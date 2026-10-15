# `src/chat-provider/`

Test suites for `../chat-provider.ts` — the extension host's chat orchestration
module (webview message handling, engine event routing, thread/session
lifecycle, settings).

The module itself stays at `src/chat-provider.ts`; this directory holds only its
tests and their double. Every suite here imports it as `../../chat-provider`,
which resolves to that file. **Do not add an `index.ts` here** — a directory
index would silently change what `../../chat-provider` resolves to and shadow
the module (the file wins today; the directory index wins only once the file is
gone).

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

`vscode-double.ts` is the `vscode` module every suite here runs against;
`vitest.config.ts` maps `vscode` to it. Suites do not mock `vscode` — they
import it and get the double. The double is the union of what these suites
need, and `vscodeState` is its mutable half: which configuration values
`getConfiguration()` answers with, what `workspaceFolders` reports, what a
document opened off disk contains.

A suite that needs the double to behave differently from its defaults — an
answer to a confirmation dialog, a file's bytes, a workspace folder — sets that
on `vscodeState` in its own setup, beside the tests it affects. `createProvider()`
stays per-file: each suite fakes a different subset of the runtime API client,
and that harness is about the client, not the host.
