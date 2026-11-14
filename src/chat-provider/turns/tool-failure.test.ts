import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** A tool card whose call did not succeed used to say one word — "error" — and
 *  nothing else. These tests hold the three facts the row now carries: which
 *  ending it was (a stopped turn is not a broken tool), the engine's own
 *  numbers for a command, and the reason a call that never answered left
 *  behind. */

function createProvider(detail: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
    listProviderModels: vi.fn(async () => ({ provider: "custom", models: [{ id: "glm-5.3" }] })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    getThreadContext: vi.fn(async () => undefined),
    getThreadUsage: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  provider.currentThread = { id: "thread-1", mode: "agent", model: "deepseek-v4-pro" } as any;
  provider.messages = [
    { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
  ] as any;
  (provider as any).autoSaveSession = vi.fn();
  (provider as any).scheduleThreadListRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).refreshGoal = vi.fn();
  (provider as any).playCompletionCue = vi.fn();
  (provider as any).refreshTaskList = vi.fn();
  (provider as any).refreshWorkPanel = vi.fn();
  (provider as any).refreshChangesPanel = vi.fn();

  return { provider, postMessage: provider.postMessage as any };
}

function postedMessages(postMessage: any): Record<string, any>[] {
  return postMessage.mock.calls.map((call: unknown[]) => call[0] as Record<string, any>);
}

const ARGS = JSON.stringify({ command: "make test", description: "Full regression", timeout: 1500 });

function startBash(provider: any, id = "call-1") {
  return provider.handleItemEvent({
    event: "item.started",
    item_id: `item-${id}`,
    turn_id: "turn-1",
    payload: {
      item: { kind: "tool_call", id: `item-${id}`, summary: "Bash started" },
      tool: { id, name: "Bash", input: JSON.parse(ARGS) },
    },
  });
}

function endItem(
  provider: any,
  event: "item.failed" | "item.interrupted",
  item: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
  id = "call-1",
) {
  return provider.handleItemEvent({
    event,
    item_id: `item-${id}`,
    turn_id: "turn-1",
    payload: {
      item: { kind: "tool_call", id: `item-${id}`, ...item },
      ...envelope,
    },
  });
}

describe("a tool card that did not succeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls an interrupted call interrupted, and prints no arguments as its output", () => {
    const { provider, postMessage } = createProvider();
    startBash(provider);

    endItem(provider, "item.interrupted", {
      summary: ARGS,
      detail: ARGS,
      status: "interrupted",
      metadata: { tool_use_id: "call-1", tool_name: "Bash", tool_input: ARGS },
    });

    const tc = (provider.messages[0] as any).toolCalls[0];
    expect(tc.status).toBe("error");
    expect(tc.terminalState).toBe("interrupted");
    // The item kept the call's own arguments in `detail` (it never answered);
    // those are arguments, not a result to print as the error.
    expect(tc.output).toBeUndefined();

    const update = postedMessages(postMessage).find((msg) => msg.type === "updateToolCall");
    expect(update?.status).toBe("error");
    expect(update?.terminalState).toBe("interrupted");
    expect(update?.output).toBeUndefined();
  });

  it("carries the engine's exit code, shell status and duration through", () => {
    const { provider, postMessage } = createProvider();
    startBash(provider);

    endItem(provider, "item.failed", {
      summary: "bash failed",
      detail: "Command timed out after 1500ms; process killed.\n\nSTDOUT:\n\nSTDERR:\n",
      status: "failed",
      metadata: {
        tool_use_id: "call-1",
        tool_name: "Bash",
        status: "TimedOut",
        exit_code: null,
        duration_ms: 1500,
        is_error: true,
      },
    });

    const tc = (provider.messages[0] as any).toolCalls[0];
    expect(tc.status).toBe("error");
    expect(tc.terminalState).toBe("failed");
    expect(tc.shellStatus).toBe("TimedOut");
    expect(tc.durationMs).toBe(1500);
    // The engine recorded no exit code at all; the card must not invent one.
    expect(tc.exitCode).toBeUndefined();
    // A real result stays the result.
    expect(tc.output).toContain("Command timed out");

    const update = postedMessages(postMessage).find((msg) => msg.type === "updateToolCall");
    expect(update?.shellStatus).toBe("TimedOut");
    expect(update?.durationMs).toBe(1500);
  });

  it("takes the reason from the envelope when the item has no answer", () => {
    const { provider, postMessage } = createProvider();
    startBash(provider);

    endItem(
      provider,
      "item.failed",
      {
        summary: ARGS,
        detail: ARGS,
        status: "failed",
        metadata: { tool_use_id: "call-1", tool_name: "Bash", tool_input: ARGS },
      },
      { error: "engine process exited while the call was running" },
    );

    const tc = (provider.messages[0] as any).toolCalls[0];
    expect(tc.output).toBeUndefined();
    expect(tc.failureReason).toBe("engine process exited while the call was running");

    const update = postedMessages(postMessage).find((msg) => msg.type === "updateToolCall");
    expect(update?.failureReason).toBe("engine process exited while the call was running");
  });

  it("backfills the turn's reason onto a card the engine settled without one", () => {
    const { provider, postMessage } = createProvider();
    startBash(provider);

    // The engine settled the item where it lay: its own status, no result, and
    // no sentence. The turn that ended it is where the sentence lives.
    endItem(provider, "item.failed", {
      summary: ARGS,
      detail: ARGS,
      status: "failed",
      metadata: { tool_use_id: "call-1", tool_name: "Bash", tool_input: ARGS },
    });
    expect((provider.messages[0] as any).toolCalls[0].failureReason).toBeUndefined();

    (provider as any).currentTurnId = "turn-1";
    (provider as any).handleRuntimeEvent({
      event: "turn.completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      payload: {
        turn: {
          id: "turn-1",
          thread_id: "thread-1",
          status: "failed",
          input_summary: "run the suite",
          created_at: "2026-11-14T10:00:00Z",
          ended_at: "2026-11-14T10:00:05Z",
          error: "provider stream ended unexpectedly",
          item_ids: [],
          steer_count: 0,
        },
      },
    } as any);

    const tc = (provider.messages[0] as any).toolCalls[0];
    expect(tc.failureReason).toBe("provider stream ended unexpectedly");
    const update = postedMessages(postMessage)
      .filter((msg) => msg.type === "updateToolCall")
      .pop();
    expect(update?.failureReason).toBe("provider stream ended unexpectedly");
  });
});

describe("the reason a failed turn leaves on its cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays on this turn's cards, not an earlier turn's", () => {
    // A card from an earlier turn that failed for its own reason (a blocked
    // command, say) is not part of this turn. Handing it this turn's error
    // would attribute one failure to another turn's tool.
    const { provider } = createProvider();
    const earlier = { name: "Bash", input: {}, status: "error" as const };
    provider.messages = [
      { id: "assistant-0", role: "assistant", content: "", blocks: [], toolCalls: [earlier] },
      { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
    ] as any;

    startBash(provider);
    endItem(provider, "item.failed", {
      summary: ARGS,
      detail: ARGS,
      status: "failed",
      metadata: { tool_use_id: "call-1", tool_name: "Bash", tool_input: ARGS },
    });

    (provider as any).currentTurnId = "turn-1";
    (provider as any).handleRuntimeEvent({
      event: "turn.completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      payload: {
        turn: {
          id: "turn-1",
          thread_id: "thread-1",
          status: "failed",
          input_summary: "run the suite",
          created_at: "2026-11-14T10:00:00Z",
          ended_at: "2026-11-14T10:00:05Z",
          error: "provider stream ended unexpectedly",
          item_ids: [],
          steer_count: 0,
        },
      },
    } as any);

    const current = (provider.messages[1] as any).toolCalls[0];
    expect(current.failureReason).toBe("provider stream ended unexpectedly");
    expect((earlier as any).failureReason).toBeUndefined();
  });
});

describe("a reloaded tool card that did not succeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the ending the item recorded instead of folding it into \"error\"", async () => {
    const detail = {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the suite",
          created_at: "2026-11-14T10:00:00Z",
          ended_at: "2026-11-14T10:00:05Z",
          status: "interrupted",
          error: "interrupted by the user",
          item_ids: ["u1", "t1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the suite", detail: "run the suite", status: "completed" },
        {
          id: "t1",
          kind: "tool_call",
          summary: ARGS,
          detail: ARGS,
          status: "interrupted",
          metadata: {
            tool_use_id: "call-1",
            tool_name: "Bash",
            tool_input: ARGS,
            tool_result_for: "call-1",
            is_error: true,
          },
        },
      ],
    };

    const { provider } = createProvider(detail);
    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length || 0) > 0,
    );
    expect(assistant).toBeDefined();
    const tc = assistant!.toolCalls![0];
    expect(tc.status).toBe("error");
    expect(tc.terminalState).toBe("interrupted");
    // The recording never held a result, so there is none to show — and the
    // arguments must not be dressed up as one.
    expect(tc.output).toBeUndefined();
  });

  it("shows the engine's numbers on a reloaded command that failed", async () => {
    const detail = {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the suite",
          created_at: "2026-11-14T10:00:00Z",
          ended_at: "2026-11-14T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the suite", detail: "run the suite", status: "completed" },
        {
          id: "t1",
          kind: "tool_call",
          summary: "Bash failed: exit 2",
          detail: "Command failed (exit code 2)\n\nSTDOUT:\n\nSTDERR:\nzsh: no such file",
          status: "failed",
          metadata: {
            tool_use_id: "call-1",
            tool_name: "Bash",
            tool_input: ARGS,
            tool_result_for: "call-1",
            is_error: true,
            status: "Completed",
            exit_code: 2,
            duration_ms: 12_000,
          },
        },
      ],
    };

    const { provider } = createProvider(detail);
    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length || 0) > 0,
    );
    const tc = assistant!.toolCalls![0];
    expect(tc.terminalState).toBe("failed");
    expect(tc.exitCode).toBe(2);
    expect(tc.durationMs).toBe(12_000);
    expect(tc.output).toContain("no such file");
  });
});
