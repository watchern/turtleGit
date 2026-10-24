/**
 * Webview 状态持久化。
 *
 * 封装 acquireVsCodeApi 的 getState/setState：状态由扩展宿主按 webview 持有，
 * 在 webview 重载后依然保留。典型场景：面板在浮动窗口与主窗口之间移动时，
 * webview 内容会重载，用户已输入的提交信息/勾选状态需要恢复。
 */

export interface WebviewStateApi {
  getState(): unknown;
  setState(state: unknown): void;
}

let api: WebviewStateApi | undefined;

/** 由入口（main.ts）在 acquireVsCodeApi 后调用一次 */
export function bindWebviewState(a: WebviewStateApi): void {
  api = a;
}

export function loadState<T>(): T | undefined {
  try {
    return api?.getState() as T | undefined;
  } catch {
    return undefined;
  }
}

export function saveState(state: unknown): void {
  try {
    api?.setState(state);
  } catch {
    /* 持久化失败不影响主流程 */
  }
}
