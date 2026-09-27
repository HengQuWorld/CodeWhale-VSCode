/**
 * Per-workspace persistence for the composer's input history — the entries
 * the ↑/↓ keys walk. The webview keeps its working copy in memory, so a
 * window reload empties it; this module is the disk copy the host owns.
 *
 * Stored under ~/.codewhale/input-history/ keyed by the same workspace hash
 * the engine uses for its runtime store (see engine.ts workspaceStoreKey),
 * so a window reopening a workspace comes back to the history it wrote.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

/** Same shape as the webview's in-memory list: newest first. */
export const INPUT_HISTORY_LIMIT = 200;

/** A stable directory name per workspace (engine.ts keeps its own copy for
 *  the runtime store; the convention, not the helper, is the shared thing). */
export function workspaceHistoryKey(workspace: string): string {
  if (!workspace) return "no-workspace";
  return `ws-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`;
}

function historyDir(): string {
  return path.join(process.env.HOME || process.env.USERPROFILE || ".", ".codewhale", "input-history");
}

function historyFile(workspace: string): string {
  return path.join(historyDir(), `${workspaceHistoryKey(workspace)}.json`);
}

/** Reads the stored list for a workspace. Newest first; empty when nothing
 *  (or nothing parseable) is on disk — a corrupt file is not worth failing
 *  the panel over, it just reads as "no history yet". */
export function loadInputHistory(workspace: string): string[] {
  try {
    const raw = fs.readFileSync(historyFile(workspace), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .slice(0, INPUT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Prepends an entry and writes the list back — the exact mirror of the
 *  webview's in-memory unshift + cap, so the disk copy and the copy ↑/↓ walk
 *  cannot drift apart. Returns the resulting list. */
export function pushInputHistory(workspace: string, text: string): string[] {
  const entry = text.trim();
  if (!entry) return loadInputHistory(workspace);
  const list = loadInputHistory(workspace);
  list.unshift(entry);
  const capped = list.slice(0, INPUT_HISTORY_LIMIT);
  try {
    fs.mkdirSync(historyDir(), { recursive: true });
    fs.writeFileSync(historyFile(workspace), JSON.stringify(capped));
  } catch {
    // A read-only or full disk leaves the session without a disk copy; the
    // in-memory behavior must not change because persistence failed.
  }
  return capped;
}
