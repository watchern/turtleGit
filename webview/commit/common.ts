import { FileStatus } from '../../shared/protocol';

/** 提交对话框与侧边栏提交视图共享的展示工具 */

const STATUS_LABEL: Record<string, string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  typechanged: '类型',
  conflicted: '冲突',
  none: '',
};

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
  if (file.conflicted) return { text: 'C', cls: 'st-conflict', title: '冲突 (Conflict)' };
  if (file.untracked) return { text: 'U', cls: 'st-untracked', title: '未版本控制 (Untracked)' };
  if (file.ignored) return { text: '!', cls: 'st-ignored', title: '已忽略 (Ignored)' };
  const colorOf = (letter: string, base: string): string =>
    letter === 'D' ? 'st-deleted' : base;
  if (file.index !== 'none' && file.worktree !== 'none') {
    const letter = STATUS_LETTER[file.index] ?? 'M';
    return {
      text: letter,
      cls: colorOf(letter, 'st-modified'),
      title: `已暂存${STATUS_LABEL[file.index] ?? ''} + 工作区${STATUS_LABEL[file.worktree] ?? ''}`,
    };
  }
  if (file.index !== 'none') {
    const letter = STATUS_LETTER[file.index] ?? 'M';
    return {
      text: letter,
      cls: colorOf(letter, 'st-staged'),
      title: `已暂存 · ${STATUS_LABEL[file.index] ?? ''}`,
    };
  }
  const letter = STATUS_LETTER[file.worktree] ?? 'M';
  return {
    text: letter,
    cls: colorOf(letter, 'st-modified'),
    title: STATUS_LABEL[file.worktree] ?? '修改',
  };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}
