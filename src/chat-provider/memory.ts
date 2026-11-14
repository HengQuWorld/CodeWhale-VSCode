/**
 * The Memory panel: the engine's native memory store, read and maintained
 * through the Context Lens.
 *
 * Extracted from `chat-provider.ts` the same way the skills and MCP
 * controllers were: the provider keeps one-line delegations, so the webview's
 * messages and the slash commands route exactly as before.
 *
 * Nothing about memory is decided here. The engine owns the store, the review
 * policy and every mutation; this side reads the Lens and turns one click into
 * one engine command. Two rules come from the engine and are repeated in the
 * wording, because a client that hid them would be promising more than the
 * store can do:
 *
 *  - Approving or forgetting changes what *later* turns are given. Context a
 *    model has already received cannot be retracted, and the engine says so on
 *    every action receipt.
 *  - A write carries the revision the panel displayed. The engine refuses a
 *    write against an entry that moved on, which is why every refusal is
 *    followed by a re-read instead of a guess.
 */

import type { CodeWhaleApiClient, MemoryLensAction, MemoryLensEntry } from "../types";
import { formatError, getErrorMessage } from "../utils/error-handler";
import { MEMORY_LENS_ID_CHARS, MEMORY_USAGE, collectMemoryLens, memoryLensId } from "../utils/memory-lens";

/**
 * What the controller needs from the provider it serves.
 *
 * The capability answer is read live: it comes from probing the runtime after
 * startup, so a snapshot taken at construction would freeze it at "no".
 */
export interface MemoryHost {
  readonly api: CodeWhaleApiClient;
  /** Whether the engine advertises the memory family (`capabilities.memory`). */
  hasMemoryStore(): boolean;
  /** The conversation the view is on, so its session-scoped entries are read
   *  too. Null when there is no thread yet. */
  currentThreadId(): string | null;
  postMessage(msg: Record<string, unknown>): void;
  debugLog(msg: string): void;
}

/** A read the panel could not complete, in terms the panel can draw. */
export interface MemoryPanelProblem {
  /** `unsupported`: the engine has no memory routes at all (it predates them).
   *  `disabled`: the routes exist but memory is turned off in the engine's
   *  config. `failed`: anything else, with the client's own message. */
  kind: "unsupported" | "disabled" | "failed";
  message: string;
}

/** One row as the webview draws it. */
export interface MemoryPanelRow {
  /** The Lens UUID. Unlike the flat listing's `id`, this is not a row number
   *  and is the only value the action route accepts. */
  id: string;
  shortId: string;
  /** The entry's own revision. Approve, reject and forget write against this. */
  revision: number;
  /** The *preference* row's revision, which is a different counter: pin and
   *  exclude write against it, and the engine refuses a write whose revision
   *  does not match the preferences it holds (`set_preferences` compares
   *  `memory_preferences.revision`, not `memories.revision`). A never-touched
   *  entry has no preference row, so this is 0 while the memory may be at 2. */
  preferencesRevision: number;
  status: string;
  title: string;
  body: string;
  kind: string;
  /** Where the entry applies: this conversation, this repository, or the user. */
  scope: "session" | "workspace" | "global";
  pinned: boolean;
  suppressed: boolean;
  /** Why the engine considers the entry fresh / stale / expired. */
  freshness: string;
  /** Whether the entry is in some assembled context packet. */
  inContext: boolean;
  updatedAt: number;
}

export class MemoryController {
  /** The rows last published by a good read. A failed refresh keeps them on
   *  screen with a one-line note rather than blanking a list the user was
   *  reading — the same rule the Skills panel follows. */
  private rows: MemoryPanelRow[] = [];
  private canReview = false;
  private canForget = false;
  private loaded = false;

  constructor(private readonly host: MemoryHost) {}

  /** Read the Lens and push it to the panel.
   *
   *  One page is enough for a maintenance panel: the store is meant to be
   *  small, and a read that has to walk five pages is a store whose first
   *  screenful is what the reader is acting on anyway. `truncated` says the
   *  rest is not shown, so the panel never implies it listed everything. */
  public async refreshMemoryPanel(): Promise<void> {
    if (!this.host.hasMemoryStore()) {
      this.postState(
        [],
        { kind: "unsupported", message: unsupportedMessage() },
        false,
        false,
        false,
      );
      return;
    }
    try {
      const read = await collectMemoryLens(this.host.api, {
        threadId: this.host.currentThreadId() ?? undefined,
        maxPages: 1,
      });
      this.rows = read.entries.map(memoryRow);
      this.canReview = read.snapshot.can_review;
      this.canForget = read.snapshot.can_forget;
      this.loaded = true;
      this.postState(this.rows, null, read.truncated, this.canReview, this.canForget);
    } catch (err) {
      // `debugLog`, not a transcript error: a background refresh that fails
      // while the panel is closed should not interrupt the conversation. The
      // panel says what could not be read; the cause is in the log.
      this.host.debugLog(`refreshMemoryPanel failed: ${getErrorMessage(err)}`);
      const problem = describeReadFailure(err);
      // Without a previous good read the panel has nothing truthful to draw
      // but the problem; with one, the last known rows stay and the note says
      // they are what the panel last read.
      const keep = this.loaded && problem.kind === "failed";
      this.postState(
        keep ? this.rows : [],
        problem,
        false,
        keep && this.canReview,
        keep && this.canForget,
      );
    }
  }

  /** Approve, reject, forget, or re-preference one entry.
   *
   *  `revision` is the revision the panel displayed. A refusal (the entry
   *  moved on, or its state no longer allows the action) is followed by a
   *  re-read: the buttons on screen were built from a stale snapshot, so the
   *  next click must act on what is there now. */
  public async act(
    action: string,
    id: string,
    revision: number,
    flags?: { pinned?: boolean; suppressed?: boolean },
  ): Promise<void> {
    if (!id || !Number.isInteger(revision) || revision < 0) {
      this.host.postMessage({ type: "error", message: MEMORY_USAGE });
      return;
    }
    const command = buildCommand(action, id, revision, flags);
    if (!command) {
      this.host.postMessage({ type: "error", message: MEMORY_USAGE });
      return;
    }
    try {
      const receipt = await this.host.api.memoryLensAction(command);
      const shortId = id.slice(0, MEMORY_LENS_ID_CHARS);
      const caveat = receipt.already_sent_context_cannot_be_retracted
        ? " Text already sent to the model cannot be retracted."
        : "";
      this.host.postMessage({
        type: "info",
        message: `${describeAction(action, shortId, flags)}${caveat}`,
      });
      await this.refreshMemoryPanel();
    } catch (err) {
      this.host.postMessage({ type: "error", message: describeActionFailure(err) });
      // Even when the engine refused because the entry moved on, the refusal
      // is a fact about the store; re-reading is what makes the next click
      // land on the current revision.
      if (this.loaded) await this.refreshMemoryPanel();
    }
  }

  /** Append a note as a reviewed memory.
   *
   *  `POST /v1/memory` is the authenticated operator surface, so the entry
   *  lands active — the explicit request is the review. That is the same
   *  behaviour the GUI's `/memory remember` already had, and it is deliberately
   *  unlike the model's own capture path, which stays candidate-only. */
  public async remember(text: string, scope?: string): Promise<void> {
    const note = (text ?? "").trim();
    if (!note) {
      this.host.postMessage({ type: "error", message: MEMORY_USAGE });
      return;
    }
    if (scope !== undefined && scope !== "global" && scope !== "workspace") {
      this.host.postMessage({
        type: "error",
        message: `Invalid memory scope '${scope}': expected 'global' or 'workspace'.`,
      });
      return;
    }
    const target = scope === "workspace" ? "workspace" : "global";
    try {
      const { entry } = await this.host.api.createMemoryEntry(note, target);
      this.host.postMessage({
        type: "info",
        message: `Remembered #${entry.id} (${entry.scope}) — it is given to later turns.`,
      });
      await this.refreshMemoryPanel();
    } catch (err) {
      // A workspace note on a repository with no git origin is refused by the
      // engine with that reason; the prefix must not bury it.
      this.host.postMessage({
        type: "error",
        message: formatError("Could not remember that note", err),
      });
    }
  }

  private postState(
    rows: MemoryPanelRow[],
    problem: MemoryPanelProblem | null,
    truncated: boolean,
    canReview: boolean,
    canForget: boolean,
  ): void {
    this.host.postMessage({
      type: "memoryState",
      entries: rows,
      canReview,
      canForget,
      truncated,
      problem,
    });
  }
}

function unsupportedMessage(): string {
  return (
    "This engine has no memory routes, so the panel cannot list or maintain memory. " +
    "Update the CodeWhale engine to one that ships the native memory store."
  );
}

/** One Lens entry as the panel draws it.
 *
 *  `title` falls back to the first line of the body: a note captured without a
 *  title is still recognizable by how it starts, and a row with an empty title
 *  would look like a broken entry. */
function memoryRow(entry: MemoryLensEntry): MemoryPanelRow {
  const draft = entry.memory.draft;
  const scope = draft.scope;
  const body = draft.body ?? "";
  const firstLine = body.split("\n", 1)[0] ?? "";
  return {
    id: entry.memory.id,
    shortId: memoryLensId(entry),
    revision: entry.memory.revision,
    preferencesRevision: entry.preferences.revision,
    status: entry.memory.status,
    title: draft.title || firstLine,
    body,
    kind: draft.kind,
    // A session scope is the workspace scope plus a session id. Saying
    // "workspace" for it would claim the note outlives the conversation, which
    // is exactly what it does not do.
    scope: scope.session ? "session" : scope.workspace ? "workspace" : "global",
    pinned: entry.preferences.pinned,
    suppressed: entry.preferences.suppressed,
    freshness: entry.freshness,
    inContext: entry.in_contexts.length > 0,
    updatedAt: entry.memory.updated_at,
  };
}

/** The one roster of actions a row can send: approve, reject, forget, or a
 *  preferences write (pin/unpin and suppress/unsuppress — the engine takes both
 *  flags together, so the panel sends the pair it wants rather than a delta).
 *  Anything else is refused here rather than posted to the engine. */
function buildCommand(
  action: string,
  id: string,
  revision: number,
  flags?: { pinned?: boolean; suppressed?: boolean },
): MemoryLensAction | null {
  switch (action) {
    case "approve":
      return { action: "approve", id, revision };
    case "reject":
      return { action: "reject", id, revision };
    case "forget":
      return { action: "forget", id, revision };
    case "preferences":
      if (typeof flags?.pinned !== "boolean" || typeof flags?.suppressed !== "boolean") {
        return null;
      }
      return {
        action: "preferences",
        id,
        revision,
        pinned: flags.pinned,
        suppressed: flags.suppressed,
      };
    default:
      return null;
  }
}

function describeAction(
  action: string,
  shortId: string,
  flags?: { pinned?: boolean; suppressed?: boolean },
): string {
  switch (action) {
    case "approve":
      return `Approved ${shortId} — later turns are given it.`;
    case "reject":
      return `Rejected ${shortId} — it will not be given to the model.`;
    case "forget":
      return `Forgotten ${shortId} — it will not be given to later turns.`;
    case "preferences":
      if (flags?.suppressed) return `Excluded ${shortId} — it stays in the store but is never given.`;
      if (flags?.pinned) return `Pinned ${shortId} — it keeps its place in the context budget.`;
      return `Updated ${shortId}.`;
    default:
      return `Updated ${shortId}.`;
  }
}

/** Turn the engine's refusal codes into the next step the user needs.
 *
 *  A Lens error arrives as `{"error":"<code>"}` rather than the `error.message`
 *  envelope the client unwraps, so left alone it surfaces as raw JSON with no
 *  way forward. An unrecognised code falls back to the client's own message
 *  rather than a guess. */
function describeActionFailure(err: unknown): string {
  const message = getErrorMessage(err);
  if (message.includes("revision_conflict")) {
    return "That memory changed since the panel read it, so nothing was decided. The list has been refreshed — act on the entry as it reads now.";
  }
  if (message.includes("invalid_state")) {
    return "That memory is not in a state where this action applies — it may already have been decided. The list has been refreshed.";
  }
  if (message.includes("validation_required")) {
    return "That memory needs a validation receipt before it can be approved, which this panel cannot supply. It can still be rejected or forgotten.";
  }
  if (message.includes("denied")) {
    return "This runtime does not grant the permission that action needs; nothing was changed.";
  }
  return formatError("Memory error", err);
}

/** Why the Lens could not be read.
 *
 *  The status is the discriminator, not digits that happen to appear in the
 *  message: the client throws `API error <status>: <body>`, and a body that
 *  mentions an id must not read as a missing route. */
function describeReadFailure(err: unknown): MemoryPanelProblem {
  const message = getErrorMessage(err);
  if (/^API error 404\b/.test(message)) {
    return { kind: "unsupported", message: unsupportedMessage() };
  }
  if (/^API error 503\b/.test(message) && /"disabled"/.test(message)) {
    return {
      kind: "disabled",
      message:
        "Memory is turned off in this engine's configuration ([memory] enabled = true turns it back on). The panel cannot read or maintain the store until then.",
    };
  }
  return { kind: "failed", message: formatError("Could not read memory", err) };
}
