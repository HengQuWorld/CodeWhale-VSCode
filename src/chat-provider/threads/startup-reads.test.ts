/**
 * Startup has to get the engine's own facts before it can reopen anything, but
 * those facts are independent of each other.
 *
 * They were read one after another, so the reader waited for the sum of their
 * round trips before the conversation could even be asked for. Started
 * together, the wait is the slowest one.
 *
 * The other half is what must *not* be waited on: the Sessions rail's list is
 * the whole stored history, and on a long one that is tens of megabytes — it
 * has nothing to do with the conversation being reopened.
 */
import { describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** An API whose reads only answer when the test says so. */
function createHarness() {
  const gates: Array<{ name: string; open: () => void }> = [];
  const gate = (name: string) =>
    new Promise<void>((resolve) => {
      gates.push({ name, open: resolve });
    });

  const api: Record<string, any> = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getWorkspaceStatus: vi.fn(async () => { await gate("workspaceStatus"); return { workspace: "/tmp/repo" }; }),
    getRuntimeInfo: vi.fn(async () => { await gate("runtimeInfo"); return { version: "1.0.0" }; }),
    probeRuntimeCapabilities: vi.fn(async () => { await gate("capabilities"); return {}; }),
    listThreads: vi.fn(async () => []),
    listSessions: vi.fn(async () => { await gate("sessions"); return { sessions: [] }; }),
    streamEvents: vi.fn(() => ({ abort: () => undefined })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).debugLog = vi.fn();
  (provider as any).postWorkspaceTrust = vi.fn();
  (provider as any).refreshProviders = vi.fn(async () => undefined);
  (provider as any).refreshGoal = vi.fn(async () => undefined);
  return { provider, api, gates };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the reads startup makes before it can reopen a conversation", () => {
  it("starts the engine's three reads together instead of one after another", async () => {
    const h = createHarness();

    void (h.provider as any).initializeThread();
    await settle();

    // All three were asked for before any of them answered: none of them needs
    // the others' answer, so queueing them put three round trips in series.
    const asked = h.gates.map((g) => g.name);
    expect(asked).toEqual(
      expect.arrayContaining(["workspaceStatus", "runtimeInfo", "capabilities"]),
    );

    for (const g of h.gates.splice(0)) g.open();
    await settle();
  });

  it("does not wait on the Sessions rail's list before reopening", async () => {
    const h = createHarness();

    let finished = false;
    const run = (h.provider as any).initializeThread().then(() => { finished = true; });
    await settle();

    // Everything except the session list has answered; the list is still open.
    for (const g of h.gates.splice(0)) {
      if (g.name !== "sessions") g.open();
    }
    // Give the initialization the turns it needs to reach its end.
    for (let i = 0; i < 5; i++) await settle();

    // The conversation is not held behind a list it does not need.
    expect(finished).toBe(true);
    // ...and that list was asked for, so the rail still fills in.
    expect(h.api.listSessions).toHaveBeenCalled();

    for (const g of h.gates.splice(0)) g.open();
    await run;
  });
});

describe("a handshake after the startup read", () => {
  function harness() {
    const api: Record<string, any> = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      getThread: vi.fn(async () => ({ id: "thr_1" })),
      getThreadDetail: vi.fn(async () => ({
        thread: { id: "thr_1" },
        latest_seq: 0,
        turns: [],
        items: [],
      })),
      listThreads: vi.fn(async () => []),
      listThreadsSummary: vi.fn(async () => []),
      listSessions: vi.fn(async () => ({ sessions: [] })),
      listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
      listAgentRuns: vi.fn(async () => ({ runs: [] })),
      listProviders: vi.fn(async () => ({ providers: [], current: null })),
      getRuntimeInfo: vi.fn(async () => ({ version: "1.0.0" })),
      probeRuntimeCapabilities: vi.fn(async () => ({})),
      getWorkspaceStatus: vi.fn(async () => ({ workspace: "/tmp/repo" })),
      getThreadGoal: vi.fn(async () => null),
      getThreadUsage: vi.fn(async () => null),
      streamEvents: vi.fn(() => ({ abort: () => undefined })),
    };
    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    (provider as any).debugLog = vi.fn();
    provider.currentThread = { id: "thr_1" } as any;
    return { provider, api };
  }

  it("does not rebuild what the view is already showing", async () => {
    const h = harness();

    // The startup read lands first — this is what the webview is displaying.
    await (h.provider as any).loadHistory("thr_1");
    const reads = h.api.getThreadDetail.mock.calls.length;
    const posts = (h.provider.postMessage as any).mock.calls.length;

    // ...and then the handshake arrives, for the same view.
    await (h.provider as any).syncWebviewState();

    // Nothing was re-read and nothing was re-sent: the transcript on screen is
    // the one this handshake found already there.
    expect(h.api.getThreadDetail.mock.calls.length).toBe(reads);
    expect(
      (h.provider.postMessage as any).mock.calls
        .slice(posts)
        .filter((c: any[]) => c[0]?.type === "loadHistory"),
    ).toHaveLength(0);
  });

  it("rebuilds for a view that has just loaded, which holds no DOM", async () => {
    const h = harness();
    await (h.provider as any).loadHistory("thr_1");
    const reads = h.api.getThreadDetail.mock.calls.length;

    // A reload announces itself, so the transcript it was delivered to is not
    // one this view has.
    (h.provider as any).webviewGeneration += 1;
    await (h.provider as any).syncWebviewState();

    expect(h.api.getThreadDetail.mock.calls.length).toBe(reads + 1);
  });

  it("rebuilds when the conversation on screen is not the one delivered", async () => {
    const h = harness();
    await (h.provider as any).loadHistory("thr_1");
    const reads = h.api.getThreadDetail.mock.calls.length;

    // Same view, different conversation — switching must redraw it.
    h.provider.currentThread = { id: "thr_2" } as any;
    await (h.provider as any).syncWebviewState();

    expect(h.api.getThreadDetail.mock.calls.length).toBe(reads + 1);
  });
});

describe("the session list read", () => {
  function harness() {
    let open: (() => void) | null = null;
    const api: Record<string, any> = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => {
        await new Promise<void>((resolve) => { open = resolve; });
        return { sessions: [] };
      }),
      streamEvents: vi.fn(() => ({ abort: () => undefined })),
    };
    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    (provider as any).debugLog = vi.fn();
    return { provider, api, release: () => open?.() };
  }

  it("answers a second ask from the read already in flight", async () => {
    const h = harness();

    const first = (h.provider as any).refreshSessionList();
    const second = (h.provider as any).refreshSessionList();
    await new Promise((r) => setTimeout(r, 0));

    // The startup read and the handshake that follows it ask the same
    // question; the engine was asked once.
    expect(h.api.listSessions).toHaveBeenCalledTimes(1);
    h.release();
    await Promise.all([first, second]);
  });

  it("reads again for a different question, and for the next one", async () => {
    const h = harness();

    const first = (h.provider as any).refreshSessionList();
    await new Promise((r) => setTimeout(r, 0));
    h.release();
    await first;

    // Once it has answered, a later ask is a new read — the store may have
    // changed while the view was away.
    const second = (h.provider as any).refreshSessionList();
    await new Promise((r) => setTimeout(r, 0));
    h.release();
    await second;
    expect(h.api.listSessions).toHaveBeenCalledTimes(2);

    // A different filter is a different question.
    (h.provider as any).showAllWorkspaces = true;
    const third = (h.provider as any).refreshSessionList();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api.listSessions).toHaveBeenCalledTimes(3);
    h.release();
    await third;
  });
});
