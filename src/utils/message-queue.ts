/**
 * Per-thread message queue for the composer — the prompts the user parked
 * ("queue as memo") instead of sending, and chooses when to run (the panel's
 * ▶ per item, or `/queue run <n>`).
 *
 * TUI parity: this is the GUI's take on the TUI's composer queue
 * (`crates/tui/src/commands/groups/core/queue.rs`) — `/queue list|run|edit|
 * drop|clear` over parked prompts the user dispatches deliberately. The TUI
 * queue lives in App memory and dies with the session; the GUI one persists,
 * because a memo that "the user decides when to run" outlives window reloads.
 * Storage mirrors `input-history.ts` (same workspace hash keying): one JSON
 * file under ~/.codewhale/message-queue/ keyed per workspace, prompts keyed
 * per thread inside it.
 *
 * A prompt parked before the first send belongs to no thread yet; it is
 * stored under the DRAFT_QUEUE_KEY and migrates to the real thread id when
 * handleSendMessage creates that thread.
 */

import * as fs from "fs";
import * as path from "path";
import { workspaceHistoryKey } from "./input-history";

/** One parked prompt: what the user queued, when, and the attachments that
 *  rode with it. */
export interface QueuedPrompt {
  /** Stable identity the panel's buttons and the slash command address. */
  id: string;
  text: string;
  /** Epoch ms, stamped at enqueue time. Display-only; sorting stays
   *  insertion-ordered like the TUI's VecDeque, oldest first. */
  ts: number;
  /** Attachments parked with the prompt. Stored by path — the prompt
   *  re-reads the files when it runs, so the queue file stays small and a
   *  moved file degrades to a named miss instead of a stale copy. */
  attachments?: QueuedAttachment[];
}

/** The on-disk shape of one parked attachment: where the file lives, what
 *  to call it, and the kind that decides its prompt line
 *  (`[Attached image: …]` vs `@path`). No preview bytes — those are
 *  regenerated from the file when the memo is loaded back. */
export interface QueuedAttachment {
  path: string;
  name: string;
  kind: string;
}

/** The per-thread bucket prompts park into before any thread exists. */
export const DRAFT_QUEUE_KEY = ":draft";

/** Hard cap per thread, mirroring the spirit of the TUI stash's
 *  MAX_STASH_ENTRIES (200): a runaway enqueue loop cannot fill the disk.
 *  The oldest entries fall off at push time. */
export const MESSAGE_QUEUE_LIMIT = 50;

export type MessageQueueByThread = Record<string, QueuedPrompt[]>;

function queueDir(): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".codewhale",
    "message-queue"
  );
}

function queueFile(workspace: string): string {
  return path.join(queueDir(), `${workspaceHistoryKey(workspace)}.json`);
}

function newPromptId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeEntries(raw: unknown): QueuedPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is { id?: unknown; text?: unknown; ts?: unknown; attachments?: unknown } =>
        typeof e === "object" && e !== null
    )
    .filter((e) => typeof e.text === "string" && e.text.trim().length > 0)
    .map((e) => ({
      id: typeof e.id === "string" && e.id ? e.id : newPromptId(),
      text: (e.text as string).trim(),
      ts: typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : 0,
      attachments: normalizeAttachments(e.attachments),
    }));
}

/** Pre-attachment records (no field, or a non-array) read as "no
 *  attachments"; entries with only unusable rows keep the others. */
function normalizeAttachments(raw: unknown): QueuedAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kept = raw
    .filter(
      (a): a is Record<string, unknown> =>
        typeof a === "object" && a !== null &&
        typeof a.path === "string" && a.path.length > 0
    )
    .map((a) => ({
      path: a.path as string,
      name:
        typeof a.name === "string" && a.name
          ? a.name
          : (a.path as string).split("/").pop() || (a.path as string),
      kind: typeof a.kind === "string" && a.kind ? a.kind : "file",
    }));
  return kept.length > 0 ? kept : undefined;
}

/** Reads every thread's queue for a workspace. Empty map when nothing (or
 *  nothing parseable) is on disk — a corrupt file reads as "nothing parked",
 *  exactly like a corrupt input-history file. */
export function loadMessageQueue(workspace: string): MessageQueueByThread {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(queueFile(workspace), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const byThread: MessageQueueByThread = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entries = normalizeEntries(value);
      if (entries.length > 0) byThread[key] = entries;
    }
    return byThread;
  } catch {
    return {};
  }
}

function writeQueue(workspace: string, byThread: MessageQueueByThread): void {
  try {
    fs.mkdirSync(queueDir(), { recursive: true });
    fs.writeFileSync(queueFile(workspace), JSON.stringify(byThread));
  } catch {
    // A read-only or full disk leaves the session without a disk copy; the
    // in-memory behavior must not change because persistence failed.
  }
}

function loadThreadQueue(workspace: string, threadKey: string): QueuedPrompt[] {
  return loadMessageQueue(workspace)[threadKey] ?? [];
}

function saveThreadQueue(
  workspace: string,
  threadKey: string,
  entries: QueuedPrompt[]
): MessageQueueByThread {
  const byThread = loadMessageQueue(workspace);
  if (entries.length === 0) {
    delete byThread[threadKey];
  } else {
    byThread[threadKey] = entries;
  }
  writeQueue(workspace, byThread);
  return byThread;
}

/** Appends a prompt to a thread's queue (oldest first, TUI parity). Empty or
 *  whitespace-only text is dropped — parking nothing must not create an
 *  entry the panel then offers to run. Attachments ride along by path (an
 *  empty list parks as a plain prompt). Returns that thread's queue. */
export function enqueuePrompt(
  workspace: string,
  threadKey: string,
  text: string,
  attachments: QueuedAttachment[] = []
): QueuedPrompt[] {
  const trimmed = text.trim();
  if (!trimmed) return loadThreadQueue(workspace, threadKey);
  const entries = loadThreadQueue(workspace, threadKey);
  entries.push({
    id: newPromptId(),
    text: trimmed,
    ts: Date.now(),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  const overflow = entries.length - MESSAGE_QUEUE_LIMIT;
  if (overflow > 0) entries.splice(0, overflow);
  saveThreadQueue(workspace, threadKey, entries);
  return entries;
}

/** Removes one prompt by id. Returns the queue it left, or null when the id
 *  named nothing (the caller reports that rather than repainting a list
 *  nothing changed). */
export function dequeuePrompt(
  workspace: string,
  threadKey: string,
  id: string
): QueuedPrompt[] | null {
  const entries = loadThreadQueue(workspace, threadKey);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  entries.splice(idx, 1);
  saveThreadQueue(workspace, threadKey, entries);
  return entries;
}

/** Drops every parked prompt of a thread. Returns how many were dropped, so
 *  the caller can report it the way the TUI's `/stash clear` does. */
export function clearThreadQueue(workspace: string, threadKey: string): number {
  const dropped = loadThreadQueue(workspace, threadKey).length;
  if (dropped > 0) saveThreadQueue(workspace, threadKey, []);
  return dropped;
}

/** Moves a thread's parked prompts under another key — the draft bucket's
 *  migration onto the thread that first send created. The source key is
 *  removed, so the same memo cannot come back under both names. Returns the
 *  destination queue (empty when there was nothing to migrate). */
export function migrateThreadQueue(
  workspace: string,
  fromKey: string,
  toKey: string
): QueuedPrompt[] {
  if (fromKey === toKey) return loadThreadQueue(workspace, toKey);
  const moving = loadThreadQueue(workspace, fromKey);
  if (moving.length === 0) {
    saveThreadQueue(workspace, fromKey, []);
    return loadThreadQueue(workspace, toKey);
  }
  const destination = loadThreadQueue(workspace, toKey);
  const merged = [...destination, ...moving].slice(-MESSAGE_QUEUE_LIMIT);
  saveThreadQueue(workspace, fromKey, []);
  saveThreadQueue(workspace, toKey, merged);
  return merged;
}
