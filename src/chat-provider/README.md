# `src/chat-provider/`

Test suites for `../chat-provider.ts` — the extension host's chat orchestration
module (webview message handling, engine event routing, thread/session
lifecycle, settings).

The module itself stays at `src/chat-provider.ts`; this directory holds only its
tests. Every suite here imports it as `../../chat-provider`, which resolves to
that file. **Do not add an `index.ts` here** — a directory index would silently
change what `../../chat-provider` resolves to and shadow the module (the file
wins today; the directory index wins only once the file is gone).

## Layout

One directory per area of the module's behavior. The suite at the top of this
directory is the module's own — event routing guards, the event-handling state
machine, tool-call transitions, task-refresh triggers, message and change
models. Everything narrower lives below it.

- **`threads/`** — the thread and session list: session binding, switching,
  background watching, forking from a turn, the new-thread route.
- **`turns/`** — one turn's life: send, steer, stop and send-refusal, why a turn
  failed, undo/retry, manual compaction, the completion cue.
- **`transcript/`** — what a loaded or rebuilt conversation shows: how it is
  rebuilt (`history-rendering`, `history-tool-calls`, `history-changes-panel`,
  `history-diff-rebuild`, `history-pending-attention`,
  `history-viewed-session`, `history-unreadable-block`), the detail view, and
  the file changes a command caused.
- **`composer/`** — the input area: image/attachment handling, input history.
- **`settings/`** — mode, permission posture, provider switch, workspace trust.
- **`integrations/`** — engine capabilities the panel manages: MCP servers,
  skills.

## Running them

```sh
npm test                                       # everything
npx vitest run src/chat-provider               # this module's suites
npx vitest run src/chat-provider/threads       # one area
```

## Shared setup

Each suite declares its own `vi.mock("vscode", ...)` double, because `vi.mock`
factories are hoisted per test file and cannot be hoisted out of an import.
Those doubles are near-duplicates by necessity, not by accident; the variants
differ in which window/workspace members each suite needs. The `createProvider()`
harness is likewise per-file, since each suite fakes a different subset of the
runtime API client.
