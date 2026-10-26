import { RpcClient } from '../bridge';
import { buildFileTree, collectDirs, collectFiles, FileTreeNode } from '../ui/fileTree';
import { loadState, saveState } from '../state';
import { statusBadge, esc, escAttr } from './common';
import { showMenuAt } from '../ui/dialogs';
import { BranchInfo, FileStatus, FileNumstat, StatusViewMode } from '../../shared/protocol';

/** 右键菜单项：有 children 时点击展开子菜单（渲染为带 › 的父项） */
interface MenuItem {
  label: string;
  action?: () => void;
  children?: () => MenuItem[];
}

/** 提交方式（底部整行按钮的下拉选项）：普通提交 / 修订提交(Amend) / 提交后推送 */
export type CommitMode = 'normal' | 'amend' | 'push';

const COMMIT_MODE_LABEL: Record<CommitMode, string> = {
  normal: '提交',
  amend: '修订提交',
  push: '提交并推送',
};

/** 侧边栏提交视图的持久化状态（webview 重载后恢复提交信息与勾选） */
interface CommitSidebarState {
  repoRoot?: string;
  message?: string;
  selected?: string[];
  userTouched?: string[];
  showUntracked?: boolean;
  showIgnored?: boolean;
  /** 签署 (Signed-off-by) 勾选 */
  signOff?: boolean;
  /** 签署人「姓名 <邮箱>」，留空表示用 git 身份 */
  signOffName?: string;
  /** 提交方式：普通提交 / 修订提交 / 提交后推送 */
  commitMode?: CommitMode;
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
  /** 当前分支（变更文件列表的第一级根节点）；undefined = 尚未取到 */
  private branch: BranchInfo | undefined;
  /** 分支行折叠：只显示分支行，隐藏整个文件列表 */
  private branchCollapsed = false;
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
  /** 底部整行按钮右侧的下拉（切换提交方式） */
  private btnCommitMode!: HTMLButtonElement;
  /** 当前提交方式：普通提交 / 修订提交 / 提交后推送 */
  private commitMode: CommitMode = 'normal';
  private chkSignOff!: HTMLInputElement;
  private inpSignOff!: HTMLInputElement;
  private signOffRow!: HTMLElement;
  /** git 身份（user.name / user.email），签署人输入框的默认值 */
  private identity: { name: string; email: string } = { name: '', email: '' };

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
    void this.loadIdentity();
  }

  /** 读取 git 身份，给签署人输入框填默认「姓名 <邮箱>」（用户已手工填写时不覆盖） */
  private async loadIdentity(): Promise<void> {
    try {
      const id = await this.client.send('repo:identity', { repoRoot: this.repoRoot });
      this.identity = { name: id.name ?? '', email: id.email ?? '' };
      if (this.identity.name || this.identity.email) {
        if (!this.inpSignOff.value.trim()) {
          this.inpSignOff.value = `${this.identity.name} <${this.identity.email}>`.trim();
        }
        this.inpSignOff.placeholder = `${this.identity.name} <${this.identity.email}>`;
      }
    } catch {
      /* 身份读取失败不影响提交 */
    }
  }

  // ---------- UI ----------

  private build(): void {
    this.el.innerHTML = `
<div class="sidebar-commit">
  <div class="sc-head">
    <button class="mini" id="sc-mode" title="切换树形/列表视图">树形</button>
    <button class="mini" id="sc-collapse" title="一键收起 / 展开所有目录">收起</button>
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
      <label class="chk"><input type="checkbox" id="sc-signoff"> 签署</label>
      <span class="flex"></span>
    </div>
    <div class="sc-commit-row">
      <button class="primary sc-commit-main" id="sc-commit">提交</button>
      <button class="primary sc-commit-mode" id="sc-commit-mode" title="切换提交方式：普通提交 / 修订提交 / 提交后推送" aria-haspopup="true" aria-expanded="false">▾</button>
    </div>
    <div class="sc-signoff" id="sc-signoff-row" hidden>
      <input type="text" id="sc-signoff-name" class="signoff-input"
             placeholder="签署人：姓名 &lt;邮箱&gt;" title="留空则使用 git 配置的 user.name / user.email">
    </div>
  </div>
</div>
<div class="ctx-menu" id="sc-menu" hidden></div>
`;
    // 顶部固定区 + 列表滚动 + 底部固定区：整体竖向撑满侧边栏
    this.listEl = this.must('sc-list');
    this.msgEl = this.must('sc-message') as HTMLTextAreaElement;
    this.btnCommit = this.must('sc-commit') as HTMLButtonElement;
    this.btnCommitMode = this.must('sc-commit-mode') as HTMLButtonElement;
    this.chkSignOff = this.must('sc-signoff') as HTMLInputElement;
    this.inpSignOff = this.must('sc-signoff-name') as HTMLInputElement;
    this.signOffRow = this.must('sc-signoff-row');
    this.syncCommitMode();

    // 整行按钮右侧的下拉：切换提交方式（普通 / 修订 / 提交后推送）
    this.btnCommitMode.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = this.btnCommitMode.getBoundingClientRect();
      showMenuAt(
        this.must('sc-menu'),
        rect.left,
        rect.bottom,
        [{ label: '普通提交' }, { label: '修订提交（Amend）' }, { label: '提交后推送' }],
        (i) => {
          this.commitMode = (['normal', 'amend', 'push'] as CommitMode[])[i] ?? 'normal';
          this.syncCommitMode();
          this.persist();
        },
      );
    });

    // 勾选「签署」时才显示签署人输入框
    this.chkSignOff.addEventListener('change', () => {
      this.signOffRow.hidden = !this.chkSignOff.checked;
      if (this.chkSignOff.checked) this.inpSignOff.focus();
      this.persist();
    });
    this.inpSignOff.addEventListener('input', () => this.persistSoon());

    this.must('sc-mode').addEventListener('click', () => {
      void this.client.send('ui:setViewMode', { mode: this.viewMode === 'tree' ? 'list' : 'tree' });
    });
    // 一键收起 / 展开所有目录（仅树形模式有意义，列表模式下隐藏按钮）
    this.must('sc-collapse').addEventListener('click', () => {
      const dirs = collectDirs(buildFileTree(this.visibleFiles()));
      const allCollapsed = dirs.length > 0 && dirs.every((d) => this.collapsedDirs.has(d));
      this.collapsedDirs.clear();
      if (!allCollapsed) for (const d of dirs) this.collapsedDirs.add(d);
      this.renderList();
    });
    this.must('sc-refresh').addEventListener('click', () => void this.reload());
    // 全选/全不选由分支根行的复选框承担（顶栏不再放按钮）
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
    // 一键收起只在树形模式可用
    this.must('sc-collapse').style.display = this.viewMode === 'tree' ? '' : 'none';
  }

  /** 收起按钮文案：全部目录已收起 → 「展开」，否则 → 「收起」 */
  private updateCollapseButton(): void {
    if (this.viewMode !== 'tree') return;
    const dirs = collectDirs(buildFileTree(this.visibleFiles()));
    const allCollapsed = dirs.length > 0 && dirs.every((d) => this.collapsedDirs.has(d));
    this.must('sc-collapse').textContent = allCollapsed ? '展开' : '收起';
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
    if (typeof s.signOff === 'boolean') this.chkSignOff.checked = s.signOff;
    this.signOffRow.hidden = !this.chkSignOff.checked;
    if (typeof s.signOffName === 'string') this.inpSignOff.value = s.signOffName;
    if (s.commitMode === 'amend' || s.commitMode === 'push') {
      this.commitMode = s.commitMode;
      this.syncCommitMode();
    }
  }

  /** 把当前提交方式同步到整行按钮（主按钮文案 + 下拉标题） */
  private syncCommitMode(): void {
    this.btnCommit.textContent = COMMIT_MODE_LABEL[this.commitMode];
    const hint =
      this.commitMode === 'normal'
        ? '普通提交'
        : this.commitMode === 'amend'
          ? '修订提交（Amend）：并入上一个提交'
          : '提交后推送：提交成功即 push 到上游';
    this.btnCommit.title = hint;
    this.btnCommitMode.title = `当前：${hint}\n点击下拉可切换为 普通提交 / 修订提交 / 提交后推送`;
  }

  private persist(): void {
    saveState({
      repoRoot: this.repoRoot,
      message: this.msgEl.value,
      selected: [...this.selected],
      userTouched: [...this.userTouched],
      showUntracked: this.showUntracked,
      showIgnored: this.showIgnored,
      signOff: this.chkSignOff.checked,
      signOffName: this.inpSignOff.value,
      commitMode: this.commitMode,
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
    // 分支信息（列表第一级根节点）跟随宿主推送实时更新
    this.client.on('branch:changed', ({ info }) => {
      this.branch = info;
      this.renderList();
    });
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
    // 分支信息：变更文件列表的第一级根节点（初始值走 repo:info，之后由 branch:changed 推送）
    void this.loadBranch();
    this.renderList();
    void this.refreshNumstat();
  }

  /** 拉取当前分支信息；失败时静默（不渲染分支行，文件列表照常显示） */
  private async loadBranch(): Promise<void> {
    if (!this.repoRoot) return;
    try {
      this.branch = await this.client.send('repo:info', { repoRoot: this.repoRoot });
    } catch {
      return;
    }
    this.renderList();
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
    const parts: string[] = [];
    if (this.branch) parts.push(this.renderBranchRow(files));
    if (!files.length) {
      parts.push('<div class="empty">没有变更</div>');
    } else if (!this.branchCollapsed) {
      // 分支行是第一级，文件整体下挂一层：树形 depth 从 1 起，列表模式左缩进 10px
      parts.push(
        this.viewMode === 'tree'
          ? this.renderTree(buildFileTree(files), 1)
          : this.renderFlat(files),
      );
    }
    this.listEl.innerHTML = parts.join('');
    this.bindListEvents();
    this.updateSelStat();
    this.updateCollapseButton();
  }

  /** 仓库状态中文名（分支行上非 clean 时提示） */
  private static readonly STATE_CN: Record<string, string> = {
    merging: '合并中',
    rebasing: '变基中',
    'cherry-picking': '拣选中',
    reverting: '还原中',
    bisecting: '二分查找中',
    applying: '应用补丁中',
  };

  /**
   * 分支根行：变更文件列表的第一级。
   * 分支名 + ↑领先/↓落后 + 仓库状态 + 已选/总数；复选框 = 全选/全不选，
   * twisty = 折叠/展开整个文件列表（sticky 定位，滚动时保持可见）。
   */
  private renderBranchRow(files: FileStatus[]): string {
    const b = this.branch!;
    const selectedCount = files.filter((f) => this.selected.has(f.path)).length;
    const all = files.length > 0 && selectedCount === files.length;
    const indeterminate = selectedCount > 0 && !all;
    const ab =
      (b.ahead ? `<span class="branch-ab" title="领先上游 ${b.ahead} 个提交">↑${b.ahead}</span>` : '') +
      (b.behind ? `<span class="branch-ab" title="落后上游 ${b.behind} 个提交">↓${b.behind}</span>` : '');
    const state =
      b.state !== 'clean'
        ? `<span class="branch-state">${esc(CommitSidebarPanel.STATE_CN[b.state] ?? b.state)}</span>`
        : '';
    const name = esc(`${b.name}${b.detached ? ' (detached)' : ''}`);
    return `<div class="branch-row${this.branchCollapsed ? ' collapsed' : ''}" title="${escAttr(`${b.name}（当前分支）`)}">
  <span class="dir-twisty${this.branchCollapsed ? '' : ' open'}" title="展开/折叠文件列表"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 1.5 8.5 6 4.5 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
  <input type="checkbox" class="branch-check"${all ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}>
  <svg class="branch-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="11.5" cy="5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 5.3v5.4M11.5 6.8c0 1.2-1.6 1.7-3 1.7h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
  <span class="branch-name">${name}</span>
  ${ab}${state}
  <span class="dir-count">${selectedCount}/${files.length}</span>
</div>`;
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
  <span class="badge ${badge.cls}">${badge.text}</span>
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
  <span class="badge ${badge.cls}">${badge.text}</span>
  ${this.fileStatHtml(f.path)}
  <span class="file-name">${esc(n.label)}</span>
</div>`;
      })
      .join('');
  }

  private bindListEvents(): void {
    // 分支根行：点击行（非复选框处）折叠/展开整个文件列表
    const branchRow = this.listEl.querySelector<HTMLElement>('.branch-row');
    if (branchRow) {
      branchRow.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('branch-check')) return;
        this.branchCollapsed = !this.branchCollapsed;
        this.renderList();
      });
    }
    // 分支复选框 = 全选/全不选（顶栏不再放按钮，由分支根行承担）
    this.listEl.querySelectorAll<HTMLInputElement>('.branch-check').forEach((cb) => {
      cb.addEventListener('change', () => this.selectAll(cb.checked));
      if (cb.dataset.indeterminate) cb.indeterminate = true;
    });
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
    // 折叠的忽略目录（路径以 / 结尾）没有可对比的单文件，点击只做选中不高亮 diff
    if (path.endsWith('/')) return;
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
    this.btnCommitMode.disabled = true;
    this.btnCommit.textContent = '提交中…';
    try {
      const files = this.selected.size ? [...this.selected] : undefined;
      const result = await this.client.send('commit:create', {
        repoRoot: this.repoRoot,
        message,
        files,
        amend: this.commitMode === 'amend',
        signOff: this.chkSignOff.checked,
        signOffName: this.inpSignOff.value.trim(),
        pushAfter: this.commitMode === 'push',
      });
      this.msgEl.value = '';
      // 修订/推送都是一次性动作：提交成功后回到「普通提交」
      this.commitMode = 'normal';
      this.selected.clear();
      this.userTouched.clear();
      this.clearPersistedState();
      let text = `提交成功：${result.hash.slice(0, 7)}`;
      if (result.pushed === true) text += `（已推送：${result.pushMessage || '完成'}）`;
      else if (result.pushed === false) text += `（推送失败：${result.pushMessage || '未知原因'}）`;
      this.toast(text);
      await this.reload();
    } catch (err) {
      this.toast(`提交失败：${String(err)}`, true);
    } finally {
      this.busy = false;
      this.btnCommit.disabled = false;
      this.btnCommitMode.disabled = false;
      this.syncCommitMode();
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
