import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/GitService';
import { relPathIn } from '../core/paths';
import { parseBlobParams } from '../core/blobUri';

/**
 * 自注册的 diff 内容 scheme（URI 构造见 ../core/blobUri.ts）。
 *
 * 为什么不复用内置 git 扩展的 `git:` scheme：该 scheme 的 FileSystemProvider
 * 由 `vscode.git` 扩展注册，而在 Trae CN 等把 `git.enabled` 设为 false 的
 * 环境里，该扩展激活直接失败（"Git model not found"），`git:` URI 无人解析，
 * `vscode.diff` 左侧输入解析失败即报「由于意外错误，无法打开编辑器」。
 * 自建 scheme 后，原生 diff 不再依赖任何内置 git 扩展的状态，行为跨环境一致。
 */

/** 原生 diff 左侧（历史/index 版本）内容提供器。
 * 以 FileSystemProvider 实现（与内置 git 扩展的 GitFileSystemProvider 同构）：
 * readFile 返回原始字节，编码检测交给编辑器，GBK 等非 UTF-8 文件不乱码。
 * 文件在指定 ref 不存在（如未跟踪文件没有 HEAD 版本）时按空内容处理——
 * diff 表现为「全部新增」，与预期一致。
 */
export class TgBlobProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly git: GitService) {}

  watch(): vscode.Disposable {
    // 静态内容：无需监听文件变化（mtime 每次取新值，编辑器侧缓存天然失效）
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const buf = await this.read(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: buf ? buf.length : 0,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const buf = await this.read(uri);
    return buf ?? new Uint8Array(0);
  }

  readDirectory(): never {
    throw new Error('TurtleGit: 目录读取不支持');
  }
  createDirectory(): never {
    throw new Error('TurtleGit: 只读 scheme');
  }
  writeFile(): never {
    throw new Error('TurtleGit: 只读 scheme');
  }
  delete(): never {
    throw new Error('TurtleGit: 只读 scheme');
  }
  rename(): never {
    throw new Error('TurtleGit: 只读 scheme');
  }

  /** 取 ref 版本内容；文件在该 ref 不存在时返回 null */
  private async read(uri: vscode.Uri): Promise<Buffer | null> {
    const params = parseBlobParams(uri.query);
    if (!params) return null;
    // root 缺失时回退探测（兼容手搓 URI）；探测失败则退到文件所在目录
    let repoRoot = params.root;
    if (!repoRoot) {
      repoRoot = (await this.git.repoRootOf(params.path)) ?? path.dirname(params.path);
    }
    const rel = relPathIn(repoRoot, params.path) ?? path.basename(params.path);
    return this.git.blobAtRef(repoRoot, rel, params.ref ?? '');
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
  }
}
