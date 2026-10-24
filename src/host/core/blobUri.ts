/**
 * turtlegit: diff 内容 URI 的参数构造/解析（无 vscode 依赖，便于测试）。
 *
 * URI 由 `vscode.Uri.file(abs).with({ scheme, query })` 拼装——与内置 git 扩展
 * toGitUri 完全一致（不用 Uri.parse 拼字符串：路径里的 `#`/`?` 会被误判为
 * fragment/query 边界）。query 承载 JSON 参数，读取侧 JSON.parse(uri.query) 即可。
 */

/** 自注册的 diff 内容 scheme（不依赖内置 git 扩展的 git: scheme） */
export const TGIT_BLOB_SCHEME = 'turtlegit';

/** turtlegit: URI 的 query 参数 */
export interface BlobParams {
  /** 文件绝对路径 */
  path: string;
  /** ref：'' 表示 index（暂存）版本 */
  ref: string;
  /** 仓库根（绝对路径） */
  root: string;
}

/** 构造 query 参数对象 */
export function blobUriParams(abs: string, ref: string, repoRoot: string): BlobParams {
  return { path: abs, ref, root: repoRoot };
}

/** 构造 query 字符串（原样 JSON：Uri.with 存入、uri.query 取回即可 JSON.parse） */
export function blobUriQuery(abs: string, ref: string, repoRoot: string): string {
  return JSON.stringify(blobUriParams(abs, ref, repoRoot));
}

/** 解析 query 为参数；格式非法或字段缺失时返回 null */
export function parseBlobParams(query: string): BlobParams | null {
  try {
    const params = JSON.parse(query) as BlobParams;
    if (params && typeof params.path === 'string' && typeof params.root === 'string') {
      return params;
    }
  } catch {
    /* 非本扩展构造的 URI */
  }
  return null;
}
