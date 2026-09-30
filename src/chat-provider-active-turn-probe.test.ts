import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {},
  env: {
    language: "en",
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}));

import { ChatProvider } from "./chat-provider";

function turn(id: string, status: string, mode = "agent") {
  return {
    id,
    thread_id: "thread-1",
    status,
    mode,
    input_summary: "the question that started it",
    created_at: "2026-09-30T04:00:00Z",
    item_ids: [],
  };
}

function detailWith(turns: unknown[]) {
  return { thread: { id: "thread-1" }, turns, items: [], latest_seq: 7 };
}

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async () => ({ id: "thread-1" })),
    getThreadDetail: vi.fn(async () => detailWith([])),
    interruptTurn: vi.fn(async () => undefined),
    getThreadUsageBucket: vi.fn(async () => null),
    streamEvents: vi.fn(() => new AbortController()),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).startPeriodicTaskRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  // Every test here is about which of the three answers the probe acts on, so
  // the rebuild is observed rather than re-run — except in the one test that
  // has to see the rebuild reach the view, which restores it.
  const loadHistory = vi.spyOn(provider as any, "loadHistory").mockResolvedValue(0);

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
    { id: "a1", role: "assistant", content: "partial answer", status: "streaming", timestamp: 2, blocks: [] },
  ] as any;
  // A turn this view is holding: the id Stop would interrupt, the items still
  // being routed, a prompt it is waiting on, and the stream it is watching the
  // engine through.
  (provider as any).currentTurnId = "turn-1";
  (provider as any).activeItems.set("item-1", "assistant-a1");
  (provider as any).pendingApprovals.set("approval-1", { id: "approval-1" });
  (provider as any).eventController = new AbortController();

  return { provider, api, loadHistory, postMessage: provider.postMessage as any };
}

/** The probe as the webview really sends it: the handler's own switch, not the
 *  method behind it, so a message that stops being routed fails here. */
async function probe(provider: ChatProvider) {
  await (provider as any).handleWebviewMessage({ type: "probeActiveTurn" });
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

describe("ChatProvider's answer to the composer's stall probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts a turn the engine still holds, so the composer goes back to Stop", async () => {
    const { provider, api, loadHistory, postMessage } = createProvider();
    (api.getThreadDetail as any).mockResolvedValue(
      detailWith([turn("turn-1", "in_progress")]),
    );

    await probe(provider);

    // The engine was really asked — the probe is routed, and it is the engine's
    // own answer the composer follows.
    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    // The engine is still running it: the view holds the turn it already had,
    // re-armed with the deadline that brought it here.
    expect(messagesOfType(postMessage, "turnStarted")).toHaveLength(1);
    expect((provider as any).currentTurnId).toBe("turn-1");
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("rebuilds the conversation when the engine holds no turn for the thread", async () => {
    const { provider, api, loadHistory, postMessage } = createProvider();
    (api.getThreadDetail as any).mockResolvedValue(
      detailWith([turn("turn-1", "completed")]),
    );
    // The real rebuild this time: the seam that matters is that the view is
    // actually told, with the message a finished turn uses to release it.
    loadHistory.mockRestore();

    await probe(provider);

    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    // The turn this view was holding is over and its completion was lost with
    // the stream: nothing is invented for it — the conversation is rebuilt from
    // the engine, which is also what releases the composer — and everything the
    // dead turn left behind goes with it, prompts included.
    expect(messagesOfType(postMessage, "loadHistory")).toHaveLength(1);
    expect((provider as any).currentTurnId).toBeNull();
    expect((provider as any).activeTurnMode).toBeNull();
    expect((provider as any).activeItems.size).toBe(0);
    expect((provider as any).pendingApprovals.size).toBe(0);
    expect((provider as any).stopPeriodicTaskRefresh).toHaveBeenCalled();
    expect(messagesOfType(postMessage, "turnStarted")).toHaveLength(0);
  });

  it("answers nothing when the engine cannot be reached at all", async () => {
    const { provider, api, loadHistory, postMessage } = createProvider();
    (api.getThreadDetail as any).mockRejectedValue(new Error("connect ECONNREFUSED"));

    await probe(provider);

    // The question was asked and the engine could not answer it.
    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    // A read that failed says nothing about the turn — which is exactly what
    // this must not turn into "the turn is over", because that is how a running
    // conversation came to read as finished. The view keeps holding it and
    // gives the composer back on its own deadline.
    expect(postMessage).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect((provider as any).currentTurnId).toBe("turn-1");
  });

  it("does not act on an answer about a turn the user stopped while it was in flight", async () => {
    const { provider, api, loadHistory, postMessage } = createProvider();
    let answerTheProbe: (detail: unknown) => void = () => {};
    (api.getThreadDetail as any).mockReturnValue(
      new Promise((resolve) => { answerTheProbe = resolve; }),
    );

    const pending = probe(provider);
    // The read is a round trip, and the user acts inside it: Stop releases the
    // turn this view is holding before the engine's answer comes back.
    await provider.handleInterrupt();
    expect(messagesOfType(postMessage, "turnInterrupted")).toHaveLength(1);

    // The engine had not processed the interrupt when it answered, so what
    // comes back says the turn is still running — about a turn this client has
    // already let go of. Adopting it would re-arm the composer for a turn the
    // user just stopped, with Stop pointing at it again.
    answerTheProbe(detailWith([turn("turn-1", "in_progress")]));
    await pending;

    expect(messagesOfType(postMessage, "turnStarted")).toHaveLength(0);
    expect(loadHistory).not.toHaveBeenCalled();
    expect((provider as any).currentTurnId).toBeNull();
  });
});
