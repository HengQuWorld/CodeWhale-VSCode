/**
 * The Changes panel is told once per rebuild, not once per change.
 *
 * A rebuild re-reads every command in the conversation, and each answer
 * rewrites the panel's payload — which is the whole session, not a delta. A
 * few hundred of those went out while the transcript was still being built, so
 * the panel was handed the same growing list a few hundred times, and the
 * messages queued ahead of the conversation itself.
 *
 * The suppression is scoped to the rebuild. A single change — a revert, a
 * command starting — still reaches the panel immediately, because those are the
 * moments the reader is watching the panel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

function createHarness() {
  const api: Record<string, any> = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async () => ({ id: "thr_1" })),
    getThreadDetail: vi.fn(),
    streamEvents: vi.fn(() => ({ abort: () => undefined })),
    getCallChanges: vi.fn(),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  const posts: any[] = [];
  provider.postMessage = ((m: any) => { posts.push(m); return true; }) as any;
  (provider as any).debugLog = vi.fn();
  (provider as any).apiCapabilities = { callChanges: true };
  provider.currentThread = { id: "thr_1" } as any;

  const states = () => posts.filter((p) => p.type === "changesState");
  const record = (path: string) => {
    (provider as any).turnFileChanges = [
      ...(provider as any).turnFileChanges,
      { filePath: path, changeType: "modified", addedLines: 1, removedLines: 0 },
    ];
  };
  const refresh = () => (provider as any).refreshChangesPanel();
  return { provider, api, posts, states, record, refresh };
}

describe("the Changes panel during a rebuild", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is told once for a batch of them, not once per change", () => {
    const h = createHarness();

    (h.provider as any).beginChangesPanelBatch();
    for (let i = 0; i < 50; i++) {
      h.record(`src/file-${i}.ts`);
      h.refresh();
    }
    expect(h.states()).toHaveLength(0);

    (h.provider as any).endChangesPanelBatch();

    expect(h.states()).toHaveLength(1);
    // The one it gets is the state it would have ended with anyway: nothing
    // that happened inside the batch is lost by not narrating it.
    expect(h.states()[0].changes).toHaveLength(50);
  });

  it("still answers one change immediately outside a batch", () => {
    const h = createHarness();

    h.record("src/one.ts");
    h.refresh();

    // A revert or a command starting is the reader watching this panel; it
    // must not wait a turn of the loop for the news.
    expect(h.states()).toHaveLength(1);
    expect(h.states()[0].changes).toHaveLength(1);
  });

  it("says nothing at the end of a batch that changed nothing", () => {
    const h = createHarness();

    (h.provider as any).beginChangesPanelBatch();
    (h.provider as any).endChangesPanelBatch();

    // A rebuild that touched no changes has already had its state published;
    // a second identical payload is not an update.
    expect(h.states()).toHaveLength(0);
  });

  it("nests, so an inner batch does not publish under the outer one", () => {
    const h = createHarness();

    (h.provider as any).beginChangesPanelBatch();
    (h.provider as any).beginChangesPanelBatch();
    h.record("src/one.ts");
    h.refresh();
    (h.provider as any).endChangesPanelBatch();
    // Still inside the outer batch.
    expect(h.states()).toHaveLength(0);

    (h.provider as any).endChangesPanelBatch();
    expect(h.states()).toHaveLength(1);
  });

  it("publishes once the rebuild is over, before it is reported done", async () => {
    const h = createHarness();
    h.api.getThreadDetail.mockResolvedValue({
      thread: { id: "thr_1" },
      latest_seq: 0,
      turns: [],
      items: [],
    });

    await (h.provider as any).loadHistory("thr_1");

    const order = h.posts.map((p) => p.type);
    const state = order.indexOf("changesState");
    const status = order.lastIndexOf("status");
    expect(state).toBeGreaterThanOrEqual(0);
    // The panel holds the rebuilt state by the time the load says it is done:
    // a payload left to a timer would arrive after the reply that promised it.
    expect(state).toBeLessThan(status);
  });

  it("closes the batch when the rebuild fails, so the next one is not muted", async () => {
    const h = createHarness();
    h.api.getThreadDetail.mockResolvedValue({
      thread: { id: "thr_1" },
      latest_seq: 0,
      turns: [],
      items: [],
    });
    // Fail *inside* the rebuild — after the batch is open, which is the case a
    // read that rejects before it never exercises. The transcript post is the
    // first thing a rebuild sends that can blow up.
    const original = h.provider.postMessage as any;
    h.provider.postMessage = ((m: any) => {
      if (m.type === "loadHistory") throw new Error("view went away");
      return original(m);
    }) as any;

    await (h.provider as any).loadHistory("thr_1");
    expect((h.provider as any).changesPanelBatchDepth).toBe(0);

    // And the panel still answers the next change, which is what a leaked
    // batch would have stopped.
    h.provider.postMessage = original;
    const before = h.states().length;
    h.record("src/after.ts");
    h.refresh();
    expect(h.states()).toHaveLength(before + 1);
    expect(h.states()[h.states().length - 1].changes).toHaveLength(1);
  });
});
