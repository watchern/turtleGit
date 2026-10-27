import { GitRunner, GitRunnerError, GitRunResult } from './GitRunner';
import * as i18n from '../i18n';
import { BranchInfo } from '../../../shared/protocol';

export interface BranchEntry {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  commit: string;
  /** 远程分支所属 remote 名（本地分支无） */
  remote?: string;
  /** 去掉 `remotes/<remote>/` 前缀后的分支名（远程分支面板展示用） */
  shortName?: string;
}

/** 一个远程仓库（fetch/push 地址不同时同时给出 pushUrl） */
export interface RemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
}

/**
 * 分支名解析（纯函数，便于测试）：
 * - `remotes/origin/feature/x` → { remote: 'origin', shortName: 'feature/x', isRemote: true }
 * - `feature/x`（本地）→ { shortName: 'feature/x', isRemote: false }（本地名的 / 只是普通分隔，不拆）
 */
export function parseBranchName(ref: string): {
  remote?: string;
  shortName: string;
  isRemote: boolean;
} {
  // 注意：不能用 `refs/remotes/` 之外的前缀判定远程分支——`git branch -a
  // --format=%(refname:short)` 对远程跟踪分支输出的是 `origin/feature`（已去掉
  // `remotes/` 前缀），旧实现按 `remotes/` 判定导致远程分支被当成本地分支。
  // 因此这里统一按完整 ref 名（`%(refname)`）判定，同时兼容短名形态。
  const isRemote = /^refs\/remotes\//.test(ref) || /^remotes\//.test(ref);
  const trimmed = ref
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '')
    .replace(/^refs\/heads\//, '');
  if (isRemote) {
    const slash = trimmed.indexOf('/');
    if (slash > 0) {
      return { remote: trimmed.slice(0, slash), shortName: trimmed.slice(slash + 1), isRemote };
    }
  }
  return { shortName: trimmed, isRemote };
}

/** 解析 `git remote -v` 输出（纯函数，便于测试） */
export function parseRemotes(out: string): RemoteEntry[] {
  const map = new Map<string, RemoteEntry>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const [, name, url, kind] = m;
    const entry = map.get(name) ?? { name, fetchUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    map.set(name, entry);
  }
  // push 与 fetch 相同时不单独给出 pushUrl（UI 侧无需重复展示）
  for (const entry of map.values()) {
    if (entry.pushUrl && entry.pushUrl === entry.fetchUrl) delete entry.pushUrl;
  }
  return [...map.values()];
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

/**
 * 分支/标签/合并/变基/拣选/重置等分支操作层。
 * 所有写操作返回 Promise，失败抛 GitRunnerError（stderr 已过滤 warning）。
 */
export class BranchOps {
  constructor(private runner: GitRunner) {}

  // ---------- 分支 ----------

  async branches(repoRoot: string): Promise<BranchEntry[]> {
    const out = await this.runner.out(
      [
        'branch',
        '-a',
        '--no-color',
        // 首列用完整 ref 名判定本地/远程（%(refname:short) 会抹掉这一信息），
        // 次列才是可直接当 git ref 使用的短名
        '--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(objectname:short)',
      ],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    const entries: BranchEntry[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [refname, short, head, upstream, commit] = line.split('\t');
      if (!refname) continue;
      const parsed = parseBranchName(refname);
      // 远程跟踪分支无"自己的上游"概念，跳过统计（同时省一次 rev-list）
      const counts =
        upstream && !parsed.isRemote
          ? await this.aheadBehind(repoRoot, short || parsed.shortName)
          : { ahead: 0, behind: 0 };
      entries.push({
        // name 保持原有语义：本地 `feature`、远程 `origin/feature`（可直接作为 git ref）
        name: short || parsed.shortName,
        isRemote: parsed.isRemote,
        isCurrent: head === '*',
        upstream: upstream || undefined,
        ahead: counts.ahead,
        behind: counts.behind,
        commit: commit ?? '',
        remote: parsed.remote,
        shortName: parsed.shortName,
      });
    }
    return entries;
  }

  /**
   * 相对该分支**自己的上游**统计领先/落后。
   * 旧实现用 `@{upstream}`（= 当前分支的上游），导致非当前分支的 ↑↓ 全是错的。
   */
  private async aheadBehind(
    repoRoot: string,
    ref: string,
  ): Promise<{ ahead: number; behind: number }> {
    const r = await this.runner.tryRun(
      ['rev-list', '--left-right', '--count', `${ref}...${ref}@{upstream}`],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    if (!r?.stdout.trim()) return { ahead: 0, behind: 0 };
    const [l, rr] = r.stdout.trim().split(/\s+/);
    return { ahead: Number(l) || 0, behind: Number(rr) || 0 };
  }

  async createBranch(
    repoRoot: string,
    name: string,
    ref?: string,
    checkout = false,
  ): Promise<void> {
    const args = checkout ? ['checkout', '-b', name] : ['branch', name];
    if (ref) args.push(ref);
    await this.assertOk(args, repoRoot, i18n.t('ops.createBranchFailed'));
  }

  async deleteBranch(repoRoot: string, name: string, force = false): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', name];
    await this.assertOk(args, repoRoot, i18n.t('ops.deleteBranchFailed'));
  }

  async renameBranch(repoRoot: string, oldName: string, newName: string): Promise<void> {
    await this.assertOk(['branch', '-m', oldName, newName], repoRoot, i18n.t('ops.renameBranchFailed'));
  }

  /**
   * 检出远程分支：本地已存在同名分支则直接检出，否则建立同名本地分支并跟踪
   * （对应 IDEA「Checkout as new local branch」）。
   */
  async checkoutRemote(
    repoRoot: string,
    remoteBranch: string,
  ): Promise<{ branch: string; created: boolean }> {
    // 入参形态：`remotes/origin/feature`（git 原始）或 `origin/feature`（BranchEntry.name）
    const raw = remoteBranch.replace(/^remotes\//, '');
    const slash = raw.indexOf('/');
    if (slash <= 0) throw new Error(i18n.t('ops.parseRemoteBranchFailed', remoteBranch));
    const remote = raw.slice(0, slash);
    const short = raw.slice(slash + 1);
    if (await this.branchExists(repoRoot, short)) {
      await this.checkout(repoRoot, short);
      return { branch: short, created: false };
    }
    await this.assertOk(
      ['checkout', '-b', short, '--track', `${remote}/${short}`],
      repoRoot,
      i18n.t('ops.checkoutRemoteFailed'),
    );
    return { branch: short, created: true };
  }

  /** 删除远程分支：git push <remote> --delete <branch>（网络操作，用较长超时） */
  async deleteRemoteBranch(repoRoot: string, remote: string, branch: string): Promise<void> {
    await this.assertOk(
      ['push', remote, '--delete', branch],
      repoRoot,
      i18n.t('ops.deleteRemoteBranchFailed'),
      BranchOps.NET_TIMEOUT,
    );
  }

  private async branchExists(repoRoot: string, name: string): Promise<boolean> {
    const r = await this.runner.tryRun(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    return !!r;
  }

  // ---------- 远程仓库管理（IDEA Manage Remotes） ----------

  /** 列出 remote（fetch/push 地址） */
  async remotes(repoRoot: string): Promise<RemoteEntry[]> {
    const out = await this.runner.out(['remote', '-v'], { cwd: repoRoot, timeoutMs: 15000 });
    return parseRemotes(out);
  }

  async addRemote(repoRoot: string, name: string, url: string): Promise<void> {
    await this.assertOk(['remote', 'add', name, url], repoRoot, i18n.t('ops.addRemoteFailed'));
  }

  async removeRemote(repoRoot: string, name: string): Promise<void> {
    await this.assertOk(['remote', 'remove', name], repoRoot, i18n.t('ops.removeRemoteFailed'));
  }

  /** 修改 remote 地址；push=true 时只改 push 地址（--push） */
  async setRemoteUrl(
    repoRoot: string,
    name: string,
    url: string,
    push = false,
  ): Promise<void> {
    const args = ['remote', 'set-url', name, url];
    if (push) args.push('--push');
    await this.assertOk(args, repoRoot, i18n.t('ops.setUrlFailed'));
  }

  /**
   * 同步远程引用（git fetch <remote>）：只更新远程跟踪分支，不动工作区与当前分支。
   * fetch 的进度/摘要信息主要在 stderr，成功时也可能有输出（如 "-> origin/main"）。
   */
  async fetchRemote(repoRoot: string, remote: string): Promise<GitRunResult> {
    if (!remote) throw new Error(i18n.t('ops.noRemoteName'));
    const r = await this.runner.run(['fetch', remote, '--progress'], {
      cwd: repoRoot,
      timeoutMs: BranchOps.NET_TIMEOUT,
    });
    if (r.code !== 0) {
      throw new GitRunnerError(
        this.cleanOutput(`${r.stdout}\n${r.stderr}`) || i18n.t('ops.fetchFailed', remote),
        r,
      );
    }
    return r;
  }

  // ---------- 标签 ----------

  async tags(repoRoot: string): Promise<TagEntry[]> {
    const out = await this.runner.out(
      [
        'tag',
        '--list',
        '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:short)%09%(contents:subject)',
      ],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    return out
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((line) => {
        const [name, commit, date, ...rest] = line.split('\t');
        return { name, commit, date: date || undefined, message: rest.join('\t') || undefined };
      });
  }

  async createTag(
    repoRoot: string,
    name: string,
    ref?: string,
    message?: string,
  ): Promise<void> {
    const args = ['tag', name];
    if (message) args.push('-m', message);
    if (ref) args.push(ref);
    await this.assertOk(args, repoRoot, i18n.t('ops.createTagFailed'));
  }

  async deleteTag(repoRoot: string, name: string): Promise<void> {
    await this.assertOk(['tag', '-d', name], repoRoot, i18n.t('ops.deleteTagFailed'));
  }

  // ---------- 检出 / 切换 ----------

  async checkout(repoRoot: string, ref: string): Promise<void> {
    await this.assertOk(['checkout', ref], repoRoot, i18n.t('ops.checkoutFailed'));
  }

  // ---------- 合并 / 拣选 / 变基 ----------

  async merge(
    repoRoot: string,
    ref: string,
    opts: { noFf?: boolean; ffOnly?: boolean; noCommit?: boolean } = {},
  ): Promise<void> {
    const args = ['merge'];
    if (opts.noFf) args.push('--no-ff');
    if (opts.ffOnly) args.push('--ff-only');
    if (opts.noCommit) args.push('--no-commit');
    args.push(ref);
    await this.assertOk(args, repoRoot, i18n.t('ops.mergeFailed'));
  }

  async mergeAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['merge', '--abort'], repoRoot, i18n.t('ops.mergeAbortFailed'));
  }

  async cherryPick(repoRoot: string, hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    await this.assertOk(['cherry-pick', ...hashes], repoRoot, i18n.t('ops.cherryFailed'));
  }

  async cherryPickAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['cherry-pick', '--abort'], repoRoot, i18n.t('ops.cherryAbortFailed'));
  }

  async cherryPickContinue(repoRoot: string): Promise<void> {
    await this.assertOk(['cherry-pick', '--continue'], repoRoot, i18n.t('ops.cherryContinueFailed'));
  }

  async rebase(
    repoRoot: string,
    ref: string,
    opts: { interactive?: boolean; autostash?: boolean } = {},
  ): Promise<void> {
    const args = ['rebase'];
    if (opts.autostash !== false) args.push('--autostash');
    if (opts.interactive) args.push('-i');
    args.push(ref);
    await this.assertOk(args, repoRoot, i18n.t('ops.rebaseFailed'));
  }

  async rebaseAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--abort'], repoRoot, i18n.t('ops.rebaseAbortFailed'));
  }

  async rebaseContinue(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--continue'], repoRoot, i18n.t('ops.rebaseContinueFailed'));
  }

  async rebaseSkip(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--skip'], repoRoot, i18n.t('ops.rebaseSkipFailed'));
  }

  // ---------- 重置 / 还原 ----------

  async reset(repoRoot: string, ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.assertOk(['reset', `--${mode}`, ref], repoRoot, i18n.t('ops.resetFailed'));
  }

  async revert(repoRoot: string, hash: string, noCommit = false): Promise<void> {
    const args = ['revert'];
    if (noCommit) args.push('--no-commit');
    args.push(hash);
    await this.assertOk(args, repoRoot, i18n.t('ops.revertFailed'));
  }

  // ---------- Stash ----------

  async stashList(repoRoot: string): Promise<StashEntry[]> {
    const r = await this.runner.tryRun(
      ['stash', 'list', '--format=%gd%x09%H%x09%gs'],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    if (!r) return [];
    const entries: StashEntry[] = [];
    r.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((line) => {
        const [ref, commit, message] = line.split('\t');
        const m = /^stash@\{(\d+)\}$/.exec(ref ?? '');
        const branch = /^[^:]*: [^:]*: ([^:]+):/.exec(message ?? '');
        entries.push({
          index: m ? Number(m[1]) : entries.length,
          ref: ref ?? '',
          message: message ?? '',
          branch: branch?.[1],
          commit: commit ?? '',
        });
      });
    return entries;
  }

  async stashPush(repoRoot: string, message?: string, paths?: string[]): Promise<void> {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    if (paths?.length) args.push('--', ...paths);
    await this.assertOk(args, repoRoot, i18n.t('ops.stashPushFailed'));
  }

  async stashApply(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'apply', `stash@{${index}}`], repoRoot, i18n.t('ops.stashApplyFailed'));
  }

  async stashPop(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'pop', `stash@{${index}}`], repoRoot, i18n.t('ops.stashPopFailed'));
  }

  async stashDrop(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'drop', `stash@{${index}}`], repoRoot, i18n.t('ops.stashDropFailed'));
  }

  // ---------- Reflog ----------

  async reflog(repoRoot: string, limit = 100): Promise<ReflogEntry[]> {
    const r = await this.runner.tryRun(
      ['reflog', '--date=iso', '--format=%H%x1f%h%x1f%gs%x1f%ad', '-n', String(limit)],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    if (!r) return [];
    const entries: ReflogEntry[] = [];
    r.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((line, i) => {
        const [hash, shortHash, action, date] = line.split('\u001f');
        entries.push({
          hash: hash ?? '',
          shortHash: shortHash ?? '',
          // reflog 输出顺序即编号：最新一条为 HEAD@{0}
          selector: `HEAD@{${i}}`,
          action: action ?? '',
          date: date ?? '',
        });
      });
    return entries;
  }

  // ---------- Blame ----------

  async blame(repoRoot: string, filePath: string): Promise<BlameLine[]> {
    const out = await this.runner.out(['blame', '--line-porcelain', '--', filePath], {
      cwd: repoRoot,
      timeoutMs: 30000,
    });
    const lines: BlameLine[] = [];
    let hash = '';
    let author = '';
    let authorTime = 0;
    let summary = '';
    let pendingLine = 0;
    let content = '';
    const flush = (lineNo: number) => {
      if (!hash) return;
      lines.push({
        line: lineNo,
        hash,
        shortHash: hash.slice(0, 7),
        author,
        date: authorTime ? new Date(authorTime * 1000).toISOString().slice(0, 10) : '',
        summary,
        content,
      });
    };
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('\t')) {
        content = line.slice(1);
        continue;
      }
      const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
      if (header) {
        flush(pendingLine);
        hash = header[1];
        pendingLine = Number(header[3]);
        author = '';
        authorTime = 0;
        summary = '';
        content = '';
        continue;
      }
      if (line.startsWith('author ')) author = line.slice(7);
      else if (line.startsWith('author-time ')) authorTime = Number(line.slice(12));
      else if (line.startsWith('summary ')) summary = line.slice(8);
    }
    flush(pendingLine);
    return lines;
  }

  // ---------- 拉取 / 推送 ----------

  /** 网络操作超时（拉取/推送可能较久，给 10 分钟） */
  private static readonly NET_TIMEOUT = 600000;

  /** 当前分支名；detached HEAD 时返回空串。 */
  private async currentBranch(repoRoot: string): Promise<string> {
    const r = await this.runner.tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: 15000,
    });
    return r?.stdout.trim() ?? '';
  }

  /** 第一个 remote 名（无 remote 返回空串）。 */
  private async firstRemote(repoRoot: string): Promise<string> {
    const r = await this.runner.tryRun(['remote'], { cwd: repoRoot, timeoutMs: 15000 });
    return r?.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
  }

  /** 上游跟踪引用（如 origin/main）；无上游返回空串。 */
  private async upstreamRef(repoRoot: string): Promise<string> {
    const r = await this.runner.tryRun(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    return r?.stdout.trim() ?? '';
  }

  /** 清理 git 输出：去 warning 行、压缩空行、只保留末尾若干行。 */
  private cleanOutput(text: string, maxLines = 8): string {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^warning:/i.test(l));
    if (!lines.length) return '';
    const tail = lines.length > maxLines ? ['…', ...lines.slice(-maxLines)] : lines;
    return tail.join('\n');
  }

  /**
   * 拉取（fetch + merge，复刻 TortoiseGit Sync 对话框的 Pull）。
   * --no-edit 避免 merge 提交信息弹出编辑器卡住非交互进程。
   * 无上游跟踪时回退 `git pull <remote> <branch>`。
   */
  async pull(repoRoot: string, opts: { rebase?: boolean } = {}): Promise<GitRunResult> {
    const args = ['pull', '--no-edit'];
    if (opts.rebase) args.push('--rebase');
    if (!(await this.upstreamRef(repoRoot))) {
      const branch = await this.currentBranch(repoRoot);
      if (!branch) {
        throw new Error(i18n.t('ops.detachedPull'));
      }
      const remote = await this.firstRemote(repoRoot);
      if (!remote) {
        throw new Error(i18n.t('ops.noRemotePull'));
      }
      args.push(remote, branch);
    }
    const r = await this.runner.run(args, {
      cwd: repoRoot,
      timeoutMs: BranchOps.NET_TIMEOUT,
    });
    if (r.code !== 0) {
      // 冲突时关键信息在 stdout（Auto-merging / CONFLICT），stderr 为辅
      throw new GitRunnerError(
        this.cleanOutput(`${r.stdout}\n${r.stderr}`) || i18n.t('ops.pullFailed'),
        r,
      );
    }
    return r;
  }

  /** 推送。无上游跟踪时自动探测 remote 并 `-u` 建立跟踪关系。 */
  async push(repoRoot: string, opts: { forceWithLease?: boolean } = {}): Promise<GitRunResult> {
    const args = ['push'];
    if (opts.forceWithLease) args.push('--force-with-lease');
    if (!(await this.upstreamRef(repoRoot))) {
      const branch = await this.currentBranch(repoRoot);
      if (!branch) {
        throw new Error(i18n.t('ops.detachedPush'));
      }
      const remote = await this.firstRemote(repoRoot);
      if (!remote) {
        throw new Error(i18n.t('ops.noRemotePush'));
      }
      args.push('-u', remote, branch);
    }
    const r = await this.runner.run(args, {
      cwd: repoRoot,
      timeoutMs: BranchOps.NET_TIMEOUT,
    });
    if (r.code !== 0) {
      throw new GitRunnerError(this.cleanOutput(r.stderr) || i18n.t('ops.pushFailed'), r);
    }
    return r;
  }

  // ---------- 工具 ----------

  private async assertOk(
    args: string[],
    repoRoot: string,
    label: string,
    timeoutMs = 120000,
  ): Promise<void> {
    const r = await this.runner.run(args, { cwd: repoRoot, timeoutMs });
    if (r.code !== 0) {
      const message =
        r.stderr
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^warning:/i.test(l.trim()))
          .join('\n')
          .trim() || label;
      throw new GitRunnerError(message, r);
    }
  }
}
