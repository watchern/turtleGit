import { RpcClient } from '../bridge';
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
    <span class="br-cur" id="br-cur">载入中…</span>
    <span class="flex"></span>
    <input type="search" id="br-filter" class="filter" placeholder="过滤" title="按名称过滤分支">
    <button class="mini icon" id="br-pull" title="拉取（Pull）">${ICONS.pull}</button>
    <button class="mini icon" id="br-push" title="推送（Push）">${ICONS.push}</button>
    <button class="mini icon" id="br-refresh" title="刷新分支列表">${ICONS.refresh}</button>
  </div>
  <div class="br-groups" id="br-groups"><div class="empty">载入中…</div></div>
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
      this.groupsEl.innerHTML = '<div class="empty">未找到 git 仓库</div>';
      this.curEl.textContent = '无仓库';
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
      this.groupsEl.innerHTML = `<div class="empty">读取失败：${esc(String(err))}</div>`;
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
        ? `分离 HEAD @ ${this.info.name.slice(0, 7)}`
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
      this.groupHead('local', `本地分支`, local.length, {
        act: 'new-branch',
        title: '从当前提交新建分支',
        icon: ICONS.newBranch,
      }),
      this.collapsed.local ? '' : `<div class="br-rows">${local.map((b) => this.branchRow(b)).join('') || '<div class="empty">无匹配分支</div>'}</div>`,
    );
    parts.push(
      this.groupHead('remote', `远程分支`, remote.length),
      this.collapsed.remote
        ? ''
        : [...byRemote.entries()]
            .map(([name, list]) => {
              const open = !this.remoteCollapsed.has(name);
              return `<div class="br-sub" data-remote="${escAttr(name)}">
  <div class="br-subhead"><span class="twisty">${open ? '▾' : '▸'}</span><span class="br-sub-name">${esc(name)}</span><span class="count">（${list.length}）</span></div>
  ${open ? `<div class="br-rows">${list.map((b) => this.branchRow(b)).join('')}</div>` : ''}
</div>`;
            })
            .join('') || '<div class="empty">无远程分支</div>',
    );
    parts.push(
      this.groupHead('remotes', `远程仓库`, this.remotes.length, {
        act: 'add-remote',
        title: '添加远程仓库',
        icon: ICONS.addRemote,
      }),
      this.collapsed.remotes
        ? ''
        : `<div class="br-rows">${this.remotes.map((r) => this.remoteRow(r)).join('') || '<div class="empty">无远程仓库</div>'}</div>`,
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
        ? `<span class="br-ico cur" title="当前分支">${ICONS.check}</span>`
        : `<span class="br-ico" title="本地分支">${ICONS.branchIco}</span>`;
      const hash = b.commit ? b.commit.slice(0, 6) : '';
      const meta = b.upstream
        ? `跟踪 ${b.upstream}${b.ahead || b.behind ? ` ↑${b.ahead} ↓${b.behind}` : ''}`
        : b.ahead || b.behind
          ? `↑${b.ahead} ↓${b.behind}`
          : '';
      return `<div class="br-row br-local${b.isCurrent ? ' current' : ''}" data-name="${escAttr(b.name)}" data-remote="0"${meta ? ` title="${escAttr(meta)}"` : ''}>
  ${ico}
  <span class="br-hash">${esc(hash)}</span>
  <span class="br-name-cell">
    <span class="br-name" title="${escAttr(b.name)}">${esc(b.name)}</span>
    <span class="br-acts">
      <button class="mini icon" data-act="rename" title="重命名分支">✎</button>
      <button class="mini icon" data-act="del" title="删除分支">✕</button>
    </span>
  </span>
</div>`;
    }
    // 远程分支：保持原有 flex 布局（图标 + 名称 + ↑↓ + 提交号）
    const ab = b.ahead || b.behind ? `<span class="br-ab">↑${b.ahead} ↓${b.behind}</span>` : '';
    const up = b.upstream ? ` title="跟踪 ${escAttr(b.upstream)}"` : '';
    return `<div class="br-row${b.isCurrent ? ' current' : ''}" data-name="${escAttr(b.name)}" data-remote="1"${up}>
  <span class="br-ico rem" title="远程分支">${ICONS.remoteIco}</span>
  <span class="br-name">${esc(b.shortName ?? b.name)}</span>
  ${ab}
  <span class="flex"></span>
  <span class="br-hash">${esc(b.commit)}</span>
</div>`;
  }

  private remoteRow(r: RemoteEntry): string {
    const push =
      r.pushUrl && r.pushUrl !== r.fetchUrl
        ? `<div class="br-url push" title="推送地址">↑ ${esc(r.pushUrl)}</div>`
        : '';
    return `<div class="br-row br-rem" data-rem="${escAttr(r.name)}">
  <div class="br-rem-main">
    <span class="br-name">${esc(r.name)}</span>
    <span class="flex"></span>
    <button class="mini icon" data-act="edit-remote" title="修改地址">✎</button>
    <button class="mini icon" data-act="del-remote" title="删除远程仓库">✕</button>
  </div>
  <div class="br-url" title="拉取地址">↓ ${esc(r.fetchUrl || '（未设置）')}</div>
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
      toast(`${label}失败：${String(err)}`, true);
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
    await this.run('检出', () => this.client.send('branch:checkout', { repoRoot: this.repoRoot, ref: name }), `已切换到 ${name}`);
  }

  private async checkoutRemote(name: string): Promise<void> {
    await this.run(
      '检出远程分支',
      async () => {
        const r = await this.client.send('branch:checkoutRemote', { repoRoot: this.repoRoot, name });
        toast(r.created ? `已新建本地分支 ${r.branch} 并跟踪远程` : `已切换到 ${r.branch}`);
      },
    );
  }

  private async createBranch(base?: string): Promise<void> {
    const name = await promptValue(base ? `基于 ${base} 新建分支，名称：` : '新分支名称：', '');
    if (!name) return;
    await this.run(
      '新建分支',
      () =>
        this.client.send('branch:create', {
          repoRoot: this.repoRoot,
          name,
          ref: base,
          checkout: true,
        }),
      `已创建并切换到 ${name}`,
    );
  }

  private async rename(name: string): Promise<void> {
    const newName = await promptValue('新的分支名称：', name);
    if (!newName || newName === name) return;
    await this.run(
      '重命名',
      () =>
        this.client.send('branch:rename', { repoRoot: this.repoRoot, oldName: name, newName }),
      `已重命名为 ${newName}`,
    );
  }

  private async remove(name: string, force = false): Promise<void> {
    if (this.branches.find((x) => x.name === name)?.isCurrent) {
      toast('不能删除当前分支（请先切换到其他分支）', true);
      return;
    }
    if (!(await this.confirm(`确定删除本地分支「${name}」？`))) return;
    try {
      await this.client.send('branch:delete', { repoRoot: this.repoRoot, name, force });
      toast(`已删除 ${name}`);
      await this.reload();
    } catch (err) {
      // 未合并分支被 git 拒绝时（IDEA 会追问是否强制删除）
      if (!force && (await this.confirm(`删除失败：${String(err)}\n是否强制删除（-D）？`))) {
        await this.remove(name, true);
        return;
      }
      toast(`删除失败：${String(err)}`, true);
    }
  }

  private async deleteRemoteBranch(name: string): Promise<void> {
    const remote = name.includes('/') ? name.slice(0, name.indexOf('/')) : '';
    const branch = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (!(await this.confirm(`确定删除远程分支「${name}」？此操作会改动远程仓库。`))) return;
    await this.run(
      '删除远程分支',
      () => this.client.send('branch:deleteRemote', { repoRoot: this.repoRoot, remote, branch }),
      `已删除远程分支 ${name}`,
    );
  }

  // ---------- 远程管理 ----------

  private async addRemote(): Promise<void> {
    // 一次对话框填写所有项（名称 + 地址），不再一步一步连续 prompt
    const vals = await promptFields('添加远程仓库', [
      { label: '名称', initial: 'origin', placeholder: '如 origin' },
      { label: '地址（URL）', initial: '', placeholder: 'https://… 或 git@…' },
    ]);
    if (!vals) return;
    const [name, url] = vals;
    if (!name || !url) return;
    await this.run(
      '添加远程',
      () => this.client.send('remote:add', { repoRoot: this.repoRoot, name, url }),
      `已添加远程 ${name}`,
    );
  }

  private async editRemote(name: string): Promise<void> {
    const current = this.remotes.find((r) => r.name === name);
    showMenuAt(
      this.menuEl,
      Math.round(window.innerWidth / 2 - 90),
      Math.round(window.innerHeight / 3),
      [
        { label: '修改拉取地址（fetch）' },
        { label: '修改推送地址（push）' },
      ],
      (i) => {
        if (i !== 0 && i !== 1) return;
        const push = i === 1;
        const initial = push ? current?.pushUrl ?? current?.fetchUrl ?? '' : current?.fetchUrl ?? '';
        void (async () => {
          const url = await promptValue(`${name} 的${push ? '推送' : '拉取'}地址：`, initial);
          if (!url) return;
          await this.run(
            '修改地址',
            () =>
              this.client.send('remote:setUrl', { repoRoot: this.repoRoot, name, url, push }),
            `已更新 ${name} 的${push ? '推送' : '拉取'}地址`,
          );
        })();
      },
    );
  }

  private async removeRemote(name: string): Promise<void> {
    if (!(await this.confirm(`确定删除远程仓库「${name}」？仅移除本地配置，不影响远程服务器。`))) return;
    await this.run(
      '删除远程',
      () => this.client.send('remote:remove', { repoRoot: this.repoRoot, name }),
      `已删除远程 ${name}`,
    );
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
      toast(text || (kind === 'pull' ? '拉取完成' : '推送完成'));
      await this.reload();
    } catch (err) {
      toast(`${kind === 'pull' ? '拉取' : '推送'}失败：${String(err)}`, true);
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
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = isRemote
      ? [
          { label: '检出为本地分支…', action: () => void this.checkoutRemote(name) },
          { label: '合并到当前分支', action: () => void this.merge(name) },
          { label: '将当前分支变基到此', action: () => void this.rebase(name) },
          { label: '基于此新建分支…', action: () => void this.createBranch(name) },
          { label: '删除远程分支…', danger: true, action: () => void this.deleteRemoteBranch(name) },
        ]
      : [
          { label: '检出 (Checkout)', action: () => void this.checkout(name) },
          { label: '基于此新建分支…', action: () => void this.createBranch(name) },
          { label: '合并到当前分支', action: () => void this.merge(name) },
          { label: '将当前分支变基到此', action: () => void this.rebase(name) },
          { label: '重命名…', action: () => void this.rename(name) },
          { label: '删除…', danger: true, action: () => void this.remove(name) },
        ];
    showMenuAt(this.menuEl, x, y, items, (i) => items[i]?.action());
  }

  private async merge(ref: string): Promise<void> {
    await this.run('合并', () => this.client.send('merge:run', { repoRoot: this.repoRoot, ref }), `已将 ${ref} 合并到当前分支`);
  }

  private async rebase(ref: string): Promise<void> {
    await this.run('变基', () => this.client.send('rebase:run', { repoRoot: this.repoRoot, ref }), `已将当前分支变基到 ${ref}`);
  }
}
