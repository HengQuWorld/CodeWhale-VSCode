/**
 * Background (non-viewed) thread support.
 *
 * The runtime owns every turn and keeps it running when the view switches away
 * (runtime_threads.rs owns the turn lifecycle). The GUI parks the outgoing
 * thread, opens one lightweight SSE watch per background thread that is running
 * or waiting on the user, and keeps the rail badge, the cross-thread answering
 * path and the auto-save target live from those
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
  replayLimit: number | undefined;
  /** Push an event the engine published on this thread at `event.seq`.
   *
   *  The admission rule is the engine's, not a convenience: a stream delivers
   *  `seq > since_seq`, and the opening cursor is also the live pump's cursor,
   *  so a cursor above the thread's own sequence admits nothing — ever.
   *  `replay_limit: 0` repositions that cursor to the thread's last event
   *  instead of to `since_seq`, which is how a caller asks to watch from now
   *  on. Modelling both here is what makes a watch's cursor observable: a test
   *  that arms a silent stream cannot quietly assert against one. */
  emit: (event: RuntimeEvent) => void;
};

type Harness = {
  provider: ChatProvider;
  api: Record<string, any>;
  streams: StreamRecord[];
  /** Highest event sequence the engine has published on a thread, which is
   *  where a `replay_limit: 0` stream starts reading. */
  engineEdge: Map<string, number>;
};

function createProvider(): Harness {
  const streams: StreamRecord[] = [];
  /** Where the engine's journal ends for a thread: the sequence a
   *  `replay_limit: 0` stream is positioned at when it opens. */
  const engineEdge = new Map<string, number>();
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
    completeThreadGoal: vi.fn(async () => makeGoal({ status: "complete" })),
    blockThreadGoal: vi.fn(async () => makeGoal({ status: "blocked" })),
    deleteThreadGoal: vi.fn(async () => undefined),
    listThreadsSummary: vi.fn(async () => [] as ThreadSummary[]),
    listThreads: vi.fn(async () => [] as ThreadRecord[]),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
    submitUserInput: vi.fn(async () => undefined),
    streamEvents: vi.fn(
      (
        threadId: string,
        sinceSeq: number,
        onEvent: (event: RuntimeEvent) => void,
        _onError?: (err: Error) => void,
        replayLimit?: number,
      ) => {
        // Resolve the opening cursor the way the engine does, then apply the
        // delivery rule: nothing at or below it is ever delivered.
        const liveFrom = replayLimit === 0 ? (engineEdge.get(threadId) ?? 0) : sinceSeq;
        streams.push({
          threadId,
          sinceSeq,
          replayLimit,
          emit: (event: RuntimeEvent) => {
            if (event.seq <= liveFrom) return;
            engineEdge.set(threadId, event.seq);
            onEvent(event);
          },
        });
        return { abort: () => undefined };
      },
    ),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).apiCapabilities = { ...CAPABILITIES };
  (provider as any).loadHistory = vi.fn(async () => 0);
  (provider as any).subscribeToEvents = vi.fn();
  return { provider, api, streams, engineEdge };
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

/** The attention count the rail would show for one thread.
 *
 *  It is read off the newest `threadList` publish, because that is the only
 *  thing the rail and the toolbar's Agent label are drawn from — a count the
 *  client holds internally but never publishes is not a visible surface. */
function attentionCountOnRail(provider: ChatProvider, threadId: string): number {
  const lists = messagesOf(provider, "threadList");
  const rows = (lists[lists.length - 1]?.threads as Array<Record<string, unknown>>) || [];
  const row = rows.find((r) => r.id === threadId);
  return Number(row?.pending_attention_count || 0);
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

    it("arms a watch for a parked thread whose goal is still Active, with no turn in flight", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      api.getThreadGoal.mockResolvedValue(makeGoal({ objective: "keep going" }));
      (provider as any).lastEventSeq = 42;

      // The view learned the goal while it was on this thread.
      await provider.refreshGoal();
      expect((provider as any).currentTurnId).toBeNull();

      (provider as any).parkCurrentThread();

      // The runtime arms the next continuation pass itself, so an Active goal
      // is work in flight even when no turn happens to be running right now.
      expect(streamFor(streams, "thread-A")!.sinceSeq).toBe(42);
      const st = (provider as any).backgroundThreads.get("thread-A");
      expect(st.running).toBe(false);
    });

    it("parks nothing when the goal is not Active", async () => {
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      api.getThreadGoal.mockResolvedValue(makeGoal({ status: "paused" }));

      await provider.refreshGoal();
      (provider as any).parkCurrentThread();

      expect(streams).toHaveLength(0);
    });
  });

  describe("attention discovery poll", () => {
    it("watches a thread that started somewhere else, and surfaces it on the rail", async () => {
      const { provider, api, streams } = newProvider();
      vi.useFakeTimers();
      try {
        provider.currentThread = makeThread("thread-mine");
        // A task is still unfinished somewhere, which is what makes the sweep
        // worth its summary fetch at all.
        api.listTasks.mockResolvedValue({
          tasks: [{ id: "task-1", status: "running", prompt_summary: "ship it" }],
          counts: { active: 1, completed: 0, failed: 0 },
        });
        api.listThreadsSummary.mockResolvedValue([
          makeSummary("thread-elsewhere", { pending_attention_count: 1 }),
        ]);

        (provider as any).startAttentionDiscoveryPoll();
        await vi.advanceTimersByTimeAsync(30_000);

        // Nothing in this window had ever heard of this thread, so no event
        // could open a watch for it: the sweep is the only way it gets one.
        expect(streamFor(streams, "thread-elsewhere")).toBeDefined();
        // And the sweep is the only thing that can *surface* it. The watch it
        // just armed starts at the live edge, so the request that prompted
        // this pass is history that stream will never replay; a waiting thread
        // the sweep finds has to reach the rail, or it stays invisible until
        // someone opens it by hand. (A sweep that finds nobody waiting still
        // leaves the rail alone — that is the next test.)
        expect(attentionCountOnRail(provider, "thread-elsewhere")).toBe(1);
      } finally {
        (provider as any).stopAttentionDiscoveryPoll();
        vi.useRealTimers();
      }
    });

    it("skips the summary walk when nothing could need the user", async () => {
      const { provider, api } = newProvider();
      vi.useFakeTimers();
      try {
        provider.currentThread = makeThread("thread-mine");
        // The default mocks: no task anywhere, no thread tracked here.

        (provider as any).startAttentionDiscoveryPoll();
        await vi.advanceTimersByTimeAsync(30_000);

        // The gate is the point: an idle window must not walk the summary store
        // (25s on a large one) every 30 seconds for nothing.
        expect(api.listTasks).toHaveBeenCalled();
        expect(api.listThreadsSummary).not.toHaveBeenCalled();
      } finally {
        (provider as any).stopAttentionDiscoveryPoll();
        vi.useRealTimers();
      }
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
      // Never watched before, so there is no cursor to resume from: the watch
      // starts at the live edge and replays nothing.
      //
      // Both halves matter. `replayLimit: 0` is what makes `sinceSeq: 0` mean
      // "from now on" instead of "replay everything"; and `sinceSeq` must not
      // be a cursor above the thread's own sequence, because delivery is
      // `seq > since_seq` — such a stream opens, keeps alive, and never
      // delivers an event, which is a background thread that can wait for an
      // approval in complete silence.
      const waiting = streamFor(streams, "thread-waiting")!;
      expect(waiting.sinceSeq).toBe(0);
      expect(waiting.replayLimit).toBe(0);
      const list = messagesOf(provider, "threadList");
      expect(list).toHaveLength(1);
      // The rail is handed the summaries and nothing else: the toolbar chip
      // derives the count from them, so what it offers to open cannot name a
      // thread the list does not carry. (The viewed-thread exclusion the count
      // depends on is asserted in the sidebar's own runtime test.)
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

  describe("watch cursor", () => {
    it("hears a live approval on a thread it has never watched", async () => {
      // The regression. This watch used to be armed at `Number.MAX_SAFE_INTEGER`
      // as a way of saying "skip the durable replay": the cursor was rewritten
      // from the client's reading of the engine, and the engine does not work
      // that way. Delivery is `seq > since_seq` and the opening cursor is also
      // the live pump's cursor, so nothing could ever exceed MAX — the stream
      // opened, kept alive, and never delivered an event. A background thread
      // that blocked on an approval under Ask therefore raised no notification
      // and no rail badge, and the only way to see the request was to open the
      // thread by hand and let loadHistory read `pending_approvals`.
      const { provider, api, streams, engineEdge } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      // The thread already has a journal, and its live edge sits well above
      // the sequences these tests use: a watch that replayed from 0 would
      // deliver 40 events nobody asked for, and one armed above the edge at
      // MAX would deliver none of them ever.
      engineEdge.set("thread-busy", 40);
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-busy", {
          latest_turn_status: "inprogress",
          pending_attention_count: 0,
        }),
      ]);
      await (provider as any).refreshThreadList();

      const watch = streamFor(streams, "thread-busy")!;
      expect(watch.sinceSeq).toBe(0);
      expect(watch.replayLimit).toBe(0);
      // Nothing is waiting yet: that row was published before the request existed.
      expect(attentionCountOnRail(provider, "thread-busy")).toBe(0);

      // The runtime registers the request before sequencing the event, so the
      // next summary fetch reports it — and that count is what the rail's
      // *Needs you* group and the Agent label show.
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-busy", {
          latest_turn_status: "inprogress",
          pending_attention_count: 1,
        }),
      ]);

      // The delivered event is what schedules the rail repaint. Nothing below
      // calls refreshThreadList directly: a watch that cannot deliver an event
      // never schedules one, so the count would sit at 0 forever — which is
      // exactly what the MAX cursor produced, and why a waiting thread was
      // invisible until it was opened by hand.
      watch.emit(makeEvent(41, "approval.required", { id: "approval-1" }));

      await vi.waitFor(() => expect(attentionCountOnRail(provider, "thread-busy")).toBe(1));
    });

    it("surfaces attention the discovery sweep finds, instead of swallowing it", async () => {
      // A request that is already pending when a watch opens is invisible to
      // that watch: it is history, and a live-edge stream replays nothing. So
      // the sweep that arms the watch is the only thing that can tell the user
      // — and it used to do it *quietly*, publishing nothing at all. The rail
      // then stayed frozen until the thread was opened by hand, which is the
      // "it only ever showed once" report.
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-waiting", { pending_attention_count: 1 }),
      ]);

      // The sweep, exactly as the discovery poll runs it.
      await (provider as any).refreshThreadList(true);

      expect(attentionCountOnRail(provider, "thread-waiting")).toBe(1);
    });

    it("arms a watch for a running thread the sweep finds without repainting", async () => {
      // The sweep's first job, and the one it must not lose: a thread running
      // somewhere else has nobody watching it, and until a watch exists nothing
      // can hear its approval. Repainting the rail for a thread that is merely
      // *running* is what the sweep deliberately avoids.
      const { provider, api, streams } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-running", { latest_turn_status: "inprogress" }),
      ]);

      await (provider as any).refreshThreadList(true);

      expect(streamFor(streams, "thread-running")).toBeDefined();
      expect(messagesOf(provider, "threadList")).toHaveLength(0);
    });

    it("keeps a quiet sweep off the rail when nobody is waiting", async () => {
      // The other half: the sweep is still not a repaint. With nothing waiting
      // it must not touch the rail, or every 30 seconds would redraw the list
      // (and throw away an expanded attention card) for no reason.
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-idle", { latest_turn_status: "completed" }),
      ]);

      await (provider as any).refreshThreadList(true);

      expect(messagesOf(provider, "threadList")).toHaveLength(0);
    });

    it("publishes complete rows when a sweep does paint the rail", async () => {
      // A quiet pass skips the branch-line fetch. Painting rows without it
      // would strip the rail's fork lines until the next full refresh, so the
      // pass that decides to paint has to fetch them itself.
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.listThreadsSummary.mockResolvedValue([
        makeSummary("thread-waiting", { pending_attention_count: 1 }),
      ]);
      api.listThreads.mockResolvedValue([
        makeThread("thread-waiting", { session_id: "session-of-waiting" }),
      ]);

      await (provider as any).refreshThreadList(true);

      const lists = messagesOf(provider, "threadList");
      const rows = lists[lists.length - 1]!.threads as Array<Record<string, unknown>>;
      expect(rows.find((r) => r.id === "thread-waiting")!.session_id).toBe(
        "session-of-waiting",
      );
    });

    it("keeps the parked thread's own cursor instead of jumping to the edge", async () => {
      // The other half: parking knows exactly where the view stopped reading,
      // so that watch resumes there rather than discarding the events emitted
      // between the park and the stream opening.
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      (provider as any).lastEventSeq = 42;
      (provider as any).currentTurnId = "turn-1";

      await (provider as any).parkCurrentThread();

      const parked = streamFor(streams, "thread-A")!;
      expect(parked.sinceSeq).toBe(42);
      expect(parked.replayLimit).toBeUndefined();
    });

    it("does not replay the whole journal when a parked thread has no cursor yet", async () => {
      // `lastEventSeq` of 0 is not a cursor at all — it is the absence of one.
      // Passing it through would ask the engine for `seq > 0`, the entire
      // journal, replaying turns this client already handled: a second
      // completion cue and a second auto-save. It means the live edge.
      const { provider, streams } = newProvider();
      provider.currentThread = makeThread("thread-A");
      (provider as any).lastEventSeq = 0;
      (provider as any).currentTurnId = "turn-1";

      await (provider as any).parkCurrentThread();

      const parked = streamFor(streams, "thread-A")!;
      expect(parked.sinceSeq).toBe(0);
      expect(parked.replayLimit).toBe(0);
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

    it("stays silent for approvals the runtime resolves by itself", async () => {
      // The runtime's auto-approve path (a remembered "always allow", Full
      // Access) emits `approval.required` and then `approval.decided` with
      // `auto: true`, registering nothing as pending in between. Nothing in
      // that path needs the user, so ten of those must not put ten onto the
      // rail's *Needs you* count (or into the toolbar's Agent label, which
      // reads the same rows).
      const { provider, api, emit } = await watch({
        pending_attention_count: 0,
        latest_turn_status: "inprogress",
      });

      for (let i = 0; i < 10; i += 1) {
        emit(makeEvent(i * 2 + 1, "approval.required", { id: `approval-auto-${i}` }));
        emit(makeEvent(i * 2 + 2, "approval.decided", { id: `approval-auto-${i}` }));
      }
      // The authoritative count never moves: nothing was ever registered.
      api.listThreadsSummary.mockResolvedValue([
        makeSummary(watchedId, { pending_attention_count: 0, latest_turn_status: "inprogress" }),
      ]);
      await (provider as any).refreshThreadList();

      expect(attentionCountOnRail(provider, watchedId)).toBe(0);
    });

    it("refreshes the task list when a watched thread asks for the user", async () => {
      const { api, emit } = await watch();
      api.listTasks.mockClear();

      emit(makeEvent(1, "approval.required", { id: "approval-1" }));

      // A task's pending approvals are read off its own thread (enrichTaskSummary),
      // so the Tasks panel has to move when the watch sees the very request the
      // rail card is showing — otherwise the badge stays stale exactly when a
      // background task needs an answer.
      expect(api.listTasks).toHaveBeenCalled();
    });

    it("refreshes the task list when a watched turn completes", async () => {
      const { api, emit } = await watch();
      api.listTasks.mockClear();

      emit(makeEvent(1, "turn.completed"));

      expect(api.listTasks).toHaveBeenCalled();
    });

    it("puts a background thread's attention on the rail, and takes it down again", async () => {
      // The rail is where attention is surfaced now: the *Needs you* group on
      // the thread card and the toolbar's Agent label are both drawn from these
      // rows, and the count comes from the summary's authoritative pending
      // total — never from a raw `approval.required`, which the runtime also
      // emits for calls it resolves itself.
      const { provider, api, emit } = await watch({
        pending_attention_count: 0,
        latest_turn_status: "inprogress",
      });
      expect(attentionCountOnRail(provider, watchedId)).toBe(0);

      // A real request: the runtime registers it before sequencing the event,
      // so the summary the refresh fetches reports it.
      emit(makeEvent(1, "approval.required", { id: "approval-1" }));
      api.listThreadsSummary.mockResolvedValue([
        makeSummary(watchedId, { pending_attention_count: 1, latest_turn_status: "inprogress" }),
      ]);
      await (provider as any).refreshThreadList();
      expect(attentionCountOnRail(provider, watchedId)).toBe(1);

      // Answering it takes the count back down the same way it went up, so a
      // thread that no longer needs anyone stops being counted as waiting.
      emit(makeEvent(2, "approval.decided", { id: "approval-1" }));
      api.listThreadsSummary.mockResolvedValue([
        makeSummary(watchedId, { pending_attention_count: 0, latest_turn_status: "inprogress" }),
      ]);
      await (provider as any).refreshThreadList();
      expect(attentionCountOnRail(provider, watchedId)).toBe(0);
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
      // The thread was created a moment ago: no cursor to resume from, so the
      // watch is positioned at the live edge. A background goal under Ask
      // blocks on the first tool approval, and this watch is the only thing
      // that can hear it.
      const goalWatch = streamFor(streams, "thread-goal")!;
      expect(goalWatch.sinceSeq).toBe(0);
      expect(goalWatch.replayLimit).toBe(0);
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

    it("adopts a thread when the GUI has none, instead of dropping the goal", async () => {
      const { provider, api } = newProvider();
      // 新建会话 (handleNewThread) and a saved session from the Sessions tab
      // both reset the session state, leaving no thread to attach a goal to.
      expect(provider.currentThread).toBeNull();

      await (provider as any).handleSetGoal("ship the release", 2500);

      expect(api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "deepseek-v4-pro",
          mode: "agent",
          trust_mode: false,
          auto_approve: false,
        }),
      );
      expect(provider.currentThread?.id).toBe("thread-goal");
      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-goal", "ship the release", 2500);
      expect(messagesOf(provider, "error")).toHaveLength(0);
    });

    it("resumes the viewed session when the goal belongs to it", async () => {
      const { provider, api } = newProvider();
      // A saved session is viewed without a thread, and the next message will
      // resume it: a goal set here belongs to that conversation, not to a
      // thread of its own that the next message would never use and nothing
      // would watch.
      (provider as any).sessionState.data.viewingSessionId = "sess-1";
      api.resumeSessionThread = vi.fn(async () => ({
        thread_id: "thread-resumed",
        summary: "a session",
      }));
      api.updateThread = vi.fn(async (id: string) => makeThread(id));

      await (provider as any).handleSetGoal("ship the release", 2500);

      expect(api.resumeSessionThread).toHaveBeenCalledWith("sess-1");
      expect(api.createThread).not.toHaveBeenCalled();
      expect(provider.currentThread?.id).toBe("thread-resumed");
      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-resumed", "ship the release", 2500);
      expect((provider as any).sessionState.data.viewingSessionId).toBeNull();
      expect(messagesOf(provider, "error")).toHaveLength(0);
    });

    it("keeps a background goal on a thread of its own while a session is viewed", async () => {
      const { provider, api } = newProvider();
      (provider as any).sessionState.data.viewingSessionId = "sess-1";
      api.resumeSessionThread = vi.fn(async () => ({
        thread_id: "thread-resumed",
        summary: "a session",
      }));

      await (provider as any).handleSetGoal("ship the release", undefined, true);

      // "Run on a background thread" is exactly that: the work goes to a new
      // thread while the view keeps showing the session, which is not resumed
      // until the user types into it.
      expect(api.resumeSessionThread).not.toHaveBeenCalled();
      expect(api.createThread).toHaveBeenCalled();
      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-goal", "ship the release", undefined);
    });

    it("lets a background goal start with no thread to inherit from", async () => {
      const { provider, api, streams } = newProvider();
      expect(provider.currentThread).toBeNull();

      await (provider as any).handleSetGoal("ship the release", undefined, true);

      expect(api.upsertThreadGoal).toHaveBeenCalledWith("thread-goal", "ship the release", undefined);
      expect(streamFor(streams, "thread-goal")).toBeDefined();
    });

    it("answers the webview when a save fails, instead of leaving the panel stale", async () => {
      const { provider, api } = newProvider();
      provider.currentThread = makeThread("thread-mine");
      api.upsertThreadGoal.mockRejectedValueOnce(new Error("engine down"));

      await (provider as any).handleSetGoal("ship the release");

      expect(vscodeMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("engine down"),
      );
      const errors = messagesOf(provider, "error").map((m) => String(m.message));
      expect(errors.some((message) => message.includes("engine down"))).toBe(true);
    });

    it("answers a goal action that has no thread instead of returning in silence", async () => {
      const { provider, api } = newProvider();
      expect(provider.currentThread).toBeNull();

      await (provider as any).handleDeleteGoal();

      expect(api.deleteThreadGoal).not.toHaveBeenCalled();
      expect(vscodeMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("No active thread"),
      );
      expect(messagesOf(provider, "error")).toHaveLength(1);
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
