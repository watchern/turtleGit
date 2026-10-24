/** Unified patch 解析与并排/统一渲染（复刻 TortoiseGitMerge 的基础版） */

export interface DiffRow {
  kind: 'context' | 'add' | 'del' | 'header' | 'meta' | 'gap';
  leftNo?: number;
  rightNo?: number;
  left?: string;
  right?: string;
  text?: string;
  /** gap 行：被省略的旧侧行范围（1 基，含端点） */
  oldStart?: number;
  oldEnd?: number;
  /** gap 行：被省略的新侧行范围（1 基，含端点） */
  newStart?: number;
  newEnd?: number;
}

interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

function parsePatch(patch: string): { fileName: string; hunks: Hunk[] } {
  const lines = patch.split(/\r?\n/);
  let fileName = '';
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        fileName = p.replace(/^b\//, '');
      }
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      current = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current) {
      if (
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ') ||
        line === ''
      ) {
        current.lines.push(line === '' ? ' ' : line);
      } else if (line.startsWith('\\')) {
        current.lines.push(line);
      }
    }
  }
  return { fileName, hunks };
}

export function rowsSideBySide(patch: string): DiffRow[] {
  const { hunks } = parsePatch(patch);
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  for (const hunk of hunks) {
    // hunk 之间（含首个 hunk 之前）被省略的上下文行 → gap 折叠行（波浪线 + 可展开）
    const gapOldStart = prevOldEnd + 1;
    const gapOldEnd = hunk.oldStart - 1;
    const gapNewStart = prevNewEnd + 1;
    const gapNewEnd = hunk.newStart - 1;
    if (gapOldEnd >= gapOldStart && gapNewEnd >= gapNewStart) {
      rows.push({
        kind: 'gap',
        oldStart: gapOldStart,
        oldEnd: gapOldEnd,
        newStart: gapNewStart,
        newEnd: gapNewEnd,
      });
    }
    rows.push({ kind: 'header', text: hunk.header });
    let leftNo = hunk.oldStart;
    let rightNo = hunk.newStart;
    const pendingDel: string[] = [];

    const flushDel = () => {
      while (pendingDel.length) {
        rows.push({
          kind: 'del',
          leftNo: leftNo++,
          rightNo: undefined,
          left: pendingDel.shift()!.slice(1),
          right: undefined,
        });
      }
    };

    for (const line of hunk.lines) {
      const c = line.charAt(0);
      if (c === '+') {
        if (pendingDel.length) {
          rows.push({
            kind: 'add',
            leftNo: leftNo++,
            rightNo: rightNo++,
            left: pendingDel.shift()!.slice(1),
            right: line.slice(1),
          });
        } else {
          rows.push({
            kind: 'add',
            leftNo: undefined,
            rightNo: rightNo++,
            left: undefined,
            right: line.slice(1),
          });
        }
      } else if (c === '-') {
        pendingDel.push(line);
      } else if (c === '\\') {
        rows.push({ kind: 'meta', text: line });
      } else {
        flushDel();
        rows.push({
          kind: 'context',
          leftNo: leftNo++,
          rightNo: rightNo++,
          left: line.slice(1),
          right: line.slice(1),
        });
      }
    }
    flushDel();
    prevOldEnd = leftNo - 1;
    prevNewEnd = rightNo - 1;
  }
  return rows;
}

export function rowsUnified(patch: string): DiffRow[] {
  const { hunks } = parsePatch(patch);
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  for (const hunk of hunks) {
    const gapOldStart = prevOldEnd + 1;
    const gapOldEnd = hunk.oldStart - 1;
    const gapNewStart = prevNewEnd + 1;
    const gapNewEnd = hunk.newStart - 1;
    if (gapOldEnd >= gapOldStart && gapNewEnd >= gapNewStart) {
      rows.push({
        kind: 'gap',
        oldStart: gapOldStart,
        oldEnd: gapOldEnd,
        newStart: gapNewStart,
        newEnd: gapNewEnd,
      });
    }
    rows.push({ kind: 'header', text: hunk.header });
    let leftNo = hunk.oldStart;
    let rightNo = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) {
        rows.push({ kind: 'meta', text: line });
        continue;
      }
      const c = line.charAt(0);
      if (c === '+') {
        rows.push({ kind: 'add', rightNo: rightNo++, text: line.slice(1) });
      } else if (c === '-') {
        rows.push({ kind: 'del', leftNo: leftNo++, text: line.slice(1) });
      } else {
        rows.push({
          kind: 'context',
          leftNo: leftNo++,
          rightNo: rightNo++,
          text: line.slice(1),
        });
      }
    }
    prevOldEnd = leftNo - 1;
    prevNewEnd = rightNo - 1;
  }
  return rows;
}

/** 构造 gap 展开后插入的上下文行（左右行内容一一对应）。 */
export function contextDiffRows(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    rows.push({
      kind: 'context',
      leftNo: oldStart + i,
      rightNo: newStart + i,
      left: oldLines[i],
      right: newLines[i],
      text: oldLines[i],
    });
  }
  return rows;
}

function esc(s: string | undefined): string {
  if (s === undefined) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 横向波浪线（复刻 TortoiseGitMerge 的折叠行视觉） */
function waveSvg(): string {
  return `<svg class="d-wave" width="56" height="7" viewBox="0 0 56 7" aria-hidden="true"><path d="M0 3.5 q 3.5 -3.2 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
}

function gapRowHtml(r: DiffRow, colSpan: number): string {
  const count = (r.oldEnd ?? 0) - (r.oldStart ?? 1) + 1;
  return `<tr class="d-gap" data-old-start="${r.oldStart}" data-old-end="${r.oldEnd}" data-new-start="${r.newStart}" data-new-end="${r.newEnd}"><td colspan="${colSpan}"><span class="d-gap-inner">${waveSvg()}<button class="d-gap-btn" type="button">展开 ${count} 行</button>${waveSvg()}</span></td></tr>`;
}

/** 渲染行数组为 HTML 片段（gap 展开后插入用） */
export function renderRows(rows: DiffRow[], mode: 'side' | 'unified'): string {
  return rows.map((r) => renderRow(r, mode)).join('');
}

function renderRow(r: DiffRow, mode: 'side' | 'unified'): string {
  if (r.kind === 'header') {
    return `<tr class="d-hunk"><td colspan="${mode === 'side' ? 4 : 2}">${esc(r.text)}</td></tr>`;
  }
  if (r.kind === 'meta') {
    return `<tr class="d-meta"><td colspan="${mode === 'side' ? 4 : 2}">${esc(r.text)}</td></tr>`;
  }
  if (r.kind === 'gap') {
    return gapRowHtml(r, mode === 'side' ? 4 : 2);
  }
  if (mode === 'side') {
    return `<tr class="d-${r.kind}">
<td class="d-no">${r.leftNo ?? ''}</td>
<td class="d-left">${esc(r.left)}</td>
<td class="d-no">${r.rightNo ?? ''}</td>
<td class="d-right">${esc(r.right)}</td>
</tr>`;
  }
  const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
  return `<tr class="d-${r.kind}">
<td class="d-no">${sign}</td>
<td class="d-text">${esc(r.text)}</td>
</tr>`;
}

function renderSideBySide(rows: DiffRow[]): string {
  return `<table class="diff-table"><colgroup><col class="c-no"><col><col class="c-no"><col></colgroup><tbody>${renderRows(rows, 'side')}</tbody></table>`;
}

function renderUnified(rows: DiffRow[]): string {
  return `<table class="diff-table unified"><colgroup><col class="c-sign"><col></colgroup><tbody>${renderRows(rows, 'unified')}</tbody></table>`;
}

export function renderDiff(patch: string, mode: 'side' | 'unified'): string {
  if (!patch || !patch.trim()) {
    return '<div class="diff-empty">无差异</div>';
  }
  return mode === 'side' ? renderSideBySide(rowsSideBySide(patch)) : renderUnified(rowsUnified(patch));
}

export function patchStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}
