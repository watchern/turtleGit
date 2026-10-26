import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { toast, promptValue, showMenuAt, escapeHtml } from '../ui/dialogs';
import { loadState, saveState } from '../state';
import {
  computeLanes,
  buildEdges,
  laneColor,
  searchMatches,
  pickCompareRef,
  isHeadCommit,
  branchChips,
  autoLaneWidth,
  graphWidth,
  nodeRadius,
  LANE_W_MIN,
  LANE_W_MAX,
  GraphNode,
} from './lanes';
import { BranchEntry, CommitFile, CommitInfo } from '../../shared/protocol';

const ROW_H = 26;
/** hash 文本列（等宽 11px，shortHash 7 字符）——表头与行共用 */
const HASH_W = 50;
/** 作者 / 日期列默认宽（与 Intellig log 表一致） */
const AUTHOR_W = 120;
const DATE_W = 145;
/** 列宽拖拽范围（Intellig：40–600） */
const MIN_COL_W = 40;
const MAX_COL_W = 600;
/** hash 列可缩到 34px（约 5 字符），拉到 140px（长缩写哈希） */
const MIN_HASH_W = 34;
const MAX_HASH_W = 140;
/** 键盘调列宽步长 */
const COL_KEY_STEP = 10;
const MIN_PANE_W = 240;

/** 面板布局（左图面板宽 + 各列宽），跨 webview 重载保持 */
interface GraphLayout {
  paneW: number;
  /** lane 间距（px）；undefined = 按 lane 数自适应压缩 */
  laneW?: number;
  hashW: number;
  authorW: number;
  dateW: number;
}
const DEFAULT_LAYOUT: GraphLayout = { paneW: 460, hashW: HASH_W, authorW: AUTHOR_W, dateW: DATE_W };

/** 「与当前分支对比」状态 */
interface CompareState {
  /** 对比引用（分支名 / 远程跟踪分支 / 提交号） */
  ref: string;
  /** 展示用短标签 */
  label: string;
  /** diff range：HEAD..ref */
  range: string;
}

/** 行内分支/标签芯片的小图标（head/分支/远程/标签） */
const CHIP_ICONS: Record<'head' | 'branch' | 'remote' | 'tag', string> = {
  head: '<circle cx="4.5" cy="3.6" r="1.7" fill="currentColor"/><circle cx="4.5" cy="12.4" r="1.7" fill="currentColor"/><circle cx="11.5" cy="6" r="1.7" fill="currentColor"/><path d="M4.5 5.3v5.4M11.5 7.7c0 2.7-2.4 4.6-5.6 4.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  branch: '<circle cx="4.5" cy="3.6" r="1.7" fill="currentColor"/><circle cx="4.5" cy="12.4" r="1.7" fill="currentColor"/><circle cx="11.5" cy="6" r="1.7" fill="currentColor"/><path d="M4.5 5.3v5.4M11.5 7.7c0 2.7-2.4 4.6-5.6 4.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  remote:
    '<circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.3 8h11.4M8 2.3c2.3 2.1 3.5 3.7 3.5 5.7s-1.2 3.6-3.5 5.7c-2.3-2.1-3.5-3.7-3.5-5.7S5.7 4.4 8 2.3z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  tag: '<path d="M2.5 8.3V3h5.3L14 9.3l-4.7 4.7z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.7" cy="5.7" r="1.1" fill="currentColor"/>',
};

/** 日期列格式：本年 `MM-dd HH:mm`，往年补年份 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear()
    ? md
    : `${d.getFullYear()}-${md}`;
}

/** 日期预设（与 Intellig log 的 datePreset 对齐） */
const DATE_PRESETS: Array<{ label: string; value: string | undefined }> = [
  { label: '全部时间', value: undefined },
  { label: '最近 24 小时', value: '24h' },
  { label: '最近 7 天', value: '7d' },
];

/**
 * 版本分支图：复刻 TortoiseGit Revision Graph + Intellig Git Log 左侧分栏。
 * 左栏自上而下：筛选行（搜索 + 分支/作者/日期弹出筛选 + 路径/关键字）→
 *  sticky 表头（图沟槽 | 提交 | 消息 | 作者 | 日期，作者/日期列宽可拖拽）→
 *  滚动区（SVG 只画 lane/连线/节点，HTML 行承载文本与行内分支芯片，head 芯片最左）。
 * 右侧为提交详情 / 变更文件 / 差异；支持搜索跳转（Ctrl+F）、面板拖拽分栏、
 * 分支「与当前分支对比」。
 */
export class GraphPanel {
  private nodes: GraphNode[] = [];
  private commits = new Map<string, CommitInfo>();
  private files: CommitFile[] = [];
  private currentFile: CommitFile | undefined;
  private selectedHash: string | undefined;
  private skip = 0;
  private readonly pageSize = 200;
  private noMerges = false;

  // 筛选（弹出式：分支 / 作者 / 日期）
  private branchFilter: string | undefined;
  private authorFilter: string | undefined;
  private since: string | undefined;
  /** 分支弹出列表数据（branch:list，reload 时刷新） */
  private branchInfos: BranchEntry[] = [];

  // 搜索（跳转型：滚动 + 高亮，不改右侧详情）
  private search = '';
  private matchRows: number[] = [];
  private searchPos = -1;

  // 对比模式
  private compare: CompareState | undefined;

  // 布局（持久化）
  private paneW = DEFAULT_LAYOUT.paneW;
  /** undefined = 按 lane 数自适应（压缩图沟槽占用） */
  private laneW: number | undefined;
  private hashW = DEFAULT_LAYOUT.hashW;
  private authorW = DEFAULT_LAYOUT.authorW;
  private dateW = DEFAULT_LAYOUT.dateW;

  private el: HTMLElement;
  private graphEl!: HTMLElement;
  private graphSvgEl!: HTMLElement;
  private rowsEl!: HTMLElement;
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
    const saved = loadState<Partial<GraphLayout>>();
    this.paneW = saved?.paneW && saved.paneW >= MIN_PANE_W ? saved.paneW : DEFAULT_LAYOUT.paneW;
    // laneW 允许 undefined（自适应）；有值时按范围夹紧
    this.laneW =
      typeof saved?.laneW === 'number' && Number.isFinite(saved.laneW)
        ? Math.max(LANE_W_MIN, Math.min(LANE_W_MAX, Math.round(saved.laneW)))
        : undefined;
    this.hashW = this.clamp(saved?.hashW, HASH_W, MIN_HASH_W, MAX_HASH_W);
    this.authorW = this.clampCol(saved?.authorW, AUTHOR_W);
    this.dateW = this.clampCol(saved?.dateW, DATE_W);
    this.el.innerHTML = `
<div class="toolbar">
  <button id="btn-refresh" title="刷新 (F5)">刷新</button>
  <span class="flex"></span>
  <span class="page-info" id="page-info"></span>
  <button id="btn-more" class="mini" title="加载更多">加载更多</button>
</div>
<div class="split" id="split">
  <section class="pane left graph-pane" id="graph-pane" style="width:${this.paneW}px; --col-author-width:${this.authorW}px; --col-date-width:${this.dateW}px; --col-hash-width:${this.hashW}px; --graph-w:60px">
    <div class="log-filter-row">
      <div class="log-filter-search">
        <input type="search" id="flt-search" class="log-filter-search-input" placeholder="搜索 哈希/消息/作者/引用" title="搜索（Ctrl+F 聚焦，回车下一个，Shift+回车上一个）">
        <span class="search-info" id="search-info"></span>
        <button class="mini icon" id="btn-search-prev" title="上一个匹配 (Shift+Enter)">↑</button>
        <button class="mini icon" id="btn-search-next" title="下一个匹配 (Enter)">↓</button>
      </div>
      <div class="log-filter-pop" id="pop-branch-wrap">
        <button type="button" class="log-filter-pop-btn" id="pop-branch-btn" aria-haspopup="true" aria-expanded="false" title="按分支筛选">
          <span class="log-filter-pop-label">分支:</span>
          <span class="log-filter-pop-value" id="pop-branch-value">所有分支</span>
          <span class="log-filter-pop-caret">▾</span>
        </button>
        <div class="log-filter-popup" id="pop-branch" hidden></div>
      </div>
      <div class="log-filter-pop" id="pop-author-wrap">
        <button type="button" class="log-filter-pop-btn" id="pop-author-btn" aria-haspopup="true" aria-expanded="false" title="按作者筛选">
          <span class="log-filter-pop-label">作者:</span>
          <span class="log-filter-pop-value" id="pop-author-value">所有用户</span>
          <span class="log-filter-pop-caret">▾</span>
        </button>
        <div class="log-filter-popup" id="pop-author" hidden></div>
      </div>
      <div class="log-filter-pop" id="pop-date-wrap">
        <button type="button" class="log-filter-pop-btn" id="pop-date-btn" aria-haspopup="true" aria-expanded="false" title="按时间筛选">
          <span class="log-filter-pop-label">日期:</span>
          <span class="log-filter-pop-value" id="pop-date-value">全部时间</span>
          <span class="log-filter-pop-caret">▾</span>
        </button>
        <div class="log-filter-popup" id="pop-date" hidden></div>
      </div>
      <input type="search" id="flt-path" class="filter" placeholder="路径">
      <input type="search" id="flt-grep" class="filter" placeholder="信息关键字">
      <label class="chk"><input type="checkbox" id="chk-nomerge"> 排除合并</label>
    </div>
    <div class="log-column-header">
      <div class="log-column-header-info">
        <div class="log-column-resize-handle first" data-column-resize="graph" role="separator" aria-label="调整图沟槽宽（lane 间距）" tabindex="0" title="拖拽或方向键（±10px）调整图沟槽宽；双击复位为自适应压缩"></div>
        <div class="log-column-header-hash">提交</div>
        <div class="log-column-resize-handle" data-column-resize="hash" role="separator" aria-label="调整提交号列宽" tabindex="0" title="拖拽或方向键（±10px）调整提交号列宽；双击复位"></div>
        <div class="log-column-header-title">消息</div>
        <div class="log-column-resize-handle" data-column-resize="author" role="separator" aria-label="调整作者列宽" tabindex="0" title="拖拽或方向键（±10px）调整作者列宽（消息列随之伸缩）；双击复位"></div>
        <div class="log-column-header-author">作者</div>
        <div class="log-column-resize-handle" data-column-resize="date" role="separator" aria-label="调整日期列宽" tabindex="0" title="拖拽或方向键（±10px）调整日期列宽；双击复位"></div>
        <div class="log-column-header-date">日期</div>
      </div>
    </div>
    <div class="graph-scroll" id="graph-scroll">
      <div class="gp-canvas" id="gp-canvas">
        <div class="gp-graph" id="gp-graph"></div>
        <div class="gp-rows" id="gp-rows"></div>
      </div>
    </div>
  </section>
  <div class="split-handle" id="split-handle" title="拖拽调整面板宽度"></div>
  <section class="pane right">
    <div class="pane-head"><span id="commit-title">提交详情</span></div>
    <div class="commit-detail" id="commit-detail"><div class="empty">点击图中节点查看详情</div></div>
    <div class="pane-head">
      <span id="files-title">变更文件</span><span class="count" id="file-count"></span>
      <span class="flex"></span>
      <button class="mini" id="btn-exit-compare" hidden>退出对比</button>
    </div>
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
    this.graphEl = this.must('graph-pane');
    this.graphSvgEl = this.must('gp-graph');
    this.rowsEl = this.must('gp-rows');
    this.detailEl = this.must('commit-detail');
    this.filesEl = this.must('file-list');
    this.diffEl = this.must('diff-view');
    this.statEl = this.must('diff-stat');

    this.must('btn-refresh').addEventListener('click', () => {
      this.skip = 0;
      void this.reload();
    });
    (this.must('chk-nomerge') as HTMLInputElement).addEventListener('change', (e) => {
      this.noMerges = (e.target as HTMLInputElement).checked;
      this.skip = 0;
      void this.reload();
    });
    for (const id of ['flt-grep', 'flt-path']) {
      this.must(id).addEventListener('change', () => {
        this.skip = 0;
        void this.reload();
      });
    }
    this.must('btn-more').addEventListener('click', () => {
      this.skip += this.pageSize;
      void this.reload(true);
    });
    this.bindSearch();
    this.bindSplitter();
    this.bindColumnResize();
    this.bindPopups();
    this.must('btn-exit-compare').addEventListener('click', () => this.exitCompare());
    this.must('btn-open-editor').addEventListener('click', () => {
      const file = this.currentFile;
      if (!file) return;
      if (this.compare) {
        this.client.command('openRangeDiff', {
          repoRoot: this.repoRoot,
          path: file.path,
          left: 'HEAD',
          right: this.compare.ref,
          label: `${this.compare.label} ↔ HEAD`,
        });
      } else if (this.selectedHash) {
        this.client.command('openCommitDiff', { hash: this.selectedHash, path: file.path });
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        this.skip = 0;
        void this.reload();
      }
      if (e.key === 'Escape') this.closeAllPopups();
      // Ctrl/Cmd+F 聚焦搜索框（对齐 Intellig 的 jumpToHash 快捷键）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const input = this.must('flt-search') as HTMLInputElement;
        input.focus();
        input.select();
      }
    });
  }

  private must(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing element: ' + id);
    return el;
  }

  private clampCol(w: number | undefined, fallback: number): number {
    return this.clamp(w, fallback, MIN_COL_W, MAX_COL_W);
  }

  private clamp(w: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof w !== 'number' || !Number.isFinite(w)) return fallback;
    return Math.max(min, Math.min(max, Math.round(w)));
  }

  // ---------- 搜索（跳转） ----------

  private bindSearch(): void {
    const input = this.must('flt-search') as HTMLInputElement;
    input.addEventListener('input', () => {
      this.search = input.value;
      this.matchRows = searchMatches(this.nodes, this.search);
      this.searchPos = this.matchRows.length ? 0 : -1;
      this.updateSearchInfo();
      if (this.searchPos >= 0) this.scrollToMatch(this.matchRows[0]!);
      this.renderGraph();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.jumpToMatch(e.shiftKey ? -1 : 1);
      }
    });
    this.must('btn-search-next').addEventListener('click', () => this.jumpToMatch(1));
    this.must('btn-search-prev').addEventListener('click', () => this.jumpToMatch(-1));
  }

  private jumpToMatch(dir: 1 | -1): void {
    if (!this.matchRows.length) return;
    this.searchPos = (this.searchPos + dir + this.matchRows.length) % this.matchRows.length;
    this.scrollToMatch(this.matchRows[this.searchPos]!);
    this.renderGraph();
    this.updateSearchInfo();
  }

  private scrollToMatch(row: number): void {
    const scroller = this.must('graph-scroll');
    const top = row * ROW_H - scroller.clientHeight / 2 + ROW_H / 2;
    scroller.scrollTop = Math.max(0, top);
  }

  private updateSearchInfo(): void {
    const el = this.must('search-info');
    if (!this.search.trim()) {
      el.textContent = '';
      return;
    }
    el.textContent = this.matchRows.length ? `${this.searchPos + 1}/${this.matchRows.length}` : '无匹配';
  }

  // ---------- 弹出式筛选（分支 / 作者 / 日期） ----------

  private bindPopups(): void {
    const wraps = ['pop-branch-wrap', 'pop-author-wrap', 'pop-date-wrap'];
    for (const id of wraps) {
      const wrap = this.must(id);
      const btn = wrap.querySelector('.log-filter-pop-btn');
      const pop = wrap.querySelector('.log-filter-popup') as HTMLElement;
      btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = pop.hidden;
        this.closeAllPopups();
        pop.hidden = !willOpen;
        btn.setAttribute('aria-expanded', String(willOpen));
      });
      // 弹窗内点击不冒泡到 document（否则立即被关掉）
      pop.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', () => this.closeAllPopups());
  }

  private closeAllPopups(): void {
    for (const id of ['pop-branch-wrap', 'pop-author-wrap', 'pop-date-wrap']) {
      const wrap = this.must(id);
      const pop = wrap.querySelector('.log-filter-popup') as HTMLElement;
      const btn = wrap.querySelector('.log-filter-pop-btn');
      pop.hidden = true;
      btn?.setAttribute('aria-expanded', 'false');
    }
  }

  /** 重建三个弹窗的内容（reload 后调用：分支/作者列表随数据变化） */
  private renderPopups(): void {
    // 分支：所有分支（清空筛选）+ 本地/远程分组（branch:list 全量数据）
    const locals = this.branchInfos.filter((b) => !b.isRemote);
    const remotes = this.branchInfos.filter((b) => b.isRemote);
    const branchItems: string[] = [
      this.popupItem('所有分支', '', !this.branchFilter, '显示所有分支的提交'),
    ];
    if (locals.length) {
      branchItems.push('<div class="log-filter-popup-section">本地分支</div>');
      for (const b of locals) {
        branchItems.push(this.popupItem(b.shortName || b.name, b.name, this.branchFilter === b.name, b.name));
      }
    }
    if (remotes.length) {
      branchItems.push('<div class="log-filter-popup-section">远程分支</div>');
      for (const b of remotes) {
        branchItems.push(this.popupItem(b.name, b.name, this.branchFilter === b.name, b.name));
      }
    }
    this.fillPopup('pop-branch', branchItems, (value) => {
      this.branchFilter = value || undefined;
      this.must('pop-branch-value').textContent = value || '所有分支';
      this.skip = 0;
      void this.reload();
    });

    // 作者：当前已加载提交里去重（Intellig 的 user 过滤器同理）
    const authors: string[] = [];
    for (const n of this.nodes) {
      const a = n.commit.author;
      if (a && !authors.includes(a)) authors.push(a);
    }
    authors.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const authorItems: string[] = [this.popupItem('所有用户', '', !this.authorFilter, '显示所有作者的提交')];
    for (const a of authors) {
      authorItems.push(this.popupItem(a, a, this.authorFilter === a, a));
    }
    this.fillPopup('pop-author', authorItems, (value) => {
      this.authorFilter = value || undefined;
      this.must('pop-author-value').textContent = value || '所有用户';
      this.skip = 0;
      void this.reload();
    });

    // 日期：静态预设
    const dateItems = DATE_PRESETS.map((p) =>
      this.popupItem(p.label, p.value ?? '', this.since === p.value, p.label),
    );
    this.fillPopup('pop-date', dateItems, (value) => {
      this.since = value || undefined;
      const preset = DATE_PRESETS.find((p) => (p.value ?? '') === value);
      this.must('pop-date-value').textContent = preset?.label ?? '全部时间';
      this.skip = 0;
      void this.reload();
    });
  }

  private popupItem(label: string, value: string, active: boolean, title: string): string {
    return `<button type="button" class="log-filter-popup-item${active ? ' active' : ''}" data-value="${this.escAttr(value)}" title="${this.escAttr(title)}"><span class="log-filter-tree-check">${active ? '✓' : ''}</span>${this.esc(label)}</button>`;
  }

  private fillPopup(id: string, items: string[], onPick: (value: string) => void): void {
    const pop = this.must(id);
    pop.innerHTML = items.join('');
    pop.querySelectorAll<HTMLElement>('.log-filter-popup-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.closeAllPopups();
        onPick(btn.dataset.value ?? '');
      });
    });
  }

  // ---------- 可拖拽分栏（左图面板 | 右详情面板） ----------

  private bindSplitter(): void {
    const handle = this.must('split-handle');
    const pane = this.must('graph-pane');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = pane.clientWidth;
      const maxW = Math.max(MIN_PANE_W, this.must('split').clientWidth * 0.75);
      const onMove = (ev: MouseEvent): void => {
        this.paneW = Math.max(MIN_PANE_W, Math.min(maxW, startW + ev.clientX - startX));
        pane.style.width = `${this.paneW}px`;
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        this.persistLayout();
      };
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- 表头列宽调整（图沟槽 / 提交号 / 作者 / 日期） ----------

  /**
   * 各列宽由 CSS 变量驱动，拖拽时只 setProperty 即可（表头与全部行即时跟随，无需重渲染）；
   * 只有图沟槽例外——lane 间距变了要重排 SVG 里的连线与节点，故需 renderGraph。
   * 消息列是弹性列（flex:1），宽度 = 剩余空间，通过其两侧的列宽反向调节。
   */
  private bindColumnResize(): void {
    this.graphEl.querySelectorAll<HTMLElement>('.log-column-resize-handle').forEach((h) => {
      const which = (h.dataset.columnResize ?? 'author') as 'graph' | 'hash' | 'author' | 'date';
      h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = this.colWidth(which);
        document.body.classList.add('resizing-column');
        h.classList.add('dragging');
        const onMove = (ev: MouseEvent): void => this.setColWidth(which, startW + ev.clientX - startX);
        const onUp = (): void => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('resizing-column');
          h.classList.remove('dragging');
          this.persistLayout();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      // 键盘微调（Intellig：聚焦手柄后方向键 ±10px）
      h.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowLeft' ? -COL_KEY_STEP : e.key === 'ArrowRight' ? COL_KEY_STEP : 0;
        if (!step) return;
        e.preventDefault();
        this.setColWidth(which, this.colWidth(which) + step);
        this.persistLayout();
      });
      // 双击复位该列（图沟槽复位为「按 lane 数自适应压缩」）
      h.addEventListener('dblclick', () => {
        if (which === 'graph') this.laneW = undefined;
        else if (which === 'hash') this.hashW = HASH_W;
        else if (which === 'author') this.authorW = AUTHOR_W;
        else this.dateW = DATE_W;
        this.renderGraph();
        this.persistLayout();
      });
    });
  }

  /** 当前列宽（图沟槽 = 实际占用宽度，其余为列宽） */
  private colWidth(which: 'graph' | 'hash' | 'author' | 'date'): number {
    // 与实际渲染宽度同源（含 GRAPH_W_MIN 下限），否则拖拽起点会偏
    if (which === 'graph') return graphWidth(this.laneCount(), this.currentLaneW());
    if (which === 'hash') return this.hashW;
    return which === 'author' ? this.authorW : this.dateW;
  }

  /** 设置列宽（内部夹紧）：图沟槽换算成 lane 间距并触发重绘 */
  private setColWidth(which: 'graph' | 'hash' | 'author' | 'date', w: number): void {
    if (which === 'graph') {
      const lanes = Math.max(1, this.laneCount());
      const laneW = Math.max(LANE_W_MIN, Math.min(LANE_W_MAX, (w - 6) / lanes));
      this.laneW = laneW;
      this.renderGraph();
      return;
    }
    if (which === 'hash') {
      this.hashW = this.clamp(w, HASH_W, MIN_HASH_W, MAX_HASH_W);
      this.graphEl.style.setProperty('--col-hash-width', `${this.hashW}px`);
      return;
    }
    const varName = which === 'author' ? '--col-author-width' : '--col-date-width';
    const next = this.clamp(w, which === 'author' ? AUTHOR_W : DATE_W, MIN_COL_W, MAX_COL_W);
    if (which === 'author') this.authorW = next;
    else this.dateW = next;
    this.graphEl.style.setProperty(varName, `${next}px`);
  }

  private laneCount(): number {
    if (!this.nodes.length) return 1;
    return this.nodes.reduce((m, n) => Math.max(m, n.lane, ...n.parentLanes), 0) + 1;
  }

  /** 当前 lane 间距：用户拖过就用用户值，否则按 lane 数自适应压缩 */
  private currentLaneW(): number {
    if (typeof this.laneW === 'number' && Number.isFinite(this.laneW)) return this.laneW;
    return autoLaneWidth(this.laneCount());
  }

  private readColW(varName: string): number {
    const raw = getComputedStyle(this.graphEl).getPropertyValue(varName);
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  private persistLayout(): void {
    saveState({
      ...(loadState<object>() ?? {}),
      paneW: this.paneW,
      laneW: this.laneW,
      hashW: this.hashW,
      authorW: this.authorW,
      dateW: this.dateW,
    });
  }

  private async reload(append = false): Promise<void> {
    try {
      const [commits, branches] = await Promise.all([
        this.client.send('log:list', {
          repoRoot: this.repoRoot,
          skip: this.skip,
          limit: this.pageSize,
          all: !this.branchFilter,
          noMerges: this.noMerges,
          author: this.authorFilter,
          grep: (this.must('flt-grep') as HTMLInputElement).value.trim() || undefined,
          path: (this.must('flt-path') as HTMLInputElement).value.trim() || undefined,
          branch: this.branchFilter,
          since: this.since,
        }),
        this.client.send('branch:list', { repoRoot: this.repoRoot }).catch(() => [] as BranchEntry[]),
      ]);
      this.branchInfos = branches;
      if (append) {
        this.nodes = [...this.nodes, ...computeLanes(commits)];
      } else {
        this.nodes = computeLanes(commits);
      }
      for (const c of commits) this.commits.set(c.hash, c);
      // 列表变化后重算搜索匹配（保持计数与跳转有效）
      if (this.search.trim()) {
        this.matchRows = searchMatches(this.nodes, this.search);
        this.searchPos = this.matchRows.length ? 0 : -1;
        this.updateSearchInfo();
      }
      this.renderGraph();
      this.renderPopups();
      this.must('page-info').textContent = `${this.nodes.length} 个提交`;
    } catch (err) {
      this.rowsEl.innerHTML = `<div class="gp-empty">读取失败：${this.esc(String(err))}</div>`;
    }
  }

  // ---------- 图渲染 ----------

  private renderGraph(): void {
    const height = this.nodes.length * ROW_H + 10;
    const laneCount = this.laneCount();
    // 图沟槽宽：只放 lane 连线与节点；lane 越多间距越小，尽量少占宽度（可拖拽微调）
    const laneW = this.currentLaneW();
    const graphW = graphWidth(laneCount, laneW);
    const nodeR = nodeRadius(laneW);
    this.graphEl.style.setProperty('--graph-w', `${graphW}px`);
    this.graphEl.style.setProperty('--col-hash-width', `${this.hashW}px`);
    (this.must('gp-canvas')).style.height = `${height}px`;

    const parts: string[] = [];
    // 连线：连到父提交的真实行（拓扑序里父提交可能隔着多行）
    for (const e of buildEdges(this.nodes)) {
      const x1 = e.fromLane * laneW + laneW / 2;
      const y1 = e.fromRow * ROW_H + ROW_H / 2;
      const x2 = e.toLane * laneW + laneW / 2;
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
    // 节点：按 lane 着色；HEAD 加粗描边，选中再加一圈
    this.nodes.forEach((node, row) => {
      const y = row * ROW_H + ROW_H / 2;
      const x = node.lane * laneW + laneW / 2;
      const isHead = isHeadCommit(node.commit);
      const selected = this.selectedHash === node.commit.hash;
      const cls = `node${isHead ? ' head' : ''}${selected ? ' selected' : ''}`;
      parts.push(`<circle cx="${x}" cy="${y}" r="${nodeR}" class="${cls}" fill="${laneColor(node.lane)}"/>`);
    });
    this.graphSvgEl.innerHTML = `<svg width="${graphW}" height="${height}" viewBox="0 0 ${graphW} ${height}" class="graph-svg">${parts.join('')}</svg>`;

    // HTML 行：文本 + 行内分支芯片（head 芯片最左）
    if (!this.nodes.length) {
      const filtered = !!(this.branchFilter || this.authorFilter || this.since || this.noMerges);
      this.rowsEl.innerHTML = `<div class="gp-empty">${
        filtered
          ? '没有符合当前筛选条件的提交'
          : '该仓库还没有提交'
      }</div>`;
      return;
    }
    this.rowsEl.innerHTML = this.nodes.map((node, row) => this.rowHtml(node, row)).join('');
    this.rowsEl.querySelectorAll<HTMLElement>('.commit-row').forEach((row) => {
      const hash = row.dataset.hash!;
      row.addEventListener('click', () => void this.selectCommit(hash));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void this.selectCommit(hash);
        this.showContextMenu(e.clientX, e.clientY, hash);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void this.selectCommit(hash);
        }
      });
    });
    this.rowsEl.querySelectorAll<HTMLElement>('.branch-label-collapsed').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        let names: string[] = [];
        try {
          names = JSON.parse(chip.dataset.collapsed ?? '[]') as string[];
        } catch {
          names = [];
        }
        showMenuAt(
          this.must('ctx-menu'),
          e.clientX,
          e.clientY,
          names.map((n) => ({ label: n })),
          () => undefined,
        );
      });
    });
  }

  private rowHtml(node: GraphNode, row: number): string {
    const c = node.commit;
    const selected = this.selectedHash === c.hash;
    const hit = this.searchPos >= 0 && this.matchRows[this.searchPos] === row;
    const { chips, collapsed } = branchChips(c.refs);
    const color = laneColor(node.lane);
    const chipsHtml = chips
      .map(
        (ch) =>
          `<span class="branch-label branch-label-${ch.kind}" data-branch="${this.escAttr(ch.text)}" title="${this.escAttr(ch.title)}"><svg class="chip-ico" viewBox="0 0 16 16" aria-hidden="true">${CHIP_ICONS[ch.kind]}</svg><span class="branch-label-name">${this.esc(ch.text)}</span></span>`,
      )
      .join('');
    const collapsedHtml = collapsed.length
      ? `<span class="branch-label branch-label-collapsed" data-collapsed="${this.escAttr(JSON.stringify(collapsed))}" title="还有 ${collapsed.length} 个分支：${this.escAttr(collapsed.join('、'))}" role="button" tabindex="0">+${collapsed.length}</span>`
      : '';
    const dateFull = new Date(c.authorDate).toLocaleString();
    return `<div class="commit-row${selected ? ' selected' : ''}${hit ? ' hit' : ''}" data-hash="${c.hash}" data-row="${row}" role="option" tabindex="0" aria-selected="${selected}">
  <div class="commit-info">
    <span class="commit-hash" title="${c.hash}">${c.shortHash}</span>
    <div class="commit-title" title="${this.escAttr(c.subject)}">${this.esc(c.subject)}</div>
    <div class="commit-branches" style="--chip-color:${color}">${chipsHtml}${collapsedHtml}</div>
    <span class="commit-author" title="${this.escAttr(c.author)} &lt;${this.escAttr(c.authorEmail)}&gt;">${this.esc(c.author)}</span>
    <span class="commit-date" title="${this.escAttr(dateFull)}">${this.esc(fmtDate(c.authorDate))}</span>
  </div>
</div>`;
  }

  // ---------- 详情 ----------

  private async selectCommit(hash: string): Promise<void> {
    this.clearCompareUi();
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

  // ---------- 与当前分支对比 ----------

  /** 右键「与当前分支对比…」：右侧面板切换为 HEAD ↔ 选中引用 的差异视图 */
  private async startCompare(hash: string): Promise<void> {
    const commit = this.commits.get(hash);
    if (!commit) return;
    if (isHeadCommit(commit)) {
      toast('该提交就是当前分支（HEAD），无需对比');
      return;
    }
    const ref = pickCompareRef(commit);
    const label = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
    this.compare = { ref, label, range: `HEAD..${ref}` };
    this.selectedHash = undefined;
    this.currentFile = undefined;
    this.renderGraph();
    this.must('commit-title').textContent = `对比：${label} ↔ 当前分支 (HEAD)`;
    this.detailEl.innerHTML = `<div class="compare-banner">对比范围 <span class="mono">HEAD..${this.esc(ref)}</span>：从当前分支到 ${this.esc(label)} 的全部差异。<br>点击下方文件查看逐文件差异；点击图中任意节点退出对比。</div>`;
    this.must('files-title').textContent = '变更文件（对比）';
    this.must('btn-exit-compare').hidden = false;
    try {
      this.files = await this.client.send('diff:files', {
        repoRoot: this.repoRoot,
        range: this.compare.range,
      });
    } catch (err) {
      this.files = [];
      toast(`读取对比文件失败：${String(err)}`, true);
    }
    this.renderFiles();
  }

  private clearCompareUi(): void {
    if (!this.compare) return;
    this.compare = undefined;
    this.must('btn-exit-compare').hidden = true;
    this.must('files-title').textContent = '变更文件';
  }

  private exitCompare(): void {
    const had = this.selectedHash;
    this.clearCompareUi();
    if (had && this.commits.has(had)) {
      void this.selectCommit(had);
      return;
    }
    this.files = [];
    this.currentFile = undefined;
    this.must('commit-title').textContent = '提交详情';
    this.detailEl.innerHTML = '<div class="empty">点击图中节点查看详情</div>';
    this.renderFiles();
    void this.showDiff();
  }

  private renderFiles(): void {
    this.must('file-count').textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.filesEl.innerHTML = this.compare
        ? '<div class="empty">两个分支内容一致（无差异文件）</div>'
        : '<div class="empty">该提交没有文件变更</div>';
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
    const range = this.compare
      ? this.compare.range
      : this.selectedHash
        ? `${this.selectedHash}^..${this.selectedHash}`
        : undefined;
    if (!this.currentFile || !range) {
      this.diffEl.innerHTML = '<div class="diff-empty">选择文件以查看差异</div>';
      return;
    }
    try {
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: this.currentFile.path,
        staged: false,
        range,
      });
      this.diffEl.innerHTML = renderDiff(patch, 'side', tail, this.currentFile.path);
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
    const commit = this.commits.get(hash);
    const items: Array<{ label: string; action: () => void }> = [
      { label: '检出 (Checkout)', action: () => void this.runAction('checkout', hash) },
    ];
    // 非 HEAD 提交才提供对比（HEAD 与自身对比无意义）
    if (commit && !isHeadCommit(commit)) {
      items.push({ label: '与当前分支对比…', action: () => void this.startCompare(hash) });
    }
    items.push(
      { label: '在此创建分支…', action: () => void this.runAction('branch', hash) },
      { label: '在此创建标签…', action: () => void this.runAction('tag', hash) },
      { label: '合并到此 (Merge)', action: () => void this.runAction('merge', hash) },
      { label: '拣选到当前分支 (Cherry-pick)', action: () => void this.runAction('cherry', hash) },
      { label: '重置到此处 (Reset)', action: () => void this.runAction('reset', hash) },
      { label: '还原此提交 (Revert)', action: () => void this.runAction('revert', hash) },
    );
    showMenuAt(
      this.must('ctx-menu'),
      x,
      y,
      items.map((it) => ({ label: it.label })),
      (i) => items[i]?.action(),
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
