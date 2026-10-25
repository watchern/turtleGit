import { FileStatus, StagedStatus, CommitInfo, CommitFile } from '../../../shared/protocol';
import { absPathIn } from '../core/paths';

/**
 * 把前端的日期预设（'24h' / '7d'）或任意日期串映射为 git `--since` 参数。
 * 预设之外的值原样透传（git 自身解析 ISO 日期 / "2 weeks ago" 等）。
 */
export function sinceArg(since: string): string {
  const s = since.trim();
  if (s === '24h') return '24 hours ago';
  if (s === '7d') return '7 days ago';
  return s;
}

/**
 * 解析 `git status --porcelain=v2 -z` 输出。
 * 条目格式（NUL 分隔）：
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> <origPath>
 *   ? <path>
 *   ! <path>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 */
export function parseStatus(output: string, repoRoot: string): FileStatus[] {
  const fields = output.split('\0');
  const files: FileStatus[] = [];
  let i = 0;

  const toStatus = (c: string): StagedStatus => {
    switch (c) {
      case 'M':
        return 'modified';
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'C':
        return 'copied';
      case 'T':
        return 'typechanged';
      case 'U':
        return 'conflicted';
      default:
        return 'none';
    }
  };

  while (i < fields.length) {
    const field = fields[i];
    if (!field) {
      i++;
      continue;
    }
    const head = field.charAt(0);
    if (head === '1' || head === '2' || head === 'u') {
      const parts = field.split(' ');
      if (head === '2') {
        // renamed/copied：后跟 path 与 origPath 两个 NUL 字段
        const pathStr = fields[i + 1] ?? '';
        const origStr = fields[i + 2] ?? '';
        i += 3;
        const xy = parts[1] ?? '..';
        files.push({
          path: pathStr,
          absPath: absPathIn(repoRoot, pathStr),
          index: toStatus(xy.charAt(0)),
          worktree: toStatus(xy.charAt(1)),
          origPath: origStr,
          untracked: false,
          ignored: false,
          conflicted: false,
        });
      } else {
        // 类型 1：`1 XY sub mH mI mW hH hI path`；类型 u：`u XY sub m1 m2 m3 mW h1 h2 h3 path`。
        // path 是固定前缀之后的所有内容（-z 模式下路径原样输出、不引号包裹，可含空格/中文），
        // 必须按前缀长度切片后 join 还原；取 split 最后一个分词会把空格路径截断（如只剩文件名）。
        const pathStr = parts.slice(head === 'u' ? 10 : 8).join(' ');
        i += 1;
        const xy = parts[1] ?? '..';
        const isUnmerged = head === 'u';
        files.push({
          path: pathStr,
          absPath: absPathIn(repoRoot, pathStr),
          index: isUnmerged ? 'conflicted' : toStatus(xy.charAt(0)),
          worktree: isUnmerged ? 'conflicted' : toStatus(xy.charAt(1)),
          untracked: false,
          ignored: false,
          conflicted: isUnmerged,
        });
      }
      continue;
    }
    if (head === '?') {
      const pathStr = field.slice(2);
      i += 1;
      files.push({
        path: pathStr,
        absPath: absPathIn(repoRoot, pathStr),
        index: 'none',
        worktree: 'none',
        untracked: true,
        ignored: false,
        conflicted: false,
      });
      continue;
    }
    if (head === '!') {
      const pathStr = field.slice(2);
      i += 1;
      files.push({
        path: pathStr,
        absPath: absPathIn(repoRoot, pathStr),
        index: 'none',
        worktree: 'none',
        untracked: false,
        ignored: true,
        conflicted: false,
      });
      continue;
    }
    i += 1;
  }
  return files;
}

/** git log 输出记录分隔符与字段分隔符（用户输入不会触达这些控制字符） */
const REC = '\u001e';
const FLD = '\u001f';

export function parseLog(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of output.split(REC)) {
    const trimmed = record.replace(/^\n/, '');
    if (!trimmed) continue;
    const f = trimmed.split(FLD);
    const refsRaw = f[8] ?? '';
    commits.push({
      hash: f[0] ?? '',
      shortHash: f[1] ?? '',
      parents: (f[2] ?? '').split(' ').filter(Boolean),
      author: f[3] ?? '',
      authorEmail: f[4] ?? '',
      authorDate: f[5] ?? '',
      subject: f[6] ?? '',
      body: f[7] ?? '',
      refs: refsRaw
        .split(', ')
        .map((r) => r.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

export function logFormat(): string {
  return [
    '%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%b', '%D',
  ].join(FLD) + REC;
}

/**
 * 解析 `git show --name-status -z` 输出，合并 --numstat 的统计数据。
 * 记录格式（NUL 分隔）：R100\0old\0new\0、M\0path\0、A\0path\0 …
 */
export function parseCommitFiles(
  output: string,
  numstat?: Map<string, { additions: number; deletions: number; isBinary: boolean }>,
): CommitFile[] {
  const parts = output.split('\0');
  const files: CommitFile[] = [];
  let i = 0;

  while (i < parts.length) {
    const p = parts[i];
    if (!p) {
      i++;
      continue;
    }
    const status = p.charAt(0);
    if ('AMDRCT'.includes(status) && p.length <= 3) {
      if (status === 'R' || status === 'C') {
        const oldPath = parts[i + 1] ?? '';
        const newPath = parts[i + 2] ?? '';
        i += 3;
        const stat = numstat?.get(newPath);
        files.push({
          path: newPath,
          oldPath,
          status: status as CommitFile['status'],
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          isBinary: stat?.isBinary ?? false,
        });
      } else {
        const pathStr = parts[i + 1] ?? '';
        i += 2;
        const stat = numstat?.get(pathStr);
        files.push({
          path: pathStr,
          status: status as CommitFile['status'],
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          isBinary: stat?.isBinary ?? false,
        });
      }
      continue;
    }
    i += 1;
  }
  return files;
}


/** 签署人身份解析结果（对应 `Signed-off-by: 姓名 <邮箱>`） */
export interface SignOffIdentity {
  name: string;
  email: string;
}

/**
 * 解析用户填写的签署人，接受三种写法：
 *   "张三 <zhangsan@example.com>"  → { name: '张三', email: 'zhangsan@example.com' }
 *   "张三"                          → { name: '张三', email: '' }（邮箱沿用仓库配置）
 *   "zhangsan@example.com"         → { name: '', email: '...' }（姓名沿用仓库配置）
 * 空白输入返回 null（调用方退回 `git commit -s` 的默认身份）。
 */
export function parseSignOffIdentity(text: string): SignOffIdentity | null {
  const s = (text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return null;
  const m = /^(.*?)\s*<([^<>]*)>\s*$/.exec(s);
  if (m) {
    const name = m[1].trim();
    const email = m[2].trim();
    return name || email ? { name, email } : null;
  }
  // 纯邮箱：只覆盖 email
  if (/^[^\s<>"']+@[^\s<>"']+$/.test(s)) return { name: '', email: s };
  // 其余按姓名处理（去掉可能残留的尖括号，避免注入 git 配置值）
  const name = s.replace(/[<>]/g, '').trim();
  return name ? { name, email: '' } : null;
}
