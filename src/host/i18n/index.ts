import * as vscode from 'vscode';
import { Locale, detectLocale, format, normalizeLocale } from './locales';
import { MESSAGES } from './messages';
import { toTraditional } from './s2t';

export { Locale, detectLocale, localeFromEnv, normalizeLocale, LOCALES } from './locales';
export { MESSAGES } from './messages';
export { toTraditional } from './s2t';

/** 当前界面语言（启动时由 `refreshLocale()` 初始化，设置变更时刷新） */
let current: Locale = 'en';

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale | string): void {
  // 允许直接传 zh-hans / zh-hant 等写法，内部统一收敛到规范值
  current = normalizeLocale(String(locale)) ?? 'en';
}

/**
 * 按「设置 `turtlegit.language` → VSCode 显示语言 → 英文」重新确定界面语言。
 * 返回是否发生变化（变了需要给已打开的面板推送新 init 让它们重挂载）。
 */
export function refreshLocale(): boolean {
  const setting = vscode.workspace.getConfiguration('turtlegit').get<string>('language');
  const next = detectLocale(setting, vscode.env.language);
  const changed = next !== current;
  current = next;
  return changed;
}

/** 取某 key 在当前语言下的原文（已含占位符替换） */
export function t(key: string, ...args: Array<string | number>): string {
  const entry = MESSAGES[key];
  // 漏译时直接返回 key：界面上会显示 `a.b.c`，一眼可发现，也避免整句消失
  if (!entry) return key;
  const raw = current === 'en' ? entry.en : current === 'zh-TW' ? toTraditional(entry.zh) : entry.zh;
  return args.length ? format(raw, args) : raw;
}

/** 指定语言的原文（用于构造给 webview 下发的字典） */
export function translate(key: string, locale: Locale): string {
  const entry = MESSAGES[key];
  if (!entry) return key;
  return locale === 'en' ? entry.en : locale === 'zh-TW' ? toTraditional(entry.zh) : entry.zh;
}

/** 当前语言的完整字典，随 WebviewInit 下发给 webview（只发一份，不塞三种语言） */
export function buildStrings(locale: Locale = current): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(MESSAGES)) out[key] = translate(key, locale);
  return out;
}
