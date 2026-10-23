import { RpcClient } from '../bridge';
import { buildFileTree, collectFiles, FileTreeNode } from '../ui/fileTree';
import { loadState, saveState } from '../state';
import { statusBadge, esc, escAttr } from './common';
import { FileStatus, FileNumstat, StatusViewMode } from '../../shared/protocol';

/** 右键菜单项：有 children 时点击展开子菜单（渲染为带 › 的父项） */
interface MenuItem {
  label: string;
  action?: () => void;
  children?: () => MenuItem[];
}

/** 侧边栏提交视图的持久化状态（webview 重载后恢复提交信息与勾选） */
interface CommitSidebarState {
  repoRoot?: string;
  message?: string;
  selected?: string[];
  userTouched?: string[];
  showUntracked?: boolean;
  showIgnored?: boolean;
}

/**
 * 侧边栏提交视图：把提交对话框的功能收进侧边栏（复刻 TortoiseGit"提交即一个面板"）。
 *
 * 与对话框的差异：
 * - 竖向紧凑布局，适合窄侧边栏；
 * - 不内嵌差异区：点击文件直接用 VSCode 原生 diff 打开（用户诉求）；
 * - 提供「在编辑器中打开」按钮与右键菜单项。
 */
export class CommitSidebarPanel {
  private files: FileStatus[] = [];
  private selected = new Set<string>();
  private userTouched = new Set<string>();
  private numstat = new Map<string, FileNumstat>();
  private viewMode: StatusViewMode;
  private collapsedDirs = new Set<string>();
  private showUntracked = true;
  private showIgnored = false;
  private busy = false;
  private activePath: string | undefined;
  private savedState: CommitSidebarState | undefined;
  private persistTimer: number | undefined;

  private el: HTMLElement;
  private listEl!: HTMLElement;
  private msgEl!: HTMLTextAreaElement;
  private btnCommit!: HTMLButtonElement;
  private chkAmend!: HTMLInputElement;
  private chkSignOff!: HTMLInputElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    viewMode: StatusViewMode = 'list',
    initialPaths?: string[],
  ) {
    this.el = root;
    this.viewMode = viewMode;
    this.savedState = this.loadSavedState();
    this.build();
    this.applyStateToControls();
    this.updateModeButton();
    void this.reload(initialPaths);
    this.bindStoreEvents();
  }

  // ---------- UI ----------

  private build(): void {
    this.el.innerHTML = `
<div class="sidebar-commit">
  <div class="sc-head">
    <button class="mini" id="sc-mode" title="切换树形/列表视图">树形</button>
    <button class="mini" id="sc-sel" title="全选 / 全不选">全选</button>
    <span class="flex"></span>
    <label class="chk"><input type="checkbox" id="sc-untracked" checked> 未版本</label>
    <label class="chk"><input type="checkbox" id="sc-ignored"> 忽略文件</label>
    <button class="icon" id="sc-refresh" title="刷新 (F5)">
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13.9 1.6v3.3h-3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <div class="file-list sc-list" id="sc-list"></div>
  <div class="sc-foot">
    <div class="sel-stat" id="sc-stat"></div>
    <textarea id="sc-message" class="message" rows="4" placeholder="提交信息…（Ctrl+Enter 提交）"></textarea>
    <div class="sc-actions">
      <label class="chk"><input type="checkbox" id="sc-amend"> 修订</label>
      <label class="chk"><input type="checkbox" id="sc-signoff"> 签署</label>
      <span class="flex"></span>
      <button class="primary" id="sc-commit">提交</button>
    </div>
  </div>
</div>
<div class="ctx-menu" id="sc-menu" hidden></div>
`;
    // 顶部固定区 + 列表滚动 + 底部固定区：整体竖向撑满侧边栏
    this.listEl = this.must('sc-list');
    this.msgEl = this.must('sc-message') as HTMLTextAreaElement;
    this.btnCommit = this.must('sc-commit') as HTMLButtonElement;
    this.chkAmend = this.must('sc-amend') as HTMLInputElement;
    this.chkSignOff = this.must('sc-signoff') as HTMLInputElement;

    this.must('sc-mode').addEventListener('click', () => {
      void this.client.send('ui:setViewMode', { mode: this.viewMode === 'tree' ? 'list' : 'tree' });
    });
    this.must('sc-refresh').addEventListener('click', () => void this.reload());
    // 全选 / 全不选：单按钮互斥（按钮文字即为"点击后执行的动作"）
    this.must('sc-sel').addEventListener('click', () => this.selectAll(!this.allVisibleSelected()));
    (this.must('sc-untracked') as HTMLInputElement).addEventListener('change', (e) => {
      this.showUntracked = (e.target as HTMLInputElement).checked;
      this.renderList();
      this.persist();
    });
    (this.must('sc-ignored') as HTMLInputElement).addEventListener('change', (e) => {
      this.showIgnored = (e.target as HTMLInputElement).checked;
      this.renderList();
      this.persist();
    });
    this.must('sc-commit').addEventListener('click', () => void this.commit());
    this.msgEl.addEventListener('input', () => this.persistSoon());

    // 挂在面板根节点上（而非 document）：视图重建时旧监听器随 DOM 一起被丢弃
    this.el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void this.commit();
      }
      if (e.key === 'F5') {
        e.preventDefault();
        void this.reload();
      }
    });
  }

  private must(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing element: ' + id);
    return el;
  }

  private updateModeButton(): void {
    this.must('sc-mode').textContent = this.viewMode === 'tree' ? '列表' : '树形';
  }

  /** 可见文件是否全部已勾选（决定"全选/全不选"按钮的当前语义） */
  private allVisibleSelected(): boolean {
    const files = this.visibleFiles();
    return files.length > 0 && files.every((f) => this.selected.has(f.path));
  }

  private updateSelButton(): void {
    this.must('sc-sel').textContent = this.allVisibleSelected() ? '全不选' : '全选';
  }

  // ---------- 状态持久化 ----------

  private loadSavedState(): CommitSidebarState | undefined {
    const saved = loadState<CommitSidebarState>();
    if (!saved || saved.repoRoot !== this.repoRoot) return undefined;
    return saved;
  }

  private applyStateToControls(): void {
    const s = this.savedState;
    if (!s) return;
    if (typeof s.message === 'string') this.msgEl.value = s.message;
    if (typeof s.showUntracked === 'boolean') {
      this.showUntracked = s.showUntracked;
      (this.must('sc-untracked') as HTMLInputElement).checked = s.showUntracked;
    }
    if (typeof s.showIgnored === 'boolean') {
      this.showIgnored = s.showIgnored;
      (this.must('sc-ignored') as HTMLInputElement).checked = s.showIgnored;
    }
  }

  private persist(): void {
    saveState({
      repoRoot: this.repoRoot,
      message: this.msgEl.value,
      selected: [...this.selected],
      userTouched: [...this.userTouched],
      showUntracked: this.showUntracked,
      showIgnored: this.showIgnored,
    } satisfies CommitSidebarState);
  }

  private persistSoon(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persist(), 400);
  }

  private clearPersistedState(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.savedState = undefined;
    saveState(undefined);
  }

  // ---------- 数据 ----------

  private bindStoreEvents(): void {
    this.client.on('status:changed', ({ files }) => {
      this.files = files;
      for (const f of files) {
        if (f.index !== 'none' && !this.selected.has(f.path) && !this.userTouched.has(f.path)) {
          this.selected.add(f.path);
        }
      }
      this.renderList();
      void this.refreshNumstat();
    });
    // 标题栏刷新按钮 / 宿主主动刷新：只重新拉取，不重建 UI（保留勾选与折叠态）
    this.client.on('reload', () => void this.reload());
    this.client.on('statusViewMode:changed', ({ mode }) => {
      this.viewMode = mode;
      this.collapsedDirs.clear();
      this.updateModeButton();
      this.renderList();
    });
  }

  private async reload(initialPaths?: string[]): Promise<void> {
    if (!this.repoRoot) {
      this.listEl.innerHTML = '<div class="empty">未发现 git 仓库</div>';
      return;
    }
    try {
      this.files = await this.client.send('status:list', { repoRoot: this.repoRoot });
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty">无法读取仓库状态：${esc(String(err))}</div>`;
      return;
    }
    this.selected.clear();
    this.userTouched.clear();
    const saved = this.savedState;
    if (saved && Array.isArray(saved.selected)) {
      for (const p of saved.selected) {
        const f = this.files.find((x) => x.path === p);
        if (f && !f.conflicted) this.selected.add(p);
      }
      for (const p of saved.userTouched ?? []) this.userTouched.add(p);
    } else {
      for (const f of this.files) {
        if (f.index !== 'none' && f.index !== 'conflicted') this.selected.add(f.path);
      }
    }
    for (const p of initialPaths ?? []) {
      const f = this.files.find((x) => x.path === p);
      if (f && !f.conflicted) this.selected.add(p);
    }
    // 分支信息改由宿主写到视图标题栏（description），webview 内不再重复显示
    this.renderList();
    void this.refreshNumstat();
  }

  private visibleFiles(): FileStatus[] {
    return this.files.filter((f) => {
      if (f.ignored && !this.showIgnored) return false;
      if (f.untracked && !this.showUntracked) return false;
      return true;
    });
  }

  private renderList(): void {
    const files = this.visibleFiles();
    if (!files.length) {
      this.listEl.innerHTML = '<div class="empty">没有变更</div>';
    } else {
      this.listEl.innerHTML =
        this.viewMode === 'tree' ? this.renderTree(buildFileTree(files), 0) : this.renderFlat(files);
      this.bindListEvents();
    }
    this.updateSelStat();
    this.updateSelButton();
  }

  private async refreshNumstat(): Promise<void> {
    let list: FileNumstat[];
    try {
      list = await this.client.send('status:numstat', { repoRoot: this.repoRoot });
    } catch {
      return;
    }
    this.numstat = new Map(list.map((n) => [n.path, n]));
    this.renderList();
  }

  private updateSelStat(): void {
    const el = this.must('sc-stat');
    if (!this.selected.size) {
      el.textContent = '未选择文件';
      return;
    }
    let additions = 0;
    let deletions = 0;
    for (const p of this.selected) {
      const n = this.numstat.get(p);
      if (n) {
        additions += n.additions;
        deletions += n.deletions;
      }
    }
    el.innerHTML =
      `已选 <b>${this.selected.size}</b> 个文件：` +
      `<span class="add">+${additions}</span> <span class="del">-${deletions}</span>`;
  }

  private fileStatHtml(path: string): string {
    const n = this.numstat.get(path);
    if (!n || (!n.additions && !n.deletions)) return '';
    return `<span class="file-stat"><span class="add">+${n.additions}</span> <span class="del">-${n.deletions}</span></span>`;
  }

  private renderFlat(files: FileStatus[]): string {
    return files
      .map((f) => {
        const badge = statusBadge(f);
        const checked = this.selected.has(f.path) ? 'checked' : '';
        const name = f.path.includes('/') ? f.path.slice(f.path.lastIndexOf('/') + 1) : f.path;
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        return `<div class="file-row${this.activePath === f.path ? ' active' : ''}" data-path="${escAttr(f.path)}" title="${escAttr(f.path)}">
  <input type="checkbox" class="file-check" ${checked} data-path="${escAttr(f.path)}">
  <span class="badge ${badge.cls}" title="${escAttr(badge.title)}">${badge.text}</span>
  ${this.fileStatHtml(f.path)}
  <span class="file-name">${esc(name)}</span>
  <span class="file-dir">${esc(dir)}</span>
</div>`;
      })
      .join('');
  }

  private renderTree(nodes: FileTreeNode[], depth: number): string {
    return nodes
      .map((n) => {
        if (n.kind === 'dir') {
          const collapsed = this.collapsedDirs.has(n.path);
          const childFiles = collectFiles(n);
          const selectedCount = childFiles.filter((f) => this.selected.has(f.path)).length;
          const all = childFiles.length > 0 && selectedCount === childFiles.length;
          const indeterminate = selectedCount > 0 && !all;
          const indent = depth * 10;
          const twisty = `<span class="dir-twisty${collapsed ? '' : ' open'}" title="展开/折叠"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 1.5 8.5 6 4.5 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
          const row = `<div class="dir-row" data-dir="${escAttr(n.path)}" style="padding-left:${indent}px" title="${escAttr(n.path)}">
  ${twisty}
  <input type="checkbox" class="dir-check" data-dir="${escAttr(n.path)}"${all ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}>
  <span class="dir-name">${esc(n.label)}</span>
  <span class="dir-count">${selectedCount}/${childFiles.length}</span>
</div>`;
          return collapsed ? row : row + this.renderTree(n.children ?? [], depth + 1);
        }
        const f = n.file!;
        const badge = statusBadge(f);
        const checked = this.selected.has(f.path) ? 'checked' : '';
        const indent = depth * 10 + 12;
        return `<div class="file-row${this.activePath === f.path ? ' active' : ''}" data-path="${escAttr(f.path)}" style="padding-left:${indent}px" title="${escAttr(f.path)}">
  <input type="checkbox" class="file-check" ${checked} data-path="${escAttr(f.path)}">
  <span class="badge ${badge.cls}" title="${escAttr(badge.title)}">${badge.text}</span>
  ${this.fileStatHtml(f.path)}
  <span class="file-name">${esc(n.label)}</span>
</div>`;
      })
      .join('');
  }

  private bindListEvents(): void {
    this.listEl.querySelectorAll<HTMLElement>('.file-row').forEach((row) => {
      // 点击行 → VSCode 原生对比（用户诉求：不再内嵌差异区）
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('file-check')) return;
        this.openDiff(row.dataset.path!);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.activePath = row.dataset.path;
        this.showFileMenu(e.clientX, e.clientY, row.dataset.path!);
      });
    });
    this.listEl.querySelectorAll<HTMLInputElement>('.file-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const p = cb.dataset.path!;
        this.userTouched.add(p);
        if (cb.checked) this.selected.add(p);
        else this.selected.delete(p);
        if (this.viewMode === 'tree') this.renderList();
        else this.updateSelStat();
        this.persist();
      });
    });
    this.listEl.querySelectorAll<HTMLElement>('.dir-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('dir-check')) return;
        const dir = row.dataset.dir!;
        if (this.collapsedDirs.has(dir)) this.collapsedDirs.delete(dir);
        else this.collapsedDirs.add(dir);
        this.renderList();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showDirMenu(e.clientX, e.clientY, row.dataset.dir!);
      });
    });
    this.listEl.querySelectorAll<HTMLInputElement>('.dir-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const prefix = cb.dataset.dir! + '/';
        for (const f of this.visibleFiles()) {
          if (!f.path.startsWith(prefix)) continue;
          this.userTouched.add(f.path);
          if (cb.checked) this.selected.add(f.path);
          else this.selected.delete(f.path);
        }
        this.renderList();
        this.persist();
      });
      if (cb.dataset.indeterminate) cb.indeterminate = true;
    });
  }

  /** 点击文件：记录当前文件并用 VSCode 原生 diff 打开（HEAD ↔ 工作区；未跟踪直接打开） */
  private openDiff(path: string): void {
    this.activePath = path;
    this.renderList();
    this.client.command('openNativeDiff', { repoRoot: this.repoRoot, path, staged: 'false' });
  }

  private selectAll(on: boolean): void {
    for (const f of this.visibleFiles()) {
      this.userTouched.add(f.path);
      if (on) this.selected.add(f.path);
      else this.selected.delete(f.path);
    }
    this.renderList();
    this.persist();
  }

  // ---------- 右键菜单（支持二级/三级子菜单） ----------

  /** 文件行右键 */
  private showFileMenu(x: number, y: number, path: string): void {
    const repoRoot = this.repoRoot;
    const ignoreSub = (): MenuItem[] => [
      {
        label: '仓库根 .gitignore',
        action: () =>
          void this.client.send('status:ignore', { repoRoot, paths: [path], target: 'gitignore' }),
      },
      {
        label: '.git/info/exclude（仅本地）',
        action: () =>
          void this.client.send('status:ignore', { repoRoot, paths: [path], target: 'exclude' }),
      },
    ];
    const items: MenuItem[] = [
      {
        label: '比较差异（VSCode 对比）',
        action: () => this.client.command('openNativeDiff', { repoRoot, path, staged: 'false' }),
      },
      {
        label: '在编辑器中打开',
        action: () => this.client.command('openFile', { repoRoot, path }),
      },
      {
        label: '暂存 (Stage)',
        action: () => void this.client.send('status:stage', { repoRoot, paths: [path] }),
      },
      {
        label: '取消暂存 (Unstage)',
        action: () => void this.client.send('status:unstage', { repoRoot, paths: [path] }),
      },
      {
        label: '放弃修改 (Revert)',
        action: async () => {
          const ok = await this.confirm(`确定放弃 ${path} 的修改？此操作不可恢复。`);
          if (ok) await this.client.send('status:discard', { repoRoot, paths: [path] });
        },
      },
      { label: '添加到忽略列表', children: ignoreSub },
    ];
    this.openMenu(items, x, y);
  }

  /** 目录行右键（忽略列表需再选"整个目录 / 遍历目录下文件"） */
  private showDirMenu(x: number, y: number, dir: string): void {
    const repoRoot = this.repoRoot;
    const scopeSub = (target: 'gitignore' | 'exclude'): MenuItem[] => [
      {
        label: '整个目录',
        action: () =>
          void this.client.send('status:ignore', {
            repoRoot,
            paths: [dir],
            target,
            mode: 'dir',
          }),
      },
      {
        label: '遍历目录下文件',
        action: () =>
          void this.client.send('status:ignore', {
            repoRoot,
            paths: [dir],
            target,
            mode: 'files',
          }),
      },
    ];
    const ignoreSub = (): MenuItem[] => [
      { label: '仓库根 .gitignore', children: () => scopeSub('gitignore') },
      { label: '.git/info/exclude（仅本地）', children: () => scopeSub('exclude') },
    ];
    const items: MenuItem[] = [
      {
        label: '暂存 (Stage)',
        action: () => void this.client.send('status:stage', { repoRoot, paths: [dir] }),
      },
      {
        label: '取消暂存 (Unstage)',
        action: () => void this.client.send('status:unstage', { repoRoot, paths: [dir] }),
      },
      {
        label: '放弃修改 (Revert)',
        action: async () => {
          const ok = await this.confirm(`确定放弃 ${dir}/ 下所有文件的修改？此操作不可恢复。`);
          if (ok) await this.client.send('status:discard', { repoRoot, paths: [dir] });
        },
      },
      { label: '添加到忽略列表', children: ignoreSub },
    ];
    this.openMenu(items, x, y);
  }

  /**
   * 渲染右键菜单（点击父项进入子菜单，子菜单首项为"← 返回"）。
   * 每次重渲染都重新测量并做边界翻转，子菜单展开后同样贴边可用。
   */
  private openMenu(items: MenuItem[], x: number, y: number): void {
    const menu = this.must('sc-menu');
    const stack: MenuItem[][] = [];

    const place = (): void => {
      menu.style.maxHeight = '';
      menu.style.overflowY = '';
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width + 4 > vw) left = Math.max(4, vw - rect.width - 4);
      if (top + rect.height + 4 > vh) top = Math.max(4, y - rect.height);
      if (top + rect.height + 4 > vh) {
        top = 4;
        menu.style.maxHeight = `${vh - 8}px`;
        menu.style.overflowY = 'auto';
      }
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };

    const render = (list: MenuItem[], withBack: boolean): void => {
      const rows: MenuItem[] = withBack
        ? [{ label: '← 返回', action: () => {
            const prev = stack.pop();
            if (prev) render(prev, stack.length > 0);
          } }]
        : [];
      const shown = [...rows, ...list];
      menu.innerHTML = shown
        .map(
          (it, i) =>
            `<div class="ctx-item${it.children ? ' has-sub' : ''}" data-i="${i}">${esc(it.label)}${
              it.children ? '<span class="ctx-more">›</span>' : ''
            }</div>`,
        )
        .join('');
      menu.hidden = false;
      place();
      menu.querySelectorAll<HTMLElement>('.ctx-item').forEach((el) => {
        el.addEventListener('click', () => {
          const it = shown[Number(el.dataset.i)];
          if (it.children) {
            stack.push(list);
            render(it.children(), true);
            return;
          }
          this.closeMenu(menu);
          it.action?.();
        });
      });
    };

    render(items, false);
    // 点击菜单外部时关闭（mousedown 早于 click，避免与子菜单点击冲突）
    setTimeout(() => {
      const onDown = (e: MouseEvent): void => {
        if (menu.hidden) return;
        if (menu.contains(e.target as Node)) return;
        this.closeMenu(menu);
        document.removeEventListener('mousedown', onDown);
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
  }

  private closeMenu(menu: HTMLElement): void {
    menu.hidden = true;
    menu.innerHTML = '';
  }

  private async confirm(text: string): Promise<boolean> {
    return this.client.send('ui:confirm' as never, { text } as never) as Promise<boolean>;
  }

  // ---------- 提交 ----------

  private async commit(): Promise<void> {
    if (this.busy) return;
    const message = this.msgEl.value.trim();
    if (!message) {
      this.toast('请先输入提交信息。', true);
      this.msgEl.focus();
      return;
    }
    const stagedCount = this.files.filter((f) => f.index !== 'none').length;
    if (this.selected.size === 0 && stagedCount === 0) {
      this.toast('没有可提交的内容。', true);
      return;
    }
    this.busy = true;
    this.btnCommit.disabled = true;
    this.btnCommit.textContent = '提交中…';
    try {
      const files = this.selected.size ? [...this.selected] : undefined;
      const result = await this.client.send('commit:create', {
        repoRoot: this.repoRoot,
        message,
        files,
        amend: this.chkAmend.checked,
        signOff: this.chkSignOff.checked,
      });
      this.msgEl.value = '';
      this.chkAmend.checked = false;
      this.selected.clear();
      this.userTouched.clear();
      this.clearPersistedState();
      this.toast(`提交成功：${result.hash.slice(0, 7)}`);
      await this.reload();
    } catch (err) {
      this.toast(`提交失败：${String(err)}`, true);
    } finally {
      this.busy = false;
      this.btnCommit.disabled = false;
      this.btnCommit.textContent = '提交';
    }
  }

  private toast(text: string, isError = false): void {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }
}
