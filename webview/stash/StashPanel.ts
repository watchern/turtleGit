import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions } from '../diff/expander';
import { toast, promptValue, escapeHtml } from '../ui/dialogs';
import { StashEntry, CommitFile } from '../../shared/protocol';

/**
 * Stash 管理（主窗口编辑器标签内打开）：复刻 TortoiseGit Stash 对话框。
 * 三列布局：Stash 列表 | 变更文件 | 文件差异。
 * 一个 stash 常含多个文件，每文件可分别查看改动记录（侧边栏「查看」入口指向本面板）。
 */
export class StashPanel {
  private stashes: StashEntry[] = [];
  private files: CommitFile[] = [];
  private selected: StashEntry | undefined;
  private currentFile: CommitFile | undefined;
  /** 首次 reload 后需要预选的 stash ref（侧边栏「查看」带入） */
  private pendingRef: string | undefined;

  private el: HTMLElement;
  private listEl!: HTMLElement;
  private filesEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private statEl!: HTMLElement;
  private diffTitleEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    stashRef?: string,
  ) {
    this.el = root;
    this.pendingRef = stashRef;
    this.build();
    void this.reload();
  }

  private build(): void {
    this.el.innerHTML = `
<div class="toolbar">
  <button class="primary" id="btn-push">保存 Stash…</button>
  <button id="btn-refresh">刷新</button>
  <span class="sep"></span>
  <button id="btn-apply" disabled>应用 (Apply)</button>
  <button id="btn-pop" disabled>恢复 (Pop)</button>
  <button id="btn-drop" disabled>删除 (Drop)</button>
  <span class="flex"></span>
  <span class="repo-name"></span>
</div>
<div class="split stash-split">
  <section class="pane left">
    <div class="pane-head"><span>Stash 列表</span><span class="count" id="stash-count"></span></div>
    <div class="commit-list" id="stash-list"></div>
  </section>
  <section class="pane mid">
    <div class="pane-head"><span>变更文件</span><span class="count" id="file-count"></span></div>
    <div class="file-list" id="stash-files"></div>
  </section>
  <section class="pane right">
    <div class="pane-head"><span id="diff-title">差异（stash 与其基线）</span><span class="diff-stat" id="diff-stat"></span></div>
    <div class="diff-view full" id="diff-view"><div class="diff-empty">选择 stash 查看差异</div></div>
  </section>
</div>
`;
    this.listEl = this.must('stash-list');
    this.filesEl = this.must('stash-files');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');
    this.diffTitleEl = this.must('diff-title');

    this.must('btn-refresh').addEventListener('click', () => void this.reload());
    this.must('btn-push').addEventListener('click', () => void this.push());
    this.must('btn-apply').addEventListener('click', () => void this.run('apply'));
    this.must('btn-pop').addEventListener('click', () => void this.run('pop'));
    this.must('btn-drop').addEventListener('click', () => void this.run('drop'));

    document.addEventListener('keydown', (e) => {
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

  private async reload(): Promise<void> {
    try {
      this.stashes = await this.client.send('stash:list', { repoRoot: this.repoRoot });
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty">读取失败：${this.esc(String(err))}</div>`;
      return;
    }
    // 预选（侧边栏「查看」带入的 ref）：仅生效一次
    if (this.pendingRef) {
      const hit = this.stashes.find((s) => s.ref === this.pendingRef);
      this.pendingRef = undefined;
      if (hit) {
        this.selected = hit;
        this.renderList();
        await this.selectStash(hit.ref);
        return;
      }
    }
    // 已选 stash 被删除/弹出后清理
    if (this.selected && !this.stashes.some((s) => s.ref === this.selected!.ref)) {
      this.selected = undefined;
      this.files = [];
      this.currentFile = undefined;
      this.renderFiles();
      this.showEmptyDiff();
    }
    this.renderList();
  }

  private renderList(): void {
    this.must('stash-count').textContent = `（${this.stashes.length}）`;
    (this.must('btn-apply') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-pop') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-drop') as HTMLButtonElement).disabled = !this.selected;
    if (!this.stashes.length) {
      this.listEl.innerHTML = '<div class="empty">没有 stash</div>';
      this.files = [];
      this.currentFile = undefined;
      this.renderFiles();
      this.showEmptyDiff();
      return;
    }
    this.listEl.innerHTML = this.stashes
      .map((s) => `<div class="commit-row${this.selected?.ref === s.ref ? ' active' : ''}" data-ref="${this.escAttr(s.ref)}">
  <div class="commit-line1"><span class="hash">${this.esc(s.ref)}</span><span class="subject">${this.esc(s.message)}</span></div>
  <div class="commit-line2">${s.branch ? `<span class="author">on ${this.esc(s.branch)}</span>` : ''}<span class="date mono">${this.esc(s.commit.slice(0, 7))}</span></div>
</div>`)
      .join('');
    this.listEl.querySelectorAll<HTMLElement>('.commit-row').forEach((row) => {
      row.addEventListener('click', () => {
        this.selected = this.stashes.find((s) => s.ref === row.dataset.ref);
        this.renderList();
        void this.selectStash(this.selected!.ref);
      });
    });
  }

  /** 选中 stash：加载其变更文件列表，并默认展示第一个文件的差异 */
  private async selectStash(ref: string): Promise<void> {
    this.currentFile = undefined;
    this.diffTitleEl.textContent = `${ref} 的变更`;
    try {
      this.files = await this.client.send('log:files', { repoRoot: this.repoRoot, hash: ref });
    } catch (err) {
      this.files = [];
      toast(`读取 stash 文件失败：${String(err)}`, true);
    }
    this.renderFiles();
    if (this.files.length) {
      this.currentFile = this.files[0];
      this.renderFiles();
      await this.showDiff();
    } else {
      this.showEmptyDiff();
    }
  }

  private renderFiles(): void {
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = '<div class="empty">没有文件变更</div>';
      return;
    }
    const badge: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型', U: '冲突' };
    this.filesEl.innerHTML = this.files
      .map((f) => {
        const stat = f.isBinary ? '二进制' : `+${f.additions} -${f.deletions}`;
        return `<div class="file-row${this.currentFile?.path === f.path ? ' active' : ''}" data-path="${this.escAttr(f.path)}" title="${this.escAttr(f.path)}">
  <span class="badge st-${f.status === 'A' ? 'staged' : f.status === 'D' ? 'untracked' : 'modified'}" title="${this.escAttr(badge[f.status] ?? f.status)}">${f.status}</span>
  <span class="file-name">${this.esc(f.path)}</span>
  <span class="file-dir">${stat}</span>
</div>`;
      })
      .join('');
    this.filesEl.querySelectorAll<HTMLElement>('.file-row').forEach((row) => {
      row.addEventListener('click', () => {
        this.currentFile = this.files.find((f) => f.path === row.dataset.path);
        this.renderFiles();
        void this.showDiff();
      });
    });
  }

  private showEmptyDiff(): void {
    this.diffEl.innerHTML = '<div class="diff-empty">选择 stash 查看差异</div>';
    this.statEl.textContent = '';
    this.diffTitleEl.textContent = '差异（stash 与其基线）';
  }

  /** 单个文件的 stash 差异：diff:patch 的 path + range 组合 */
  private async showDiff(): Promise<void> {
    if (!this.selected || !this.currentFile) {
      this.showEmptyDiff();
      return;
    }
    try {
      const patch = await this.client.send('diff:patch', {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range: `${this.selected.ref}^..${this.selected.ref}`,
      });
      this.diffEl.innerHTML = renderDiff(patch, 'side');
      this.diffTitleEl.textContent = `${this.currentFile.path}（${this.selected.ref}）`;
      bindDiffInteractions(this.diffEl, this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range: `${this.selected.ref}^..${this.selected.ref}`,
      }, 'side');
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
      this.statEl.textContent = '';
    }
  }

  private async push(): Promise<void> {
    const message = await promptValue('Stash 消息（可留空）：', '');
    try {
      await this.client.send('stash:push', {
        repoRoot: this.repoRoot,
        message: message?.trim() || undefined,
      });
      toast('已保存 stash');
      await this.reload();
    } catch (err) {
      toast(`保存失败：${String(err)}`, true);
    }
  }

  private async run(op: 'apply' | 'pop' | 'drop'): Promise<void> {
    if (!this.selected) return;
    if (op === 'drop' && !(await this.client.send('ui:confirm', { text: `确定删除 ${this.selected.ref}？` }))) {
      return;
    }
    try {
      await this.client.send(`stash:${op}` as never, { repoRoot: this.repoRoot, index: this.selected.index } as never);
      toast(`已${op === 'apply' ? '应用' : op === 'pop' ? '恢复' : '删除'} ${this.selected.ref}`);
      this.selected = undefined;
      this.files = [];
      this.currentFile = undefined;
      this.renderFiles();
      this.showEmptyDiff();
      await this.reload();
    } catch (err) {
      toast(`操作失败：${String(err)}`, true);
    }
  }

  private esc(s: string): string {
    return escapeHtml(s);
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
