import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from './DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from './expander';

/**
 * 独立差异面板：单文件对比（工作区 ↔ HEAD / 已暂存 ↔ HEAD）。
 */
export class DiffPanel {
  private diffMode: 'side' | 'unified' = 'side';
  private staged: boolean;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    private filePath: string,
    staged: boolean,
  ) {
    this.staged = staged;
    root.innerHTML = `
<div class="toolbar">
  <span class="diff-title" id="diff-title">${this.esc(filePath)}</span>
  <span class="diff-stat" id="diff-stat"></span>
  <span class="flex"></span>
  <label class="chk"><input type="checkbox" id="chk-staged" ${staged ? 'checked' : ''}> 已暂存</label>
  <button class="mini" id="btn-diff-mode">并排</button>
  <button class="mini" id="btn-open-editor">在编辑器中打开</button>
</div>
<div class="diff-view full" id="diff-view"><div class="diff-empty">加载中…</div></div>
`;
    const chk = root.querySelector('#chk-staged') as HTMLInputElement;
    chk.addEventListener('change', () => {
      this.staged = chk.checked;
      void this.load();
    });
    root.querySelector('#btn-diff-mode')!.addEventListener('click', () => {
      this.diffMode = this.diffMode === 'side' ? 'unified' : 'side';
      (root.querySelector('#btn-diff-mode') as HTMLElement).textContent =
        this.diffMode === 'side' ? '并排' : '统一';
      void this.load();
    });
    root.querySelector('#btn-open-editor')!.addEventListener('click', () => {
      this.client.command('openNativeDiff', { path: this.filePath, staged: String(this.staged) });
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: this.filePath,
        staged: this.staged,
      });
      const view = document.getElementById('diff-view')!;
      view.innerHTML = renderDiff(patch, this.diffMode, tail, this.filePath);
      bindDiffInteractions(
        view,
        this.client,
        { repoRoot: this.repoRoot, path: this.filePath, staged: this.staged },
        this.diffMode,
      );
      const stat = patchStat(patch);
      const el = document.getElementById('diff-stat');
      if (el) {
        el.textContent =
          stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
      }
      const title = document.getElementById('diff-title');
      if (title) {
        title.textContent = `${this.filePath}（${this.staged ? '已暂存' : '工作区'} ↔ HEAD）`;
      }
    } catch (err) {
      const view = document.getElementById('diff-view')!;
      view.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
    }
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
