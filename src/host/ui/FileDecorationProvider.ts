import * as vscode from 'vscode';
import * as i18n from '../i18n';
import { RepositoryStore } from '../core/RepositoryStore';
import { absPathIn, relPathIn } from '../core/paths';
import { FileStatus } from '../../../shared/protocol';

const BADGE: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechanged: 'T',
  conflicted: '!',
  none: '',
};

const LABEL_CN: Record<string, string> = {
  modified: i18n.t('deco.modified'),
  added: i18n.t('status.added'),
  deleted: i18n.t('deco.deleted'),
  renamed: i18n.t('branches.renameOp'),
  copied: i18n.t('status.copied'),
  typechanged: i18n.t('deco.typechanged'),
  conflicted: i18n.t('status.conflict'),
};

/**
 * 复刻 TortoiseGit 的图标覆盖：在资源管理器中给变更文件加状态角标。
 */
export class FileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private disposables: vscode.Disposable[] = [];

  constructor(private store: RepositoryStore) {
    this.disposables.push(
      store.onDidChangeFiles(({ repoRoot, files }) => {
        const uris = files.map((f) => vscode.Uri.file(absPathIn(repoRoot, f.path)));
        if (uris.length) {
          this._onDidChange.fire(uris);
        }
      }),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const repoRoot = this.store.repoForPath(uri.fsPath);
    if (!repoRoot) return undefined;
    const rel = relPathIn(repoRoot, uri.fsPath);
    if (!rel) return undefined;
    const file = this.store.fileStatus(repoRoot, rel);
    if (!file) return undefined;
    return decorationFor(file);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export function decorationFor(file: FileStatus): vscode.FileDecoration {
  if (file.conflicted) {
    return {
      badge: '!',
      color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
      tooltip: i18n.t('deco.conflictTip'),
      propagate: false,
    };
  }
  if (file.untracked) {
    return {
      badge: 'U',
      color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
      tooltip: i18n.t('deco.untrackedTip'),
      propagate: false,
    };
  }
  if (file.index === 'added' && file.worktree === 'none') {
    return {
      badge: 'A',
      color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      tooltip: i18n.t('deco.stagedAddedTip'),
      propagate: false,
    };
  }
  if (file.index !== 'none' && file.worktree !== 'none') {
    return {
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: i18n.t('deco.stagedAndWorktreeTip'),
      propagate: false,
    };
  }
  if (file.index !== 'none') {
    const s = file.index;
    return {
      badge: BADGE[s] ?? 'M',
      color: new vscode.ThemeColor('gitDecoration.stagedModifiedResourceForeground'),
      tooltip: i18n.t('deco.stagedTip', LABEL_CN[s] ?? s),
      propagate: false,
    };
  }
  if (file.worktree !== 'none') {
    const s = file.worktree;
    const colorKey =
      s === 'deleted'
        ? 'gitDecoration.deletedResourceForeground'
        : s === 'added' || s === 'renamed'
          ? 'gitDecoration.addedResourceForeground'
          : 'gitDecoration.modifiedResourceForeground';
    return {
      badge: BADGE[s] ?? 'M',
      color: new vscode.ThemeColor(colorKey),
      tooltip: i18n.t('deco.worktreeTip', LABEL_CN[s] ?? s),
      propagate: false,
    };
  }
  return { propagate: false };
}
