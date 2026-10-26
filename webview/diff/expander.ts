import { RpcClient } from '../bridge';
import { contextDiffRows, renderRows, DiffTail } from './DiffRenderer';
import { languageForPath } from './highlight';

export interface DiffContext {
  repoRoot: string;
  path: string;
  staged: boolean;
  against?: string;
  range?: string;
}

/** diff 加载参数（diff:patch 与 diff:lineCounts 共用同一组筛选条件） */
export interface DiffLoadOpts {
  repoRoot: string;
  path: string;
  staged?: boolean;
  against?: string;
  range?: string;
}

/**
 * 拉取 patch 与两侧总行数（后者用于渲染「末尾折叠 gap」）。
 * 行数统计失败（如新增/删除文件一侧不存在）时静默降级为无末尾 gap，
 * 不影响 diff 主体展示。
 */
export async function loadPatchAndCounts(
  client: RpcClient,
  opts: DiffLoadOpts,
): Promise<{ patch: string; tail?: DiffTail }> {
  const [patch, counts] = await Promise.all([
    client.send('diff:patch', { ...opts, staged: opts.staged ?? false }),
    client.send('diff:lineCounts', opts).catch(() => undefined),
  ]);
  return { patch, tail: counts };
}

/** 点击行号高亮整行（并排模式左右同 tr，天然联动；再次点击取消）。 */
function bindRowHighlight(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.diff-table td.d-no').forEach((td) => {
    td.addEventListener('click', () => {
      td.closest('tr')?.classList.toggle('hl');
    });
  });
}

/**
 * 绑定 diff 视图交互：
 * - gap 折叠行（波浪线）点击展开为上下文行，再次点击收起
 * - 点击行号高亮整行（左右联动）
 */
export function bindDiffInteractions(
  root: HTMLElement,
  client: RpcClient,
  ctx: DiffContext,
  mode: 'side' | 'unified',
): void {
  bindRowHighlight(root);
  // gap 展开需要明确的单文件路径（多文件 patch 如 '.' 无法定位单侧内容，只做行号高亮）
  if (!ctx.path || ctx.path === '.') return;
  root.querySelectorAll<HTMLElement>('tr.d-gap').forEach((tr) => {
    tr.addEventListener('click', async () => {
      const btn = tr.querySelector<HTMLButtonElement>('.d-gap-btn');
      const oldStart = Number(tr.dataset.oldStart);
      const oldEnd = Number(tr.dataset.oldEnd);
      const newStart = Number(tr.dataset.newStart);
      const newEnd = Number(tr.dataset.newEnd);
      const count = oldEnd - oldStart + 1;

      // 已展开 → 收起：移除后续插入的上下文行（直到下一个 gap/hunk）
      if (tr.classList.contains('expanded')) {
        let next = tr.nextElementSibling;
        while (next && !next.classList.contains('d-gap') && !next.classList.contains('d-hunk')) {
          const remove = next;
          next = next.nextElementSibling;
          remove.remove();
        }
        tr.classList.remove('expanded');
        if (btn) {
          btn.disabled = false;
          btn.textContent = `展开 ${count} 行`;
        }
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.textContent = '加载中…';
      }
      try {
        const { oldLines, newLines } = await client.send('diff:context', {
          repoRoot: ctx.repoRoot,
          path: ctx.path,
          oldStart,
          oldEnd,
          newStart,
          newEnd,
          staged: ctx.staged,
          against: ctx.against,
          range: ctx.range,
        });
        const html = renderRows(
          contextDiffRows(oldLines, newLines, oldStart, newStart),
          mode,
          languageForPath(ctx.path),
        );
        tr.insertAdjacentHTML('afterend', html);
        tr.classList.add('expanded');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '收起';
        }
        // 新插入的行同样支持行号高亮
        bindRowHighlight(tr.parentElement ?? root);
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = `展开失败：${String(err)}`;
        }
      }
    });
  });
}
