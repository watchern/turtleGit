import type { RpcRequestEnvelope, RpcResponseEnvelope, RpcRequests } from '../../../shared/protocol';
import * as i18n from '../i18n';

export type RpcHandler<K extends keyof RpcRequests> = (
  payload: RpcRequests[K]['req'],
) => Promise<RpcRequests[K]['res']> | RpcRequests[K]['res'];

/**
 * Webview RPC 服务端：按请求类型分发到 handler，回包带 id 与错误信息。
 */
export class RpcRouter {
  private handlers = new Map<string, RpcHandler<keyof RpcRequests>>();

  register<K extends keyof RpcRequests>(type: K, handler: RpcHandler<K>): void {
    this.handlers.set(type as string, handler as unknown as RpcHandler<keyof RpcRequests>);
  }

  async handle(msg: RpcRequestEnvelope): Promise<RpcResponseEnvelope> {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      return {
        kind: 'response',
        id: msg.id,
        ok: false,
        error: i18n.t('rpc.unknownType', msg.type),
      };
    }
    try {
      const payload = await handler(msg.payload as never);
      return { kind: 'response', id: msg.id, ok: true, payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'response', id: msg.id, ok: false, error: message };
    }
  }
}
