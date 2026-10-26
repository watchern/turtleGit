import * as path from 'path';
import * as fs from 'fs';
import { GitRunner, GitRunnerError } from './GitRunner';
import { parseStatus, parseLog, parseCommitFiles, logFormat, parseSignOffIdentity, sinceArg } from './parsers';
import { normalizeFsPath, absPathIn } from '../core/paths';
import {
  BranchInfo,
  CommitFile,
  CommitInfo,
  CommitRequest,
  CommitResult,
  FileNumstat,
  FileStatus,
  GitIdentity,
  LogQuery,
  RepoInfo,
} from '../../../shared/protocol';

/** git 仓库高层操作。所有命令经 GitRunner 执行，路径以数组传参防注入。 */
export class GitService {
  constructor(private runner: GitRunner) {}

  // ---------- 仓库发现 ----------

  async listRepos(): Promise<RepoInfo[]> {
    // 多根工作区的仓库发现由 RepositoryStore 遍历 workspaceFolders 完成
    return [];
  }

  async repoRootOf(fsPath: string): Promise<string | null> {
    const r = await this.runner.tryRun(['rev-parse', '--show-toplevel'], {
      cwd: fsPath,
      // 同 rev-parse HEAD：慢环境偶发超 8s，放宽到 15s（失败仅意味着非 git 仓库，不影响其他）
      timeoutMs: 15000,
    });
    if (!r) {
      return null;
    }
    return normalizeFsPath(r.stdout.trim());
  }

  async repoName(root: string): Promise<string> {
    const r = await this.runner.tryRun(['config', '--get', 'remote.origin.url'], {
      cwd: root,
      timeoutMs: 8000,
    });
    if (r?.stdout.trim()) {
      const url = r.stdout.trim();
      const m = /([^/:]+?)(\.git)?\/?$/.exec(url);
      if (m) return m[1];
    }
    const base = path.basename(normalizeFsPath(root));
    return base || root;
  }

  // ---------- 状态 ----------

  async status(
    repoRoot: string,
    opts: { ignoredExcludeDirs?: string[] } = {},
  ): Promise<FileStatus[]> {
    // --ignored=matching：拉取忽略文件，同时把忽略目录折叠为单条（git 2.55 实测：
    // -uall --ignored 会把 node_modules 每个文件单列，--ignored=matching 则输出 `! build/`
    // 单条，显式匹配的忽略文件仍单列，未跟踪目录正常展开）。
    // 侧边栏「忽略文件」复选框只在本地过滤（visibleFiles），数据里必须始终包含忽略文件，
    // 否则勾选后无数据可显示。
    const out = await this.runner.out(['status', '--porcelain=v2', '-z', '-uall', '--ignored=matching'], {
      cwd: repoRoot,
      timeoutMs: 20000,
    });
    const files = parseStatus(out, repoRoot);
    await expandIgnoredDirs(repoRoot, files, opts.ignoredExcludeDirs ?? []);
    return files;
  }

  async stage(repoRoot: string, paths: string[]): Promise<void> {
    await this.runner.out(['add', '-A', '--', ...paths], { cwd: repoRoot });
  }

  async unstage(repoRoot: string, paths: string[]): Promise<void> {
    await this.runner.out(['restore', '--staged', '--', ...paths], { cwd: repoRoot });
  }

  /** 放弃工作区修改（TortoiseGit 的 Revert） */
  async discard(repoRoot: string, paths: string[]): Promise<void> {
    // 已暂存的新增/删除需先取消暂存，再 checkout
    await this.unstage(repoRoot, paths);
    await this.runner.out(['checkout', '--', ...paths], { cwd: repoRoot });
    // 未跟踪文件：删除
    await this.runner.run(['clean', '-f', '--', ...paths], { cwd: repoRoot });
  }

  /**
   * 追加到忽略列表。
   * - `target`: `gitignore` = 仓库根 `.gitignore`（随仓库提交）；`exclude` = `.git/info/exclude`（仅本地，不入库）
   * - `mode`: 目录路径下 `dir` = 整目录写一条 `dir/`；`files` = 遍历目录下所有文件逐条写入
   * - 追加前补换行（原实现直接 append，文件末尾无换行时会与最后一行粘在一起）；已存在的条目跳过
   */
  async addToGitIgnore(
    repoRoot: string,
    paths: string[],
    opts: { target?: 'gitignore' | 'exclude'; mode?: 'dir' | 'files' } = {},
  ): Promise<void> {
    const { appendFile, readFile, mkdir } = await import('fs/promises');
    const target = opts.target ?? 'gitignore';
    const ignorePath =
      target === 'exclude'
        ? path.join(repoRoot, '.git', 'info', 'exclude')
        : path.join(repoRoot, '.gitignore');

    const entries: string[] = [];
    for (const p of paths) {
      const rel = p.replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!rel) continue;
      const abs = path.join(repoRoot, rel);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir && opts.mode === 'files') {
        for (const f of listFilesRecursive(abs, repoRoot)) entries.push(`/${f}`);
      } else if (isDir) {
        entries.push(`/${rel}/`);
      } else {
        entries.push(`/${rel}`);
      }
    }
    if (!entries.length) return;

    if (target === 'exclude') {
      await mkdir(path.dirname(ignorePath), { recursive: true });
    }
    let existing = '';
    try {
      existing = await readFile(ignorePath, 'utf8');
    } catch {
      existing = '';
    }
    const have = new Set(
      existing
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    );
    const add = entries.filter((e) => !have.has(e.replace(/\/+$/, '')));
    if (!add.length) return;
    // 文件末尾没有换行时先补一个，避免新条目粘在最后一行后面
    const prefix = existing && !/(\r?\n)$/.test(existing) ? '\n' : '';
    await appendFile(ignorePath, prefix + add.join('\n') + '\n', 'utf8');
  }

  /**
   * 每个文件的增删行数统计（提交对话框文件列表展示用）。
   * - 已跟踪文件：`git diff HEAD --numstat`（HEAD ↔ 工作区，暂存与未暂存合计）；
   * - 未跟踪文件：读取文件内容按新增行计数（二进制计 0）。
   * 空仓库（无 HEAD）时已跟踪部分为空，仅统计未跟踪文件。
   */
  async numstat(repoRoot: string): Promise<FileNumstat[]> {
    const out: FileNumstat[] = [];
    const seen = new Set<string>();
    const put = (path: string, additions: number, deletions: number): void => {
      if (seen.has(path)) return;
      seen.add(path);
      out.push({ path, additions, deletions });
    };
    try {
      const raw = await this.runner.out(
        ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--numstat', '--no-renames'],
        { cwd: repoRoot, timeoutMs: 20000 },
      );
      for (const line of raw.split(/\r?\n/)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line.trim());
        if (!m) continue;
        put(m[3], m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2]));
      }
    } catch {
      /* 空仓库无 HEAD：无已跟踪差异 */
    }
    // 未跟踪文件：全部计为新增行（二进制文件计 0）
    try {
      const raw = await this.runner.out(['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: repoRoot,
        timeoutMs: 20000,
      });
      for (const p of raw.split('\0')) {
        if (!p) continue;
        let additions = 0;
        try {
          const buf = fs.readFileSync(absPathIn(repoRoot, p));
          if (!buf.includes(0)) {
            const lines = buf.toString('utf8').split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            additions = lines.length;
          }
        } catch {
          /* 读取失败：计 0 */
        }
        put(p, additions, 0);
      }
    } catch {
      /* 忽略 */
    }
    return out;
  }

  // ---------- Diff ----------

  async diffPatch(
    repoRoot: string,
    filePath: string,
    staged: boolean,
    against?: string,
    range?: string,
  ): Promise<string> {
    const args = ['diff', '--no-color', '-U3'];
    if (staged) args.push('--cached');
    if (range) args.push(range);
    else if (against) args.push(against);
    args.push('--', filePath);
    return this.runner.out(args, { cwd: repoRoot, timeoutMs: 30000 });
  }

  /**
   * 未版本控制（未跟踪）文件的差异 patch：内容全部为新增。
   * 自构造标准 unified patch——不依赖 `git diff --no-index`（Windows 上
   * NUL 设备路径不可达，实测报错且 stdout 为空），跨平台行为确定。
   */
  untrackedPatch(repoRoot: string, relPath: string): string {
    const abs = absPathIn(repoRoot, relPath);
    const buf = fs.readFileSync(abs);
    const header = [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      'index 0000000..0000000',
      '--- /dev/null',
      `+++ b/${relPath}`,
    ].join('\n');
    // 二进制文件：git 风格提示，不输出内容行
    if (buf.includes(0)) {
      return `${header}\nBinary files /dev/null and b/${relPath} differ\n`;
    }
    const content = buf.toString('utf8');
    const hadTrailingNewline = content.endsWith('\n');
    const lines = content.split(/\r?\n/);
    if (hadTrailingNewline) lines.pop();
    // 空文件（'' → ['']）：无 hunk 内容（与 git 行为一致，渲染侧显示无差异）
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      return `${header}\n@@ -0,0 +0,0 @@\n`;
    }
    const body = lines.map((l) => `+${l}`).join('\n');
    const noNewline = hadTrailingNewline ? '' : '\\ No newline at end of file';
    return `${header}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${noNewline}\n`.replace(/\n\n$/, '\n');
  }

  /**
   * 取指定 ref 版本的文件原始字节（原生 diff 左侧内容提供器用）。
   * ref 传 '' 表示 index（暂存）版本；文件在该 ref 不存在时返回 null
   * （如未跟踪文件没有 HEAD 版本——此时 diff 左侧视为空内容）。
   * 返回原始 Buffer：编码检测交给编辑器（GBK 等非 UTF-8 文件不乱码）。
   */
  async blobAtRef(repoRoot: string, relPath: string, ref: string): Promise<Buffer | null> {
    // `<ref>:<path>` 取提交内版本，`:<path>` 取 index 暂存版本
    const rev = ref ? `${ref}:${relPath}` : `:${relPath}`;
    const r = await this.runner.run(['cat-file', 'blob', rev], {
      cwd: repoRoot,
      timeoutMs: 30000,
    });
    return r.code === 0 ? r.stdoutRaw ?? Buffer.alloc(0) : null;
  }

  /**
   * 取 diff 某一侧的完整文件内容：
   * side='old'：基准侧内容（range 的左 ref / against / HEAD）；
   * side='new'：range 的右 ref，否则 staged 取 index、非 staged 取工作区文件。
   */
  private async sideContent(
    repoRoot: string,
    filePath: string,
    side: 'old' | 'new',
    opts: { staged?: boolean; against?: string; range?: string },
  ): Promise<string> {
    if (opts.range) {
      const [l, r] = opts.range.split('..');
      const ref = side === 'old' ? l : r;
      return this.runner.out(['show', `${ref}:${filePath}`], { cwd: repoRoot, timeoutMs: 30000 });
    }
    if (side === 'old') {
      const ref = opts.against ?? 'HEAD';
      return this.runner.out(['show', `${ref}:${filePath}`], { cwd: repoRoot, timeoutMs: 30000 });
    }
    if (opts.staged) {
      return this.runner.out(['show', `:${filePath}`], { cwd: repoRoot, timeoutMs: 30000 });
    }
    return fs.readFileSync(absPathIn(repoRoot, filePath), 'utf8');
  }

  /** 行数归一化：按行 split 后去掉文件末尾换行产生的空元素（与 contextLines 一致） */
  private static countLines(content: string): number {
    const lines = content.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  /**
   * 统计 diff 两侧文件的总行数（渲染「末尾折叠 gap」用）。
   * 最后一个 hunk 之后到 EOF 的省略行不在 patch 里，渲染侧需要知道两侧
   * 总行数才能补出这个可展开的 gap。某侧文件不存在（如新增/删除文件）
   * 或读取失败时该侧计 0——调用方据此不生成 gap。
   */
  async fileLineCounts(
    repoRoot: string,
    filePath: string,
    opts: { staged?: boolean; against?: string; range?: string } = {},
  ): Promise<{ old: number; new: number }> {
    const [oldR, newR] = await Promise.all([
      this.sideContent(repoRoot, filePath, 'old', opts).then(
        (c) => GitService.countLines(c),
        () => 0,
      ),
      this.sideContent(repoRoot, filePath, 'new', opts).then(
        (c) => GitService.countLines(c),
        () => 0,
      ),
    ]);
    return { old: oldR, new: newR };
  }

  /**
   * 读取 diff 中被省略的上下文行（gap 折叠行展开用）。
   * side='old'：基准侧内容（range 的左 ref / against / HEAD）；
   * side='new'：range 的右 ref，否则 staged 取 index、非 staged 取工作区文件。
   * 行号为 1 基，含端点。
   */
  async contextLines(
    repoRoot: string,
    filePath: string,
    side: 'old' | 'new',
    start: number,
    end: number,
    opts: { staged?: boolean; against?: string; range?: string } = {},
  ): Promise<string[]> {
    const content = await this.sideContent(repoRoot, filePath, side, opts);
    const lines = content.split(/\r?\n/);
    // 文件以换行结尾时 split 多出一个末尾空元素，去掉
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(start - 1, end);
  }

  // ---------- 提交 ----------

  /**
   * 读取 git 身份（user.name / user.email）。
   * 未配置时返回空串（不抛错）——调用方用它给「签署人」输入框填默认值。
   */
  async identity(repoRoot: string): Promise<GitIdentity> {
    const [nameR, emailR] = await Promise.all([
      this.runner.run(['config', 'user.name'], { cwd: repoRoot, timeoutMs: 10000 }),
      this.runner.run(['config', 'user.email'], { cwd: repoRoot, timeoutMs: 10000 }),
    ]);
    return {
      name: nameR.code === 0 ? nameR.stdout.trim() : '',
      email: emailR.code === 0 ? emailR.stdout.trim() : '',
    };
  }

  async commit(req: CommitRequest): Promise<CommitResult> {
    const { repoRoot, message, files, amend, signOff, noVerify, signOffName } = req;

    if (files && files.length > 0) {
      // 勾选子集提交（复刻 TortoiseGit 部分提交）：
      // 未跟踪文件需先 add；git commit -- <paths> 只提交这些路径的工作区版本
      const st = await this.status(repoRoot);
      const untracked = files.filter((f) => st.find((s) => s.path === f)?.untracked);
      if (untracked.length > 0) {
        await this.runner.out(['add', '--', ...untracked], { cwd: repoRoot });
      }
    }

    // 签署：默认 `git commit -s`（用 git 自己的身份）；填了签署人时改用
    // `-c user.name/-c user.email` 覆盖本次身份——仓库没配 user.email 也能完成签署。
    const pre: string[] = [];
    if (signOff) {
      const ident = signOffName ? parseSignOffIdentity(signOffName) : null;
      if (ident?.name) pre.push('-c', `user.name=${ident.name}`);
      if (ident?.email) pre.push('-c', `user.email=${ident.email}`);
    }
    const args = [...pre, 'commit'];
    if (amend) args.push('--amend');
    if (signOff) args.push('-s');
    if (noVerify) args.push('--no-verify');
    args.push('-m', message);
    if (files && files.length > 0) {
      args.push('--', ...files);
    }
    const r = await this.runner.run(args, { cwd: repoRoot, timeoutMs: 120000 });
    if (r.code !== 0) {
      // 过滤 LF/CRLF 等 warning 行，只保留真正的错误信息
      const message =
        r.stderr
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^warning:/i.test(l.trim()))
          .join('\n')
          .trim() || '提交失败';
      throw new GitRunnerError(message, r);
    }
    const head = await this.runner.out(['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      // rev-parse 本身是瞬时命令，但慢磁盘/网络盘/重负载机器上 git 进程
      // 启动与退出偶尔会超过 10s，放宽到 30s 避免误杀（已实测出 hash 后被 SIGKILL）。
      timeoutMs: 30000,
    });
    return { hash: head.trim() };
  }

  // ---------- 日志 ----------

  async log(query: LogQuery): Promise<CommitInfo[]> {
    const args = ['log', `--pretty=format:${logFormat()}`, '--date-order', '--topo-order'];
    args.push('-n', String((query.skip ?? 0) + (query.limit ?? 100)));
    if (query.skip && query.skip > 0) args.push('--skip', String(query.skip));
    // 指定分支时用位置参数 ref（--all 与 ref 同时给会取并集，不是过滤）
    if (query.branch) args.push(query.branch);
    else if (query.all) args.push('--all');
    if (query.since) args.push(`--since=${sinceArg(query.since)}`);
    if (query.author) args.push(`--author=${query.author}`);
    if (query.grep) args.push(`--grep=${query.grep}`, '-i');
    if (query.noMerges) args.push('--no-merges');
    if (query.path) args.push('--', query.path);
    const out = await this.runner.out(args, {
      cwd: query.repoRoot,
      timeoutMs: 60000,
    });
    return parseLog(out);
  }

  async commitFiles(repoRoot: string, hash: string): Promise<CommitFile[]> {
    // 注意：--numstat 与 --name-status -z 混用时 git 会丢弃 numstat 段，
    // 因此分两次调用再合并。
    const [nameStatusOut, numstatOut] = await Promise.all([
      this.runner.out(['show', '--name-status', '-z', '--format=', hash], {
        cwd: repoRoot,
        timeoutMs: 30000,
      }),
      this.runner.out(['show', '--numstat', '--format=', hash], {
        cwd: repoRoot,
        timeoutMs: 30000,
      }),
    ]);
    const numstat = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
    for (const line of numstatOut.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (m) {
        numstat.set(m[3].replace(/^"|"$/g, ''), {
          additions: m[1] === '-' ? 0 : Number(m[1]),
          deletions: m[2] === '-' ? 0 : Number(m[2]),
          isBinary: m[1] === '-',
        });
      }
    }
    return parseCommitFiles(nameStatusOut, numstat);
  }

  /**
   * 两个引用之间（range，如 `A..B`）的变更文件列表（分支对比：「与当前分支对比」）。
   * 与 commitFiles 同构：--numstat 与 --name-status -z 分两次调用再合并。
   */
  async rangeFiles(repoRoot: string, range: string): Promise<CommitFile[]> {
    const [nameStatusOut, numstatOut] = await Promise.all([
      this.runner.out(['diff', '--name-status', '-z', range], {
        cwd: repoRoot,
        timeoutMs: 30000,
      }),
      this.runner.out(['diff', '--numstat', range], {
        cwd: repoRoot,
        timeoutMs: 30000,
      }),
    ]);
    const numstat = new Map<string, { additions: number; deletions: number; isBinary: boolean }>();
    for (const line of numstatOut.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      numstat.set(m[3].replace(/^"|"$/g, ''), {
        additions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
        isBinary: m[1] === '-',
      });
    }
    return parseCommitFiles(nameStatusOut, numstat);
  }

  // ---------- 分支信息 ----------

  async branchInfo(repoRoot: string): Promise<BranchInfo> {
    const [symbolic, headRef, upstream, counts, stateDir] = await Promise.all([
      this.runner.tryRun(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot }),
      this.runner.tryRun(['rev-parse', 'HEAD'], { cwd: repoRoot }),
      this.runner
        .tryRun(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: repoRoot })
        .catch(() => null),
      this.runner
        .tryRun(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], {
          cwd: repoRoot,
        })
        .catch(() => null),
      this.detectState(repoRoot),
    ]);

    const detached = !symbolic;
    const name = detached
      ? (headRef?.stdout.trim().slice(0, 7) || 'HEAD')
      : (symbolic?.stdout.trim().replace('refs/heads/', '') ?? 'HEAD');

    let ahead = 0;
    let behind = 0;
    if (counts?.stdout.trim()) {
      const [l, r] = counts.stdout.trim().split(/\s+/);
      ahead = Number(l) || 0;
      behind = Number(r) || 0;
    }

    return {
      name,
      upstream: upstream?.stdout.trim() || undefined,
      ahead,
      behind,
      detached,
      state: stateDir,
    };
  }

  private async detectState(repoRoot: string): Promise<BranchInfo['state']> {
    const fs = await import('fs');
    const path = await import('path');
    const check = (p: string) => {
      try {
        return fs.existsSync(path.join(repoRoot, '.git', p));
      } catch {
        return false;
      }
    };
    if (check('MERGE_HEAD')) return 'merging';
    if (check('rebase-merge') || check('rebase-apply')) return 'rebasing';
    if (check('CHERRY_PICK_HEAD')) return 'cherry-picking';
    if (check('REVERT_HEAD')) return 'reverting';
    if (check('BISECT_LOG')) return 'bisecting';
    return 'clean';
  }
}


/** 递归列出目录下的文件（仓库相对路径，正斜杠），跳过 .git 等版本控制目录 */
function listFilesRecursive(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.svn') continue;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..')) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 忽略目录展开上限：`--ignored=matching` 把忽略目录折叠为单条（`! dir/`），
 * 目录里的文件（.vscode/、.claude/ 等）因此不可见。这里把折叠目录展开为逐个
 * 忽略文件；超过上限的巨型目录（node_modules）保持折叠，且遍历提前中止。
 */
export const IGNORED_DIR_EXPAND_LIMIT = 500;

/**
 * 构造忽略目录排除匹配器：按目录名或仓库相对路径匹配（win32 大小写不敏感），
 * 用于「忽略文件」视图里排除 .history、node_modules 等文件夹（设置
 * turtlegit.ignoredExcludeDirs）。空名单返回恒假匹配器。
 */
function makeExcludeMatcher(dirs: string[]): (relPath: string) => boolean {
  const set = new Set<string>();
  const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  for (const d of dirs) {
    const p = d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (p) set.add(norm(p));
  }
  if (set.size === 0) return () => false;
  return (relPath: string) => {
    const p = relPath.replace(/\/+$/, '');
    const base = p.split('/').pop() ?? p;
    return set.has(norm(p)) || set.has(norm(base));
  };
}

/**
 * 把 status 结果里的忽略目录条目（`! dir/`，路径以 / 结尾）原地展开为目录下
 * 逐个忽略文件。目录被忽略时其内容按 git 语义同样视为忽略，无需再跑 ignore 匹配。
 * excludeDirs 命中的文件夹直接剔除（不展开、不显示），遍历时同样跳过。
 */
async function expandIgnoredDirs(
  repoRoot: string,
  files: FileStatus[],
  excludeDirs: string[],
): Promise<void> {
  const excluded = makeExcludeMatcher(excludeDirs);
  const out: FileStatus[] = [];
  let changed = false;
  for (const f of files) {
    if (!f.ignored || !f.path.endsWith('/')) {
      out.push(f);
      continue;
    }
    if (excluded(f.path)) {
      // 排除名单内的文件夹：整条剔除
      changed = true;
      continue;
    }
    const inner = await walkIgnoredDir(
      repoRoot,
      f.path.slice(0, -1),
      IGNORED_DIR_EXPAND_LIMIT,
      excluded,
    );
    if (inner === null || inner.length === 0) {
      out.push(f); // 超上限或空目录：保持折叠单条
      continue;
    }
    changed = true;
    for (const rel of inner) {
      out.push({
        path: rel,
        absPath: absPathIn(repoRoot, rel),
        index: 'none',
        worktree: 'none',
        untracked: false,
        ignored: true,
        conflicted: false,
      });
    }
  }
  if (!changed) return; // 无忽略目录条目或全部保持折叠：无需替换
  files.length = 0;
  for (const f of out) files.push(f);
}

/**
 * 异步遍历忽略目录，返回仓库相对文件路径（排序）；超过 limit 返回 null（提前中止，
 * 不为 node_modules 这类巨型目录付出全量遍历代价）。跳过 .git/.svn、符号链接目录
 * 与排除名单命中的条目（目录不进栈、文件不列出）。
 */
async function walkIgnoredDir(
  repoRoot: string,
  dir: string,
  limit: number,
  excluded: (relPath: string) => boolean,
): Promise<string[] | null> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absPathIn(repoRoot, cur), { withFileTypes: true });
    } catch {
      continue; // 目录不存在或无权限：跳过
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.svn') continue;
      const rel = cur ? `${cur}/${e.name}` : e.name;
      if (excluded(rel)) continue;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile() || e.isSymbolicLink()) {
        out.push(rel);
        if (out.length > limit) return null;
      }
    }
  }
  return out.sort();
}
