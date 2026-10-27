/**
 * Webview 侧国际化。
 *
 * 宿主按语言把**当前语言的整份字典**随 `WebviewInit.strings` 下发（只发一份，
 * 不把三种语言都打进 webview），这里只做查表与占位符替换：
 *
 *   import { t } from '../i18n';
 *   el.textContent = t('commit.btn.commit');
 *   toast(t('branches.deleted', name));   // {0} → name
 *
 * 漏译时返回 key 本身（而不是空串）：界面上会直接暴露 `xxx.yyy` 这类 key，
 * 便于一眼发现未翻译文案，也避免整句消失。
 */

let dict: Record<string, string> = {};

/** 由 main.ts 在挂载面板前调用（每次收到新 init 都会重新注入） */
export function setStrings(strings: Record<string, string> | undefined): void {
  dict = strings ?? {};
}

/** 取某 key 的原文（无占位符版本，用于比较/拼接） */
export function raw(key: string): string {
  return dict[key] ?? key;
}

/** 翻译；`{0}` `{1}` … 依次替换为后续参数 */
export function t(key: string, ...args: Array<string | number>): string {
  const s = dict[key];
  if (s === undefined) return key;
  if (!args.length) return s;
  return s.replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}
