import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** The Sessions rail's archive toggle, from the extension's side.
 *
 *  Archiving is not rare — the session store caps active transcripts at 50 and
 *  archives the rest — so a workspace whose sessions have all aged out listed
 *  as empty and its history could not be searched. The rail now has a toggle;
 *  these tests pin what the two states ask the engine for, that the filter the
 *  rows arrive under is the filter they were asked for, and that a search in
 *  the box survives the switch instead of being replaced by the whole store.
 */
function createProvider() {
  const api = {
    // The constructor binds the client to the engine before anything else.
    bindEngine: vi.fn(),
    // Every listing answers with what it was asked for; these tests are about
    // the query, not the rows.
    listSessions: vi.fn(async (_opts?: Record<string, unknown>) => ({ sessions: [] })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return { provider, api, posted: provider.postMessage as any };
}

function toggle(provider: ChatProvider, msg: Record<string, unknown> = {}) {
  return (provider as any).handleWebviewMessage({ type: "toggleArchivedSessions", ...msg });
}

/** A listing whose answer the test decides, so two of them can be in flight at
 *  once and finish in the order a quick double click produces. */
function deferredListing() {
  let resolve!: (value: { sessions: Array<Record<string, unknown>> }) => void;
  const promise = new Promise<{ sessions: Array<Record<string, unknown>> }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sessionRow(id: string, archived: boolean) {
  return {
    id,
    title: id,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    message_count: 4,
    total_tokens: 0,
    model: "deepseek-v4-pro",
    workspace: "/w",
    mode: "agent",
    ...(archived ? { archived: true } : {}),
  };
}

describe("Sessions rail archive filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the engine for archived records once the toggle is on", async () => {
    const { provider, api, posted } = createProvider();

    await toggle(provider);

    // The engine hides archived sessions unless `include_archived` asks, so a
    // client-side filter could not have shown them at all.
    expect(api.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true })
    );
    // Archived records outnumber active ones on a long-lived store: the
    // active-only limit would cut the view off partway.
    expect(api.listSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
    // The rail takes the filter state back with the rows, so a dimmed toggle
    // and a list that includes archived rows cannot describe each other.
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessionList", showArchivedSessions: true })
    );
  });

  it("goes back to the active-only query when toggled off", async () => {
    const { provider, api, posted } = createProvider();

    await toggle(provider);
    await toggle(provider);

    const lastCall = api.listSessions.mock.calls.at(-1)![0];
    expect(lastCall).toEqual({ limit: 100 });
    expect(posted).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sessionList", showArchivedSessions: false })
    );
  });

  it("answers the click with the new filter before the listing comes back", async () => {
    const { provider, posted } = createProvider();
    const listing = deferredListing();
    (provider as any).api.listSessions = vi.fn(() => listing.promise);

    const click = toggle(provider);

    // The fetch can take a while and can fail; the toggle must not sit in its
    // old state until rows arrive, or the click reads as one that missed.
    expect(posted).toHaveBeenCalledWith({
      type: "sessionFilterState",
      showAllWorkspaces: false,
      showArchivedSessions: true,
    });

    listing.resolve({ sessions: [] });
    await click;
  });

  it("publishes rows under the filter they were queried with when two clicks overlap", async () => {
    const { provider, posted } = createProvider();
    const archivedListing = deferredListing();
    const activeListing = deferredListing();
    const api = (provider as any).api.listSessions as ReturnType<typeof vi.fn>;
    api.mockReturnValueOnce(archivedListing.promise);
    api.mockReturnValueOnce(activeListing.promise);

    // Two clicks with the first listing still in flight. VS Code does not
    // serialize messages, so both are running and either can answer first.
    const on = toggle(provider);
    const off = toggle(provider);

    // The "off" answer lands first, then the stale "on" one — the order that
    // used to paint archived rows under a dimmed toggle.
    activeListing.resolve({ sessions: [sessionRow("live", false)] });
    await off;
    archivedListing.resolve({ sessions: [sessionRow("live", false), sessionRow("old", true)] });
    await on;

    const lists = posted.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .filter((msg: Record<string, unknown>) => msg.type === "sessionList");
    // One publisher: the pass that owns the rail. The stale answer is dropped
    // rather than painted with a filter it was not asked for.
    expect(lists).toHaveLength(1);
    expect(lists[0].showArchivedSessions).toBe(false);
    expect((lists[0].sessions as Array<Record<string, unknown>>).map((s) => s.id)).toEqual([
      "live",
    ]);
  });

  it("re-runs the search in the box rather than replacing it with the whole store", async () => {
    const { provider, api } = createProvider();

    await toggle(provider, { query: "deploy" });

    // One listing, carrying both the query and the wider archive scope: the
    // box and the rows keep describing the same thing.
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ search: "deploy", includeArchived: true })
    );
  });

  it("ignores a blank query and lists without a search", async () => {
    const { provider, api } = createProvider();

    await toggle(provider, { query: "   " });

    const opts = api.listSessions.mock.calls[0][0]!;
    expect(opts.search).toBeUndefined();
  });
});
