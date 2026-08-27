# Change Log

## 0.4.4

### New Features

- **Runtime-Sourced Session Cost** — Replace the hardcoded client-side pricing table with thread-scoped usage totals fetched from the TUI runtime, so provider rate changes are picked up by updating the TUI rather than this extension. Adds a `costCurrency` setting (`auto` | `usd` | `cny`, default `auto`) that follows the interface language, and mirrors the TUI's `cost_display_currency` behavior: a CNY preference with no native-CNY spend falls back to USD, and unrecorded cost shows an honest em dash instead of a fabricated estimate.

### Bug Fixes

- **Per-Turn Usage Chips Persistence** — Turn usage is now stamped onto the final assistant message during history reload, so the reloaded transcript shows the same ↑/↓ token chip as the live view. Cache-write tokens are included in the full prompt-input total so the status bar matches the transcript.

## 0.4.3

### New Features

- **Mid-Turn Steering** — While a turn is streaming, plain text sent via Enter now guides the active turn instead of starting a new one (mirrors TUI's steering input `POST /v1/threads/{id}/turns/{turn_id}/steer`). The composer shows a "steer the running turn..." hint and keeps the send button as Stop; slash commands still block except `/interrupt` and `/clear`. Steered prompts render as interrupt bubbles with a steer pill badge, and subsequent output flows into a fresh streaming segment — in-flight tool updates keep landing on the segment they started on, and history reloads interleave steered messages as separate bubbles. Capability-gated with graceful fallback to the previous blocking behavior on older engines.

### Bug Fixes

- **Steer Badge Tooltip** — The steer badge now shows a dedicated "Sent as mid-turn steering" tooltip instead of reusing the composer's placeholder hint text.

## 0.4.2

### New Features

- **Message Navigation Rail** — Add a vertical navigation rail along the right edge of the chat messages panel. Each user message gets a clickable dot positioned proportionally to its location in the scrollable content; hovering shows a text preview and clicking smooth-scrolls to that message with a brief flash highlight. The dot nearest the viewport center is highlighted as active. Includes keyboard shortcuts: `Ctrl/Cmd+Up` jumps to the previous user message and `Ctrl/Cmd+Down` jumps to the next, both wrapping around at the ends of the conversation.

## 0.4.1

### New Features

- **Dynamic Provider Switching** — Provider dropdown with live model preview, switching providers without losing model preferences, and integrated provider/model catalog APIs for real-time backend registry updates.

- **Enhanced Task Workflow** — Modal-based task creation, compact task actions, attention indicators, and stable task detail handling with improved CSP compliance and thread-switch timing.

- **Workspace-Scoped Task List** — Filter tasks by workspace with async enrichment; task list shows tasks from all workspaces or just the current one.

## 0.4.0

### New Features

- **Inline Task & Agent Detail Views** — Route task and agent sidebar interactions to inline detail overlays in the main chat webview, including richer task process/result rendering and agent run detail views. Resolve task result artifacts using the TUI task path semantics, add result preview fallback support, and remove the deprecated standalone Agent Sessions panel command and implementation.

- **Config Panel** — Add a full-featured config panel UI that reads/writes TUI runtime config via `/v1/config` and `/v1/config/reload` APIs, supporting all GUI-relevant config keys including nested-table entries (sandbox_mode, strict_tool_mode, memory_enabled, search_provider, prompt_suggestion). Accessible via the `/config` slash command or the settings bar gear icon.

### Improvements

- **Workspace-Scoped Task List** — Remove thread-level filter from refreshTaskList() so the sidebar shows all tasks across the entire workspace instead of just the active thread.

### Bug Fixes

- **Sidebar Clear on Thread Switch** — Clear sidebar tasks, agents, work, and changes panels when switching threads, preventing stale data from the previous thread from persisting into the new thread context.

## 0.3.3

### Bug Fixes

- **Textarea Height on Resize** — Reset textarea inline height when the input area is manually resized via drag handle, so the textarea fills the new container height instead of staying at its auto-grown height

- **Workspace Thread Filtering** — Filter threads by current workspace on initialization, preventing the GUI from loading the most recent thread from a different project when creating a new session

- **Thread Update Field Preservation** — Merge partial API responses with existing thread data instead of overwriting, fixing a bug where `/mode agent` would silently revert to the config default after sending a message

### Improvements

- **Work Panel Animation Simplification** — Remove interactive-style animations (shimmer, pulse, hover translate) from read-only checklist and strategy items to match the static display style of session/thread lists

## 0.3.2

### Bug Fixes

- **Apply Patch Diff Preview** — Support diff preview for apply_patch tool outputs from input patch/changes

- **Session Reset State Cleanup** — Clear stale sidebar work and changes state when resetting the webview session, so old session data does not persist into new sessions

- **Accurate Diff Line Numbers** — Separate single-diff and cumulative-diff modes: per-card diffs in reasoning sessions now show full files with correct line numbers instead of only hunk fragments

- **Diff View Line Alignment** — Align diff view line numbers with actual file positions by reverse-applying diff hunks to current file content, making it easier to correlate hunks with their real positions

## 0.3.1

### New Features

- **Thread List Visibility Setting** — Add a config option to control whether the Threads tab is shown in the sidebar (hidden by default since Sessions are the user-facing conversation list)

- **Settings Dropdowns and Panel Polish** — Clickable dropdown menus for mode, model, and reasoning effort in the settings bar; refactored work and changes panels with CSS classes; added icons to empty-state messages; improved task card styling

- **Resizable Panels and Unified Send/Stop Button** — Drag handles for sidebar width and input area height resizing; unified send/stop button that toggles based on streaming state; improved input area layout

## 0.3.0

### New Features

- **Agent Runs Sidebar** — Added an Agent Runs panel with delegate cards so background agent activity and delegated work are easier to inspect from the GUI.

- **Session Search And Delete** — The sidebar now supports searching saved sessions and removing sessions you no longer need.

### Improvements

- **Streaming Status Animation** — Replaced the old blinking cursor with pulse and bounce dot animations for a clearer streaming-state indicator.

### Bug Fixes

- **Tool Call Terminal Events** — Fixed tool call terminal event handling to prevent GUI freezes while TUI commands are running.

- **Approval Freeze And Session Duplication** — Resolved approval-flow freezes and stopped concurrent turns from creating duplicate sessions.

- **Multi-Turn Event Isolation** — Prevented stale turn events from corrupting later multi-turn conversations.

- **Changes Panel Consistency** — Fixed repeated edits to the same file so every modification appears in the Changes panel instead of only the first one.

## 0.2.0

### New Features

- **Independent Changes Panel** — Added a dedicated Changes sidebar panel so file modifications are easier to inspect during a conversation, while also reducing duplicate change entries.

- **Per-Turn Session Auto-Save** — The GUI now saves the current session after each completed turn, improving recovery and continuation across restarts.

### Improvements

- **Session Recovery Performance** — Optimized session recovery to make better use of cached state and reduce unnecessary reload work.

- **Frontend Architecture Cleanup** — Reorganized the source tree into feature-focused modules, split the webview HTML/CSS/JS into smaller units, and centralized session state and engine/API synchronization for easier maintenance.

- **History Rendering And Test Coverage** — Improved chat history rendering and expanded the automated test suite around the refactored GUI flows.

### Bug Fixes

- **Changes Panel Sync** — File changes produced by tool calls now stay in sync with the Changes panel instead of being missed or shown inconsistently.

## 0.1.2

### New Features

- **Sessions Sidebar** — Browse and resume saved sessions from the sidebar. A new "Sessions" tab sits alongside the legacy "Threads" tab, with a workspace filter toggle to show sessions from all workspaces or just the current one.

- **File Attachments** — The `/attach` command now opens a native file picker. Attach images, videos, PDFs, or any file to your message. Attachments are embedded directly into the conversation text.

- **Cross-Workspace Thread Resumption** — Loading a thread from a different workspace now automatically updates its workspace to the current one, preventing stalled conversations and misdirected output.

- **Auto-Save Threads as Sessions** — Completed conversations are automatically saved as sessions, making them available for cross-workspace resumption. Deduplication ensures each thread is saved only once.

- **Session Loading Error Handling** — Friendly error messages when a session is not found (404) or the server encounters an error, with automatic session list refresh on failure.

- **Skills Slash Command** — Added `/skills` command to list and manage available skills.

- **Runtime API Capability Detection** — GUI now probes the running TUI backend at startup to discover available API endpoints (undo, retry, snapshot restore). Features depending on unmerged upstream PRs are automatically disabled rather than failing at runtime.

- **TUI Version Display** — The status bar now shows the connected TUI backend version, helping users and maintainers understand the runtime environment at a glance.

- **Improved Unavailable-Feature UX** — Undo, Retry, and Revert buttons now show a distinct "unavailable" visual style (dashed border, muted colors) with a reliable custom tooltip explaining why the feature is not available, replacing unreliable native `title` behavior.

### Improvements

- **Trust Mode Consistency** — Yolo mode now correctly sets both `trust_mode` and `auto_approve` flags. `/trust off` preserves these flags only when in yolo mode.

- **Session Save Compatibility** — `saveThreadAsSession()` now falls back to the mainline `POST /v1/sessions` endpoint when the `/v1/sessions/save-current` route is unavailable, preventing save failures on stock TUI builds.

- **i18n** — Added Chinese and English translations for sessions, workspace filter, file attachment labels, and unavailable-feature tooltips.

## 0.1.1

- Cross-platform support for Windows and Linux
- Updated documentation to reflect config namespace and vsix filename changes

## 0.1.0

- Renamed all references from codewhale to brotherwhale
- Initial release with CodeWhale branding
