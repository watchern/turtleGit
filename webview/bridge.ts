import type { RpcEvents, RpcRequestType, RpcRequests } from '../shared/protocol';

type Handler<K extends keyof RpcEvents> = (payload: RpcEvents[K]) => void;

/**
 * Webview 侧 RPC 客户端：请求-响应配对 + 事件订阅。
 * 通过 postMessage 与宿主层通信，不直接依赖 vscode 对象。
 */
export class RpcClient {
  private seq = 1;
  private pending = new Map<
    number,
    { resolve: (v: never) => void; reject: (e: Error) => void }
  >();
  private handlers = new Map<string, Set<(p: unknown) => void>>();

  constructor(private post: (msg: unknown) => void) {}

  send<K extends RpcRequestType>(
    type: K,
    payload: RpcRequests[K]['req'],
  ): Promise<RpcRequests[K]['res']> {
    const id = this.seq++;
    this.post({ kind: 'request', id, type, payload: payload ?? {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
      });
    });
  }

  /** 发送宿主侧命令（无响应） */
  command(type: string, payload?: Record<string, unknown>): void {
    this.post({ kind: 'command', type, payload: payload ?? {} });
  }

  on<K extends keyof RpcEvents>(event: K, handler: Handler<K>): void;
  on(event: string, handler: (payload: never) => void): void;
  on(event: string, handler: (payload: never) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (p: unknown) => void);
  }

  /** 取消单个事件订阅 */
  off(event: string, handler: (payload: never) => void): void {
    this.handlers.get(event)?.delete(handler as (p: unknown) => void);
  }

  /**
   * 清空所有事件订阅（重挂载视图前调用，避免上一视图的监听器在 DOM 被销毁后
   * 仍被触发导致报错）。`except` 中的事件（如 init）会保留。
   */
  clearHandlers(except: string[] = []): void {
    if (!except.length) {
      this.handlers.clear();
      return;
    }
    for (const key of [...this.handlers.keys()]) {
      if (!except.includes(key)) this.handlers.delete(key);
    }
  }

  handleMessage(msg: unknown): void {
    const m = msg as { kind?: string; id?: number; ok?: boolean; payload?: unknown; type?: string; error?: string };
    if (m?.kind === 'response') {
      const p = this.pending.get(m.id as number);
      if (p) {
        this.pending.delete(m.id as number);
        if (m.ok) {
          p.resolve(m.payload as never);
        } else {
          p.reject(new Error(m.error ?? 'RPC 失败'));
        }
      }
      return;
    }
    if (m?.kind === 'event' && m.type) {
      this.handlers.get(m.type)?.forEach((cb) => cb(m.payload));
    }
  }
}

/** 解析 data-params 中的 base64url JSON 初始化参数 */
export function decodeParams(raw: string): Record<string, unknown> {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
