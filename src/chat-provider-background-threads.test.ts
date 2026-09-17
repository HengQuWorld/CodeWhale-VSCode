/**
 * Background (non-viewed) thread support.
 *
 * The runtime owns every turn and keeps it running when the view switches away
 * (runtime_threads.rs owns the turn lifecycle). The GUI parks the outgoing
 * thread, opens one lightweight SSE watch per background thread that is running
 * or waiting on the user, and keeps the rail badge, the VS Code notification,
 * the cross-thread answering path and the auto-save target live from those
 * events. These tests pin that wiring — in particular that a park really arms a
 * watch (the thread is still `currentThread` at that moment) and that adopting a
 * thread drops the watch it had as a background one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  showInformationMessage: vi.fn(
    async (_message: string, ..._items: string[]): Promise<string | undefined> => undefined,
  ),
  showErrorMessage: vi.fn(),
  configGet: vi.fn((_key: string, fallback?: unknown) => fallback),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vscodeMock.configGet,
      update: vi.fn(async () => undefined),
    })),
    // undefined so loadThread skips the workspace-update branch
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vscodeMock.showInformationMessage,
    showErrorMessage: vscodeMock.showErrorMessage,
  },
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "./chat-provider";
import type {
  PendingUserInputRequest,
  RuntimeEvent,
  ThreadDetailResponse,
  ThreadGoal,
  ThreadRecord,
  ThreadSummary,
} from "./types";

const UNWATCHED_SINCE_SEQ = Number.MAX_SAFE_INTEGER;

function makeThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
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

function makeSummary(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    preview: "",
    model: "deepseek-v4-pro",
    mode: "agent",
    archived: false,
    updated_at: "2026-09-17T00:00:00Z",
    latest_turn_id: null,
    latest_turn_status: null,
    pending_attention_count: 0,
    ...overrides,
  };
}

function makeEvent(
  seq: number,
  event: string,
  payload: Record<string, unknown> = {},
  turnId: string | null = null,
): RuntimeEvent {
  return {
    seq,
    timestamp: "2026-09-17T00:00:00Z",
    thread_id: "thread-A",
    turn_id: turnId,
    item_id: null,
    event,
    payload,
  };
}

function makeGoal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    thread_id: "thread-A",
    goal_id: "goal-1",
    objective: "ship it",
    status: "active",
    token_budget: null,
    tokens_used: 0,
    time_used_seconds: 0,
    continuation_count: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as ThreadGoal;
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

type StreamRecord = {
  threadId: string;
  sinceSeq: number;
  emit: (event: RuntimeEvent) => void;
};

type Harness = {
  provider: ChatProvider;
  api: Record<string, any>;
  streams: StreamRecord[];
};

function createProvider(): Harness {
  const streams: StreamRecord[] = [];
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => makeThread(id)),
    getThreadDetail: vi.fn(
      async (id: string): Promise<ThreadDetailResponse> => ({
        thread: makeThread(id),
        latest_seq: 0,
        turns: [],
        items: [],
      }),
    ),
    getThreadGoal: vi.fn(async (): Promise<ThreadGoal | null> => null),
    createThread: vi.fn(async (opts: Record<string, unknown>) => makeThread("thread-goal", opts)),
    upsertThreadGoal: vi.fn(async () => makeGoal()),
    listThreadsSummary: vi.fn(async () => [] as ThreadSummary[]),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
    submitUserInput: vi.fn(async () => undefined),
    streamEvents: vi.fn(
      (threadId: string, sinceSeq: number, onEvent: (event: RuntimeEvent) => void) => {
        streams.push({ threadId, sinceSeq, emit: onEvent });
        return { abort: () => undefined };
      },
    ),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).apiCapabilities = { ...CAPABILITIES };
  (provider as any).loadHistory = vi.fn(async () => 0);
  (provider as any).subscribeToEvents = vi.fn();
  return { provider, api, streams };
}

/** messages of one type, oldest first. */
function messagesOf(provider: ChatProvider, type: string): Array<Record<string, unknown>> {
  const calls = (provider.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type);
}

function streamFor(streams: StreamRecord[], threadId: string): StreamRecord | undefined {
  return streams.find((s) => s.threadId === threadId);
}

const providers: ChatProvider[] = [];

function newProvider() {
  const harness = createProvider();
  providers.push(harness.provider);
  return harness;
}

describe("background thread watching", () => {
  beforeEach(() => {
    vscodeMock.showInformationMessage.mockClear();
    vscodeMock.showErrorMessage.mockClear();
    vscodeMock.configGet.mockClear();
  });

  afterEach(() => {
    // The watcher debounces list refreshes on a timer; a leaked one would fire
    // into the next test's provider.
    for (const provider of providers.splice(0)) {
      const timer = (provider as any).threadListRefreshTimer;
      if (timer) clearTimeout(timer);
      (provider as any).stopAllBackgroundWatches?.();
    }
  });

  describe("parkCurrentThread()", () => {
    it("arms a watch for the thread it parks, from the view's cursor", () => {
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      (provider as any).currentTurnId = "turn-1";
      (provider as any).lastEventSeq = 42;

      (provider as any).parkCurrentThread();

      // The thread is still `currentThread` while it is being parked, so the
      // "never watch the viewed thread" rule has to be waived for this call.
      expect(streams).toHaveLength(1);
      expect(streams[0].threadId).toBe("thread-A");
      expect(streams[0].sinceSeq).toBe(42);
      const st = (provider as any).backgroundThreads.get("thread-A");
      expect(st.running).toBe(true);
      expect(st.currentTurnId).toBe("turn-1");
      const status = messagesOf(provider, "status").map((m) => m.text);
      expect(status.some((text) => String(text).includes("background"))).toBe(true);
    });

    it("parks nothing (and watches nothing) when there is no work in flight", () => {
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");

      (provider as any).parkCurrentThread();

      expect(streams).toHaveLength(0);
      expect((provider as any).backgroundThreads.size).toBe(0);
    });
  });

  describe("loadThread()", () => {
    it("drops the background watch of the thread it adopts", async () => {
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-B");
      (provider as any).ensureBackgroundState("thread-A");
      (provider as any).startBackgroundWatch("thread-A", 7);
      expect(streams.map((s) => s.threadId)).toEqual(["thread-A"]);

      await (provider as any).loadThread("thread-A");

      // Otherwise the same events arrive twice: a second notification for a
      // thread the user is looking at, and a racing duplicate auto-save.
      expect(provider.currentThread?.id).toBe("thread-A");
      expect((provider as any).watchControllers.has("thread-A")).toBe(false);
      expect((provider as any).backgroundThreads.has("thread-A")).toBe(false);
    });
  });

  describe("refreshThreadList() reconciliation", () => {
    it("watches threads the summary reports as running or waiting", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-mine", { latest_turn_status: "inprogress" }),
        makeSummary("thread-busy", { latest_turn_status: "inprogress" }),
        makeSummary("thread-waiting", { pending_attention_count: 2 }),
        makeSummary("thread-idle"),
      ]);

      await (provider as any).refreshThreadList();

      expect(streams.map((s) => s.threadId).sort()).toEqual(["thread-busy", "thread-waiting"]);
      // Never watched before → skip the durable replay entirely.
      expect(streamFor(streams, "thread-waiting")!.sinceSeq).toBe(UNWATCHED_SINCE_SEQ);
      const list = messagesOf(provider, "threadList");
      expect(list).toHaveLength(1);
      // The viewed thread is excluded: its cards are already inline.
      expect(list[0].attentionTotal).toBe(2);
    });

    it("prunes the watch and the cursor of a thread that went idle", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-busy", { pending_attention_count: 1 }),
      ]);
      await (provider as any).refreshThreadList();
      const first = streamFor(streams, "thread-busy")!;
      first.emit(makeEvent(9, "approval.decided", { id: "approval-1" }));

      api.listThreadsSummary.mockResolvedValue([makeSummary("thread-busy")]);
      await (provider as any).refreshThreadList();

      expect((provider as any).watchControllers.has("thread-busy")).toBe(false);
      expect((provider as any).backgroundThreads.has("thread-busy")).toBe(false);
      expect((provider as any).threadTitles.has("thread-busy")).toBe(true);
    });

    it("keeps watching a thread whose goal is still active", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.getThreadGoal.mockResolvedValue(makeGoal({ thread_id: "thread-goal", status: "active" }));
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-goal", { latest_turn_status: "inprogress" }),
      ]);
      await (provider as any).refreshThreadList();

      // The runtime drives goal continuations on its own; the summary alone
      // says "not running" between passes, and the watch must survive that.
      api.listThreadsSummary.mockResolvedValue([makeSummary("thread-goal")]);
      await (provider as any).refreshThreadList();

      expect((provider as any).watchControllers.has("thread-goal")).toBe(true);
      expect(streamFor(streams, "thread-goal")).toBeDefined();
    });
  });

  describe("watcher events", () => {
    const watchedId = "thread-busy";

    async function watch(overrides: Partial<ThreadSummary> = {}) {
      const harness = newProvider();
      harness.provider.currentThread = makeThread("thread-mine");
      harness.api.listThreadsSummary.mockResolvedValue([
        makeSummary(watchedId, { pending_attention_count: 1, ...overrides }),
      ]);
      await (harness.provider as any).refreshThreadList();
      return { ...harness, emit: streamFor(harness.streams, watchedId)!.emit };
    }

    it("notifies once per attention episode, and again after it clears", async () => {
      // Running thread: the watch survives an answered approval, so the next
      // episode is observed on the same stream.
      const { emit } = await watch({ pending_attention_count: 0, latest_turn_status: "inprogress" });

      emit(makeEvent(1, "approval.required", { id: "approval-1" }));
      await vi.waitFor(() => expect(vscodeMock.showInformationMessage).toHaveBeenCalledTimes(1));
      expect(String(vscodeMock.showInformationMessage.mock.calls[0][0])).toContain("Thread thread-busy");

      // Same episode → no second toast.
      emit(makeEvent(2, "approval.required", { id: "approval-2" }));
      await Promise.resolve();
      expect(vscodeMock.showInformationMessage).toHaveBeenCalledTimes(1);

      // Episode over, then a fresh one → notifies again.
      emit(makeEvent(3, "approval.decided", { id: "approval-1" }));
      emit(makeEvent(4, "approval.decided", { id: "approval-2" }));
      emit(makeEvent(5, "approval.required", { id: "approval-3" }));
      await vi.waitFor(() => expect(vscodeMock.showInformationMessage).toHaveBeenCalledTimes(2));
    });

    it("re-arms from the summary after an idle thread goes quiet", async () => {
      const { provider, api, streams, emit } = await watch();

      // Answering the last pending item leaves an idle thread with nothing to
      // watch, so the stream is dropped instead of idling forever.
      emit(makeEvent(1, "approval.decided", { id: "approval-1" }));
      expect((provider as any).watchControllers.has("thread-busy")).toBe(false);
      expect((provider as any).backgroundThreads.has("thread-busy")).toBe(false);

      // A new approval arrives: the summary reports it, and the next refresh
      // opens a fresh watch (never replaying what we already saw).
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-busy", { pending_attention_count: 1 }),
      ]);
      await (provider as any).refreshThreadList();
      expect((provider as any).watchControllers.has("thread-busy")).toBe(true);
      expect(streams.filter((s) => s.threadId === "thread-busy")).toHaveLength(2);
    });

    it("stays silent when the notification setting is off", async () => {
      vscodeMock.configGet.mockImplementation((key: string, fallback?: unknown) =>
        key === "backgroundThreadNotifications" ? false : fallback,
      );
      const { emit } = await watch();

      emit(makeEvent(1, "approval.required", { id: "approval-1" }));
      await Promise.resolve();

      expect(vscodeMock.showInformationMessage).not.toHaveBeenCalled();
    });

    it("auto-saves a completed background turn in place", async () => {
      const { api, emit } = await watch();

      emit(makeEvent(1, "turn.completed", {}));
      await vi.waitFor(() => expect(api.saveCurrentSession).toHaveBeenCalledTimes(1));
      expect(api.saveCurrentSession).toHaveBeenCalledWith("thread-busy", undefined);

      // Second turn on the same thread updates the same session, not a new one.
      emit(makeEvent(2, "turn.completed", {}));
      await vi.waitFor(() => expect(api.saveCurrentSession).toHaveBeenCalledTimes(2));
      expect(api.saveCurrentSession).toHaveBeenLastCalledWith("thread-busy", "session-1");
    });

    it("drops item deltas and stops the watch once nothing is pending", async () => {
      const { provider, emit } = await watch();
      const state = (provider as any).backgroundThreads.get("thread-busy");

      emit(makeEvent(1, "approval.decided", { id: "approval-1" }));
      emit(makeEvent(2, "item.delta", { delta: "noise" }));

      expect(state.attention).toBe(0);
      // The summary will re-arm it if the thread still needs watching.
      expect((provider as any).watchControllers.has("thread-busy")).toBe(false);
      expect((provider as any).backgroundThreads.has("thread-busy")).toBe(false);
    });
  });

  describe("cross-thread attention", () => {
    const pendingInput: PendingUserInputRequest = {
      id: "input-1",
      turn_id: "t1",
      request: {
        questions: [
          {
            header: "Pick",
            id: "q1",
            question: "Which one?",
            options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
          },
        ],
      },
    };

    it("caches a background thread's pending inputs and answers them in place", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.getThreadDetail.mockResolvedValue({
        latest_seq: 3,
        turns: [],
        items: [],
        pending_approvals: [{ id: "approval-1", turn_id: "t1", tool_name: "shell", description: "run ls" }],
        pending_user_inputs: [pendingInput],
      });

      await (provider as any).handleShowThreadAttention("thread-busy");

      expect(api.getThreadDetail).toHaveBeenCalledWith("thread-busy");
      expect((provider as any).backgroundUserInputs.has("input-1")).toBe(true);
      const posted = messagesOf(provider, "threadAttention");
      expect(posted).toHaveLength(1);
      expect(posted[0].threadId).toBe("thread-busy");
      expect((posted[0].approvals as unknown[]).length).toBe(1);

      // Answering resolves against the background thread, not the view's.
      await (provider as any).handleUserInputSelect("input-1", "q1", 0, "Yes");
      expect(api.submitUserInput).toHaveBeenCalledWith("thread-busy", "input-1", [
        { id: "q1", label: "Yes", value: "Yes" },
      ]);
      expect((provider as any).backgroundUserInputs.has("input-1")).toBe(false);
    });

    it("cancels a background input from either map", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      (provider as any).backgroundUserInputs.set("input-2", {
        threadId: "thread-busy",
        questions: pendingInput.request.questions,
        answers: [],
        answeredQuestions: new Set(),
      });

      await (provider as any).handleUserInputCancel("input-2");

      expect(api.submitUserInput).toHaveBeenCalledWith("thread-busy", "input-2", []);
      expect((provider as any).backgroundUserInputs.has("input-2")).toBe(false);
    });

    it("ignores the currently viewed thread", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");

      await (provider as any).handleShowThreadAttention("thread-mine");

      expect(api.getThreadDetail).not.toHaveBeenCalled();
      expect(messagesOf(provider, "threadAttention")).toHaveLength(0);
    });
  });

  describe("background goals", () => {
    it("runs the goal on a new thread with the current thread's posture", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-mine", { permission_posture: "full_access" });

      await (provider as any).handleSetGoal("ship the release", 5000, true);

      expect(api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "deepseek-v4-pro",
          mode: "agent",
          workspace: "/tmp/repo",
          title: "ship the release",
          permission_posture: "full_access",
          auto_approve: true,
          trust_mode: true,
        }),
      );
      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-goal", "ship the release", 5000);
      expect(streamFor(streams, "thread-goal")!.sinceSeq).toBe(UNWATCHED_SINCE_SEQ);
      const info = messagesOf(provider, "info").map((m) => String(m.message));
      expect(info.some((message) => message.includes("Background goal started"))).toBe(true);
      expect(info.some((message) => message.includes("Ask posture blocks"))).toBe(false);
    });

    it("warns about the Ask posture the new thread is pinned to", async () => {
      const { provider } = newProvider();
      provider.currentThread = makeThread("thread-mine", { permission_posture: "ask" });

      await (provider as any).handleSetGoal("ship the release", undefined, true);

      const info = messagesOf(provider, "info").map((m) => String(m.message));
      expect(info.some((message) => message.includes("Ask posture blocks"))).toBe(true);
    });

    it("leaves the goal on the current thread when background is not asked for", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");

      await (provider as any).handleSetGoal("stay here", undefined, false);

      expect(api.createThread).not.toHaveBeenCalled();
      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-mine", "stay here", undefined);
    });

    it("resumes by re-PUTting the active goal", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.getThreadGoal.mockResolvedValue(makeGoal({ objective: "keep going", token_budget: 100 }));

      await (provider as any).handleResumeGoal();

      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-mine", "keep going", 100);
    });
  });

  describe("dispose()", () => {
    it("stops every watch and clears the cursor state", () => {
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      (provider as any).currentTurnId = "turn-1";
      (provider as any).parkCurrentThread();
      expect(streams).toHaveLength(1);

      provider.dispose();

      expect((provider as any).watchControllers.size).toBe(0);
      expect((provider as any).backgroundThreads.size).toBe(0);
    });
  });
});
