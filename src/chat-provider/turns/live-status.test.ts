import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** The engine's context-window posture, as `/v1/threads/{id}/context` answers
 *  it between turns. */
function contextResponse(overrides: Record<string, unknown> = {}) {
  return {
    thread_id: "thread-1",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    model_provider_id: null,
    live: true,
    window_tokens: 128000,
    window_source: "engine_active_route",
    input_tokens: 53760,
    billed_input_tokens: 51200,
    output_cap_tokens: 8192,
    input_budget_ceiling: 118784,
    available_input_tokens: 65024,
    compaction_trigger_tokens: 96000,
    usage_percent: 42,
    pressure: "moderate",
    ...overrides,
  };
}

function totals(overrides: Record<string, unknown> = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    cost_cny: 0,
    turns: 0,
    ...overrides,
  };
}

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThreadUsage: vi.fn(async () => totals()),
    getThreadContext: vi.fn(async () => contextResponse()),
    getThreadUsageBucket: vi.fn(async () => undefined),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn();
  provider.refreshTaskList = vi.fn();
  (provider as any).autoSaveSession = vi.fn();
  (provider as any).scheduleThreadListRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).refreshGoal = vi.fn();
  (provider as any).playCompletionCue = vi.fn();

  provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
  provider.messages = [];
  (provider as any).currentTurnId = "turn-2";
  (provider as any).apiCapabilities.threadUsage = true;
  (provider as any).apiCapabilities.threadContext = true;

  return { provider, api, postMessage: provider.postMessage as any };
}

/** One model call's receipt, as `monitor_turn` publishes it. */
function stepReceipt(payload: Record<string, unknown> = {}) {
  return {
    seq: 1,
    event: "turn.usage",
    thread_id: "thread-1",
    turn_id: "turn-2",
    item_id: null,
    payload: {
      usage: {
        input_tokens: 400,
        output_tokens: 100,
        prompt_cache_hit_tokens: 300,
        prompt_cache_miss_tokens: 100,
      },
      billed_prompt_tokens: 400,
      cost: { usd: 0.02, cny: 0.14, usd_priced: true, cny_priced: true },
      ...payload,
    },
  } as any;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function messagesOf(postMessage: any, type: string): any[] {
  return postMessage.mock.calls
    .map((call: any[]) => call[0])
    .filter((msg: any) => msg.type === type);
}

function lastOf(postMessage: any, type: string): any {
  const all = messagesOf(postMessage, type);
  return all[all.length - 1];
}

describe("ChatProvider's live status while a turn runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a step's tokens and price to the settled totals", () => {
    const { provider, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;
    provider.totalInputTokens = 1000;
    provider.totalOutputTokens = 500;
    provider.totalTokens = 1500;

    (provider as any).handleRuntimeEvent(stepReceipt());

    const stats = lastOf(postMessage, "sessionStats");
    expect(stats.cost).toBe("$0.12");
    expect(stats.totalInputTokens).toBe(1400);
    expect(stats.totalOutputTokens).toBe(600);
    // 1000 + 400 in, 500 + 100 out.
    expect(stats.totalTokens).toBe(2000);
    // The chip describes the call in flight, so the cache rate follows this
    // turn's own samples rather than the previous turn's.
    expect(stats.cacheHitRate).toBe("75.0");
  });

  it("keeps climbing across the calls within one turn", () => {
    // A tool-calling turn is several model calls. Each receipt moves the bar,
    // which is what makes the reading useful mid-turn rather than only at the
    // end.
    const { provider, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;

    (provider as any).handleRuntimeEvent(stepReceipt());
    const afterFirst = lastOf(postMessage, "sessionStats");
    (provider as any).handleRuntimeEvent(stepReceipt());
    const afterSecond = lastOf(postMessage, "sessionStats");

    expect(afterFirst.cost).toBe("$0.12");
    expect(afterSecond.cost).toBe("$0.14");
    expect(afterFirst.totalOutputTokens).toBe(100);
    expect(afterSecond.totalOutputTokens).toBe(200);
  });

  it("leaves the cost alone when the route cannot price the step", () => {
    // An unpriced step is not a free step: the settled total stays the record
    // of what it cost, and the live figure never invents a number.
    const { provider, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;

    (provider as any).handleRuntimeEvent(stepReceipt({ cost: null }));

    const stats = lastOf(postMessage, "sessionStats");
    expect(stats.cost).toBe("$0.10");
    expect(stats.totalInputTokens).toBe(400);
  });

  it("lifts the context chip to the prompt the provider billed", async () => {
    // The settled reading says 42% — the estimate of the prompt the turn sent.
    // Once the provider reports the call, the meter moves to the size it
    // actually processed, which is what decides whether the next turn fits.
    const { provider, postMessage } = createProvider();
    // Between turns the engine answers; an in-flight turn would own it.
    (provider as any).currentTurnId = null;
    await (provider as any).refreshThreadContext("thread-1");
    expect(lastOf(postMessage, "contextUsage").percent).toBeCloseTo(42, 5);
    (provider as any).currentTurnId = "turn-2";

    (provider as any).handleRuntimeEvent(
      stepReceipt({ billed_prompt_tokens: 90000 }),
    );

    const chip = lastOf(postMessage, "contextUsage");
    expect(chip.usedTokens).toBe(90000);
    expect(chip.windowTokens).toBe(128000);
    expect(chip.percent).toBeCloseTo((90000 / 128000) * 100, 5);
  });

  it("shows no percentage without a settled reading to name the window", () => {
    // A receipt carries tokens but never the window. Rather than invent one,
    // the chip stays hidden until the engine reports the route's window.
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(stepReceipt());

    const chip = lastOf(postMessage, "contextUsage");
    expect(chip.percent).toBeNull();
    expect(chip.windowTokens).toBeNull();
    // The prompt count itself is a fact and is kept for the tooltip.
    expect(chip.usedTokens).toBe(400);
  });

  it("does not count a turn's own steps twice once it settles", async () => {
    const { provider, api, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;
    provider.totalInputTokens = 1000;
    provider.totalOutputTokens = 500;
    provider.totalTokens = 1500;
    api.getThreadUsage.mockResolvedValue(
      totals({ input_tokens: 1400, output_tokens: 600, cost_usd: 0.12, turns: 1 }),
    );

    (provider as any).handleRuntimeEvent(stepReceipt());
    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "turn.completed",
      thread_id: "thread-1",
      turn_id: "turn-2",
      item_id: null,
      payload: {
        turn: {
          id: "turn-2",
          status: "completed",
          usage: { input_tokens: 400, output_tokens: 100 },
        },
      },
    } as any);
    await settle();

    const stats = lastOf(postMessage, "sessionStats");
    expect(api.getThreadUsage).toHaveBeenCalledWith("thread-1");
    // The settled fetch is authoritative: the turn's tokens appear once, not
    // once from the receipt and again from the store.
    expect(stats.totalInputTokens).toBe(1400);
    expect(stats.totalOutputTokens).toBe(600);
    expect(stats.cost).toBe("$0.12");
    expect(
      (provider as any).liveTurnUsageByThread.get("thread-1"),
    ).toBeUndefined();
  });

  it("drops the chip when compaction rewrites the conversation", async () => {
    const { provider, postMessage } = createProvider();
    // Between turns the engine answers; an in-flight turn would own it.
    (provider as any).currentTurnId = null;
    await (provider as any).refreshThreadContext("thread-1");
    expect(lastOf(postMessage, "contextUsage").percent).toBeCloseTo(42, 5);
    (provider as any).currentTurnId = "turn-2";

    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "item.completed",
      thread_id: "thread-1",
      turn_id: "turn-2",
      item_id: "item_compact",
      payload: {
        item: {
          id: "item_compact",
          kind: "context_compaction",
          status: "completed",
          summary: "Compaction complete",
        },
      },
    } as any);

    // The pre-compaction reading describes a prompt that no longer exists.
    expect(lastOf(postMessage, "contextUsage")).toEqual({
      type: "contextUsage",
      percent: null,
    });
  });

  it("repaints the chip from the next step after a compaction", () => {
    // The window belongs to the route the compaction did not change, so the
    // reading it was measured against survives: the first receipt of the
    // still-running turn can paint a truthful percentage again instead of
    // leaving the chip blank until the turn ends.
    const { provider, postMessage } = createProvider();
    (provider as any).currentTurnId = null;
    return (provider as any).refreshThreadContext("thread-1").then(() => {
      (provider as any).currentTurnId = "turn-2";

      (provider as any).handleRuntimeEvent({
        seq: 2,
        event: "item.completed",
        thread_id: "thread-1",
        turn_id: "turn-2",
        item_id: "item_compact",
        payload: {
          item: { id: "item_compact", kind: "context_compaction", status: "completed" },
        },
      } as any);
      expect(lastOf(postMessage, "contextUsage").percent).toBeNull();

      (provider as any).handleRuntimeEvent(
        stepReceipt({ billed_prompt_tokens: 32000 }),
      );

      const chip = lastOf(postMessage, "contextUsage");
      expect(chip.windowTokens).toBe(128000);
      expect(chip.usedTokens).toBe(32000);
      expect(chip.percent).toBeCloseTo(25, 5);
    });
  });

  it("keeps a running turn's figure when the view leaves and comes back", () => {
    // The runtime records a turn's usage only when the turn ends, so the
    // settled totals cannot restore what a running turn has spent. The figure
    // is therefore kept per thread: switching away must not reset the cost to
    // the settled total (which read as "starting over from zero").
    const { provider, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;

    (provider as any).handleRuntimeEvent(stepReceipt());
    (provider as any).handleRuntimeEvent(stepReceipt());
    expect(lastOf(postMessage, "sessionStats").cost).toBe("$0.14");

    // Park it and look at another conversation.
    provider.currentThread = { id: "thread-2", mode: "agent", model: "deepseek-v4-pro" } as any;
    (provider as any).sendSessionStats();
    expect(lastOf(postMessage, "sessionStats").cost).toBe("$0.10");

    // Back to the running one: its own figure is still there.
    provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
    (provider as any).sendSessionStats();
    expect(lastOf(postMessage, "sessionStats").cost).toBe("$0.14");
    expect(lastOf(postMessage, "sessionStats").totalOutputTokens).toBe(200);
  });

  it("keeps counting a parked thread's turn from its background watch", () => {
    // A parked conversation keeps running server-side. The watcher already
    // sees its events, so the running figure stays current while the user
    // works elsewhere — returning shows what the turn has spent so far.
    const { provider, postMessage } = createProvider();
    provider.sessionCostUsd = 0.1;
    provider.displayedCostHighWaterUsd = 0.1;
    (provider as any).backgroundThreads.set("thread-1", {
      lastEventSeq: 0,
      currentTurnId: "turn-2",
      running: true,
      attention: 0,
      sessionId: null,
      goal: null,
      goalChecked: true,
    });

    (provider as any).handleBackgroundEvent("thread-1", stepReceipt());

    provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
    (provider as any).sendSessionStats();
    expect(lastOf(postMessage, "sessionStats").cost).toBe("$0.12");
    expect(lastOf(postMessage, "sessionStats").totalOutputTokens).toBe(100);
  });

  it("keeps the context reading when the view returns to an idle thread", () => {
    // Switching away must not blank a conversation's chip: the reading is
    // stored against the thread that owns it, so coming back repaints it
    // without asking the engine (which would load one just to paint a chip).
    const { provider, postMessage } = createProvider();
    (provider as any).currentTurnId = null;
    return (provider as any).refreshThreadContext("thread-1").then(() => {
      // Park and look at another conversation.
      provider.currentThread = { id: "thread-2", mode: "agent", model: "deepseek-v4-pro" } as any;
      (provider as any).publishContextUsage();
      expect(lastOf(postMessage, "contextUsage")).toEqual({
        type: "contextUsage",
        percent: null,
      });

      // Back: the thread's own reading is still there.
      provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
      (provider as any).publishContextUsage();
      expect(lastOf(postMessage, "contextUsage").percent).toBeCloseTo(42, 5);
    });
  });
});
