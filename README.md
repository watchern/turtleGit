# TurtleGit

在 VSCode 中复刻 **TortoiseGit** 界面与使用习惯的 Git 增强插件：独立浮窗对话框、提交图、按块勾选的提交、双栏差异对比。

**为什么做这个**：TortoiseGit 只支持 Windows。Linux 上没有等价的产品——TurtleGit 用纯 VSCode 插件实现同一套交互习惯，**不调用 TortoiseGit、不调用任何外部 GUI 进程**，Linux / macOS / Windows 通用。

> 状态：核心闭环已实现并通过数据层冒烟测试（73 项断言）。尚未在真实 VSCode 中端到端联调（见「已知限制」）。

## 功能

| 功能 | 说明 |
|---|---|
| 提交对话框 | 变更文件三态勾选（已暂存/工作区/未跟踪）、**树形/列表两种视图**（与侧边栏共享同一偏好，目录复选框可整目录勾选/半选）、双击看差异、右键（暂存/取消暂存/放弃修改/加入 .gitignore）、提交信息、Amend、Signed-off-by、部分文件提交 |
| 日志对话框 | 提交列表（作者/日期/摘要/分支标签徽标）、变更文件列表、文件差异、按作者/关键字过滤、所有分支开关、分页、**提交右键操作集**（检出/建分支/打标签/合并/拣选/重置/还原/复制哈希） |
| 版本分支图 | 复刻 TortoiseGit Revision Graph：SVG lane 图 + refs 徽标 + 提交详情 + 变更文件 + 差异；节点右键全套操作 |
| 差异对比 | 并排 / 统一两种模式、hunk 头、行号、二进制与空差异处理；并排模式**左右各自行号**（紧邻文本，点击行号高亮整行、左右联动）；**省略的上下文行以波浪线折叠行展示，可点击展开/收起**；可一键切换到 VSCode 原生 diff 编辑器 |
| Stash 管理 | 列表、保存（带消息）、Apply / Pop / Drop、stash 与基线差异 |
| Blame | 复刻 TortoiseGitBlame：提交/作者/日期列 + 文件内容 |
| 图标覆盖 | 资源管理器文件状态角标（复刻 TortoiseGit Icon Overlay） |
| 检查修改视图 | 侧边栏仓库 → 变更文件，点击直接看差异；**树形/列表两种视图**（列表为 TortoiseGit 默认，label 为完整路径）；标题栏含**全部展开/折叠互斥按钮**与**树/列表互斥切换按钮**（图标随状态切换）；`···` 下拉含提交（弹窗）/拉取/推送 |
| 拉取 / 推送 | 侧边栏 `···` 菜单或命令面板执行；拉取 = fetch + merge（`--no-edit`），推送无上游时自动探测 remote 并 `-u` 建立跟踪 |
| 状态栏 | 当前分支 + 领先/落后计数 + 合并/变基等状态提示 |
| 弹窗策略 | `auto` / `floating` / `embedded` 三档，运行期自动降级 |

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
| `TurtleGit: 提交…` | 打开提交对话框 |
| `TurtleGit: 提交（弹窗）…` | 在浮动独立窗口中打开提交对话框 |
| `TurtleGit: 在此提交…` | 对资源管理器/编辑器选中的文件提交 |
| `TurtleGit: 显示日志…` | 打开日志对话框 |
| `TurtleGit: 比较差异…` | 打开差异面板 |
| `TurtleGit: 版本分支图…` | 打开 Revision Graph |
| `TurtleGit: 存储…` | 打开 Stash 管理 |
| `TurtleGit: 追溯…` | 对当前文件打开 Blame |
| `TurtleGit: 刷新` | 刷新所有仓库状态 |
| `TurtleGit: 在独立窗口中打开` | 把当前活动面板拉回主窗口 |
| `TurtleGit: 全部展开` / `TurtleGit: 全部折叠` | 展开/折叠侧边栏全部节点（标题栏为互斥单按钮，图标随状态切换） |
| `TurtleGit: 切换树/列表视图` | 侧边栏在目录树 / 平铺列表间切换（记忆选择） |
| `TurtleGit: 树结构查看` / `TurtleGit: 列表形式查看` | 侧边栏标题栏互斥切换按钮对应的命令（图标 list-tree / list-flat） |
| `TurtleGit: 拉取` / `TurtleGit: 推送` | 对当前仓库执行 git pull / git push |

快捷键：面板内 `Ctrl+Enter` 提交、`F5` 刷新。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `turtlegit.gitPath` | 空 | git 可执行文件路径；留空自动探测（PATH；Windows 上额外探测 TortoiseGit 自带 git.exe 与 Git for Windows） |
| `turtlegit.panelMode` | `auto` | 弹窗形态：`auto`/`floating`/`embedded` |
| `turtlegit.autoRefresh` | `true` | 保存文件后自动刷新状态 |
| `turtlegit.showStatusDecorations` | `true` | 资源管理器状态角标 |

## 架构

```
src/host/          宿主层（Node，跨平台）
  git/             GitRunner / parsers / GitService / BranchOps（分支·标签·合并·变基·拣选·重置·stash·reflog·blame）
  core/            RepositoryStore / paths（跨平台路径规范）
  ui/              PanelManager（弹窗策略 + RPC + pull/push）/ FileDecorationProvider /
                   StatusBarManager / StatusTreeProvider（树/列表双模式）
  rpc/             RpcRouter（请求分发）
webview/           UI 层（浏览器，esbuild IIFE 打包）
  commit/          提交对话框
  log/             日志对话框（含右键操作集）
  graph/           版本分支图（lane 算法 + SVG 渲染）
  stash/           Stash 管理
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
- **部分提交**用 `git commit -- <paths>`（复刻勾选子集），未跟踪文件先 `git add`。
- **RPC 全类型化**，`shared/protocol.ts` 是宿主与 UI 的唯一契约。

## 已知限制 / 路线

- [ ] VSCode 内端到端联调（F5 开发主机实测各对话框，含 Linux 实机）
- [ ] 浮动窗口首次移入可能空白一次（已知上游问题），已留刷新兜底
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

测试为真实临时 git 仓库上的集成断言（`test/smoke.ts`），覆盖状态解析、部分提交、中文路径、日志/numstat、分支信息、跨平台路径工具。
