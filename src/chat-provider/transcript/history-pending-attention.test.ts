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
    submitUserInput: vi.fn(async (..._args: unknown[]) => undefined),
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

  it("puts the question back on a rebuild that no longer names it", async () => {
    const { provider, api, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    await (provider as any).loadHistory("thread-1");
    expect(postedMessages(postMessage).filter((m) => m.type === "userInputRequired")).toHaveLength(1);

    // The rebuild clears the transcript, and the bar the question drew was part
    // of it. The next snapshot came back with nothing pending (observed: two
    // switches into the same thread seconds apart, the second one empty), and
    // trusting only that list left a turn waiting on an answer no longer on
    // screen. The client's own copy has to put the bar back.
    postMessage.mockClear();
    api.getThreadDetail.mockImplementation(async () => detailWith({}));
    await (provider as any).loadHistory("thread-1");

    const again = postedMessages(postMessage).filter((m) => m.type === "userInputRequired");
    expect(again).toHaveLength(1);
    expect(again[0].inputId).toBe("input-1");
    expect(again[0].messageId).toBe("assistant-turn-1");
  });

  it("retires a question answered in another client", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    await (provider as any).loadHistory("thread-1");
    postMessage.mockClear();

    // Answered from the terminal, or from another window: this view still
    // holds the request, and would keep drawing its bar.
    (provider as any).handleRuntimeEvent({
      seq: 8,
      event: "user_input.answered",
      payload: { id: "input-1", input_id: "input-1" },
    } as any);

    expect((provider as any).pendingUserInputs.has("input-1")).toBe(false);
    expect(postedMessages(postMessage).filter((m) => m.type === "userInputResolved")).toEqual([
      { type: "userInputResolved", inputId: "input-1", cancelled: false },
    ]);
  });

  it("retires a question settled while a later turn is running", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    await (provider as any).loadHistory("thread-1");
    // A newer turn owns the view: the answer to the earlier turn's question
    // then arrives carrying the earlier turn's id.
    (provider as any).currentTurnId = "turn-2";
    postMessage.mockClear();

    (provider as any).handleRuntimeEvent({
      seq: 9,
      event: "user_input.answered",
      turn_id: "turn-1",
      payload: { id: "input-1", input_id: "input-1" },
    } as any);

    // The stale-turn guard exists for item deltas and turn bookkeeping; this
    // is neither, and dropping it would leave a request the client holds and
    // redraws forever.
    expect((provider as any).pendingUserInputs.has("input-1")).toBe(false);
  });

  it("says nothing about a request it was not holding", async () => {
    const { provider, postMessage } = createProvider(detailWith({}));
    await (provider as any).loadHistory("thread-1");
    postMessage.mockClear();

    // Our own submit already removed the bar and posted the resolution; the
    // event the runtime sends afterwards must not post a second one.
    (provider as any).handleRuntimeEvent({
      seq: 8,
      event: "user_input.answered",
      payload: { id: "input-never-held", input_id: "input-never-held" },
    } as any);

    expect(postedMessages(postMessage).filter((m) => m.type === "userInputResolved")).toHaveLength(0);
  });

  it("forgets a held question once it is answered", async () => {
    const { provider, api, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    await (provider as any).loadHistory("thread-1");
    await (provider as any).handleUserInputSelect("input-1", "q1", 0, "Staging");

    // The map is what keeps the bar alive across rebuilds, so an entry that
    // outlived its answer would redraw a question that is no longer waiting.
    postMessage.mockClear();
    api.getThreadDetail.mockImplementation(async () => detailWith({}));
    await (provider as any).loadHistory("thread-1");

    expect(
      postedMessages(postMessage).filter((m) => m.type === "userInputRequired"),
    ).toHaveLength(0);
  });

  it("redraws a question the rail already holds for this thread", async () => {
    const { provider, postMessage } = createProvider(detailWith({}));
    // Answered from the rail card without switching: the request lives in the
    // background map, which is a different hold from the view's.
    (provider as any).backgroundUserInputs.set("input-1", {
      threadId: "thread-1",
      turnId: "turn-1",
      questions: pendingQuestion.request.questions,
      answers: [{ id: "q1", label: "Staging", value: "Staging" }],
      answeredQuestions: new Set(["q1"]),
    });

    await (provider as any).loadHistory("thread-1");

    const posted = postedMessages(postMessage).filter((m) => m.type === "userInputRequired");
    expect(posted).toHaveLength(1);
    expect(posted[0].inputId).toBe("input-1");
    // Registering a second, blank copy would win the lookup and throw away the
    // answer already collected on the card.
    const state = (provider as any).backgroundUserInputs.get("input-1");
    expect(state.answers).toHaveLength(1);
    expect((provider as any).pendingUserInputs.has("input-1")).toBe(false);
  });

  it("offers a held question only on its own thread", async () => {
    const { provider, postMessage } = createProvider(
      detailWith({ pending_user_inputs: [] }),
    );
    (provider as any).pendingUserInputs.set("input-elsewhere", {
      threadId: "thread-2",
      turnId: "turn-2",
      questions: pendingQuestion.request.questions,
      answers: [],
      answeredQuestions: new Set(),
    });

    await (provider as any).loadHistory("thread-1");

    // A question belongs to the conversation it was asked in; drawing it here
    // would put an unanswerable prompt on a thread that never asked it.
    expect(
      postedMessages(postMessage).filter((m) => m.type === "userInputRequired"),
    ).toHaveLength(0);
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

  const twoQuestions = {
    id: "input-2",
    turn_id: "turn-1",
    request: {
      questions: [
        {
          header: "Environment",
          id: "q1",
          question: "Which environment?",
          options: [
            { label: "Staging", description: "" },
            { label: "Production", description: "" },
          ],
        },
        {
          header: "Scope",
          id: "q2",
          question: "How much of it?",
          options: [
            { label: "All", description: "" },
            { label: "Part", description: "" },
          ],
        },
      ],
    },
  };

  const multiQuestionRequest = {
    id: "input-3",
    turn_id: "turn-1",
    request: {
      questions: [
        {
          header: "Databases",
          id: "q1",
          question: "Which ones?",
          multi_select: true,
          options: [
            { label: "Postgres", description: "" },
            { label: "Redis", description: "" },
            { label: "ClickHouse", description: "" },
          ],
        },
      ],
    },
  };

  it("sends a multi-select answer as one entry per ticked option", async () => {
    const { provider, api } = createProvider(
      detailWith({ pending_user_inputs: [multiQuestionRequest] }),
    );
    await (provider as any).loadHistory("thread-1");

    // A click on a multi-select option only ticks it: the reply is not final
    // until the confirm button names the set.
    await (provider as any).handleUserInputSelect("input-3", "q1", 0, "Postgres");
    expect(api.submitUserInput).not.toHaveBeenCalled();

    await (provider as any).handleUserInputConfirm("input-3", "q1", ["Postgres", "Redis"]);
    expect(api.submitUserInput).toHaveBeenCalledTimes(1);
    expect(api.submitUserInput.mock.calls[0][2]).toEqual([
      { id: "q1", label: "Postgres", value: "Postgres" },
      { id: "q1", label: "Redis", value: "Redis" },
    ]);
  });

  it("ignores labels a multi-select question never offered", async () => {
    const { provider, api } = createProvider(
      detailWith({ pending_user_inputs: [multiQuestionRequest] }),
    );
    await (provider as any).loadHistory("thread-1");

    // The engine rejects an answer naming a label it did not offer, and that
    // rejection would fail the whole turn — so a stray label is dropped here,
    // where it can still be corrected.
    await (provider as any).handleUserInputConfirm("input-3", "q1", ["Postgres", "MySQL"]);

    expect(api.submitUserInput.mock.calls[0][2]).toEqual([
      { id: "q1", label: "Postgres", value: "Postgres" },
    ]);
  });

  it("ignores a confirm for a single-select question", async () => {
    const { provider, api } = createProvider(
      detailWith({ pending_user_inputs: [pendingQuestion] }),
    );
    await (provider as any).loadHistory("thread-1");

    // Single-select is answered by its click; a confirm would replace that
    // answer with a stale copy.
    await (provider as any).handleUserInputSelect("input-1", "q1", 0, "Staging");
    await (provider as any).handleUserInputConfirm("input-1", "q1", ["Staging"]);

    expect(api.submitUserInput).toHaveBeenCalledTimes(1);
    expect(api.submitUserInput.mock.calls[0][2]).toEqual([
      { id: "q1", label: "Staging", value: "Staging" },
    ]);
  });

  it("sends one answer per question, the last pick winning", async () => {
    const { provider, api } = createProvider(
      detailWith({ pending_user_inputs: [twoQuestions] }),
    );
    await (provider as any).loadHistory("thread-1");

    // The bar stays on screen until every question is answered, so a pick can
    // be changed. The reply is the `answers` list, and two entries for one
    // question would arrive as two contradicting answers to it.
    await (provider as any).handleUserInputSelect("input-2", "q1", 0, "Staging");
    await (provider as any).handleUserInputSelect("input-2", "q1", 1, "Production");

    // Half answered: nothing is submitted yet.
    expect(api.submitUserInput).not.toHaveBeenCalled();

    await (provider as any).handleUserInputSelect("input-2", "q2", 0, "All");
    expect(api.submitUserInput).toHaveBeenCalledTimes(1);
    const answers = api.submitUserInput.mock.calls[0][2];
    expect(answers).toEqual([
      { id: "q1", label: "Production", value: "Production" },
      { id: "q2", label: "All", value: "All" },
    ]);
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
