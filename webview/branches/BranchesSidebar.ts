import { RpcClient } from '../bridge';
import { t } from '../i18n';
import { toast, promptValue, promptFields, showMenuAt, escapeHtml } from '../ui/dialogs';
import { BranchEntry, BranchInfo, RemoteEntry } from '../../shared/protocol';

const esc = (s: string): string => escapeHtml(s);
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

/** 标题行图标（内联 SVG，stroke=currentColor 跟随主题） */
const ICONS = {
  pull: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M2.5 13.5h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  push: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11.5v-8M4.8 6.7 8 3.5l3.2 3.2M2.5 13.5h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.9 1.6v3.3h-3.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  newBranch: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 5.2v5.6M9.8 8h4.4M12 5.9v4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  addRemote: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.2 8h11.6M8 2.1c2.3 2.1 2.3 9.7 0 11.8M8 2.1c-2.3 2.1-2.3 9.7 0 11.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  /** 当前分支：绿色对勾（IDEA Branches 风格） */
  check: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.6l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  /** 同步远程引用（git fetch）：环形双箭头 */
  fetch: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.9 6.7a5.4 5.4 0 0 1 9.2-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12.6 1.9v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.1 9.3a5.4 5.4 0 0 1-9.2 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.4 14.1v-2.9h2.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  /** 普通本地分支：分支线图标 */
  branchIco: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.5" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 5.2v5.6M4 8h5.2a2.8 2.8 0 0 0 2.8-2.8V5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  /** 远程分支：地球图标 */
  remoteIco: `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.6 8h10.8M8 2.4c2.1 2 2.1 9.2 0 11.2M8 2.4c-2.1 2-2.1 9.2 0 11.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
};

/** 分组折叠状态（持久化在内存，webview 重载时重置为默认） */
type GroupKey = 'local' | 'remote' | 'remotes';

/**
 * 侧边栏「分支」视图（复刻 IntelliJ IDEA 的 Branches 面板）：
 * - 当前分支 + ↑领先/↓落后 + 拉取 / 推送 / 新建分支
 * - 本地分支：检出、基于此新建、合并到当前、变基当前到此、重命名、删除
 * - 远程分支：按 remote 分组；检出为本地跟踪分支、合并/变基、删除远程分支
 * - 远程仓库：新增 / 改地址（拉取·推送）/ 删除
 */
export class BranchesSidebar {
  private branches: BranchEntry[] = [];
  private remotes: RemoteEntry[] = [];
  private info: BranchInfo | undefined;
  private filter = '';
  private collapsed: Record<GroupKey, boolean> = { local: false, remote: false, remotes: false };
  private remoteCollapsed = new Set<string>();
  private busy = false;

  private el: HTMLElement;
  private groupsEl!: HTMLElement;
  private curEl!: HTMLElement;
  private menuEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
  ) {
    this.el = root;
    this.build();
    void this.reload();
    this.bindEvents();
  }

  // ---------- UI 骨架 ----------

  private build(): void {
    this.el.innerHTML = `
<div class="br-view">
  <div class="br-head">
    <span class="br-cur" id="br-cur">${t('common.loading')}</span>
    <input type="search" id="br-filter" class="filter" placeholder="${t('branches.filterPlaceholder')}" title="${t('branches.filterTip')}">
    <button class="mini icon" id="br-pull" title="${t('branches.pull')}">${ICONS.pull}</button>
    <button class="mini icon" id="br-push" title="${t('branches.push')}">${ICONS.push}</button>
    <button class="mini icon" id="br-refresh" title="${t('branches.refreshTip')}">${ICONS.refresh}</button>
  </div>
  <div class="br-groups" id="br-groups"><div class="empty">${t('common.loading')}</div></div>
</div>
<div class="ctx-menu" id="br-menu" hidden></div>
`;
    this.curEl = this.must('br-cur');
    this.groupsEl = this.must('br-groups');
    this.menuEl = this.must('br-menu');

    this.must('br-refresh').addEventListener('click', () => void this.reload());
    (this.must('br-filter') as HTMLInputElement).addEventListener('input', (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.render();
    });
    this.must('br-pull').addEventListener('click', () => void this.sync('pull'));
    this.must('br-push').addEventListener('click', () => void this.sync('push'));
  }

  private must(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing element: ' + id);
    return el;
  }

  // ---------- 数据 ----------

  private async reload(): Promise<void> {
    if (!this.repoRoot) {
      this.groupsEl.innerHTML = `<div class="empty">${t('branches.noRepo')}</div>`;
      this.curEl.textContent = t('branches.noRepoShort');
      return;
    }
    try {
      const [branches, remotes, info] = await Promise.all([
        this.client.send('branch:list', { repoRoot: this.repoRoot }),
        this.client.send('remote:list', { repoRoot: this.repoRoot }),
        this.client.send('repo:info', { repoRoot: this.repoRoot }).catch(() => undefined),
      ]);
      this.branches = branches;
      this.remotes = remotes;
      this.info = info;
      this.render();
    } catch (err) {
      this.groupsEl.innerHTML = `<div class="empty">${t('branches.readFailed', esc(String(err)))}</div>`;
    }
  }

  private bindEvents(): void {
    this.client.on('reload', () => void this.reload());
    this.client.on('branch:changed', ({ info }) => {
      this.info = info;
      this.render();
    });
    this.client.on('status:changed', () => void this.reload());
  }

  // ---------- 渲染 ----------

  private render(): void {
    if (this.info) {
      const cur = this.info.detached
        ? t('branches.detachedAt', this.info.name.slice(0, 7))
        : this.info.name;
      const ab = this.info.ahead || this.info.behind
        ? ` ↑${this.info.ahead} ↓${this.info.behind}`
        : '';
      this.curEl.innerHTML = `<span class="br-cur-name">${esc(cur)}</span><span class="br-ab">${ab}</span>`;
    }

    const match = (b: BranchEntry): boolean =>
      !this.filter ||
      b.name.toLowerCase().includes(this.filter) ||
      (b.shortName ?? '').toLowerCase().includes(this.filter);

    const local = this.branches.filter((b) => !b.isRemote && match(b));
    const remote = this.branches.filter((b) => b.isRemote && match(b));
    // 当前分支排在前面（IDEA：Current Branch 置顶）
    local.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const byRemote = new Map<string, BranchEntry[]>();
    for (const b of remote) {
      const key = b.remote ?? 'origin';
      const list = byRemote.get(key) ?? [];
      list.push(b);
      byRemote.set(key, list);
    }

    const parts: string[] = [];
    parts.push(
      this.groupHead('local', t('branches.group.local'), local.length, {
        act: 'new-branch',
        title: t('branches.newBranchTitle'),
        icon: ICONS.newBranch,
      }),
      this.collapsed.local ? '' : `<div class="br-rows">${local.map((b) => this.branchRow(b)).join('') || `<div class="empty">${t('branches.noMatch')}</div>`}</div>`,
    );
    parts.push(
      this.groupHead('remote', t('branches.group.remote'), remote.length),
      this.collapsed.remote
        ? ''
        : [...byRemote.entries()]
            .map(([name, list]) => {
              const open = !this.remoteCollapsed.has(name);
              return `<div class="br-sub" data-remote="${escAttr(name)}">
  <div class="br-subhead" title="${t('branches.remoteGroupTip', escAttr(name), list.length)}"><span class="twisty">${open ? '▾' : '▸'}</span><span class="br-rem-ico">${ICONS.remoteIco}</span><span class="br-sub-name">${esc(name)}</span><span class="count">（${list.length}）</span></div>
  ${open ? `<div class="br-rows">${list.map((b) => this.branchRow(b)).join('')}</div>` : ''}
</div>`;
            })
            .join('') || `<div class="empty">${t('branches.noRemoteBranch')}</div>`,
    );
    parts.push(
      this.groupHead('remotes', t('branches.group.remotes'), this.remotes.length, {
        act: 'add-remote',
        title: t('branches.addRemoteTitle'),
        icon: ICONS.addRemote,
      }),
      this.collapsed.remotes
        ? ''
        : `<div class="br-rows">${this.remotes.map((r) => this.remoteRow(r)).join('') || `<div class="empty">${t('branches.noRemote')}</div>`}</div>`,
    );

    this.groupsEl.innerHTML = parts.join('');
    this.bindRows();
  }

  private groupHead(
    key: GroupKey,
    label: string,
    count: number,
    action?: { act: string; title: string; icon: string },
  ): string {
    const open = !this.collapsed[key];
    const btn = action
      ? `<span class="flex"></span><button class="mini icon ghead-btn" data-act="${action.act}" title="${action.title}">${action.icon}</button>`
      : '';
    return `<div class="br-ghead" data-group="${key}"><span class="twisty">${open ? '▾' : '▸'}</span><span>${label}</span><span class="count">（${count}）</span>${btn}</div>`;
  }

  private branchRow(b: BranchEntry): string {
    if (!b.isRemote) {
      // 本地分支：三列 = 版本图标(当前=绿色对勾) | 提交号(固定6位) | 分支名(过长以 … 省略)
      const ico = b.isCurrent
        ? `<span class="br-ico cur" title="${t('branches.ico.current')}">${ICONS.check}</span>`
        : `<span class="br-ico" title="${t('branches.group.local')}">${ICONS.branchIco}</span>`;
      const hash = b.commit ? b.commit.slice(0, 6) : '';
      const meta = b.upstream
        ? t('branches.tracking', b.upstream) + (b.ahead || b.behind ? ` ↑${b.ahead} ↓${b.behind}` : '')
        : b.ahead || b.behind
          ? `↑${b.ahead} ↓${b.behind}`
          : '';
      return `<div class="br-row br-local${b.isCurrent ? ' current' : ''}" data-name="${escAttr(b.name)}" data-remote="0"${meta ? ` title="${escAttr(meta)}"` : ''}>
  ${ico}
  <span class="br-hash">${esc(hash)}</span>
  <span class="br-name-cell">
    <span class="br-name" title="${escAttr(b.name)}">${esc(b.name)}</span>
    <span class="br-acts">
      <button class="mini icon" data-act="rename" title="${t('branches.renameTip')}">✎</button>
      <button class="mini icon" data-act="del" title="${t('branches.deleteTip')}">✕</button>
    </span>
  </span>
</div>`;
    }
    // 远程分支：保持原有 flex 布局（图标 + 名称 + ↑↓ + 提交号）
    const ab = b.ahead || b.behind ? `<span class="br-ab">↑${b.ahead} ↓${b.behind}</span>` : '';
    const up = b.upstream ? ` title="${t('branches.trackTip', escAttr(b.upstream))}"` : '';
    return `<div class="br-row${b.isCurrent ? ' current' : ''}" data-name="${escAttr(b.name)}" data-remote="1"${up}>
  <span class="br-ico rem" title="${t('branches.group.remote')}">${ICONS.remoteIco}</span>
  <span class="br-name">${esc(b.shortName ?? b.name)}</span>
  ${ab}
  <span class="flex"></span>
  <span class="br-hash">${esc(b.commit)}</span>
</div>`;
  }

  private remoteRow(r: RemoteEntry): string {
    const push =
      r.pushUrl && r.pushUrl !== r.fetchUrl
        ? `<div class="br-url push" title="${t('branches.pushUrlTip')}">↑ ${esc(r.pushUrl)}</div>`
        : '';
    return `<div class="br-row br-rem" data-rem="${escAttr(r.name)}">
  <div class="br-rem-main">
    <span class="br-name">${esc(r.name)}</span>
    <span class="flex"></span>
    <button class="mini icon" data-act="fetch-remote" title="${t('branches.fetchTip')}">${ICONS.fetch}</button>
    <button class="mini icon" data-act="edit-remote" title="${t('branches.editUrlTip')}">✎</button>
    <button class="mini icon" data-act="del-remote" title="${t('branches.deleteRemoteTip')}">✕</button>
  </div>
  <div class="br-url" title="${t('branches.fetchUrlTip')}">↓ ${esc(r.fetchUrl || t('common.notSet'))}</div>
  ${push}
</div>`;
  }

  private bindRows(): void {
    // 分组折叠
    this.groupsEl.querySelectorAll<HTMLElement>('.br-ghead').forEach((h) => {
      h.addEventListener('click', () => {
        const key = h.dataset.group as GroupKey;
        this.collapsed[key] = !this.collapsed[key];
        this.render();
      });
    });
    this.groupsEl.querySelectorAll<HTMLElement>('.br-subhead').forEach((h) => {
      h.addEventListener('click', () => {
        const name = h.parentElement?.dataset.remote ?? '';
        if (this.remoteCollapsed.has(name)) this.remoteCollapsed.delete(name);
        else this.remoteCollapsed.add(name);
        this.render();
      });
    });
    // 分支行：左键检出，右键菜单
    this.groupsEl.querySelectorAll<HTMLElement>('.br-row[data-name]').forEach((row) => {
      row.addEventListener('click', () => {
        const name = row.dataset.name!;
        void (row.dataset.remote === '1' ? this.checkoutRemote(name) : this.checkout(name));
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void this.branchMenu(e.clientX, e.clientY, row.dataset.name!, row.dataset.remote === '1');
      });
    });
    // 远程行按钮 / 分组标题行按钮 / 分支行悬停按钮
    this.groupsEl.querySelectorAll<HTMLElement>('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        const name = btn.closest<HTMLElement>('.br-rem')?.dataset.rem ?? '';
        if (act === 'add-remote') void this.addRemote();
        else if (act === 'new-branch') void this.createBranch();
        else if (act === 'fetch-remote') void this.fetchRemote(name);
        else if (act === 'edit-remote') void this.editRemote(name);
        else if (act === 'del-remote') void this.removeRemote(name);
        else if (act === 'rename' || act === 'del') {
          // 本地分支行悬停按钮：重命名 / 删除（与右键菜单同操作）
          const row = btn.closest<HTMLElement>('.br-row[data-name]');
          const bname = row?.dataset.name ?? '';
          if (!bname) return;
          if (act === 'rename') void this.rename(bname);
          else void this.remove(bname);
        }
      });
    });
  }

  // ---------- 分支操作 ----------

  private async run(label: string, fn: () => Promise<unknown>, ok?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
      if (ok) toast(ok);
      await this.reload();
    } catch (err) {
      toast(t('branches.failed', label, String(err)), true);
    } finally {
      this.busy = false;
    }
  }

  private async confirm(text: string): Promise<boolean> {
    return this.client.send('ui:confirm', { text });
  }

  private async checkout(name: string): Promise<void> {
    const b = this.branches.find((x) => x.name === name);
    if (b?.isCurrent) return;
    // 切换分支会改动工作区文件，误点代价大 —— 二次确认
    if (!(await this.confirm(t('branches.checkoutConfirm', name)))) return;
    await this.run(t('branches.checkoutOp'), () => this.client.send('branch:checkout', { repoRoot: this.repoRoot, ref: name }), t('branches.checkedOut', name));
  }

  private async checkoutRemote(name: string): Promise<void> {
    // 远程分支检出会新建/切换本地跟踪分支，同样先确认
    if (!(await this.confirm(t('branches.checkoutRemoteConfirm', name)))) return;
    await this.run(
      t('branches.checkoutRemoteOp'),
      async () => {
        const r = await this.client.send('branch:checkoutRemote', { repoRoot: this.repoRoot, name });
        toast(r.created ? t('branches.createdLocal', r.branch) : t('branches.checkedOut', r.branch));
      },
    );
  }

  private async createBranch(base?: string): Promise<void> {
    const name = await promptValue(base ? t('branches.newBranchFromPrompt', base) : t('branches.newBranchPrompt'), '');
    if (!name) return;
    await this.run(
      t('branches.createBranchOp'),
      () =>
        this.client.send('branch:create', {
          repoRoot: this.repoRoot,
          name,
          ref: base,
          checkout: true,
        }),
      t('branches.createdSwitched', name),
    );
  }

  private async rename(name: string): Promise<void> {
    const newName = await promptValue(t('branches.renamePrompt'), name);
    if (!newName || newName === name) return;
    await this.run(
      t('branches.renameOp'),
      () =>
        this.client.send('branch:rename', { repoRoot: this.repoRoot, oldName: name, newName }),
      t('branches.renamed', newName),
    );
  }

  private async remove(name: string, force = false): Promise<void> {
    if (this.branches.find((x) => x.name === name)?.isCurrent) {
      toast(t('branches.cannotDeleteCurrent'), true);
      return;
    }
    if (!(await this.confirm(t('branches.deleteLocalConfirm', name)))) return;
    try {
      await this.client.send('branch:delete', { repoRoot: this.repoRoot, name, force });
      toast(t('branches.deleted', name));
      await this.reload();
    } catch (err) {
      // 未合并分支被 git 拒绝时（IDEA 会追问是否强制删除）
      if (!force && (await this.confirm(t('branches.deleteForceConfirm', String(err))))) {
        await this.remove(name, true);
        return;
      }
      toast(t('branches.deleteFailed', String(err)), true);
    }
  }

  private async deleteRemoteBranch(name: string): Promise<void> {
    const remote = name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
    const branch = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!(await this.confirm(t('branches.deleteRemoteConfirm', name)))) return;
    await this.run(
      t('branches.deleteRemoteBranch'),
      () => this.client.send('branch:deleteRemote', { repoRoot: this.repoRoot, remote, branch }),
      t('branches.deletedRemote', name),
    );
  }

  // ---------- 远程管理 ----------

  private async addRemote(): Promise<void> {
    // 一次对话框填写所有项（名称 + 地址），不再一步一步连续 prompt
    const vals = await promptFields(t('branches.addRemoteTitle'), [
      { label: t('branches.addRemote.name'), initial: 'origin', placeholder: t('branches.prompt.namePlaceholder') },
      { label: t('branches.addRemote.url'), initial: '', placeholder: t('branches.prompt.urlPlaceholder') },
    ]);
    if (!vals) return;
    const [name, url] = vals;
    if (!name || !url) return;
    await this.run(
      t('branches.addRemoteOp'),
      () => this.client.send('remote:add', { repoRoot: this.repoRoot, name, url }),
      t('branches.addedRemote', name),
    );
  }

  private async editRemote(name: string): Promise<void> {
    const current = this.remotes.find((r) => r.name === name);
    showMenuAt(
      this.menuEl,
      Math.round(window.innerWidth / 2 - 90),
      Math.round(window.innerHeight / 3),
      [
        { label: t('branches.editFetchUrl') },
        { label: t('branches.editPushUrl') },
      ],
      (i) => {
        if (i !== 0 && i !== 1) return;
        const push = i === 1;
        const initial = push ? current?.pushUrl ?? current?.fetchUrl ?? '' : current?.fetchUrl ?? '';
        void (async () => {
          const url = await promptValue(t('branches.urlPrompt', name, push ? t('word.push') : t('word.pull')), initial);
          if (!url) return;
          await this.run(
            t('branches.editUrlTip'),
            () =>
              this.client.send('remote:setUrl', { repoRoot: this.repoRoot, name, url, push }),
            t('branches.urlUpdated', name, push ? t('word.push') : t('word.pull')),
          );
        })();
      },
    );
  }

  private async removeRemote(name: string): Promise<void> {
    if (!(await this.confirm(t('branches.deleteRemoteRepoConfirm', name)))) return;
    await this.run(
      t('branches.deleteRemoteRepoOp'),
      () => this.client.send('remote:remove', { repoRoot: this.repoRoot, name }),
      t('branches.deletedRemoteRepo', name),
    );
  }

  /** 更新远程引用（git fetch <remote>）：只同步远程跟踪分支，不动工作区 */
  private async fetchRemote(name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const text = await this.client.send('remote:fetch', { repoRoot: this.repoRoot, remote: name });
      toast(text || t('branches.synced', name));
      await this.reload();
    } catch (err) {
      toast(t('branches.syncFailed', name, String(err)), true);
    } finally {
      this.busy = false;
    }
  }

  // ---------- 拉取 / 推送 ----------

  private async sync(kind: 'pull' | 'push'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const text =
        kind === 'pull'
          ? await this.client.send('repo:pull', { repoRoot: this.repoRoot })
          : await this.client.send('repo:push', { repoRoot: this.repoRoot });
      toast(text || (kind === 'pull' ? t('branches.pullDone') : t('branches.pushDone')));
      await this.reload();
    } catch (err) {
      toast(t('branches.failed', kind === 'pull' ? t('word.pull') : t('word.push'), String(err)), true);
    } finally {
      this.busy = false;
    }
  }

  // ---------- 右键菜单 ----------

  private async branchMenu(
    x: number,
    y: number,
    name: string,
    isRemote: boolean,
  ): Promise<void> {
    // 「与当前分支对比」：当前分支就是所选分支时无意义，不展示
    const cur = this.currentRef();
    const cmp =
      cur && cur !== name
        ? [{ label: t('branches.menu.compare', cur, name), action: () => this.compareWithCurrent(name) }]
        : [];
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = isRemote
      ? [
          { label: t('branches.menu.checkoutAs'), action: () => void this.checkoutRemote(name) },
          ...cmp,
          { label: t('branches.menu.mergeInto'), action: () => void this.merge(name) },
          { label: t('branches.menu.rebaseOnto'), action: () => void this.rebase(name) },
          { label: t('branches.menu.newBranchFrom'), action: () => void this.createBranch(name) },
          { label: t('branches.menu.deleteRemoteBranch'), danger: true, action: () => void this.deleteRemoteBranch(name) },
        ]
      : [
          { label: t('branches.menu.checkout'), action: () => void this.checkout(name) },
          ...cmp,
          { label: t('branches.menu.newBranchFrom'), action: () => void this.createBranch(name) },
          { label: t('branches.menu.mergeInto'), action: () => void this.merge(name) },
          { label: t('branches.menu.rebaseOnto'), action: () => void this.rebase(name) },
          { label: t('branches.menu.rename'), action: () => void this.rename(name) },
          { label: t('branches.menu.delete'), danger: true, action: () => void this.remove(name) },
        ];
    showMenuAt(this.menuEl, x, y, items, (i) => items[i]?.action());
  }

  /** 当前分支引用（分离 HEAD 时用 HEAD，保证 range 一定可解析） */
  private currentRef(): string | undefined {
    if (!this.info) return undefined;
    return this.info.detached ? 'HEAD' : this.info.name;
  }

  /** 在主窗口打开「分支对比」面板：左=当前分支（基线），右=所选分支（目标） */
  private compareWithCurrent(name: string): void {
    const base = this.currentRef();
    if (!base) {
      toast(t('branches.noCurrentBranch'), true);
      return;
    }
    void this.client
      .send('ui:openCompare', { repoRoot: this.repoRoot, base, target: name })
      .catch((err) => toast(t('branches.openCompareFailed', String(err)), true));
  }

  private async merge(ref: string): Promise<void> {
    await this.run(t('branches.mergeOp'), () => this.client.send('merge:run', { repoRoot: this.repoRoot, ref }), t('branches.merged', ref));
  }

  private async rebase(ref: string): Promise<void> {
    await this.run(t('branches.rebaseOp'), () => this.client.send('rebase:run', { repoRoot: this.repoRoot, ref }), t('branches.rebased', ref));
  }
}
