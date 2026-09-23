# Contributing to CodeWhale for VS Code

[English](#english) · [中文](#中文)

## English

Issues, discussions and pull requests are all welcome — in English or Chinese.
Several of the extension's best features started as community pull requests, and
there is plenty left to build.

### Where does your report belong?

- **The GUI** (webview, sidebar, diffs, sessions, engine process management in
  VS Code) — this repository.
- **The agent engine** (`codewhale` CLI: prompts, models, providers, tools,
  sandboxing) — [Hmbown/CodeWhale](https://github.com/Hmbown/CodeWhale/issues).
  The extension is a thin frontend and cannot fix engine behavior.
- **Questions and ideas** — [Discussions](https://github.com/HengQuWorld/CodeWhale-VSCode/discussions).

### Getting started

```bash
git clone https://github.com/HengQuWorld/CodeWhale-VSCode.git
cd CodeWhale-VSCode
npm install
npm run watch     # development build, rebuild on change
npm test          # vitest unit tests
npm run lint      # eslint
npm run package   # production build
npx @vscode/vsce package --no-dependencies   # build the VSIX
```

Install the VSIX with `code --install-extension ./brotherwhale-vscode-<version>.vsix --force`,
then open the Run and Debug view and launch the **Extension Development Host**.

`AGENTS.md` documents the architecture in depth: `src/extension.ts` (entry) →
`src/chat-provider.ts` (orchestration) → `src/api/` (engine process + runtime
API client) → `src/commands/` → `src/webview/` → `src/utils/`.

### Ground rules

1. **The engine owns agent behavior.** This extension is a thin GUI over the
   engine's local runtime API — it never bundles, forks or reimplements the
   agent. If a fix means copying agent logic into the extension, it belongs
   upstream instead.
2. **No runtime npm dependencies.** The extension's own TypeScript (and
   `marked`) is inlined by webpack; the VSIX stays small and dependency-free.
3. **Degrade gracefully across engine versions.** When a runtime endpoint is
   missing, the UI disables the feature with an explanation instead of failing
   at runtime.
4. **Bilingual UI.** Every user-facing string lives in both
   `package.nls.json` and `package.nls.zh-cn.json`.
5. **Tests and changelog.** Behavior changes come with vitest tests; user-visible
   changes get a `CHANGELOG.md` entry written from the user's perspective —
   what they experienced before, and what they get now.

### Pull requests

Keep PRs focused — one concern each. The PR template carries the checklist:
lint, tests, changelog, localization, and the thin-adapter rule. If you want a
starting point, comment on an issue and a maintainer will help scope it; the
["good first issue" label](https://github.com/HengQuWorld/CodeWhale-VSCode/labels)
marks candidates when present.

### Releases (maintainers)

1. Bump `version` in `package.json` and add the `CHANGELOG.md` section.
2. Commit, then tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI builds the VSIX, attaches it with SHA-256 checksums to a GitHub Release
   using the changelog section as notes, and publishes to the Marketplace when
   the `VSCE_PAT` secret is configured.

## 中文

欢迎通过 issue、discussion 和 pull request 参与贡献，中英文均可。这个扩展最好用的几个功能最初都来自社区
PR，还有很多值得做的事。

### 反馈应该发到哪里？

- **GUI 本身**（webview、侧边栏、diff、会话、引擎进程管理）→ 本仓库。
- **代理引擎**（`codewhale` CLI：提示词、模型、供应商、工具、沙箱）→
  [Hmbown/CodeWhale](https://github.com/Hmbown/CodeWhale/issues)。扩展只是前端，修不了引擎行为。
- **提问与想法** → [Discussions](https://github.com/HengQuWorld/CodeWhale-VSCode/discussions)。

### 本地开发

```bash
npm install
npm run watch     # 开发构建，改动自动重编译
npm test          # vitest 单元测试
npm run lint      # eslint
npm run package   # 生产构建
npx @vscode/vsce package --no-dependencies   # 打 VSIX
```

用 `code --install-extension ./brotherwhale-vscode-<版本>.vsix --force` 安装后，
在「运行和调试」里启动 **Extension Development Host** 调试。架构细节见 `AGENTS.md`。

### 基本约定

1. **代理行为归引擎。** 扩展只是引擎本地运行时 API 的轻量前端，不打包、不分叉、不重实现代理。
   如果一个修复需要把代理逻辑复制进扩展，它应该去上游做。
2. **零运行时 npm 依赖。** webpack 内联扩展自身代码，VSIX 保持小体积、无依赖。
3. **跨引擎版本优雅降级。** 运行时端点缺失时，UI 禁用该功能并说明原因，而不是运行时报错。
4. **界面双语。** 每条用户可见字符串同时写入 `package.nls.json` 和 `package.nls.zh-cn.json`。
5. **测试与变更日志。** 行为变更配 vitest 测试；用户可见变更在 `CHANGELOG.md` 用用户视角记录——
   之前遇到什么问题，现在得到什么。

### Pull request

每个 PR 聚焦一件事。PR 模板带有检查清单：lint、测试、变更日志、本地化、薄适配层原则。
想要切入点，可以在 issue 下留言，维护者会帮忙圈定范围。

### 发布（维护者）

1. 更新 `package.json` 的 `version`，在 `CHANGELOG.md` 加对应小节。
2. 提交后打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`。
3. CI 自动构建 VSIX，附 SHA-256 校验和，以变更日志为说明发布 GitHub Release；
   配置了 `VSCE_PAT` secret 时同步发布到插件市场。
