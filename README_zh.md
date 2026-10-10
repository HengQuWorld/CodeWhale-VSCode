# CodeWhale for VS Code —— CodeWhale 代理的轻量图形前端

[![Version](https://img.shields.io/badge/version-0.8.4-blue)](https://github.com/HengQuWorld/CodeWhale-VSCode)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![CI](https://github.com/HengQuWorld/CodeWhale-VSCode/actions/workflows/ci.yml/badge.svg)](https://github.com/HengQuWorld/CodeWhale-VSCode/actions/workflows/ci.yml)
[![Release](https://github.com/HengQuWorld/CodeWhale-VSCode/actions/workflows/release.yml/badge.svg)](https://github.com/HengQuWorld/CodeWhale-VSCode/actions/workflows/release.yml)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85+-informational)](https://code.visualstudio.com/)
[![VSIX](https://img.shields.io/badge/VSIX-~390%20KB-brightgreen)](https://github.com/HengQuWorld/CodeWhale-VSCode/releases)
[![macOS](https://img.shields.io/badge/macOS-supported-brightgreen)](#系统要求)
[![Windows](https://img.shields.io/badge/Windows-supported-brightgreen)](#系统要求)
[![Linux](https://img.shields.io/badge/Linux-supported-brightgreen)](#系统要求)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

CodeWhale for VS Code 是 [CodeWhale](https://github.com/Hmbown/CodeWhale) 的**图形化前端**。CodeWhale 是一个开源且持续活跃开发的编程代理，本扩展把它装进 VS Code 原生侧边栏：读取工作区、修改文件、执行命令、搜索网络、派发子代理，全程不必离开编辑器。

围绕 CodeWhale，社区为同一个引擎提供了两种界面：**TUI** 面向习惯终端的人，本 **GUI** 面向习惯编辑器的人。它们共享同一个引擎和核心 runtime 概念，但 GUI 明确是围绕编辑器工作流做的取舍，目前仍有一部分高级能力只在 TUI 中提供。

这个分工是刻意的：**代理留在引擎里，体验留在编辑器里。** 本扩展不打包、不分叉、也不重新实现代理，它只是引擎之上的一个薄的本地 GUI。

## 为什么它能保持轻量

| | |
|---|---|
| VSIX 体积（0.8.4） | 约 390 KB |
| 运行时 npm 依赖 | **零** —— 扩展自身的 TypeScript（以及用于渲染的 `marked`）都被 webpack 内联 |
| 打包的引擎或模型 | **无** —— `codewhale` 是独立的原生二进制 |
| 重复实现的代理逻辑 | **无** —— GUI 只是引擎本地 runtime API 之上的适配层 |
| 扩展内的权威会话状态存储 | **无** —— 线程、回合、工具调用、文件变更都以引擎为唯一权威 |

前端是一个 webview：`ChatProvider` 运行在扩展宿主中，通过 HTTP 访问 `127.0.0.1`，把引擎报告的内容渲染出来。当安装的引擎暴露了更新的 runtime 端点时，UI 就直接使用；没有暴露时，相关功能会带着说明被禁用，而不是在运行时崩掉 —— 这也是 Undo、Retry、快照 Restore 会显示为「不可用」灰态而不是坏按钮的原因。

正因为代理的任何一部分都没有被复制进扩展，引擎可以独立发布新能力和修复，而不需要前端跟着发版。

### 0.8.4 的引擎兼容性

0.8.4 针对引擎 **v0.10.1** 验证：本版交付的每一项改动都在客户端侧、或依托 v0.10.1 已携带的路由 —— 早期版本一直在等的那些也在其中。Branch 行、Changes 面板中命令自己的变更行、把打开的会话移到另一个 provider、undo 的文件回滚与按文件 Revert、选择器里的用户自定义 provider、fork 保留会话文档、线程栏的流畅，都在引擎读到 v0.10.1 的那一刻全部点亮。

以下两项仍需要比任何已发布引擎 tag 更新的 Codewhale 构建：

- **会话上报自己属于哪个客户端** —— 需要 [5166473](https://github.com/codewhale-hq/Codewhale/commit/5166473369fbe548cd5b518ed1e697ce9d4b706a)，已在 Codewhale `main`、尚未进入任何引擎 tag。在引擎携带它之前，本扩展启动的会话会被计为匿名的 `serve`，而不是标明所属客户端；`brotherwhale.telemetry` 关闭开关本身在任何引擎上都有效。

- **本扩展的第二个窗口，或与另一个 CodeWhale 客户端并用** —— 引擎 v0.10.1 引入的 runtime ownership 模型限制每台机器只能有一个驱动客户端：第二个运行本扩展的 VS Code 窗口、或本扩展与 TUI 等其他 CodeWhale 客户端同机并用，会被直接拒绝而不是启动自己的引擎。修复——每个 runtime store 独立的 control endpoint、每个工作区唯一的驱动者，让 web、desktop、TUI 与本扩展并行工作——见 [Codewhale#6924](https://github.com/codewhale-hq/Codewhale/pull/6924)，仍开放未合并；在引擎携带它之前，请一次只开一个窗口、一台机器只跑一个 CodeWhale 客户端。

在引擎 **v0.10.0** 上，其余各项与 0.8.3 时期完全一致：不显示 Branch 行（从一个丢失工具调用的会话分叉出的分支，第一条消息可能失败）、命令的变更行只到路径为止、打开的会话不会被移动、undo 把改动留在磁盘上且 Revert 对存在的快照回答 `409`、`[providers.<name>]` 路由不出现在选择器里、fork 新建自己的会话文档、大型线程 store 在引擎侧缓慢。本版新增的 Skills 面板在 v0.10.0 上会把激活与详情带着原因变暗，列出、开关以及安装 / 更新 / 移除 / 信任 / 审计操作不受影响。

用 `codewhale update` 保持引擎最新，用 `codewhale --version` 确认版本。

## 预览

**消息导航轨** —— 右侧边缘的圆点可跳转到任意用户消息，`Ctrl/Cmd+Up` / `Ctrl/Cmd+Down` 可在消息之间前后跳转。

![消息导航轨](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/01-message-nav.gif)

**文件变更的内联差异** —— 变更卡片打开差异视图，行号正确，还原的是模型当时看到的文件内容。

![文件变更差异](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/02-diff.gif)


## 亮点功能

**一个入口，管三种工作负载** —— 目标（Goal）、任务（Task）、对话（Thread）都在同一个侧边栏里创建和切换。想清楚一件事、丢出去一件事、聊一件事，各归各位，不必在窗口之间搬运上下文。

**想到就纠偏：不停下这一轮，也能改变它的走向** —— 模型的思路开始跑偏，或者干活途中冒出了新的现实发现，你不必先 Stop 再重开一轮。把你的引导打进去、按 Enter，这段话就落进当前正在跑的回合里，Agent 从当下这一点修正方向；消息带上 steer 标记，让你清楚看到对话是在哪一刻转向的。纠偏是对话的一部分，而不是把对话推倒重来。

**并发开工，让 AI 用满每一分算力** —— 多个任务可以同时推进：每个回合都由 Runtime 独立持有，你在一个线程里继续对话时，其它线程的目标循环和长任务照常往下跑。不是排队等批处理，而是真正的多路并行 —— 什么时候回来收结果，你说了算。

**多任务跑到哪一步，抬眼就能看见** —— Sessions、Threads、Activity 三个并列标签页把「正在发生什么」摊开在眼前：运行中的线程、实时工作面板、变更列表、Fleet 与子代理状态、任务进度。每个活跃线程各持一条轻量 SSE 流，状态与进度实时刷新，不靠定时轮询。

**该你拍板的那一刻，一键触达** —— 某个后台线程停下来等审批或等你补充信息时，它自己的卡片上会亮起待办计数（归入 *Needs you*），工具栏 Agent 标签会点名并显示总数。你可以直接在卡片里点一下完成审批或回答提问，不必先切过去。

**回滚到你需要的粒度：轮次或文件** —— 上一轮不满意，Undo / Retry 直接作用于这一轮；某个文件被改坏了，按文件的 Revert 只撤这一处变更，并标明变更之前所取的还原点，同一文件中其余的改动和其它文件都原样不动。需要更大范围时，快照可以把工作区文件整体回滚到某个时间点。

**一个工作区，装下多个项目** —— 有些活儿天生横跨多个仓库。把各个项目软链接进同一个目录，打开 VS Code 的「跟随符号链接」设置项，然后只打开这一个目录：Agent 会把所有项目看成同一棵树，你也能在同一个侧边栏、同一段对话里，同时推进多个项目的开发。


## 系统要求

| 要求 | 说明 |
|---|---|
| **VS Code 1.85+** | 或兼容的 IDE —— 支持 Trae CN |
| **CodeWhale 引擎** | 即 `codewhale` CLI。**未随扩展打包**，需单独安装（见下） |
| **Node.js** | 仅在从源码构建扩展、或通过 npm 安装引擎时需要 |
| **操作系统** | macOS、Windows 或 Linux |

### 1. 安装引擎

引擎由上游项目发布的原生二进制提供。macOS / Linux：

```bash
curl -fsSL https://codewhale.net/install.sh | sh
"$HOME/.local/bin/codewhale"
```

Windows：从 [GitHub Releases](https://github.com/Hmbown/CodeWhale/releases/latest) 下载对应安装包。

确认它在 `PATH` 中：

```bash
codewhale --version
codewhale update          # 保持引擎为最新
```

npm 和 Cargo 是受支持的次要安装途径（`npm install -g codewhale`）。引擎同时也是连接模型提供商的地方 —— 首次运行时用 `/provider` 和 `/model` 完成配置。

> **找不到引擎？** 扩展会搜索常见位置（`~/.cargo/bin`、Homebrew 与 npm 全局 `node_modules`、`~/.local/share/codewhale`）。如果你是通过 `install.sh` 安装到 `~/.local/bin`，而 VS Code 又没有继承这个 `PATH`，请显式设置 `brotherwhale.enginePath`。

### 2. 安装扩展

**方式 A —— VS Code 插件市场：** 在扩展面板（`Cmd/Ctrl+Shift+X`）搜索 "CodeWhale" 并安装。

**方式 B —— 从源码构建：**

```bash
git clone https://github.com/HengQuWorld/CodeWhale-VSCode.git
cd CodeWhale-VSCode
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

然后安装生成的 `.vsix`（`Extensions: Install from VSIX...`），或在终端执行：

```bash
code --install-extension ./brotherwhale-vscode-0.8.4.vsix --force
```

> **Trae CN 用户：** 如果 `code` 不在 `PATH` 中，使用自带的 CLI：
> ```bash
> "/Applications/Trae CN.app/Contents/Resources/app/bin/code" --install-extension ./brotherwhale-vscode-0.8.4.vsix --force
> ```

### 3. 打开它

点击活动栏中的 **CodeWhale 图标**。扩展会按需为你的工作区启动引擎、做健康检查，并在状态栏显示 **Ready**。第一条消息最慢，之后引擎会被复用。

## 功能特性

### 像代理、而不是像输入框的聊天
- **流式回合**，带可折叠的思考面板；工具调用卡片会显示实际参数（例如 shell 命令以 `$ ...` 代码块呈现）；每回合带 `↑/↓` token 用量标记。
- **回合中引导（steering）** —— 回合运行期间按 Enter 会把内容作为指引送进当前回合，而不是开启新回合（与引擎的 steering 输入一致）；被引导的消息会带一个 steer 徽标。
- **统一的发送/停止按钮**，反映真实的回合状态；并提供上一回合的 **Undo** 与 **Retry**。
- **附件** —— `/attach`、📎 按钮，或在资源管理器中右键文件选择 **CodeWhale: 附加到对话**；截图可用 `Ctrl/Cmd+V` 粘贴，从 Finder 或其他窗口拖入的文件同样可以附加。（在 VS Code 窗口内部发起的拖拽 —— 从资源管理器文件树或编辑器标签页 —— 无法到达对话 webview：VS Code 会把它留给自己的编辑器组投放目标。这类情况请用右键菜单。）
- **消息导航轨** —— 右侧边缘的圆点可跳转到任意用户消息；`Ctrl/Cmd+Up` / `Ctrl/Cmd+Down` 在消息间前后跳转。

### 模式与权限姿态
两个彼此独立的控制项，词汇与引擎保持一致：

| 模式 | 行为 |
|---|---|
| **Act**（`agent`） | 自主工作，是否需审批由权限姿态决定 |
| **Plan** | 动手前先给出方案 |
| **Operate** | 面向长时间、编排型的工作 |

| 权限姿态 | 行为 |
|---|---|
| **Ask** | 每个受控操作都需要审批 |
| **Auto-Review** | 代理直接推进，由 runtime 审查高风险步骤 |
| **Full Access** | 不再弹审批 —— 隐含自动批准 |

可在状态栏切换，或使用 `/mode`（快捷键 `1`/`2`/`3`）与 `/auto`。旧写法 `/mode yolo` 作为单向兼容别名保留，含义是 **Act + Full Access**，它本身永远不会作为一个模式显示。

### 会话（Sessions），而不只是线程
- 把对话**保存并恢复**为会话，支持搜索与删除。
- **每回合自动保存**，重载或重启都不会丢线程。
- **后台线程持续运行** —— 切换线程、载入会话或新建对话都不会再动到正在运行的回合：回合由 Runtime 拥有，目标循环或长时间回合会在你处理其它事情时继续跑。切回该线程时会重新接上这个回合（Stop、Steer 恢复可用）；要停下仍然需要显式点 **Stop**。
- **跨工作区恢复** —— 载入其他项目的会话时，会自动重新绑定到当前工作区。
- **工作区过滤** —— 可查看全部工作区的会话，或只看当前工作区。
- **注意力提示** —— 等待审批或等待你输入的线程，会在它的卡片上显示待办数量（归入 *Needs you* 分组），工具栏 **Agent** 标签上显示总数并点名等待最久的线程。其它线程的审批与提问可以直接在它的卡片内联回答，不用先切过去。
- **一轮跑完时的一声提示音** —— 人不在屏幕前也听得见：正在看的会话、以及后台线程跑完的轮次都会响。失败或中断的轮次不发声，同时完成的轮次只响一次；`brotherwhale.completionSound` 可关闭。
- **监视而非轮询** —— 每个正在运行或等待你的后台线程各持有一条轻量 SSE 流，侧栏徽章与自动保存都是实时的，不再有定时轮询；别处到来、需要你处理的请求会立刻出现在侧栏上，而不是等下一次轮询。
- 侧边栏三个并列标签页 —— **Sessions**（已保存的会话）、**Threads**（进行中的线程）、**Activity**（智能体实时状态：工作、变更、车队、任务、子代理），每个标签下都有一行说明它装了什么。

### 编辑器内的变更与差异
- 每个会话一个 **Changes** 区块，文件变更卡片由引擎权威的 mutation 元数据构建。
- **差异视图**行号正确，还原的是模型当时看到的文件内容。
- 可直接在编辑器中 **Open** 变更文件，或内联 **Diff**。
- **Revert** 通过引擎的文件级端点恢复单条记录变更，并指明该变更之前所取的还原点；同一文件中其余的变更 —— 以及其它所有文件 —— 都保持不动。
- 重放历史会话时会依据记录中的替换内容重建差异；当链条无法对齐时，会**明确不显示差异**，而不是编造一份。

### 任务、代理与 Fleet
- **Tasks** —— 弹窗创建、跟踪进度、打开详情浮层、按工作区过滤；后台线程需要你时会给出提示。
- **Agent runs** —— 委派出去的工作，带内联详情视图。
- **Fleet** —— 受管的多代理运行：worker、任务、回执，启动/停止与单个 worker 的中断/停止/重启，以及可按 issues / progress / all 过滤的实时 SSE 事件时间线。

### 目标、记忆与技能
- **Thread Goal** —— 状态、token 预算（超支显示红色）、耗时与续跑次数，支持设置 / 编辑 / 完成 / 阻塞 / 删除。
- **后台目标** —— 设置目标时勾选*在后台线程运行*，它会移到独立线程上，继承当前线程的模型、模式与权限姿态；工作面板会在当前目标下方列出这些目标，并提供**打开线程**。**恢复运行**用于重新唤醒被 Runtime 重启搁置的目标（引擎启动时不会自动扫它们）。
- **Memory** —— `/memory` 通过 runtime API 读写引擎的原生记忆存储。
- **Notes** —— `/note` 记录按工作区的速记。
- **Skills** —— `/skills` 与 `/skill` 列出、切换技能。
- **MCP** —— `/mcp` 打开 VS Code 中与 MCP 相关的设置。
- **快照** —— `/restore` 列出快照，并可将工作区文件回滚到某个快照。

### 模型、成本与诊断
- 在状态栏**切换提供商与模型**，切换提供商时会实时预览可用模型。
- **思考深度**从 `off` 到 `max`。
- **成本来自 runtime** —— 用量与价格都由引擎提供，因此提供商调价不需要前端发版。`costCurrency` 跟随界面语言（`auto`）；没有记录成本时显示破折号，而不是估算值。
- **诊断** —— `/context`、`/tokens`、`/cost`、`/status`、`/cache`（最近 10 回合的前缀缓存遥测）、`/system`、`/diff`、`/translate`。
- **配置面板** —— 设置栏的齿轮（或 `/config`）可读写引擎的 runtime 配置，包括 sandbox 模式、strict tool 模式、memory、search provider 与 prompt suggestion。

### 为编辑器而做
- 活动栏容器，侧边栏包含 **Sessions**、**Threads**、**Activity** 三个标签页，最后者汇集 Work、Changes、Fleet、Tasks 与 Agents 面板。线程面板与对话并排显示，占用对话区的宽度而不是盖住它，且最多占用当前视图能匀出的宽度——侧边栏再窄，对话区也保留自己的一列；可用 ✕ 按钮或 `Esc` 收起。
- 状态栏显示引擎状态、模式、权限、提供商、模型与思考深度。
- 侧边栏与输入区可拖拽调整；自动跟随 VS Code 主题。
- **英文与简体中文**界面，跟随 VS Code 的显示语言。

## 命令

### VS Code 命令（命令面板）

| 命令 | 说明 |
|---|---|
| `CodeWhale: Open Chat` | 打开 CodeWhale 侧边栏 |
| `CodeWhale: New Thread` | 开始一个新对话 |
| `CodeWhale: Compact Context` | 压缩当前对话上下文 |
| `CodeWhale: Restart Engine` | 重启本地引擎进程 |

### 斜杠命令（聊天中输入）

**核心** —— `/help`、`/clear`、`/home`、`/exit`、`/links`、`/feedback`、`/attach`、`/anchor`、`/jobs`、`/trust`、`/verbose`

**配置与模型** —— `/mode`、`/auto`、`/model`、`/models`、`/provider`、`/reasoning`、`/config`、`/settings`、`/workspace`、`/profile`、`/mcp`、`/init`

**会话与文件** —— `/sessions`、`/load`、`/save`、`/export`、`/rename`、`/compact`、`/edit`、`/undo`、`/retry`、`/restore`、`/diff`

**任务、代理与目标** —— `/task`、`/goal`、`/skills`、`/skill`、`/note`、`/memory`

**诊断** —— `/status`、`/context`、`/tokens`、`/cost`、`/cache`、`/system`、`/translate`

> 部分 TUI 专有命令在 GUI 中会被识别但标记为不可用，例如 `/agent`、`/subagents`、`/hooks`、`/queue`、`/stash`、`/review`、`/lsp`、`/theme`、`/statusline`。它们会给出原因，而不是报「未知命令」，让命令面保持可预期。

## 配置项

在 VS Code 设置中搜索 `brotherwhale`（`Cmd/Ctrl+,`）。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `brotherwhale.enginePath` | `"codewhale"` | 引擎二进制路径。保持默认即使用内置的自动查找 |
| `brotherwhale.defaultModel` | `"deepseek-v4-pro"` | 新会话的回退模型：仅当该路线在 `brotherwhale.modelByProvider` 中无记录、且其运行时目录也没有模型时使用 |
| `brotherwhale.modelByProvider` | `{}` | 每条 provider 路线的新会话使用的模型，按路线 id（有精确 id 时为 `model_provider_id`）记录。由 `/model` 与 provider 选择器写入 |
| `brotherwhale.defaultMode` | `"agent"` | `agent`（Act）、`plan` 或 `operate`。旧的 `yolo` 值会解析为 Act + Full Access |
| `brotherwhale.defaultPermissionPosture` | `"ask"` | `ask`、`auto_review` 或 `full_access` |
| `brotherwhale.reasoningEffort` | `"auto"` | `auto`、`off`、`low`、`medium`、`high`、`max` |
| `brotherwhale.autoApprove` | `false` | 自动批准的旧兜底项。建议改用 **Full Access** 权限姿态，它本身已隐含自动批准 |
| `brotherwhale.costCurrency` | `"auto"` | `auto` 跟随界面语言（中文 → CNY，否则 USD），也可强制 `usd` / `cny`。没有原生 CNY 价格时回退到 USD |
| `brotherwhale.completionSound` | `true` | 一轮对话跑完时发出提示音 —— 正在看的会话与后台线程都包括。失败或中断的轮次不发声；同一时刻完成的轮次只响一次 |
| `brotherwhale.telemetry` | `true` | 让本窗口启动的引擎统计匿名用量。application 作用域；具体收集内容由引擎负责（见[用量统计](#用量统计)） |

## 工作原理

```
CodeWhale 侧边栏（webview：由扩展渲染的 HTML/CSS/JS）
        │  postMessage
ChatProvider（扩展宿主：chat-provider.ts、i18n、会话状态）
        │  在 127.0.0.1:<临时端口> 上的 HTTP
codewhale serve（引擎 —— 单独安装与升级）
        │
你的工作区 + 你在引擎中配置的模型提供商
```

1. 激活时，扩展解析 `codewhale` 二进制、分配一个空闲回环端口，并启动 `codewhale --workspace <folder> serve --http --host 127.0.0.1 --port <port>`。
2. 每个受信任的窗口独占自己启动的 Runtime 进程：每次启动生成新的 bearer token，只通过环境变量传给子进程（绝不出现在命令行参数中）；扩展会等待子进程自己的绑定成功回执后才发送任何请求，本地 API 会拒绝匿名调用。端口状态不在会话之间持久化；重启或关闭时也只停止本窗口启动的那个子进程。
3. webview 只与 `ChatProvider` 通信，`ChatProvider` 只与引擎的 runtime API 通信。没有第二份权威数据，扩展里也没有代理逻辑。
4. 启动时扩展会探测存在哪些 runtime 端点，因此依赖更新 API 的能力在旧引擎上会优雅降级。
5. 由于一切都发生在本地，模型访问、工具调用与文件变更都由引擎掌管 —— GUI 只负责呈现和引导。

### Runtime 生命周期与撤销

扩展只使用当前窗口启动的 Runtime，不连接旧端口文件指向的进程，也不会按端口终止其他程序。Runtime 的 token 为该进程单独生成，不会出现在命令行参数、设置或日志中。

关闭或重新加载窗口会停止该 Runtime，并中断正在运行的任务；已保存的会话可在重新打开后恢复。重新加载前请等待任务完成或取消任务，目前不支持运行中的任务跨窗口重载继续执行。

按文件的 Revert 走引擎的文件级恢复端点；如果引擎版本早于该端点，该控件会保持禁用并给出说明，撤销上一轮仍可通过既有的线程接口使用。

## 故障排除

**引擎启动失败**
- 检查安装：`codewhale --version`。
- 在命令面板执行 `CodeWhale: Restart Engine`。
- 查看 **CodeWhale** 输出通道（查看 → 输出 → CodeWhale）；引擎日志也会追加到扩展全局存储的 `engine.log`。

**提示找不到引擎**
- 在 `brotherwhale.enginePath` 中填写完整路径，例如 `/opt/homebrew/bin/codewhale` 或 `~/.local/bin/codewhale`。
- 先在 VS Code 之外的终端里确认该二进制可用。

**扩展没有激活**
- 重载窗口（`Developer: Reload Window`），并确认 VS Code 版本为 1.85+。

**某个按钮是灰的 /「不可用」**
- 该功能需要你安装的引擎尚未暴露的 runtime 端点。升级引擎（`codewhale update`）—— 端点出现后 UI 会自动启用。

**安装 VSIX**
```bash
code --install-extension /path/to/brotherwhale-vscode-0.8.4.vsix --force
```

## 隐私与数据

扩展只与 `127.0.0.1` 上**本地运行**的引擎通信。对话数据只会经由引擎、使用你在引擎中配置的提供商、模型与凭据送达模型提供商。提供商、模型与数据流向都由你掌控。

### 用量统计

用量统计在扩展启动的**引擎**里实现 —— 与 CodeWhale CLI / TUI 用的是同一套代码。前端只提供 `brotherwhale.telemetry` 这一个开关，以及会话上报所用的客户端名；具体收集什么、如何标识、发送到哪里都由引擎实现决定，契约见 [`docs/TELEMETRY.md`](https://github.com/codewhale-hq/Codewhale/blob/main/docs/TELEMETRY.md)。

把它设为 `false` 即可关闭上报。该设置默认开启，且为 application 作用域（只能写入用户设置），仓库自带的 `.vscode/settings.json` 无法为你重新打开上报。引擎在启动时读取它，因此修改会在**下次引擎启动**时生效 —— 执行「CodeWhale: Restart Engine」可立即生效。

## 开发指南

```bash
npm install
npm run compile   # 开发构建（含 source map）
npm run watch     # 变更时自动重建
npm test          # vitest 单元测试
npm run lint      # eslint
npm run package   # 生产构建
npx @vscode/vsce package --no-dependencies   # 打包 VSIX
```

项目结构：`src/extension.ts`（入口）→ `src/chat-provider.ts`（业务编排）→ `src/api/`（引擎进程 + runtime API 客户端）→ `src/commands/`（斜杠命令）→ `src/webview/`（按域拆分的 HTML/CSS/JS）→ `src/utils/`（diff、成本、会话状态）。更深的架构说明、以及让这个前端保持轻薄的「复用引擎、绝不重造」原则，见 `AGENTS.md`。

Pull Request 请按 [CONTRIBUTING.md](CONTRIBUTING.md)（中英双语）中的清单提交。

## 反馈与贡献

**欢迎通过 issue、discussion 和 pull request 参与反馈和贡献，中英文均可。**本扩展最好用的几个功能最初都来自社区 PR（[#9](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/9)–[#12](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/12)），还有很多值得做的事。

- **缺陷与功能建议** —— [提交 issue](https://github.com/HengQuWorld/CodeWhale-VSCode/issues/new/choose)，缺陷与功能建议各有模板。代理引擎本身的问题（`codewhale` CLI：提示词、模型、供应商、工具）请提[上游](https://github.com/Hmbown/CodeWhale/issues)，本仓库只维护前端。
- **提问与想法** —— [Discussions](https://github.com/HengQuWorld/CodeWhale-VSCode/discussions)，适合一切不是缺陷的内容。
- **代码** —— [CONTRIBUTING.md](CONTRIBUTING.md) 有开发环境、基本约定（代理行为归引擎，GUI 只做薄适配层）和 PR 检查清单。欢迎首次贡献者 —— 在 issue 下留言，维护者会帮你找到切入点。

## 相关项目

- **[CodeWhale](https://github.com/Hmbown/CodeWhale)** —— 本扩展所承载的开源编程代理。引擎文档、发行版与提供商配置都在那里。

## 贡献者

感谢通过 Pull Request 改进本扩展的每一位贡献者：

- **[@eoli](https://github.com/eoli)** —— [#9](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/9) 恢复并加固了侧边栏拖拽手柄、把输入区重构为带底栏的输入框、并将设置入口迁移到侧边栏标题栏齿轮（历经 #4–#8 数轮迭代）；[#10](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/10) 新增侧边栏 **Activity** 标签页与各标签说明文字，并为其加上智能体状态标签与关闭按钮；[#11](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/11) 新增带工具输入明细的悬浮审批面板、thinking 尾部预览与默认裁剪的工具块，并移除 smooth scrolling 让程序化滚动可靠落位；[#12](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/12) 让已生成的计划可一键确认并执行，并把模式与权限下拉移入工具栏
- **[@Hmbown](https://github.com/Hmbown)** —— [#2](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/2) 让每个窗口独立持有并认证自己的 Runtime，并为按文件恢复加了防护

## 许可证

[MIT](LICENSE)
