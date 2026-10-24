/**
 * turtleGit RPC 协议（宿主层 ↔ Webview 层共享的唯一契约）
 * 所有类型必须可 JSON 序列化。
 */

// ============ 数据模型 ============

export type StagedStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechanged'
  | 'conflicted'
  | 'none';

export interface FileStatus {
  /** 仓库相对路径，统一使用正斜杠 */
  path: string;
  /** 绝对路径（宿主侧可能为空字符串，Webview 侧不需要） */
  absPath?: string;
  /** 已暂存（index）状态 */
  index: StagedStatus;
  /** 工作区状态 */
  worktree: StagedStatus;
  /** 重命名/复制的原路径 */
  origPath?: string;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

/** 单文件增删行数统计（提交对话框文件列表展示用） */
export interface FileNumstat {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string;
  subject: string;
  body: string;
  refs: string[];
}

export interface CommitFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  oldPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export type RepoState =
  | 'clean'
  | 'merging'
  | 'rebasing'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting'
  | 'applying';

export interface BranchInfo {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  state: RepoState;
}

export interface RepoInfo {
  root: string;
  name: string;
}

export type PanelMode = 'auto' | 'floating' | 'embedded';

/** 变更文件列表的视图模式：tree=按目录分组，list=平铺完整路径 */
export type StatusViewMode = 'tree' | 'list';

export type WebviewView = 'commit' | 'log' | 'diff' | 'graph' | 'stash' | 'blame';

export interface WebviewInit {
  view: WebviewView;
  repoRoot: string;
  /** 初始选中的文件（commit 视图） */
  paths?: string[];
  /** log 视图初始过滤路径 */
  filterPath?: string;
  /** diff 视图参数 */
  diff?: { path: string; staged: boolean; against?: string };
  /** 变更文件列表的视图模式（侧边栏与提交对话框共享同一偏好） */
  statusViewMode?: StatusViewMode;
  panelMode: PanelMode;
  floating: boolean;
  /** true = 侧边栏内嵌提交视图（紧凑竖向布局，点击文件走 VSCode 原生对比） */
  sidebar?: boolean;
}

// ============ RPC 请求 ============

export interface CommitRequest {
  repoRoot: string;
  message: string;
  /** 勾选要提交的文件；缺省表示提交全部已暂存内容 */
  files?: string[];
  amend?: boolean;
  signOff?: boolean;
  noVerify?: boolean;
}

export interface LogQuery {
  repoRoot: string;
  skip?: number;
  limit?: number;
  path?: string;
  author?: string;
  grep?: string;
  all?: boolean;
}

export interface RpcRequests {
  'repo:list': { req: Record<string, never>; res: RepoInfo[] };
  'repo:info': { req: { repoRoot: string }; res: BranchInfo };
  'status:list': { req: { repoRoot: string }; res: FileStatus[] };
  'status:stage': { req: { repoRoot: string; paths: string[] }; res: void };
  'status:unstage': { req: { repoRoot: string; paths: string[] }; res: void };
  'status:discard': { req: { repoRoot: string; paths: string[] }; res: void };
  'status:ignore': {
    req: {
      repoRoot: string;
      paths: string[];
      /** 写入位置：仓库根 .gitignore（默认）或 .git/info/exclude（仅本地） */
      target?: 'gitignore' | 'exclude';
      /** 目录路径的处理方式：整目录写一条 `dir/`（默认）或遍历目录下文件逐条写入 */
      mode?: 'dir' | 'files';
    };
    res: void;
  };
  /** 每个文件的增删行数（HEAD↔工作区合计 + 未跟踪文件新增行） */
  'status:numstat': { req: { repoRoot: string }; res: FileNumstat[] };
  'diff:patch': {
    req: {
      repoRoot: string;
      path: string;
      staged: boolean;
      against?: string;
      /** 显式版本范围，如 "a1b2c3^..a1b2c3"（日志视图用） */
      range?: string;
    };
    res: string;
  };
  /** 读取 diff 中被省略的上下文行内容（gap 折叠行展开用） */
  'diff:context': {
    req: {
      repoRoot: string;
      path: string;
      /** 旧侧行范围（1 基，含端点） */
      oldStart: number;
      oldEnd: number;
      /** 新侧行范围（1 基，含端点） */
      newStart: number;
      newEnd: number;
      staged?: boolean;
      against?: string;
      range?: string;
    };
    res: { oldLines: string[]; newLines: string[] };
  };
  'commit:create': { req: CommitRequest; res: { hash: string } };
  'ui:confirm': { req: { text: string }; res: boolean };
  'log:list': { req: LogQuery; res: CommitInfo[] };
  'log:files': { req: { repoRoot: string; hash: string }; res: CommitFile[] };
  'ui:openNativeDiff': { req: { repoRoot: string; path: string; staged: boolean }; res: void };
  /** 在 VSCode 编辑器中打开文件（非 diff） */
  'ui:openFile': { req: { repoRoot: string; path: string }; res: void };
  'ui:revealInExplorer': { req: { repoRoot: string; path: string }; res: void };

  // ---- 分支操作（BranchOps） ----
  'branch:list': { req: { repoRoot: string }; res: BranchEntry[] };
  'branch:create': {
    req: { repoRoot: string; name: string; ref?: string; checkout?: boolean };
    res: void;
  };
  'branch:delete': { req: { repoRoot: string; name: string; force?: boolean }; res: void };
  'branch:rename': { req: { repoRoot: string; oldName: string; newName: string }; res: void };
  'branch:checkout': { req: { repoRoot: string; ref: string }; res: void };

  'tag:list': { req: { repoRoot: string }; res: TagEntry[] };
  'tag:create': {
    req: { repoRoot: string; name: string; ref?: string; message?: string };
    res: void;
  };
  'tag:delete': { req: { repoRoot: string; name: string }; res: void };

  'merge:run': {
    req: { repoRoot: string; ref: string; noFf?: boolean; ffOnly?: boolean; noCommit?: boolean };
    res: void;
  };
  'merge:abort': { req: { repoRoot: string }; res: void };
  'cherryPick:run': { req: { repoRoot: string; hashes: string[] }; res: void };
  'cherryPick:abort': { req: { repoRoot: string }; res: void };
  'cherryPick:continue': { req: { repoRoot: string }; res: void };
  'rebase:run': { req: { repoRoot: string; ref: string }; res: void };
  'rebase:abort': { req: { repoRoot: string }; res: void };
  'rebase:continue': { req: { repoRoot: string }; res: void };
  'rebase:skip': { req: { repoRoot: string }; res: void };
  'reset:run': {
    req: { repoRoot: string; ref: string; mode: 'soft' | 'mixed' | 'hard' };
    res: void;
  };
  'revert:run': { req: { repoRoot: string; hash: string; noCommit?: boolean }; res: void };

  'stash:list': { req: { repoRoot: string }; res: StashEntry[] };
  'stash:push': {
    req: { repoRoot: string; message?: string; paths?: string[] };
    res: void;
  };
  'stash:apply': { req: { repoRoot: string; index: number }; res: void };
  'stash:pop': { req: { repoRoot: string; index: number }; res: void };
  'stash:drop': { req: { repoRoot: string; index: number }; res: void };

  'reflog:list': { req: { repoRoot: string; limit?: number }; res: ReflogEntry[] };
  'blame:file': { req: { repoRoot: string; path: string }; res: BlameLine[] };
  /** 切换变更文件列表视图模式（树/列表），宿主持久化并广播到所有面板与侧边栏 */
  'ui:setViewMode': { req: { mode: StatusViewMode }; res: StatusViewMode };
}

// ---- 分支操作层类型（与 BranchOps 对齐，Webview 可直接使用） ----

export interface BranchEntry {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  commit: string;
}

export interface TagEntry {
  name: string;
  commit: string;
  date?: string;
  message?: string;
}

export interface StashEntry {
  index: number;
  ref: string;
  message: string;
  branch?: string;
  commit: string;
}

export interface ReflogEntry {
  hash: string;
  shortHash: string;
  selector: string;
  action: string;
  date: string;
}

export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  summary: string;
  content: string;
}

export type RpcRequestType = keyof RpcRequests;

// ============ RPC 事件（宿主 → Webview 推送） ============

export interface RpcEvents {
  'status:changed': { repoRoot: string; files: FileStatus[] };
  'branch:changed': { repoRoot: string; info: BranchInfo };
  'repos:changed': { repos: RepoInfo[] };
  /** 视图模式（树/列表）变化广播：宿主 → 所有已打开面板 */
  'statusViewMode:changed': { mode: StatusViewMode };
  /** 面板浮动窗口状态变化（移入/移出辅助窗口）：宿主 → 对应面板 */
  'window:floating': { floating: boolean };
  /** 强制重新拉取（标题栏刷新按钮 → 侧边栏视图刷新，无需重建 UI） */
  reload: Record<string, never>;
}

export type RpcEventType = keyof RpcEvents;

// ============ 消息信封 ============

export interface RpcRequestEnvelope {
  kind: 'request';
  id: number;
  type: RpcRequestType;
  payload: unknown;
}

export interface RpcResponseEnvelope {
  kind: 'response';
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface RpcEventEnvelope {
  kind: 'event';
  type: RpcEventType;
  payload: unknown;
}

export type RpcMessage =
  | RpcRequestEnvelope
  | RpcResponseEnvelope
  | RpcEventEnvelope;

export function isRpcRequest(m: RpcMessage): m is RpcRequestEnvelope {
  return m.kind === 'request';
}
