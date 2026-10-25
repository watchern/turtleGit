import { RpcClient } from '../bridge';
import { toast, promptValue, escapeHtml } from '../ui/dialogs';
import { StashEntry } from '../../shared/protocol';

/**
 * 侧边栏「暂存（Stash）」标签页：紧凑竖向列表（保存 / 应用 / 恢复 / 删除）。
 * 查看差异不在侧边栏内嵌展开——一个 stash 常含多个文件、每个文件要分别
 * 查看改动记录，故点击行统一走「在主窗口打开 Stash 管理面板」并预选该 stash。
 */
export class StashSidebarPanel {
  private stashes: StashEntry[] = [];

  private el: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
  ) {
    this.el = root;
    this.build();
    void this.reload();
    this.bindEvents();
  }

  private build(): void {
    this.el.innerHTML = `
<div class="stash-sidebar">
  <div class="ss-head">
    <button class="primary" id="ss-push">保存 Stash…</button>
    <button id="ss-refresh">刷新</button>
    <span class="flex"></span>
    <span class="ss-count" id="ss-count"></span>
  </div>
  <div class="ss-list" id="ss-list"></div>
  <div class="ss-hint">点击行在主窗口查看各文件改动</div>
</div>`;
    this.listEl = this.must('ss-list');

    this.must('ss-refresh').addEventListener('click', () => void this.reload());
    this.must('ss-push').addEventListener('click', () => void this.push());
  }

  private bindEvents(): void {
    this.client.on('reload', () => void this.reload());
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
    this.must('ss-count').textContent = `（${this.stashes.length}）`;
    if (!this.stashes.length) {
      this.listEl.innerHTML = '<div class="empty">没有 stash</div>';
      return;
    }
    this.listEl.innerHTML = this.stashes
      .map(
        (s) => `<div class="ss-row" data-ref="${this.escAttr(s.ref)}" title="点击在主窗口查看各文件改动">
  <div class="ss-line1"><span class="ss-hash">${this.esc(s.ref)}</span><span class="ss-msg">${this.esc(s.message)}</span></div>
  <div class="ss-line2">${s.branch ? `<span class="ss-branch">on ${this.esc(s.branch)}</span>` : ''}<span class="ss-date">${this.esc(s.commit.slice(0, 7))}</span></div>
  <div class="ss-acts">
    <button class="mini" data-act="apply">应用</button>
    <button class="mini" data-act="pop">恢复</button>
    <button class="mini danger" data-act="drop">删除</button>
  </div>
</div>`,
      )
      .join('');
    this.listEl.querySelectorAll<HTMLElement>('.ss-row').forEach((row) => {
      const ref = row.dataset.ref!;
      row.addEventListener('click', (e) => {
        // 点击操作按钮不触发「在主窗口打开」
        if ((e.target as HTMLElement).closest('[data-act]')) return;
        void this.client.send('ui:openStash', { repoRoot: this.repoRoot, ref });
      });
      row.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.run(btn.dataset.act as 'apply' | 'pop' | 'drop', ref);
        });
      });
    });
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

  private async run(op: 'apply' | 'pop' | 'drop', ref: string): Promise<void> {
    const target = this.stashes.find((s) => s.ref === ref);
    if (!target) return;
    if (op === 'drop' && !(await this.client.send('ui:confirm', { text: `确定删除 ${ref}？` }))) {
      return;
    }
    try {
      await this.client.send(`stash:${op}` as never, {
        repoRoot: this.repoRoot,
        index: target.index,
      } as never);
      toast(`已${op === 'apply' ? '应用' : op === 'pop' ? '恢复' : '删除'} ${ref}`);
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
