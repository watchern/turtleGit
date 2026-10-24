import * as vscode from 'vscode';
import { EventEmitter } from 'vscode';
import { GitService } from '../git/GitService';
import { normalizeFsPath } from './paths';
import { FileStatus, RepoInfo, BranchInfo } from '../../../shared/protocol';

interface RepoEntry {
  info: RepoInfo;
  files: FileStatus[];
  branch: BranchInfo;
  refreshing: boolean;
}

/**
 * 仓库状态中心：发现工作区中的 git 仓库，维护文件状态与分支信息，
 * 在内置 git 扩展刷新时同步失效，并向所有 UI（装饰器、树视图、面板）广播。
 */
export class RepositoryStore {
  private repos = new Map<string, RepoEntry>();
  private disposables: vscode.Disposable[] = [];
  private gitApi: { onDidChangeRepository?: vscode.Event<unknown>; onDidOpenRepository?: vscode.Event<unknown> } | undefined;

  private readonly _onDidChangeFiles = new EventEmitter<{ repoRoot: string; files: FileStatus[] }>();
  readonly onDidChangeFiles = this._onDidChangeFiles.event;

  private readonly _onDidChangeBranch = new EventEmitter<{ repoRoot: string; info: BranchInfo }>();
  readonly onDidChangeBranch = this._onDidChangeBranch.event;

  private readonly _onDidChangeRepos = new EventEmitter<RepoInfo[]>();
  readonly onDidChangeRepos = this._onDidChangeRepos.event;

  constructor(private git: GitService) {}

  /** 订阅内置 git 扩展的仓库事件，作为被动刷新触发器。 */
  attachBuiltinGit(): void {
    const ext = vscode.extensions.getExtension<{ getAPI(version: number): unknown }>('vscode.git');
    if (!ext?.isActive && !ext) {
      return;
    }
    const activate = async () => {
      try {
        const api = (ext.exports as { getAPI(v: number): unknown })?.getAPI(1) as {
          repositories?: unknown[];
          onDidChangeRepository?: vscode.Event<unknown>;
          onDidOpenRepository?: vscode.Event<unknown>;
        } | undefined;
        if (!api) return;
        this.gitApi = api;
        const onChange = api.onDidChangeRepository ?? api.onDidOpenRepository;
        if (onChange) {
          this.disposables.push(onChange(() => this.refreshAll({ silent: false })));
        }
      } catch {
        /* 内置 git 不可用时静默降级 */
      }
    };
    if (ext.isActive) {
      void activate();
    } else {
      ext.activate().then(activate, () => undefined);
    }
  }

  async discover(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const root = await this.git.repoRootOf(folder.uri.fsPath);
      if (root && !this.repos.has(root)) {
        const name = await this.git.repoName(root);
        this.repos.set(root, {
          info: { root, name },
          files: [],
          branch: {
            name: '?',
            ahead: 0,
            behind: 0,
            detached: false,
            state: 'clean',
          },
          refreshing: false,
        });
      }
    }
    this._onDidChangeRepos.fire(this.repoInfos());
    void this.refreshAll();
  }

  repoInfos(): RepoInfo[] {
    return [...this.repos.values()].map((r) => r.info);
  }

  /** 给定 fs 路径找到所属仓库根；找不到返回 undefined。 */
  repoForPath(fsPath: string): string | undefined {
    if (!fsPath) return undefined;
    const normalized = normalizeFsPath(fsPath);
    let best: string | undefined;
    for (const key of this.repos.keys()) {
      const root = normalizeFsPath(key);
      if (normalized === root || normalized.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) {
        if (!best || root.length > normalizeFsPath(best).length) {
          best = key;
        }
      }
    }
    return best;
  }

  files(repoRoot: string): FileStatus[] {
    return this.repos.get(repoRoot)?.files ?? [];
  }

  fileStatus(repoRoot: string, filePath: string): FileStatus | undefined {
    return this.files(repoRoot).find((f) => f.path === filePath);
  }

  branch(repoRoot: string): BranchInfo {
    return (
      this.repos.get(repoRoot)?.branch ?? {
        name: '?',
        ahead: 0,
        behind: 0,
        detached: false,
        state: 'clean',
      }
    );
  }

  async refreshAll(opts: { silent?: boolean } = {}): Promise<void> {
    await Promise.all([...this.repos.keys()].map((root) => this.refresh(root, opts)));
  }

  async refresh(repoRoot: string, _opts: { silent?: boolean } = {}): Promise<void> {
    const entry = this.repos.get(repoRoot);
    if (!entry) return;
    if (entry.refreshing) return;
    entry.refreshing = true;
    try {
      const [files, branch] = await Promise.all([
        this.git
          .status(repoRoot, { ignoredExcludeDirs: this.ignoredExcludeDirs() })
          .catch(() => entry.files),
        this.git.branchInfo(repoRoot).catch(() => entry.branch),
      ]);
      entry.files = files;
      entry.branch = branch;
      this._onDidChangeFiles.fire({ repoRoot, files });
      this._onDidChangeBranch.fire({ repoRoot, info: branch });
    } finally {
      entry.refreshing = false;
    }
  }

  /** 写操作后调用：立即刷新对应仓库。 */
  async touch(repoRoot: string): Promise<void> {
    await this.refresh(repoRoot);
  }

  /**
   * 勾选「忽略文件」时排除不显示的文件夹（设置 turtlegit.ignoredExcludeDirs）。
   * 读取失败或类型不符时回退默认值 ['.history', 'node_modules']；
   * 用户显式设为空数组则不过滤任何目录。
   */
  private ignoredExcludeDirs(): string[] {
    let list: unknown;
    try {
      list = vscode.workspace.getConfiguration('turtlegit').get('ignoredExcludeDirs');
    } catch {
      return ['.history', 'node_modules'];
    }
    if (!Array.isArray(list)) return ['.history', 'node_modules'];
    return list.filter((d): d is string => typeof d === 'string');
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
