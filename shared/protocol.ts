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

export type WebviewView =
  | 'commit'
  | 'log'
  | 'diff'
  | 'graph'
  | 'stash'
  | 'blame'
  | 'sidebar';

/** 合并后的侧边栏标签页：提交 / 分支 / 暂存 */
export type SidebarTab = 'commit' | 'branches' | 'stash';

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
  /** 合并侧边栏启动时应聚焦的标签页 */
  tab?: SidebarTab;
  /** stash 面板启动时预选的 stash ref（侧边栏「查看」带入，如 stash@{0}） */
  stashRef?: string;
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
  /**
   * 签署人，格式「姓名 <邮箱>」（对应 Signed-off-by 尾注）。
   * 留空时由 git 自己的 user.name/user.email 生成；填写后以 `-c user.name/-c user.email`
   * 覆盖本次提交的身份——仓库未配置 user.email 时也能靠它完成签署。
   */
  signOffName?: string;
  /** 提交成功后立即推送到上游（无上游时自动 -u 建立跟踪） */
  pushAfter?: boolean;
}

/** 提交结果：hash + 可选推送结果（pushAfter 时填充） */
export interface CommitResult {
  hash: string;
  /** 是否已执行推送（仅 pushAfter 为 true 时存在） */
  pushed?: boolean;
  /** 推送摘要或失败原因 */
  pushMessage?: string;
}

/** git 身份（user.name / user.email），用于签署默认值 */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface LogQuery {
  repoRoot: string;
  skip?: number;
  limit?: number;
  path?: string;
  author?: string;
  grep?: string;
  all?: boolean;
  /** 排除合并提交（--no-merges） */
  noMerges?: boolean;
  /** 只看某个分支/引用的历史（位置参数 ref；设置时忽略 all） */
  branch?: string;
  /** 时间范围：'24h' | '7d' | ISO 日期（--since） */
  since?: string;
}

export interface RpcRequests {
  'repo:list': { req: Record<string, never>; res: RepoInfo[] };
  'repo:info': { req: { repoRoot: string }; res: BranchInfo };
  /** 拉取 / 推送（返回可读摘要）。分支面板的「更新/推送」按钮用 */
  'repo:pull': { req: { repoRoot: string }; res: string };
  'repo:push': { req: { repoRoot: string }; res: string };
  /** 读取 git 身份（user.name/user.email），签署输入的默认值 */
  'repo:identity': { req: { repoRoot: string }; res: GitIdentity };
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
  /** 统计 diff 两侧文件的总行数（渲染「末尾折叠 gap」用：git patch 只含 hunk
   * 附近的行，最后一个 hunk 之后到 EOF 的省略区在渲染侧不可见，需要补一个
   * 可展开的 gap 行）。某侧文件不存在时该侧计 0。 */
  'diff:lineCounts': {
    req: {
      repoRoot: string;
      path: string;
      staged?: boolean;
      against?: string;
      range?: string;
    };
    res: { old: number; new: number };
  };
  'commit:create': { req: CommitRequest; res: CommitResult };
  'ui:confirm': { req: { text: string }; res: boolean };
  'log:list': { req: LogQuery; res: CommitInfo[] };
  'log:files': { req: { repoRoot: string; hash: string }; res: CommitFile[] };
  /** 两个引用之间（range，如 `A..B`）的变更文件列表（分支对比用） */
  'diff:files': { req: { repoRoot: string; range: string }; res: CommitFile[] };
  'ui:openNativeDiff': { req: { repoRoot: string; path: string; staged: boolean | string }; res: void };
  /** 在 VSCode 编辑器中打开文件（非 diff） */
  'ui:openFile': { req: { repoRoot: string; path: string }; res: void };
  'ui:revealInExplorer': { req: { repoRoot: string; path: string }; res: void };
  /** 侧边栏「查看 stash」：在主窗口打开 Stash 管理面板并预选该 stash（多文件可分别查看改动） */
  'ui:openStash': { req: { repoRoot: string; ref?: string }; res: void };

  // ---- 分支操作（BranchOps） ----
  'branch:list': { req: { repoRoot: string }; res: BranchEntry[] };
  'branch:create': {
    req: { repoRoot: string; name: string; ref?: string; checkout?: boolean };
    res: void;
  };
  'branch:delete': { req: { repoRoot: string; name: string; force?: boolean }; res: void };
  'branch:rename': { req: { repoRoot: string; oldName: string; newName: string }; res: void };
  'branch:checkout': { req: { repoRoot: string; ref: string }; res: void };
  /** 检出远程分支为本地分支并跟踪（IDEA：Checkout as new local branch） */
  'branch:checkoutRemote': {
    req: { repoRoot: string; name: string };
    res: { branch: string; created: boolean };
  };
  /** 删除远程分支：git push <remote> --delete <branch> */
  'branch:deleteRemote': {
    req: { repoRoot: string; remote: string; branch: string };
    res: void;
  };
  // ---- 远程仓库管理 ----
  'remote:list': { req: { repoRoot: string }; res: RemoteEntry[] };
  'remote:add': { req: { repoRoot: string; name: string; url: string }; res: void };
  'remote:remove': { req: { repoRoot: string; name: string }; res: void };
  /** 同步远程引用（git fetch <remote>）：更新远程跟踪分支，不动工作区 */
  'remote:fetch': { req: { repoRoot: string; remote: string }; res: string };
  'remote:setUrl': {
    req: { repoRoot: string; name: string; url: string; push?: boolean };
    res: void;
  };

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
  /** 可直接作为 git ref 使用的名字：本地 `feature`、远程 `origin/feature` */
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  commit: string;
  /** 远程分支所属 remote 名（本地分支无） */
  remote?: string;
  /** 去掉 `remotes/<remote>/` 与 `<remote>/` 前缀后的短名（面板展示用） */
  shortName?: string;
}

/** 远程仓库（对应 IDEA 的 Manage Remotes） */
export interface RemoteEntry {
  name: string;
  fetchUrl: string;
  /** push 地址与 fetch 不同时给出 */
  pushUrl?: string;
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
  /** 合并侧边栏切换标签页（命令聚焦时通知 webview 切到指定 tab） */
  'sidebar:tab': { tab: SidebarTab };
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
