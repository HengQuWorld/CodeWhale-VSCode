import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
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

function createProvider() {
  const thread = { id: "thread-1", model: "deepseek-v4-pro", mode: "agent" };
  // Every SSE stream the provider opens, so a test can see which conversation
  // it is still watching after a switch.
  const streams: Array<{ threadId: string; sinceSeq: number }> = [];
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    forkThreadAtTurn: vi.fn(),
    patchUndoThreadTurn: vi.fn(),
    retryThreadTurn: vi.fn(),
    getThreadDetail: vi.fn(),
    getSession: vi.fn(),
    resumeSessionThread: vi.fn(),
    // For the live path: a sent turn, so a completion can be replayed.
    startTurn: vi.fn(async () => ({ thread, turn: { id: "turn-1" } })),
    getThread: vi.fn(async () => thread),
    interruptTurn: vi.fn(async () => undefined),
    updateThread: vi.fn(async () => thread),
    getThreadGoal: vi.fn(async () => null),
    listThreadsSummary: vi.fn(async () => ({ threads: [] })),
    streamEvents: vi.fn((threadId: string, sinceSeq: number) => {
      streams.push({ threadId, sinceSeq });
      return { abort: vi.fn() };
    }),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  (provider as any).loadThread = vi.fn(async () => undefined);
  (provider as any).apiCapabilities.threadForkAtTurn = true;

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "user-turn_1", role: "user", content: "first", status: "complete", timestamp: 1 },
    { id: "assistant-turn_1", role: "assistant", content: "one", status: "complete", timestamp: 2 },
  ] as any;

  return { provider, api, streams, postMessage: provider.postMessage as any };
}

describe("ChatProvider fork-from-turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("branches at the named turn and hands the dropped prompt back", async () => {
    const { provider, api, postMessage } = createProvider();
    api.forkThreadAtTurn.mockResolvedValue({
      thread: { id: "thread-2" },
      original_user_text: "second question",
    });

    await provider.handleForkFromTurn("turn_2");

    // The anchor travels as the engine's own turn id — the GUI never converts
    // it to a depth, because the transcript it renders is not the turn list
    // the engine cuts.
    expect(api.forkThreadAtTurn).toHaveBeenCalledWith("thread-1", "turn_2");
    expect(provider.currentThread).toEqual({ id: "thread-2" });
    expect(provider.messages).toEqual([]);
    expect((provider as any).loadThread).toHaveBeenCalledWith("thread-2");
    expect(postMessage).toHaveBeenCalledWith({ type: "setInputText", text: "second question" });
    expect(postMessage).toHaveBeenCalledWith({ type: "historyUpdated" });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("stops writing to the source document when the fork inherits its session id", async () => {
    // The data-loss case: `PUT /v1/sessions` replaces the stored transcript, so
    // a fork that keeps the source's session id would have its shorter history
    // written over the conversation it was cut from, leaving that conversation
    // unloadable. The binding has to be dropped.
    const { provider, api } = createProvider();
    (provider as any).sessionState.data.currentSessionId = "sess-shared";
    (provider as any).loadThread = vi.fn(async () => {
      // What a runtime that predates fork-owns-its-document hands back.
      (provider as any).currentSessionId = "sess-shared";
    });
    api.forkThreadAtTurn.mockResolvedValue({
      thread: { id: "thread-2" },
      original_user_text: "second question",
    });

    await provider.handleForkFromTurn("turn_2");

    expect((provider as any).currentSessionId).toBeNull();
  });

  it("keeps the fork's own document when the runtime minted one", async () => {
    const { provider, api } = createProvider();
    (provider as any).sessionState.data.currentSessionId = "sess-source";
    (provider as any).loadThread = vi.fn(async () => {
      (provider as any).currentSessionId = "sess-fork";
    });
    api.forkThreadAtTurn.mockResolvedValue({
      thread: { id: "thread-2" },
      original_user_text: null,
    });

    await provider.handleForkFromTurn("turn_2");

    expect((provider as any).currentSessionId).toBe("sess-fork");
  });

  it("does not offer the branch when the engine has no fork-at-turn route", async () => {
    // A runtime that only forks the last turn would cut at the wrong place and
    // still answer 201, so the action is not attempted at all.
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.threadForkAtTurn = false;

    await provider.handleForkFromTurn("turn_2");

    expect(api.forkThreadAtTurn).not.toHaveBeenCalled();
    expect(provider.currentThread).toEqual({ id: "thread-1" });
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("fork-at-turn"),
    });
  });

  it("branches while the thread is mid-turn, and interrupts nothing", async () => {
    // A turn going the wrong way is exactly when a person wants a branch, and
    // taking one must not stop that turn: the runtime owns it, and the view
    // parks the source instead of interrupting it.
    const { provider, api, postMessage } = createProvider();
    api.getThreadDetail.mockResolvedValue({
      turns: [{ id: "turn_2", status: "in_progress" }],
    });
    api.forkThreadAtTurn.mockResolvedValue({
      thread: { id: "thread-2" },
      original_user_text: "the question that turn is answering",
    });

    await provider.handleForkFromTurn("turn_1");

    expect(api.forkThreadAtTurn).toHaveBeenCalledWith("thread-1", "turn_1");
    expect(api.interruptTurn).not.toHaveBeenCalled();
    expect(provider.currentThread).toEqual({ id: "thread-2" });
    // The turn that is still running comes back to the composer as the place
    // to continue from, and the source conversation is left running.
    expect(postMessage).toHaveBeenCalledWith({
      type: "setInputText",
      text: "the question that turn is answering",
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("leaves a watch on the source conversation it branches away from", async () => {
    // Parking is what keeps a still-running source's badge, completion and
    // auto-save alive while this view is elsewhere. Parked before the switch,
    // because parkCurrentThread reads whatever currentThread names.
    const { provider, api, streams } = createProvider();
    (provider as any).currentTurnId = "turn_2";
    (provider as any).lastEventSeq = 42;
    (provider as any).loadThread = vi.fn(async () => {
      (provider as any).currentThread = { id: "thread-2" };
    });
    api.forkThreadAtTurn.mockResolvedValue({
      thread: { id: "thread-2" },
      original_user_text: null,
    });

    await provider.handleForkFromTurn("turn_1");

    const parked = (provider as any).backgroundThreads.get("thread-1");
    expect(parked?.running).toBe(true);
    expect(parked?.currentTurnId).toBe("turn_2");
    expect(streams.some((s: any) => s.threadId === "thread-1")).toBe(true);
  });

  it("reports an unusable anchor as guidance, not as a failure", async () => {
    const { provider, api, postMessage } = createProvider();
    api.forkThreadAtTurn.mockRejectedValue(
      new Error(
        "API error 400: fork_at_user_turn: turn turn_9 is not a user turn of thread thread-1"
      )
    );

    await provider.handleForkFromTurn("turn_9");

    expect(provider.currentThread).toEqual({ id: "thread-1" });
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("no longer a branch point"),
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
  it("opens a viewed session as a live conversation without sending anything", async () => {
    // A branch names a turn, and turns only exist on a live thread: this is the
    // step that turns a browsed recording into something branchable — and it
    // must not pretend to be a message.
    const { provider, api, postMessage } = createProvider();
    provider.currentThread = null;
    (provider as any).viewingSessionId = "sess-1";
    api.getSession.mockResolvedValue({
      metadata: { id: "sess-1", cost: { session_cost_usd: 0.5 } },
    });
    api.resumeSessionThread.mockResolvedValue({ thread_id: "thread-9" });

    await provider.handleContinueSession();

    expect(api.resumeSessionThread).toHaveBeenCalledWith("sess-1");
    expect((provider as any).loadThread).toHaveBeenCalledWith("thread-9");
    expect((provider as any).viewingSessionId).toBeNull();
    // The session's own document is the one the resumed thread keeps saving to.
    expect((provider as any).currentSessionId).toBe("sess-1");
    expect(api.forkThreadAtTurn).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("live conversation"),
    });
    // It takes a moment, like the other conversation-replacing actions.
    expect(postMessage).toHaveBeenCalledWith({ type: "hostOperation", active: false });
  });

  it("has nothing to continue when a live thread is on screen", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.handleContinueSession();

    expect(api.resumeSessionThread).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("No saved session"),
    });
  });

  it("says it is working while the fork is created, and holds the composer", async () => {
    // Creating a fork takes seconds and streams nothing: without this the click
    // is answered by a still screen. The composer is told why it is holding its
    // send — the fork is about to replace which conversation it belongs to.
    const { provider, api, postMessage } = createProvider();
    let settle: (value: { thread: { id: string }; original_user_text: string | null }) => void =
      () => {};
    api.forkThreadAtTurn.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; })
    );

    const inFlight = provider.handleForkFromTurn("turn_2");
    // The wait is announced once the refusal checks are behind us; wait for the
    // request itself rather than counting microtasks.
    await vi.waitFor(() => expect(api.forkThreadAtTurn).toHaveBeenCalled());

    expect(postMessage).toHaveBeenCalledWith({
      type: "hostOperation",
      active: true,
      label: expect.stringContaining("Branching"),
      hint: expect.stringContaining("sending waits"),
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "status",
      text: expect.stringContaining("Branching"),
    });

    settle({ thread: { id: "thread-2" }, original_user_text: "second question" });
    await inFlight;

    expect(postMessage).toHaveBeenCalledWith({ type: "hostOperation", active: false });
  });

  it("releases the composer when the fork fails", async () => {
    const { provider, api, postMessage } = createProvider();
    api.forkThreadAtTurn.mockRejectedValue(new Error("API error 500: boom"));

    await provider.handleForkFromTurn("turn_2");

    expect(postMessage).toHaveBeenCalledWith({ type: "hostOperation", active: false });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("ignores a second click while the first fork is still running", async () => {
    // Two forks would be two new threads cut from a source the person has
    // already left, and the second would overwrite the first on screen.
    const { provider, api, postMessage } = createProvider();
    let settle: (value: { thread: { id: string }; original_user_text: string | null }) => void =
      () => {};
    api.forkThreadAtTurn.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; })
    );

    const first = provider.handleForkFromTurn("turn_2");
    await Promise.resolve();
    await Promise.resolve();
    await provider.handleForkFromTurn("turn_2");

    expect(api.forkThreadAtTurn).toHaveBeenCalledTimes(1);

    settle({ thread: { id: "thread-2" }, original_user_text: null });
    await first;
    expect(provider.currentThread).toEqual({ id: "thread-2" });
    expect(postMessage).toHaveBeenCalledWith({ type: "hostOperation", active: false });
  });

  it("says why it will not start a second swap, and starts nothing", async () => {
    // The other operation is already holding the conversation: beginning this
    // one would have it replace what the first is swapping away from.
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.threadPatchUndo = true;
    let settle: (value: { thread: { id: string }; original_user_text: string | null }) => void =
      () => {};
    api.forkThreadAtTurn.mockImplementation(
      () => new Promise((resolve) => { settle = resolve; })
    );

    const first = provider.handleForkFromTurn("turn_1");
    await vi.waitFor(() => expect(api.forkThreadAtTurn).toHaveBeenCalled());

    await provider.handleUndoLastTurn();

    expect(api.forkThreadAtTurn).toHaveBeenCalledTimes(1);
    expect(api.patchUndoThreadTurn).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("still finishing"),
    });

    settle({ thread: { id: "thread-2" }, original_user_text: null });
    await first;
  });

  it("offers the branch point as soon as a turn sent here finishes", async () => {
    // A turn sent in this session has no id until it completes, so the row can
    // only be handed over with the finalize message. Without it, the turns a
    // person just watched would offer nowhere to branch until the conversation
    // was reopened — the case where branching is most wanted.
    const { provider, postMessage } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "sendMessage", text: "the question" });
    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "item.delta",
      turn_id: "turn-1",
      item_id: "i1",
      payload: { kind: "agent_message", delta: "an answer" },
    } as any);
    (provider as any).handleRuntimeEvent({
      seq: 3,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    } as any);

    const completion = (postMessage as any).mock.calls
      .map(([msg]: [Record<string, unknown>]) => msg)
      .find((msg: Record<string, unknown>) => msg?.type === "messageComplete");
    expect(completion?.branchTurnId).toBe("turn-1");
    // And the same anchor is on the message the host keeps, so a later reload
    // of this transcript agrees with the row it just drew.
    expect(provider.messages.some((m) => m.branchTurnId === "turn-1")).toBe(true);
  });
});
