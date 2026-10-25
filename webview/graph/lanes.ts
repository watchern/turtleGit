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

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  /** 父提交所在行；continues 为 true 时此值无意义（画到图底部） */
  toRow: number;
  toLane: number;
  /** 父提交不在当前列表内（超出已加载页/未在结果中）→ 线延伸到底部 */
  continues: boolean;
}

/**
 * 生成连线：按父提交的**真实行号**连线，而不是想当然地连到下一行。
 * 拓扑序里父提交常常隔着若干行，连到下一行会让线断在半空、节点没有入边（图看起来错位）。
 */
export function buildEdges(nodes: GraphNode[]): GraphEdge[] {
  const rowOf = new Map<string, number>();
  nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));
  const edges: GraphEdge[] = [];
  nodes.forEach((node, row) => {
    node.commit.parents.forEach((parent, i) => {
      const toLane = node.parentLanes[i] ?? node.lane;
      const toRow = rowOf.get(parent);
      if (toRow === undefined) {
        // 父提交不在列表内（未加载/被过滤）：向下延伸到底部
        edges.push({ fromRow: row, fromLane: node.lane, toRow: nodes.length, toLane, continues: true });
      } else if (toRow > row) {
        edges.push({ fromRow: row, fromLane: node.lane, toRow, toLane, continues: false });
      }
      // toRow < row 在拓扑序下不应出现，忽略
    });
  });
  return edges;
}

/**
 * lane 配色：固定调色板（深浅主题下都可见）。
 * 早先用 `fill: var(--bg)`（编辑器背景色）画节点——暗黑主题下就是近黑色实心点。
 */
const LANE_COLORS = [
  '#e06c75',
  '#61afef',
  '#98c379',
  '#e5c07b',
  '#c678dd',
  '#56b6c2',
  '#d19a66',
  '#be5046',
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/** 徽标宽度估算：中/日/韩等全角字符按 2 个单位宽算，避免文字溢出矩形 */
export function badgeWidth(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return units * 6.2 + 12;
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
