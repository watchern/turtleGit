import * as vscode from 'vscode';
import { GitRunner, resolveGitExecutable } from './host/git/GitRunner';
import { GitService } from './host/git/GitService';
import { RepositoryStore } from './host/core/RepositoryStore';
import { FileDecorationProvider } from './host/ui/FileDecorationProvider';
import { StatusBarManager } from './host/ui/StatusBarManager';
import { nodeToTargets } from './host/ui/statusNodes';
import { PanelManager } from './host/ui/PanelManager';
import { SidebarViewProvider } from './host/ui/SidebarViewProvider';
import { absPathIn, relPathIn } from './host/core/paths';
import * as i18n from './host/i18n';

let store: RepositoryStore | undefined;
let panels: PanelManager | undefined;
let decorations: FileDecorationProvider | undefined;
let statusBar: StatusBarManager | undefined;
let sidebarView: SidebarViewProvider | undefined;

/** 命令目标：仓库根 + 仓库相对路径 */
type FileTarget = { repoRoot: string; path: string };

export function activate(context: vscode.ExtensionContext): void {
  const gitPath = resolveGitExecutable(
    vscode.workspace.getConfiguration('turtlegit').get<string>('gitPath') || undefined,
  );
  const runner = new GitRunner(gitPath);
  const git = new GitService(runner);
  store = new RepositoryStore(git);
  store.attachBuiltinGit();

  panels = new PanelManager(context, git, runner, store);
  // 按「设置 turtlegit.language → VSCode 显示语言 → 英文」确定界面语言
  i18n.refreshLocale();
  // 合并后的侧边栏（提交 / 分支 / 暂存 三标签合一，复刻 TortoiseGit 单面板习惯）
  sidebarView = new SidebarViewProvider(context, panels, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('turtlegit.sidebarView', sidebarView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const showDecorations =
    vscode.workspace.getConfiguration('turtlegit').get<boolean>('showStatusDecorations') ?? true;
  if (showDecorations) {
    decorations = new FileDecorationProvider(store);
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(decorations),
    );
  }
  statusBar = new StatusBarManager(store);

  /** 解析当前仓库根：活动编辑器 → 第一个工作区文件夹 → 已发现仓库 */
  const resolveRepoRoot = async (): Promise<string | undefined> => {
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      const root = await git.repoRootOf(active);
      if (root) return root;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
      const root = await git.repoRootOf(folders[0].uri.fsPath);
      if (root) return root;
    }
    return store!.repoInfos()[0]?.root;
  };

  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const withRepoArg =
    (fn: (fsPath: string | undefined, uris: readonly vscode.Uri[] | undefined) => Promise<void>) =>
    (...args: unknown[]): Promise<void> => {
      const uri = args[0] as vscode.Uri | undefined;
      const uris = args[1] as readonly vscode.Uri[] | undefined;
      return fn(uri?.fsPath, uris);
    };

  /** 命令参数（Uri / 侧边栏树节点 / 多选 Uri）→ 仓库相对路径目标列表 */
  const resolveTargets = async (...args: unknown[]): Promise<FileTarget[]> => {
    const arg = args[0];
    const uris = args[1] as readonly vscode.Uri[] | undefined;
    const fromFsPaths = async (paths: string[]): Promise<FileTarget[]> => {
      const out: FileTarget[] = [];
      for (const p of paths) {
        const root = await git.repoRootOf(p);
        if (!root) continue;
        const rel = relPathIn(root, p);
        if (rel) out.push({ repoRoot: root, path: rel });
      }
      return out;
    };
    if (uris?.length) return fromFsPaths(uris.map((u) => u.fsPath));
    if (arg instanceof vscode.Uri) return fromFsPaths([arg.fsPath]);
    const fromNode = nodeToTargets(arg, (root) => store!.files(root));
    if (fromNode.length) return fromNode;
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) return fromFsPaths([active]);
    return [];
  };

  /** 按仓库分组执行变更文件操作（侧边栏右键 / 资源管理器右键共用） */
  const groupAction =
    (fn: (repoRoot: string, paths: string[]) => Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      const targets = await resolveTargets(...args);
      if (!targets.length) {
        vscode.window.showWarningMessage(i18n.t('host.noSelection'));
        return;
      }
      const byRepo = new Map<string, string[]>();
      for (const t of targets) {
        byRepo.set(t.repoRoot, [...(byRepo.get(t.repoRoot) ?? []), t.path]);
      }
      for (const [repoRoot, paths] of byRepo) {
        try {
          await fn(repoRoot, paths);
        } catch (err) {
          vscode.window.showErrorMessage(i18n.t('host.opFailed', errText(err)));
        }
      }
    };

  const commands: Array<[string, (...args: unknown[]) => Promise<void> | void]> = [
    // 提交：聚焦合并侧边栏并切到「提交」标签（"在此提交…"额外预选目标文件）
    ['turtlegit.commit', () => sidebarView!.show(undefined, 'commit')],
    // 分支：聚焦合并侧边栏并切到「分支」标签（切换分支 / 管理远程）
    ['turtlegit.branches', () => sidebarView!.show(undefined, 'branches')],
    [
      'turtlegit.commitPath',
      async (...args: unknown[]): Promise<void> => {
        const arg = args[0] as vscode.Uri | undefined;
        const uris = args[1] as readonly vscode.Uri[] | undefined;
        const paths = uris?.length
          ? uris.map((u) => u.fsPath)
          : arg instanceof vscode.Uri
            ? [arg.fsPath]
            : [];
        await sidebarView!.show(paths.length ? paths : undefined, 'commit');
      },
    ],
    ['turtlegit.log', () => panels!.openLog()],
    [
      'turtlegit.diff',
      async (...args: unknown[]): Promise<void> => {
        const targets = await resolveTargets(...args);
        const first = targets[0];
        if (!first) {
          vscode.window.showWarningMessage(i18n.t('host.selectFileFirst'));
          return;
        }
        await panels!.diffNative(absPathIn(first.repoRoot, first.path));
      },
    ],
    [
      'turtlegit.diffPanel',
      async (...args: unknown[]): Promise<void> => {
        const targets = await resolveTargets(...args);
        const first = targets[0];
        if (!first) {
          vscode.window.showWarningMessage(i18n.t('host.selectFileFirst'));
          return;
        }
        await panels!.openDiff(absPathIn(first.repoRoot, first.path));
      },
    ],
    [
      'turtlegit.openFile',
      async (...args: unknown[]): Promise<void> => {
        const targets = await resolveTargets(...args);
        if (!targets.length) {
          vscode.window.showWarningMessage(i18n.t('host.selectFileFirst'));
          return;
        }
        for (const t of targets) {
          await panels!.openFileInEditor(t.repoRoot, t.path);
        }
      },
    ],
    ['turtlegit.stage', groupAction((r, p) => panels!.stagePaths(r, p))],
    ['turtlegit.unstage', groupAction((r, p) => panels!.unstagePaths(r, p))],
    ['turtlegit.ignore', groupAction((r, p) => panels!.ignorePaths(r, p))],
    [
      'turtlegit.discard',
      async (...args: unknown[]): Promise<void> => {
        const targets = await resolveTargets(...args);
        if (!targets.length) {
          vscode.window.showWarningMessage(i18n.t('host.noSelection'));
          return;
        }
        const names = targets.map((t) => t.path).join('、');
        const confirmLabel = i18n.t('common.confirm');
        const answer = await vscode.window.showWarningMessage(
          i18n.t('host.discardConfirm', names),
          { modal: true },
          confirmLabel,
        );
        if (answer !== confirmLabel) return;
        const byRepo = new Map<string, string[]>();
        for (const t of targets) {
          byRepo.set(t.repoRoot, [...(byRepo.get(t.repoRoot) ?? []), t.path]);
        }
        for (const [repoRoot, paths] of byRepo) {
          try {
            await panels!.discardPaths(repoRoot, paths);
          } catch (err) {
            vscode.window.showErrorMessage(i18n.t('host.opFailed', errText(err)));
          }
        }
      },
    ],
    ['turtlegit.graph', () => panels!.openGraph()],
    ['turtlegit.stash', () => sidebarView!.show(undefined, 'stash')],
    ['turtlegit.blame', withRepoArg((p) => (p ? panels!.openBlame(p) : Promise.resolve()))],
    ['turtlegit.refresh', () => panels!.refreshAll()],
    ['turtlegit.openFloating', () => panels!.pullActiveToMain()],
    ['turtlegit.pull', async () => {
      const root = await resolveRepoRoot();
      if (!root) {
        vscode.window.showWarningMessage(i18n.t('host.noRepo'));
        return;
      }
      try {
        const summary = await panels!.pull(root);
        vscode.window.showInformationMessage(i18n.t('host.pullDone', summary));
      } catch (err) {
        vscode.window.showErrorMessage(i18n.t('host.pullFailed', errText(err)));
      }
    }],
    ['turtlegit.push', async () => {
      const root = await resolveRepoRoot();
      if (!root) {
        vscode.window.showWarningMessage(i18n.t('host.noRepo'));
        return;
      }
      try {
        const summary = await panels!.push(root);
        vscode.window.showInformationMessage(i18n.t('host.pushDone', summary));
      } catch (err) {
        vscode.window.showErrorMessage(i18n.t('host.pushFailed', errText(err)));
      }
    }],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // 工作区变化（打开/关闭文件夹）时重新发现仓库
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void store!.discover();
    }),
  );

  // 窗口重新获得焦点时刷新：在外部（终端/TortoiseGit）执行 git 操作后切回即可同步
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(({ focused }) => {
      if (focused) panels!.refreshAll();
    }),
  );

  // 监听文件保存，触发轻量刷新
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      if (vscode.workspace.getConfiguration('turtlegit').get<boolean>('autoRefresh')) {
        void store!.refreshAll({ silent: true });
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('turtlegit.showStatusDecorations')) {
        vscode.window.showInformationMessage(i18n.t('host.reloadDecorations'));
      }
      // 忽略文件排除名单变更：立即刷新，无需重载
      if (e.affectsConfiguration('turtlegit.ignoredExcludeDirs')) {
        void store!.refreshAll({ silent: true });
      }
      // 界面语言变更：刷新语言并向已打开面板重推 init，使其用新字典重挂载
      if (e.affectsConfiguration('turtlegit.language')) {
        panels?.onLocaleChanged();
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      store?.dispose();
      panels?.dispose();
      statusBar?.dispose();
      sidebarView?.dispose();
    },
  });

  void store.discover();
}

export function deactivate(): void {
  store?.dispose();
  panels?.dispose();
}
