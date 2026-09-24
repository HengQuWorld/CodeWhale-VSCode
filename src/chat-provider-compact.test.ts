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
import { t } from "./i18n";

/** The manual-compaction turn the stubbed engine accepts. */
const COMPACT_TURN_ID = "turn_compact";
const ENGINE_RESULT =
  "Compaction complete: 12 → 5 messages (7 removed), ~34000 → ~9000 tokens (full coverage)";

function emptyDetail() {
  return { latest_seq: 0, thread: { id: "thread-1" }, turns: [], items: [] };
}

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    compactThread: vi.fn(async () => ({
      thread: { id: "thread-1" },
      turn: { id: COMPACT_TURN_ID },
    })),
    getThreadDetail: vi.fn(async () => emptyDetail()),
    getThread: vi.fn(async () => ({ id: "thread-1" })),
    getThreadUsageBucket: vi.fn(async () => undefined),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).autoSaveSession = vi.fn();
  (provider as any).scheduleThreadListRefresh = vi.fn();
  (provider as any).refreshGoal = vi.fn();

  provider.currentThread = { id: "thread-1" } as any;
  (provider as any).currentTurnId = null;

  return { provider, api, postMessage: provider.postMessage as any };
}

/** A runtime event for the compaction turn, as the engine publishes it. */
function compactionEvent(event: string, payload: Record<string, unknown>) {
  return {
    seq: 1,
    event,
    turn_id: COMPACT_TURN_ID,
    item_id: "item_compact",
    payload,
  } as any;
}

function posted(postMessage: any): any[] {
  return postMessage.mock.calls.map((call: any[]) => call[0]);
}

/** Let the completion path's extra read settle before asserting on it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function said(postMessage: any, message: string): boolean {
  return posted(postMessage).some((m: any) => m.message === message);
}

describe("ChatProvider manual compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tracks the accepted turn without claiming the work is done", async () => {
    const { provider, api, postMessage } = createProvider();

    await (provider as any).handleCompact();

    expect(api.compactThread).toHaveBeenCalledWith("thread-1");
    expect(posted(postMessage)).toContainEqual({
      type: "status",
      text: t().contextCompactionStarted,
    });
    // The wait between the two lines produces no tokens, so it is carried by
    // the status bar's activity indicator.
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: true });
    // The engine returns 202 and does the work asynchronously: nothing may
    // report a result before the engine's own completion event arrives.
    expect(said(postMessage, t().contextCompacted)).toBe(false);
    expect((provider as any).compactionTurns.has(COMPACT_TURN_ID)).toBe(true);
  });

  it("shows the compaction starting in the conversation window", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.started", { item: { kind: "context_compaction" } })
    );

    expect(posted(postMessage)).toContainEqual({
      type: "info",
      message: t().contextCompactionStarted,
    });
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: true });
  });

  it("shows the engine's own result when the compaction completes", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
      })
    );
    await settle();

    // The engine's text is the result — it carries the message and token
    // deltas, which a client-side template could not reconstruct. It is also
    // what the persisted item holds, so the reloaded view matches.
    expect(posted(postMessage)).toContainEqual({ type: "info", message: ENGINE_RESULT });
    // The bar said "compacting"; nothing upstream repaints it on success.
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: false });
    expect(posted(postMessage)).toContainEqual({ type: "status", text: t().ready });
  });

  it("falls back to the plain note when the engine sends no text", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", { item: { kind: "context_compaction" } })
    );
    await settle();

    expect(said(postMessage, t().contextCompacted)).toBe(true);
  });

  it("carries the handoff summary the engine committed, collapsed on the result", async () => {
    const { provider, api, postMessage } = createProvider();
    api.getThread.mockResolvedValue({
      id: "thread-1",
      system_prompt: `You are helpful.\n\n<!-- compaction-summary:begin -->\nThe user asked for X.\n<!-- compaction-summary:end -->`,
    } as any);
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
      })
    );
    await settle();

    // The result line says what compaction did; the summary says what the
    // conversation became. Both, on the same note.
    expect(posted(postMessage)).toContainEqual({
      type: "info",
      message: ENGINE_RESULT,
      compactionSummary: "The user asked for X.",
    });
  });

  it("reads the summary for the thread the pass ran on, not the one on screen later", async () => {
    const { provider, api, postMessage } = createProvider();
    let release: (thread: any) => void = () => {};
    api.getThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
      })
    );
    // The user switches threads while the read is still in flight.
    provider.currentThread = { id: "thread-2" } as any;
    release({
      id: "thread-1",
      system_prompt: "<!-- compaction-summary:begin -->\nhandoff\n<!-- compaction-summary:end -->",
    });
    await settle();

    expect(api.getThread).toHaveBeenCalledWith("thread-1");
    expect(posted(postMessage)).toContainEqual({
      type: "info",
      message: ENGINE_RESULT,
      compactionSummary: "handoff",
    });
  });

  it("still reports the outcome when the summary cannot be read", async () => {
    const { provider, api, postMessage } = createProvider();
    api.getThread.mockRejectedValue(new Error("engine went away"));
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
      })
    );
    await settle();

    // The body is a bonus; losing it must not cost the result or leave the
    // activity indicator spinning.
    expect(posted(postMessage)).toContainEqual({ type: "info", message: ENGINE_RESULT });
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: false });
  });

  it("reports an engine-declared failure with the engine's own text", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleCompact();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.failed", {
        item: {
          kind: "context_compaction",
          detail: "Manual context compaction failed: provider returned 503",
        },
      })
    );

    expect(posted(postMessage)).toContainEqual({
      type: "error",
      message: `${t().compactFailed}: Manual context compaction failed: provider returned 503`,
    });
    // The activity indicator stops even though the failure text stays.
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: false });
  });

  it("clears the in-progress bar when a compaction is cancelled", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleCompact();
    postMessage.mockClear();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.canceled", {
        item: { kind: "context_compaction", detail: "Context compaction canceled" },
      })
    );

    // The engine sends no status for a cancellation, so nothing else would
    // stop the bar claiming the pass is still running.
    expect(posted(postMessage)).toContainEqual({ type: "busy", active: false });
    expect(posted(postMessage)).toContainEqual({ type: "status", text: t().ready });
    // Nothing was changed, so nothing is claimed about the outcome either.
    expect(said(postMessage, t().contextCompacted)).toBe(false);
  });

  it("reports the outcome even when the transcript has no assistant message", async () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [];
    await (provider as any).handleCompact();

    // Nothing to route an item to: a report that went through the
    // assistant-message guard would be dropped here.
    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
      })
    );
    await settle();

    expect(said(postMessage, ENGINE_RESULT)).toBe(true);
  });

  it("says nothing for an auto compaction's items", async () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(
      compactionEvent("item.completed", {
        item: { kind: "context_compaction", detail: ENGINE_RESULT },
        auto: true,
      })
    );

    // The engine's own housekeeping keeps the status-only treatment; the
    // manual path is the one that owes the user a report.
    expect(said(postMessage, ENGINE_RESULT)).toBe(false);
  });

  it("refuses while a turn is running, without asking the engine", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentTurnId = "turn_running";

    await (provider as any).handleCompact();

    // A compaction is itself a turn, so the engine would refuse this with
    // "Thread already has an active turn"; the click is answered with the way
    // out instead of a doomed round trip.
    expect(api.compactThread).not.toHaveBeenCalled();
    expect(said(postMessage, t().compactRefusedActiveTurn)).toBe(true);
  });

  it("says so when there is no conversation open", async () => {
    const { provider, api, postMessage } = createProvider();
    provider.currentThread = null;

    await (provider as any).handleCompact();

    expect(api.compactThread).not.toHaveBeenCalled();
    expect(said(postMessage, t().compactNoThread)).toBe(true);
  });

  it("surfaces an engine refusal of the request itself", async () => {
    const { provider, api, postMessage } = createProvider();
    api.compactThread.mockRejectedValueOnce(new Error("API error 404: no such route"));

    await (provider as any).handleCompact();

    expect(posted(postMessage)).toContainEqual({
      type: "error",
      message: `${t().compactFailed}: API error 404: no such route`,
    });
  });

  it("does not re-finalize the last answer when the compaction turn ends", async () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [
      { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
      { id: "a1", role: "assistant", content: "done", status: "complete", timestamp: 2, blocks: [] },
    ] as any;
    await (provider as any).handleCompact();
    postMessage.mockClear();

    (provider as any).handleRuntimeEvent({
      seq: 9,
      event: "turn.completed",
      turn_id: COMPACT_TURN_ID,
      payload: { turn: { id: COMPACT_TURN_ID, mode: "plan", status: "completed" } },
    } as any);

    const messages = posted(postMessage);
    // Re-finalizing would stamp the compaction's usage onto the previous
    // answer, and (in Plan mode) offer it as a plan to approve.
    expect(messages.some((m: any) => m.type === "messageComplete")).toBe(false);
    expect(messages.some((m: any) => m.planApproval)).toBe(false);
    // The turn was drained, not merely skipped.
    expect((provider as any).compactionTurns.has(COMPACT_TURN_ID)).toBe(false);
  });

  it("keeps a compaction started elsewhere out of the turn-completion handling", async () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [
      { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
      { id: "a1", role: "assistant", content: "done", status: "complete", timestamp: 2, blocks: [] },
    ] as any;
    // No handleCompact(): this view never placed the request, so the turn id is
    // only knowable from the item event itself.
    (provider as any).handleRuntimeEvent(
      compactionEvent("item.started", { item: { kind: "context_compaction" } })
    );
    postMessage.mockClear();

    (provider as any).handleRuntimeEvent({
      seq: 9,
      event: "turn.completed",
      turn_id: COMPACT_TURN_ID,
      payload: { turn: { id: COMPACT_TURN_ID, mode: "plan", status: "completed" } },
    } as any);

    const messages = posted(postMessage);
    expect(messages.some((m: any) => m.type === "messageComplete")).toBe(false);
    expect(messages.some((m: any) => m.planApproval)).toBe(false);
  });

  it("still finalizes an ordinary turn", async () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [
      { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
      { id: "a1", role: "assistant", content: "writing", status: "streaming", timestamp: 2, blocks: [] },
    ] as any;

    (provider as any).handleRuntimeEvent({
      seq: 9,
      event: "turn.completed",
      turn_id: "turn_other",
      payload: { turn: { id: "turn_other", mode: "agent", status: "completed" } },
    } as any);

    expect(
      posted(postMessage).some((m: any) => m.type === "messageComplete" && m.messageId === "a1")
    ).toBe(true);
  });
});

describe("ChatProvider compaction in a rebuilt transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The shape the engine stores for a compaction pass: one turn whose only
   *  item is the compaction, with the engine's label as the turn summary. */
  function historyWithCompaction() {
    return {
      latest_seq: 7,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        { id: "turn-1", input_summary: "hello", status: "completed", item_ids: ["u1", "a1"] },
        {
          id: COMPACT_TURN_ID,
          input_summary: "Manual context compaction",
          status: "completed",
          item_ids: ["c1"],
          created_at: "2026-06-18T10:00:00Z",
          ended_at: "2026-06-18T10:00:05Z",
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "hello", detail: "hello", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "hi", detail: "hi", status: "completed" },
        {
          id: "c1",
          kind: "context_compaction",
          summary: "Compaction complete: 12 → 5 messages",
          detail: ENGINE_RESULT,
          status: "completed",
        },
      ],
    };
  }

  it("replays a compaction as one note, not a question and an answer", async () => {
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValueOnce(historyWithCompaction() as any);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.map((m: any) => `${m.role}:${m.content}`)).toEqual([
      "user:hello",
      "assistant:hi",
      `system:${ENGINE_RESULT}`,
    ]);
    // Before this was handled, both input_summary fallbacks fired and the
    // engine's label for the request was printed as a question and an answer.
    expect(
      provider.messages.some((m: any) => String(m.content).includes("Manual context compaction"))
    ).toBe(false);
  });

  it("carries the handoff summary on the newest compaction note only", async () => {
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValueOnce({
      latest_seq: 9,
      thread: {
        id: "thread-1",
        model: "deepseek-v4-pro",
        system_prompt:
          "Base.\n\n<!-- compaction-summary:begin -->\ncurrent handoff\n<!-- compaction-summary:end -->",
      },
      turns: [
        { id: "turn_c1", input_summary: "Manual context compaction", status: "completed", item_ids: ["c1"] },
        { id: "turn-1", input_summary: "hello", status: "completed", item_ids: ["u1", "a1"] },
        { id: "turn_c2", input_summary: "Manual context compaction", status: "completed", item_ids: ["c2"] },
      ],
      items: [
        { id: "c1", kind: "context_compaction", summary: "first", detail: "Compaction complete: 96 → 9 messages", status: "completed" },
        { id: "u1", kind: "user_message", summary: "hello", detail: "hello", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "hi", detail: "hi", status: "completed" },
        { id: "c2", kind: "context_compaction", summary: "second", detail: "Compaction complete: 40 → 7 messages", status: "completed" },
      ],
    } as any);

    await (provider as any).loadHistory("thread-1");

    const notes = provider.messages.filter((m: any) => m.role === "system");
    expect(notes).toHaveLength(2);
    // The engine keeps one summary — a later pass replaces it — so the older
    // note must not claim the current one.
    expect(notes[0].compactionSummary).toBeUndefined();
    expect(notes[1].compactionSummary).toBe("current handoff");
  });

  it("keeps rendering an ordinary turn through the fallbacks", async () => {
    const { provider, api } = createProvider();
    api.getThreadDetail.mockResolvedValueOnce({
      latest_seq: 3,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [{ id: "turn-1", input_summary: "run the tests", status: "completed", item_ids: [] }],
      items: [],
    } as any);

    await (provider as any).loadHistory("thread-1");

    // A turn whose items carry no text still shows its input summary, as before.
    expect(provider.messages.map((m: any) => `${m.role}:${m.content}`)).toEqual([
      "user:run the tests",
      "assistant:run the tests",
    ]);
  });
});
