import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { toast, promptValue, showMenuAt, escapeHtml } from '../ui/dialogs';
import { computeLanes, refBadges, buildEdges, laneColor, badgeWidth, GraphNode } from './lanes';
import { CommitFile, CommitInfo } from '../../shared/protocol';

const ROW_H = 26;
const COL_W = 18;
const NODE_R = 5;
/** hash 文本列（等宽 11px，shortHash 7 字符） */
const HASH_W = 50;

/**
 * 版本分支图：复刻 TortoiseGit Revision Graph。
 * 左侧 SVG 图（lane + 节点 + refs 徽标），右侧提交详情与变更文件。
 */
export class GraphPanel {
  private nodes: GraphNode[] = [];
  private commits = new Map<string, CommitInfo>();
  private files: CommitFile[] = [];
  private currentFile: CommitFile | undefined;
  private selectedHash: string | undefined;
  private skip = 0;
  private readonly pageSize = 200;
  private showAll = true;

  private el: HTMLElement;
  private graphEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private filesEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private statEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
  ) {
    this.el = root;
    this.build();
    void this.reload();
  }

  private build(): void {
    this.el.innerHTML = `
<div class="toolbar">
  <button id="btn-refresh" title="刷新 (F5)">刷新</button>
  <label class="chk"><input type="checkbox" id="chk-all" checked> 所有分支</label>
  <input type="search" id="flt-author" class="filter" placeholder="作者">
  <input type="search" id="flt-grep" class="filter" placeholder="信息关键字">
  <span class="flex"></span>
  <span class="page-info" id="page-info"></span>
  <button id="btn-more" class="mini" title="加载更多">加载更多</button>
</div>
<div class="split">
  <section class="pane left graph-pane">
    <div class="graph-scroll" id="graph-scroll"><div class="graph-svg-host" id="graph-svg"></div></div>
  </section>
  <section class="pane right">
    <div class="pane-head"><span id="commit-title">提交详情</span></div>
    <div class="commit-detail" id="commit-detail"><div class="empty">点击图中节点查看详情</div></div>
    <div class="pane-head"><span>变更文件</span><span class="count" id="file-count"></span></div>
    <div class="file-list short" id="file-list"></div>
    <div class="pane-head">
      <span>差异</span><span class="diff-stat" id="diff-stat"></span>
      <span class="flex"></span>
      <button class="mini" id="btn-open-editor">在编辑器中打开</button>
    </div>
    <div class="diff-view" id="diff-view"><div class="diff-empty">选择文件以查看差异</div></div>
  </section>
</div>
<div class="ctx-menu" id="ctx-menu" hidden></div>
`;
    this.graphEl = this.must('graph-svg');
    this.detailEl = this.must('commit-detail');
    this.filesEl = this.must('file-list');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');

    this.must('btn-refresh').addEventListener('click', () => {
      this.skip = 0;
      void this.reload();
    });
    (this.must('chk-all') as HTMLInputElement).addEventListener('change', (e) => {
      this.showAll = (e.target as HTMLInputElement).checked;
      this.skip = 0;
      void this.reload();
    });
    this.must('flt-grep').addEventListener('change', () => {
      this.skip = 0;
      void this.reload();
    });
    this.must('flt-author').addEventListener('change', () => {
      this.skip = 0;
      void this.reload();
    });
    this.must('btn-more').addEventListener('click', () => {
      this.skip += this.pageSize;
      void this.reload(true);
    });
    this.must('btn-open-editor').addEventListener('click', () => {
      const file = this.currentFile;
      if (!file || !this.selectedHash) return;
      this.client.command('openCommitDiff', { hash: this.selectedHash, path: file.path });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        this.skip = 0;
        void this.reload();
      }
    });
  }

  private must(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing element: ' + id);
    return el;
  }

  private async reload(append = false): Promise<void> {
    try {
      const commits = await this.client.send('log:list', {
        repoRoot: this.repoRoot,
        skip: this.skip,
        limit: this.pageSize,
        all: this.showAll,
        author: (this.must('flt-author') as HTMLInputElement).value.trim() || undefined,
        grep: (this.must('flt-grep') as HTMLInputElement).value.trim() || undefined,
      });
      if (append) {
        this.nodes = [...this.nodes, ...computeLanes(commits)];
      } else {
        this.nodes = computeLanes(commits);
      }
      for (const c of commits) this.commits.set(c.hash, c);
      this.renderGraph();
      this.must('page-info').textContent = `${this.nodes.length} 个提交`;
    } catch (err) {
      this.graphEl.innerHTML = `<div class="empty">读取失败：${this.esc(String(err))}</div>`;
    }
  }

  // ---------- 图渲染 ----------

  private renderGraph(): void {
    const height = this.nodes.length * ROW_H + 10;
    const laneCount =
      this.nodes.reduce((m, n) => Math.max(m, n.lane, ...n.parentLanes), 0) + 1;
    // 列布局：lane 区 → hash 文本列 → refs 徽标（从左往右排，不回头、不重叠）
    const textX = laneCount * COL_W + 6;
    const badgeStart = textX + HASH_W + 8;
    const rowEnd = this.nodes.map((n) => {
      let x = badgeStart;
      for (const b of refBadges(n.commit.refs)) x += badgeWidth(b.text) + 4;
      return Math.max(textX + HASH_W, x - 4);
    });
    const contentW = rowEnd.reduce((m, w) => Math.max(m, w), 0);
    const paneW = this.graphEl.parentElement?.clientWidth ?? 0;
    const graphWidth = Math.max(contentW + 8, paneW - 6, 140);
    const parts: string[] = [];

    // 选中行高亮：半透明焦点色（深浅主题都不会糊成一块黑）
    const selRow = this.selectedHash
      ? this.nodes.findIndex((n) => n.commit.hash === this.selectedHash)
      : -1;
    if (selRow >= 0) {
      parts.push(
        `<rect class="row-sel" x="1" y="${selRow * ROW_H + 1}" width="${graphWidth - 2}" height="${ROW_H - 2}" rx="3"/>`,
      );
    }

    // 连线：连到父提交的真实行（拓扑序里父提交可能隔着多行）
    for (const e of buildEdges(this.nodes)) {
      const x1 = e.fromLane * COL_W + COL_W / 2;
      const y1 = e.fromRow * ROW_H + ROW_H / 2;
      const x2 = e.toLane * COL_W + COL_W / 2;
      const y2 = e.continues ? height - 4 : e.toRow * ROW_H + ROW_H / 2;
      if (e.fromLane === e.toLane) {
        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="edge"/>`);
        continue;
      }
      const dy = y2 - y1;
      if (dy <= ROW_H * 1.2) {
        // 相邻行：对称 S 形
        const m = y1 + dy / 2;
        parts.push(`<path d="M ${x1} ${y1} C ${x1} ${m}, ${x2} ${m}, ${x2} ${y2}" class="edge"/>`);
      } else {
        // 隔行：先在本 lane 竖直下行，接近父行时平滑拐入父 lane（gitk 风格）
        const k = y2 - ROW_H * 0.9;
        const d = ROW_H * 0.45;
        parts.push(
          `<path d="M ${x1} ${y1} L ${x1} ${k} C ${x1} ${k + d}, ${x2} ${y2 - d}, ${x2} ${y2}" class="edge"/>`,
        );
      }
    }

    // 节点与行
    this.nodes.forEach((node, row) => {
      const y = row * ROW_H + ROW_H / 2;
      const x = node.lane * COL_W + COL_W / 2;
      const isHead = node.commit.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD ->'));
      const selected = this.selectedHash === node.commit.hash;
      let bx = badgeStart;
      const badgesHtml: string[] = [];
      for (const b of refBadges(node.commit.refs)) {
        const w = badgeWidth(b.text);
        badgesHtml.push(
          `<g class="badge-${b.kind}"><rect x="${bx}" y="${y - 8}" width="${w}" height="16" rx="8"/><text x="${bx + w / 2}" y="${y + 4}" text-anchor="middle">${this.esc(b.text)}</text></g>`,
        );
        bx += w + 4;
      }
      parts.push(
        `<g class="gnode${selected ? ' selected' : ''}" data-hash="${node.commit.hash}" data-row="${row}">
  <rect class="row-hit" x="0" y="${row * ROW_H}" width="${graphWidth}" height="${ROW_H}"/>
  <circle cx="${x}" cy="${y}" r="${NODE_R}" class="${isHead ? 'node head' : 'node'}" fill="${laneColor(node.lane)}"/>
  <text x="${textX}" y="${y + 4}" class="g-hash">${node.commit.shortHash}</text>
  ${badgesHtml.join('')}
</g>`,
      );
    });

    this.graphEl.innerHTML = `<svg width="${graphWidth}" height="${height}" viewBox="0 0 ${graphWidth} ${height}" class="graph-svg">${parts.join('')}</svg>`;
    this.graphEl.querySelectorAll<SVGGElement>('.gnode').forEach((g) => {
      g.addEventListener('click', () => this.selectCommit(g.dataset.hash!));
      g.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.selectCommit(g.dataset.hash!);
        this.showContextMenu(e.clientX, e.clientY, g.dataset.hash!);
      });
    });
  }

  // ---------- 详情 ----------

  private async selectCommit(hash: string): Promise<void> {
    this.selectedHash = hash;
    this.currentFile = undefined;
    this.renderGraph();
    const commit = this.commits.get(hash);
    if (!commit) return;
    const date = new Date(commit.authorDate);
    this.must('commit-title').textContent = `${commit.shortHash} ${commit.subject}`;
    const refs = commit.refs.length
      ? `<div class="refs">${commit.refs.map((r) => `<span class="ref">${this.esc(r)}</span>`).join('')}</div>`
      : '';
    this.detailEl.innerHTML = `
<div class="detail-row"><span class="k">提交</span><span class="v mono">${commit.hash}</span></div>
<div class="detail-row"><span class="k">作者</span><span class="v">${this.esc(commit.author)} &lt;${this.esc(commit.authorEmail)}&gt;</span></div>
<div class="detail-row"><span class="k">日期</span><span class="v">${date.toLocaleString()}</span></div>
<div class="detail-row"><span class="k"> parents </span><span class="v mono">${commit.parents.map((p) => p.slice(0, 7)).join(' ') || '（无）'}</span></div>
${refs}
<div class="detail-msg">${this.esc(commit.body || commit.subject)}</div>
<div class="detail-actions">
  <button class="mini" data-act="checkout">检出</button>
  <button class="mini" data-act="branch">建分支</button>
  <button class="mini" data-act="tag">打标签</button>
  <button class="mini" data-act="merge">合并到此</button>
  <button class="mini" data-act="cherry">拣选</button>
  <button class="mini" data-act="reset">重置到此处</button>
  <button class="mini" data-act="revert">还原</button>
</div>
`;
    this.detailEl.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => void this.runAction(btn.dataset.act!, hash));
    });

    try {
      this.files = await this.client.send('log:files', { repoRoot: this.repoRoot, hash });
    } catch {
      this.files = [];
    }
    this.renderFiles();
  }

  private renderFiles(): void {
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = '<div class="empty">该提交没有文件变更</div>';
      return;
    }
    const badge: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型', U: '冲突' };
    this.filesEl.innerHTML = this.files
      .map((f) => {
        const stat = f.isBinary ? '二进制' : `+${f.additions} -${f.deletions}`;
        return `<div class="file-row${this.currentFile?.path === f.path ? ' active' : ''}" data-path="${this.escAttr(f.path)}" title="${this.escAttr(f.path)}">
  <span class="badge st-${f.status === 'A' ? 'staged' : f.status === 'D' ? 'untracked' : 'modified'}" title="${this.escAttr(badge[f.status] ?? f.status)}">${f.status}</span>
  <span class="file-name">${this.esc(f.path)}</span>
  <span class="file-dir">${stat}</span>
</div>`;
      })
      .join('');
    this.filesEl.querySelectorAll<HTMLElement>('.file-row').forEach((row) => {
      row.addEventListener('click', () => {
        this.currentFile = this.files.find((f) => f.path === row.dataset.path);
        this.renderFiles();
        void this.showDiff();
      });
    });
  }

  private async showDiff(): Promise<void> {
    if (!this.currentFile || !this.selectedHash) {
      this.diffEl.innerHTML = '<div class="diff-empty">选择文件以查看差异</div>';
      return;
    }
    try {
      const range = `${this.selectedHash}^..${this.selectedHash}`;
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range,
      });
      this.diffEl.innerHTML = renderDiff(patch, 'side', tail);
      bindDiffInteractions(
        this.diffEl,
        this.client,
        {
          repoRoot: this.repoRoot,
          path: this.currentFile.path,
          staged: false,
          range,
        },
        'side',
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${this.esc(String(err))}</div>`;
    }
  }

  // ---------- 右键操作 ----------

  private showContextMenu(x: number, y: number, hash: string): void {
    const items: Array<{ label: string; action: () => void }> = [
      { label: '检出 (Checkout)', action: () => void this.runAction('checkout', hash) },
      { label: '在此创建分支…', action: () => void this.runAction('branch', hash) },
      { label: '在此创建标签…', action: () => void this.runAction('tag', hash) },
      { label: '合并到此 (Merge)', action: () => void this.runAction('merge', hash) },
      { label: '拣选到当前分支 (Cherry-pick)', action: () => void this.runAction('cherry', hash) },
      { label: '重置到此处 (Reset)', action: () => void this.runAction('reset', hash) },
      { label: '还原此提交 (Revert)', action: () => void this.runAction('revert', hash) },
    ];
    showMenuAt(
      this.must('ctx-menu'),
      x,
      y,
      items.map((it) => ({ label: it.label })),
      (i) => items[i].action(),
    );
  }

  private async runAction(act: string, hash: string): Promise<void> {
    const short = hash.slice(0, 7);
    try {
      switch (act) {
        case 'checkout':
          await this.client.send('branch:checkout', { repoRoot: this.repoRoot, ref: hash });
          toast(`已检出 ${short}（分离头指针）`);
          break;
        case 'branch': {
          const name = await promptValue('新分支名称：', `branch-${short}`);
          if (name) {
            await this.client.send('branch:create', {
              repoRoot: this.repoRoot,
              name,
              ref: hash,
              checkout: true,
            });
            toast(`已创建并切换到 ${name}`);
          }
          break;
        }
        case 'tag': {
          const name = await promptValue('标签名称：', `v-${short}`);
          if (name) {
            await this.client.send('tag:create', { repoRoot: this.repoRoot, name, ref: hash });
            toast(`已创建标签 ${name}`);
          }
          break;
        }
        case 'merge':
          if (await this.confirm(`确定将 ${short} 合并到当前分支？`)) {
            await this.client.send('merge:run', { repoRoot: this.repoRoot, ref: hash });
            toast('合并完成');
          }
          break;
        case 'cherry':
          await this.client.send('cherryPick:run', { repoRoot: this.repoRoot, hashes: [hash] });
          toast('拣选完成');
          break;
        case 'reset': {
          const mode = await this.choose('重置模式', ['soft（保留暂存区）', 'mixed（默认，保留工作区）', 'hard（全部丢弃，危险）']);
          if (mode) {
            const m = mode.startsWith('soft') ? 'soft' : mode.startsWith('hard') ? 'hard' : 'mixed';
            if (m === 'hard' && !(await this.confirm('hard 重置将丢弃所有本地修改，确定？'))) return;
            await this.client.send('reset:run', { repoRoot: this.repoRoot, ref: hash, mode: m });
            toast('重置完成');
          }
          break;
        }
        case 'revert':
          await this.client.send('revert:run', { repoRoot: this.repoRoot, hash });
          toast('还原完成');
          break;
      }
      void this.reload();
    } catch (err) {
      toast(`操作失败：${String(err)}`, true);
    }
  }

  // ---------- 简易对话框（webview 内） ----------

  private async confirm(text: string): Promise<boolean> {
    return this.client.send('ui:confirm', { text });
  }

  private async choose(title: string, options: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      showMenuAt(
        this.must('ctx-menu'),
        Math.round(window.innerWidth / 2 - 60),
        Math.round(window.innerHeight / 3),
        options.map((o) => ({ label: o })),
        (i) => resolve(options[i]),
      );
      setTimeout(() => resolve(null), 0);
    });
  }

  private esc(s: string): string {
    return escapeHtml(s);
  }

  private escAttr(s: string): string {
    return this.esc(s).replace(/"/g, '&quot;');
  }
}
