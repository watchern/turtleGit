import './style.css';
import { RpcClient, decodeParams } from './bridge';
import { bindWebviewState } from './state';
import { CommitPanel } from './commit/CommitPanel';
import { CommitSidebarPanel } from './commit/CommitSidebar';
import { BranchesSidebar } from './branches/BranchesSidebar';
import { SidebarPanel } from './sidebar/SidebarPanel';
import { LogPanel } from './log/LogPanel';
import { DiffPanel } from './diff/DiffPanel';
import { GraphPanel } from './graph/GraphPanel';
import { StashPanel } from './stash/StashPanel';
import { BlamePanel } from './blame/BlamePanel';
import { ComparePanel } from './compare/ComparePanel';
import { WebviewInit } from '../shared/protocol';
import { setStrings, t } from './i18n';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi();
bindWebviewState(vscode);
const app = document.getElementById('app')!;
const client = new RpcClient((msg) => vscode.postMessage(msg));

window.addEventListener('message', (event) => {
  client.handleMessage(event.data);
});

let currentDisposer: (() => void) | undefined;

function mount(init: WebviewInit): void {
  currentDisposer?.();
  // 重挂载前清掉上一视图的事件订阅（保留 init），避免 DOM 销毁后仍有监听器报错
  client.clearHandlers(['init']);
  // 注入当前语言字典（宿主按语言只下发一份），之后整面板用 t() 渲染
  setStrings(init.strings);
  app.innerHTML = '';
  document.body.dataset.view = init.view;
  switch (init.view) {
    case 'commit':
      if (init.sidebar) {
        new CommitSidebarPanel(app, client, init.repoRoot, init.statusViewMode, init.paths);
      } else {
        new CommitPanel(app, client, init.repoRoot, init.paths, init.statusViewMode);
      }
      break;
    case 'sidebar':
      new SidebarPanel(app, client, init);
      break;
    case 'log':
      new LogPanel(app, client, init.repoRoot, init.filterPath);
      break;
    case 'diff':
      new DiffPanel(app, client, init.repoRoot, init.diff?.path ?? '', init.diff?.staged ?? false);
      break;
    case 'graph':
      new GraphPanel(app, client, init.repoRoot);
      break;
    case 'stash':
      new StashPanel(app, client, init.repoRoot, init.stashRef);
      break;
    case 'blame':
      new BlamePanel(app, client, init.repoRoot, init.paths?.[0] ?? '');
      break;
    case 'compare':
      new ComparePanel(app, client, init.repoRoot, init.compare);
      break;
  }
  currentDisposer = () => undefined;
}

// 宿主在面板复用时推送新 init
client.on('init', (payload) => mount(payload as WebviewInit));

// 初始参数来自 data-params（base64url JSON）
try {
  const init = decodeParams(app.dataset.params ?? '') as unknown as WebviewInit;
  mount(init);
} catch (err) {
  app.innerHTML = `<div class="diff-empty">${t('common.initFailed', String(err))}</div>`;
}

// 通知宿主：webview 已就绪
vscode.postMessage({ kind: 'ready' });
