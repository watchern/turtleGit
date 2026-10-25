import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitRunner } from '../git/GitRunner';
import { GitService } from '../git/GitService';
import { BranchOps } from '../git/BranchOps';
import { RepositoryStore } from '../core/RepositoryStore';
import { RpcRouter } from '../rpc/Router';
import { absPathIn, relPathIn, normalizeFsPath } from '../core/paths';
import { TgBlobProvider } from './GitBlobProvider';
import { TGIT_BLOB_SCHEME, blobUriQuery } from '../core/blobUri';
import {
  RpcRequestEnvelope,
  WebviewInit,
  WebviewView,
  PanelMode,
  StatusViewMode,
  SidebarTab,
} from '../../../shared/protocol';

const VIEW_TITLES: Record<WebviewView, string> = {
  commit: '提交 (Commit) - TurtleGit',
  sidebar: 'TurtleGit',
  log: '显示日志 (Show Log) - TurtleGit',
  diff: '比较差异 (Diff) - TurtleGit',
  graph: '版本分支图 (Revision Graph) - TurtleGit',
  stash: '存储 (Stash) - TurtleGit',
  blame: '追溯 (Blame) - TurtleGit',
};

/**
 * Webview 面板生命周期管理中心。
 * - 每种视图单例（复刻 TortoiseGit 单对话框习惯）
 * - 弹窗策略：auto / floating / embedded，运行期自动降级（不调用任何外部 GUI 进程）
 * - RPC 请求分发 + 仓库状态事件推送
 */
export class PanelManager {
  private panels = new Map<WebviewView, vscode.WebviewPanel>();
  private router = new RpcRouter();
  private disposables: vscode.Disposable[] = [];
  private panelMode: WebviewInit['panelMode'];
  /** 每个面板的仓库根，用于事件定向推送 */
  private panelRepo = new Map<WebviewView, string>();

  constructor(
    private context: vscode.ExtensionContext,
    private git: GitService,
    private runner: GitRunner,
    private store: RepositoryStore,
  ) {
    this.ops = new BranchOps(runner);
    this.panelMode =
      (vscode.workspace.getConfiguration('turtlegit').get<WebviewInit['panelMode']>('panelMode')) ??
      'auto';
    // 原生 diff 左侧内容走自注册 scheme：内置 git 扩展的 git: scheme 在
    // Trae CN（git.enabled=false）等环境无人注册提供器，diff 必然打不开
    this.blobProvider = new TgBlobProvider(git);
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(TGIT_BLOB_SCHEME, this.blobProvider, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
    );
    this.registerHandlers();
    this.forwardStoreEvents();
  }

  private ops: BranchOps;
  /** 原生 diff 左侧内容提供器（自注册 turtlegit: scheme，不依赖内置 git 扩展） */
  private blobProvider: TgBlobProvider;
  /** 当前处于浮动（辅助）窗口的视图：applyFloating 成功时登记，收回/关闭时移除 */
  private floatingViews = new Set<WebviewView>();
  /**
   * 侧边栏内嵌 webview（如提交视图）：与面板共用同一套 RPC 与事件推送。
   * 侧边栏永远位于主窗口，因而不需要浮动窗口收回逻辑。
   */
  private sidebarSinks = new Map<
    string,
    { view: WebviewView; webview: vscode.Webview; repoRoot: string }
  >();

  // ---------- 对外入口 ----------

  /** 打开提交对话框。fsPath 为资源管理器/编辑器右键的目标（可为空）。 */
  async openCommit(
    fsPath?: string,
    uris?: readonly vscode.Uri[],
    opts?: { mode?: PanelMode },
  ): Promise<void> {
    const targets = (uris && uris.length ? uris : fsPath ? [vscode.Uri.file(fsPath)] : []).map(
      (u) => u.fsPath,
    );
    const repoRoot = await this.resolveRepoRoot(targets[0]);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    const selected = targets
      .map((p) => relPathIn(repoRoot, p))
      .filter((p): p is string => !!p);

    this.openPanel('commit', repoRoot, { paths: selected.length ? selected : undefined }, opts?.mode);
  }

  /** 打开日志对话框。 */
  async openLog(fsPath?: string, uris?: readonly vscode.Uri[]): Promise<void> {
    const targets = (uris && uris.length ? uris : fsPath ? [vscode.Uri.file(fsPath)] : []).map(
      (u) => u.fsPath,
    );
    const repoRoot = await this.resolveRepoRoot(targets[0]);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    const filterPath = targets[0] ? relPathIn(repoRoot, targets[0]) : undefined;
    const scoped =
      filterPath && !(await this.isDirectory(repoRoot, filterPath)) ? filterPath : undefined;

    // 一律在主窗口打开（浮动窗口无法承载原生编辑器，用户已要求回到主窗口）
    this.openPanel('log', repoRoot, { filterPath: scoped }, 'embedded');
  }

  /** 打开差异对比面板。 */
  async openDiff(fsPath: string, staged = false): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(fsPath);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    const rel = relPathIn(repoRoot, fsPath);
    this.openPanel(
      'diff',
      repoRoot,
      {
        paths: rel ? [rel] : undefined,
        diff: { path: rel ?? '', staged },
      },
      'embedded',
    );
  }

  /** 打开版本分支图。 */
  async openGraph(fsPath?: string): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(fsPath);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    this.openPanel('graph', repoRoot, {}, 'embedded');
  }

  /** 打开 Stash 管理。 */
  async openStash(fsPath?: string): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(fsPath);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    this.openPanel('stash', repoRoot, {}, 'embedded');
  }

  /**
   * 侧边栏「查看 stash」入口：在主窗口打开 Stash 管理面板并预选指定 stash。
   * repoRoot 由侧边栏直接给出（已解析），无需再猜。
   */
  openStashForRepo(repoRoot: string, stashRef?: string): void {
    this.openPanel('stash', repoRoot, stashRef ? { stashRef } : {}, 'embedded');
  }

  /** 打开 Blame 视图。 */
  async openBlame(fsPath: string): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(fsPath);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    const rel = relPathIn(repoRoot, fsPath);
    if (!rel) {
      vscode.window.showWarningMessage('TurtleGit: 无法解析文件路径。');
      return;
    }
    this.openPanel('blame', repoRoot, { paths: [rel] }, 'embedded');
  }

  /** 让指定侧边栏 webview 重新拉取数据（不触发仓库刷新，仅通知 UI 重载） */
  refreshSidebar(id: string): void {
    const sink = this.sidebarSinks.get(id);
    if (sink) void sink.webview.postMessage({ kind: 'event', type: 'reload', payload: {} });
  }

  /** 命令面板 / 侧边栏标题栏"刷新"：刷新仓库并通知侧边栏重新拉取 */
  refreshAll(): void {
    void this.store.refreshAll().then(() => {
      // 文件状态未变化时不触发 status:changed，故显式通知侧边栏重新拉取
      for (const sink of this.sidebarSinks.values()) {
        void sink.webview.postMessage({ kind: 'event', type: 'reload', payload: {} });
      }
    });
  }

  // ---------- 侧边栏内嵌 webview ----------

  /**
   * 挂载侧边栏（WebviewView）webview：复用本类的 RPC 路由与仓库事件推送。
   * 返回 Disposable，视图销毁时调用。
   */
  attachSidebar(
    id: string,
    view: WebviewView,
    webview: vscode.Webview,
    repoRoot: string,
  ): vscode.Disposable {
    this.sidebarSinks.set(id, { view, webview, repoRoot });
    const sub = webview.onDidReceiveMessage((msg) => void this.onSidebarMessage(id, msg));
    return {
      dispose: () => {
        sub.dispose();
        this.sidebarSinks.delete(id);
      },
    };
  }

  /** 切换侧边栏 webview 绑定的仓库（并推送新 init 让 UI 重建） */
  setSidebarRepo(
    id: string,
    view: WebviewView,
    repoRoot: string,
    opts: { paths?: string[]; tab?: WebviewInit['tab'] } = {},
  ): void {
    const sink = this.sidebarSinks.get(id);
    if (!sink) return;
    sink.repoRoot = repoRoot;
    const init = this.buildInit(view, repoRoot, opts, 'embedded', true);
    void sink.webview.postMessage({ kind: 'event', type: 'init', payload: init });
  }

  /** 仅切换合并侧边栏的标签页（不重建视图，保留已填内容） */
  switchSidebarTab(tab: WebviewInit['tab']): void {
    const sink = this.sidebarSinks.get('turtlegit.sidebarView');
    if (!sink) return;
    void sink.webview.postMessage({ kind: 'event', type: 'sidebar:tab', payload: { tab } });
  }

  private async onSidebarMessage(id: string, msg: unknown): Promise<void> {
    const sink = this.sidebarSinks.get(id);
    if (!sink) return;
    const m = msg as { kind?: string; id?: number; type?: string; payload?: unknown };
    if (m?.kind === 'request' && typeof m.id === 'number') {
      const response = await this.router.handle({
        kind: 'request',
        id: m.id,
        type: m.type as never,
        payload: m.payload,
      });
      void sink.webview.postMessage(response);
      return;
    }
    if (m?.kind === 'command') {
      // 侧边栏位于主窗口：不传 view，避免触发浮动窗口收回逻辑
      await this.handleCommand(undefined, m as { type: string; payload?: Record<string, unknown> });
    }
  }

  /** 构造一份 init 供外部（侧边栏视图）使用 */
  buildInitFor(
    view: WebviewView,
    repoRoot: string,
    opts: {
      paths?: string[];
      filterPath?: string;
      diff?: WebviewInit['diff'];
      tab?: WebviewInit['tab'];
    } = {},
    sidebar = false,
  ): WebviewInit {
    return this.buildInit(view, repoRoot, opts, 'embedded', sidebar);
  }

  /** 生成 webview HTML（WebviewPanel 与 WebviewView 共用） */
  html(webview: vscode.Webview, view: WebviewView, init: WebviewInit): string {
    const csp = webview.cspSource;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    const nonce = createNonce();
    const params = Buffer.from(JSON.stringify(init), 'utf8').toString('base64url');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>${VIEW_TITLES[view]}</title>
</head>
<body>
<div id="app" data-view="${view}" data-params="${params}"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // ---------- 原生编辑器入口（侧边栏 / 命令面板共用） ----------

  /** 用 VSCode 原生 diff 打开指定文件（HEAD ↔ 工作区；未跟踪文件直接打开） */
  async diffNative(fsPath: string): Promise<void> {
    const repoRoot = await this.resolveRepoRoot(fsPath);
    if (!repoRoot) {
      vscode.window.showWarningMessage('TurtleGit: 所选目标不在 git 仓库中。');
      return;
    }
    const rel = relPathIn(repoRoot, fsPath);
    if (!rel) {
      vscode.window.showWarningMessage('TurtleGit: 无法解析文件路径。');
      return;
    }
    await this.openNativeDiff(undefined, repoRoot, rel, false);
  }

  /** 在 VSCode 编辑器中打开文件（非 diff） */
  async openFileInEditorByPath(fsPath: string): Promise<void> {
    await this.openNativeEditor(undefined, async () => {
      await vscode.window.showTextDocument(vscode.Uri.file(fsPath), { preview: true });
    });
  }

  /** 在 VSCode 编辑器中打开仓库内文件（相对路径） */
  async openFileInEditor(repoRoot: string, relPath: string): Promise<void> {
    await this.openFileInEditorByPath(absPathIn(repoRoot, relPath));
  }

  // ---------- 变更文件操作（侧边栏右键菜单用） ----------

  async stagePaths(repoRoot: string, paths: string[]): Promise<void> {
    await this.git.stage(repoRoot, paths);
    await this.store.touch(repoRoot);
  }

  async unstagePaths(repoRoot: string, paths: string[]): Promise<void> {
    await this.git.unstage(repoRoot, paths);
    await this.store.touch(repoRoot);
  }

  async discardPaths(repoRoot: string, paths: string[]): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TurtleGit: 正在放弃修改…',
        cancellable: false,
      },
      () => this.git.discard(repoRoot, paths),
    );
    await this.store.touch(repoRoot);
  }

  async ignorePaths(
    repoRoot: string,
    paths: string[],
    opts?: { target?: 'gitignore' | 'exclude'; mode?: 'dir' | 'files' },
  ): Promise<void> {
    await this.git.addToGitIgnore(repoRoot, paths, opts);
    await this.store.touch(repoRoot);
  }

  /** 解析当前仓库根（活动编辑器 → 工作区文件夹 → 已发现仓库），供外部使用 */
  async resolveRepoRootFor(fsPath?: string): Promise<string | undefined> {
    return this.resolveRepoRoot(fsPath);
  }

  /** 拉取（fetch + merge）。返回可读摘要。 */
  async pull(repoRoot: string): Promise<string> {
    const r = await this.withNotify('正在拉取…', () => this.ops.pull(repoRoot));
    await this.store.touch(repoRoot);
    return summarizeGitOutput(r.stdout) || '已是最新';
  }

  /** 推送当前分支到上游（无上游时自动 -u 建立跟踪）。返回可读摘要。 */
  async push(repoRoot: string): Promise<string> {
    const r = await this.withNotify('正在推送…', () => this.ops.push(repoRoot));
    await this.store.touch(repoRoot);
    // push 的进度信息主要在 stderr
    return summarizeGitOutput(`${r.stdout}\n${r.stderr}`) || '推送完成';
  }

  // ---------- 面板管理 ----------

  private async openPanel(
    view: WebviewView,
    repoRoot: string,
    opts: { paths?: string[]; filterPath?: string; diff?: WebviewInit['diff']; stashRef?: string },
    modeOverride?: PanelMode,
  ): Promise<vscode.WebviewPanel> {
    const mode = modeOverride ?? this.panelMode;
    const existing = this.panels.get(view);
    if (existing) {
      // 复刻 TortoiseGit：同一对话框只保留一个，切仓库时推送新 init 让 UI 重建
      this.panelRepo.set(view, repoRoot);
      const init = this.buildInit(view, repoRoot, opts, mode);
      void existing.webview.postMessage({ kind: 'event', type: 'init', payload: init });
      existing.reveal();
      // 显式请求弹窗且面板当前不在浮动窗口 → 重新浮动（如收回后再次打开弹窗）
      if (modeOverride === 'floating' && !this.floatingViews.has(view)) {
        void this.applyFloating(view, existing, 'floating');
      }
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      'turtlegit.' + view,
      VIEW_TITLES[view],
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    this.panels.set(view, panel);
    this.panelRepo.set(view, repoRoot);

    const init = this.buildInit(view, repoRoot, opts, mode);
    panel.webview.html = this.html(panel.webview, view, init);

    panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(panel, view, msg),
      undefined,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        this.panels.delete(view);
        this.panelRepo.delete(view);
        this.floatingViews.delete(view);
      },
      undefined,
      this.disposables,
    );

    // 弹窗策略执行（不影响 embedded 保底）
    void this.applyFloating(view, panel, mode);

    return panel;
  }

  private buildInit(
    view: WebviewView,
    repoRoot: string,
    opts: {
      paths?: string[];
      filterPath?: string;
      diff?: WebviewInit['diff'];
      stashRef?: string;
      tab?: WebviewInit['tab'];
    },
    mode: PanelMode = this.panelMode,
    sidebar = false,
  ): WebviewInit {
    return {
      view,
      repoRoot,
      paths: opts.paths,
      filterPath: opts.filterPath,
      diff: opts.diff,
      stashRef: opts.stashRef,
      statusViewMode: this.context.globalState.get<StatusViewMode>('turtlegit.viewMode') ?? 'list',
      panelMode: mode,
      floating: this.floatingViews.has(view),
      sidebar,
      tab: opts.tab,
    };
  }

  /**
   * 浮动窗口策略：先把面板 reveal 成活动编辑器，再执行"移到新窗口"。
   * 任何失败都静默降级为内嵌标签页。
   */
  private async applyFloating(
    view: WebviewView,
    panel: vscode.WebviewPanel,
    mode: PanelMode = this.panelMode,
  ): Promise<void> {
    if (mode !== 'auto' && mode !== 'floating') {
      return;
    }
    try {
      await panel.reveal();
      // 给工作区一帧时间完成 reveal，降低命令作用于错误编辑器的概率
      await new Promise((r) => setTimeout(r, 60));
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      this.floatingViews.add(view);
      void panel.webview.postMessage({ kind: 'event', type: 'window:floating', payload: { floating: true } });
    } catch {
      /* 降级：保持内嵌 */
    }
  }

  /** 把当前活动面板拉回主窗口（浮动窗口的"收回"操作） */
  async pullActiveToMain(): Promise<void> {
    try {
      // 注意：VSCode 并无 workbench.action.moveEditorToMainWindow 命令；
      // 可用的是 restoreEditorsToMainWindow——把「聚焦窗口」的编辑器组全部
      // 合并回主窗口活动组（executeCommand 不校验其 when 前置条件）。
      if (this.panels.size === 0) {
        // 本扩展宿主未持有任何面板：命令来自其他窗口（典型：浮动窗口的命令
        // 面板由该窗口自己的扩展宿主处理），直接执行即可作用于聚焦的辅助窗口。
        await vscode.commands.executeCommand('workbench.action.restoreEditorsToMainWindow');
        return;
      }
      // 持有面板的宿主：仅当确有浮动面板、且主窗口未聚焦时执行。
      // 主窗口聚焦时执行会把主窗口自己的编辑器组合并为一个，压平用户布局。
      if (!this.floatingViews.size || vscode.window.state.focused) {
        vscode.window.showInformationMessage('TurtleGit: 请在浮动窗口中执行收回操作。');
        return;
      }
      await vscode.commands.executeCommand('workbench.action.restoreEditorsToMainWindow');
      this.floatingViews.clear();
    } catch {
      vscode.window.showInformationMessage('TurtleGit: 当前窗口无法收回主窗口。');
    }
  }

  /**
   * 把浮动（辅助）窗口中的面板收回了主窗口。
   *
   * 背景：VSCode 没有"在指定窗口打开编辑器"的 API，`vscode.diff` 只会落在
   * 当前聚焦窗口；承载 webview 的浮动窗口打开原生编辑器会失败并弹出
   * "由于意外错误，无法打开编辑器"。因此凡需要原生编辑器的操作（双击看
   * 差异 / 在编辑器中打开 / 提交文件差异），必须先把面板并回主窗口。
   *
   * 返回是否发生了收回。
   */
  private async bringPanelToMainWindow(view: WebviewView): Promise<boolean> {
    if (!this.floatingViews.has(view)) return false;
    const panel = this.panels.get(view);
    // 先通知 webview：窗口移动会使其重载，事件须在重载前送达
    if (panel) {
      void panel.webview.postMessage({ kind: 'event', type: 'window:floating', payload: { floating: false } });
    }
    // 安全护栏：restoreEditorsToMainWindow 作用于「聚焦窗口」的编辑器组，
    // 主窗口聚焦时执行会压平主窗口布局（面板可能已被用户手动移回）。
    // 此时跳过收回——vscode.diff 本来就会落在主窗口，行为依然正确。
    if (vscode.window.state.focused) {
      return false;
    }
    try {
      await vscode.commands.executeCommand('workbench.action.restoreEditorsToMainWindow');
    } catch {
      return false;
    }
    this.floatingViews.delete(view);
    // 等待辅助窗口关闭、主窗口成为活动窗口，否则 vscode.diff 仍可能落到错误窗口
    await new Promise((r) => setTimeout(r, 250));
    return true;
  }

  /** 原生编辑器打开的统一入口：浮动窗口先回主窗口 + 统一错误提示 */
  private async openNativeEditor(view: WebviewView | undefined, open: () => Promise<void>): Promise<void> {
    if (view) {
      await this.bringPanelToMainWindow(view);
    }
    try {
      await open();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`TurtleGit: 无法打开编辑器：${detail}`);
    }
  }

  // ---------- RPC ----------

  private registerHandlers(): void {
    this.router.register('repo:list', () => this.store.repoInfos());
    this.router.register('repo:info', ({ repoRoot }) => this.store.branch(repoRoot));
    this.router.register('repo:pull', ({ repoRoot }) => this.pull(repoRoot));
    this.router.register('repo:push', ({ repoRoot }) => this.push(repoRoot));
    this.router.register('repo:identity', ({ repoRoot }) => this.git.identity(repoRoot));

    this.router.register('status:list', async ({ repoRoot }) => {
      await this.store.refresh(repoRoot);
      return this.store.files(repoRoot);
    });
    this.router.register('status:stage', async ({ repoRoot, paths }) => {
      await this.git.stage(repoRoot, paths);
      await this.store.touch(repoRoot);
    });
    this.router.register('status:unstage', async ({ repoRoot, paths }) => {
      await this.git.unstage(repoRoot, paths);
      await this.store.touch(repoRoot);
    });
    this.router.register('status:discard', async ({ repoRoot, paths }) => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'TurtleGit: 正在放弃修改…',
          cancellable: false,
        },
        () => this.git.discard(repoRoot, paths),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('status:ignore', async ({ repoRoot, paths, target, mode }) => {
      await this.git.addToGitIgnore(repoRoot, paths, { target, mode });
      await this.store.touch(repoRoot);
    });
    this.router.register('status:numstat', ({ repoRoot }) => this.git.numstat(repoRoot));

    this.router.register('diff:patch', ({ repoRoot, path: p, staged, against, range }) =>
      this.diffPatchSmart(repoRoot, p, staged, against, range),
    );

    this.router.register('diff:context', async ({ repoRoot, path: p, oldStart, oldEnd, newStart, newEnd, staged, against, range }) => {
      const [oldLines, newLines] = await Promise.all([
        this.git.contextLines(repoRoot, p, 'old', oldStart, oldEnd, { staged, against, range }),
        this.git.contextLines(repoRoot, p, 'new', newStart, newEnd, { staged, against, range }),
      ]);
      return { oldLines, newLines };
    });

    this.router.register('diff:lineCounts', ({ repoRoot, path: p, staged, against, range }) =>
      this.git.fileLineCounts(repoRoot, p, { staged, against, range }),
    );

    // 两个引用之间（range）的变更文件列表（分支对比：「与当前分支对比」）
    this.router.register('diff:files', ({ repoRoot, range }) => this.git.rangeFiles(repoRoot, range));

    this.router.register('ui:confirm', async ({ text }) => {
      const answer = await vscode.window.showWarningMessage(text, { modal: true }, '确定');
      return answer === '确定';
    });

    this.router.register('commit:create', async (req) => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'TurtleGit: 正在提交…',
          cancellable: false,
        },
        () => this.git.commit(req),
      );
      await this.store.touch(req.repoRoot);
      if (!req.pushAfter) return result;
      // 提交后推送：推送失败不回滚已完成的提交，把结果回传给界面提示
      try {
        const pushMessage = await this.push(req.repoRoot);
        return { hash: result.hash, pushed: true, pushMessage };
      } catch (err) {
        return { hash: result.hash, pushed: false, pushMessage: String(err) };
      }
    });

    this.router.register('log:list', (query) => this.git.log(query));
    this.router.register('log:files', ({ repoRoot, hash }) => this.git.commitFiles(repoRoot, hash));

    // ---- 分支操作（BranchOps） ----
    this.router.register('branch:list', ({ repoRoot }) => this.ops.branches(repoRoot));
    this.router.register('branch:create', async ({ repoRoot, name, ref, checkout }) => {
      await this.withNotify(`正在创建分支 ${name}…`, () =>
        this.ops.createBranch(repoRoot, name, ref, checkout),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('branch:delete', async ({ repoRoot, name, force }) => {
      await this.withNotify(`正在删除分支 ${name}…`, () =>
        this.ops.deleteBranch(repoRoot, name, force),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('branch:rename', async ({ repoRoot, oldName, newName }) => {
      await this.withNotify('正在重命名分支…', () =>
        this.ops.renameBranch(repoRoot, oldName, newName),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('branch:checkout', async ({ repoRoot, ref }) => {
      await this.withNotify(`正在切换到 ${ref}…`, () => this.ops.checkout(repoRoot, ref));
      await this.store.touch(repoRoot);
    });
    this.router.register('branch:checkoutRemote', async ({ repoRoot, name }) => {
      const r = await this.withNotify(`正在检出 ${name}…`, () =>
        this.ops.checkoutRemote(repoRoot, name),
      );
      await this.store.touch(repoRoot);
      return r;
    });
    this.router.register('branch:deleteRemote', async ({ repoRoot, remote, branch }) => {
      await this.withNotify(`正在删除远程分支 ${remote}/${branch}…`, () =>
        this.ops.deleteRemoteBranch(repoRoot, remote, branch),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('remote:list', ({ repoRoot }) => this.ops.remotes(repoRoot));
    this.router.register('remote:add', async ({ repoRoot, name, url }) => {
      await this.withNotify(`正在添加远程 ${name}…`, () =>
        this.ops.addRemote(repoRoot, name, url),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('remote:remove', async ({ repoRoot, name }) => {
      await this.withNotify(`正在删除远程 ${name}…`, () => this.ops.removeRemote(repoRoot, name));
      await this.store.touch(repoRoot);
    });
    this.router.register('remote:setUrl', async ({ repoRoot, name, url, push }) => {
      await this.withNotify(`正在修改 ${name} 的${push ? '推送' : '拉取'}地址…`, () =>
        this.ops.setRemoteUrl(repoRoot, name, url, push === true),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('remote:fetch', async ({ repoRoot, remote }) => {
      const r = await this.withNotify(`正在同步 ${remote} 的引用…`, () =>
        this.ops.fetchRemote(repoRoot, remote),
      );
      await this.store.touch(repoRoot);
      // fetch 的输出（含 stderr 进度行）汇总为可读摘要；无输出即已最新
      return summarizeGitOutput(`${r.stdout}\n${r.stderr}`) || `${remote} 已是最新`;
    });

    this.router.register('tag:list', ({ repoRoot }) => this.ops.tags(repoRoot));
    this.router.register('tag:create', async ({ repoRoot, name, ref, message }) => {
      await this.withNotify(`正在创建标签 ${name}…`, () =>
        this.ops.createTag(repoRoot, name, ref, message),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('tag:delete', async ({ repoRoot, name }) => {
      await this.withNotify(`正在删除标签 ${name}…`, () => this.ops.deleteTag(repoRoot, name));
      await this.store.touch(repoRoot);
    });

    this.router.register('merge:run', async ({ repoRoot, ref, noFf, ffOnly, noCommit }) => {
      await this.withNotify(`正在合并 ${ref}…`, () =>
        this.ops.merge(repoRoot, ref, { noFf, ffOnly, noCommit }),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('merge:abort', async ({ repoRoot }) => {
      await this.ops.mergeAbort(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('cherryPick:run', async ({ repoRoot, hashes }) => {
      await this.withNotify('正在拣选提交…', () => this.ops.cherryPick(repoRoot, hashes));
      await this.store.touch(repoRoot);
    });
    this.router.register('cherryPick:abort', async ({ repoRoot }) => {
      await this.ops.cherryPickAbort(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('cherryPick:continue', async ({ repoRoot }) => {
      await this.ops.cherryPickContinue(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('rebase:run', async ({ repoRoot, ref }) => {
      await this.withNotify(`正在变基到 ${ref}…`, () => this.ops.rebase(repoRoot, ref));
      await this.store.touch(repoRoot);
    });
    this.router.register('rebase:abort', async ({ repoRoot }) => {
      await this.ops.rebaseAbort(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('rebase:continue', async ({ repoRoot }) => {
      await this.ops.rebaseContinue(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('rebase:skip', async ({ repoRoot }) => {
      await this.ops.rebaseSkip(repoRoot);
      await this.store.touch(repoRoot);
    });
    this.router.register('reset:run', async ({ repoRoot, ref, mode }) => {
      await this.withNotify(`正在重置到 ${ref.slice(0, 7)}（${mode}）…`, () =>
        this.ops.reset(repoRoot, ref, mode),
      );
      await this.store.touch(repoRoot);
    });
    this.router.register('revert:run', async ({ repoRoot, hash, noCommit }) => {
      await this.withNotify('正在还原提交…', () => this.ops.revert(repoRoot, hash, noCommit));
      await this.store.touch(repoRoot);
    });

    this.router.register('stash:list', ({ repoRoot }) => this.ops.stashList(repoRoot));
    this.router.register('stash:push', async ({ repoRoot, message, paths }) => {
      await this.withNotify('正在保存 stash…', () => this.ops.stashPush(repoRoot, message, paths));
      await this.store.touch(repoRoot);
    });
    this.router.register('stash:apply', async ({ repoRoot, index }) => {
      await this.withNotify('正在应用 stash…', () => this.ops.stashApply(repoRoot, index));
      await this.store.touch(repoRoot);
    });
    this.router.register('stash:pop', async ({ repoRoot, index }) => {
      await this.withNotify('正在恢复 stash…', () => this.ops.stashPop(repoRoot, index));
      await this.store.touch(repoRoot);
    });
    this.router.register('stash:drop', async ({ repoRoot, index }) => {
      await this.withNotify('正在删除 stash…', () => this.ops.stashDrop(repoRoot, index));
      await this.store.touch(repoRoot);
    });

    this.router.register('reflog:list', ({ repoRoot, limit }) => this.ops.reflog(repoRoot, limit));
    this.router.register('blame:file', ({ repoRoot, path }) => this.ops.blame(repoRoot, path));

    // 变更文件视图模式（树/列表）：宿主持久化 → 同步侧边栏 → 广播所有面板
    this.router.register('ui:setViewMode', async ({ mode }) => {
      await this.context.globalState.update('turtlegit.viewMode', mode);
      void vscode.commands.executeCommand('setContext', 'turtlegit.viewMode', mode);
      const event = {
        kind: 'event',
        type: 'statusViewMode:changed',
        payload: { mode },
      };
      for (const panel of this.panels.values()) {
        void panel.webview.postMessage(event);
      }
      for (const sink of this.sidebarSinks.values()) {
        void sink.webview.postMessage(event);
      }
      return mode;
    });

    this.router.register('ui:openNativeDiff', async ({ repoRoot, path: p, staged }) => {
      // 尽力推断发起面板（按仓库根匹配），以便浮动窗口先收回主窗口
      const view = [...this.panelRepo.entries()].find(([, r]) => r === repoRoot)?.[0];
      // webview 传的是字符串 'true'/'false'，直接透传会让 'false' 变成 truthy
      // （结果对比 index 而非 HEAD），这里统一归一化为布尔
      const isStaged = staged === true || staged === 'true';
      await this.openNativeDiff(view, repoRoot, p, isStaged);
    });
    this.router.register('ui:openFile', async ({ repoRoot, path: p }) => {
      await this.openFileInEditor(repoRoot, p);
    });
    this.router.register('ui:revealInExplorer', async ({ repoRoot, path: p }) => {
      const uri = vscode.Uri.file(path.join(repoRoot, p));
      await vscode.commands.executeCommand('revealInExplorer', uri);
    });
    this.router.register('ui:openStash', async ({ repoRoot, ref }) => {
      this.openStashForRepo(repoRoot, ref);
    });
  }

  /** 带通知进度执行写操作 */
  private async withNotify<T>(title: string, fn: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `TurtleGit: ${title}`,
        cancellable: false,
      },
      () => fn(),
    );
  }

  /** 未跟踪文件没有 index 对象，diff --cached 为空，需要特殊处理。 */
  private async diffPatchSmart(
    repoRoot: string,
    filePath: string,
    staged: boolean,
    against?: string,
    range?: string,
  ): Promise<string> {
    if (!range && !against) {
      const file = this.store.fileStatus(repoRoot, filePath);
      if (file?.untracked) {
        return this.diffNoIndex(repoRoot, filePath);
      }
    }
    return this.git.diffPatch(repoRoot, filePath, staged, against, range);
  }

  private async diffNoIndex(repoRoot: string, filePath: string): Promise<string> {
    const abs = path.join(repoRoot, filePath);
    const { GitRunner } = await import('../git/GitRunner');
    const runner = new GitRunner('git');
    const r = await runner.run(
      ['diff', '--no-color', '--no-index', '-U3', '--', process.platform === 'win32' ? '\\\\.\\nul' : '/dev/null', abs],
      { cwd: repoRoot, timeoutMs: 30000 },
    );
    // git diff --no-index 退出码为 1 表示有差异，属正常
    return r.stdout;
  }

  private async onMessage(
    panel: vscode.WebviewPanel,
    view: WebviewView,
    msg: unknown,
  ): Promise<void> {
    const m = msg as { kind?: string; id?: number; type?: string; payload?: unknown };
    if (m?.kind === 'request' && typeof m.id === 'number') {
      const response = await this.router.handle({
        kind: 'request',
        id: m.id,
        type: m.type as never,
        payload: m.payload,
      });
      void panel.webview.postMessage(response);
      return;
    }
    if (m?.kind === 'command') {
      await this.handleCommand(view, m as { type: string; payload?: Record<string, unknown> });
    }
  }

  /** Webview 内的非 RPC 命令（打开原生 diff、关闭面板等）。
   *  view 为 undefined 表示来自侧边栏内嵌 webview（无需浮动窗口收回）。 */
  private async handleCommand(
    view: WebviewView | undefined,
    msg: { type: string; payload?: Record<string, unknown> },
  ): Promise<void> {
    const p = (msg.payload ?? {}) as Record<string, string>;
    const repoOf = (): string | undefined => (view ? this.panelRepo.get(view) : undefined) ?? p['repoRoot'];
    switch (msg.type) {
      case 'openNativeDiff': {
        const repoRoot = repoOf();
        if (repoRoot && p['path']) {
          await this.openNativeDiff(view, repoRoot, p['path'], p['staged'] === 'true');
        }
        break;
      }
      case 'openFile': {
        const repoRoot = repoOf();
        if (repoRoot && p['path']) {
          await this.openFileInEditor(repoRoot, p['path']);
        }
        break;
      }
      case 'openCommitDiff': {
        const repoRoot = repoOf();
        if (repoRoot && p['path'] && p['hash']) {
          await this.openNativeEditor(view, async () => {
            const abs = absPathIn(repoRoot, p['path']);
            const right = this.blobUriFor(abs, p['hash'], repoRoot);
            // 根提交无父版本：直接打开右侧内容（该提交中全部为新增）
            const parent = await this.runner.tryRun(
              ['rev-parse', '--verify', '--quiet', `${p['hash']}^`],
              { cwd: repoRoot, timeoutMs: 8000 },
            );
            if (!parent) {
              await vscode.commands.executeCommand('vscode.open', right, { preview: true });
              return;
            }
            const left = this.blobUriFor(abs, `${p['hash']}^`, repoRoot);
            // stash@{n} 等选择器含 @{}，截 7 位会得到 "stash@{"——原样显示
            const label = /[@{}]/.test(p['hash']) ? p['hash'] : p['hash'].slice(0, 7);
            await vscode.commands.executeCommand(
              'vscode.diff',
              left,
              right,
              `${p['path']} (${label})`,
              { preview: true },
            );
          });
        }
        break;
      }
      case 'openRangeDiff': {
        // 任意两个引用间对比（分支「与当前分支对比」）：left/right 为 ref，缺侧直接打开存在侧
        const repoRoot = repoOf();
        if (repoRoot && p['path'] && p['left'] && p['right']) {
          await this.openNativeEditor(view, async () => {
            const abs = absPathIn(repoRoot, p['path']);
            const rel = relPathIn(repoRoot, abs);
            const exists = async (ref: string): Promise<boolean> =>
              (await this.runner.tryRun(['cat-file', '-e', `${ref}:${rel}`], {
                cwd: repoRoot,
                timeoutMs: 8000,
              })) !== null;
            const [hasLeft, hasRight] = [await exists(p['left']), await exists(p['right'])];
            const right = this.blobUriFor(abs, p['right'], repoRoot);
            const label = p['label'] ?? `${p['left']} ↔ ${p['right']}`;
            if (!hasLeft) {
              // 左侧无此文件（对比范围内为新增）：直接打开右侧内容
              await vscode.commands.executeCommand('vscode.open', right, { preview: true });
              return;
            }
            const left = this.blobUriFor(abs, p['left'], repoRoot);
            if (!hasRight) {
              // 右侧无此文件（对比范围内已删除）：打开左侧内容
              await vscode.commands.executeCommand('vscode.open', left, { preview: true });
              return;
            }
            await vscode.commands.executeCommand(
              'vscode.diff',
              left,
              right,
              `${p['path']} (${label})`,
              { preview: true },
            );
          });
        }
        break;
      }
      case 'closePanel': {
        if (view) this.panels.get(view)?.dispose();
        break;
      }
      case 'pullToMain':
        await this.pullActiveToMain();
        break;
      default:
        break;
    }
  }

  /**
   * 用 VSCode 原生 diff 编辑器打开（复刻 TortoiseGit"双击看差异"）。
   * - 未跟踪文件没有 HEAD/index 版本：直接打开文件本身（内容全部为新增）
   * - 面板处于浮动窗口时先收回主窗口（浮动窗口无法承载原生编辑器）
   */
  private async openNativeDiff(
    view: WebviewView | undefined,
    repoRoot: string,
    relPath: string,
    staged: boolean,
  ): Promise<void> {
    const file = this.store.fileStatus(repoRoot, relPath);
    await this.openNativeEditor(view, async () => {
      const abs = absPathIn(repoRoot, relPath);
      if (file?.untracked) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs), { preview: true });
        return;
      }
      // ref 传 '' 表示 index（暂存）版本——与内置 git 扩展 toGitUri(uri, '') 一致
      const left = this.blobUriFor(abs, staged ? '' : 'HEAD', repoRoot);
      const right = vscode.Uri.file(abs);
      const title = `${relPath} (${staged ? '已暂存' : '工作区'} ↔ HEAD)`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    });
  }

  /**
   * 构造 turtlegit: scheme 的 diff 内容 URI（自注册提供器解析，见 GitBlobProvider）。
   * 与内置 git 扩展 git: URI 同构（path 段 + URL 编码 JSON query），但不依赖
   * `vscode.git` 扩展是否可用。ref 传 '' 表示 index（暂存）版本。
   */
  private blobUriFor(abs: string, ref: string, repoRoot: string): vscode.Uri {
    // Uri.file(...).with(...) 与内置 git 扩展 toGitUri 同构：路径由 Uri.file 规范
    // 化（UNC、#/? 等特殊字符均安全），query 存 JSON 参数
    return vscode.Uri.file(abs).with({
      scheme: TGIT_BLOB_SCHEME,
      query: blobUriQuery(abs, ref, repoRoot),
    });
  }

  // ---------- 仓库事件推送 ----------

  private forwardStoreEvents(): void {
    this.disposables.push(
      this.store.onDidChangeFiles(({ repoRoot, files }) => {
        const event = { kind: 'event', type: 'status:changed', payload: { repoRoot, files } };
        for (const [view, panel] of this.panels) {
          if (this.panelRepo.get(view) === repoRoot) {
            void panel.webview.postMessage(event);
          }
        }
        for (const sink of this.sidebarSinks.values()) {
          if (sink.repoRoot === repoRoot) void sink.webview.postMessage(event);
        }
      }),
      this.store.onDidChangeBranch(({ repoRoot, info }) => {
        const event = { kind: 'event', type: 'branch:changed', payload: { repoRoot, info } };
        for (const [view, panel] of this.panels) {
          if (this.panelRepo.get(view) === repoRoot) {
            void panel.webview.postMessage(event);
          }
        }
        for (const sink of this.sidebarSinks.values()) {
          if (sink.repoRoot === repoRoot) void sink.webview.postMessage(event);
        }
      }),
    );
  }

  // ---------- 工具 ----------

  private async resolveRepoRoot(fsPath?: string): Promise<string | undefined> {
    if (fsPath) {
      const root = await this.git.repoRootOf(fsPath);
      if (root) return root;
    }
    // 回退：当前活动编辑器 → 第一个工作区文件夹
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      const root = await this.git.repoRootOf(active);
      if (root) return root;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const root = await this.git.repoRootOf(folders[0].uri.fsPath);
      if (root) return root;
    }
    return this.store.repoInfos()[0]?.root;
  }

  private async isDirectory(repoRoot: string, relPath: string): Promise<boolean> {
    try {
      return fs.statSync(absPathIn(repoRoot, relPath)).isDirectory();
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.blobProvider.dispose();
    this.panels.forEach((p) => p.dispose());
    this.panels.clear();
    this.floatingViews.clear();
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** 压缩 git 输出为可读摘要：去 warning 行、只保留末尾若干行。 */
function summarizeGitOutput(text: string, maxLines = 6): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^warning:/i.test(l));
  if (!lines.length) return '';
  return (lines.length > maxLines ? ['…', ...lines.slice(-maxLines)] : lines).join('\n');
}
