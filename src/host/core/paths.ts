import * as path from 'path';

/**
 * 跨平台路径工具。
 * 内部规范：
 * - 仓库 Map 的 key、VSCode Uri.fsPath 使用"平台原生分隔符"（win32 反斜杠，posix 正斜杠）
 * - git 输出的仓库相对路径统一为正斜杠（与 git 一致）
 */

/** 归一化为平台原生分隔符形式，用于 Map key / 前缀比较 */
export function normalizeFsPath(p: string): string {
  if (!p) return p;
  return process.platform === 'win32' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/');
}

/** 仓库相对路径（正斜杠）→ 绝对 fs 路径 */
export function absPathIn(repoRoot: string, relPath: string): string {
  if (!relPath) return normalizeFsPath(repoRoot);
  return path.join(repoRoot, ...relPath.split('/'));
}

/** 绝对 fs 路径 → 仓库相对路径（正斜杠）；仓库根本身返回 ''，不在仓库内返回 undefined */
export function relPathIn(repoRoot: string, fsPath: string): string | undefined {
  const root = normalizeFsPath(repoRoot).replace(/[\\/]+$/, '');
  const full = normalizeFsPath(fsPath);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (full === root) return '';
  if (!full.startsWith(root + sep)) return undefined;
  return full.slice(root.length + 1).replace(/\\/g, '/');
}
