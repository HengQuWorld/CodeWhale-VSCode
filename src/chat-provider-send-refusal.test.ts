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

/** The engine's refusal verbatim: runtime_threads.rs `start_turn` bails with
 *  "Thread already has an active turn" and `map_thread_err` answers 409. */
const BUSY_REFUSAL = "API error 409: Thread already has an active turn";

function turn(id: string, status: string, mode = "agent") {
  return { id, thread_id: "thread-1", status, mode };
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
    startTurn: vi.fn(),
    interruptTurn: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => new AbortController()),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).startPeriodicTaskRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "u0", role: "user", content: "earlier", status: "complete", timestamp: 1 },
    { id: "a0", role: "assistant", content: "earlier answer", status: "complete", timestamp: 2 },
  ] as any;
  // A thread the user is viewing already has a live stream; adopting a turn
  // must not open a second one over it.
  (provider as any).eventController = new AbortController();

  return { provider, api, postMessage: provider.postMessage as any };
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

async function sendRefused(provider: any, api: any, text: string, turns: unknown[]) {
  (api.getThreadDetail as any).mockResolvedValue(detailWith(turns));
  api.startTurn.mockRejectedValue(new Error(BUSY_REFUSAL));
  await provider.handleSendMessage(text);
}

describe("ChatProvider send refused for the thread's active turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts the running turn so the composer's Stop button can interrupt it", async () => {
    const { provider, api, postMessage } = createProvider();

    await sendRefused(provider, api, "carry on then", [turn("turn-running", "in_progress", "plan")]);

    // No error banner: the refusal names a state, so the report names the way
    // out of it instead of repeating the engine's sentence.
    expect(messagesOfType(postMessage, "error")).toEqual([]);
    const info = messagesOfType(postMessage, "info");
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain("Stop");

    // The prompt was never accepted: its bubble is retracted and its text
    // handed back rather than left claiming the thread holds that message.
    expect(provider.messages.some((m: any) => m.role === "user" && m.content === "carry on then")).toBe(
      false
    );
    expect(provider.messages.map((m: any) => m.id)).toEqual([
      "u0",
      "a0",
      expect.stringMatching(/^assistant-/),
    ]);
    expect(messagesOfType(postMessage, "removeMessage")).toHaveLength(1);
    expect(messagesOfType(postMessage, "setInputText")).toEqual([
      { type: "setInputText", text: "carry on then" },
    ]);

    // The turn is this client's now: the id is what makes Stop real, and it is
    // also what stops SSE dropping the turn's own events as stale.
    expect((provider as any).currentTurnId).toBe("turn-running");
    expect((provider as any).activeTurnMode).toEqual({ turnId: "turn-running", mode: "plan" });
    expect(messagesOfType(postMessage, "turnStarted")).toEqual([
      { type: "turnStarted", turnId: "turn-running" },
    ]);

    await provider.handleInterrupt();
    expect(api.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-running");
  });

  it("does not open a second stream over one already delivering the turn", async () => {
    const { provider, api } = createProvider();

    await sendRefused(provider, api, "hello", [turn("turn-running", "in_progress")]);

    expect(api.streamEvents).not.toHaveBeenCalled();
  });

  it("opens a stream when there is none, or the adopted turn would never report completion", async () => {
    const { provider, api } = createProvider();
    (provider as any).eventController = null;
    // Resuming uses the cursor this client processed, like every other
    // subscribe — not the detail's latest seq. Jumping the cursor forward is
    // what `loadHistory` does after rebuilding the transcript from the store;
    // nothing here rebuilds it, so the events between the two are ours to read.
    (provider as any).lastEventSeq = 3;

    await sendRefused(provider, api, "hello", [turn("turn-running", "in_progress")]);

    expect(api.streamEvents).toHaveBeenCalledWith(
      "thread-1",
      3,
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("hands the attachments back too — a refused send carried them nowhere", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentAttachments = [
      { id: "att-1", kind: "image", path: "/tmp/shot.png", name: "shot.png" },
    ];

    await sendRefused(provider, api, "look at this", [turn("turn-running", "in_progress")]);

    const lists = messagesOfType(postMessage, "attachmentsChanged");
    // The send emptied the composer; the recovery republishes what it took.
    expect(lists[0].attachments).toEqual([]);
    expect(lists[lists.length - 1].attachments).toMatchObject([{ id: "att-1" }]);
    // The typed text comes back without the attachment placeholder lines.
    expect(messagesOfType(postMessage, "setInputText")).toEqual([
      { type: "setInputText", text: "look at this" },
    ]);
  });

  it("reports the refusal when the turn ended in between, with the text already back", async () => {
    const { provider, api, postMessage } = createProvider();

    await sendRefused(provider, api, "second thought", [turn("turn-done", "completed")]);

    const errors = messagesOfType(postMessage, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("already has an active turn");
    // Nothing is left to stop, so no Stop button is offered — but the refusal
    // must not cost the user their instruction either.
    expect(messagesOfType(postMessage, "turnStarted")).toEqual([]);
    expect(messagesOfType(postMessage, "info")).toEqual([]);
    expect((provider as any).currentTurnId).toBeNull();
    expect(messagesOfType(postMessage, "setInputText")).toEqual([
      { type: "setInputText", text: "second thought" },
    ]);
  });

  it("leaves the other 409s on the error path", async () => {
    const { provider, api, postMessage } = createProvider();
    api.startTurn.mockRejectedValue(
      new Error("API error 409: No active turn on thread thread-1")
    );

    await (provider as any).handleSendMessage("hello");

    expect(messagesOfType(postMessage, "error")).toHaveLength(1);
    expect(api.getThreadDetail).not.toHaveBeenCalled();
  });

  it("needs the 409 status, not just the phrase", async () => {
    const { provider, api, postMessage } = createProvider();
    api.startTurn.mockRejectedValue(new Error("Thread already has an active turn"));

    await (provider as any).handleSendMessage("hello");

    expect(messagesOfType(postMessage, "error")).toHaveLength(1);
    expect(api.getThreadDetail).not.toHaveBeenCalled();
  });
});

describe("ChatProvider Stop without a known turn id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reaches a turn this client never started", async () => {
    const { provider, api } = createProvider();
    (api.getThreadDetail as any).mockResolvedValue(
      detailWith([turn("turn-elsewhere", "in_progress")])
    );

    await provider.handleInterrupt();

    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    expect(api.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-elsewhere");
  });

  it("does not invent a turn to interrupt", async () => {
    const { provider, api, postMessage } = createProvider();
    (api.getThreadDetail as any).mockResolvedValue(detailWith([turn("turn-done", "completed")]));

    await provider.handleInterrupt();

    expect(api.interruptTurn).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "turnInterrupted")).toHaveLength(1);
  });

  it("keeps clearing the view when the read itself fails", async () => {
    const { provider, api, postMessage } = createProvider();
    (api.getThreadDetail as any).mockRejectedValue(new Error("engine is not running"));

    await provider.handleInterrupt();

    expect(api.interruptTurn).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "turnInterrupted")).toHaveLength(1);
  });

  it("prefers the turn it already knows over reading the thread back", async () => {
    const { provider, api } = createProvider();
    (provider as any).currentTurnId = "turn-mine";

    await provider.handleInterrupt();

    expect(api.getThreadDetail).not.toHaveBeenCalled();
    expect(api.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-mine");
  });
});

describe("ChatProvider Changes panel across a send", () => {
  /** The last Changes payload the provider published. */
  function lastChanges(postMessage: ReturnType<typeof vi.fn>): any {
    const payloads = messagesOfType(postMessage, "changesState");
    expect(payloads.length).toBeGreaterThan(0);
    return payloads[payloads.length - 1];
  }

  /** A session whose first turn already recorded a change to src/first.ts. */
  function withAnEarlierTurn(provider: any): void {
    provider.beginChangeTurn("earlier prompt", 1);
    provider.appendFileChange({
      filePath: "src/first.ts",
      changeType: "modified",
      addedLines: 2,
      removedLines: 1,
      diff: "diff --git a/src/first.ts b/src/first.ts",
    });
  }

  it("keeps the earlier turn's changes when the next turn starts", async () => {
    const { provider, api, postMessage } = createProvider();
    withAnEarlierTurn(provider);
    api.startTurn.mockResolvedValue({ turn: { id: "turn-2" }, thread: { id: "thread-1" } });

    await (provider as any).handleSendMessage("carry on");

    // The new turn's own change, recorded the way a detected one arrives.
    (provider as any).appendFileChange({
      filePath: "src/second.ts",
      changeType: "created",
      addedLines: 3,
      removedLines: 0,
      diff: "diff --git a/src/second.ts b/src/second.ts",
    });
    (provider as any).refreshChangesPanel();

    const payload = lastChanges(postMessage);
    // Both turns, not just the newest: this is the report the panel was fixed
    // for — sending a message used to wipe everything the session had changed.
    expect(payload.changes.map((c: any) => c.filePath)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2]);
    expect(payload.turns.map((t: any) => t.label)).toEqual(["earlier prompt", "carry on"]);
  });

  it("leaves no change section for a prompt the engine refused", async () => {
    const { provider, api, postMessage } = createProvider();
    withAnEarlierTurn(provider);

    await sendRefused(provider, api, "carry on then", [turn("turn-running", "in_progress")]);
    (provider as any).refreshChangesPanel();

    // The refused prompt is not a turn of this session: it must not stand as a
    // section header labelled with text the user was handed back.
    const payload = lastChanges(postMessage);
    expect(payload.turns.map((t: any) => t.label)).toEqual(["earlier prompt"]);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1]);
  });
});
