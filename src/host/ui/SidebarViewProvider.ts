import * as vscode from 'vscode';
import { RepositoryStore } from '../core/RepositoryStore';
import { PanelManager } from './PanelManager';
import { relPathIn } from '../core/paths';
import { SidebarTab } from '../../../shared/protocol';

export const SIDEBAR_VIEW_ID = 'turtlegit.sidebarView';

/**
 * 合并后的侧边栏（单一 WebviewView）：用标签页在「提交 / 分支 / 暂存」之间切换，
 * 取代原先两个独立的 WebviewView（commitView / branchesView）。
 *
 * 与提交对话框、分支面板共用同一套 RPC 路由与仓库事件推送（PanelManager.attachSidebar）。
 * 命令聚焦（commit/branches/stash）通过 `sidebar:tab` 事件切页，不重建视图。
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private attached: vscode.Disposable | undefined;
  private repoRoot: string | undefined;
  /** 视图尚未解析时的预选信息（"在此提交…"场景） */
  private pendingPaths: string[] | undefined;
  private pendingTab: SidebarTab = 'commit';
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
        if (webviewView.visible) this.panels.refreshSidebar(SIDEBAR_VIEW_ID);
      },
      undefined,
      this.disposables,
    );

    const repoRoot = await this.panels.resolveRepoRootFor();
    this.repoRoot = repoRoot;
    // 标题留空：标签页已提供「提交 / 分支 / 暂存」标签，避免冗余表头
    webviewView.title = '';
    this.render(repoRoot, this.pendingTab, this.pendingPaths);
    this.pendingPaths = undefined;
  }

  /** 仓库发现结果变化时同步（如打开/关闭文件夹、首次发现仓库） */
  private async syncRepo(): Promise<void> {
    const repoRoot = await this.panels.resolveRepoRootFor();
    if (repoRoot === this.repoRoot) return;
    this.repoRoot = repoRoot;
    if (!this.view) return;
    this.render(repoRoot, this.pendingTab);
  }

  private render(repoRoot: string | undefined, tab: SidebarTab, paths?: string[]): void {
    const view = this.view;
    if (!view) return;
    const init = this.panels.buildInitFor('sidebar', repoRoot ?? '', { tab, paths }, true);
    view.webview.html = this.panels.html(view.webview, 'sidebar', init);
    this.attached?.dispose();
    this.attached = repoRoot
      ? this.panels.attachSidebar(SIDEBAR_VIEW_ID, 'sidebar', view.webview, repoRoot)
      : undefined;
  }

  /**
   * 显示合并侧边栏并切换到指定标签页（"在此提交…"可带 fsPaths 预选文件）。
   * tab 缺省为 commit。视图已解析且仓库未变时仅推送 `sidebar:tab` 事件切页；
   * 视图未解析或仓库变更时重建并预选。
   */
  async show(fsPaths?: string[], tab?: SidebarTab): Promise<void> {
    const targetTab = tab ?? 'commit';
    // 先展开 TurtleGit 视图容器，再聚焦侧边栏视图（focus 命令不可用时前者已足够）
    await vscode.commands
      .executeCommand('workbench.view.extension.turtlegit')
      .then(undefined, () => undefined);
    await vscode.commands
      .executeCommand(`${SIDEBAR_VIEW_ID}.focus`)
      .then(undefined, () => undefined);

    if (!this.view) {
      // 视图还没解析：记录下来，resolveWebviewView 时应用
      this.pendingTab = targetTab;
      if (fsPaths?.length) this.pendingPaths = fsPaths;
      this.repoRoot = await this.panels.resolveRepoRootFor(fsPaths?.[0]);
      return;
    }

    const target = fsPaths?.[0];
    const repoRoot = await this.panels.resolveRepoRootFor(target);
    const relPaths =
      repoRoot && fsPaths?.length
        ? fsPaths.map((p) => relPathIn(repoRoot, p)).filter((p): p is string => !!p)
        : undefined;

    if (repoRoot && relPaths?.length && repoRoot !== this.repoRoot) {
      // 跨仓库预选：重建并落到 commit 标签
      this.repoRoot = repoRoot;
      this.panels.setSidebarRepo(SIDEBAR_VIEW_ID, 'sidebar', repoRoot, {
        tab: 'commit',
        paths: relPaths,
      });
      return;
    }
    if (repoRoot && repoRoot !== this.repoRoot) {
      this.repoRoot = repoRoot;
      this.panels.setSidebarRepo(SIDEBAR_VIEW_ID, 'sidebar', repoRoot, { tab: targetTab });
      return;
    }
    // 同仓库：仅切页，不重建视图（保留已填写的提交信息）
    this.panels.switchSidebarTab(targetTab);
    this.view.show?.(false);
  }

  dispose(): void {
    this.attached?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
