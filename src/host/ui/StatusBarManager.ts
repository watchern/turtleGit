import * as vscode from 'vscode';
import { RepositoryStore } from '../core/RepositoryStore';
import { BranchInfo } from '../../../shared/protocol';

const STATE_CN: Record<string, string> = {
  merging: '合并中',
  rebasing: '变基中',
  'cherry-picking': '拣选中',
  reverting: '还原中',
  bisecting: '二分中',
  applying: '应用补丁中',
};

/**
 * 状态栏：当前分支 + 领先/落后（TortoiseGit 用户习惯的 Sync 入口信息）。
 */
export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: RepositoryStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'turtlegit.log';
    this.item.tooltip = 'TurtleGit: 显示日志';

    this.disposables.push(
      store.onDidChangeBranch(({ repoRoot, info }) => this.update(repoRoot, info)),
      store.onDidChangeRepos(() => {
        const first = store.repoInfos()[0];
        if (first) this.update(first.root, store.branch(first.root));
      }),
    );
    this.item.show();
  }

  private update(_repoRoot: string, info: BranchInfo): void {
    let text = `$(git-branch) ${info.name}`;
    if (info.detached) {
      text = `$(git-commit) ${info.name}（分离头指针）`;
    }
    if (info.ahead || info.behind) {
      const parts: string[] = [];
      if (info.behind) parts.push(`↓${info.behind}`);
      if (info.ahead) parts.push(`↑${info.ahead}`);
      text += ` ${parts.join(' ')}`;
    }
    if (info.state !== 'clean') {
      text += ` ⚠ ${STATE_CN[info.state] ?? info.state}`;
    }
    this.item.text = text;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.item.dispose();
  }
}
