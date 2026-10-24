import { RpcClient } from '../bridge';
import { BlameLine } from '../../shared/protocol';

/**
 * Blame 视图：复刻 TortoiseGitBlame——左列（提交/作者/日期），右列文件内容。
 */
export class BlamePanel {
  private lines: BlameLine[] = [];

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    private filePath: string,
  ) {
    root.innerHTML = `
<div class="toolbar">
  <span class="diff-title">${this.esc(filePath)}</span>
  <span class="flex"></span>
  <button class="mini" id="btn-refresh">刷新</button>
</div>
<div class="blame-view" id="blame-view"><div class="diff-empty">加载中…</div></div>
`;
    root.querySelector('#btn-refresh')!.addEventListener('click', () => void this.load());
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.lines = await this.client.send('blame:file', {
        repoRoot: this.repoRoot,
        path: this.filePath,
      });
      this.render();
    } catch (err) {
      const view = document.getElementById('blame-view')!;
      view.innerHTML = `<div class="diff-empty">无法读取 blame：${this.esc(String(err))}</div>`;
    }
  }

  private render(): void {
    const view = document.getElementById('blame-view')!;
    if (!this.lines.length) {
      view.innerHTML = '<div class="diff-empty">文件为空或未被跟踪</div>';
      return;
    }
    const rows = this.lines
      .map((l) => `<tr class="blame-row" data-hash="${l.hash}">
  <td class="b-line">${l.line}</td>
  <td class="b-hash" title="${this.esc(l.summary)}">${l.shortHash}</td>
  <td class="b-author">${this.esc(l.author)}</td>
  <td class="b-date">${this.esc(l.date)}</td>
  <td class="b-text">${this.esc(l.content)}</td>
</tr>`)
      .join('');
    view.innerHTML = `<table class="blame-table"><tbody>${rows}</tbody></table>`;
    view.querySelectorAll<HTMLElement>('.blame-row').forEach((row) => {
      row.addEventListener('click', () => {
        view.querySelectorAll('.blame-row').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
      });
    });
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
