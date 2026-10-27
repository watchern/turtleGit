import { RpcClient } from '../bridge';
import { t } from '../i18n';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { toast, promptValue, showMenuAt, escapeHtml } from '../ui/dialogs';
import { CommitFile, CommitInfo } from '../../shared/protocol';

/**
 * 日志对话框：复刻 TortoiseGit Log Dialog。
 * 左：提交列表；右：选中提交的变更文件；底部：文件差异预览。
 */
export class LogPanel {
  private commits: CommitInfo[] = [];
  private files: CommitFile[] = [];
  private selectedHash: string | undefined;
  private skip = 0;
  private readonly pageSize = 100;
  private showAll = false;
  private diffMode: 'side' | 'unified' = 'side';

  private el: HTMLElement;
  private listEl!: HTMLElement;
  private filesEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private statEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    filterPath?: string,
  ) {
    this.el = root;
    this.build();
    void this.reload();
    this.bindEvents();
  }

  private build(): void {
    this.el.innerHTML = `
<div class="toolbar">
  <button id="btn-refresh" title="${t('common.refreshTip')}">${t('common.refresh')}</button>
  <label class="chk"><input type="checkbox" id="chk-all"> ${t('log.allBranches')}</label>
  <input type="search" id="flt-author" class="filter" placeholder="${t('log.authorPlaceholder')}">
  <input type="search" id="flt-grep" class="filter" placeholder="${t('graph.grepPlaceholder')}">
  <span class="flex"></span>
  <button id="btn-prev" class="mini" title="${t('log.prevPage')}">${t('log.prevPage')}</button>
  <span class="page-info" id="page-info"></span>
  <button id="btn-next" class="mini" title="${t('log.nextPage')}">${t('log.nextPage')}</button>
</div>
<div class="split log-split">
  <section class="pane left">
    <div class="pane-head"><span>${t('commit.btn.commit')}</span><span class="count" id="commit-count"></span></div>
    <div class="commit-list" id="commit-list"></div>
  </section>
  <section class="pane right">
    <div class="pane-head"><span id="commit-title">${t('common.files')}</span><span class="count" id="file-count"></span></div>
    <div class="file-list" id="file-list"></div>
    <div class="pane-head">
      <span>${t('common.diff')}</span><span class="diff-stat" id="diff-stat"></span>
      <span class="flex"></span>
      <button class="mini" id="btn-diff-mode">${t('diff.modeSide')}</button>
      <button class="mini" id="btn-open-editor">${t('common.openEditor')}</button>
    </div>
    <div class="diff-view" id="diff-view"><div class="diff-empty">${t('common.selectFileDiff')}</div></div>
  </section>
</div>
<div class="ctx-menu" id="ctx-menu" hidden></div>
`;
    this.listEl = this.must('commit-list');
    this.filesEl = this.must('file-list');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');

    this.must('btn-refresh').addEventListener('click', () => void this.reload());
    (this.must('chk-all') as HTMLInputElement).addEventListener('change', (e) => {
      this.showAll = (e.target as HTMLInputElement).checked;
      this.skip = 0;
      void this.reload();
    });
    this.must('flt-grep').addEventListener('change', () => {
      this.skip = 0;
      void this.reload();
    });
    this.must('flt-author').addEventListener('change', () => {
      this.skip = 0;
      void this.reload();
    });
    this.must('btn-prev').addEventListener('click', () => {
      this.skip = Math.max(0, this.skip - this.pageSize);
      void this.reload();
    });
    this.must('btn-next').addEventListener('click', () => {
      this.skip += this.pageSize;
      void this.reload();
    });
    this.must('btn-diff-mode').addEventListener('click', () => {
      this.diffMode = this.diffMode === 'side' ? 'unified' : 'side';
      this.must('btn-diff-mode').textContent = this.diffMode === 'side' ? t('diff.modeSide') : t('diff.modeUnified');
      void this.showDiff();
    });
    this.must('btn-open-editor').addEventListener('click', () => {
      const file = this.currentFile;
      if (!file || !this.selectedHash) return;
      this.client.command('openCommitDiff', {
        hash: this.selectedHash,
        path: file.path,
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

  private currentFile: CommitFile | undefined;

  private bindEvents(): void {
    this.client.on('status:changed', () => {
      // 外部写操作后刷新当前选中提交的文件列表可能失效，轻量忽略
    });
  }

  private async reload(): Promise<void> {
    try {
      this.commits = await this.client.send('log:list', {
        repoRoot: this.repoRoot,
        skip: this.skip,
        limit: this.pageSize,
        all: this.showAll,
        author: (this.must('flt-author') as HTMLInputElement).value.trim() || undefined,
        grep: (this.must('flt-grep') as HTMLInputElement).value.trim() || undefined,
      });
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty">${t('log.loadFailed', this.esc(String(err)))}</div>`;
      return;
    }
    this.renderList();
  }

  private renderList(): void {
    this.must('commit-count').textContent = `（${this.commits.length}）`;
    this.must('page-info').textContent = `${this.skip + 1}–${this.skip + this.commits.length}`;
    if (!this.commits.length) {
      this.listEl.innerHTML = `<div class="empty">${t('log.noCommits')}</div>`;
      return;
    }
    this.listEl.innerHTML = this.commits
      .map((c) => {
        const refs = c.refs.length
          ? `<div class="refs">${c.refs.map((r) => `<span class="ref">${this.esc(r)}</span>`).join('')}</div>`
          : '';
        const date = new Date(c.authorDate);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return `<div class="commit-row${this.selectedHash === c.hash ? ' active' : ''}" data-hash="${c.hash}">
  <div class="commit-line1">
    <span class="hash" title="${c.hash}">${c.shortHash}</span>
    <span class="subject">${this.esc(c.subject)}</span>
  </div>
  <div class="commit-line2">
    <span class="author">${this.esc(c.author)}</span>
    <span class="date">${dateStr}</span>
    ${refs}
  </div>
</div>`;
      })
      .join('');
    this.listEl.querySelectorAll<HTMLElement>('.commit-row').forEach((row) => {
      row.addEventListener('click', () => this.selectCommit(row.dataset.hash!));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void this.selectCommit(row.dataset.hash!);
        this.showContextMenu(e.clientX, e.clientY, row.dataset.hash!);
      });
    });
  }

  /** TortoiseGit Log Dialog 标志性的提交右键操作集 */
  private showContextMenu(x: number, y: number, hash: string): void {
    const items: Array<{ label: string; action: () => void }> = [
      { label: t('branches.menu.checkout'), action: () => void this.runAction('checkout', hash) },
      { label: t('cm.branchHere'), action: () => void this.runAction('branch', hash) },
      { label: t('cm.tagHere'), action: () => void this.runAction('tag', hash) },
      { label: t('log.menu.merge'), action: () => void this.runAction('merge', hash) },
      { label: t('log.menu.cherry'), action: () => void this.runAction('cherry', hash) },
      { label: t('cm.reset'), action: () => void this.runAction('reset', hash) },
      { label: t('cm.revert'), action: () => void this.runAction('revert', hash) },
      {
        label: t('cm.copyHash'),
        action: () => {
          void navigator.clipboard?.writeText(hash).catch(() => undefined);
          toast(t('cm.copied', hash.slice(0, 7)));
        },
      },
    ];
    showMenuAt(
      this.must('ctx-menu'),
      x,
      y,
      items.map((it) => ({ label: it.label })),
      (i) => items[i].action(),
    );
  }

  private async runAction(act: string, hash: string): Promise<void> {
    const short = hash.slice(0, 7);
    try {
      switch (act) {
        case 'checkout':
          await this.client.send('branch:checkout', { repoRoot: this.repoRoot, ref: hash });
          toast(t('cm.checkedOutDetached', short));
          break;
        case 'branch': {
          const name = await promptValue(t('branches.newBranchPrompt'), `branch-${short}`);
          if (name) {
            await this.client.send('branch:create', {
              repoRoot: this.repoRoot,
              name,
              ref: hash,
              checkout: true,
            });
            toast(t('cm.createdBranch', name));
          }
          break;
        }
        case 'tag': {
          const name = await promptValue(t('cm.tagPrompt'), `v-${short}`);
          if (name) {
            await this.client.send('tag:create', { repoRoot: this.repoRoot, name, ref: hash });
            toast(t('cm.createdTag', name));
          }
          break;
        }
        case 'merge':
          if (await this.client.send('ui:confirm', { text: t('cm.mergeConfirm', short) })) {
            await this.client.send('merge:run', { repoRoot: this.repoRoot, ref: hash });
            toast(t('cm.mergeDone'));
          }
          break;
        case 'cherry':
          await this.client.send('cherryPick:run', { repoRoot: this.repoRoot, hashes: [hash] });
          toast(t('cm.cherryDone'));
          break;
        case 'reset': {
          const mode = await this.chooseResetMode();
          if (mode) {
            await this.client.send('reset:run', { repoRoot: this.repoRoot, ref: hash, mode });
            toast(t('cm.resetDone'));
          }
          break;
        }
        case 'revert':
          await this.client.send('revert:run', { repoRoot: this.repoRoot, hash });
          toast(t('cm.revertDone'));
          break;
      }
      void this.reload();
    } catch (err) {
      toast(t('common.opFailed', String(err)), true);
    }
  }

  private chooseResetMode(): Promise<'soft' | 'mixed' | 'hard' | null> {
    return new Promise((resolve) => {
      const options: Array<'soft' | 'mixed' | 'hard'> = ['soft', 'mixed', 'hard'];
      const labels = [t('cm.resetSoft'), t('cm.resetMixed'), t('cm.resetHard')];
      showMenuAt(
        this.must('ctx-menu'),
        Math.round(window.innerWidth / 2 - 60),
        Math.round(window.innerHeight / 3),
        labels.map((l) => ({ label: l })),
        (i) => resolve(options[i]),
      );
      setTimeout(() => resolve(null), 0);
    });
  }

  private async selectCommit(hash: string): Promise<void> {
    this.selectedHash = hash;
    this.currentFile = undefined;
    this.renderList();
    const commit = this.commits.find((c) => c.hash === hash);
    this.must('commit-title').textContent = t('log.filesTitle', commit ? commit.subject : hash);
    try {
      this.files = await this.client.send('log:files', { repoRoot: this.repoRoot, hash });
    } catch (err) {
      this.files = [];
      toast(t('log.readFilesFailed', String(err)), true);
    }
    this.renderFiles();
  }

  private renderFiles(): void {
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = `<div class="empty">${t('graph.noFileChanges')}</div>`;
      this.diffEl.innerHTML = `<div class="diff-empty">${t('common.selectFileDiff')}</div>`;
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

  private async showDiff(): Promise<void> {
    if (!this.currentFile || !this.selectedHash) {
      this.diffEl.innerHTML = `<div class="diff-empty">${t('common.selectFileDiff')}</div>`;
      return;
    }
    try {
      const range = `${this.selectedHash}^..${this.selectedHash}`;
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range,
      });
      this.diffEl.innerHTML = renderDiff(patch, this.diffMode, tail, this.currentFile.path);
      bindDiffInteractions(
        this.diffEl,
        this.client,
        {
          repoRoot: this.repoRoot,
          path: this.currentFile.path,
          staged: false,
          range,
        },
        this.diffMode,
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">${t('common.diffFailed', this.esc(String(err)))}</div>`;
    }
  }

  private esc(s: string): string {
    return escapeHtml(s);
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
