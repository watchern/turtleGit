import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as i18n from '../i18n';

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  /** 标准输入内容（如 heredoc 场景） */
  input?: string;
  /** 覆盖可执行文件路径 */
  gitPath?: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout 原始字节（utf8 解码前的 Buffer）；二进制 blob 读取用 */
  stdoutRaw?: Buffer;
}

export class GitRunnerError extends Error {
  constructor(
    message: string,
    public readonly result?: GitRunResult
  ) {
    super(message);
    this.name = 'GitRunnerError';
  }
}

/**
 * git 可执行文件探测顺序：
 * 1. 用户配置 turtlegit.gitPath
 * 2. PATH 中的 git
 * 3. Windows 上：TortoiseGit 安装目录自带的 git.exe（仅复用其 git 可执行文件，
 *    不调用任何 TortoiseGit GUI 进程）、Git for Windows
 * 说明：本插件不依赖 TortoiseGit，Linux/macOS 上直接使用 PATH 中的 git。
 */
export function resolveGitExecutable(configured?: string): string {
  if (configured && configured.trim()) {
    return configured.trim();
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\TortoiseGit\\bin\\git.exe',
      'C:\\Program Files (x86)\\TortoiseGit\\bin\\git.exe',
      process.env['ProgramFiles']
        ? path.join(process.env['ProgramFiles'], 'Git', 'cmd', 'git.exe')
        : '',
      process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe')
        : '',
      process.env['LocalAppData']
        ? path.join(process.env['LocalAppData'], 'Programs', 'Git', 'cmd', 'git.exe')
        : '',
      path.join(os.homedir(), 'scoop', 'shims', 'git.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          return c;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return 'git';
}

/** 执行 git 命令。数组传参，无 shell，天然免疫路径注入。 */
export class GitRunner {
  constructor(private gitPath: string) {}

  async run(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
    return new Promise<GitRunResult>((resolve, reject) => {
      const exe = opts.gitPath ?? this.gitPath;
      const child = spawn(exe, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            // 子进程其实已经退出、只是 close 事件还在排队（机器负载极重时事件循环
            // 被饿死会出现这种情况）→ 不能算超时，否则会把一次成功完成的命令
            // （code 0 + 完整 stdout）误判成超时。已退出就放过，等 close 正常 resolve。
            if (child.exitCode !== null || child.signalCode !== null) return;
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : undefined;

      child.stdout.on('data', (d: Buffer) => stdout.push(d));
      child.stderr.on('data', (d: Buffer) => stderr.push(d));

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        reject(
          new GitRunnerError(
            i18n.t('git.cannotRun', exe, err.message),
          ),
        );
      });

      child.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        const raw = Buffer.concat(stdout);
        const result: GitRunResult = {
          code: code ?? (timedOut ? -1 : -1),
          stdout: raw.toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdoutRaw: raw,
        };
        // 退出码为 0 = 命令干净地跑完了（被 SIGKILL 的进程退出码不会是 0），
        // 即使因事件循环饿死被误标了 timedOut，也应按成功返回。
        if (timedOut && result.code !== 0) {
          reject(new GitRunnerError(i18n.t('git.timeout', args.join(' ')), result));
        } else {
          resolve(result);
        }
      });

      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    });
  }

  /** 执行并返回 stdout；退出码非 0 时抛错（stderr 作为错误信息）。 */
  async out(args: string[], opts: GitRunOptions): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0) {
      throw new GitRunnerError(
        (r.stderr.trim() || i18n.t('git.failedWithCode', args.join(' '), r.code)),
        r,
      );
    }
    return r.stdout;
  }

  /** 执行；退出码非 0 时返回 null（用于探测类命令）。 */
  async tryRun(args: string[], opts: GitRunOptions): Promise<GitRunResult | null> {
    try {
      const r = await this.run(args, opts);
      return r.code === 0 ? r : null;
    } catch {
      return null;
    }
  }
}
