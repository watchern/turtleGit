/** Unified patch 解析与并排/统一渲染（复刻 TortoiseGitMerge 的基础版） */

import { escapeHtml, highlightLine, languageForPath, HIGHLIGHT_MAX_LINES } from './highlight';
import { t } from '../i18n';

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

/** 文件两侧总行数（用于在最后一个 hunk 之后补「末尾折叠 gap」） */
export interface DiffTail {
  old: number;
  new: number;
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

/**
 * 末尾省略区（最后一个 hunk 之后到 EOF）：git patch 只含 hunk 附近的行，
 * 尾部未展示的行在渲染侧需要一个可展开的 gap 行。最后一个 hunk 含全部
 * 最后的改动，故尾部剩余行数两侧必然相等；纯新增/删除文件（一侧为空）
 * 不生成。不传 tail 时行为与旧版一致（无末尾 gap）。
 */
function trailingGap(prevOldEnd: number, prevNewEnd: number, sawHunk: boolean, tail?: DiffTail): DiffRow | undefined {
  if (!sawHunk || !tail) return undefined;
  const gapOld = tail.old - prevOldEnd;
  const gapNew = tail.new - prevNewEnd;
  if (gapOld >= 1 && gapOld === gapNew) {
    return {
      kind: 'gap',
      oldStart: prevOldEnd + 1,
      oldEnd: tail.old,
      newStart: prevNewEnd + 1,
      newEnd: tail.new,
    };
  }
  return undefined;
}

export function rowsSideBySide(patch: string, tail?: DiffTail): DiffRow[] {
  const { hunks } = parsePatch(patch);
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  let sawHunk = false;
  for (const hunk of hunks) {
    sawHunk = true;
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
  const trail = trailingGap(prevOldEnd, prevNewEnd, sawHunk, tail);
  if (trail) rows.push(trail);
  return rows;
}

export function rowsUnified(patch: string, tail?: DiffTail): DiffRow[] {
  const { hunks } = parsePatch(patch);
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let prevNewEnd = 0;
  let sawHunk = false;
  for (const hunk of hunks) {
    sawHunk = true;
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
  const trail = trailingGap(prevOldEnd, prevNewEnd, sawHunk, tail);
  if (trail) rows.push(trail);
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
  return escapeHtml(s);
}

/** 横向波浪线（复刻 TortoiseGitMerge 的折叠行视觉） */
function waveSvg(): string {
  return `<svg class="d-wave" width="56" height="7" viewBox="0 0 56 7" aria-hidden="true"><path d="M0 3.5 q 3.5 -3.2 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0 t 7 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
}

function gapRowHtml(r: DiffRow, colSpan: number): string {
  const count = (r.oldEnd ?? 0) - (r.oldStart ?? 1) + 1;
  return `<tr class="d-gap" data-old-start="${r.oldStart}" data-old-end="${r.oldEnd}" data-new-start="${r.newStart}" data-new-end="${r.newEnd}"><td colspan="${colSpan}"><span class="d-gap-inner">${waveSvg()}<button class="d-gap-btn" type="button">${t('diff.expandLines', count)}</button>${waveSvg()}</span></td></tr>`;
}

/**
 * 由文件路径推断着色语言，并对超大 patch 直接放弃着色（避免拖慢渲染）。
 * 纯新增/删除等无语言命中的情况返回 undefined → 退化为纯转义，与旧行为一致。
 */
export function diffLanguage(path: string | undefined, patch: string): string | undefined {
  if (!path) return undefined;
  let lines = 0;
  for (let i = 0; i < patch.length; i++) {
    if (patch.charCodeAt(i) === 10) lines++;
  }
  if (lines > HIGHLIGHT_MAX_LINES) return undefined;
  return languageForPath(path);
}

/** 渲染行数组为 HTML 片段（gap 展开后插入用）。lang 为 highlight.js 语言名，缺省不着色 */
export function renderRows(rows: DiffRow[], mode: 'side' | 'unified', lang?: string): string {
  return rows.map((r) => renderRow(r, mode, lang)).join('');
}

function renderRow(r: DiffRow, mode: 'side' | 'unified', lang?: string): string {
  const hl = (s: string | undefined): string => highlightLine(s, lang);
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
<td class="d-left">${hl(r.left)}</td>
<td class="d-no">${r.rightNo ?? ''}</td>
<td class="d-right">${hl(r.right)}</td>
</tr>`;
  }
  const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
  return `<tr class="d-${r.kind}">
<td class="d-no">${sign}</td>
<td class="d-text">${hl(r.text)}</td>
</tr>`;
}

function renderSideBySide(rows: DiffRow[], lang?: string): string {
  return `<table class="diff-table"><colgroup><col class="c-no"><col><col class="c-no"><col></colgroup><tbody>${renderRows(rows, 'side', lang)}</tbody></table>`;
}

function renderUnified(rows: DiffRow[], lang?: string): string {
  return `<table class="diff-table unified"><colgroup><col class="c-sign"><col></colgroup><tbody>${renderRows(rows, 'unified', lang)}</tbody></table>`;
}

/**
 * @param path 被比较文件路径（用于推断语言做语法高亮，缺省则纯转义）
 */
export function renderDiff(patch: string, mode: 'side' | 'unified', tail?: DiffTail, path?: string): string {
  if (!patch || !patch.trim()) {
    return `<div class="diff-empty">${t('diff.noChanges')}</div>`;
  }
  const lang = diffLanguage(path, patch);
  return mode === 'side'
    ? renderSideBySide(rowsSideBySide(patch, tail), lang)
    : renderUnified(rowsUnified(patch, tail), lang);
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
