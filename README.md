# TurtleGit

在 VSCode 中复刻 **TortoiseGit** 界面与使用习惯的 Git 增强插件：**侧边栏内完成提交**、版本分支图、双栏差异对比、Stash / Blame / 日志，全部走插件自身的 git CLI 调用。

**为什么做这个**：TortoiseGit 只支持 Windows，Linux 上没有等价产品。TurtleGit 用纯 VSCode 插件实现同一套交互习惯，**不调用 TortoiseGit、不依赖任何外部 GUI 进程**，Linux / macOS / Windows 通用。

> 状态：核心闭环已实现，数据层冒烟测试 **349** 项断言全通过。尚未在真实 VSCode 中端到端联调（见「已知限制」）。

## 快速开始

```bash
pnpm install
pnpm run compile    # 构建 dist/extension.js 与 dist/webview/main.js
pnpm test           # 数据层冒烟测试（临时仓库，跨平台断言）
```

在本项目按 **F5** 启动扩展开发主机，在新窗口打开任意 git 仓库即可体验。

## 功能

### 侧边栏：提交

提交全部在侧边栏完成，**不再弹独立对话框**。

- 文件勾选（树形 / 列表两种视图，目录复选框整目录勾选）、每文件增删徽标 `+N -M`、选中文件总数与总增删统计
- 提交信息、签署（Signed-off-by，可指定签署人）、整行提交按钮
- **提交按钮下拉**：默认普通提交，可切换为**修订提交（Amend）** / **提交后推送**；文案随模式变化，提交成功后复位
- 点击文件直接用 **VSCode 原生 diff** 打开（HEAD ↔ 工作区，未跟踪文件直接打开）
- 文件 / 目录右键：比较差异、在编辑器中打开、暂存、取消暂存、放弃修改、添加到忽略列表（二级菜单选 `.gitignore` / `.git/info/exclude`，目录可选整目录或逐文件）
- 状态用单字母彩色标记（M/A/D/R/T/C/U/!），悬停显示中文说明
- 提交信息与勾选状态经 webview 状态持久化；视图重新可见或窗口重新获得焦点时自动刷新

### 侧边栏：分支

参考 IntelliJ IDEA 的 Branches 面板。

- **当前分支**：显示 ↑领先 / ↓落后，标题行右侧为拉取 / 推送 / 刷新图标与筛选框
- **本地分支**：当前置顶（绿色对勾），点击检出（**二次确认**）；行内悬停 ✎ 重命名 / ✕ 删除；右键可检出、基于此新建、**与当前分支对比**、合并到当前、变基当前到此、重命名、删除（未合并被拒时追问 `-D`）
- **远程分支**：按 remote 分组折叠，仓名与分支为清晰的父子层级；检出为同名本地分支并 `--track`
- **远程仓库**：新增 / 改拉取·推送地址 / 删除 / **同步引用（`git fetch`）**

### 侧边栏：暂存（Stash）

单行展示 `stash@{n}` + 提交哈希 + 消息；保存（带消息）、Apply / Pop / Drop；点击行在**主窗口**打开 Stash 面板，按文件逐条查看改动，并可起原生 diff。

### 版本分支图

复刻 TortoiseGit Revision Graph + Intellig Git Log 的左栏：

- SVG lane 图：连线按父提交的真实行号绘制、节点按 lane 着色、lane 间距按条数自适应压缩
- **左栏三段式**：顶部筛选行（搜索 + 分支/作者/日期弹出筛选 + 路径/关键字 + 排除合并）→ sticky 表头（图沟槽 | 提交 | 消息 | 作者 | 日期）→ 滚动区
- **各列列宽可拖拽**：每个分隔符调整它**左侧**那一列，支持方向键 ±10px、双击复位，松手持久化
- 分支 / 标签以行内芯片展示在消息列（当前分支芯片加粗 + 描边环并排最左，超过 3 个折叠为 `+N`）
- 提交详情 + 变更文件 + 差异；节点右键全套操作（检出/建分支/打标签/合并/拣选/重置/还原/复制哈希）
- **左右面板可拖拽分栏**；选中提交右键「与当前分支对比」显示 `HEAD..<分支>` 区间变更

### 分支对比面板

分支页右键「与当前分支对比」在**主窗口编辑器标签**打开：左栏为**变更文件目录树**（可折叠、状态字母 + `+N -M`），右栏为**文件差异**，语义 `base..target`（左=基线、右=目标）。支持拖拽分栏、并排 / 统一视图、交换方向、在原生 diff 中打开。

### 差异对比

并排 / 统一两种模式、hunk 头、行号、二进制与空差异处理；**语法高亮**（highlight.js 核心 + 20 种语言，按扩展名推断）；并排模式左右各自行号（点击高亮、左右联动）；**省略的上下文行以折叠行展示，可点击展开**（含最后一个 hunk 之后到 EOF 的省略区）；可一键切换到 VSCode 原生 diff。

### 其他

| 功能 | 说明 |
|---|---|
| 日志 | 提交列表（作者/日期/摘要/分支标签）、变更文件、差异、按作者/关键字过滤、分页、提交右键操作集 |
| Blame | 提交 / 作者 / 日期列 + 文件内容 |
| 图标覆盖 | 资源管理器文件状态角标 |
| 拉取 / 推送 | 侧边栏菜单、命令面板或提交按钮下拉的「提交后推送」；推送无上游时自动探测 remote 并 `-u` |
| 状态栏 | 当前分支 + 领先/落后 + 合并/变基等状态（工作区含 `.git` 时自动激活） |
| 弹窗策略 | 各面板一律在**主窗口以编辑器标签**打开；`turtlegit.panelMode` 仅作兜底 |

## 命令

| 命令 | 说明 |
|---|---|
| `TurtleGit: 提交…` / `在此提交…` | 聚焦侧边栏提交标签（后者预选所选文件） |
| `TurtleGit: 分支…` | 聚焦侧边栏分支标签 |
| `TurtleGit: 存储…` | 聚焦侧边栏暂存标签 |
| `TurtleGit: 显示日志…` | 打开日志对话框 |
| `TurtleGit: 比较差异…` / `比较差异（增强面板）…` | 原生 diff / 自研差异面板 |
| `TurtleGit: 版本分支图…` | 打开 Revision Graph |
| `TurtleGit: 追溯…` | 对当前文件打开 Blame |
| `TurtleGit: 在编辑器中打开` | 打开选中文件 |
| `TurtleGit: 暂存` / `取消暂存` / `放弃修改` / `添加到 .gitignore` | 对选中文件或目录执行 |
| `TurtleGit: 刷新` / `收回主窗口` | 刷新仓库状态 / 把浮动窗口面板拉回主窗口 |
| `TurtleGit: 拉取` / `推送` | 对当前仓库执行 git pull / git push |

快捷键：面板内 `Ctrl+Enter` 提交、`F5` 刷新。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `turtlegit.gitPath` | 空 | git 可执行文件路径；留空自动探测（PATH；Windows 上额外探测 TortoiseGit 自带 git.exe 与 Git for Windows） |
| `turtlegit.panelMode` | `auto` | 弹窗形态：`auto` / `floating` / `embedded` |
| `turtlegit.autoRefresh` | `true` | 保存文件后自动刷新状态 |
| `turtlegit.showStatusDecorations` | `true` | 资源管理器状态角标 |
| `turtlegit.ignoredExcludeDirs` | `[".history", "node_modules"]` | 勾选「忽略文件」时排除不显示的文件夹 |

## 兼容性

- **最低 VSCode 版本 `^1.52.0`**：实际用到的扩展 API 在 1.52 上均已可用。
- webview 少量底色用了 CSS `color-mix()`（Chrome 111+，即 VSCode 1.78+）。1.52–1.77 上会退化为前面声明的固定 rgba 兜底值——只是色调不完全跟随主题，不影响功能。

## 架构

```
src/host/          宿主层（Node，跨平台）
  git/             GitRunner / parsers / GitService / BranchOps（分支·标签·合并·变基·拣选·重置·stash·blame）
  core/            RepositoryStore / paths（跨平台路径规范）
  ui/              PanelManager（面板策略 + RPC + 侧边栏挂载）/ FileDecorationProvider / StatusBarManager
  rpc/             RpcRouter（请求分发）
webview/           UI 层（浏览器，esbuild IIFE 打包）
  sidebar/ commit/ branches/ log/ graph/ stash/ blame/ diff/ compare/
  ui/dialogs.ts    toast / prompt / 菜单共享工具
  bridge.ts        类型安全 RPC 客户端
shared/protocol.ts 宿主与 UI 的唯一 RPC 契约（请求/响应/事件）
```

**关键设计**

- **直调 git CLI**（与 TortoiseGit 同源），状态订阅沿用内置 `vscode.git` 事件，两者不打架；零外部 GUI 依赖。
- **原生 diff 不依赖内置 git 扩展**：自注册 `turtlegit:` scheme 的 FileSystemProvider（返回 ref 版本原始字节，编码检测交给编辑器），避免用户 `git.enabled: false` 时 `git:` URI 无人解析。
- **原生编辑器一律回主窗口**：浮动窗口是独立扩展宿主，在其中打开原生编辑器/diff 会失败，故先收回主窗口再开标签。
- **合并侧边栏**（提交 / 分支 / 暂存 三标签）：单一 WebviewView，三个面板共用一份 `WebviewInit` 与 RPC 路由。
- **部分提交**用 `git commit -- <paths>`（未跟踪文件先 `git add`）；签署默认 `-s`，指定签署人时改为 `-c user.name/-c user.email` 覆盖本次身份。
- **RPC 全类型化**，`shared/protocol.ts` 是唯一契约。

## 已知限制 / 路线

- [ ] VSCode 内端到端联调（F5 开发主机实测各面板，含 Linux 实机）
- [ ] 浮动窗口首次移入可能空白一次（已知上游问题），已留刷新兜底
- [ ] 浮动窗口的标签栏无法通过扩展 API 关闭（平台限制）
- [ ] Repo-browser（任意版本目录树浏览）
- [ ] 冲突解决向导（merge / rebase / cherry-pick 冲突的逐文件解决 UI）
- [ ] 交互式 rebase（当前为非交互式）
- [ ] 部分提交的按块 / 按行粒度（当前为文件级）
- [ ] Patch/PR、Submodule、LFS、Issue tracker 集成

## 开发

```bash
pnpm run watch   # 监听编译
pnpm test        # 冒烟测试（349 项）
pnpm run package # 打包 vsix
```

测试是真实临时 git 仓库上的集成断言（`test/smoke.ts`），覆盖：状态解析、部分提交、中文/空格路径、日志与 numstat、分支信息、跨平台路径、未跟踪文件 patch（含二进制/空文件/无末尾换行）、lane 算法与连线几何（含分叉点幻影 lane 回归）、远程仓库管理与远程分支检出、stash 按文件查看、文件目录树、diff 折叠行与行数统计、签署与提交后推送、分支区间变更文件、差异语法高亮、以及一批 **CSS/源码回归护栏**（列宽变量、分隔符归属、表头必须在滚动容器内、类名作用域等）。

## 发布（GitHub Actions）

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | 推送 main / PR | 类型检查 → 构建 → 冒烟测试 → 试打包 |
| `release.yml` | **仅**推送 `v*` 标签 | 校验标签与 `package.json` 版本一致 → 构建 → 测试 → 打包 → 创建 GitHub Release 并附 vsix |

```bash
# 1) 改 package.json 版本号
# 2) 提交
git add -A && git commit -m "0.4.0：……"
# 3) 打同名标签并推送（工作流据此发版）
git tag v0.4.0 && git push origin v0.4.0
```

- 标签必须是 `v` + `package.json` 的 version，不一致时工作流直接报错退出。
- 推送 master / 提 PR 不会发版，只跑 `ci.yml`。
- 要同时发布到 VS Code 市场，在仓库 Secrets 里加 `VSCE_PAT`；未配置时该步跳过。
- 运行环境：ubuntu-latest + Node 22 + pnpm 11（版本统一由 `package.json` 的 `packageManager` 指定，工作流里不要再写 `version:`，否则 `pnpm/action-setup` 会报版本冲突）。

## 变更日志

版本历史见 **[CHANGELOG.md](CHANGELOG.md)**。
