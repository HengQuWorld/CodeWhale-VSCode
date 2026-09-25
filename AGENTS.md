# CodeWhale VSCode 项目指南

## 项目概述

CodeWhale VSCode 是一个 VSCode 扩展，为 CodeWhale TUI 提供图形界面。该扩展通过 WebView 与用户交互，连接到 CodeWhale TUI 引擎进行 AI 对话。

## 开发环境设置

### 前置要求
- Node.js 18+
- npm 或 yarn
- VSCode 或兼容的 IDE（如 Trae CN）

### 安装依赖
```bash
npm install
```

## 编译与构建

### 开发模式编译
```bash
npm run compile
```
- 使用 webpack 编译开发版本
- 输出文件：`dist/extension.js`
- 包含 source map，便于调试

### 生产模式打包
```bash
npm run package
```
- 使用 webpack 编译生产版本
- 代码压缩优化
- 输出文件更小（约 168KB）

### 运行测试
```bash
npm test
```
- 使用 vitest 运行单元测试
- 测试文件位于 `src/*.test.ts`

## 插件打包与安装

### 打包为 VSIX 文件
```bash
npx @vscode/vsce package --no-dependencies
```
- 生成 `brotherwhale-vscode-0.1.0.vsix` 文件
- 包含所有必要的源文件和资源
- 文件大小约 180KB

### 安装 VSIX
```bash
code --install-extension ./brotherwhale-vscode-0.1.0.vsix --force
```

> 使用 Trae CN 时如果 `code` 不可用，先设置 alias：
> ```bash
> alias code="/Applications/Trae CN.app/Contents/Resources/app/bin/code"
> ```

### 一键编译打包安装
```bash
npm run compile && \
npx @vscode/vsce package --no-dependencies && \
code --install-extension ./brotherwhale-vscode-0.1.0.vsix --force
```

### 安装后激活
安装完成后，重新加载窗口：
- 按 `Cmd+Shift+P` 打开命令面板
- 输入 "Reload Window" 并执行

## 项目结构

```
DeepSeek-GUI/
├── src/
│   ├── extension.ts          # 扩展入口点
│   ├── chat-provider.ts      # 主聊天界面逻辑（业务编排）
│   ├── config-panel.ts       # 配置面板
│   ├── i18n.ts               # 国际化支持（en/zh/tr 三语映射）
│   ├── types.ts              # 共享类型定义
│   ├── api/                  # api-client.ts（Runtime API 客户端）、engine.ts（TUI 引擎管理）
│   ├── commands/             # slash-commands.ts（命令注册表）、slash-command-handler.ts（dispatcher）
│   ├── utils/                # cost-calculator、diff-utils、error-handler、session-state 等
│   └── webview/              # webview-html.ts（HTML 模板）、webview-css.ts、webview-js-*.ts（按域拆分的脚本模块）
├── dist/                     # 编译输出
├── media/                    # 图标等资源
├── package.json              # 扩展配置
└── webpack.config.js         # Webpack 配置
```

> 注意：webview 前端脚本已按域拆分到 `src/webview/webview-js-*.ts`（fleet / goal / input / messages / sidebar / tooltip / utilities / debug / event-handler 等），不再是单个巨型内联块；但「一损俱损」的教训仍然适用（见下文「编码注意的坑」）。

## 关键功能模块

### 1. WebView 通信
- `chat-provider.ts` 管理与 WebView 的双向通信
- 消息类型：`sendMessage`, `slashCommand`, `loadThread`, `interrupt` 等
- 使用 `postMessage` API 发送消息

### 2. 斜杠命令处理
- `src/commands/slash-commands.ts` 定义命令注册表（`COMMANDS` 数组 + availability 标记）
- `src/commands/slash-command-handler.ts` 用 dispatcher Map（`HANDLERS`）分发命令逻辑，不再是巨型 switch
- 命令格式：`command` + `args`（例如：`/task` + `show task_id`）
- 标记为 `unavailable` 的命令必须有兜底提示；注意 HANDLERS 与 slash-commands.ts 的 COMMANDS 数组要保持同步

### 3. 任务管理
- 任务列表显示在侧边栏的 "Tasks" 标签页
- 支持创建、查看、取消任务
- 点击任务卡片触发 `/task show <id>` 命令

### 4. 侧边栏状态
- 侧边栏三个并列标签页：Sessions（默认激活）、Threads、Activity；没有设置可以隐藏其中任何一个
- Activity 标签内汇集 Work、Fleet、Tasks、Agents、Changes 区块（各自仍可折叠）
- Threads 面板与对话并排（`#threads-panel` 是 `#layout` 里的普通 flex 子项，靠 `.open` 显示），从对话区让出宽度而不是盖住它；不要改回绝对定位的覆盖写法
- 打开后保持打开状态，除非用户明确关闭（✕ 按钮或 `Esc`）
- 点击线程项不会自动关闭侧边栏
- Changes 区块列出**整个会话**的文件变更，按轮次分组（每条变更带 `turnIndex`，`changesState` 消息同时带 `turns` 分组元数据）。轮次边界只**新开一个分组**，不清空列表：`sendMessage` / 外部回合开始时调 `beginChangeTurn`，只有重建整个面板的路径（`loadHistory`、fork/retry、切会话）才调 `resetChangeGroups`。`changeIndex` 与 diff 重建都是按文件、跨整个会话编号的，改回「只留本轮」会让 Diff/回滚/Revert 的目标错位。

## 常见问题修复

### 问题：任务列表点击报错 "Unknown command"
**原因**：消息格式错误，将整个命令字符串作为 `command` 参数发送

**修复**：
```javascript
// 错误格式
vscode.postMessage({ type: 'slashCommand', command: '/task show ' + taskId });

// 正确格式
vscode.postMessage({ type: 'slashCommand', command: '/task', args: 'show ' + taskId });
```

### 问题：侧边栏自动关闭
**原因**：点击线程项时自动移除 `open` 类

**修复**：移除自动关闭代码
```javascript
// 移除这行
threadsPanel.classList.remove('open');
```

## 开发建议

### 代码风格
- 使用 TypeScript 严格模式
- 遵循 ESLint 规则
- 函数和变量使用 camelCase
- 类和接口使用 PascalCase

### 调试技巧
1. 使用 `console.log` 输出到 VSCode 开发者工具（Help → Toggle Developer Tools）
2. WebView 中的 `console.log` 输出到浏览器控制台
3. 使用 `postMessage` 记录消息流

### 性能优化
- WebView HTML 模板使用模板字符串，避免频繁 DOM 操作
- 使用事件委托处理列表项点击
- 避免在渲染函数中创建重复的事件监听器

## 发布流程

1. 更新 `package.json` 中的版本号
2. 运行测试：`npm test`
3. 编译生产版本：`npm run package`
4. 打包 VSIX：`npx @vscode/vsce package --no-dependencies`
5. 测试安装：安装到本地 IDE 验证功能
6. 发布到 VSCode Marketplace（如果需要）

## 相关项目

- **CodeWhale TUI**: TUI 引擎，提供 API 服务
- **DeepSeek API**: DeepSeek AI API 接口

## 联系与支持

- 项目仓库：https://github.com/HengQuWorld/CodeWhale-VSCode
- 问题反馈：通过 GitHub Issues

---

## 编码注意的坑（WebView + 大型前端块修改经验总结）

### 根因案例（2026-06-04 撤销/重试功能卡 Initializing 事件）

> 现象：在 `webview-html.ts` 的 `<script>` 块中添加了新函数 `updateUndoRetryState()` 引用了 `messages` 变量，但原始代码中**只有** `messagesEl`（DOM 元素引用），**未声明过** `messages` 数组变量。新代码在 script 块靠前位置执行 → 抛出 `ReferenceError: messages is not defined` → 整个 script 块**停止执行** → 后续所有初始化（status 更新、消息订阅、按钮事件绑定）全部死锁 → UI 永远停在 "Initializing..."。

### 核心教训

1. **大型 inline `<script>` 块是一荣俱荣、一损俱损的整体**
   - VSCode WebView 的 `webview.html` 是单文件模板，里面常常塞一个 80~200 KB 的 `<script>` 块
   - 该块中**任何位置**的运行时错误（`ReferenceError` / `TypeError` / 语法错误）都会让**整个块停止执行**
   - 后果：用户看到的不是"某个按钮不工作"，而是**整个 webview 看起来死了**（Initializing 永远不消失、状态栏不更新、按钮全无响应）

2. **不要假设前端存在某个变量**
   - 大型 webview 脚本里**有大量闭包、模块模式、IIFE**，变量要么在 `window` 上、要么闭包私有
   - 修改前必须**先 grep** 确认变量是否被声明：`grep -n "let X\|var X\|const X" webview-html.ts`
   - 如果找不到 → **不要直接用**。要么走 postMessage 让后端判断，要么自己维护一个 IIFE 局部变量

3. **修改 webview 前端的最安全姿势**
   - **优先后端**：按钮 → `vscode.postMessage({ type: 'xxx' })` → 后端判断 + 状态机
   - **不依赖前端变量**：所有判断逻辑放在后端 `chat-provider.ts`，前端只负责"显示/发消息"
   - **新逻辑放 IIFE 隔离**：用 `(function(){ ... })()` 包起来，自己声明局部变量，**绝不**污染外层作用域
   - **绑定 handler 用 try/catch 包装**：单个按钮的 handler 出错不应该影响其他按钮
   - **事件委托复用现有模式**：新按钮的 click 处理**插到**原有 `addEventListener('click', ...)` 内部，跟着 `target.classList.contains('xxx')` 走

4. **debug 大型 webview 卡死的二分定位法**
   - 第一步：`git stash` 全部本地修改 → 打包测试
     - 正常 → 我的修改是问题源
     - 还是卡 → 是环境问题（不是代码）
   - 第二步：`git checkout` 逐个文件回退，找出**哪个文件**的修改导致问题
   - 第三步：定位具体行时，从**最简化的修改**开始（只加 1 行 HTML / 1 个 postMessage）→ 测试 → 逐步加代码 → 找到出错的那行
   - **不要**用 `console.log` 散弹枪调试大型 webview 块——错误抛出后**后续所有 `console.log` 也不会执行**，所以看到的"没日志"不代表"没出错"，而可能**脚本已经死了**

5. **绝对不要把 HTML 调试标记 + 状态文字改动直接 commit**
   - 调试时的 BOOT marker、CSP 临时移除、`_debugMode = true`、写日志到磁盘等**都是一次性探针**
   - 找到根因后**立即 revert** 这些探针代码
   - 探针代码混在生产代码里 → 下次再调试时浪费更多时间判断"这些是做什么的"

6. **CSP / nonce / script 块语法问题的早期信号**
   - JS 完全不执行 + Console 完全没日志 → **整段 script 被浏览器拒绝**（CSP 阻止、语法错误导致整个块拒绝解析、nonce 不匹配）
   - JS 执行了一段然后挂 → `ReferenceError` / `TypeError` / 无限循环
   - UI 部分渲染（HTML）但交互失效 → 事件 handler 报错或没绑上

### 检查清单（每次修改 webview-html.ts 前对照）

- [ ] 已用 `grep` 确认所有引用的变量在 script 块中存在
- [ ] 所有新 UI 逻辑尽量放后端
- [ ] 新代码用 IIFE 隔离，不污染外层
- [ ] 调试探针代码标记为 `// DEBUG:`，调试完**立即删除**
- [ ] 至少在 IDE 重新加载一次 webview 验证状态从 "Initializing" 变 "Ready"
- [ ] 修改量 > 50 行时，分批 commit，便于 `git bisect` 定位问题

---

## TUI / GUI 功能一致性原则

### 核心规则：GUI 实现**必须参考 TUI 的设计**，保持行为一致

GUI 是 TUI 的图形前端，用户在两种界面下的操作应该产生相同的效果。实现新功能前，**先读 TUI 源码**理解其设计意图，再决定 GUI 的实现方式。

### 实现优先级

1. **优先使用 TUI 已有的 Runtime API** — GUI 通过 HTTP 调用 TUI 的 `/v1/*` 端点
2. **如果 TUI 有功能但缺少 API 端点** — 先在 TUI 的 `runtime_api.rs` 中添加端点，再在 GUI 实现
3. **如果 TUI 也没有该功能** — 先在 TUI 设计并实现，暴露 API，再在 GUI 对接

**绝不**在 GUI 中用 hack/变通方式模拟一个 TUI 已有但 GUI 没有对接的功能。

### 模式与权限姿态契约（2026-09 起与 TUI 对齐）

TUI 把「对话模式」和「权限姿态」当作**两个独立维度**，GUI 必须同样处理，不要再用 `yolo` 当作模式：

| 维度 | 取值 | 显示名 | 切换方式 |
|------|------|--------|----------|
| TUI mode | `agent` / `plan` / `operate` | Act / Plan / Operate | 状态栏模式下拉；`/mode`；数字 `1`/`2`/`3` |
| Permission posture | `ask` / `auto_review` / `full_access` | Ask / Auto-Review / Full Access | 状态栏 Permission 下拉；`/auto` |

- `yolo`（及 `4` / `bypass` / `bypass-permissions` / `bypasspermissions`）是 **Act + Full Access 的单向兼容别名**，不是模式，也不出现在下拉里。
- 单一事实来源：`src/utils/modes.ts`（镜像 `crates/config/src/app_mode.rs`、`crates/execpolicy/src/approval_mode.rs` 与 `crates/tui/src/runtime_policy.rs`）。状态栏下拉与配置面板的选项都由它生成，**不要在任何新代码里硬编码模式/姿态字符串**。
- 三套拼法不要混用：`POSTURE_WIRE`（线程/Runtime 请求体，snake_case）、`POSTURE_CONFIG`（引擎配置 `approval_mode`，hyphenated）、`POSTURE_LABELS`（UI 显示名）。配置面板的姿态下拉只提供 `ask`/`auto-review`/`full-access`：`use-tui-default` 属于另一个 key `approval_policy`，`never` 是托管策略值，两者都不是 `approval_mode` 的合法取值。
- 改模式时只 PATCH `{ mode }`，改姿态时只 PATCH `{ permission_posture }`；运行时会自行推导 `auto_approve` / `trust_mode`（`runtime_policy_with_overrides`）。把 GUI 缓存的 `auto_approve: false` 一起发出去（且不带显式姿态）会把 Auto-Review 姿态重新推导成 Ask。
- 兼容旧记录的姿态推导必须与引擎的 `RuntimePolicyProjection::from_persisted` 一致：`permission_posture` 优先，其次看 mode 的 `yolo` 别名与 `auto_approve`；**不要**参考 `trust_mode`（引擎会忽略它）。
- 启动默认值：`brotherwhale.defaultMode`（`agent|plan|operate`）与 `brotherwhale.defaultPermissionPosture`（`ask|auto_review|full_access`）。它们只作用于**新建**线程；下拉把两个作用域分开列出（item 带 `data-scope="thread|default"`，由 `scopedDropdownItems()` 生成），第二组才写这两个配置项。`/mode`、`/auto` 与计划确认只作用于当前线程；无当前线程时（新会话视图、浏览已保存会话）它们落到启动默认值并在提示里说明作用域。默认值的当前值经 `scopedDefaults` 消息推给 webview 用于打勾。
- `resume-thread` 请求体只有 `model`/`mode`（`runtime_api/sessions.rs`），**不支持** `permission_posture`；恢复的线程姿态由引擎从会话本身推导。

> 注意：模式可选 `operate` 与 `/v1/operate` 编排面（operate run / plan / keepalive）是两回事；后者仍未对接。

### 当前已知差异（2026-09 对齐检查结果）

undo / retry / patch-undo / 快照恢复这条链路**已完成对齐**：

| 功能 | TUI 端点 | GUI 实现 | 状态 |
|------|----------|----------|------|
| `/undo` | `POST /v1/threads/{id}/patch-undo` | `chat-provider.ts` `handleUndoLastTurn()` 调 `patchUndoThreadTurn()`，先快照回滚文件再删对话轮 | 已对齐 |
| `/retry` | `POST /v1/threads/{id}/retry` | `handleRetryLastTurn()` 调 `retryThreadTurn()`（服务端 undo + 重发） | 已对齐 |
| 从指定轮次分叉（GUI 主导） | `POST /v1/threads/{id}/fork-at-turn` | 每条回答（每轮的最后一个 assistant 消息）下方的“分叉”行 → `handleForkFromTurn(turnId)`；引擎解析 turn id，GUI 不数轮次 | 已对齐（路由为本功能新增，旧引擎无此路由 → 该行不渲染） |
| `/restore` | `GET /v1/snapshots` + `POST /v1/snapshots/{id}/restore` | `api-client.ts` 已有 `listSnapshots()` / `restoreSnapshot()`；`chat-provider.ts` 用 pre-turn 快照做恢复 | API 已对接，**`/restore` 斜杠命令入口缺失**（slash-commands.ts 仍标 unavailable） |

当前真实缺口集中在「平台管理面」（TUI 有 API，GUI 未对接）：

| TUI 功能面 | 端点 | GUI 现状 |
|------------|------|----------|
| MCP 服务器管理 | `/v1/apps/mcp/servers` 全套 CRUD + enable/disable/reconnect + `/v1/apps/mcp/tools` | `/mcp` 只打开 VSCode settings（hack，待改 API 面板） |
| 插件管理 | `/v1/apps/plugins` + install/update/trust/enable/disable/revoke | 完全缺失 |
| 市场管理 | `/v1/apps/marketplaces` + install | 完全缺失 |
| Skills 管理增强 | `/v1/skills/install`、`/{name}/update`、`/{name}/trust`、`/{name}/audit` | 只有 list + enable/disable |
| Agent mail | `/v1/agent-mail`、`/v1/threads/{id}/agent-mail` | 完全缺失 |
| Operate（模式） | 线程 `mode: "operate"` | 状态栏模式下拉 / `/mode operate`，已对齐 |
| Operate（编排 API） | `/v1/operate` 全套（run/plan/keepalive/auto-merge） | 完全缺失 |
| Memory | `/v1/memory` 全套 | **违反复用原则**：`slash-command-handler.ts` 的 `/memory` 直接读写 `~/.deepseek/memory.md` 本地文件，应改走 API |

> 本表是对齐检查的**快照**，会过时。做新功能前先重新核对源码：TUI 端点查 `runtime_api.rs` 的 `build_router()`，GUI 对接查 `src/api/api-client.ts`，命令查 `commands/mod.rs` 的 `execute()` 与 `src/commands/slash-commands.ts`。不要把此表当全量清单。

### 由 GUI 主导新增的引擎端点：`fork-at-turn`

TUI 的 `/fork` 只能整会话复制，`fork_at_user_message` 又只按「距尾部多少轮」定位，所以「从某一轮分叉」**没有现成的 TUI 命令**，是 GUI 提出、并由 TUI 已有能力（`fork_at_user_message`）实现的：

- 锚点必须是 **turn id**（`GET /v1/threads/{id}` 返回的那个），不是 GUI 自己数出来的轮次序号。GUI 渲染出的对话（有 steer、纯图片输入、内部 handoff 等情况）和引擎的 turn store 不是同一份列表，客户端算出来的 depth 错一格就会分叉到错误的轮次，而且还返回 201。
- 语义是「**保留**锚点那一轮及之前的全部轮次」（不是丢掉锚点轮），所以入口画在**每条回答的下方**（`branchTurnId` 只打在每轮的最后一个 assistant 消息上），而不是用户消息上——分叉点是用户正在看的那条回答；锚点选最后一轮就等于整会话复制。回执里的 `original_user_text` 是**第一个被丢掉的轮次**的提问（即“原会话接下来问的”），GUI 把它放回输入框。
- **已保存会话（Sessions 轨道里查看的会话）不能直接分叉**：分叉要的是 turn id，而一个被查看的会话只是一份 messages 文档，没有 turn。GUI 的做法是提供 **Continue**（工具栏按钮，`handleContinueSession` → `resumeViewedSessionForAction()`，不发任何消息）：把会话 resume 成活动线程后，它的每一轮都带上精确锚点、都有分叉行。undo/retry 早就静默做这一步，现在抽成同一个 helper，三个动作共用。按钮只在 `sessionLoaded` 时显示、`threadLoaded`/`clearChat` 时隐藏。
- 该端点**不回滚文件**：分叉出的会话与原会话共用一个工作区，回滚会连带改掉被留下的那一支。文件回滚只属于 `/undo` 与 `/patch-undo`。
- 分叉**可以在有轮次运行时进行**（用户明确要求）：运行时拥有在跑的轮次，切视图只是把它 parked，**不中断**——所以 `adoptForkedThread` 和 retry 都在改 `currentThread` **之前**调 `parkCurrentThread()`（否则 park 读到的是刚赋上的新线程，源会话就丢了后台订阅；该信号就是 `backgroundThreads`/`streamEvents`）。**尚未跑完的轮次不作为分叉点**（`loadHistory` 的 `turnIsRunning` 判定）：否则会把一个半成品回答复制进新会话。
- 分叉 / 撤销 / 重试共用 `hostOperationInFlight`：同一时刻只允许一个「换掉当前对话」的操作，后来者得到 `operationBusy` 提示而不是真的开始。
- 点击到落地之间有几秒：`chat-provider.ts` 先发 `status` + `hostOperation(active:true)`，webview 用它点亮状态栏活动点、把被点的那行标成 `is-pending`、并**暂缓**这一组控件：输入区的发送（`webview-js-input.ts` 的 `setHostOperation`，只拦发送不锁输入；`keydown`/按钮都走 `sendMessage()` 这一个漏斗）+ 工具栏的 Undo / Retry / New Thread / Compact（它们作用在同一段对话上，跟发送一样会和在飞的切换抢）。理由：分叉会**换掉输入区所属的那段对话**，这几秒里发出的消息或触发的动作没有确定的落点（很可能落在原会话、然后从视野里消失），而输入框里的字是用户自己的，锁住它更糟。释放时统一把能力状态交还给 `applyApiCapabilities()`，不要手写回滚（否则 Old engine 上 Undo 会被永久置灰）。对比：压缩（compact）只发 `busy` 而不拦发送，因为它**不换对话**——`busy` 只画活动点，`hostOperation` 才是「这段对话暂时归宿主所有」。
- 同一个分叉在飞行中时第二次点击会被 `forkInFlight` 丢掉：否则会分叉出两个新线程、两份 session 文档，而第二次是从用户已经离开的源上切的。这个守卫在后端，因为那一行在整个等待期间都留在屏幕上。
- 能力检测用**路由探测**（`api-client.ts` 的 `probeRuntimeCapabilities()`：用 GET 探这条 POST-only 路由得到 405 → true，旧引擎 404 → false）。旧引擎上整行都不渲染，而不是退化成“分叉最后一轮”那件事——那样会在别的轮次上下刀还报告成功。

### TUI 关键源码位置

| 功能 | 文件 | 函数/结构 |
|------|------|-----------|
| undo 对话 | `crates/tui/src/commands/groups/debug/undo.rs` | `undo_conversation()` |
| retry 重试 | `crates/tui/src/commands/groups/debug/undo.rs` | `retry()` |
| patch_undo 文件回滚 | `crates/tui/src/commands/groups/debug/undo.rs` | `patch_undo()` |
| 快照仓库 | `crates/tui/src/snapshot/repo.rs` | `SnapshotRepo` |
| pre-turn 快照 | `crates/tui/src/core/turn.rs` | `pre_turn_snapshot()` |
| 唯一 turn loop | `crates/tui/src/core/engine/turn_loop.rs` | `Engine::run_turn` |
| revert_turn 工具 | `crates/tui/src/tools/revert_turn.rs` | `RevertTurnTool` |
| 工具注册 builder 链 | `crates/tui/src/tools/registry.rs` + `crates/tui/src/core/engine/tool_setup.rs` | `with_agent_runtime_surface()` 等 `with_*_tool()` |
| Runtime API 路由 | `crates/tui/src/runtime_api.rs` | `build_router()`（新增端点的唯一落点） |
| /restore 命令 | `crates/tui/src/commands/groups/skills/restore.rs` | `restore()` |
| 内置命令分发 | `crates/tui/src/commands/mod.rs` | `execute()` |

> TUI 的 `commands/` 已按组重组（`groups/core|config|session|debug|skills|plugins|utility|project|memory/`），旧的单文件路径（如 `commands/debug.rs`）不再存在。

### 实现新功能的检查流程

1. 在 TUI 源码中找到对应功能的实现
2. 确认 TUI Runtime API 是否已暴露该功能（查 `runtime_api.rs` 的 `build_router()`）
3. 如果没有 API → 先在 `runtime_api.rs` 添加端点（薄适配层，复用 Engine 已有能力）
4. 在 GUI 的 `src/api/api-client.ts` 中添加调用方法
5. 在 `chat-provider.ts` 中实现业务逻辑
6. 在 `src/webview/` 中添加 UI（新脚本放对应的 `webview-js-*.ts` 模块，遵循 WebView 编码原则）
7. 对比 TUI 和 GUI 的行为是否一致

---

## GUI 后端开发原则：复用 TUI 能力，不重复造轮子

### 核心原则

GUI 的 runtime API 端点（`runtime_api.rs`）**必须复用 TUI 已有的核心能力**，而不是自己重新实现一遍。TUI 已经有了完整的业务逻辑，API 端点只是把这些能力暴露给 GUI 调用。

### 正确做法 vs 错误做法

**错误**：在 API 端点中自己重建数据
```rust
// ❌ 自己从 turns 重建消息、估算 token
let turns = runtime_threads.list_turns_for_thread_pub(&thread_id)?;
let messages = runtime_threads.reconstruct_messages_from_turns(&turns)?;
let total_tokens = messages.iter().map(|m| text.len() as u64 / 4).sum();
```

**正确**：通过 Engine 获取 TUI 已有的真实数据
```rust
// ✅ 复用 Engine 的 get_session_snapshot()，和 TUI 的 build_session_snapshot 走同一路径
let engine = runtime_threads.get_engine(&thread_id).await?;
let snapshot = engine.get_session_snapshot().await?;
// snapshot.messages / snapshot.total_tokens / snapshot.model 都是 Engine 的真实状态
```

### 判断标准

写 API 端点时问自己：
1. **TUI 内部做这件事用的是什么？** → API 端点应该调用同一个东西
2. **我是在"暴露 TUI 的能力"还是"重新实现 TUI 的逻辑"？** → 应该是前者
3. **如果 TUI 的逻辑改了，我的 API 端点会不会不同步？** → 如果会，说明没有复用

### 具体规则

1. **数据来源：用 Engine 的真实状态，不要自己重建**
   - Engine 的 `session.messages` 是权威消息列表，不要从 turns/items 重建
   - Engine 的 `session.total_usage` 是权威 token 统计，不要从文本长度估算
   - 通过 `get_session_snapshot()` 获取完整快照

2. **业务逻辑：用 TUI 已有的函数，不要重写**
   - 保存 session：用 `create_saved_session_with_id_and_mode()` / `update_session()`，和 TUI 的 `build_session_snapshot` 一致
   - 文件操作：用 Engine 的 Op 通道，不要绕过 Engine 直接操作文件
   - 对话操作（undo/retry）：用 Engine 的 Op 通道，确保状态一致

3. **API 端点的角色是"薄适配层"**
   - 接收 HTTP 请求 → 转换参数 → 调用 TUI 已有能力 → 返回结果
   - 不应该在 API 层做数据转换、计算、重建等重逻辑
   - 如果发现 API 端点里有超过 20 行的业务逻辑，大概率是在重复造轮子

4. **Engine 是唯一的状态权威**
   - Engine 持有当前 session 的完整状态（messages、tokens、model 等）
   - Thread store 只持久化 turn items，不是消息的权威来源
   - 从 turns 重建消息是 `ensure_engine_loaded` 的内部实现细节，API 不应该依赖它

### 典型案例：session 保存

| 方面 | 错误方式 | 正确方式 |
|------|---------|---------|
| 消息来源 | 从 turns 重建 | Engine `get_session_snapshot()` |
| token 计算 | `text.len() / 4` 估算 | Engine 的 `total_usage` |
| model/workspace | 从 thread 记录读取 | Engine 快照自带 |
| session 构建 | 自己拼 `SavedSession` | 用 `create_saved_session_with_id_and_mode()` |
| 保存方式 | 自己写文件 | 用 `SessionManager::save_session()` |
