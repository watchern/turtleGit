import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions } from '../diff/expander';
import { toast, escapeHtml } from '../ui/dialogs';
import { StashEntry } from '../../shared/protocol';

/**
 * Stash 管理：复刻 TortoiseGit Stash 对话框（列表 + apply/pop/drop + push）。
 */
export class StashPanel {
  private stashes: StashEntry[] = [];
  private selected: StashEntry | undefined;

  private el: HTMLElement;
  private listEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private statEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
  ) {
    this.el = root;
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
  <section class="pane right">
    <div class="pane-head"><span>差异（stash 与其基线）</span><span class="diff-stat" id="diff-stat"></span></div>
    <div class="diff-view full" id="diff-view"><div class="diff-empty">选择 stash 查看差异</div></div>
  </section>
</div>
`;
    this.listEl = this.must('stash-list');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');

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
    this.renderList();
  }

  private renderList(): void {
    this.must('stash-count').textContent = `（${this.stashes.length}）`;
    (this.must('btn-apply') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-pop') as HTMLButtonElement).disabled = !this.selected;
    (this.must('btn-drop') as HTMLButtonElement).disabled = !this.selected;
    if (!this.stashes.length) {
      this.listEl.innerHTML = '<div class="empty">没有 stash</div>';
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
        void this.showDiff();
      });
    });
  }

  private async showDiff(): Promise<void> {
    if (!this.selected) {
      this.diffEl.innerHTML = '<div class="diff-empty">选择 stash 查看差异</div>';
      return;
    }
    try {
      const patch = await this.client.send('diff:patch', {
        repoRoot: this.repoRoot,
        path: '.',
        staged: false,
        range: `${this.selected.ref}^..${this.selected.ref}`,
      });
      this.diffEl.innerHTML = renderDiff(patch, 'side');
      // 多文件 patch（path='.'）：仅行号高亮，不绑 gap 展开
      bindDiffInteractions(
        this.diffEl,
        this.client,
        { repoRoot: this.repoRoot, path: '', staged: false },
        'side',
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
    }
  }

  private async push(): Promise<void> {
    const message = window.prompt('Stash 消息（可留空）：', '') ?? '';
    try {
      await this.client.send('stash:push', {
        repoRoot: this.repoRoot,
        message: message.trim() || undefined,
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
      await this.reload();
      this.diffEl.innerHTML = '<div class="diff-empty">选择 stash 查看差异</div>';
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
