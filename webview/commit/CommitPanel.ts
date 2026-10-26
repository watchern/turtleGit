import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { buildFileTree, collectFiles, FileTreeNode } from '../ui/fileTree';
import { loadState, saveState } from '../state';
import { statusBadge, esc, escAttr } from './common';
import { FileStatus, FileNumstat, StatusViewMode } from '../../shared/protocol';

/** 提交对话框的持久化会话状态（webview 重载——如窗口移动——后恢复） */
interface CommitPanelState {
  repoRoot?: string;
  message?: string;
  selected?: string[];
  userTouched?: string[];
  selectedPath?: string;
  diffMode?: 'side' | 'unified';
  showUntracked?: boolean;
  showIgnored?: boolean;
  /** 签署 (Signed-off-by) 勾选 */
  signOff?: boolean;
  /** 签署人「姓名 <邮箱>」，留空表示用 git 身份 */
  signOffName?: string;
  /** 提交后自动推送 */
  pushAfter?: boolean;
}

/**
 * 提交对话框：复刻 TortoiseGit Commit Dialog。
 * 左：变更文件列表（复选框 + 状态徽标）；右上：差异预览；右下：提交信息。
 */
export class CommitPanel {
  private files: FileStatus[] = [];
  private selected = new Set<string>();
  private selectedPath: string | undefined;
  private diffMode: 'side' | 'unified' = 'side';
  private showUntracked = true;
  private showIgnored = false;
  private busy = false;
  /** 变更文件列表视图模式（与侧边栏共享，经宿主持久化） */
  private viewMode: StatusViewMode;
  /** 树形模式下被折叠的目录路径集合 */
  private collapsedDirs = new Set<string>();
  /** 每文件增删行数（status:numstat，path → 统计） */
  private numstat = new Map<string, FileNumstat>();
  /** 上次会话持久化状态（仅同仓库；webview 重载后恢复用户输入） */
  private savedState: CommitPanelState | undefined;
  private persistTimer: number | undefined;

  private el: HTMLElement;
  private listEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private statEl!: HTMLElement;
  private msgEl!: HTMLTextAreaElement;
  private btnCommit!: HTMLButtonElement;
  private chkAmend!: HTMLInputElement;
  private chkSignOff!: HTMLInputElement;
  private chkPush!: HTMLInputElement;
  private inpSignOff!: HTMLInputElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    initialPaths?: string[],
    viewMode: StatusViewMode = 'list',
  ) {
    this.el = root;
    this.viewMode = viewMode;
    this.savedState = this.loadSavedState();
    this.build();
    this.applyStateToControls();
    this.updateViewModeButton();
    void this.reload(initialPaths);
    this.bindStoreEvents();
    void this.loadIdentity();
  }

  /** 读取 git 身份，给签署人输入框填默认「姓名 <邮箱>」（用户已手工填写时不覆盖） */
  private async loadIdentity(): Promise<void> {
    try {
      const id = await this.client.send('repo:identity', { repoRoot: this.repoRoot });
      if ((id.name || id.email) && !this.inpSignOff.value.trim()) {
        this.inpSignOff.value = `${id.name} <${id.email}>`.trim();
      }
      this.inpSignOff.placeholder = id.name || id.email ? `${id.name} <${id.email}>` : '姓名 <邮箱>';
    } catch {
      /* 身份读取失败不影响提交 */
    }
  }

  // ---------- UI 构建 ----------

  private build(): void {
    this.el.innerHTML = `
<div class="toolbar">
  <button id="btn-refresh" title="刷新 (F5)">刷新</button>
  <button id="btn-view-mode" title="切换树形/列表视图">树形</button>
  <span class="sep"></span>
  <button id="btn-select-all" title="全选">全选</button>
  <button id="btn-select-none" title="全部不选">全不选</button>
  <span class="sep"></span>
  <label class="chk"><input type="checkbox" id="chk-untracked" checked> 显示未版本控制</label>
  <label class="chk"><input type="checkbox" id="chk-ignored"> 显示忽略文件</label>
  <span class="flex"></span>
  <span class="repo-name" id="repo-name"></span>
</div>
<div class="split">
  <section class="pane left">
    <div class="pane-head">
      <span>变更文件</span>
      <span class="count" id="file-count"></span>
    </div>
    <div class="file-list" id="file-list"></div>
  </section>
  <section class="pane right">
    <div class="pane-head">
      <span id="diff-title">差异</span>
      <span class="diff-stat" id="diff-stat"></span>
      <span class="flex"></span>
      <button class="mini" id="btn-diff-mode">并排</button>
      <button class="mini" id="btn-open-editor">在编辑器中打开</button>
    </div>
    <div class="diff-view" id="diff-view"><div class="diff-empty">选择文件以查看差异</div></div>
    <div class="pane-head message-head">
      <span>提交信息</span>
      <span class="hint">第一行作为摘要</span>
    </div>
    <textarea id="commit-message" class="message" placeholder="在此输入提交信息…&#10;&#10;Ctrl+Enter 提交"></textarea>
    <div class="commit-foot">
      <label class="chk"><input type="checkbox" id="chk-amend"> 修订上次提交 (Amend)</label>
      <label class="chk"><input type="checkbox" id="chk-signoff"> 签署 (Signed-off-by)</label>
      <input type="text" id="inp-signoff" class="signoff-input" placeholder="姓名 &lt;邮箱&gt;" hidden>
      <label class="chk"><input type="checkbox" id="chk-push"> 提交后推送</label>
      <span class="sel-stat" id="sel-stat"></span>
      <span class="flex"></span>
      <label class="chk"><input type="checkbox" id="chk-closeafter" checked> 提交后关闭</label>
      <button class="primary" id="btn-commit">提交</button>
    </div>
  </section>
</div>
<div class="ctx-menu" id="ctx-menu" hidden></div>
`;

    this.listEl = this.must('file-list');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');
    this.msgEl = this.must('commit-message') as HTMLTextAreaElement;
    // 提交信息输入防抖持久化（窗口移动导致 webview 重载后恢复）
    this.msgEl.addEventListener('input', () => this.persistSoon());
    this.btnCommit = this.must('btn-commit') as HTMLButtonElement;
    this.chkAmend = this.must('chk-amend') as HTMLInputElement;
    this.chkSignOff = this.must('chk-signoff') as HTMLInputElement;
    this.chkPush = this.must('chk-push') as HTMLInputElement;
    this.inpSignOff = this.must('inp-signoff') as HTMLInputElement;

    // 勾选「签署」时才显示签署人输入框
    this.chkSignOff.addEventListener('change', () => {
      this.inpSignOff.hidden = !this.chkSignOff.checked;
      if (this.chkSignOff.checked) this.inpSignOff.focus();
      this.persist();
    });
    this.chkPush.addEventListener('change', () => this.persist());
    this.inpSignOff.addEventListener('input', () => this.persistSoon());
    this.must('repo-name').textContent = this.repoRoot;

    this.must('btn-commit').addEventListener('click', () => void this.commit());
    this.must('btn-refresh').addEventListener('click', () => void this.reload());
    this.must('btn-view-mode').addEventListener('click', () => {
      // 经宿主持久化并广播，statusViewMode:changed 事件回来后再重渲染
      void this.client.send('ui:setViewMode', {
        mode: this.viewMode === 'tree' ? 'list' : 'tree',
      });
    });
    this.must('btn-select-all').addEventListener('click', () => this.selectAll(true));
    this.must('btn-select-none').addEventListener('click', () => this.selectAll(false));
    (this.must('chk-untracked') as HTMLInputElement).addEventListener('change', (e) => {
      this.showUntracked = (e.target as HTMLInputElement).checked;
      this.renderList();
      this.persist();
    });
    (this.must('chk-ignored') as HTMLInputElement).addEventListener('change', (e) => {
      this.showIgnored = (e.target as HTMLInputElement).checked;
      this.renderList();
      this.persist();
    });
    this.must('btn-diff-mode').addEventListener('click', () => {
      this.diffMode = this.diffMode === 'side' ? 'unified' : 'side';
      this.must('btn-diff-mode').textContent = this.diffMode === 'side' ? '并排' : '统一';
      this.persist();
      void this.showDiff(this.selectedPath);
    });
    this.must('btn-open-editor').addEventListener('click', () => {
      if (!this.selectedPath) return;
      const file = this.files.find((f) => f.path === this.selectedPath);
      this.client.command('openNativeDiff', {
        path: this.selectedPath,
        staged: String(this.isStagedView(file)),
      });
    });

    // 全局快捷键：Ctrl+Enter 提交、Esc 关闭面板
    document.addEventListener('keydown', (e) => {
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

  /** 切换按钮文字：显示"点击后切到的目标模式" */
  private updateViewModeButton(): void {
    this.must('btn-view-mode').textContent = this.viewMode === 'tree' ? '列表' : '树形';
  }

  // ---------- 会话状态持久化 ----------

  /** 读取上次会话状态（仅同仓库有效；窗口移动导致 webview 重载时恢复用户输入） */
  private loadSavedState(): CommitPanelState | undefined {
    const saved = loadState<CommitPanelState>();
    if (!saved || saved.repoRoot !== this.repoRoot) return undefined;
    return saved;
  }

  /** 把持久化状态应用到控件（提交信息/差异模式/筛选/当前选中文件） */
  private applyStateToControls(): void {
    const s = this.savedState;
    if (!s) return;
    if (typeof s.message === 'string') this.msgEl.value = s.message;
    if (s.diffMode === 'side' || s.diffMode === 'unified') this.diffMode = s.diffMode;
    if (typeof s.showUntracked === 'boolean') this.showUntracked = s.showUntracked;
    if (typeof s.showIgnored === 'boolean') this.showIgnored = s.showIgnored;
    if (s.selectedPath) this.selectedPath = s.selectedPath;
    if (typeof s.signOff === 'boolean') this.chkSignOff.checked = s.signOff;
    this.inpSignOff.hidden = !this.chkSignOff.checked;
    if (typeof s.signOffName === 'string') this.inpSignOff.value = s.signOffName;
    if (typeof s.pushAfter === 'boolean') this.chkPush.checked = s.pushAfter;
    (this.must('chk-untracked') as HTMLInputElement).checked = this.showUntracked;
    (this.must('chk-ignored') as HTMLInputElement).checked = this.showIgnored;
    this.must('btn-diff-mode').textContent = this.diffMode === 'side' ? '并排' : '统一';
  }

  /** 持久化会话状态（webview 重载后恢复） */
  private persist(): void {
    const state: CommitPanelState = {
      repoRoot: this.repoRoot,
      message: this.msgEl.value,
      selected: [...this.selected],
      userTouched: [...this.userTouched],
      selectedPath: this.selectedPath,
      diffMode: this.diffMode,
      showUntracked: this.showUntracked,
      showIgnored: this.showIgnored,
      signOff: this.chkSignOff.checked,
      signOffName: this.inpSignOff.value,
      pushAfter: this.chkPush.checked,
    };
    saveState(state);
  }

  /** 输入类变更防抖保存（避免每次按键都序列化） */
  private persistSoon(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persist(), 400);
  }

  /** 提交成功后清理（避免恢复已提交的信息） */
  private clearPersistedState(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer);
    this.savedState = undefined;
    saveState(undefined);
  }

  // ---------- 数据 ----------

  private bindStoreEvents(): void {
    this.client.on('status:changed', ({ files }) => {
      this.files = files;
      // 保留用户勾选状态，补充新出现的已暂存文件
      for (const f of files) {
        if (f.index !== 'none' && !this.selected.has(f.path) && !this.userTouched.has(f.path)) {
          this.selected.add(f.path);
        }
      }
      this.renderList();
      void this.showDiff(this.selectedPath);
      void this.refreshNumstat();
    });
    this.client.on('branch:changed', ({ info }) => {
      this.must('repo-name').textContent = `${this.repoRoot}  [${info.name}${info.detached ? ' (detached)' : ''}]`;
    });
    // 视图模式广播（侧边栏或其他面板切换时同步）
    this.client.on('statusViewMode:changed', ({ mode }) => {
      this.viewMode = mode;
      this.collapsedDirs.clear();
      this.updateViewModeButton();
      this.renderList();
    });
  }

  private userTouched = new Set<string>();

  private async reload(initialPaths?: string[]): Promise<void> {
    this.files = await this.client.send('status:list', { repoRoot: this.repoRoot });
    // 勾选状态：优先恢复上次会话（webview 重载场景），否则默认勾选已暂存文件
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
        if (f.index !== 'none' && f.index !== 'conflicted') {
          this.selected.add(f.path);
        }
      }
    }
    if (initialPaths?.length) {
      for (const p of initialPaths) {
        const f = this.files.find((x) => x.path === p);
        if (f && !f.conflicted) this.selected.add(p);
      }
    }
    const info = await this.client.send('repo:info', { repoRoot: this.repoRoot });
    this.must('repo-name').textContent = `${this.repoRoot}  [${info.name}${info.detached ? ' (detached)' : ''}]`;
    this.renderList();
    void this.refreshNumstat();
    if (initialPaths?.[0]) {
      this.selectFile(initialPaths[0]);
    }
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
    this.must('file-count').textContent = `（${files.length}）`;
    if (!files.length) {
      this.listEl.innerHTML = '<div class="empty">没有变更</div>';
    } else {
      this.listEl.innerHTML =
        this.viewMode === 'tree' ? this.renderTree(buildFileTree(files), 0) : this.renderFlat(files);
      this.bindListEvents();
    }
    this.updateSelStat();
  }

  /** 拉取每文件增删行数（异步；到达后若无变化则不重渲染，避免列表滚动位置被重置） */
  private async refreshNumstat(): Promise<void> {
    let list: FileNumstat[];
    try {
      list = await this.client.send('status:numstat', { repoRoot: this.repoRoot });
    } catch {
      return; // 保留旧统计
    }
    const next = new Map(list.map((n) => [n.path, n]));
    let changed = next.size !== this.numstat.size;
    if (!changed) {
      for (const [k, v] of next) {
        const o = this.numstat.get(k);
        if (!o || o.additions !== v.additions || o.deletions !== v.deletions) {
          changed = true;
          break;
        }
      }
    }
    this.numstat = next;
    if (changed) this.renderList();
    else this.updateSelStat();
  }

  /** 选中文件的总数与总增删行数（commit-foot 统计区） */
  private updateSelStat(): void {
    const el = this.must('sel-stat');
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

  /** 文件行的 +N -M 徽标（无增删时不显示，如二进制或仅模式变更） */
  private fileStatHtml(path: string): string {
    const n = this.numstat.get(path);
    if (!n || (!n.additions && !n.deletions)) return '';
    return `<span class="file-stat"><span class="add">+${n.additions}</span> <span class="del">-${n.deletions}</span></span>`;
  }

  /** 列表模式：平铺，label 为完整路径（TortoiseGit 默认列表视图） */
  private renderFlat(files: FileStatus[]): string {
    return files
      .map((f) => {
        const badge = statusBadge(f);
        const checked = this.selected.has(f.path) ? 'checked' : '';
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const name = f.path.includes('/')
          ? f.path.slice(f.path.lastIndexOf('/') + 1)
          : f.path;
        const rename = f.origPath ? `<span class="rename">← ${f.origPath}</span>` : '';
        const stat = this.fileStatHtml(f.path);
        return `<div class="file-row${this.selectedPath === f.path ? ' active' : ''}" data-path="${this.escAttr(f.path)}" title="${this.escAttr(f.path)}">
  <input type="checkbox" class="file-check" ${checked} data-path="${this.escAttr(f.path)}">
  <span class="badge ${badge.cls}">${badge.text}</span>
  ${stat}
  <span class="file-name">${this.esc(name)}${rename}</span>
  <span class="file-dir">${this.esc(dir)}</span>
</div>`;
      })
      .join('');
  }

  /** 树形模式：目录分组，目录复选框控制其下全部文件，点击目录名折叠/展开 */
  private renderTree(nodes: FileTreeNode[], depth: number): string {
    return nodes
      .map((n) => {
        if (n.kind === 'dir') {
          const collapsed = this.collapsedDirs.has(n.path);
          const childFiles = collectFiles(n);
          const selectedCount = childFiles.filter((f) => this.selected.has(f.path)).length;
          const all = childFiles.length > 0 && selectedCount === childFiles.length;
          const indeterminate = selectedCount > 0 && !all;
          const indent = 10 + depth * 14;
          const twisty = `<span class="dir-twisty${collapsed ? '' : ' open'}" title="展开/折叠"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 1.5 8.5 6 4.5 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
          const row = `<div class="dir-row" data-dir="${this.escAttr(n.path)}" style="padding-left:${indent}px" title="${this.escAttr(n.path)}">
  ${twisty}
  <input type="checkbox" class="dir-check" data-dir="${this.escAttr(n.path)}"${all ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}>
  <span class="dir-name">${this.esc(n.label)}</span>
  <span class="dir-count">${selectedCount}/${childFiles.length}</span>
</div>`;
          return collapsed ? row : row + this.renderTree(n.children ?? [], depth + 1);
        }
        const f = n.file!;
        const badge = statusBadge(f);
        const checked = this.selected.has(f.path) ? 'checked' : '';
        const stat = this.fileStatHtml(f.path);
        const rename = f.origPath ? `<span class="rename">← ${f.origPath}</span>` : '';
        const indent = 10 + depth * 14 + 16;
        return `<div class="file-row${this.selectedPath === f.path ? ' active' : ''}" data-path="${this.escAttr(f.path)}" style="padding-left:${indent}px" title="${this.escAttr(f.path)}">
  <input type="checkbox" class="file-check" ${checked} data-path="${this.escAttr(f.path)}">
  <span class="badge ${badge.cls}">${badge.text}</span>
  ${stat}
  <span class="file-name">${this.esc(n.label)}${rename}</span>
</div>`;
      })
      .join('');
  }

  /** 行事件绑定（列表/树形共用） */
  private bindListEvents(): void {
    this.listEl.querySelectorAll<HTMLElement>('.file-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('file-check')) return;
        this.selectFile(row.dataset.path!);
      });
      row.addEventListener('dblclick', () => {
        const path = row.dataset.path!;
        const file = this.files.find((f) => f.path === path);
        this.client.command('openNativeDiff', {
          path,
          staged: String(this.isStagedView(file)),
        });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.selectFile(row.dataset.path!);
        this.showContextMenu(e.clientX, e.clientY, row.dataset.path!);
      });
    });
    this.listEl.querySelectorAll<HTMLInputElement>('.file-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const p = cb.dataset.path!;
        this.userTouched.add(p);
        if (cb.checked) this.selected.add(p);
        else this.selected.delete(p);
        // 树形模式下同步目录复选框的勾选/半选态；列表模式仅需更新底部统计
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
      // HTML 无 indeterminate 属性，需 JS 设置（部分选中态）
      if (cb.dataset.indeterminate) cb.indeterminate = true;
    });
  }

  private selectFile(path: string): void {
    this.selectedPath = path;
    this.renderList();
    void this.showDiff(path);
    this.persist();
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

  private isStagedView(file?: FileStatus): boolean {
    if (!file) return false;
    if (file.conflicted) return false;
    return file.index !== 'none';
  }

  private async showDiff(path?: string): Promise<void> {
    if (!path) {
      this.diffEl.innerHTML = '<div class="diff-empty">选择文件以查看差异</div>';
      this.statEl.textContent = '';
      this.must('diff-title').textContent = '差异';
      return;
    }
    const file = this.files.find((f) => f.path === path);
    const staged = this.isStagedView(file);
    this.must('diff-title').textContent = `${path}（${staged ? '已暂存' : '工作区'}）`;
    try {
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path,
        staged,
      });
      this.diffEl.innerHTML = renderDiff(patch, this.diffMode, tail, path);
      bindDiffInteractions(
        this.diffEl,
        this.client,
        { repoRoot: this.repoRoot, path, staged },
        this.diffMode,
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
    }
  }

  private showContextMenu(x: number, y: number, path: string): void {
    const menu = this.must('ctx-menu');
    const items: Array<{ label: string; action: () => void }> = [
      {
        label: '暂存 (Stage)',
        action: () => void this.client.send('status:stage', { repoRoot: this.repoRoot, paths: [path] }),
      },
      {
        label: '取消暂存 (Unstage)',
        action: () => void this.client.send('status:unstage', { repoRoot: this.repoRoot, paths: [path] }),
      },
      {
        label: '放弃修改 (Revert)',
        action: async () => {
          const ok = await this.confirm(`确定放弃 ${path} 的修改？此操作不可恢复。`);
          if (ok) {
            await this.client.send('status:discard', { repoRoot: this.repoRoot, paths: [path] });
          }
        },
      },
      {
        label: '添加到 .gitignore',
        action: () => void this.client.send('status:ignore', { repoRoot: this.repoRoot, paths: [path] }),
      },
    ];
    menu.innerHTML = items
      .map((it, i) => `<div class="ctx-item" data-i="${i}">${it.label}</div>`)
      .join('');
    menu.hidden = false;
    // 先按点击点摆放，再测量实际尺寸做边界翻转（复刻原生菜单的贴边翻转行为）
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    // 超出右边界：整体左移到视口内
    if (left + rect.width + 4 > vw) left = Math.max(4, vw - rect.width - 4);
    // 超出下边界：向上翻转到点击点上方；仍放不下则限高滚动
    if (top + rect.height + 4 > vh) top = Math.max(4, y - rect.height);
    if (top + rect.height + 4 > vh) {
      top = 4;
      menu.style.maxHeight = `${vh - 8}px`;
      menu.style.overflowY = 'auto';
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelectorAll<HTMLElement>('.ctx-item').forEach((el) => {
      el.addEventListener('click', () => {
        menu.hidden = true;
        items[Number(el.dataset.i)].action();
      });
    });
    setTimeout(() => {
      document.addEventListener('click', () => (menu.hidden = true), { once: true });
    }, 0);
  }

  private async confirm(text: string): Promise<boolean> {
    // webview 内无法直接调用 vscode.window，走 RPC 命令交由宿主弹窗
    return this.client.send('ui:confirm' as never, { text } as never) as Promise<boolean>;
  }

  // ---------- 提交 ----------

  private async commit(): Promise<void> {
    if (this.busy) return;
    const message = this.msgEl.value.trim();
    if (!message) {
      this.flash('请先输入提交信息。');
      this.msgEl.focus();
      return;
    }
    const stagedCount = this.files.filter((f) => f.index !== 'none').length;
    if (this.selected.size === 0 && stagedCount === 0) {
      this.flash('没有可提交的内容。');
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
        signOffName: this.inpSignOff.value.trim(),
        pushAfter: this.chkPush.checked,
      });
      this.msgEl.value = '';
      this.chkAmend.checked = false;
      this.clearPersistedState();
      let text = `提交成功：${result.hash.slice(0, 7)}`;
      if (result.pushed === true) text += `（已推送：${result.pushMessage || '完成'}）`;
      else if (result.pushed === false) text += `（推送失败：${result.pushMessage || '未知原因'}）`;
      this.toast(text);
      const closeAfter = (this.must('chk-closeafter') as HTMLInputElement).checked;
      if (closeAfter) {
        this.client.command('closePanel');
      }
    } catch (err) {
      this.toast(`提交失败：${String(err)}`, true);
    } finally {
      this.busy = false;
      this.btnCommit.disabled = false;
      this.btnCommit.textContent = '提交';
    }
  }

  private flash(text: string): void {
    this.toast(text, true);
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

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
