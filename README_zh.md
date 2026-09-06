# CodeWhale for VS Code — CodeWhale AI 代理的图形化前端

[![Version](https://img.shields.io/badge/version-0.5.0-blue)](https://github.com/HengQuWorld/CodeWhale-VSCode)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85+-informational)](https://code.visualstudio.com/)

CodeWhale for VS Code 是 [CodeWhale](https://github.com/Hmbown/CodeWhale.git) 的 **图形化前端**，将终端 AI 编程代理封装为 VS Code 原生侧边栏体验。你无需离开编辑器，即可获得 CodeWhale 的全部代理能力 —— 读取工作区、编写文件、运行命令、搜索网络、管理多步骤任务。

## 🔗 上游项目

本扩展依赖 **CodeWhale TUI 引擎**。上游项目提供了核心 AI 代理能力：

- 📦 **上游仓库**: [CodeWhale](https://github.com/Hmbown/CodeWhale.git)
- 🖥️ **引擎程序**: `codewhale` CLI（详见下方 [前置条件](#前置条件--系统要求)）

## 预览

> TODO：添加展示扩展功能的截图或 GIF。  
> 建议：聊天界面、斜杠命令、任务管理、设置界面。

---

## 前置条件 / 系统要求

使用本扩展之前，你必须安装并运行 **CodeWhale 引擎**：

| 要求 | 安装方式 |
|---|---|
| **CodeWhale CLI** | `npm install -g codewhale` |
| **VS Code** | 1.85+（[下载](https://code.visualstudio.com/)） |
| **Node.js** | 18+（引擎依赖） |

扩展会自动在标准安装路径中查找 `codewhale` 程序。在 macOS 上，它可能位于 `/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale`。

> ⚠️ **重要**：本扩展**仅为 GUI 层**，不包含 AI 引擎。核心 CodeWhale 引擎（`codewhale` CLI）需要从上游项目单独安装：[CodeWhale](https://github.com/Hmbown/CodeWhale.git)。

---

## 功能特性

### 侧边栏中的 AI 代理
- **完整编程代理** — CodeWhale 读取、写入、修补文件，运行 Shell 命令，搜索代码，浏览网页来完成你的目标。
- **三种模式**：`agent`（自主执行，需审批）、`plan`（执行前提案）、`yolo`（完全自主）。
- **自由切换模型** — 随时使用 `/model` 切换模型。
- **推理深度控制** — 从 `off` 到 `max`，平衡速度与深度。

### 对话与线程管理
- **多线程对话** — 将工作组织到独立线程中，自动保留历史记录。
- **斜杠命令** — `/help`、`/mode`、`/model`、`/reasoning`、`/task`、`/compact`、`/note`、`/memory`、`/export` 等。
- **上下文压缩** — 对话过长时，使用 `/compact` 进行摘要，释放上下文窗口空间。
- **导出与保存** — 导出对话以进行分享或归档。

### 工作区集成
- **上下文感知** — CodeWhale 自动理解你的打开工作区、项目结构和文件内容。
- **实时差异** — 以内联 diff 视图查看代理提议的文件更改。
- **文件变更追踪** — 每轮对话中新建、修改、删除的文件都会被高亮显示。

### 任务系统
- **后台任务** — 使用 `/task add <prompt>` 将耗时工作转为后台执行。
- **任务侧边栏** — 在 Tasks 面板中查看和管理任务进度。
- **任务生命周期** — 无需离开编辑器即可创建、查看、取消任务。

### 引擎管理
- **自动启动** — 扩展激活时 CodeWhale 引擎自动启动。
- **按需重启** — 遇到问题时使用 `CodeWhale: 重启引擎` 命令或 `/restart`。
- **端口持久化** — 引擎跨会话复用上次的端口，加快启动速度。

### 为 VS Code 打造
- **活动栏集成** — 活动栏中专属 CodeWhale 图标。
- **侧边栏面板** — Chat、Threads、Work、Tasks 面板。
- **状态栏** — 模型、模式和工作区状态指示。
- **设置界面** — 通过 VS Code 设置配置模型、模式、推理深度、引擎路径、自动审批等。
- **深色与浅色主题** — 自动跟随 VS Code 主题。

---

## 快速开始

### 1. 安装引擎

打开终端，安装 `codewhale` CLI：

```bash
npm install -g codewhale
```

确认引擎已安装：

```bash
codewhale --version
```

> `codewhale` CLI 是本扩展背后的 AI 引擎。你也可以直接从[源代码仓库](https://github.com/Hmbown/CodeWhale.git)编译安装。

### 2. 安装扩展

**方式 A — VS Code 插件市场**（推荐）：
在 VS Code 扩展面板（`Cmd+Shift+X`）中搜索 "CodeWhale"，点击安装。

**方式 B — 从源码构建**：
```bash
git clone https://github.com/HengQuWorld/CodeWhale-VSCode.git
cd CodeWhale-VSCode
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```
然后从 VS Code 扩展菜单中点击 `Install from VSIX...`，选择生成的 `.vsix` 文件。

### 3. 打开 CodeWhale

点击活动栏中的 **CodeWhale 图标**（左侧边缘的层叠鲸鱼图标）。引擎会自动启动——你会在状态栏看到"就绪"指示。

### 4. 开始对话

在聊天面板中输入内容。试试你的第一条命令：

```
我的项目里有哪些文件？
```

就这么简单。代理会读取你的工作区并回答。

### 快速命令

| 命令 | 说明 |
|---|---|
| `CodeWhale: 打开聊天` | 打开 CodeWhale 聊天面板 |
| `CodeWhale: 新建线程` | 开始新对话 |
| `CodeWhale: 压缩上下文` | 压缩当前对话上下文 |
| `CodeWhale: 重启引擎` | 重启 CodeWhale 引擎 |

### 斜杠命令（聊天中使用）

| 命令 | 功能 |
|---|---|
| `/mode [agent\|plan\|yolo]` | 切换模式 |
| `/model [名称]` | 切换模型 |
| `/reasoning [auto\|off\|low\|medium\|high\|max]` | 设置推理深度 |
| `/task add <描述>` | 创建后台任务 |
| `/task list` | 列出任务 |
| `/task show <id>` | 查看任务详情 |
| `/task cancel <id>` | 取消任务 |
| `/compact` | 压缩对话上下文 |
| `/clear` | 清空聊天 |
| `/save` | 保存对话 |
| `/export` | 导出对话 |
| `/note <文本>` | 添加笔记 |
| `/memory` | 管理持久记忆 |
| `/help` | 显示所有命令 |

---

## 配置说明

通过 VS Code 设置配置 CodeWhale（`Cmd+,` → 搜索 "brotherwhale"）。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `brotherwhale.enginePath` | `"codewhale"` | codewhale 程序路径 |
| `brotherwhale.enginePort` | `7878` | CodeWhale 运行时 API 端口 |
| `brotherwhale.defaultModel` | `"deepseek-v4-pro"` | 新线程的默认模型 |
| `brotherwhale.defaultMode` | `"agent"` | 默认模式（agent / plan / yolo） |
| `brotherwhale.reasoningEffort` | `"auto"` | 推理深度级别 |
| `brotherwhale.autoStartEngine` | `true` | 激活时自动启动引擎 |
| `brotherwhale.autoApprove` | `false` | Agent 模式下自动审批工具调用 |

---

## 故障排除

### 引擎启动失败
- 确认 `codewhale` 已安装：`npm list -g codewhale`
- 尝试命令面板中的 `CodeWhale: 重启引擎`。
- 查看 CodeWhale 输出通道（查看 → 输出 → CodeWhale）获取错误详情。

### 扩展无法激活
- 重新加载 VS Code 窗口（`Cmd+Shift+P` → `Developer: 重新加载窗口`）。
- 确认已安装 VS Code 1.85+。

### 找不到引擎
- 在 `brotherwhale.enginePath` 中设置引擎程序的完整路径。
- 常见路径：`/opt/homebrew/bin/codewhale`、`/usr/local/bin/codewhale`。

### 安装 VSIX
```bash
code --install-extension /path/to/brotherwhale-vscode-0.5.0.vsix --force
```

> **Trae CN 用户**：如果 `code` 命令不可用，使用完整路径：
> ```bash
> "/Applications/Trae CN.app/Contents/Resources/app/bin/code" --install-extension /path/to/brotherwhale-vscode-0.3.1.vsix --force
> ```

---

## 隐私与数据

CodeWhale 连接的是**本地运行**的引擎。对话数据只发送到你 CodeWhale 配置中指定的 AI 模型提供商。你完全掌控提供商、模型和数据流向。

---

## 开发指南

```bash
git clone https://github.com/HengQuWorld/CodeWhale-VSCode.git
cd CodeWhale-VSCode
npm install
npm run compile   # 开发模式编译（含 source map）
npm test          # 运行测试
npm run package   # 生产模式编译（压缩）
npx @vscode/vsce package --no-dependencies  # 打包 VSIX
```

---

## 相关项目

- [CodeWhale](https://github.com/Hmbown/CodeWhale.git) — 为本扩展提供支持的上游终端 AI 编程代理引擎。

---

## 许可证

[MIT](LICENSE)
