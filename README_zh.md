# CodeWhale for VS Code —— CodeWhale 代理的轻量图形前端

[![Version](https://img.shields.io/badge/version-0.6.2-blue)](https://github.com/HengQuWorld/CodeWhale-VSCode)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85+-informational)](https://code.visualstudio.com/)
[![VSIX](https://img.shields.io/badge/VSIX-~200%20KB-brightgreen)](https://github.com/HengQuWorld/CodeWhale-VSCode)

CodeWhale for VS Code 是 [CodeWhale](https://github.com/Hmbown/CodeWhale) 的**图形化前端**。CodeWhale 是一个开源且持续活跃开发的编程代理，本扩展把它装进 VS Code 原生侧边栏：读取工作区、修改文件、执行命令、搜索网络、派发子代理，全程不必离开编辑器。

围绕 CodeWhale，社区为同一个引擎提供了两种界面：**TUI** 面向习惯终端的人，本 **GUI** 面向习惯编辑器的人。它们共享同一个引擎和核心 runtime 概念，但 GUI 明确是围绕编辑器工作流做的取舍，目前仍有一部分高级能力只在 TUI 中提供。

这个分工是刻意的：**代理留在引擎里，体验留在编辑器里。** 本扩展不打包、不分叉、也不重新实现代理，它只是引擎之上的一个薄的本地 GUI。

## 为什么它能保持轻量

| | |
|---|---|
| VSIX 体积（0.6.2） | 约 200 KB |
| 运行时 npm 依赖 | **零** —— 扩展自身的 TypeScript（以及用于渲染的 `marked`）都被 webpack 内联 |
| 打包的引擎或模型 | **无** —— `codewhale` 是独立的原生二进制 |
| 重复实现的代理逻辑 | **无** —— GUI 只是引擎本地 runtime API 之上的适配层 |
| 扩展内的权威会话状态存储 | **无** —— 线程、回合、工具调用、文件变更都以引擎为唯一权威 |

前端是一个 webview：`ChatProvider` 运行在扩展宿主中，通过 HTTP 访问 `127.0.0.1`，把引擎报告的内容渲染出来。当安装的引擎暴露了更新的 runtime 端点时，UI 就直接使用；没有暴露时，相关功能会带着说明被禁用，而不是在运行时崩掉 —— 这也是 Undo、Retry、快照 Restore 会显示为「不可用」灰态而不是坏按钮的原因。

正因为代理的任何一部分都没有被复制进扩展，引擎可以独立发布新能力和修复，而不需要前端跟着发版。

## 预览

**消息导航轨** —— 右侧边缘的圆点可跳转到任意用户消息，`Ctrl/Cmd+Up` / `Ctrl/Cmd+Down` 可在消息之间前后跳转。

![消息导航轨](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/01-message-nav.gif)

**文件变更的内联差异** —— 变更卡片打开差异视图，行号正确，还原的是模型当时看到的文件内容。

![文件变更差异](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/02-diff.gif)


## 系统要求

| 要求 | 说明 |
|---|---|
| **VS Code 1.85+** | 或兼容的 IDE —— 支持 Trae CN |
| **CodeWhale 引擎** | 即 `codewhale` CLI。**未随扩展打包**，需单独安装（见下） |
| **Node.js** | 仅在从源码构建扩展、或通过 npm 安装引擎时需要 |

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
code --install-extension ./brotherwhale-vscode-0.6.2.vsix --force
```

> **Trae CN 用户：** 如果 `code` 不在 `PATH` 中，使用自带的 CLI：
> ```bash
> "/Applications/Trae CN.app/Contents/Resources/app/bin/code" --install-extension ./brotherwhale-vscode-0.6.2.vsix --force
> ```

### 3. 打开它

点击活动栏中的 **CodeWhale 图标**。扩展会按需为你的工作区启动引擎、做健康检查，并在状态栏显示 **Ready**。第一条消息最慢，之后引擎会被复用。

## 功能特性

### 像代理、而不是像输入框的聊天
- **流式回合**，带可折叠的思考面板；工具调用卡片会显示实际参数（例如 shell 命令以 `$ ...` 代码块呈现）；每回合带 `↑/↓` token 用量标记。
- **回合中引导（steering）** —— 回合运行期间按 Enter 会把内容作为指引送进当前回合，而不是开启新回合（与引擎的 steering 输入一致）；被引导的消息会带一个 steer 徽标。
- **统一的发送/停止按钮**，反映真实的回合状态；并提供上一回合的 **Undo** 与 **Retry**。
- **附件** —— `/attach` 打开原生文件选择器，可附图片、PDF 及其他文件。
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
- **注意力提示** —— 等待审批或等待你输入的线程，会在它的卡片上显示待办数量（归入 *Needs you* 分组），工具栏 **Agent** 标签上显示总数，并弹出 VS Code 通知（可用 `brotherwhale.backgroundThreadNotifications` 关闭）。其它线程的审批与提问可以直接在它的卡片内联回答，不用先切过去。
- **监视而非轮询** —— 每个正在运行或等待你的后台线程各持有一条轻量 SSE 流，徽章、通知与自动保存都是实时的，不再有定时轮询。
- 侧边栏三个并列标签页 —— **Sessions**（已保存的会话）、**Threads**（进行中的线程）、**Activity**（智能体实时状态：工作、车队、任务、子代理、变更），每个标签下都有一行说明它装了什么。

### 编辑器内的变更与差异
- 每个会话一个 **Changes** 区块，文件变更卡片由引擎权威的 mutation 元数据构建。
- **差异视图**行号正确，还原的是模型当时看到的文件内容。
- 可直接在编辑器中 **Open** 变更文件，或内联 **Diff**。
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
- 活动栏容器，侧边栏包含 **Sessions**、**Threads**、**Activity** 三个标签页，最后者汇集 Work、Fleet、Tasks、Agents 与 Changes 面板。线程面板与对话并排显示，占用对话区的宽度而不是盖住它，可用 ✕ 按钮或 `Esc` 收起。
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
| `brotherwhale.defaultModel` | `"deepseek-v4-pro"` | 新线程的默认模型 |
| `brotherwhale.defaultMode` | `"agent"` | `agent`（Act）、`plan` 或 `operate`。旧的 `yolo` 值会解析为 Act + Full Access |
| `brotherwhale.defaultPermissionPosture` | `"ask"` | `ask`、`auto_review` 或 `full_access` |
| `brotherwhale.reasoningEffort` | `"auto"` | `auto`、`off`、`low`、`medium`、`high`、`max` |
| `brotherwhale.autoApprove` | `false` | 自动批准的旧兜底项。建议改用 **Full Access** 权限姿态，它本身已隐含自动批准 |
| `brotherwhale.costCurrency` | `"auto"` | `auto` 跟随界面语言（中文 → CNY，否则 USD），也可强制 `usd` / `cny`。没有原生 CNY 价格时回退到 USD |
| `brotherwhale.backgroundThreadNotifications` | `true` | 后台线程需要你审批或输入时弹出 VS Code 通知（每次等待只提醒一次；Threads 侧栏徽章与计数始终实时） |

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

单文件恢复暂不可用，因为 Runtime 快照恢复会影响整个工作区。完整轮次的撤销和重试继续使用 Runtime 的线程级补丁接口。

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
code --install-extension /path/to/brotherwhale-vscode-0.6.2.vsix --force
```

## 隐私与数据

扩展只与 `127.0.0.1` 上**本地运行**的引擎通信，不含任何遥测与分析代码。对话数据只会经由引擎、使用你在引擎中配置的提供商、模型与凭据送达模型提供商。提供商、模型与数据流向都由你掌控。

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

## 相关项目

- **[CodeWhale](https://github.com/Hmbown/CodeWhale)** —— 本扩展所承载的开源编程代理。引擎文档、发行版与提供商配置都在那里。

## 贡献者

感谢通过 Pull Request 改进本扩展的每一位贡献者：

- **[@eoli](https://github.com/eoli)** —— [#9](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/9) 恢复并加固了侧边栏拖拽手柄、把输入区重构为带底栏的输入框、并将设置入口迁移到侧边栏标题栏齿轮（历经 #4–#8 数轮迭代）；[#10](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/10) 新增侧边栏 **Activity** 标签页与各标签说明文字，并为其加上智能体状态标签与关闭按钮
- **[@Hmbown](https://github.com/Hmbown)** —— [#2](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/2) 让每个窗口独立持有并认证自己的 Runtime，并为按文件恢复加了防护

## 许可证

[MIT](LICENSE)
