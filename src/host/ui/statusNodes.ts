import { FileStatus } from '../../../shared/protocol';

/**
 * 变更文件节点模型（原侧边栏"检查修改"树视图使用）。
 * 侧边栏改为只保留提交视图后，树视图已移除；这里只保留节点类型与参数解析，
 * 供命令（暂存/取消暂存/放弃修改/…）解析来自菜单的参数使用。
 */

export type RepoNode = { kind: 'repo'; root: string; name: string };
export type DirNode = { kind: 'dir'; repoRoot: string; dir: string };
export type FileNode = { kind: 'file'; repoRoot: string; file: FileStatus };
export type StatusTreeNode = RepoNode | DirNode | FileNode;

/** 菜单/命令参数可能是树节点或 Uri，统一解析为「仓库根 + 相对路径」列表 */
export function nodeToTargets(
  node: unknown,
  filesOf: (repoRoot: string) => FileStatus[],
): Array<{ repoRoot: string; path: string }> {
  const n = node as Partial<StatusTreeNode> | undefined;
  if (!n || typeof n !== 'object') return [];
  if (n.kind === 'file') {
    const f = n as FileNode;
    return [{ repoRoot: f.repoRoot, path: f.file.path }];
  }
  if (n.kind === 'dir') {
    const d = n as DirNode;
    const prefix = d.dir + '/';
    return filesOf(d.repoRoot)
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => ({ repoRoot: d.repoRoot, path: f.path }));
  }
  if (n.kind === 'repo') {
    const r = n as RepoNode;
    return filesOf(r.root).map((f) => ({ repoRoot: r.root, path: f.path }));
  }
  return [];
}
