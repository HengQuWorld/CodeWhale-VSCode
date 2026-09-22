# Change Log

## Unreleased

### New Features

- **The Changes panel says how many files, and every row can jump back to the card it came from** — The header named only how many change records the panel held, which is not the number a reader asking "what did this turn touch" is after: a file edited three times is three rows, so `(7)` could mean seven files or one. The header now gives both readings — `(7 change(s) · 3 file(s))` — counting distinct files the way the extension does, after normalising separators, so a path the runtime spelled with backslashes is not counted twice. Each row also gains a **Locate** action. The change a row summarises was made by a tool call, and that call's card in the conversation is where the context is; the button scrolls the stream to that card and flashes it. Row and card are matched on the identity the change already carries — the engine's call id when the runtime published one, otherwise the file path plus the change's position in that file's history — so one file changing several times cannot send you to the wrong change, the newest card wins when an older recording left two turns sharing a path and index, and a miss scrolls nowhere rather than somewhere wrong. The lookup is a scroll inside the webview, not a round trip through the extension.

### Bug Fixes

- **Every row of the provider list can be reached** — The provider menu holds 52 rows and had no height bound and no scroll (it was `overflow: hidden`, absolutely positioned inside the bar), so it laid out ~1300px of rows inside a panel around 600px tall: the rows at the far end could not be seen or scrolled to. That is where a user-defined `[providers.<name>]` route is listed, so a route configured in the TUI looked like it was missing from the GUI entirely. The menus are now bounded (`min(45vh, 420px)`) and scroll — measured in a browser against the real stylesheet, the last row went from `bottom: 1323px` in a 613px viewport with no scrollbar to reachable at the end of the scroll.

- **The config panel's Provider picker switches, and its Base URL then describes the route that is active** — Changing the Provider select only fetched a *preview* model list, and the panel's Base URL went on showing the previous route's endpoint: the value it offered to preview was a `default_base_url` the Runtime has never published (its catalog is a non-secret projection and deliberately carries no endpoints), so the field was never updated at all. The select now applies the switch — the same call the toolbar picker makes, named custom routes included — and the form is re-read from the engine, so the Base URL and the model belong to the route that is actually running. A user-defined `[providers.<name>]` route keeps its endpoint in the table it is named by and cannot be written through this key, so that input is disabled and names the table instead of offering an edit that cannot land.

- **A provider you configured in the TUI appears in the picker and can be selected** — A user-defined `[providers.<name>]` route is reported by the Runtime as the generic `custom` kind plus its own name in `model_provider_id`, and every surface here matched a route on the id alone: the picker could not mark which of two such routes was selected, the chip fell back to *Custom (OpenAI-compatible)*, and the model list asked for the generic kind without the exact id, so the route's own catalog never loaded. Each row now carries both ids, the switch and the model request send both, the chip and the selected mark resolve from the same pair, and an answer for a sibling route can no longer repaint the list of the one you selected. `/provider <name>` and `/models` accept the route's own name, and the config panel's **Provider** select offers that name and writes it to the `provider` key. (The Runtime must publish the route for any of this to matter; an engine that predates `model_provider_id` on the catalog keeps working as before.)

- **A threadless `/mode`, `/auto` or `/trust` re-marks the defaults it just moved** — Those commands write `brotherwhale.defaultMode` / `defaultPermissionPosture` when the view has no conversation yet, but only the toolbar chips were told: the dropdown's *New threads* group is marked against the defaults copy the webview was last sent, so it went on ticking the value that no longer held until the panel was reloaded. The three writers now push the same `scopedDefaults` message the dropdown's own group does. A thread-scoped change still pushes nothing, because nothing in the default scope moved. The group's mark now also resolves a legacy `defaultMode: "yolo"` the way the chips and thread creation do (Act + Full Access), so a stale posture setting can no longer make the mark name a posture the next session will not start under — the chips, the mark, and the thread a new session creates are one resolution (`startupPosture` in `utils/modes.ts`).

- **A `brotherwhale.*` setting changed outside the panel reaches the toolbar** — Nothing subscribed to `workspace.onDidChangeConfiguration`, so a default changed in the VS Code settings editor, in another window, or in the config panel left the chips and the *New threads* marks describing the value from before it — and the next session would start under a mode and permission the toolbar never showed. The extension now re-announces both scopes when a `brotherwhale.*` setting changes: the active thread keeps its own mode and posture, and a view with no thread shows the defaults it will start with.

- **A task runs on the same new-session defaults as a chat thread** — A task runs on a runtime thread of its own, but `POST /v1/tasks` carried `mode` and the legacy `auto_approve` bit and no permission posture, so a task created under Auto-Review or Full Access ran on whatever the runtime happens to default to. The engine's task request now carries `permission_posture` — stored on the task record, handed to the thread the task runs on, and compared on admission replay — and both task entry points send it from the startup-default scope. A legacy `defaultMode: "yolo"` is normalized to Act + Full Access on the way out instead of sending an alias the runtime rejects.

## 0.7.2

### New Features

- **A waiting thread can be answered where you already are** — The toolbar's Agent chip read "Agent · 1" and opened the thread that was waiting, which took you out of the conversation you were in and landed you on a thread showing nothing to answer: the approval had been raised before this view subscribed, so the stream never repeated it, and the rail said "needs you" while the thread it opened looked idle. The chip now says what it counts (**1 waiting** — an approval and a question are both work), names the thread a click expands, and opens it in the panel's Threads tab instead of switching away. The card is where the request is answered, it survives a rail refresh, and an answered row does not come back on the next one; going to the thread is still one click from the card itself. Opening or switching to a waiting thread shows its approval too, so the rail and the thread agree on what is pending, the 📋 button is named for what the panel holds now, and viewing a saved session no longer hides the thread waiting on you.

- **Sub-agent cards say when each run happened** — A card reported a status, a role, a step count and a token total, but never a date: "Running tool, 12 steps" looked the same whether the agent had started a minute ago or had been sitting there since the morning, and a run left going overnight looked like it had just begun. Each card now carries a run-time line under its steps line — `Started 2026-09-19 14:32:05` plus either `Elapsed 8h49m` while it runs or `Duration 3m12s` once it settles — and an agent that has not started yet (queued, or waiting on your input) shows when it was created instead. The date is the point, not decoration: the Agents panel is built from persisted run records, so a card is often read on a later day than the one it started on. A record carrying no timestamps renders no line rather than a bare label, and the elapsed reading is a snapshot taken at render, refreshed on the next agent event — not a per-second ticker.

- **Approving a plan takes whatever you typed with it, and the button says so** — The plan-approve action already took the composer's contents as the instruction for the Act turn and put it ahead of the plan, but nothing said typing first was an option. Anything in the composer is now captured, cleared and sent with the approval — and restored to the composer if the approval fails — and the button's tooltip states the behaviour in both languages, from a new `planApproveButtonHint` rather than the label repeated.

- **Background attention that nothing is watching gets found** — The watcher only covered threads a summary refresh had already reported as busy, and the events that open a watch arrive on a watch already held, so a task or a goal started elsewhere (the CLI, another window, the TUI) could sit on an approval nothing here ever saw. A quiet 30-second sweep now looks for exactly that: it discovers and watches, never repaints the rail, and waits for the previous pass to finish before starting the next. The rail card's inline approval panel gains the **Always allow this thread** box too, so every surface that can answer an approval can now answer it for good.

### Improvements

- **The discovery sweep only runs when it could find something** — The sweep's summary fetch is the expensive half (25s measured on a large store), so it now runs only when this window already tracks a thread, or when the shared task list still holds something unfinished. An idle window with neither spends one small request per tick and never touches the summary store, and a gate that cannot be read falls through to the sweep rather than skipping it. The cost of the gate is that a window knowing of no thread and no task waits for the next foreground refresh to hear about one started elsewhere.

### Bug Fixes

- **A send refused because the thread is already running a turn recovers instead of failing** — Sending while a turn was already running failed with "Failed to send message: API error 409: Thread already has an active turn" and left it there: the message was gone from the input box, the send button had turned back from Stop to Send, and Stop could not have interrupted anything because this client held no turn id for the turn that blocked it. The running turn is now read back from the thread and adopted — id, streaming message, event stream, Stop button — so the same button that refused the send can stop the turn that refused it, and the unsent message comes back to the input box, text and attachments, with a note saying to press Stop and send again. Stop reads the turn back the same way when it holds no id, so a turn this client never started can be interrupted too. Only the busy refusal takes this path: a turn that ended in between still reports the failure, with the text already restored.

- **A background task's approvals stay visible and answerable** — A task runs on a runtime thread of its own, so the Tasks panel now follows the same events the thread watcher sees: a task created from the sidebar is watched from the moment it exists, and its approvals and finished turns refresh the panel too. The badge used to go stale the moment you switched away — exactly when the task needed an answer. The task detail panel's Allow/Deny now carries the approval float's remember box, and its wording is **Always allow this thread**, which is what the flag actually does; the old "Remember for this tool" promised a per-tool memory the runtime never had.

- **A thread whose goal is still running stays watched** — A thread with an active goal now stays watched after you switch away, so the rail badge, the notification and the auto-save keep up between two continuation passes — not only while a turn happens to be in flight. The "Run on a background thread" hint also now says what it does: a thread of its own, same workspace and model, without this conversation's history.

- **The mode and permission chips follow the active thread** — The status bar kept showing the previous thread's mode and permission after switching threads, resuming a session, clearing the view with 新建会话, or letting a goal create a thread, so the chips could name one posture while the turn actually ran under another. They now follow the active thread and fall back to the startup defaults when there is no thread — which is what the next thread inherits — and a thread the engine has discarded is rebuilt with its own mode and permission instead of the configured defaults, so a conversation the user already set up no longer changes posture behind them.

- **Background attention is decided from the summary, not from approval events** — The runtime emits `approval.required` on its auto-approve path too: a remembered "always allow" lifts the thread to Full Access, and every gated tool call then emits `approval.required` followed immediately by `approval.decided` with `"auto": true`, registering no pending approval in between. The watcher notified from the raw event, so a background thread running shell commands under a remembered allow produced one notice per tool call — an endless stream of "waiting for your approval or input" popups for a thread that never needed anyone. The notice is now decided from the summary's authoritative `pending_attention_count`, which cannot miss a real request because the runtime registers the pending approval before it sequences the event. Two consequences of the same mistake go with it: `notifiedAttention` is no longer cleared on an event-derived zero, which re-armed the notice while a real approval was still unanswered and announced the same approval twice, and `st.attention` is assigned from the summary instead of ratcheted with `Math.max`, which could only ever raise the count and pinned the rail badge once a decrement was lost.

## 0.7.1

### New Features

- **A finished plan can be approved and executed in one click** — A successful Plan-mode turn now carries a **Switch to Act & execute** action on the message that holds the plan. Taking it switches the thread to Act through the same `/mode agent` path the command uses, then sends a follow-up turn so the agent runs the plan already in the conversation, instead of making the user switch modes and restate the go-ahead. ([#12](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/12) by [@eoli](https://github.com/eoli))

### Improvements

- **Mode and permission say which scope they change** — Both dropdowns used to move two things at once: the active thread *and* the startup default every new thread inherits. Each menu now lists its roster twice under two labels — **This thread**, then **New threads** below a rule — and only the second group writes `brotherwhale.defaultMode` / `defaultPermissionPosture`. `/mode`, `/auto` and the plan-approval action are thread-scoped for the same reason, so no command can move a default behind the user's back. In a view with no conversation yet (a new chat, a viewed session) a mode or permission choice still lands on the startup default, and the toast says so rather than letting the click go nowhere.

- **Mode and Permission moved down to the toolbar** — The two dropdowns sat in the settings bar, the row that describes the request (Provider, Model, Reasoning Effort); they decide *how* a turn runs, so they now sit beside the controls that steer it — new thread, compact, undo, retry — right-aligned at the end of the toolbar, and open upward because the toolbar sits below the messages area. The dropdown handler binds both bars instead of one, so the menus that stayed in the settings bar keep working. ([#12](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/12) by [@eoli](https://github.com/eoli))

### Bug Fixes

- **Ask keeps its approval dialog when the thread still carries `trust_mode`** — The dialog was skipped on the legacy `auto_approve` / `trust_mode` bits, while the engine decides from the posture: Full Access auto-approves, Auto-Review auto-denies, and only Ask registers an approval a client has to answer. A thread moved from Full Access to Ask keeps `trust_mode: true` — switching posture patches `permission_posture` alone — so under Ask every request was dropped, and the turn stalled until the engine's approval timeout denied the tool. The posture decides now, in both directions: Ask shows the dialog, and a non-ask posture leaves the decision to the engine instead of asking for one it has already made.

- **Approving a plan no longer executes it under a mode that never changed** — The approval action sent its follow-up turn unconditionally, but `/mode` reports a failed thread patch as a message instead of throwing: when the switch failed the thread stayed in Plan, so the "execute" turn drew a second plan underneath a button that had just promised Act. The approval path now re-reads the thread's mode after the switch and stops with an error while it is still Plan, rather than sending the turn.

- **The plan approval follows the turn it belongs to, and survives a reload** — Two things decided it wrongly. It read the thread's mode at completion, which answers how the thread is set up *now*, so switching mode while the turn was still running offered or hid the action on the wrong turn; it is now decided by the mode the runtime records on the turn itself (falling back to the mode this client recorded when it started the turn, for runtimes that predate that field, and to the thread's mode for a turn nothing here started). And it only ever existed on the live turn-complete event, so reopening the thread dropped it while the plan it belonged to was still the last thing in the conversation; a rebuilt history now puts the action back on the message that carries the plan. Whichever message that is still only guessed from "the turn finished in Plan mode" — the runtime reports nothing that marks a message as *a plan*, so an answer given in Plan mode offers the action too.

- **The Threads rail no longer goes blank when its fetch is slow** — `GET /v1/threads/summary` builds every row from a full thread-detail read (`get_thread_detail` per thread, a whole-store turns+items walk), so it costs roughly a quarter-second per thread: 25.4s against a 72-thread / 189MB store, measured. That sat just inside the client's hard-coded 30s socket default and crossed it as soon as a turn was writing to the store. The failure then landed in a silent `catch` — no error, no retry, no `threadList` message — so the rail stayed empty until an unrelated watcher event happened to refresh it, which is what made it look intermittent rather than broken. The summary call now carries its own 60s timeout (`DEFAULT_REQUEST_TIMEOUT_MS` stays 30s for every other endpoint) and the catch reports instead of swallowing: one retry, but only for a failure that is actually transient — a refused or reset connection, which is what a request issued while the engine is relaunching on a fresh port sees — plus a `debugLog` line for either outcome. Overlapping refreshes are ordered by a generation token, so the slow fetch that started first can no longer publish its stale list over a newer one, or mark the rail failed after a newer fetch already succeeded.

- **The rail says what it is doing instead of presenting an empty list as the answer** — An empty rail while the fetch above was in flight was indistinguishable from "you have no threads". `refreshThreadList()` now announces the fetch with a `threadListLoading` message, and the rail renders a spinner and *Loading threads…* in place of the empty state, since "no conversations yet" is a guess until the fetch answers. The hint is scoped to the case that misleads — an empty rail: a rail that already lists threads refreshes behind them rather than putting a spinner under the list on every panel open. A fetch that failed says *Couldn't load the thread list* with a **Retry** button (`retryThreadList`) rather than sitting blank, over a populated rail too, since that list may be stale; a published list clears the row it replaces. New `threadsLoading` / `threadsLoadFailed` / `threadsRetry` strings in both languages, plus `webview-js-sidebar-runtime.test.ts`, which drives the real sidebar IIFE in a DOM stand-in — so it also guards the whole script block against the initialisation failure that takes the entire webview down with it.

### Upstream TUI PRs

- [Codewhale#6321](https://github.com/Hmbown/Codewhale/pull/6321) — feat(tui): record the mode each turn ran in on the turn (backs the plan-approval action deciding by the turn's own mode rather than the thread's current mode; older runtimes fall back to the client's recorded turn-start mode)

## 0.7.0

### New Features

- **Sidebar rebuilt around three peer tabs** — Sessions, Threads and Activity now sit as equal tabs under a hint line that says what each one holds; the Activity tab gathers the Work, Changes, Fleet, Tasks and Agents sections that used to be stacked under the session list as siblings of it, so the sidebar is one panel instead of a list plus five independent sections. The sections keep their own collapse behaviour inside that tab. The toolbar's `0 sessions` counter became an **Agent** label whose tooltip explains what the panel holds and which toggles it, and the tab bar gained a ✕ that collapses the panel. ([#10](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/10) by [@eoli](https://github.com/eoli))

- **Changes moved up to sit directly under Work** — The Activity tab's section order was Work, Fleet, Tasks, Agents, Changes, which put the files a turn actually touched last, below three panels that are only busy when you use Fleet, Tasks or Agents. Changes now follows Work, so the tab reads in the order a session generates it: what it is working on, what it changed, then the delegation panels. Nothing else about the section moved: it keeps its own collapse state, `renderChanges()` still draws into `#tab-changes`, and the section order is now pinned by a test.

- **Background threads keep working while you switch** — Selecting another thread, session or a new chat used to walk away from the running turn; now it walks away *from the view* only. The Runtime owns every turn and keeps it running, so the GUI parks the outgoing thread as a background one and holds one lightweight SSE watch on it (`GET /v1/threads/{id}/events`) while it has a running turn or pending attention. The Threads rail groups the list into **Needs you** / **Running** / **Recent** from the summary's typed `pending_attention_count` (status prose never decides a group), a background thread's approvals and questions can be answered inline in its card — approval ids are global one-shot capabilities and user inputs name their thread, so neither needs a switch — and a busy thread reports a total on the toolbar's **Agent** label. A completed background turn auto-saves into its own session, so the Sessions list stays current without the thread ever being opened. Switching back re-attaches the view to the turn that is still running (Stop and Steer work again), and adopting a thread drops its background watch so the same events never arrive twice.

- **Background goal runs, and a way to re-arm a parked goal** — Setting a goal offers *Run on a background thread*: the goal moves to a dedicated thread that inherits the current thread's model, mode and permission posture, and the Runtime's `PUT /v1/threads/{id}/goal` kicks its first turn off server-side (`activate_thread_goal`). The Work panel lists background goals below the current one with their status, budget and elapsed time, plus **Open Thread**. Since the engine has no startup sweep, a goal left Active by a Runtime restart stays parked until something re-triggers it, so an Active goal also offers **Resume**, which re-PUTs it. Under the Ask posture the kickoff warns that each background tool approval blocks and then auto-denies after the engine timeout, because that is what the pinned posture will do.

- **Approvals moved into a floating panel that shows what will actually run** — Pending approvals render as a floating bar anchored to the bottom of the messages area instead of inline blocks: a warning header, the raw tool name, a formatted view of the input (the command, key/value rows), and Allow / Deny with a "remember" option, so the decision is made against exactly what will run. Several approvals can be pending at once, and the panel treats them as individuals: answering one retires exactly that one — the card in the stream states what is waiting while the panel owns the actions — and the panel hides only once it is empty. It is state-driven rather than event-only, so a rebuilt conversation (view switch, reopened sidebar, restored session) hands its awaiting-approval tool calls back to the panel instead of showing a request with nothing to click; stacked approvals scroll inside the bounded panel (max-height, sticky header) instead of overflowing the messages area; and an interrupt retires the approvals it drops instead of leaving their buttons drawable. ([#11](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/11) by [@eoli](https://github.com/eoli))

- **Thinking preview shows the tail, tool blocks clip by default** — Streamed thinking renders as a collapsed preview pinned to the end of the content (last ~6 lines, fade-out mask at the top) until expanded. Tool input and output blocks are clipped by default with a semi-transparent veil hinting at hidden content; a block becomes scrollable on focus or click, which also removes the veil — and blocks carry `tabindex`, so the keyboard reaches the affordance exactly as a click does. The veil is drawn only where content is genuinely hidden: it is measured after layout, re-measured on resize (the panel is resizable, and a width change re-wraps the text), and a live tool call card is measured after it is inserted — the card most in need of the affordance used to be measured before it had any layout, so it never got one. ([#11](https://github.com/HengQuWorld/CodeWhale-VSCode/pull/11) by [@eoli](https://github.com/eoli))

### Improvements

- **Attention is watched, not polled** — The old sidebar polled the thread summary every 30 seconds while a turn ran, so a background thread waiting on an approval could sit unnoticed. Each busy background thread now holds its own event stream instead, and the notification that says so (`brotherwhale.backgroundThreadNotifications`, on by default) fires once per attention episode rather than once per event: a VS Code information message with **Open** that switches to the waiting thread. The watch set is reconciled from every thread-list refresh — the summary remains the authority for what is running or needs attention, and watcher events only refine it in between — and the cursor state behind those threads is pruned when they go quiet, so a long session does not accumulate cursors for threads it has finished with.

- **Switching is no longer an interruption decision** — The modal *Conversation in progress / Stop & Switch* is gone, along with `confirmSwitchWhenActive` and the three i18n strings behind it: nothing interrupts a running turn on the way out any more, so there is nothing to confirm. A turn is stopped by **Stop**, or by the engine's own timeout, and switching back now resumes observing the turn that was running (`turnStarted` re-fires for it, so the Stop/Steer controls come back).

- **`brotherwhale.showThreadList` removed** — The setting stopped hiding anything once the three tabs became peers: it was still contributed, documented and read by the chat provider, but the only thing left in the webview was a no-op assignment, so a user who set it saw the Threads tab anyway and nothing said so. The contribution, its `package.nls` strings, its three reads and the no-op it fed are gone; a `settings.json` that still carries it reports the key as unknown, which is the honest answer for a setting that no longer decides anything.

- **The panel closes with `Esc`** — Collapsing the panel used to mean finding its ✕. `Esc` now collapses an open panel too; inputs keep their own `Esc` handling (the slash menu, the task draft), and a keypress that reaches one of them is left alone.

- **Scrolling is no longer smooth, on purpose** — the webview's `scroll-behavior: smooth` made programmatic scrolls (following the streamed turn, jumping through history) animate to their destination, which hurt scroll reliability; it is removed so the view lands where it is asked to, immediately.

### Bug Fixes

- **The threads panel sits beside the chat again** — #10 made the panel an absolutely positioned overlay (opaque background, drop shadow) so that opening it would not take width from the chat. Taking that width was the point: the overlay covered the messages it exists to navigate, and no amount of resize could make the two visible at once on a wide view. The panel is an in-flow flex child of `#layout` again, so the chat is squeezed rather than covered, and the resize handle works from its own place in the row instead of being repositioned by every drag (the saved width still applies to the panel on load).

- **The Sessions empty state could stack** — `renderSessions()` removed `.session-empty-msg` nodes before each render but appends its empty state as `.work-empty`, so an empty result list (a search with no matches, or a workspace with no saved sessions) added another "no conversations" block on every re-render instead of replacing the one already there. Both list renderers now remove exactly what they create.

- **The goal slot's buttons work from a view that has no thread** — A goal is thread-scoped, but the GUI spends real time without a thread: 新建会话 clears it, and a saved session has none until it is resumed. Every goal action returned in silence there, so ＋ Set goal, Complete, Block, Delete and Resume all looked dead. Set goal now obtains the thread the way the first message would — resuming a viewed session into its own thread (the TUI restores a session's goal with the session, and the next message would have resumed it anyway) or creating one under 新建会话 — and an action still left with nothing to act on answers in a banner instead of returning silently. A background goal is unaffected: it is created on a thread of its own whether or not the view has one.

- **An open goal editor no longer outlives its thread, or fights the state pushes** — The extension pushes `goalState` on every sidebar refresh and turn end, and the slot rebuilt itself each time: a click on ＋ Set goal whose press and release straddled a push landed on the slot instead of the button, and a draft being typed was discarded. The slot now redraws only when the state actually changes, and never over an open editor — but a real view change (new chat, thread switch, opened session) resets it, so the previous conversation's goal, background list and half-written draft cannot survive into the next one, and a draft typed for one thread can no longer be saved against another.

- **A dropped goal save answers instead of freezing** — Set goal closed nothing on its failure path: the editor stayed mounted on screen with no answer, which is indistinguishable from a dead button. Saving now closes the editor as it sends, keeps the objective so a save the extension never confirms hands the draft back on the next open, and the extension answers every path (goalState, or an error banner). An empty objective cannot be submitted at all — the save button ships disabled until there is something to save — and a goal error no longer reports the turn it did not come from as finished.

## 0.6.2

### New Features

- **Settings gear in the sidebar title bar** — The config panel was reached through a gear button rendered inside the chat webview; the entry point now lives in the editor chrome instead. The CodeWhale sidebar's view title bar shows a native gear icon (`brotherwhale.openConfig`, contributed through `menus["view/title"]` in the navigation group), so it behaves like every other VSCode panel action and stays available regardless of webview state. The in-webview `#btn-config` button, its CSS and its click handler are gone, along with the redundant `brotherwhale.settings` tree view and `SettingsViewProvider`, leaving the gear as the single entry point; the `/config` slash command keeps opening the same panel.

- **Composer rebuilt as an input box with a bottom toolbar** — The input area is now a bordered box with a `:focus-within` highlight whose bottom edge is a toolbar: the attachment button sits on the left, a compact icon-only Send/Stop button is pinned to the far right (inline SVG paper-plane/square icons, since the webview does not load the codicon font, with titles and aria-labels switching with the streaming state), and the textarea fills the box above. The composer height is under explicit user control: the textarea keeps a 52px floor, the resize handle drags it between 52 and 340px (persisted as `codewhale:inputHeight`), and overflowing text scrolls inside the box instead of growing the frame — the previous auto-grow logic and its height resets on send and history recall, which made the frame jump while typing, are removed. The Stop state also now actually turns red; the `.streaming` rule had been outranked by the generic button background selector.

- **Sidebar resize handle restored with hardened drag** — The threads panel can be resized by dragging inside the webview again. The handle is back with the input handle's hardened pattern: window-level listeners, cleanup on mouseleave/blur, rAF-throttled width writes and an `is-resizing` guard (which also keeps tooltips from repositioning mid-drag), and the width persists across sessions via `codewhale:sidebarWidth`. The handle hides while the threads panel is collapsed, so a closed sidebar never shows a dead grip, and the input handle's cleanup now removes the window listeners it registers.

### Improvements

- **Goal UI consolidated into a single slot** — The thread goal was rendered twice (a standalone sidebar section plus an inline copy in the Work panel); all goal UI now lives in one dedicated `#work-goal` slot inside the Work panel. The chat provider no longer includes the goal in the workState payload — goal state flows exclusively through `refreshGoal` — and `/goal` slash commands now drive the engine's native thread goal API instead of writing local config settings. Outdated CLI-only commands (`/verbose`, `/profile`, `/translate`) are marked unavailable in the GUI.

- **Coherence banner and cycle count removed** — The TUI no longer emits `coherence.state` / `cycle.advanced` events or exposes `coherence_state` on thread records, so the dead chain is removed end to end: the `ThreadRecord` field, session-state fields, chat-provider event cases, webview banner/cycle rendering and reset paths, and the `coherence*` / `cycles` i18n keys. The Work panel empty state now keys on checklist + strategy. Regression coverage for sidebar clearing and the workState payload structure is kept; the fabricated state-machine tests are gone.

## 0.6.1

### Bug Fixes

- **A second editor window can start its own Runtime again** — Every window handed its Runtime child the same store, and the Runtime allows one process per store, so only the first window came up: the second child exited with "This runtime is already active in another process" before it bound its port, and the panel could only report "Engine exited before becoming ready". Each child now runs on `CODEWHALE_RUNTIME_DIR` under the extension's global storage, keyed by the workspace path, so the store a workspace uses is decided by the workspace rather than by which window happened to start first, and a reload comes back to the same history instead of a fresh store. Both env spellings are set, so an older Runtime isolates as well instead of silently sharing another window's store. Isolation moves the Runtime store only: tasks stay where the panel reads them and saved sessions stay shared. The shared store from earlier versions is no longer read, so a workspace's Threads list starts empty once; that store is left on disk untouched. A second window on the same workspace still cannot share a store, but it now shows the Runtime's own refusal instead of a generic message — the child's error line travels with the startup error, which makes every other startup failure legible too.

## 0.6.0

### New Features

- **Per-file Revert in the Changes panel, behind a file-scoped engine endpoint** — The **Revert** button on a change card is back, restored the way it should have been built the first time. The GUI now calls `POST /v1/threads/{id}/file-revert`, which restores exactly one path from the restore point the request names; the old implementation drove `POST /v1/snapshots/{id}/restore`, which restores the **whole workspace**, so "revert one file" silently rolled back every other file the session had touched. The engine will not guess which restore point is meant — an unrelated newer snapshot can erase later edits while leaving the change in place — so the GUI names the one taken before the tool call that produced the reviewed change (`tool:<call_id>`, resolved through `GET /v1/snapshots`) and sends the `sha256` of the bytes the panel showed, or `absent` for a file it saw deleted. That digest is captured while the change is recorded, so if the user edits the file afterwards the engine refuses with a `409` instead of overwriting the edit, and the panel re-reads the file and asks for a deliberate second click. Each refusal the engine can give — untrusted thread, changed file, pruned restore point, a turn already running in the workspace — is surfaced as its own guidance rather than as "API error 409". Reverting a file leaves every other file's recorded changes untouched. The Changes panel now keeps **one record per change instead of one merged record per file**: a file edited three times is three rows, each carrying its own diff and its own Revert, so unwinding one of them drops only that entry — the earlier changes, still on disk, stay listed and stay revertable. Per-file totals are summed where they are shown rather than stored on the record. The button stays disabled with an explanation when the connected engine predates the endpoint — the GUI never falls back to a workspace-wide restore, and replayed `revertFileChange` messages are refused rather than reinterpreted.

- **Images can be pasted and dragged into the composer** — `Ctrl/Cmd+V` of a screenshot, or a drag from Finder, Explorer or the VS Code Explorer, now attaches to the turn. Pasted and OS-dropped images are persisted under `~/.codewhale/clipboard-images/` and re-enter the turn through the same `[Attached image: …]` placeholder the TUI uses, so the engine expands them into image blocks exactly as it does for `/attach`; non-image drops land in `~/.codewhale/dropped-files/` and attach as ordinary `@path` files. Images are validated when they are attached rather than when the turn is sent: the bytes must sniff to PNG, JPEG, GIF or WebP and stay under 5 MiB, matching `image_attach.rs`, so a BMP, TIFF or oversized file is refused up front with an explanation instead of failing in-band after the turn has already run. A drop from the editor's file list keeps its real workspace path and needs no copy. Dragging *text* is left alone — prose and code selections keep their default insert rather than being read as a path — and the whole webview highlights while a file drag hovers. The thumbnail travels to the webview once, keyed by attachment, so a multi-megabyte image is not re-sent every time the attachment list changes.

### Improvements

- **Each window owns and authenticates its own Runtime** — Every trusted editor window now starts one Runtime child and stops only the child it owns. Startup waits for the child's successful-bind message before sending the generated bearer token — still compatible with Runtime 0.9.12, which requires a nonzero port — so a competing listener can no longer be handed the credentials during port selection; HTTP requests and existing event streams use that same token. Concurrent starts are deduplicated, and stop or restart cancels a pending startup before it can create another child, so a window reload cannot leave an orphaned engine behind. Runtime execution and policy settings are machine-scoped rather than per-window, and the extension is disabled in untrusted workspaces. The child's log lines are buffered so a token split across writes is still redacted. Closing or reloading the window interrupts the Runtime work it started, while saved sessions remain resumable; the unused fixed-port setting is gone.

### Bug Fixes

- **Undo no longer rolls back the whole workspace without trust** — The **Undo** button drove `POST /v1/threads/{id}/patch-undo`, which restores the *entire* workspace from a snapshot and then forks the last turn. The runtime applies no gate of its own, so in Ask or Auto-Review posture a single click silently reverted every file the session had touched, where the TUI's `/undo` refuses to touch files without `yolo`/`trust_mode`. The gate now lives in the engine, where the rollback target is actually known: it reads the thread's own `trust_mode` / `auto_approve` — the client does not get to assert it — and when a rollback target exists on an untrusted thread it refuses with a `409` explaining how to enable it. Nothing is changed in that case, and the turn is deliberately *not* forked either: dropping the turn while its file changes stay on disk leaves a workspace the transcript can no longer account for, which is worse than refusing outright. When there is provably nothing to roll back, an untrusted undo still forks the turn — that half needs no trust.

- **Undo reports the file outcome instead of staying silent** — The rollback summary was only shown when files *were* restored, so "nothing to revert" and "snapshot repo unavailable" both looked exactly like a successful undo; the user had no way to learn their workspace was untouched. The engine's `patch_result.summary` is now surfaced in both cases.

- **The Undo summary now describes what the undo changed** — `patch_undo_workspace_files()` and the TUI's `patch_undo()` built their "Files affected" list with `git diff --stat` run in the *user's* workspace against the *user's* `.git`. That reports the user's own uncommitted work: it could list files the restore never touched, and report nothing at all when that work happened to be committed. Both now use `SnapshotRepo::snapshot_diff_stat()`, which diffs the target snapshot against the working tree inside the side repo — captured *before* the restore, since afterwards the two sides agree by construction.

- **Engine refusals read as sentences, not wire envelopes** — the runtime's error body is a JSON envelope (`{"error":{"message":…}}`); the API client now unwraps it, so a deliberate refusal such as the patch-undo trust `409` is shown as the engine's own guidance instead of raw JSON.

- **First-run task persistence** — The `DEEPSEEK_TASKS_DIR` handed to the Runtime child points into the extension's global storage, which is not guaranteed to exist yet on a fresh install; it is now created recursively before the child is spawned, so task persistence cannot fail on a missing parent.

### Upstream TUI PRs

- [Codewhale#6111](https://github.com/Hmbown/Codewhale/pull/6111) — feat(tui): add a file-scoped restore endpoint and gate the whole-tree rollback (backs the per-file Revert control and the Undo trust gate)

## 0.5.1

### New Features

- **TUI Mode Surface Parity (Act / Plan / Operate)** — The status bar's mode picker now mirrors the TUI's roster instead of the retired `agent / plan / yolo` triple. `agent` displays as **Act** (its `AppMode::display_name()`), `operate` is selectable, and numeric shortcuts follow `/mode`: `1` = Act, `2` = Plan, `3` = Operate. `/mode yolo` (and `4` / `bypass`) stays a one-way compatibility alias that installs **Act + Full Access**, exactly like the TUI — it is never a visible mode.

- **Permission Posture as a Separate Dimension** — A new status-bar dropdown switches the thread's `permission_posture` independently of the mode (**Ask / Auto-Review / Full Access**, mirroring `Shift+Tab`), and `/auto` switches to Auto-Review. `ThreadRecord.permission_posture` is now modeled and sent on thread create/update/start-turn, so a non-full-access posture (e.g. Auto-Review) is no longer re-derived to Ask by the auto-approve compatibility input. "Remember" on an approval now also flips the local posture to Full Access.

- **`/memory` and `/restore` via the Runtime API** — `/memory` now reads and writes memory through the TUI runtime API instead of touching `~/.deepseek/memory.md` directly, and `/restore` lists snapshots and restores a chosen one via `GET /v1/snapshots` + `POST /v1/snapshots/{id}/restore`.

### Improvements

- **Config panel** — Default Mode offers Act / Plan / Operate, and the old Approval Mode list (`suggest / auto / on-request / untrusted`) is replaced by the canonical **Permission Posture** values `ask / auto-review / full-access` (exactly the engine's `approval_mode` enum; `use-tui-default` belongs to `approval_policy` and `never` is managed-policy-only).

- **Operate runtime handoff filtering** — Runtime-owned user-role messages (the one-time Operate contract, sub-agent and shell-completion handoffs) are no longer rendered as user bubbles when loading a saved session; the filter is structural (trailing `<turn_meta>` provenance), so a person quoting the envelope is unaffected.

### Configuration

- `brotherwhale.defaultMode` enum is now `agent | plan | operate` (a legacy `yolo` value still resolves to Act + Full Access). New setting `brotherwhale.defaultPermissionPosture` (`ask | auto_review | full_access`) supplies the starting posture for new threads.

- Removed the `brotherwhale.autoStartEngine` setting and its related code; the engine lifecycle is now managed by the runtime API.

### Bug Fixes

- **Send/Stop button no longer flickers during a turn** — Engine status prose (`<kind> started`, `Turn: in_progress`, history-load notices) is informational and arrives interleaved with stream deltas; it was routed through the streaming-state setter, so every reasoning-item start flipped the composer button back to **Send** until the next delta returned it to **Stop**. Status messages now repaint only the status-bar text, and a history load clears the running-turn state explicitly instead of as a side effect of that message.

- **Open and Diff on a reloaded session's changed files** — A recorded file path is the one the model requested, i.e. workspace-relative; resolving it against the TUI task data dir alone made every `Open` report "Artifact file is no longer available". Paths now resolve against the workspace the session was recorded in (then the open window's folders), with the task dir kept as the artifact fallback. The same replay also lost the `Diff` action: a saved session keeps no `file.mutation` receipt and the contract `edit` tool answers with a one-line summary, so there was no diff text to extract. Diffs are now rebuilt from the exact replacements recorded in each call's input, walking the file back from its content on disk; a chain that no longer lines up is left without a diff rather than given a fabricated one. Replayed change cards also stop reporting a file tool that failed — the live view shows no card for it either.

## 0.5.0

### New Features

- **Fleet Multi-Agent Management** — A Fleet sidebar section and detail overlay list managed multi-agent runs (workers, tasks, receipts) with start/stop, worker interrupt/stop/restart, and a live SSE event timeline (severity-coded, filterable by issues / progress / all). Detail rows join creation-time task specs so names, roles, objectives and prompts render instead of bare ids; receipt cards show score notes and open the saved session reply. "New from this run" prefills the create dialog, which validates duplicate role names / task ids and ASCII token ids before submit.

- **Thread Goal Control** — A Thread Goal section shows status, token budget usage (red when over budget), elapsed time and continuation count, with set / edit / complete / block / delete backed by the thread goal API.

### Improvements

- **Cross-Thread Attention Surfacing** — Background threads with pending approvals or inputs show a pulsing attention dot, and the thread list polls every 30s while a turn runs so approvals on other threads surface in the GUI.

- **i18n Table Injection** — The full i18n table is injected as escaped JSON so new translation keys reach every webview module automatically.

### Bug Fixes

- **Relative Time Day Boundary** — Fixed a day-boundary rounding bug in relative time display.

## 0.4.5

### New Features

- **Inline Tool Arguments** — Each tool call now renders its inputs in the tool-call card so you can see exactly what the agent is about to run, most notably the shell command for `exec_shell` as a `$ …` block. Seed-path tool_use arguments are recovered from the TUI runtime (`metadata.tool_name` is authoritative, JSON input parsed from `detail`), seed `detail` is no longer double-rendered as output, and a shell-tool whitelist with whole-segment fallback prevents misclassification.

### Bug Fixes

- **File-Change Cards From TUI Mutation Metadata** — File-change cards are now detected from the authoritative `metadata.mutation` diff attached to tool results, so newer TUI file tools (write, edit, fim_edit, unified File action) render cards regardless of tool name; the legacy name-based heuristic remains as a fallback for old recordings and seed replay. The duplicated diff-extraction paths are centralized into a single `detectFileChange`, and a seed-built card is rebuilt when the real tool result arrives to backfill the actual diff and added/removed line counts.

- **Diff Stat Counts** — `parseDiffStats` no longer miscounts code lines starting with `--` or `++` as file headers (only `---` / `+++` with a trailing space match), and `extractDiffForTool` reads the new `replace` array input while keeping the deprecated `changes` alias working. Write-style inputs synthesize a creation diff when the result embeds none, and edit tools count added/removed lines from the edits array.

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
