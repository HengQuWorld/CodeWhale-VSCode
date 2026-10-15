# `src/chat-provider/`

Two things live here: the parts that have been **split out of**
`../chat-provider.ts`, each with its own tests beside it, and the suites that
cover the provider itself.

The provider module stays at `src/chat-provider.ts`. Suites here import it as
`../../chat-provider`, which resolves to that file. **Do not add an `index.ts`
here** — a directory index would silently change what `../../chat-provider`
resolves to and shadow the module (the file wins today; the directory index
wins only once the file is gone).

## The modules split out of the provider

Each is a small controller that owns the state for one concern and reaches the
provider through a narrow host interface rather than the provider itself. The
provider keeps the same methods as one-line delegations, so the webview's
messages and the slash commands route exactly as before — the split changed
where the code lives, not what it does.

- **`mcp.ts`** — the engine's MCP servers: list, enable/disable, reconnect,
  remove, add, read a server's tools, review imports.
- **`skills.ts`** — the skills panel: list, toggle, activate, install, mutate,
  audit.
- **`fleet.ts`** — managed multi-agent runs: the list, the open run's detail
  and event stream, and the worker actions.

Capability flags are read through host methods rather than captured, because
they are filled in by the runtime probe after startup.

## The provider's own suites

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
npx vitest run src/chat-provider               # this directory
npx vitest run src/chat-provider/threads       # one area
```

## What is still in the provider

`chat-provider.ts` is still one large class, deliberately. The parts above
could move because each needed a handful of things from it. What remains — the
webview message dispatch, initialization, the SSE event stream, the background
thread watcher, the changes bookkeeping — reaches across 19 to 63 of the
class's own members at a time, so any split would need a host interface nearly
as large as the behavior it carried. That is a state-boundary redesign rather
than a move, and it has not been done.

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
