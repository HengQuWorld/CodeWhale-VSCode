/**
 * The thread → session binding belongs to the runtime, and every path that
 * opens a thread has to read it off the record.
 *
 * `PUT /v1/sessions` updates the session it is handed *in place*. A client that
 * saves a thread without a session id is asking the runtime to create one, so
 * the same conversation accumulates a document per visit and the previous one
 * is left behind with nothing referencing it: one real store held 122 sessions
 * for 64 bound threads, 58 of them unreferenced, with a single conversation
 * spread across eight documents (390 → 438 → … → 753 messages).
 *
 * The same binding decides which document a *parked* thread keeps writing to,
 * and — because a resume may hand back a thread that already exists — whether
 * the client is entitled to rename it.
 */
import { describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  configGet: vi.fn((_key: string, fallback?: unknown) => fallback),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vscodeMock.configGet,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
  },
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "./chat-provider";
import type { ThreadRecord } from "./types";

function makeThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    model: "deepseek-v4-pro",
    workspace: "/tmp/repo",
    mode: "agent",
    allow_shell: false,
    trust_mode: false,
    auto_approve: false,
    latest_turn_id: null,
    archived: false,
    ...overrides,
  };
}

const CAPABILITIES = {
  saveSession: true,
  threadUndo: true,
  threadPatchUndo: true,
  threadRetry: true,
  turnSteer: true,
  snapshotList: true,
  snapshotRestore: true,
  threadUsage: true,
  threadFileRevert: true,
};

function createHarness() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getWorkspaceStatus: vi.fn(async () => ({ workspace: "/tmp/repo" })),
    getThread: vi.fn(async (id: string) => makeThread(id)),
    getThreadDetail: vi.fn(async (id: string) => ({
      thread: makeThread(id),
      latest_seq: 0,
      turns: [],
      items: [],
    })),
    getThreadGoal: vi.fn(async () => null),
    listThreads: vi.fn(async () => [] as ThreadRecord[]),
    listThreadsSummary: vi.fn(async () => []),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    listProviders: vi.fn(async () => ({ providers: [], current: null })),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
    resumeSessionThread: vi.fn(async () => ({
      thread_id: "thread-resumed",
      session_id: "sess-1",
      message_count: 0,
      summary: "Resumed session 'One' (4 messages)",
      created: false,
    })),
    patchUndoThreadTurn: vi.fn(async () => ({
      thread: makeThread("thread-fork"),
      patch_result: { summary: null },
      original_user_text: "carry on",
    })),
    retryThreadTurn: vi.fn(async () => ({
      thread: makeThread("thread-fork"),
      turn: { id: "turn-retry" },
    })),
    updateThread: vi.fn(async (id: string) => makeThread(id)),
    createThread: vi.fn(async () => makeThread("thread-created")),
    startTurn: vi.fn(async () => ({ turn: { id: "turn-1" } })),
    streamEvents: vi.fn(() => ({ abort: () => undefined })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).apiCapabilities = { ...CAPABILITIES };
  (provider as any).loadHistory = vi.fn(async () => 0);
  (provider as any).subscribeToEvents = vi.fn();
  (provider as any).refreshWorkPanel = vi.fn();
  (provider as any).refreshTaskList = vi.fn(async () => undefined);
  (provider as any).refreshAgentRuns = vi.fn(async () => undefined);
  (provider as any).refreshGoal = vi.fn(async () => undefined);
  (provider as any).refreshRuntimeVersion = vi.fn(async () => undefined);
  (provider as any).refreshApiCapabilities = vi.fn(async () => undefined);
  return { provider, api };
}

describe("thread → session binding", () => {
  it("adopts the session a loaded thread is bound to", async () => {
    const { provider, api } = createHarness();
    api.getThread.mockResolvedValue(makeThread("thread-2", { session_id: "sess-bound" }));

    await (provider as any).handleWebviewMessage({ type: "loadThread", threadId: "thread-2" });

    // Not just bookkeeping: this is the id the next auto-save puts on the wire.
    expect(provider.getCurrentSessionId()).toBe("sess-bound");
    await (provider as any).autoSaveSession();
    expect(api.saveCurrentSession).toHaveBeenCalledWith("thread-2", "sess-bound");
  });

  it("drops the binding when the thread it opens has none", async () => {
    const { provider, api } = createHarness();
    (provider as any).currentSessionId = "sess-from-the-thread-we-left";
    api.getThread.mockResolvedValue(makeThread("thread-clean"));

    await (provider as any).handleWebviewMessage({ type: "loadThread", threadId: "thread-clean" });

    // Carrying the previous thread's session over would save this
    // conversation's transcript into that one's document.
    expect(provider.getCurrentSessionId()).toBeNull();
    await (provider as any).autoSaveSession();
    expect(api.saveCurrentSession).toHaveBeenCalledWith("thread-clean", undefined);
  });

  it("keeps the session of the conversation a reloaded window comes back to", async () => {
    const { provider, api } = createHarness();
    api.listThreads.mockResolvedValue([
      makeThread("thread-restored", { session_id: "sess-restored", latest_turn_id: "turn-1" }),
    ]);

    await (provider as any).initializeThread();

    // `initializeThread` reaches the thread directly rather than through
    // `loadThread`, so the adoption has to exist on that path too — a window
    // reload is one of the two ways a bound conversation used to lose its id.
    expect(provider.currentThread?.id).toBe("thread-restored");
    expect(provider.getCurrentSessionId()).toBe("sess-restored");
  });

  it("carries a parked thread's session into its background auto-save", async () => {
    const { provider, api } = createHarness();
    // A thread the client loaded: the binding came from the record and is what
    // it is holding now.
    provider.currentThread = makeThread("thread-busy", { session_id: "sess-parked" });
    (provider as any).currentSessionId = "sess-parked";
    (provider as any).currentTurnId = "turn-1";

    (provider as any).parkCurrentThread();

    expect((provider as any).backgroundThreads.get("thread-busy").sessionId).toBe("sess-parked");
    await (provider as any).autoSaveSessionForThread("thread-busy");
    expect(api.saveCurrentSession).toHaveBeenCalledWith("thread-busy", "sess-parked");
  });

  it("does not resurrect through the background path a binding the client dropped", async () => {
    const { provider } = createHarness();
    // The record still names a document (a fork inherits one from the runtime),
    // but this client decided not to write it — parking must not re-derive it.
    provider.currentThread = makeThread("thread-fork", { session_id: "sess-borrowed" });
    (provider as any).currentSessionId = null;
    (provider as any).currentTurnId = "turn-1";

    (provider as any).parkCurrentThread();

    expect((provider as any).backgroundThreads.get("thread-fork").sessionId).toBeNull();
  });

  it("does not hand a discarded thread's session to the thread that replaces it", async () => {
    const { provider, api } = createHarness();
    provider.currentThread = makeThread("thread-gone", { session_id: "sess-old" });
    (provider as any).currentSessionId = "sess-old";
    // The runtime lost the thread — an empty thread is discarded, a cleared
    // store loses it — so the send path rebuilds it as an empty one.
    api.getThread.mockRejectedValue(new Error("Thread not found: thread-gone"));
    api.createThread.mockResolvedValue(makeThread("thread-rebuilt"));

    await (provider as any).handleWebviewMessage({ type: "sendMessage", text: "carry on" });

    expect(api.createThread).toHaveBeenCalled();
    // `PUT /v1/sessions` would make `sess-old` match the rebuilt thread's
    // engine, replacing a transcript this thread never held.
    expect(provider.getCurrentSessionId()).toBeNull();
  });
});

describe("forking a thread (undo, retry)", () => {
  it("does not let the fork write into the document of the thread it came from", async () => {
    const { provider, api } = createHarness();
    provider.currentThread = makeThread("thread-source", { session_id: "sess-source" });
    (provider as any).currentSessionId = "sess-source";
    // A runtime that predates the fork-owns-its-document fix hands the fork the
    // source's id, because it forked the record wholesale.
    api.getThread.mockImplementation(async (id: string) =>
      makeThread(id, { session_id: "sess-source" }),
    );
    api.patchUndoThreadTurn.mockResolvedValue({
      thread: makeThread("thread-fork", { session_id: "sess-source" }),
      patch_result: { summary: null },
      original_user_text: "carry on",
    });

    await provider.handleUndoLastTurn();

    // `PUT /v1/sessions` replaces the stored transcript, so saving the fork's
    // shorter history under `sess-source` would leave the source thread
    // describing bytes that are gone — and it could no longer be loaded at all.
    expect(provider.currentThread?.id).toBe("thread-fork");
    expect(provider.getCurrentSessionId()).toBeNull();
  });

  it("keeps the document a runtime gave the fork itself", async () => {
    const { provider, api } = createHarness();
    provider.currentThread = makeThread("thread-source", { session_id: "sess-source" });
    (provider as any).currentSessionId = "sess-source";
    api.getThread.mockImplementation(async (id: string) =>
      makeThread(id, { session_id: "sess-fork" }),
    );
    api.patchUndoThreadTurn.mockResolvedValue({
      thread: makeThread("thread-fork", { session_id: "sess-fork" }),
      patch_result: { summary: null },
      original_user_text: "carry on",
    });

    await provider.handleUndoLastTurn();

    expect(provider.getCurrentSessionId()).toBe("sess-fork");
  });

  it("applies the same rule to retry", async () => {
    const { provider, api } = createHarness();
    provider.currentThread = makeThread("thread-source", { session_id: "sess-source" });
    (provider as any).currentSessionId = "sess-source";
    api.getThread.mockImplementation(async (id: string) =>
      makeThread(id, { session_id: "sess-source" }),
    );
    api.retryThreadTurn.mockResolvedValue({
      thread: makeThread("thread-fork", { session_id: "sess-source" }),
      turn: { id: "turn-retry" },
    });

    await provider.handleRetryLastTurn();

    expect(provider.getCurrentSessionId()).toBeNull();
  });
});

describe("resuming a session that is already open", () => {
  it("does not rename the thread the runtime handed back", async () => {
    const { provider, api } = createHarness();
    api.resumeSessionThread.mockResolvedValue({
      thread_id: "thread-open",
      session_id: "sess-1",
      message_count: 4,
      summary: "Session 'One' is already open in thread thread-open (4 messages)",
      created: false,
    } as any);
    api.getThread.mockResolvedValue(
      makeThread("thread-open", { session_id: "sess-1", title: "A title the user set" }),
    );
    (provider as any).sessionState.data.viewingSessionId = "sess-1";

    await (provider as any).resumeViewedSession("sess-1");

    expect(api.updateThread).not.toHaveBeenCalled();
    // The view is now that thread, and it writes to the session it came from.
    expect(provider.currentThread?.id).toBe("thread-open");
    expect(provider.getCurrentSessionId()).toBe("sess-1");
  });

  it("names the thread a resume created", async () => {
    const { provider, api } = createHarness();
    api.resumeSessionThread.mockResolvedValue({
      thread_id: "thread-new",
      session_id: "sess-2",
      message_count: 4,
      summary: "Resumed session 'Two' (4 messages) into thread thread-new",
      created: true,
    } as any);
    api.getThread.mockResolvedValue(makeThread("thread-new", { session_id: "sess-2" }));
    (provider as any).sessionState.data.viewingSessionId = "sess-2";

    await (provider as any).resumeViewedSession("sess-2");

    // A thread minted here has no title of its own, so the rail needs one.
    expect(api.updateThread).toHaveBeenCalledWith("thread-new", {
      title: expect.stringContaining("Resumed: Resumed session 'Two'"),
    });
  });
});
