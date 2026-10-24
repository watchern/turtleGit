import { CommitInfo } from '../../shared/protocol';

/**
 * gitk 风格的 lane 分配算法。
 * 输入为 topo-order 的提交列表（含 parents），输出每个提交的 lane 及其
 * 各 parent 的 lane，供 SVG 渲染连线使用。
 */

export interface GraphNode {
  commit: CommitInfo;
  /** 本提交所在 lane */
  lane: number;
  /** 各 parent 所在 lane（与 commit.parents 一一对应） */
  parentLanes: number[];
}

export function computeLanes(commits: CommitInfo[]): GraphNode[] {
  /** lanes[i] = 该 lane 正在等待的 commit hash，null 表示空闲 */
  const lanes: (string | null)[] = [];
  const nodes: GraphNode[] = [];

  const alloc = (hash: string | undefined): number => {
    if (!hash) {
      const free = lanes.indexOf(null);
      if (free !== -1) return free;
      lanes.push(null);
      return lanes.length - 1;
    }
    const existing = lanes.indexOf(hash);
    if (existing !== -1) return existing;
    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = hash;
      return free;
    }
    lanes.push(hash);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const lane = alloc(commit.hash);
    const parentLanes: number[] = [];
    if (commit.parents.length === 0) {
      // root 提交：处理完即释放 lane
      lanes[lane] = null;
    }
    commit.parents.forEach((parent, i) => {
      if (i === 0) {
        // 第一父提交沿用当前 lane（无父提交时释放该 lane）
        lanes[lane] = parent ?? null;
        parentLanes.push(lane);
      } else {
        parentLanes.push(alloc(parent));
      }
    });
    nodes.push({ commit, lane, parentLanes });
    // 压缩尾部空闲 lane，避免图无限变宽
    while (lanes.length > 0 && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) {
      lanes.pop();
    }
  }
  return nodes;
}

/** 提取 refs 中适合在图旁显示的标签（HEAD、分支、标签） */
export function refBadges(refs: string[]): Array<{ text: string; kind: 'head' | 'branch' | 'tag' | 'remote' }> {
  return refs.map((r) => {
    if (r === 'HEAD' || r.startsWith('HEAD ->')) {
      return { text: r, kind: 'head' as const };
    }
    if (r.startsWith('tag:')) {
      return { text: r.slice(4), kind: 'tag' as const };
    }
    if (r.includes('/')) {
      return { text: r, kind: 'remote' as const };
    }
    return { text: r, kind: 'branch' as const };
  });
}
