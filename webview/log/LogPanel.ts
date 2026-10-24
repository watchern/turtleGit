import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions } from '../diff/expander';
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
  <button id="btn-refresh" title="刷新 (F5)">刷新</button>
  <label class="chk"><input type="checkbox" id="chk-all"> 所有分支</label>
  <input type="search" id="flt-author" class="filter" placeholder="作者">
  <input type="search" id="flt-grep" class="filter" placeholder="信息关键字">
  <span class="flex"></span>
  <button id="btn-prev" class="mini" title="上一页">上一页</button>
  <span class="page-info" id="page-info"></span>
  <button id="btn-next" class="mini" title="下一页">下一页</button>
</div>
<div class="split log-split">
  <section class="pane left">
    <div class="pane-head"><span>提交</span><span class="count" id="commit-count"></span></div>
    <div class="commit-list" id="commit-list"></div>
  </section>
  <section class="pane right">
    <div class="pane-head"><span id="commit-title">变更文件</span><span class="count" id="file-count"></span></div>
    <div class="file-list" id="file-list"></div>
    <div class="pane-head">
      <span>差异</span><span class="diff-stat" id="diff-stat"></span>
      <span class="flex"></span>
      <button class="mini" id="btn-diff-mode">并排</button>
      <button class="mini" id="btn-open-editor">在编辑器中打开</button>
    </div>
    <div class="diff-view" id="diff-view"><div class="diff-empty">选择文件以查看差异</div></div>
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
      this.must('btn-diff-mode').textContent = this.diffMode === 'side' ? '并排' : '统一';
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
      this.listEl.innerHTML = `<div class="empty">读取日志失败：${this.esc(String(err))}</div>`;
      return;
    }
    this.renderList();
  }

  private renderList(): void {
    this.must('commit-count').textContent = `（${this.commits.length}）`;
    this.must('page-info').textContent = `${this.skip + 1}–${this.skip + this.commits.length}`;
    if (!this.commits.length) {
      this.listEl.innerHTML = '<div class="empty">没有提交记录</div>';
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
      { label: '检出 (Checkout)', action: () => void this.runAction('checkout', hash) },
      { label: '在此创建分支…', action: () => void this.runAction('branch', hash) },
      { label: '在此创建标签…', action: () => void this.runAction('tag', hash) },
      { label: '合并 (Merge)', action: () => void this.runAction('merge', hash) },
      { label: '拣选 (Cherry-pick)', action: () => void this.runAction('cherry', hash) },
      { label: '重置到此处 (Reset)', action: () => void this.runAction('reset', hash) },
      { label: '还原此提交 (Revert)', action: () => void this.runAction('revert', hash) },
      {
        label: '复制提交哈希',
        action: () => {
          void navigator.clipboard?.writeText(hash).catch(() => undefined);
          toast(`已复制 ${hash.slice(0, 7)}`);
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
          toast(`已检出 ${short}（分离头指针）`);
          break;
        case 'branch': {
          const name = promptValue('新分支名称：', `branch-${short}`);
          if (name) {
            await this.client.send('branch:create', {
              repoRoot: this.repoRoot,
              name,
              ref: hash,
              checkout: true,
            });
            toast(`已创建并切换到 ${name}`);
          }
          break;
        }
        case 'tag': {
          const name = promptValue('标签名称：', `v-${short}`);
          if (name) {
            await this.client.send('tag:create', { repoRoot: this.repoRoot, name, ref: hash });
            toast(`已创建标签 ${name}`);
          }
          break;
        }
        case 'merge':
          if (await this.client.send('ui:confirm', { text: `确定将 ${short} 合并到当前分支？` })) {
            await this.client.send('merge:run', { repoRoot: this.repoRoot, ref: hash });
            toast('合并完成');
          }
          break;
        case 'cherry':
          await this.client.send('cherryPick:run', { repoRoot: this.repoRoot, hashes: [hash] });
          toast('拣选完成');
          break;
        case 'reset': {
          const mode = await this.chooseResetMode();
          if (mode) {
            await this.client.send('reset:run', { repoRoot: this.repoRoot, ref: hash, mode });
            toast('重置完成');
          }
          break;
        }
        case 'revert':
          await this.client.send('revert:run', { repoRoot: this.repoRoot, hash });
          toast('还原完成');
          break;
      }
      void this.reload();
    } catch (err) {
      toast(`操作失败：${String(err)}`, true);
    }
  }

  private chooseResetMode(): Promise<'soft' | 'mixed' | 'hard' | null> {
    return new Promise((resolve) => {
      const options: Array<'soft' | 'mixed' | 'hard'> = ['soft', 'mixed', 'hard'];
      const labels = ['soft（保留暂存区）', 'mixed（默认，保留工作区）', 'hard（全部丢弃，危险）'];
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
    this.must('commit-title').textContent = `${commit ? commit.subject : hash} 的变更文件`;
    try {
      this.files = await this.client.send('log:files', { repoRoot: this.repoRoot, hash });
    } catch (err) {
      this.files = [];
      toast(`读取提交文件失败：${String(err)}`, true);
    }
    this.renderFiles();
  }

  private renderFiles(): void {
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = '<div class="empty">该提交没有文件变更</div>';
      this.diffEl.innerHTML = '<div class="diff-empty">选择文件以查看差异</div>';
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

  private async showDiff(): Promise<void> {
    if (!this.currentFile || !this.selectedHash) {
      this.diffEl.innerHTML = '<div class="diff-empty">选择文件以查看差异</div>';
      return;
    }
    try {
      const patch = await this.client.send('diff:patch', {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range: `${this.selectedHash}^..${this.selectedHash}`,
      });
      this.diffEl.innerHTML = renderDiff(patch, this.diffMode);
      bindDiffInteractions(
        this.diffEl,
        this.client,
        {
          repoRoot: this.repoRoot,
          path: this.currentFile.path,
          staged: false,
          range: `${this.selectedHash}^..${this.selectedHash}`,
        },
        this.diffMode,
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
    }
  }

  private esc(s: string): string {
    return escapeHtml(s);
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
