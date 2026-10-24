import { GitRunner, GitRunnerError, GitRunResult } from './GitRunner';
import { BranchInfo } from '../../../shared/protocol';

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
        '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(objectname:short)',
      ],
      { cwd: repoRoot, timeoutMs: 15000 },
    );
    const entries: BranchEntry[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [name, head, upstream, commit] = line.split('\t');
      if (!name) continue;
      const isRemote = name.startsWith('remotes/');
      const counts = upstream
        ? await this.aheadBehind(repoRoot, name)
        : { ahead: 0, behind: 0 };
      entries.push({
        name: name.replace(/^remotes\//, ''),
        isRemote,
        isCurrent: head === '*',
        upstream: upstream || undefined,
        ahead: counts.ahead,
        behind: counts.behind,
        commit: commit ?? '',
      });
    }
    return entries;
  }

  private async aheadBehind(
    repoRoot: string,
    ref: string,
  ): Promise<{ ahead: number; behind: number }> {
    const r = await this.runner.tryRun(
      ['rev-list', '--left-right', '--count', `${ref}...@{upstream}`],
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
    await this.assertOk(args, repoRoot, '创建分支失败');
  }

  async deleteBranch(repoRoot: string, name: string, force = false): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', name];
    await this.assertOk(args, repoRoot, '删除分支失败');
  }

  async renameBranch(repoRoot: string, oldName: string, newName: string): Promise<void> {
    await this.assertOk(['branch', '-m', oldName, newName], repoRoot, '重命名分支失败');
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
    await this.assertOk(args, repoRoot, '创建标签失败');
  }

  async deleteTag(repoRoot: string, name: string): Promise<void> {
    await this.assertOk(['tag', '-d', name], repoRoot, '删除标签失败');
  }

  // ---------- 检出 / 切换 ----------

  async checkout(repoRoot: string, ref: string): Promise<void> {
    await this.assertOk(['checkout', ref], repoRoot, '切换失败');
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
    await this.assertOk(args, repoRoot, '合并失败');
  }

  async mergeAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['merge', '--abort'], repoRoot, '放弃合并失败');
  }

  async cherryPick(repoRoot: string, hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    await this.assertOk(['cherry-pick', ...hashes], repoRoot, '拣选失败');
  }

  async cherryPickAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['cherry-pick', '--abort'], repoRoot, '放弃拣选失败');
  }

  async cherryPickContinue(repoRoot: string): Promise<void> {
    await this.assertOk(['cherry-pick', '--continue'], repoRoot, '继续拣选失败');
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
    await this.assertOk(args, repoRoot, '变基失败');
  }

  async rebaseAbort(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--abort'], repoRoot, '放弃变基失败');
  }

  async rebaseContinue(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--continue'], repoRoot, '继续变基失败');
  }

  async rebaseSkip(repoRoot: string): Promise<void> {
    await this.assertOk(['rebase', '--skip'], repoRoot, '跳过提交失败');
  }

  // ---------- 重置 / 还原 ----------

  async reset(repoRoot: string, ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.assertOk(['reset', `--${mode}`, ref], repoRoot, '重置失败');
  }

  async revert(repoRoot: string, hash: string, noCommit = false): Promise<void> {
    const args = ['revert'];
    if (noCommit) args.push('--no-commit');
    args.push(hash);
    await this.assertOk(args, repoRoot, '还原失败');
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
    await this.assertOk(args, repoRoot, '保存 stash 失败');
  }

  async stashApply(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'apply', `stash@{${index}}`], repoRoot, '应用 stash 失败');
  }

  async stashPop(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'pop', `stash@{${index}}`], repoRoot, '恢复 stash 失败');
  }

  async stashDrop(repoRoot: string, index: number): Promise<void> {
    await this.assertOk(['stash', 'drop', `stash@{${index}}`], repoRoot, '删除 stash 失败');
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
        throw new Error('当前为 detached HEAD，无法拉取，请先在终端执行 git pull。');
      }
      const remote = await this.firstRemote(repoRoot);
      if (!remote) {
        throw new Error('仓库没有配置任何 remote，无法拉取。');
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
        this.cleanOutput(`${r.stdout}\n${r.stderr}`) || 'git pull 失败',
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
        throw new Error('当前为 detached HEAD，无法推送，请先在终端执行 git push。');
      }
      const remote = await this.firstRemote(repoRoot);
      if (!remote) {
        throw new Error('仓库没有配置任何 remote，无法推送。');
      }
      args.push('-u', remote, branch);
    }
    const r = await this.runner.run(args, {
      cwd: repoRoot,
      timeoutMs: BranchOps.NET_TIMEOUT,
    });
    if (r.code !== 0) {
      throw new GitRunnerError(this.cleanOutput(r.stderr) || 'git push 失败', r);
    }
    return r;
  }

  // ---------- 工具 ----------

  private async assertOk(args: string[], repoRoot: string, label: string): Promise<void> {
    const r = await this.runner.run(args, { cwd: repoRoot, timeoutMs: 120000 });
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
