import { RpcClient } from '../bridge';
import { t } from '../i18n';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { toast, promptValue, escapeHtml } from '../ui/dialogs';
import { StashEntry, CommitFile } from '../../shared/protocol';

/**
 * Stash 管理（主窗口编辑器标签内打开）：复刻 TortoiseGit Stash 对话框。
 * 默认三列布局：Stash 列表 | 变更文件 | 文件差异。
 * 一个 stash 常含多个文件，每文件可分别查看改动记录。
 * 侧边栏「查看」入口（带入 stashRef）只聚焦某一条 stash——此时隐藏
 * Stash 列表列（用户已在侧边栏选好），只保留「变更文件 | 差异」两列。
 */
export class StashPanel {
  private stashes: StashEntry[] = [];
  private files: CommitFile[] = [];
  private selected: StashEntry | undefined;
  private currentFile: CommitFile | undefined;
  /** 首次 reload 后需要预选的 stash ref（侧边栏「查看」带入） */
  private pendingRef: string | undefined;
  /** 带入 ref 时不显示 Stash 列表列（两列布局） */
  private readonly hideList: boolean;

  private el: HTMLElement;
  private listEl: HTMLElement | undefined;
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
    this.hideList = !!stashRef;
    this.build();
    void this.reload();
  }

  private build(): void {
    const listPane = this.hideList
      ? ''
      : `
  <section class="pane left">
    <div class="pane-head"><span>${t('stash.list')}</span><span class="count" id="stash-count"></span></div>
    <div class="commit-list" id="stash-list"></div>
  </section>`;
    this.el.innerHTML = `
<div class="toolbar">
  <button class="primary" id="btn-push">${t('stash.save')}</button>
  <button id="btn-refresh">${t('common.refresh')}</button>
  <span class="sep"></span>
  <button id="btn-apply" disabled>${t('stash.apply')}</button>
  <button id="btn-pop" disabled>${t('stash.pop')}</button>
  <button id="btn-drop" disabled>${t('stash.drop')}</button>
  <span class="flex"></span>
  <span class="repo-name"></span>
</div>
<div class="split stash-split${this.hideList ? ' no-list' : ''}">
${listPane}
  <section class="pane mid">
    <div class="pane-head"><span>${t('common.files')}</span><span class="count" id="file-count"></span></div>
    <div class="file-list" id="stash-files"></div>
  </section>
  <section class="pane right">
    <div class="pane-head"><span id="diff-title">${t('stash.diffTitle')}</span><span class="diff-stat" id="diff-stat"></span><span class="flex"></span><button class="mini" id="btn-open-editor" title="${t('stash.openEditorTip')}" disabled>${t('common.openEditor')}</button></div>
    <div class="diff-view full" id="diff-view"><div class="diff-empty">${t('stash.selectHint')}</div></div>
  </section>
</div>
`;
    this.listEl = this.hideList ? undefined : this.must('stash-list');
    this.filesEl = this.must('stash-files');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');
    this.diffTitleEl = this.must('diff-title');

    this.must('btn-refresh').addEventListener('click', () => void this.reload());
    this.must('btn-push').addEventListener('click', () => void this.push());
    this.must('btn-apply').addEventListener('click', () => void this.run('apply'));
    this.must('btn-pop').addEventListener('click', () => void this.run('pop'));
    this.must('btn-drop').addEventListener('click', () => void this.run('drop'));
    this.must('btn-open-editor').addEventListener('click', () => {
      if (!this.selected || !this.currentFile) return;
      // 复用 openCommitDiff 命令：`stash@{n}^..stash@{n}` 即 stash 与其基线，
      // 与面板内展示的差异完全一致（GitBlobProvider 的 turtlegit: scheme 取两侧内容）
      this.client.command('openCommitDiff', {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        hash: this.selected.ref,
      });
    });

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
      if (this.listEl) this.listEl.innerHTML = `<div class="empty">${t('common.readFailed', this.esc(String(err)))}</div>`;
      else this.showEmptyDiff();
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
      // ref 已不存在（被删除/弹出）：清理并提示
      this.selected = undefined;
      this.files = [];
      this.currentFile = undefined;
      this.renderList();
      this.renderFiles();
      this.showEmptyDiff();
      return;
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
    this.updateActions();
    if (!this.listEl) return; // 无列表模式（侧边栏带入 ref）
    this.must('stash-count').textContent = `（${this.stashes.length}）`;
    if (!this.stashes.length) {
      this.listEl.innerHTML = `<div class="empty">${t('stash.noStash')}</div>`;
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
    this.diffTitleEl.textContent = t('stash.ofRef', ref);
    try {
      this.files = await this.client.send('log:files', { repoRoot: this.repoRoot, hash: ref });
    } catch (err) {
      this.files = [];
      toast(t('stash.readFilesFailed', String(err)), true);
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

  /** 应用/恢复/删除/在编辑器打开按钮的可用状态（两种布局模式共用） */
  private updateActions(): void {
    (this.must('btn-apply') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-pop') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-drop') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-open-editor') as HTMLButtonElement).disabled = !this.selected || !this.currentFile;
  }

  private renderFiles(): void {
    this.updateActions();
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = `<div class="empty">${t('stash.noFileChanges')}</div>`;
      return;
    }
    const badge: Record<string, string> = { A: t('status.added'), M: t('status.modified'), D: t('status.deleted'), R: t('branches.renameOp'), C: t('status.copied'), T: t('status.type'), U: t('status.conflict') };
    this.filesEl.innerHTML = this.files
      .map((f) => {
        const stat = f.isBinary ? t('common.binary') : `+${f.additions} -${f.deletions}`;
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
    this.diffEl.innerHTML = this.hideList
      ? `<div class="diff-empty">${t('stash.gone')}</div>`
      : `<div class="diff-empty">${t('stash.selectHint')}</div>`;
    this.statEl.textContent = '';
    this.diffTitleEl.textContent = t('stash.diffTitle');
  }

  /** 单个文件的 stash 差异：diff:patch 的 path + range 组合 */
  private async showDiff(): Promise<void> {
    if (!this.selected || !this.currentFile) {
      this.showEmptyDiff();
      return;
    }
    try {
      const range = `${this.selected.ref}^..${this.selected.ref}`;
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range,
      });
      this.diffEl.innerHTML = renderDiff(patch, 'side', tail, this.currentFile.path);
      this.diffTitleEl.textContent = `${this.currentFile.path}（${this.selected.ref}）`;
      bindDiffInteractions(this.diffEl, this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range,
      }, 'side');
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">${t('common.diffFailed', this.esc(String(err)))}</div>`;
      this.statEl.textContent = '';
    }
  }

  private async push(): Promise<void> {
    const message = await promptValue(t('stash.prompt'), '');
    try {
      await this.client.send('stash:push', {
        repoRoot: this.repoRoot,
        message: message?.trim() || undefined,
      });
      toast(t('stash.saved'));
      await this.reload();
    } catch (err) {
      toast(t('stash.saveFailed', String(err)), true);
    }
  }

  private async run(op: 'apply' | 'pop' | 'drop'): Promise<void> {
    if (!this.selected) return;
    if (op === 'drop' && !(await this.client.send('ui:confirm', { text: t('stash.confirmDelete', this.selected.ref) }))) {
      return;
    }
    try {
      await this.client.send(`stash:${op}` as never, { repoRoot: this.repoRoot, index: this.selected.index } as never);
      toast(t(op === 'apply' ? 'stash.applied' : op === 'pop' ? 'stash.popped' : 'stash.dropped', this.selected.ref));
      this.selected = undefined;
      this.files = [];
      this.currentFile = undefined;
      this.renderFiles();
      this.showEmptyDiff();
      await this.reload();
    } catch (err) {
      toast(t('common.opFailed', String(err)), true);
    }
  }

  private esc(s: string): string {
    return escapeHtml(s);
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
