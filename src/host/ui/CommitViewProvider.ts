import * as vscode from 'vscode';
import { RepositoryStore } from '../core/RepositoryStore';
import { PanelManager } from './PanelManager';
import { relPathIn } from '../core/paths';

export const COMMIT_VIEW_ID = 'turtlegit.commitView';

/**
 * 侧边栏内嵌提交视图（WebviewView）。
 *
 * 复刻 TortoiseGit"提交在一个面板内完成"的习惯：文件勾选、增删统计、提交信息、
 * 提交按钮都在侧边栏里，不再弹出独立对话框。差异查看交给 VSCode 原生 diff
 * （侧边栏 webview 位于主窗口，无需浮动窗口收回逻辑）。
 *
 * 与提交对话框共用同一套 RPC 路由与仓库事件推送（PanelManager.attachSidebar）。
 */
export class CommitViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private attached: vscode.Disposable | undefined;
  private repoRoot: string | undefined;
  /** 视图尚未解析时的预选文件（"在此提交…"场景） */
  private pendingPaths: string[] | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private panels: PanelManager,
    private store: RepositoryStore,
  ) {
    this.disposables.push(
      this.store.onDidChangeRepos(() => {
        void this.syncRepo();
      }),
      // 分支信息改由 webview 渲染为变更文件列表的第一级根节点，标题栏不再显示
    );
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };
    webviewView.onDidDispose(
      () => {
        this.attached?.dispose();
        this.attached = undefined;
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );
    // 视图重新变为可见（展开侧边栏/切回该视图）时刷新，避免显示过期状态
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) this.panels.refreshAll();
      },
      undefined,
      this.disposables,
    );

    const repoRoot = await this.panels.resolveRepoRootFor();
    this.repoRoot = repoRoot;
    // 标题保持静态「提交」；当前分支由 webview 渲染为变更文件列表的第一级
    webviewView.title = '提交';
    this.render(repoRoot, this.pendingPaths);
    this.pendingPaths = undefined;
  }

  /** 仓库发现结果变化时同步（如打开/关闭文件夹、首次发现仓库） */
  private async syncRepo(): Promise<void> {
    const repoRoot = await this.panels.resolveRepoRootFor();
    if (repoRoot === this.repoRoot) return;
    this.repoRoot = repoRoot;
    if (!this.view) return;
    this.render(repoRoot);
  }

  private render(repoRoot: string | undefined, paths?: string[]): void {
    const view = this.view;
    if (!view) return;
    const init = this.panels.buildInitFor('commit', repoRoot ?? '', { paths }, true);
    view.webview.html = this.panels.html(view.webview, 'commit', init);
    this.attached?.dispose();
    this.attached = repoRoot
      ? this.panels.attachSidebar(COMMIT_VIEW_ID, 'commit', view.webview, repoRoot)
      : undefined;
  }

  /**
   * 显示侧边栏提交视图（"提交…"命令）。
   * fsPaths 非空时切换到目标仓库并预选这些文件（"在此提交…"）。
   */
  async show(fsPaths?: string[]): Promise<void> {
    // 先展开 TurtleGit 视图容器，再聚焦提交视图（focus 命令不可用时前者已足够）
    await vscode.commands
      .executeCommand('workbench.view.extension.turtlegit')
      .then(undefined, () => undefined);
    await vscode.commands
      .executeCommand(`${COMMIT_VIEW_ID}.focus`)
      .then(undefined, () => undefined);

    const target = fsPaths?.[0];
    const repoRoot = await this.panels.resolveRepoRootFor(target);
    const relPaths =
      repoRoot && fsPaths?.length
        ? fsPaths.map((p) => relPathIn(repoRoot, p)).filter((p): p is string => !!p)
        : undefined;

    if (!this.view) {
      // 视图还没解析：记录下来，resolveWebviewView 时应用
      this.pendingPaths = relPaths?.length ? relPaths : undefined;
      this.repoRoot = repoRoot;
      return;
    }
    if (repoRoot && relPaths?.length) {
      this.repoRoot = repoRoot;
      this.panels.setSidebarRepo(COMMIT_VIEW_ID, 'commit', repoRoot, relPaths);
    } else if (repoRoot && repoRoot !== this.repoRoot) {
      this.repoRoot = repoRoot;
      this.panels.setSidebarRepo(COMMIT_VIEW_ID, 'commit', repoRoot);
    } else {
      this.view.show?.(false);
    }
  }

  dispose(): void {
    this.attached?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
