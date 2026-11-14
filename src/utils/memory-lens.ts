/**
 * Reading the engine's Context Lens, shared by `/memory` and the Memory panel.
 *
 * The Lens is the only read that shows a `candidate` (the model's proposal, or
 * a note nobody has reviewed yet) and the only one that says whether the caller
 * may review or forget — so both surfaces read it instead of reconstructing the
 * store from the flat `/v1/memory` listing.
 *
 * The walk is paged and the engine clamps one page to 100 entries. It lives
 * here once so the two surfaces cannot drift on the bound or on what a
 * truncated read means.
 */
import type { CodeWhaleApiClient, MemoryLensEntry, MemoryLensSnapshot } from "../types";

/** The engine clamps one Lens page to 100 entries. */
export const MEMORY_LENS_PAGE_SIZE = 100;

/** Pages a single read will walk before it stops and says so. A slash command
 *  must resolve an id against every entry, so it needs more than one page; the
 *  bound keeps that from turning into an unbounded read. */
export const MEMORY_LENS_MAX_PAGES = 5;

/** The one usage line both surfaces print. It lives here so a subcommand added
 *  to `/memory` is described in the slash command and in the panel's refusal
 *  message at the same time. */
export const MEMORY_USAGE =
  "Usage: /memory [show|pending|search <query>|get <id>|remember [global|workspace] <note>|approve <id>|reject <id>|forget <id>|clear [all|global|workspace]]";

/** The id characters a surface prints for a Lens entry.
 *
 *  Lens ids are UUIDs; the first few are enough to recognize an entry and, in
 *  the slash command, to type instead of all 36. */
export const MEMORY_LENS_ID_CHARS = 8;

export function memoryLensId(entry: MemoryLensEntry): string {
  return entry.memory.id.slice(0, MEMORY_LENS_ID_CHARS);
}

export interface MemoryLensRead {
  entries: MemoryLensEntry[];
  /** The page the walk ended on. Its capability flags are the caller's. */
  snapshot: MemoryLensSnapshot;
  /** True when the page bound stopped the walk before the store ended. */
  truncated: boolean;
}

/** Read the Lens, a page at a time.
 *
 *  `threadId` widens the read to the conversation's own session scope as well
 *  as the owner and workspace scopes the engine already grants; without it a
 *  memory that belongs to this conversation only would be invisible. */
export async function collectMemoryLens(
  api: CodeWhaleApiClient,
  opts?: { threadId?: string; maxPages?: number }
): Promise<MemoryLensRead> {
  const maxPages = Math.max(1, opts?.maxPages ?? MEMORY_LENS_MAX_PAGES);
  let snapshot = await api.getMemoryLens({
    threadId: opts?.threadId,
    limit: MEMORY_LENS_PAGE_SIZE,
  });
  const entries: MemoryLensEntry[] = [];
  for (let page = 0; ; page++) {
    entries.push(...snapshot.entries);
    if (!snapshot.next_after) return { entries, snapshot, truncated: false };
    if (page + 1 >= maxPages) return { entries, snapshot, truncated: true };
    snapshot = await api.getMemoryLens({
      threadId: opts?.threadId,
      limit: MEMORY_LENS_PAGE_SIZE,
      after: snapshot.next_after,
    });
  }
}
