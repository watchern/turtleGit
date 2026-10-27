/**
 * 界面语言。
 *
 * 只支持三种：简体中文、繁体中文、英文——**其他语种一律展示英文**
 * （VSCode 显示语言可能是德/法/日/韩等，逐个维护译文不现实，统一回落英文）。
 *
 * 语言选择优先级：
 *   ① 设置 `turtlegit.language`（auto / zh-CN / zh-TW / en）
 *   ② `vscode.env.language`（VSCode 显示语言，装了中文/繁体语言包即为 zh-cn / zh-tw）
 *   ③ 英文
 *
 * 语言标识同时接受两套写法（BCP-47 与 VSCode 自身 ID），最终收敛到内部规范值：
 *   简体：zh-Hans / zh-hans / zh-Hans-CN / zh-cn / zh-sg / zh
 *   繁体：zh-Hant / zh-hant / zh-Hant-TW / zh-tw / zh-hk / zh-mo
 *   英文：en / en-US …
 */
export type Locale = 'zh-CN' | 'zh-TW' | 'en';

/** 设置项取值（多了「跟随 VSCode」一项） */
export type LocaleSetting = 'auto' | Locale;

export const LOCALES: Locale[] = ['zh-CN', 'zh-TW', 'en'];

/** 字典条目：只需维护英文与**简体**，繁体由字符映射在运行时转换 */
export interface MessageEntry {
  en: string;
  zh: string;
}

/**
 * 规范化语言标识：把 zh-hans / zh-Hant / zh-cn / zh-tw 等各种写法统一成
 * 内部规范值 zh-CN / zh-TW / en；无法识别时返回 undefined（调用方按 auto 处理）。
 *
 * 放在这里而不是只在 detectLocale 里判断，是为了让**设置项**和
 * `vscode.env.language` 走同一套规则——否则手写 settings.json 写
 * `zh-hans` 会被当成非法值静默回落到 auto，看起来像"设置没生效"。
 */
export function normalizeLocale(value: string | undefined): Locale | undefined {
  if (!value) return undefined;
  const l = value.trim().toLowerCase().replace(/_/g, '-');
  if (!l) return undefined;
  if (l === 'en' || l.startsWith('en-')) return 'en';
  // 简体：zh / zh-cn / zh-sg / zh-hans / zh-hans-cn / zh-hans-sg …
  if (l === 'zh' || l === 'zh-cn' || l === 'zh-sg' || l.startsWith('zh-hans')) return 'zh-CN';
  // 繁体：zh-tw / zh-hk / zh-mo / zh-hant / zh-hant-tw …
  if (l === 'zh-tw' || l === 'zh-hk' || l === 'zh-mo' || l.startsWith('zh-hant')) return 'zh-TW';
  return undefined;
}

/** VSCode 显示语言 → 界面语言（其余语种一律英文） */
export function localeFromEnv(language: string | undefined): Locale {
  return normalizeLocale(language) ?? 'en';
}

/**
 * 结合设置与 VSCode 显示语言得到最终界面语言。
 * 设置非法值（如手改 json 写成 `xx-YY`）时按 auto 处理，避免白屏。
 */
export function detectLocale(setting: string | undefined, language: string | undefined): Locale {
  const s = (setting ?? '').trim();
  if (s && s !== 'auto') {
    const normalized = normalizeLocale(s);
    if (normalized) return normalized;
  }
  return localeFromEnv(language);
}

/** 占位符替换：`{0}` `{1}` … 依次对应 args（缺省保留原占位符，方便发现漏译） */
export function format(template: string, args: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)];
    return v === undefined ? m : String(v);
  });
}
