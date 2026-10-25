import { RpcClient } from '../bridge';
import { CommitSidebarPanel } from '../commit/CommitSidebar';
import { BranchesSidebar } from '../branches/BranchesSidebar';
import { StashSidebarPanel } from '../stash/StashSidebarPanel';
import { SidebarTab, WebviewInit } from '../../shared/protocol';

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'commit', label: '提交' },
  { id: 'branches', label: '分支' },
  { id: 'stash', label: '暂存' },
];

/**
 * 合并后的侧边栏：用标签页在「提交 / 分支 / 暂存」之间切换（取代原先两个独立
 * WebviewView）。三个面板一次性挂载，靠 `hidden` 切换可见性，避免反复重建导致
 * 的事件订阅泄漏；命令聚焦（commit/branches/stash）通过 `sidebar:tab` 事件切页。
 */
export class SidebarPanel {
  private tab: SidebarTab;
  private tabsEl!: HTMLElement;
  private panes!: Record<SidebarTab, HTMLElement>;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    init: WebviewInit,
  ) {
    this.tab =
      init.tab && TABS.some((t) => t.id === init.tab) ? (init.tab as SidebarTab) : 'commit';
    const repoRoot = init.repoRoot;
    const viewMode = init.statusViewMode ?? 'list';
    const initialPaths = init.paths;

    root.innerHTML = `
<div class="side-tabs" id="side-tabs">
  ${TABS.map((t) => `<button class="side-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
</div>
<div class="side-body">
  <div class="side-pane" data-pane="commit"></div>
  <div class="side-pane" data-pane="branches"></div>
  <div class="side-pane" data-pane="stash"></div>
</div>`;
    this.tabsEl = root.querySelector('#side-tabs') as HTMLElement;
    this.panes = {
      commit: root.querySelector('[data-pane="commit"]') as HTMLElement,
      branches: root.querySelector('[data-pane="branches"]') as HTMLElement,
      stash: root.querySelector('[data-pane="stash"]') as HTMLElement,
    };

    // 三个面板一次性挂载，靠 hidden 切换；事件订阅由 RpcClient.clearHandlers 在重挂载时清理
    new CommitSidebarPanel(this.panes.commit, client, repoRoot, viewMode, initialPaths);
    new BranchesSidebar(this.panes.branches, client, repoRoot);
    new StashSidebarPanel(this.panes.stash, client, repoRoot);

    this.tabsEl.querySelectorAll<HTMLButtonElement>('.side-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTo(btn.dataset.tab as SidebarTab));
    });

    // 命令聚焦时宿主推送 tab 切换事件（不重建视图）
    this.client.on('sidebar:tab', ({ tab }) => {
      if (tab && tab !== this.tab) this.switchTo(tab);
    });

    this.switchTo(this.tab);
  }

  /** 切换可见标签页 */
  switchTo(tab: SidebarTab): void {
    this.tab = tab;
    this.tabsEl.querySelectorAll<HTMLButtonElement>('.side-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    (Object.keys(this.panes) as SidebarTab[]).forEach((k) => {
      this.panes[k].hidden = k !== tab;
    });
  }
}
