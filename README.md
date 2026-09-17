# CodeWhale for VS Code — a lightweight GUI frontend for the CodeWhale agent

[![Version](https://img.shields.io/badge/version-0.6.2-blue)](https://github.com/HengQuWorld/CodeWhale-VSCode)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85+-informational)](https://code.visualstudio.com/)
[![VSIX](https://img.shields.io/badge/VSIX-~200%20KB-brightgreen)](https://github.com/HengQuWorld/CodeWhale-VSCode)

CodeWhale for VS Code is the **graphical frontend** for [CodeWhale](https://github.com/Hmbown/CodeWhale) — an open-source, actively developed coding agent. It brings the agent into a native VS Code sidebar, so you get the full engine (reading your workspace, editing files, running commands, searching the web, delegating to sub-agents) without leaving the editor.

Based on CodeWhale, community effort offers two surfaces over one engine: a **TUI** for people who live in the terminal, and this **GUI** for people who live in the editor. They share the same engine and core runtime concepts, but the GUI is intentionally optimized for the editor workflow and still leaves some advanced surfaces TUI-only.

The split is deliberate: **the agent stays in the engine, the ergonomics stay in the editor.** This extension never bundles, forks, or reimplements the agent — it is a thin, local GUI over a runtime you install and upgrade on your own schedule.

## Why it stays lightweight

| | |
|---|---|
| VSIX size (0.6.2) | ~200 KB |
| Runtime npm dependencies | **none** — webpack inlines the extension's own TypeScript (and `marked` for rendering) |
| Bundled engine or model | **none** — `codewhale` is a separate native binary |
| Duplicated agent logic | **none** — the GUI is an adapter over the engine's local runtime API |
| Authoritative conversation state store | **none in the extension** — the engine is the single source of truth for threads, turns, tools and file changes |

The frontend is a webview. `ChatProvider` runs in the extension host, speaks HTTP to `127.0.0.1`, and renders what the engine reports. When the installed engine exposes a newer runtime endpoint the UI uses it; when it does not, the feature is disabled with an explanation instead of failing at runtime — that is why Undo, Retry and snapshot Restore can show a muted "unavailable" state rather than a broken button.

Because nothing about the agent is copied into the extension, the engine can ship new capabilities and fixes without a frontend release.

## Preview

**Message navigation rail** — the dots along the right edge jump to any user message; `Ctrl/Cmd+Up` / `Ctrl/Cmd+Down` step between them.

![Message navigation rail](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/01-message-nav.gif)

**Inline diff for file changes** — a change card opens the diff with correct line numbers, reconstructing the file the model actually saw.

![File change diff](https://raw.githubusercontent.com/HengQuWorld/CodeWhale-VSCode/main/docs/media/02-diff.gif)


## Requirements

| Requirement | Notes |
|---|---|
| **VS Code 1.85+** | Or a compatible IDE — Trae CN is supported |
| **CodeWhale engine** | The `codewhale` CLI. **Not bundled** — install it separately (below) |
| **Node.js** | Only for building the extension from source, or installing the engine via npm |

### 1. Install the engine

The engine is a native binary published by the upstream project. macOS / Linux:

```bash
curl -fsSL https://codewhale.net/install.sh | sh
"$HOME/.local/bin/codewhale"
```

Windows: download the matching installer from [GitHub Releases](https://github.com/Hmbown/CodeWhale/releases/latest).

Verify it is on your `PATH`:

```bash
codewhale --version
codewhale update          # keep the engine current
```

npm and Cargo are supported as secondary packaging routes (`npm install -g codewhale`). The engine is also where you connect your model provider — configure it on first run with `/provider` and `/model`.

> **Engine not found?** The extension searches the usual locations (`~/.cargo/bin`, Homebrew and npm global `node_modules`, `~/.local/share/codewhale`). If you installed via `install.sh` to `~/.local/bin` and VS Code does not inherit that `PATH`, set `brotherwhale.enginePath` explicitly.

### 2. Install the extension

**Option A — VS Code Marketplace:** search for "CodeWhale" in the Extensions panel (`Cmd/Ctrl+Shift+X`) and click Install.

**Option B — build from source:**

```bash
git clone https://github.com/HengQuWorld/CodeWhale-VSCode.git
cd CodeWhale-VSCode
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

Then install the generated `.vsix` (`Extensions: Install from VSIX...`), or from a terminal:

```bash
code --install-extension ./brotherwhale-vscode-0.6.2.vsix --force
```

> **Trae CN users:** if `code` is not on your `PATH`, use the bundled CLI:
> ```bash
> "/Applications/Trae CN.app/Contents/Resources/app/bin/code" --install-extension ./brotherwhale-vscode-0.6.2.vsix --force
> ```

### 3. Open it

Click the **CodeWhale icon** in the activity bar. The extension starts the engine on demand for your workspace, health-checks it, and reports **Ready** in the status bar. The first message is the slowest — after that the engine is reused.

## Features

### Chat that behaves like an agent, not a text box
- **Streaming turns** with a collapsible thinking panel, tool-call cards that show the actual arguments (e.g. the shell command as a `$ ...` block), and per-turn `↑/↓` token chips.
- **Mid-turn steering** — while a turn is running, pressing Enter sends guidance into that turn instead of starting a new one (mirrors the engine's steering input); the steered message is marked with a steer badge.
- **One send/stop button** that reflects the real turn state, plus **Undo** and **Retry** for the last turn.
- **Attachments** — `/attach` opens a native file picker for images, PDFs, and other files.
- **Message navigation rail** — dots along the right edge jump to each user message; `Ctrl/Cmd+Up` / `Ctrl/Cmd+Down` step between them.

### Modes and permission posture
Two independent controls, aligned with the engine's own vocabulary:

| Mode | Behavior |
|---|---|
| **Act** (`agent`) | Works autonomously, asking for approval according to the posture |
| **Plan** | Proposes a plan before touching anything |
| **Operate** | Long-running, orchestration-oriented work |

| Posture | Behavior |
|---|---|
| **Ask** | Every gated action needs approval |
| **Auto-Review** | The agent proceeds; the runtime reviews risky steps |
| **Full Access** | No approval prompts — implies auto-approval |

Switch from the status bar or with `/mode` (shortcuts `1`/`2`/`3`) and `/auto`. The legacy `/mode yolo` is kept as a one-way alias that means **Act + Full Access**; it is never shown as a mode of its own.

### Sessions, not just threads
- **Save and resume** conversations as sessions, with search and delete.
- **Per-turn auto-save**, so a reload or restart does not lose the thread.
- **Cross-workspace resumption** — loading a session from another project rebinds it to the workspace you are in.
- **Workspace filter** — show sessions from all workspaces or only the current one.
- **Attention surfacing** — threads waiting on an approval or your input get a pulsing dot, polled while a turn runs.
- The legacy **Threads** tab still exists but is hidden by default (`brotherwhale.showThreadList`).

### Changes and diffs in the editor
- A **Changes** section per conversation, with one card per recorded change, built from the engine's authoritative mutation metadata.
- **Diff view** with correct line numbers, reconstructing the file the model actually saw.
- **Open** a changed file directly in the editor, or **Diff** it inline.
- **Revert** restores one recorded change through the engine's file-scoped endpoint, naming the restore point taken before that change; the rest of the file's changes — and every other file — are left alone.
- Replayed sessions rebuild diffs from the recorded replacements — and deliberately show *no* diff rather than a fabricated one when the chain no longer lines up.

### Tasks, agents, and Fleet
- **Tasks** — create from a modal, track progress, open a detail overlay, filter by workspace; background threads raise attention when they need you.
- **Agent runs** — delegated work with inline detail views.
- **Fleet** — managed multi-agent runs: workers, tasks, receipts, start/stop and per-worker interrupt/stop/restart, plus a live SSE event timeline filtered by issues / progress / all.

### Goal, memory, and skills
- **Thread Goal** — status, token budget (red when over), elapsed time and continuation count, with set / edit / complete / block / delete.
- **Memory** — `/memory` reads and writes the engine's native memory store through the runtime API.
- **Notes** — `/note` for quick per-workspace notes.
- **Skills** — `/skills` and `/skill` to list and toggle them.
- **MCP** — `/mcp` opens MCP-related settings in VS Code.
- **Snapshots** — `/restore` lists snapshots and can revert workspace files to one.

### Models, cost, and diagnostics
- **Provider and model switching** from the status bar, with a live model preview per provider.
- **Reasoning effort** from `off` to `max`.
- **Runtime-sourced cost** — usage and pricing come from the engine, so provider rate changes do not need a frontend release. `costCurrency` follows your UI language (`auto`), and unrecorded cost shows an em dash rather than an estimate.
- **Diagnostics** — `/context`, `/tokens`, `/cost`, `/status`, `/cache` (per-turn prefix-cache telemetry), `/system`, `/diff`, `/translate`.
- **Config panel** — the gear in the settings bar (or `/config`) reads and writes engine runtime config, including sandbox mode, strict tool mode, memory, search provider and prompt suggestion.

### Built for the editor
- Activity-bar container with Chat, Sessions, Goal, Work, Fleet, Tasks, Agents and Changes panels.
- Status bar for engine state, mode, posture, provider, model and reasoning effort.
- Resizable sidebar and input area; follows your VS Code theme.
- **English and Simplified Chinese** UI, following VS Code's display language.

## Commands

### VS Code commands (Command Palette)

| Command | Description |
|---|---|
| `CodeWhale: Open Chat` | Reveal the CodeWhale sidebar |
| `CodeWhale: New Thread` | Start a fresh conversation |
| `CodeWhale: Compact Context` | Compact the current conversation |
| `CodeWhale: Restart Engine` | Restart the local engine process |

### Slash commands (in chat)

**Core** — `/help`, `/clear`, `/home`, `/exit`, `/links`, `/feedback`, `/attach`, `/anchor`, `/jobs`, `/trust`, `/verbose`

**Config & models** — `/mode`, `/auto`, `/model`, `/models`, `/provider`, `/reasoning`, `/config`, `/settings`, `/workspace`, `/profile`, `/mcp`, `/init`

**Sessions & files** — `/sessions`, `/load`, `/save`, `/export`, `/rename`, `/compact`, `/edit`, `/undo`, `/retry`, `/restore`, `/diff`

**Tasks, agents & goals** — `/task`, `/goal`, `/skills`, `/skill`, `/note`, `/memory`

**Diagnostics** — `/status`, `/context`, `/tokens`, `/cost`, `/cache`, `/system`, `/translate`

> Some TUI-only commands are recognised but reported as unavailable in the GUI — for example `/agent`, `/subagents`, `/hooks`, `/queue`, `/stash`, `/review`, `/lsp`, `/theme`, `/statusline`. They answer with a reason instead of "unknown command", so the surface stays predictable.

## Settings

Search for `brotherwhale` in VS Code settings (`Cmd/Ctrl+,`).

| Setting | Default | Description |
|---|---|---|
| `brotherwhale.enginePath` | `"codewhale"` | Path to the engine binary. Leave at the default to use built-in discovery |
| `brotherwhale.defaultModel` | `"deepseek-v4-pro"` | Model for new threads |
| `brotherwhale.defaultMode` | `"agent"` | `agent` (Act), `plan`, or `operate`. A legacy `yolo` value resolves to Act + Full Access |
| `brotherwhale.defaultPermissionPosture` | `"ask"` | `ask`, `auto_review`, or `full_access` |
| `brotherwhale.reasoningEffort` | `"auto"` | `auto`, `off`, `low`, `medium`, `high`, `max` |
| `brotherwhale.autoApprove` | `false` | Legacy fallback for auto-approval. Prefer the **Full Access** posture, which already implies it |
| `brotherwhale.showThreadList` | `false` | Show the legacy **Threads** tab alongside **Sessions** |
| `brotherwhale.costCurrency` | `"auto"` | `auto` follows the UI language (Chinese → CNY, otherwise USD), or force `usd` / `cny`. Falls back to USD when no native CNY price exists |

## How it works

```
CodeWhale sidebar (webview: HTML/CSS/JS rendered by the extension)
        │  postMessage
ChatProvider  (extension host: chat-provider.ts, i18n, session state)
        │  HTTP on 127.0.0.1:<ephemeral port>
codewhale serve  (the engine — installed and upgraded separately)
        │
your workspace + the model provider you configured in the engine
```

1. On activation the extension resolves the `codewhale` binary, allocates a free loopback port, and spawns `codewhale --workspace <folder> serve --http --host 127.0.0.1 --port <port>`.
2. Each trusted window owns the Runtime process it spawns: a fresh bearer token is generated per start and handed to the child through its environment (never on the command line), the extension waits for the child's own bind receipt before sending any request, and the local API rejects anonymous callers. No port state is persisted between sessions; only the child a window started is stopped on restart or shutdown.
3. The webview talks only to `ChatProvider`; `ChatProvider` talks only to the engine's runtime API. There is no second source of truth, and no agent logic in the extension.
4. At startup the extension probes which runtime endpoints exist, so features backed by newer API surfaces degrade gracefully on older engines.
5. Because everything is local, the engine owns model access, tools, and file mutations — the GUI only renders and steers them.

### Runtime ownership and recovery

Each trusted VS Code window starts its own authenticated local Runtime. Old port files are ignored; restarting never kills an unrelated service. The Runtime token is generated for that process and kept out of command arguments, settings, and logs.

Reloading or closing the extension stops that window's Runtime and interrupts active work. Completed, saved sessions remain available through Sessions. Save or finish active work before reloading; active-turn continuity across reload is not supported. Per-file Revert works against the engine's file-scoped restore endpoint; on an engine that predates it the control stays disabled with an explanation, and Undo last turn remains available through the existing thread API.

## Troubleshooting

**Engine fails to start**
- Check the install: `codewhale --version`.
- Run `CodeWhale: Restart Engine` from the Command Palette.
- Read the **CodeWhale** output channel (View → Output → CodeWhale); the engine log is also appended in the extension's global storage as `engine.log`.

**"Engine not found"**
- Set the full path in `brotherwhale.enginePath`, e.g. `/opt/homebrew/bin/codewhale` or `~/.local/bin/codewhale`.
- Confirm the binary works in a terminal outside VS Code first.

**The extension does not activate**
- Reload the window (`Developer: Reload Window`) and confirm VS Code 1.85+.

**A button is greyed out / "unavailable"**
- That feature needs a runtime endpoint your installed engine does not expose. Update the engine (`codewhale update`) — the UI enables the feature automatically once the endpoint appears.

**Installing a VSIX**
```bash
code --install-extension /path/to/brotherwhale-vscode-0.6.2.vsix --force
```

## Privacy & data

The extension talks to a **locally running** engine on `127.0.0.1` and contains no telemetry and no analytics. Conversation data reaches your model provider only through the engine, using the provider, model and credentials you configured there. You control the provider, the model, and the data flow.

## Development

```bash
npm install
npm run compile   # development build with source maps
npm run watch     # rebuild on change
npm test          # vitest unit tests
npm run lint      # eslint
npm run package   # production build
npx @vscode/vsce package --no-dependencies   # build the VSIX
```

Project layout: `src/extension.ts` (entry) → `src/chat-provider.ts` (orchestration) → `src/api/` (engine process + runtime API client) → `src/commands/` (slash commands) → `src/webview/` (HTML/CSS/JS split by domain) → `src/utils/` (diff, cost, session state). See `AGENTS.md` for the deeper architecture and the "reuse the engine, never reimplement it" rule that keeps this frontend thin.

## Related projects

- **[CodeWhale](https://github.com/Hmbown/CodeWhale)** — the open-source coding agent this extension fronts. Engine docs, releases, and provider setup live there.

## License

[MIT](LICENSE)
