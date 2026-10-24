import { FileStatus } from '../../shared/protocol';

export interface FileTreeNode {
  kind: 'dir' | 'file';
  /** 目录：完整相对目录路径（不含首尾 /）；文件：完整相对文件路径 */
  path: string;
  /** 显示名：目录名 / 文件名 */
  label: string;
  /** 目录的直接子节点（目录在前、各自按名称排序） */
  children?: FileTreeNode[];
  /** 文件节点对应的 FileStatus */
  file?: FileStatus;
}

/**
 * 把平铺的变更文件列表构建为目录树（复刻 TortoiseGit 检查修改的树形视图）。
 * 例：['src/a.ts', 'src/deep/b.ts', 'README.md']
 *  → src/(a.ts, deep/(b.ts)), README.md
 * 路径以 / 结尾的条目（超上限保持折叠的忽略目录，如 `! node_modules/`）渲染为
 * 无子节点的目录节点，避免按文件解析出空名行。
 */
export function buildFileTree(files: FileStatus[]): FileTreeNode[] {
  const root: FileTreeNode = { kind: 'dir', path: '', label: '', children: [] };
  for (const f of files) {
    const isDirEntry = f.path.endsWith('/');
    const parts = (isDirEntry ? f.path.slice(0, -1) : f.path).split('/');
    let cur = root;
    let curPath = '';
    const dirCount = isDirEntry ? parts.length : parts.length - 1;
    for (let i = 0; i < dirCount; i++) {
      curPath = curPath ? `${curPath}/${parts[i]}` : parts[i];
      let child = cur.children!.find((c) => c.kind === 'dir' && c.path === curPath);
      if (!child) {
        child = { kind: 'dir', path: curPath, label: parts[i], children: [] };
        cur.children!.push(child);
      }
      cur = child;
    }
    if (!isDirEntry) {
      cur.children!.push({
        kind: 'file',
        path: f.path,
        label: parts[parts.length - 1],
        file: f,
      });
    }
  }
  const sortRec = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'dir' ? -1 : 1,
    );
    for (const n of nodes) {
      if (n.children) sortRec(n.children);
    }
  };
  sortRec(root.children!);
  return root.children!;
}

/** 递归收集目录下所有文件（含子目录）。 */
export function collectFiles(node: FileTreeNode): FileStatus[] {
  if (node.kind === 'file') return node.file ? [node.file] : [];
  const out: FileStatus[] = [];
  for (const c of node.children ?? []) out.push(...collectFiles(c));
  return out;
}

/** 递归收集所有目录节点路径（一键收起/展开用）。 */
export function collectDirs(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'dir') {
      out.push(n.path);
      out.push(...collectDirs(n.children ?? []));
    }
  }
  return out;
}
