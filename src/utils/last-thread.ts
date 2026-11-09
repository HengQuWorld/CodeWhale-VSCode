/**
 * Which thread a workspace last had open — the one piece of state a window
 * forgets on reopen that the composer's parked memos (and the conversation
 * itself) need back. The host reopens that thread at startup, so a memo
 * queued yesterday greets you today instead of hiding behind an empty
 * new-chat view until the next send.
 *
 * Stored per workspace under ~/.codewhale/last-thread/, keyed the same way
 * the engine keys its runtime store (see input-history.ts), because the
 * thread id only means something to the engine behind that workspace.
 */

import * as fs from "fs";
import * as path from "path";
import { workspaceHistoryKey } from "./input-history";

function lastThreadFile(workspace: string): string {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".codewhale",
    "last-thread",
    `${workspaceHistoryKey(workspace)}.json`
  );
}

/** The thread id this workspace last had open, or null when nothing (or
 *  nothing readable) is recorded — a corrupt file reads as "no thread to
 *  reopen", the same way a corrupt history file reads as no history. */
export function loadLastThreadId(workspace: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(lastThreadFile(workspace), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const id = (parsed as { threadId?: unknown }).threadId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Records the thread this workspace now has open. A view with no thread
 *  (new chat, viewed saved session) clears the record: reopening should
 *  come back to exactly what was on screen, not to a thread the user had
 *  already left. */
export function saveLastThreadId(workspace: string, threadId: string | null): void {
  try {
    const file = lastThreadFile(workspace);
    if (!threadId) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ threadId }));
  } catch {
    // Persistence is best-effort: a read-only disk loses the reopen
    // convenience, nothing else.
  }
}
