# TurtleGit

在 VSCode 中复刻 **TortoiseGit** 界面与使用习惯的 Git 增强插件：**侧边栏内完成提交**（不弹独立对话框，点击文件直接用 VSCode 原生对比）、独立浮窗对话框（日志/分支图/Stash/Blame）、提交图、按块勾选的提交、双栏差异对比。

**为什么做这个**：TortoiseGit 只支持 Windows。Linux 上没有等价的产品——TurtleGit 用纯 VSCode 插件实现同一套交互习惯，**不调用 TortoiseGit、不调用任何外部 GUI 进程**，Linux / macOS / Windows 通用。

> 状态：核心闭环已实现并通过数据层冒烟测试（280 项断言）。尚未在真实 VSCode 中端到端联调（见「已知限制」）。

## 功能

| 功能 | 说明 |
|---|---|
| 侧边栏（提交标签） | 原「提交视图」与「分支视图」已合并为**单个侧边栏 WebviewView**，顶部标签在 提交 / 分支 / 暂存 间切换（**当前标签为 hover 式浅底 + 加粗 + 主色下划线**，文字保持正常颜色确保可读；命令面板 `TurtleGit: 提交…`/`分支…`/`存储…` 聚焦并切到对应标签）：**提交不再弹独立对话框**（列表与输入框左内边距压到 4px，尽量靠左，把宽度留给文件名）：文件勾选、增删统计、提交信息、Amend/Signed-off、提交按钮全部收进侧边栏（WebviewView，与提交对话框共用同一套 RPC）；**当前分支显示在视图标题栏**（含 ↑领先/↓落后），webview 内不再重复；顶部一行只有「树形/列表」「全选/全不选」（互斥单按钮，文字即点击后的动作）与「未版本控制」「忽略文件」两个筛选；**刷新是标题行右侧的 ⟳ 图标**（由 webview 自己渲染——原来用 `view/title` 贡献点，扩展重载时会重复堆叠多个图标）；**视图重新可见或窗口重新获得焦点时自动刷新**（在终端/外部工具里做了 git 操作，切回 VSCode 即同步）；**分区标题显示「提交」+ 分支名（含 ↑领先/↓落后）**；**文件状态用单字母彩色文字**（M 修改 / A 新增 / D 删除 / R 重命名 / T 类型变更 / C 冲突 / U 未版本控制 / ! 已忽略，与 VSCode 内置 Git 一致，悬停显示中文说明；日志与分支图的文件列表同样改为字母）；**「添加到忽略列表」为二级菜单**：先选写入位置（仓库根 `.gitignore` / `.git/info/exclude` 仅本地），目录再选「整个目录 / 遍历目录下文件」（追加前补换行、跳过已存在条目）；**目录行右键**同样支持暂存/取消暂存/放弃修改/忽略；**点击文件直接用 VSCode 原生对比**（HEAD ↔ 工作区，未跟踪文件直接打开），不内嵌差异区；文件右键菜单含比较差异 / 在编辑器中打开 / 暂存 / 取消暂存 / 放弃修改 / 添加到忽略列表；树形/列表两种视图（目录复选框整目录勾选/半选，twisty 为大号 SVG 箭头）、**每文件增删行数徽标（+N -M）与选中文件总数/总增删统计**、**未版本控制文件显示完整新增内容**（自构造 patch，跨平台一致）、部分文件提交；**提交信息与勾选状态经 webview 状态持久化**（跨重载不丢失）；**整个侧边栏（标签栏 + 三个子面板）左右各 -10px 负边距整体外扩**，抵消 webview 默认 20px 容器留白（负边距加在包装层上，避免被子面板的 overflow:hidden 裁切文字） |
| 日志对话框 | 提交列表（作者/日期/摘要/分支标签徽标）、变更文件列表、文件差异、按作者/关键字过滤、所有分支开关、分页、**提交右键操作集**（检出/建分支/打标签/合并/拣选/重置/还原/复制哈希） |
| 侧边栏（分支标签） | 与「提交标签」共享同一侧边栏 WebviewView（顶部标签切换）：参考 IntelliJ IDEA Branches 面板：**当前分支**（↑领先/↓落后；**拉取/推送为图标、放在当前分支标题行右侧靠右对齐**，刷新同在标题行；**标题行名称优先占位、筛选框可被压缩**（窄侧边栏下分支名不消失），**当前分支名与其他分支同色**（早期 --focus 蓝字在部分主题下不可见，当前态由加粗 + 绿色对勾 + 浅色底纹区分））、**本地分支**（当前置顶，点击即检出；三列布局：**版本图标**（当前分支=绿色对勾，其他本地分支=分支线图标） | 提交号固定 6 行 | 分支名过长省略；**悬停行内显示 ✎重命名 / ✕删除按钮**（与右键菜单同操作，删除当前分支会被拒绝并提示）；右键：检出/基于此新建/合并到当前/变基当前到此/重命名/删除，未合并分支删除失败时追问是否强制 `-D`；**「新建分支」为「本地分支」标题行右侧靠右的图标**）、**远程分支**（按 remote 分组折叠，行首地球图标；检出为同名本地分支并 `--track`、合并/变基、删除远程分支需确认）、**远程仓库管理**（新增 / 改拉取·推送地址 / 删除 / **同步引用（git fetch）**；**「添加远程仓库」为「远程仓库」标题行右侧的图标，点击后一个对话框内一次填写名称与地址**（不再分两步 prompt）；**每个远程仓行悬停显示 ⟳ 同步按钮**，只更新远程跟踪引用、不动工作区，完成后 toast 摘要并自动刷新列表）；**筛选框位于当前分支标题行右侧**（不再独占一行） |
| 版本分支图 | 复刻 TortoiseGit Revision Graph + **Intellig Git Log 左侧分栏**：SVG lane 图（**连线按父提交的真实行号绘制**，拓扑序里父提交常隔多行，连到"下一行"会让线断在半空；**节点按 lane 着色**，固定调色板深浅主题下都不是黑点）+ 提交详情 + 变更文件 + 差异；节点右键全套操作。**左栏自上而下三层**：① **顶部筛选行**——搜索框（匹配 hash/短哈希/摘要/作者/引用，回车或 ↑↓ 在命中行间跳转并显示「当前位置/总数」，`Ctrl+F` 聚焦）、**分支 / 作者 / 日期（全部·24 小时·7 天）三个弹出式筛选**（分支列全量本地/远程分支，日期走 `--since`）、路径与信息关键字输入、「排除合并」勾选；② **sticky 表头**（图沟槽 | 提交 | 消息 | 作者 | 日期），**四列列宽均可拖拽调整**——图沟槽（改 lane 间距）、提交号（34–140px）、作者、日期（后两者 40–600px，同 Intellig），全部支持聚焦后方向键 ±10px、**双击手柄复位**，松手持久化；**消息列是弹性列**（宽度 = 剩余空间），由其两侧列宽反向调节；③ **滚动区**——SVG 只画 lane/连线/节点（覆盖在行背景之上、不挡点击），HTML 行承载文本，**分支/标签以行内芯片展示在消息列**（**当前分支芯片加粗 + 内描边环且排最左**，图标颜色随该行 lane 配色，超过 3 个分支折叠为可点击的 `+N`，标签排在分支后）。**图沟槽尽量少占宽度**：lane 间距按 lane 数**自适应压缩**（≤2 条 15px / ≤4 条 13px / ≤6 条 11px / 更多 9px，旧实现固定 18px），节点半径随间距收缩；更重要的是修复了**幻影 lane**——分叉点两个子提交共享同一父提交时，旧算法会让两条 lane 同时等待同一 hash，父提交落地后另一条永久卡着旧 hash 再不回收（每遇一个分叉点泄漏一列：4 个分叉点实测 8 列 150px → 修复后 2 列 36px），同时修好「边没连到父节点所在 lane、线断在半空」的老问题。**左右面板可拖拽分栏**（分隔条，左栏 240px 起、最宽到窗口 75%，松手持久化）；**选中提交右键「与当前分支对比」**：左栏显示 `HEAD..<分支>` 区间变更文件（含增删统计），「在编辑器中打开」对该区间起 VSCode 原生 diff（缺侧单开存在侧），Esc/退出按钮恢复单提交视图 |
| 差异对比 | 并排 / 统一两种模式、hunk 头、行号、二进制与空差异处理；并排模式**左右各自行号**（紧邻文本，点击行号高亮整行、左右联动）；**省略的上下文行以波浪线折叠行展示，可点击展开/收起**——hunk 之间、首个 hunk 之前**与最后一个 hunk 之后（末尾省略区，按两侧文件总行数计算）均有折叠行**；可一键切换到 VSCode 原生 diff 编辑器 |
| Stash 管理（侧边栏「暂存」标签） | 列表、保存（带消息）、Apply / Pop / Drop、stash 与基线差异；侧边栏「暂存」标签提供紧凑版（列表 + 内联应用/恢复/删除），**列表行单行展示：stash 索引编号（stash@{n}）+ 提交哈希（7 位）+ 消息**（消息过长省略；分支信息已在 git 默认消息「WIP on <branch>: …」内，不重复占行）；**点击行在右侧主窗口打开 Stash 管理面板并预选该 stash**——从侧边栏进入时主窗口面板为**两列布局（变更文件 | 文件差异，不再显示 Stash 列表列，因为已在侧边栏选好）**；直接打开面板（无预选）时才是三列布局（Stash 列表 | 变更文件 | 文件差异）；一个 stash 常含多个文件、每个文件可分别查看改动记录；**差异区标题栏提供「在编辑器中打开」**（VSCode 原生 diff：stash 版本 ↔ 基线，与面板内容一致）；命令面板 `TurtleGit: 存储…` 聚焦并切到该标签 |
| Blame | 复刻 TortoiseGitBlame：提交/作者/日期列 + 文件内容 |
| 图标覆盖 | 资源管理器文件状态角标（复刻 TortoiseGit Icon Overlay） |
| 拉取 / 推送 | 侧边栏 `···` 菜单、命令面板或**提交视图的「提交后推送」勾选项**执行；拉取 = fetch + merge（`--no-edit`），推送无上游时自动探测 remote 并 `-u` 建立跟踪 |
| 状态栏 | 当前分支 + 领先/落后计数 + 合并/变基等状态提示（**状态栏出现分支即表示扩展已激活**；工作区含 `.git` 时自动激活） |
| 弹窗策略 | 日志 / 版本分支图 / Stash / Blame / 增强差异面板**一律在主窗口以编辑器标签打开**（不再移到独立浮动窗口）；`turtlegit.panelMode` 仅作为兜底保留；「收回主窗口」命令用于把仍残留在浮动窗口的面板拉回 |

## 快速开始

```bash
pnpm install
pnpm run compile    # 构建 dist/extension.js 与 dist/webview/main.js
pnpm test           # 数据层冒烟测试（临时仓库，跨平台断言）
```

在 VSCode 中打开本项目，按 **F5** 启动扩展开发主机（已配置 `preLaunchTask`），在新窗口打开任意 git 仓库即可体验。

## 命令

| 命令 | 说明 |
|---|---|
| `TurtleGit: 提交…` | 聚焦侧边栏并切到**提交**标签（提交在此完成，不弹对话框） |
| `TurtleGit: 在此提交…` | 对资源管理器/编辑器选中的文件提交（聚焦侧边栏提交标签并预选这些文件） |
| `TurtleGit: 在编辑器中打开` | 用 VSCode 编辑器打开选中的文件（侧边栏右键 / 命令面板） |
| `TurtleGit: 暂存` / `取消暂存` / `放弃修改` / `添加到 .gitignore` | 对侧边栏选中的文件或目录执行对应操作 |
| `TurtleGit: 分支…` | 聚焦侧边栏并切到**分支**标签（切换分支 / 管理远程仓库） |
| `TurtleGit: 显示日志…` | 打开日志对话框 |
| `TurtleGit: 比较差异…` | 用 **VSCode 原生 diff** 打开差异（HEAD ↔ 工作区） |
| `TurtleGit: 比较差异（增强面板）…` | 打开自研差异面板（并排/统一、波浪线折叠行） |
| `TurtleGit: 版本分支图…` | 打开 Revision Graph |
| `TurtleGit: 存储…` | 聚焦侧边栏并切到**暂存**标签（Stash 管理） |
| `TurtleGit: 追溯…` | 对当前文件打开 Blame |
| `TurtleGit: 刷新` | 刷新所有仓库状态 |
| `TurtleGit: 收回主窗口` | 把浮动窗口中的面板拉回主窗口（亦可从侧边栏视图手动拖回） |
| `TurtleGit: 拉取` / `TurtleGit: 推送` | 对当前仓库执行 git pull / git push |

快捷键：面板内 `Ctrl+Enter` 提交、`F5` 刷新。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `turtlegit.gitPath` | 空 | git 可执行文件路径；留空自动探测（PATH；Windows 上额外探测 TortoiseGit 自带 git.exe 与 Git for Windows） |
| `turtlegit.panelMode` | `auto` | 弹窗形态：`auto`/`floating`/`embedded` |
| `turtlegit.autoRefresh` | `true` | 保存文件后自动刷新状态 |
| `turtlegit.showStatusDecorations` | `true` | 资源管理器状态角标 |
| `turtlegit.ignoredExcludeDirs` | `[".history", "node_modules"]` | 勾选「忽略文件」时排除不显示的文件夹；按目录名或仓库相对路径匹配（目录名对任意层级生效），空数组 = 全部显示 |

## 架构

```
src/host/          宿主层（Node，跨平台）
  git/             GitRunner / parsers / GitService / BranchOps（分支·标签·合并·变基·拣选·重置·stash·reflog·blame）
  core/            RepositoryStore / paths（跨平台路径规范）
  ui/              PanelManager（弹窗策略 + RPC + pull/push + 侧边栏挂载）/ SidebarViewProvider
                   （合并侧边栏：提交/分支/暂存 三标签合一）/ statusNodes（变更文件节点与命令参数解析）/
                   FileDecorationProvider / StatusBarManager
  rpc/             RpcRouter（请求分发）
webview/           UI 层（浏览器，esbuild IIFE 打包）
  sidebar/         SidebarPanel（标签栏 + 三面板挂载切换）/ 复用 commit/BranchesSidebar/StashSidebarPanel
  commit/          提交对话框 + 侧边栏提交视图（CommitSidebarPanel）+ 共享展示工具
  log/             日志对话框（含右键操作集）
  graph/           版本分支图（lane 算法 + SVG 渲染）
  stash/           Stash 管理（StashPanel 独立对话框 + StashSidebarPanel 侧边栏紧凑版）
  blame/           Blame 视图
  diff/            差异渲染器（并排/统一）
  ui/dialogs.ts    toast / prompt / 菜单共享工具
  bridge.ts        类型安全 RPC 客户端
shared/protocol.ts 唯一 RPC 契约（请求/响应/事件）
```

关键设计：

- **命令执行直调 git CLI**（与 TortoiseGit 同源），状态订阅内置 `vscode.git` 扩展事件，两者不打架。
- **零外部 GUI 依赖**：不调用 TortoiseGit 或任何第三方 Git 客户端进程；Linux 上只用 PATH 中的 `git`。
- **跨平台路径规范**：`src/host/core/paths.ts` 统一处理分隔符（仓库相对路径恒为正斜杠，绝对路径用平台原生分隔符），中文路径经 `-z` / porcelain v2 解析无转义。
- **弹窗策略不押注单一 API**：稳定 API 中暂无 `ViewColumn.Modal`，主路径为 `createWebviewPanel` + `workbench.action.moveEditorToNewWindow`（浮动窗口，Linux 同样支持），失败自动降级内嵌标签页。
- **合并侧边栏（提交 / 分支 / 暂存 三标签）**：`turtlegit.sidebarView` 单一 WebviewView 取代原先的 `turtlegit.commitView` 与 `turtlegit.branchesView`，顶部标签在 提交 / 分支 / 暂存 间切换（`SidebarPanel` 一次性挂载三个面板、`hidden` 切换可见性，避免反复重建导致的事件订阅泄漏；命令聚焦经 `sidebar:tab` 事件切页）。三个面板与提交对话框共用同一份 `WebviewInit` 与 RPC 路由（`PanelManager.attachSidebar()` 挂载消息与仓库事件推送，`sidebar: true` 让 main.ts 挂载紧凑版 `CommitSidebarPanel`/`BranchesSidebar`/`StashSidebarPanel`）；侧边栏 webview 恒在主窗口，因此不需要浮动窗口收回逻辑。差异查看交给 VSCode 原生 diff，侧边栏只保留文件勾选与提交输入。重挂载前 `RpcClient.clearHandlers(['init'])` 清理上一视图的订阅，修复旧提交/分支视图切换仓库时遗留监听器在 DOM 销毁后报错的问题。
- **原生编辑器一律回主窗口**：浮动窗口是独立的扩展宿主/编辑器区，在其中打开 VSCode 原生编辑器或 diff 会报「由于意外错误，无法打开编辑器」。因此双击文件、「在编辑器中打开」、原生 diff 等操作先把面板收回主窗口再开新标签；收回用 `workbench.action.restoreEditorsToMainWindow`（作用于聚焦窗口的编辑器组），并以 `vscode.window.state.focused` 为护栏，避免主窗口聚焦时误压平其布局。未跟踪文件直接打开工作区文件。
- **原生 diff 不依赖内置 git 扩展**：内置 `vscode.git` 扩展的 `git:` scheme 提供器在部分环境不可用（实测 Trae CN 用户 `git.enabled: false` 时该扩展激活直接失败报 "Git model not found"，`git:` URI 无人解析，原生 diff 打不开）。TurtleGit 自注册 `turtlegit:` scheme 的 FileSystemProvider（`src/host/ui/GitBlobProvider.ts`，与内置 GitFileSystemProvider 同构：`stat`/`readFile` 返回 ref 版本原始字节，编码检测交给编辑器，GBK 不乱码），diff 左侧内容由本扩展的 git 进程提供，跨环境行为一致。
- **部分提交**用 `git commit -- <paths>`（复刻勾选子集），未跟踪文件先 `git add`。
- **签署与提交后推送**：勾选「签署」时默认 `git commit -s`（用 git 自己的 `user.name`/`user.email` 生成 `Signed-off-by` 尾注）；填了签署人「姓名 <邮箱>」时改为 `-c user.name=… -c user.email=…` 覆盖本次提交身份（`src/host/git/parsers.ts` 的 `parseSignOffIdentity` 负责解析与消毒）——仓库没配 `user.email` 时也能靠它完成签署。推送在宿主侧 `PanelManager` 的 `commit:create` handler 里追加执行（提交已成功，推送失败不回滚，只回传 `pushed: false` + 原因给界面 toast）。
- **RPC 全类型化**，`shared/protocol.ts` 是宿主与 UI 的唯一契约。

## 已知限制 / 路线

- [ ] VSCode 内端到端联调（F5 开发主机实测各对话框，含 Linux 实机）
- [ ] 浮动窗口首次移入可能空白一次（已知上游问题），已留刷新兜底
- [ ] 浮动窗口的标签栏无法通过扩展 API 关闭（VSCode 平台限制）；已改为浮动窗口内不再尝试打开原生编辑器，统一收回主窗口后新开标签
- [ ] Repo-browser（任意版本目录树浏览）
- [ ] 冲突解决向导（merge/rebase/cherry-pick 冲突时的逐文件解决 UI）
- [ ] 交互式 rebase（当前 rebase 为非交互式）
- [ ] 部分提交的按块/按行粒度（当前为文件级）
- [ ] Patch/PR、Submodule、LFS、Issue tracker 集成
- [x] Revision Graph / Stash / Blame / 分支标签合并拣选重置还原（本批已实现）

## 开发

```bash
pnpm run watch   # 监听编译
pnpm test        # 冒烟测试
pnpm run package # 打包 vsix
```

测试为真实临时 git 仓库上的集成断言（`test/smoke.ts`，280 项），覆盖状态解析、部分提交、中文路径、日志/numstat、分支信息、跨平台路径工具、未跟踪文件 patch（含二进制/空文件/无末尾换行边界）、lane 算法与连线几何（含**分叉点幻影 lane 回归**与「边连到父节点所在 lane」）、图沟槽宽度纯函数（自适应间距/图宽/节点半径）、远程仓库管理与远程分支检出、远程仓 fetch 同步引用、stash 按文件查看、文件目录树、diff gap 折叠行渲染（含末尾省略区）、两侧文件行数统计、签署人与提交后推送、分支区间变更文件（rangeFiles）、日志列截断与搜索匹配与对比引用挑选纯函数、行内分支芯片排序与折叠（branchChips）、日期预设映射（sinceArg）、log 分支/时间过滤（branch/since 真实仓库）。

## 发布（GitHub Actions）

两个工作流位于 `.github/workflows/`：

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | 推送到 main / PR | 类型检查 → 构建 → 冒烟测试 → 试打包，并上传 vsix 为构建产物 |
| `release.yml` | 推送 `v*` 标签（或手动指定 tag） | 校验标签与 `package.json` 版本一致 → 类型检查 → 构建 → 冒烟测试 → 打包 → **创建 GitHub Release 并附上 vsix**；配了 `VSCE_PAT` 时再发布到 VS Code 市场 |

发版步骤：

```bash
# 1) 改 package.json 版本号并同步 README（冒烟计数等）
# 2) 提交
git add -A && git commit -m "0.3.27：……"
# 3) 打与版本一致的标签并推送（工作流据此发 Release）
git tag v0.3.27 && git push origin v0.3.27
```

- 标签必须是 `v` + `package.json` 的 version（如 `v0.3.27`），不一致时工作流直接报错退出，避免发错版本。
- Release 说明自动取「上一个标签 → 本次标签」的提交标题列表。
- 只想出 GitHub Release 不需要任何秘钥；要同时发布到 VS Code 市场，在仓库 Settings → Secrets 里加 `VSCE_PAT`（Marketplace Personal Access Token），未配置时该步自动跳过。
- 运行环境：ubuntu-latest + Node 22（`@vscode/vsce` 4.x 要求 Node ≥ 22）+ pnpm 9（锁文件 `lockfileVersion: 9.0`）。打包统一用 `node node_modules/@vscode/vsce/vsce package --no-dependencies`，与本地一致（嵌套 spawn npm 的依赖探测在受限环境里会失败）。
