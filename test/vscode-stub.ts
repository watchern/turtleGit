/**
 * 冒烟测试用的 `vscode` 桩。
 *
 * `vscode` 模块只在 VSCode 宿主进程里存在，node 直接 require 会失败。
 * 目前只有宿主 i18n 模块 `import * as vscode from 'vscode'`（refreshLocale 读配置），
 * 而冒烟测试走的都是纯数据层路径，不依赖任何宿主 API——给一个最小实现即可。
 *
 * 打包时通过 esbuild 的 `--alias:vscode=./test/vscode-stub.ts` 注入。
 */
export const workspace = {
  getConfiguration: () => ({
    get: <T>(_section: string, _key?: string): T | undefined => undefined,
    update: async (): Promise<void> => undefined,
  }),
};

export const window = {
  showWarningMessage: async (): Promise<string | undefined> => undefined,
  showErrorMessage: async (): Promise<string | undefined> => undefined,
  showInformationMessage: async (): Promise<string | undefined> => undefined,
};

export const env = {
  language: 'en',
};
