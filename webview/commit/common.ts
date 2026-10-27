import { FileStatus } from '../../shared/protocol';
import { t } from '../i18n';

/** 提交对话框与侧边栏提交视图共享的展示工具 */

/**
 * 状态短标签（"修改" / "新增" …）。
 *
 * 用函数而非模块级常量：模块级 const 会在**首次 import 时**求值，
 * 语言切换后拿到的仍是旧语言——这里必须每次现取。
 */
function statusLabel(kind: string): string {
  switch (kind) {
    case 'modified':
      return t('status.modified');
    case 'added':
      return t('status.added');
    case 'deleted':
      return t('status.deleted');
    case 'renamed':
      return t('status.renamed');
    case 'copied':
      return t('status.copied');
    case 'typechanged':
      return t('status.type');
    case 'conflicted':
      return t('status.conflict');
    default:
      return '';
  }
}

/** 单字母状态标记（与 VSCode 内置 Git 装饰一致）：M/A/D/R/T/C/U/! */
const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechanged: 'T',
  conflicted: 'C',
  none: '',
};

export interface StatusBadge {
  /** 单字母标记 */
  text: string;
  /** 配色 class */
  cls: string;
  /** 悬停提示（完整中文说明，弥补字母的信息量） */
  title: string;
}

/** 文件状态徽标：单字母（VSCode 风格），中文说明放 title */
export function statusBadge(file: FileStatus): StatusBadge {
  if (file.conflicted) return { text: 'C', cls: 'st-conflict', title: t('status.conflict') };
  if (file.untracked) return { text: 'U', cls: 'st-untracked', title: t('status.untracked') };
  if (file.ignored) return { text: '!', cls: 'st-ignored', title: t('status.ignored') };
  const colorOf = (letter: string, base: string): string =>
    letter === 'D' ? 'st-deleted' : base;
  if (file.index !== 'none' && file.worktree !== 'none') {
    const letter = STATUS_LETTER[file.index] ?? 'M';
    return {
      text: letter,
      cls: colorOf(letter, 'st-modified'),
      title: t('status.stagedWorktree', statusLabel(file.index), statusLabel(file.worktree)),
    };
  }
  if (file.index !== 'none') {
    const letter = STATUS_LETTER[file.index] ?? 'M';
    return {
      text: letter,
      cls: colorOf(letter, 'st-staged'),
      title: t('status.stagedOf', statusLabel(file.index)),
    };
  }
  const letter = STATUS_LETTER[file.worktree] ?? 'M';
  return {
    text: letter,
    cls: colorOf(letter, 'st-modified'),
    title: statusLabel(file.worktree) || t('status.modified'),
  };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}
