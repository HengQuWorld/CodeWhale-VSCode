import { describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";
import { friendlyToolName } from "../../utils/tool-utils";

function createProvider(detail: Record<string, unknown>) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
    // The model menu asks the runtime for the route's catalog; a test that
    // exercises the chip's model needs the answer to come from a route.
    listProviderModels: vi.fn(async () => ({
      provider: "custom",
      models: [{ id: "glm-5.3" }, { id: "glm-5.4" }],
    })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();

  return { provider, api, postMessage: provider.postMessage as any };
}

// ── Pending attention survives the rebuild ──
//
// A thread that is waiting on the user must still be waiting when the user
// switches to it. The runtime keeps the waiter across a view switch, but the
// `approval.required` event that announced it sits behind the cursor the
// rebuilt view resumes from (`replay_events` skips `seq <= since_seq`), so the
// typed pending list — and the tool row its correlator names — is the only
describe("ChatProvider pending attention across a rebuild", () => {
  /** Every message the provider pushed to the webview, in order. */
  function postedMessages(postMessage: any): Record<string, any>[] {
    return postMessage.mock.calls.map((call: unknown[]) => call[0] as Record<string, any>);
  }

  /** The rebuilt tool row history restored, by the provider call id. */
  function toolRow(provider: any, itemId: string): Record<string, any> | undefined {
    return provider.messages
      .flatMap((message: Record<string, any>) => message.toolCalls ?? [])
      .find((call: Record<string, any>) => call.itemId === itemId);
  }

  const approvalRow = {
    id: "approval-1",
    turn_id: "turn-1",
    tool_name: "shell",
    description: "run the test suite",
    tool_call_id: "call-1",
  };

  const pendingQuestion = {
    id: "input-1",
    turn_id: "turn-1",
    request: {
      questions: [
        {
          header: "Environment",
          id: "q1",
          question: "Which environment?",
          options: [{ label: "Staging", description: "" }],
        },
      ],
    },
  };

  function detailWith(overrides: Record<string, unknown>) {
    return {
      latest_seq: 7,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the suite",
          created_at: "2026-09-18T10:00:00Z",
          ended_at: "2026-09-18T10:00:02Z",
          status: "completed",
          item_ids: ["item-1", "assistant-1"],
        },
      ],
      items: [
        {
          id: "item-1",
          kind: "tool_call",
          summary: "shell started",
          detail: null,
          status: "in_progress",
          metadata: { tool_use_id: "call-1", tool_name: "shell" },
        },
        {
          id: "assistant-1",
          kind: "agent_message",
          summary: "Which environment?",
          detail: "Which environment?",
          status: "completed",
          metadata: null,
        },
      ],
      ...overrides,
    };
  }

  it("seeds the tool row a pending approval gates, before the rebuild is posted", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_approvals: [approvalRow] }),
    );

    await (provider as any).loadHistory("thread-1");

    const call = toolRow(provider, "call-1");
    expect(call?.status).toBe("awaiting_approval");
    expect(call?.approvalId).toBe("approval-1");
    expect(call?.approvalSummary).toBe("run the test suite");
    expect(call?.displayName).toBe(friendlyToolName("shell"));

    // The renderer draws the request's line from this state, so the seeded row
    // has to be the one the rebuild carries — the same object the webview is
    // handed, not a copy patched in afterwards.
    const rebuild = postedMessages(postMessage).find((message) => message.type === "loadHistory");
    const carried = rebuild?.messages
      .flatMap((message: Record<string, any>) => message.toolCalls ?? [])
      .find((toolCall: Record<string, any>) => toolCall.itemId === "call-1");
    expect(carried?.approvalId).toBe("approval-1");

    // A row that rendered already carries the request: it is not offered again.
    expect(postedMessages(postMessage).some((message) => message.type === "approvalRequired")).toBe(
      false,
    );
  });

  it("offers an approval with no tool row to hang on, after the rebuild", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({
        pending_approvals: [{ ...approvalRow, tool_call_id: "call-from-a-lost-item" }],
      }),
    );

    await (provider as any).loadHistory("thread-1");

    const posted = postedMessages(postMessage);
    const offered = posted.find((message) => message.type === "approvalRequired");
    expect(offered?.approvalId).toBe("approval-1");
    expect(offered?.summary).toBe("run the test suite");
    // The history draw clears the panel, so the offer must follow it or the
    // rebuild wipes the only way to answer.
    expect(posted.findIndex((message) => message.type === "approvalRequired")).toBeGreaterThan(
      posted.findIndex((message) => message.type === "loadHistory"),
    );
  });

  it("registers a pending question and posts it onto its own turn's message", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );

    await (provider as any).loadHistory("thread-1");

    const posted = postedMessages(postMessage);
    const question = posted.find((message) => message.type === "userInputRequired");
    expect(question?.inputId).toBe("input-1");
    expect(question?.messageId).toBe("assistant-turn-1");
    expect(question?.questions).toHaveLength(1);
    expect(posted.findIndex((message) => message.type === "userInputRequired")).toBeGreaterThan(
      posted.findIndex((message) => message.type === "loadHistory"),
    );

    // Registered, or an answer has nowhere to land: `userInputSelect` reads
    // these maps, and an input the rail never expanded is in neither of them.
    const state = (provider as any).pendingUserInputs.get("input-1");
    expect(state?.threadId).toBe("thread-1");
    expect(state?.answeredQuestions.size).toBe(0);

    // A rebuild that arrives while the answer is half-collected must not reset
    // it back to unanswered.
    await (provider as any).loadHistory("thread-1");
    expect((provider as any).pendingUserInputs.get("input-1")).toBe(state);
  });

  it("keeps the answers a rail card already collected for a question", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    // The user expanded this thread's card in the rail and answered its first
    // question there, without switching.
    const collected = {
      threadId: "thread-1",
      questions: pendingQuestion.request.questions,
      answers: [{ id: "q1", label: "Staging", value: "Staging" }],
      answeredQuestions: new Set(["q1"]),
    };
    (provider as any).backgroundUserInputs.set("input-1", collected);

    await (provider as any).loadHistory("thread-1");

    // The question is on screen, but a second blank copy would win the lookup
    // in `userInputSelect` and silently discard what was already answered.
    expect((provider as any).backgroundUserInputs.get("input-1")).toBe(collected);
    expect((provider as any).pendingUserInputs.has("input-1")).toBe(false);
    expect(postedMessages(postMessage).some((m) => m.type === "userInputRequired")).toBe(true);
  });

  it("stops calling an answered approval pending on its tool row", async () => {
    const { provider, api } = createProvider(detailWith({ pending_approvals: [approvalRow] }));
    await (provider as any).loadHistory("thread-1");
    expect(toolRow(provider, "call-1")?.approvalId).toBe("approval-1");

    await (provider as any).handleApprovalDecision("approval-1", "allow");

    expect(api.decideApproval).toHaveBeenCalledWith("approval-1", "allow", false);
    // The webview draws a pending request's line, and hands it to the panel,
    // from the tool call's own state. An answered one that kept saying
    // "pending" here would offer its buttons again on the next rebuild of the
    // conversation — a view switch, a reopened sidebar, a restored session.
    const row = toolRow(provider, "call-1");
    expect(row?.approvalId).toBeUndefined();
    expect(row?.status).toBe("running");
  });

  it("retires every approval the conversation names when the turn is interrupted", async () => {
    const { provider } = createProvider(detailWith({ pending_approvals: [approvalRow] }));
    await (provider as any).loadHistory("thread-1");
    provider.currentThread = { id: "thread-1" } as any;
    (provider as any).currentTurnId = "turn-1";

    await provider.handleInterrupt();

    // Nothing this client is holding is still pending once the turn is stopped,
    // seeded rows included.
    const row = toolRow(provider, "call-1");
    expect(row?.approvalId).toBeUndefined();
    expect(row?.status).toBe("error");
  });
});
