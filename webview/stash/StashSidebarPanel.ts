import { RpcClient } from '../bridge';
import { t } from '../i18n';
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
    <button class="primary" id="ss-push">${t('stash.save')}</button>
    <button id="ss-refresh">${t('common.refresh')}</button>
    <span class="flex"></span>
    <span class="ss-count" id="ss-count"></span>
  </div>
  <div class="ss-list" id="ss-list"></div>
  <div class="ss-hint">${t('stash.hint')}</div>
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
      this.listEl.innerHTML = `<div class="empty">${t('common.readFailed', String(err))}</div>`;
      return;
    }
    this.renderList();
  }

  private renderList(): void {
    this.must('ss-count').textContent = `（${this.stashes.length}）`;
    if (!this.stashes.length) {
      this.listEl.innerHTML = `<div class="empty">${t('stash.noStash')}</div>`;
      return;
    }
    this.listEl.innerHTML = this.stashes
      .map(
        (s) => `<div class="ss-row" data-ref="${this.escAttr(s.ref)}" title="${t('stash.hint')}">
  <div class="ss-line1"><span class="ss-hash">${this.esc(s.ref)}</span><span class="ss-commit">${this.esc(s.commit.slice(0, 7))}</span><span class="ss-msg">${this.esc(s.message)}</span></div>
  <div class="ss-acts">
    <button class="mini" data-act="apply">${t('stash.act.apply')}</button>
    <button class="mini" data-act="pop">${t('stash.act.pop')}</button>
    <button class="mini danger" data-act="drop">${t('stash.act.drop')}</button>
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

  private async run(op: 'apply' | 'pop' | 'drop', ref: string): Promise<void> {
    const target = this.stashes.find((s) => s.ref === ref);
    if (!target) return;
    if (op === 'drop' && !(await this.client.send('ui:confirm', { text: t('stash.confirmDelete', ref) }))) {
      return;
    }
    try {
      await this.client.send(`stash:${op}` as never, {
        repoRoot: this.repoRoot,
        index: target.index,
      } as never);
      toast(t(op === 'apply' ? 'stash.applied' : op === 'pop' ? 'stash.popped' : 'stash.dropped', ref));
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
