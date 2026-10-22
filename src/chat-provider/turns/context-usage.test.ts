import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

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

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThreadContext: vi.fn(async () => contextResponse()),
    // The send path re-reads the thread to catch one the engine discarded; a
    // stand-in that throws would send it down the recovery branch instead.
    getThread: vi.fn(async (id: string) => ({
      id,
      mode: "agent",
      model: "deepseek-v4-pro",
      workspace: "/tmp/repo",
    })),
    getThreadUsageBucket: vi.fn(async () => null),
    interruptTurn: vi.fn(async () => undefined),
    startTurn: vi.fn(async () => ({ turn: { id: "turn-2" } })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshTaskList = vi.fn();
  provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
  provider.messages = [
    { id: "u0", role: "user", content: "earlier", status: "complete", timestamp: 1 },
    { id: "a0", role: "assistant", content: "earlier answer", status: "complete", timestamp: 2 },
  ] as any;
  (provider as any).apiCapabilities.threadContext = true;

  return { provider, api, postMessage: provider.postMessage as any };
}

function contextMessages(postMessage: ReturnType<typeof vi.fn>): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === "contextUsage");
}

describe("ChatProvider's context-window reading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the prompt estimate as the send goes out, without holding the send", async () => {
    // The engine runs a turn inside its own loop, so a read issued *after* the
    // send waits for the turn to finish, and one awaited *before* it delays the
    // user's message. Issued first and left unawaited, on an idle engine it
    // answers in milliseconds — before the first token — with the estimate of
    // the prompt this very turn sends.
    const { provider, api, postMessage } = createProvider();

    await (provider as any).handleSendMessage("carry on");

    // Issued before the turn started, and the send did not wait for it: the
    // turn was requested in the same tick rather than after the read settled.
    expect(api.getThreadContext).toHaveBeenCalledWith("thread-1");
    expect(api.getThreadContext.mock.invocationCallOrder[0]).toBeLessThan(
      api.startTurn.mock.invocationCallOrder[0],
    );

    await vi.waitFor(() => expect(contextMessages(postMessage)).toHaveLength(1));
    expect(contextMessages(postMessage)[0]).toEqual({
      type: "contextUsage",
      percent: 42,
      usedTokens: 53760,
      windowTokens: 128000,
    });
  });

  it("still sends when the reading is unavailable", async () => {
    // The chip is a reading, not a precondition: an engine that cannot answer
    // the context route must not stop a message from being sent.
    const { provider, api, postMessage } = createProvider();
    api.getThreadContext = vi.fn(async () => {
      throw new Error("API error 404: no such route");
    });

    await (provider as any).handleSendMessage("carry on");

    expect(api.startTurn).toHaveBeenCalled();
    expect(contextMessages(postMessage)).toEqual([]);
    expect(
      (postMessage.mock.calls as any[])
        .map((call) => call[0])
        .filter((msg) => msg.type === "error"),
    ).toEqual([]);
  });

  it("does not ask while a turn this view is holding is running", async () => {
    // The engine is busy by definition, the request would queue behind the
    // turn, and the reading taken when that turn started is the right one.
    const { provider, api } = createProvider();
    (provider as any).currentTurnId = "turn-1";

    await (provider as any).refreshThreadContext("thread-1");

    expect(api.getThreadContext).not.toHaveBeenCalled();
  });

  it("reads again once the turn settles, whose estimate is the next prompt's", async () => {
    const { provider, api, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent({
      seq: 9,
      timestamp: "2026-10-21T00:00:00Z",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: null,
      event: "turn.completed",
      payload: { turn: { id: "turn-1", status: "completed" } },
    });
    // The read is fire-and-forget: it must not hold up turn completion's other
    // bookkeeping, so let its promise settle before asserting on the message.
    await vi.waitFor(() => expect(contextMessages(postMessage)).toHaveLength(1));

    expect(api.getThreadContext).toHaveBeenCalledWith("thread-1");
  });

  it("drops a reading for a thread the view has already left", async () => {
    const { provider, postMessage } = createProvider();
    let settle: ((value: unknown) => void) | undefined;
    const api = (provider as any).api;
    api.getThreadContext = vi.fn(
      () => new Promise((resolve) => { settle = resolve; })
    );

    const inFlight = (provider as any).refreshThreadContext("thread-1");
    // The user switches conversations while the request is out.
    provider.currentThread = { id: "thread-2" } as any;
    settle?.(contextResponse());
    await inFlight;

    expect(contextMessages(postMessage)).toEqual([]);
  });

  it("says nothing when the route cannot bound a window", async () => {
    const { provider, api, postMessage } = createProvider();
    // A route with no declared window cannot produce a percentage; the host
    // forwards the null rather than inventing a zero, and the chip stays off.
    api.getThreadContext = vi.fn(async () =>
      contextResponse({ window_tokens: null, input_tokens: null, usage_percent: null, pressure: null })
    );

    await (provider as any).refreshThreadContext();

    expect(contextMessages(postMessage)).toEqual([
      {
        type: "contextUsage",
        percent: null,
        usedTokens: null,
        windowTokens: null,
      },
    ]);
  });

  it("clears the reading when the view moves to another thread", async () => {
    // The chip describes one conversation. A thread switch that left the old
    // percentage on screen would label the new conversation with the old one's
    // context — the most misleading thing this chip could do.
    const { provider, api, postMessage } = createProvider();
    // Everything loadThread touches beyond the reading is out of scope here.
    (provider as any).loadHistory = vi.fn(async () => 0);
    (provider as any).subscribeToEvents = vi.fn();
    (provider as any).refreshWorkPanel = vi.fn();
    (provider as any).refreshSessionList = vi.fn();
    (provider as any).refreshTaskList = vi.fn();
    (provider as any).refreshAgentRuns = vi.fn();
    (provider as any).scheduleThreadListRefresh = vi.fn();
    (provider as any).refreshThreadUsage = vi.fn(async () => undefined);

    await (provider as any).loadThread("thread-2");

    expect(contextMessages(postMessage)).toContainEqual({ type: "contextUsage", percent: null });
    // And the reading was not silently re-fetched for the thread being opened:
    // browsing a conversation must not load its engine just to paint a chip.
    expect(api.getThreadContext).not.toHaveBeenCalled();
  });

  it("never asks an engine that predates the context route", async () => {
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.threadContext = false;

    await (provider as any).refreshThreadContext();

    expect(api.getThreadContext).not.toHaveBeenCalled();
  });
});
