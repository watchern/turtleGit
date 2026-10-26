import { RpcClient } from '../bridge';
import { renderDiff, patchStat } from '../diff/DiffRenderer';
import { bindDiffInteractions, loadPatchAndCounts } from '../diff/expander';
import { escapeHtml } from '../ui/dialogs';
import { buildFileTree, collectDirs, collectFiles, FileTreeNode } from '../ui/fileTree';
import { loadState, saveState } from '../state';
import { CommitFile } from '../../shared/protocol';

/** 左栏最小/默认宽（拖拽分栏） */
const MIN_PANE_W = 180;
const DEFAULT_PANE_W = 300;

/** 面板布局持久化（左栏宽 + 视图模式） */
interface CompareLayout {
  paneW: number;
  mode: 'side' | 'unified';
}

/** CommitFile.status → 徽标文案 / 配色（沿用 Stash 面板的语义） */
const STATUS_CN: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型',
  U: '冲突',
};

function statusCls(s: string): string {
  if (s === 'A') return 'st-staged';
  if (s === 'D') return 'st-untracked';
  return 'st-modified';
}

const esc = (s: string): string => escapeHtml(s);
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

/**
 * 分支对比面板（主窗口编辑器标签内打开）：左「变更文件树」| 右「文件差异」。
 *
 * 与 StashPanel 的区别：
 * - 对比的是两个任意引用（base…target），range 为 `base..target`；
 * - 左栏是**目录树**（TortoiseGit 风格），可折叠目录，而非平铺列表；
 * - 分栏可拖拽，宽度与视图模式（并排/统一）跨 webview 重载保持。
 *
 * diff 语义：`git diff base..target -- <path>`，即「从 base 变到 target 的改动」，
 * 左侧行号 = base 版本，右侧 = target 版本。
 */
export class ComparePanel {
  private files: CommitFile[] = [];
  private current: CommitFile | undefined;
  private collapsedDirs = new Set<string>();
  private base: string;
  private target: string;
  private mode: 'side' | 'unified';
  private paneW: number;
  private loading = false;

  private el: HTMLElement;
  private paneEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private statEl!: HTMLElement;
  private countEl!: HTMLElement;

  constructor(
    root: HTMLElement,
    private client: RpcClient,
    private repoRoot: string,
    compare?: { base: string; target: string },
  ) {
    this.el = root;
    this.base = compare?.base ?? 'HEAD';
    this.target = compare?.target ?? 'HEAD';
    const saved = loadState<Partial<CompareLayout>>();
    this.paneW = typeof saved?.paneW === 'number' ? saved.paneW : DEFAULT_PANE_W;
    this.mode = saved?.mode === 'unified' ? 'unified' : 'side';
    this.build();
    this.bindSplitter();
    void this.reload();
  }

  /** diff range：始终为 `base..target`（交换方向即交换两侧引用） */
  private get range(): string {
    return `${this.base}..${this.target}`;
  }

  // ---------- UI 骨架 ----------

  private build(): void {
    this.el.innerHTML = `
<div class="toolbar">
  <span class="cmp-refs" title="对比方向：左=基线，右=目标">
    <span class="cmp-ref base" id="cmp-base"></span>
    <span class="cmp-arrow" title="→ 的改动">→</span>
    <span class="cmp-ref target" id="cmp-target"></span>
  </span>
  <button id="cmp-swap" title="交换对比方向（左右互换）">交换</button>
  <button id="cmp-refresh" title="刷新 (F5)">刷新</button>
  <span class="sep"></span>
  <button id="cmp-mode" title="切换并排 / 统一视图"></button>
  <span class="flex"></span>
  <span class="repo-name" id="cmp-repo"></span>
</div>
<div class="split cmp-split" id="cmp-split">
  <section class="pane left" id="cmp-pane" style="width:${this.paneW}px">
    <div class="pane-head">
      <span>变更文件</span><span class="count" id="cmp-count"></span>
      <span class="flex"></span>
      <button class="mini" id="cmp-collapse" title="全部折叠">－</button>
      <button class="mini" id="cmp-expand" title="全部展开">＋</button>
    </div>
    <div class="file-list" id="cmp-tree"><div class="empty">载入中…</div></div>
  </section>
  <div class="split-handle" id="cmp-handle" title="拖拽调整左栏宽度"></div>
  <section class="pane right">
    <div class="pane-head">
      <span id="cmp-title">差异</span><span class="diff-stat" id="cmp-stat"></span>
      <span class="flex"></span>
      <button class="mini" id="cmp-open-editor" title="在 VSCode 原生 diff 编辑器中打开（左=基线，右=目标）" disabled>在编辑器中打开</button>
    </div>
    <div class="diff-view full" id="cmp-diff"><div class="diff-empty">选择文件查看差异</div></div>
  </section>
</div>
`;
    this.paneEl = this.must('cmp-pane');
    this.treeEl = this.must('cmp-tree');
    this.diffEl = this.must('cmp-diff');
    this.titleEl = this.must('cmp-title');
    this.statEl = this.must('cmp-stat');
    this.countEl = this.must('cmp-count');

    this.must('cmp-refresh').addEventListener('click', () => void this.reload());
    this.must('cmp-swap').addEventListener('click', () => {
      const b = this.base;
      this.base = this.target;
      this.target = b;
      void this.reload();
    });
    this.must('cmp-mode').addEventListener('click', () => {
      this.mode = this.mode === 'side' ? 'unified' : 'side';
      this.syncModeButton();
      this.persistLayout();
      void this.showDiff();
    });
    this.must('cmp-collapse').addEventListener('click', () => {
      this.collapsedDirs = new Set(collectDirs(buildFileTree(this.files)));
      this.renderTree();
    });
    this.must('cmp-expand').addEventListener('click', () => {
      this.collapsedDirs.clear();
      this.renderTree();
    });
    this.must('cmp-open-editor').addEventListener('click', () => {
      if (!this.current) return;
      this.client.command('openRangeDiff', {
        repoRoot: this.repoRoot,
        path: this.current.path,
        left: this.base,
        right: this.target,
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        void this.reload();
      }
    });

    this.syncModeButton();
    void this.loadRepoName();
  }

  private must(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error('missing element: ' + id);
    return el;
  }

  private syncModeButton(): void {
    this.must('cmp-mode').textContent = this.mode === 'side' ? '统一视图' : '并排视图';
    this.must('cmp-base').textContent = this.base;
    this.must('cmp-target').textContent = this.target;
  }

  private async loadRepoName(): Promise<void> {
    try {
      const info = await this.client.send('repo:info', { repoRoot: this.repoRoot });
      this.must('cmp-repo').textContent = `${this.repoRoot}  [${info.name}]`;
    } catch {
      this.must('cmp-repo').textContent = this.repoRoot;
    }
  }

  // ---------- 可拖拽分栏 ----------

  private bindSplitter(): void {
    const handle = this.must('cmp-handle');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.paneEl.clientWidth;
      const maxW = Math.max(MIN_PANE_W, this.must('cmp-split').clientWidth * 0.75);
      const onMove = (ev: MouseEvent): void => {
        this.paneW = Math.max(MIN_PANE_W, Math.min(maxW, startW + ev.clientX - startX));
        this.paneEl.style.width = `${this.paneW}px`;
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

  private persistLayout(): void {
    saveState({ ...(loadState<object>() ?? {}), paneW: this.paneW, mode: this.mode });
  }

  // ---------- 数据 ----------

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.syncModeButton();
    try {
      this.files = await this.client.send('diff:files', { repoRoot: this.repoRoot, range: this.range });
    } catch (err) {
      this.files = [];
      this.treeEl.innerHTML = `<div class="empty">读取失败：${esc(String(err))}</div>`;
      this.countEl.textContent = '';
      this.showEmptyDiff();
      return;
    } finally {
      this.loading = false;
    }
    // 刷新后若原选中文件已不在变更集中则清空
    if (this.current && !this.files.some((f) => f.path === this.current!.path)) {
      this.current = undefined;
    }
    this.renderTree();
    if (!this.current && this.files.length) {
      this.current = this.files[0];
      this.renderTree();
      await this.showDiff();
    } else if (this.current) {
      await this.showDiff();
    } else {
      this.showEmptyDiff();
    }
  }

  // ---------- 左栏：文件树 ----------

  private renderTree(): void {
    this.countEl.textContent = `（${this.files.length}）`;
    if (!this.files.length) {
      this.treeEl.innerHTML = '<div class="empty">两个引用之间没有差异</div>';
      return;
    }
    this.treeEl.innerHTML = this.renderNodes(buildFileTree(this.files), 0);
    this.bindTreeEvents();
  }

  private renderNodes(nodes: FileTreeNode<CommitFile>[], depth: number): string {
    return nodes
      .map((n) => {
        if (n.kind === 'dir') {
          const collapsed = this.collapsedDirs.has(n.path);
          const childFiles = collectFiles(n);
          const changed = childFiles.length;
          const indent = depth * 10;
          const twisty = `<span class="dir-twisty${collapsed ? '' : ' open'}" title="展开/折叠"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 1.5 8.5 6 4.5 10.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
          const row = `<div class="dir-row" data-dir="${escAttr(n.path)}" style="padding-left:${indent}px" title="${escAttr(n.path)}">
  ${twisty}
  <span class="dir-name">${esc(n.label)}</span>
  <span class="dir-count">${changed}</span>
</div>`;
          return collapsed ? row : row + this.renderNodes(n.children ?? [], depth + 1);
        }
        const f = n.file!;
        const indent = depth * 10 + 12;
        const stat = f.isBinary ? '二进制' : `<span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span>`;
        const rename = f.oldPath ? `<span class="rename">← ${esc(f.oldPath)}</span>` : '';
        return `<div class="file-row${this.current?.path === f.path ? ' active' : ''}" data-path="${escAttr(f.path)}" style="padding-left:${indent}px" title="${escAttr(f.path)}">
  <span class="badge ${statusCls(f.status)}" title="${escAttr(STATUS_CN[f.status] ?? f.status)}">${f.status}</span>
  <span class="file-stat">${stat}</span>
  <span class="file-name">${esc(n.label)}${rename}</span>
</div>`;
      })
      .join('');
  }

  private bindTreeEvents(): void {
    this.treeEl.querySelectorAll<HTMLElement>('.dir-row').forEach((row) => {
      row.addEventListener('click', () => {
        const dir = row.dataset.dir ?? '';
        if (this.collapsedDirs.has(dir)) this.collapsedDirs.delete(dir);
        else this.collapsedDirs.add(dir);
        this.renderTree();
      });
    });
    this.treeEl.querySelectorAll<HTMLElement>('.file-row').forEach((row) => {
      row.addEventListener('click', () => {
        const path = row.dataset.path ?? '';
        const hit = this.files.find((f) => f.path === path);
        if (!hit || this.current?.path === path) return;
        this.current = hit;
        this.renderTree();
        void this.showDiff();
      });
    });
  }

  // ---------- 右栏：差异 ----------

  private showEmptyDiff(): void {
    this.diffEl.innerHTML = this.files.length
      ? '<div class="diff-empty">选择文件查看差异</div>'
      : '<div class="diff-empty">两个引用之间没有差异</div>';
    this.statEl.textContent = '';
    this.titleEl.textContent = '差异';
    (this.must('cmp-open-editor') as HTMLButtonElement).disabled = true;
  }

  private async showDiff(): Promise<void> {
    if (!this.current) {
      this.showEmptyDiff();
      return;
    }
    const file = this.current;
    (this.must('cmp-open-editor') as HTMLButtonElement).disabled = false;
    this.titleEl.textContent = file.path;
    try {
      const { patch, tail } = await loadPatchAndCounts(this.client, {
        repoRoot: this.repoRoot,
        path: file.path,
        staged: false,
        range: this.range,
      });
      this.diffEl.innerHTML = renderDiff(patch, this.mode, tail, file.path);
      bindDiffInteractions(
        this.diffEl,
        this.client,
        { repoRoot: this.repoRoot, path: file.path, staged: false, range: this.range },
        this.mode,
      );
      const stat = patchStat(patch);
      this.statEl.textContent = stat.additions || stat.deletions ? `+${stat.additions} -${stat.deletions}` : '';
    } catch (err) {
      this.diffEl.innerHTML = `<div class="diff-empty">无法读取差异：${esc(String(err))}</div>`;
      this.statEl.textContent = '';
    }
  }
}
