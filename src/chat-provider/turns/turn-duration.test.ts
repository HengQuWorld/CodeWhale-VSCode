/**
 * How long each turn took, and how much work the conversation has done.
 *
 * Two figures, carried by two different paths: the turn's own length is
 * stamped onto the answer that closes it (live and rebuilt alike), and the
 * session's total is a running sum the status bar reads. What these tests pin
 * is where the numbers come from — the engine's `duration_ms` first, the turn's
 * two ends when a runtime predates that field, nothing at all when the record
 * cannot say — and that a turn is counted exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => ({ id })),
    getThreadDetail: vi.fn(async () => ({ latest_seq: 0, thread: { id: "thread-1" }, turns: [], items: [] }) as any),
    getThreadGoal: vi.fn(async () => null),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).startPeriodicTaskRefresh = vi.fn();
  (provider as any).autoSaveSession = vi.fn();
  (provider as any).scheduleThreadListRefresh = vi.fn();
  (provider as any).refreshGoal = vi.fn();
  (provider as any).subscribeToEvents = vi.fn();

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
    { id: "a1", role: "assistant", content: "done", status: "streaming", timestamp: 2, blocks: [] },
  ] as any;

  return { provider, api };
}

/** The engine's terminal-turn event for the conversation on screen. */
function turnCompleted(turn: Record<string, unknown>) {
  return {
    seq: 9,
    event: "turn.completed",
    turn_id: turn.id,
    item_id: null,
    payload: { turn },
  } as any;
}

function posted(provider: ChatProvider, type: string) {
  const calls = (provider.postMessage as any).mock.calls.map((call: any[]) => call[0]);
  return calls.filter((message: any) => message && message.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a finished turn's own length", () => {
  it("stamps the engine's duration on the answer that closes the turn", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      duration_ms: 192000,
    }));

    const answer = provider.messages[1];
    expect(answer.durationMs).toBe(192000);
    const [complete] = posted(provider, "messageComplete");
    expect(complete.durationMs).toBe(192000);
    expect(complete.messageId).toBe("a1");
  });

  it("derives the length from the turn's two ends when the runtime omits it", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      started_at: "2026-10-27T10:00:00Z",
      ended_at: "2026-10-27T10:03:12Z",
    }));

    expect(provider.messages[1].durationMs).toBe(192000);
    expect(posted(provider, "messageComplete")[0].durationMs).toBe(192000);
  });

  it("draws nothing for a turn the record cannot time", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
    }));

    expect(provider.messages[1].durationMs).toBeUndefined();
    expect(posted(provider, "messageComplete")[0].durationMs).toBeUndefined();
  });

  it("keeps a failed turn's length: the time was spent either way", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "failed",
      mode: "agent",
      duration_ms: 5000,
      error: "provider refused",
    }));

    expect(provider.messages[1].durationMs).toBe(5000);
  });
});

describe("the session's worked total", () => {
  it("grows by each settled turn's whole seconds", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      duration_ms: 192000,
    }));
    expect(provider.cumulativeTurnSecs).toBe(192);

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-2",
      status: "completed",
      mode: "agent",
      duration_ms: 48000,
    }));
    expect(provider.cumulativeTurnSecs).toBe(240);
  });

  it("is published with the session stats, so the view can add the live turn", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      duration_ms: 192000,
    }));
    (provider as any).sendSessionStats();

    const stats = posted(provider, "sessionStats");
    expect(stats.at(-1).workedSecs).toBe(192);
  });

  it("does not move for a turn with no measured length", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
    }));

    expect(provider.cumulativeTurnSecs).toBe(0);
  });

  it("rides along with the turn's own completion message", () => {
    // The clock under the answer stops on this message, so the total it settles
    // must arrive with it rather than a round trip later.
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      duration_ms: 192000,
    }));

    expect(posted(provider, "messageComplete")[0].workedSecs).toBe(192);
  });
});

describe("a transcript rebuilt from history", () => {
  function detail(turns: Array<Record<string, unknown>>) {
    return {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: turns.map((turn) => ({
        input_summary: "a question",
        created_at: "2026-10-27T10:00:00Z",
        status: "completed",
        item_ids: [`u-${turn.id}`, `a-${turn.id}`],
        ...turn,
      })),
      items: turns.flatMap((turn) => [
        { id: `u-${turn.id}`, kind: "user_message", summary: "a question", detail: "a question", status: "completed" },
        { id: `a-${turn.id}`, kind: "agent_message", summary: "an answer", detail: "an answer", status: "completed", metadata: null },
      ]),
      pending_approvals: [],
      pending_user_inputs: [],
    };
  }

  it("stamps each finished turn's length on the answer that closes it", async () => {
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValue(detail([
      { id: "turn-1", duration_ms: 192000 },
      { id: "turn-2", duration_ms: 48000 },
    ]));

    await (provider as any).loadHistory("thread-1");

    const answers = provider.messages.filter((message) => message.role === "assistant");
    expect(answers.map((message) => message.durationMs)).toEqual([192000, 48000]);
  });

  it("states the session total the thread already accounts for", async () => {
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValue(detail([
      { id: "turn-1", duration_ms: 192000 },
      { id: "turn-2", duration_ms: 48000 },
    ]));

    await (provider as any).loadHistory("thread-1");

    expect(provider.cumulativeTurnSecs).toBe(240);
  });

  it("leaves a running turn out of the total and out of the bubbles", async () => {
    // The engine's duration for a live turn keeps ticking; counting it here and
    // again when it settles would count the same seconds twice.
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValue(detail([
      { id: "turn-1", duration_ms: 60000 },
      { id: "turn-2", status: "in_progress", duration_ms: 90000 },
    ]));

    await (provider as any).loadHistory("thread-1");

    expect(provider.cumulativeTurnSecs).toBe(60);
    const answers = provider.messages.filter((message) => message.role === "assistant");
    expect(answers[0].durationMs).toBe(60000);
    // The live turn's figure is on no bubble: it will be stamped when it ends.
    expect(answers.some((message) => message.durationMs === 90000)).toBe(false);
  });

  it("never lowers a total the view already holds", async () => {
    // A resumed session's saved metadata can be ahead of the thread's own
    // turns; a rebuild must not roll the reading back under the user.
    const { provider, api } = createProvider();
    provider.cumulativeTurnSecs = 3600;
    api.getThreadDetail.mockResolvedValue(detail([{ id: "turn-1", duration_ms: 192000 }]));

    await (provider as any).loadHistory("thread-1");

    expect(provider.cumulativeTurnSecs).toBe(3600);
  });
});

describe("the live clock's anchor", () => {
  it("hands the view the engine's own start instant when adopting a turn", () => {
    const { provider } = createProvider();

    (provider as any).adoptActiveTurn({
      id: "turn-1",
      status: "in_progress",
      mode: "agent",
      started_at: "2026-10-27T10:00:00Z",
    });

    const [started] = posted(provider, "turnStarted");
    expect(started.turnId).toBe("turn-1");
    expect(started.startedAtMs).toBe(Date.parse("2026-10-27T10:00:00Z"));
  });

  it("says nothing rather than inventing a start for a turn that has none", () => {
    // A queued turn has not begun working. The view starts its clock at the
    // receipt instead, which is the only instant it can vouch for.
    const { provider } = createProvider();

    (provider as any).adoptActiveTurn({
      id: "turn-1",
      status: "queued",
      mode: "agent",
      created_at: "2026-10-27T10:00:00Z",
      started_at: null,
    });

    expect(posted(provider, "turnStarted")[0].startedAtMs).toBeUndefined();
  });
});

describe("counting a turn once", () => {
  it("holds the total when a reconnecting stream replays the completion", () => {
    // The same replay that can fire auto-save twice delivers turn.completed
    // twice; the seconds were already counted the first time.
    const { provider } = createProvider();
    const event = () => turnCompleted({
      id: "turn-1",
      status: "completed",
      mode: "agent",
      duration_ms: 192000,
    });

    (provider as any).handleRuntimeEvent(event());
    (provider as any).handleRuntimeEvent(event());
    (provider as any).handleRuntimeEvent(event());

    expect(provider.cumulativeTurnSecs).toBe(192);
  });

  it("still counts a second turn that has its own length", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1", status: "completed", mode: "agent", duration_ms: 60000,
    }));
    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-2", status: "completed", mode: "agent", duration_ms: 30000,
    }));

    expect(provider.cumulativeTurnSecs).toBe(90);
  });

  it("recognises a completion for a turn a rebuild already counted", async () => {
    // The rebuild sums the thread's finished turns; a completion that arrives
    // for one of them afterwards must not add its length a second time.
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValue({
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [{
        id: "turn-1",
        input_summary: "a question",
        created_at: "2026-10-27T10:00:00Z",
        ended_at: "2026-10-27T10:03:12Z",
        status: "completed",
        duration_ms: 192000,
        item_ids: ["u1", "a1"],
      }],
      items: [
        { id: "u1", kind: "user_message", summary: "a question", detail: "a question", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "an answer", detail: "an answer", status: "completed", metadata: null },
      ],
    });

    await (provider as any).loadHistory("thread-1");
    expect(provider.cumulativeTurnSecs).toBe(192);

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1", status: "completed", mode: "agent", duration_ms: 192000,
    }));

    expect(provider.cumulativeTurnSecs).toBe(192);
  });

  it("starts the count over for a conversation whose stats were reset", async () => {
    // Ids guard one conversation's total; another conversation's turn ids are
    // not the same numbers, and its own count starts from zero.
    const { provider, api } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted({
      id: "turn-1", status: "completed", mode: "agent", duration_ms: 192000,
    }));
    expect(provider.cumulativeTurnSecs).toBe(192);

    api.getThreadDetail.mockResolvedValue({
      latest_seq: 5,
      thread: { id: "thread-2", model: "deepseek-v4-pro" },
      turns: [{
        id: "turn-9",
        input_summary: "another conversation",
        created_at: "2026-10-27T11:00:00Z",
        ended_at: "2026-10-27T11:00:30Z",
        status: "completed",
        duration_ms: 30000,
        item_ids: ["u9", "a9"],
      }],
      items: [
        { id: "u9", kind: "user_message", summary: "another conversation", detail: "another conversation", status: "completed" },
        { id: "a9", kind: "agent_message", summary: "an answer", detail: "an answer", status: "completed", metadata: null },
      ],
      pending_approvals: [],
      pending_user_inputs: [],
    });
    api.getThread.mockResolvedValue({ id: "thread-2" });

    await (provider as any).loadThread("thread-2");

    expect(provider.cumulativeTurnSecs).toBe(30);
  });
});
