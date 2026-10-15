import { beforeEach, describe, expect, it, vi } from "vitest";

// What a diff view reads off disk when it reconstructs a change's before/after.
const diskState = vi.hoisted(() => ({ fileText: "" }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
    openTextDocument: vi.fn(async () => ({ getText: () => diskState.fileText })),
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showTextDocument: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
  },
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

import { ChatProvider } from "../../chat-provider";

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

describe("ChatProvider thread history rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names a viewed session's own provider route, not the picker's", async () => {
    // Viewing a saved session shows a conversation with no thread yet: its
    // next message resumes it into a thread built from the session's own
    // `model_provider` / `model_provider_id`. The model chip followed the
    // session from the start and the provider chip did not — it kept naming
    // the picker's route while the conversation on screen would run on its
    // own, which is the same "the toolbar describes a route the next message
    // will not use" failure, one step earlier.
    const { provider, postMessage } = createProvider({
      metadata: {
        id: "sess-1",
        title: "Bigmodel work",
        model: "glm-5.3",
        model_provider: "custom",
        model_provider_id: "bigmodel-cn",
        workspace: "/workspace",
        message_count: 0,
      },
      messages: [],
    });
    (provider as any).providersCache = [
      {
        id: "deepseek",
        model_provider_id: "deepseek",
        display_name: "DeepSeek",
        default_model: "deepseek-flash",
        has_model_catalog: true,
        credentialState: "configured",
      },
      {
        id: "custom",
        model_provider_id: "bigmodel-cn",
        display_name: "bigmodel-cn (custom)",
        default_model: "glm-5.3",
        has_model_catalog: true,
        credentialState: "configured",
      },
    ];
    // The picker is on another route entirely.
    (provider as any).currentProvider = "deepseek";
    (provider as any).currentProviderId = "deepseek";

    await provider.loadSessionMessages("sess-1");

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providersUpdated",
      // The picker's route is still reported as the picker's...
      current: "deepseek",
      currentProviderId: "deepseek",
      // ...and what is on screen carries the session's.
      viewProvider: "custom",
      viewProviderId: "bigmodel-cn",
    }));

    // The route the view is bound to is the session's, so the model menu is
    // fetched for it.
    expect((provider as any).viewRoute()).toEqual({
      provider: "custom",
      providerId: "bigmodel-cn",
    });
  });

  it("keeps the viewed session's own model on the chip, not the route's default", async () => {
    // The model menu answers with a model, and for a viewed session the answer
    // must be the model that session was saved with. With no thread to read,
    // falling through to the route's catalog default repainted the chip with a
    // model the session never used.
    const { provider, postMessage } = createProvider({
      metadata: {
        id: "sess-1",
        title: "Bigmodel work",
        model: "glm-5.4",
        model_provider: "custom",
        model_provider_id: "bigmodel-cn",
        workspace: "/workspace",
        message_count: 0,
      },
      messages: [],
    });
    (provider as any).providersCache = [
      {
        id: "custom",
        model_provider_id: "bigmodel-cn",
        display_name: "bigmodel-cn (custom)",
        default_model: "glm-5.3",
        has_model_catalog: true,
      },
    ];
    (provider as any).currentProvider = "custom";
    (provider as any).currentProviderId = "bigmodel-cn";

    await provider.loadSessionMessages("sess-1");
    await (provider as any).handleRequestProviderModels("custom", undefined, "bigmodel-cn");

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providerModels",
      provider: "custom",
      providerId: "bigmodel-cn",
      currentModel: "glm-5.4",
    }));
    expect(provider.getCurrentModel()).toBe("glm-5.4");

    // And once the view leaves the session, the route's own model is the
    // answer again — the session's model does not outlive it.
    await (provider as any).handleNewThread();
    expect(provider.getCurrentModel()).toBe("glm-5.3");
  });

  it("skips blank user bubbles for tool_result-only turns", async () => {
    const detail = {
      latest_seq: 12,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "",
          created_at: "2026-06-18T10:00:00Z",
          ended_at: "2026-06-18T10:00:02Z",
          status: "completed",
          item_ids: ["tool-call-1", "tool-result-1", "assistant-1"],
        },
      ],
      items: [
        {
          id: "tool-call-1",
          kind: "tool_call",
          summary: "read_file: a.txt",
          detail: null,
          status: "completed",
          metadata: {
            tool_use_id: "tool-1",
            path: "a.txt",
          },
        },
        {
          id: "tool-result-1",
          kind: "tool_call",
          summary: "contents from a.txt",
          detail: "hello world",
          status: "completed",
          metadata: {
            tool_result_for: "tool-1",
            is_error: false,
          },
        },
        {
          id: "assistant-1",
          kind: "agent_message",
          summary: "Done",
          detail: "Done",
          status: "completed",
          metadata: null,
        },
      ],
    };

    const { provider, postMessage } = createProvider(detail);

    const loadedCount = await (provider as any).loadHistory("thread-1");

    expect(loadedCount).toBe(12);
    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0].role).toBe("assistant");
    expect(provider.messages[0].content).toBe("Done");
    expect(provider.messages[0].toolCalls).toHaveLength(1);
    expect(provider.messages[0].toolCalls?.[0].output).toBe("hello world");
    expect(postMessage).toHaveBeenCalledWith({
      type: "loadHistory",
      messages: provider.messages,
    });
  });

  it("names the plan-approval message when the rebuilt thread is in plan mode", async () => {
    const detail = {
      latest_seq: 1,
      thread: { id: "thread-1", model: "deepseek-v4-pro", mode: "plan" },
      turns: [
        { id: "turn-1", input_summary: "plan it", status: "completed", item_ids: ["a1"] },
      ],
      items: [
        { id: "a1", kind: "agent_message", summary: "1. do x", detail: "1. do x", status: "completed" },
      ],
    };

    const { provider, postMessage } = createProvider(detail);
    provider.currentThread = detail.thread as any;

    await (provider as any).loadHistory("thread-1");

    const last = provider.messages[provider.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "loadHistory", planApprovalFor: last.id }),
    );
  });

  it("names the plan-approval message by the mode the last turn ran in", async () => {
    const detail = {
      latest_seq: 1,
      // The thread has since been switched to Act; the turn still ran in Plan.
      thread: { id: "thread-1", model: "deepseek-v4-pro", mode: "agent" },
      turns: [
        { id: "turn-1", input_summary: "plan it", status: "completed", item_ids: ["a1"], mode: "plan" },
      ],
      items: [
        { id: "a1", kind: "agent_message", summary: "1. do x", detail: "1. do x", status: "completed" },
      ],
    };

    const { provider, postMessage } = createProvider(detail);
    provider.currentThread = detail.thread as any;

    await (provider as any).loadHistory("thread-1");

    const last = provider.messages[provider.messages.length - 1];
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "loadHistory", planApprovalFor: last.id }),
    );
  });

  it("renders steered turns as interleaved segments, not one merged bubble", async () => {
    const detail = {
      latest_seq: 20,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the tests",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "a1", "u2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the tests", detail: "run the tests", status: "completed", started_at: "2026-08-20T10:00:00Z" },
        { id: "a1", kind: "agent_message", summary: "Starting...", detail: "Starting...", status: "completed" },
        { id: "u2", kind: "user_message", summary: "focus on vitest", detail: "focus on vitest", status: "completed", started_at: "2026-08-20T10:00:04Z" },
        { id: "a2", kind: "agent_message", summary: " Done with vitest", detail: "Done with vitest", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    // user → assistant(seg 1) → steered user → assistant(seg 2), matching
    // the live interrupt rendering instead of one merged user bubble.
    expect(provider.messages.map((m) => `${m.role}:${m.content}:${m.steered ? "steer" : ""}`)).toEqual([
      "user:run the tests:",
      "assistant:Starting...:",
      "user:focus on vitest:steer",
      "assistant:Done with vitest:",
    ]);
  });

  it("numbers a viewed session's bubbles by the groups it rebuilds for it", async () => {
    // Opening a saved session rebuilds its transcript from the stored
    // messages, which is the third path into the conversation (besides a live
    // turn and a thread load). The rail's dots and the panel's sections are
    // numbered off the same counter here too, and the counter is opened by the
    // turn's *first* user text — a second, consecutive one is the steer the
    // engine records inside the same turn.
    const session = {
      metadata: { id: "sess-turns", title: "a conversation", workspace: "/workspace" },
      messages: [
        { role: "user", content: [{ type: "text", text: "run the tests" }] },
        { role: "user", content: [{ type: "text", text: "focus on vitest" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "now the docs" }] },
        { role: "assistant", content: [{ type: "text", text: "documented" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-turns");

    const bubbles = provider.messages.filter((message) => message.role === "user");
    expect(bubbles.map((message) => (message.steered ? "steer" : "turn"))).toEqual([
      "turn",
      "steer",
      "turn",
    ]);
    // The steer shares the number of the turn it was sent into; only the next
    // turn's own text opens the next one.
    expect(bubbles.map((message) => message.turnIndex)).toEqual([1, 1, 2]);
  });

  it("anchors each finished turn's closing answer, and leaves the running one open", async () => {
    // The per-turn branch action sends this id and the engine resolves it, so
    // the turn's last assistant message must carry the runtime's own turn id
    // while every other bubble carries none: the row belongs under the answer
    // a person continues from, and a stale anchor would cut the new
    // conversation at the wrong turn while reporting success.
    const detail = {
      latest_seq: 30,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-A",
          input_summary: "first",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "a1", "u2", "a2"],
        },
        {
          // Still running: its answer is not written yet, so it is not a
          // branch point — but the finished turn above it stays branchable.
          id: "turn-B",
          input_summary: "second",
          created_at: "2026-08-20T10:01:00Z",
          status: "in_progress",
          item_ids: ["u3", "a3"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "first", detail: "first", status: "completed", started_at: "2026-08-20T10:00:00Z" },
        { id: "a1", kind: "agent_message", summary: "Starting...", detail: "Starting...", status: "completed" },
        { id: "u2", kind: "user_message", summary: "focus", detail: "focus", status: "completed", started_at: "2026-08-20T10:00:04Z" },
        { id: "a2", kind: "agent_message", summary: "Focused", detail: "Focused", status: "completed" },
        { id: "u3", kind: "user_message", summary: "second", detail: "second", status: "completed", started_at: "2026-08-20T10:01:00Z" },
        { id: "a3", kind: "agent_message", summary: "Second answer", detail: "Second answer", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const anchors = provider.messages.map((m) => `${m.id}:${m.branchTurnId ?? "-"}`);
    expect(anchors.slice(0, 5)).toEqual([
      "user-turn-A:-",
      "assistant-turn-A:-",
      "user-steer-u2:-",
      "assistant-turn-A-s1:turn-A",
      "user-turn-B:-",
    ]);
    // The running turn's own bubble is the streaming placeholder loadHistory
    // adopts for it, and it carries no anchor either: a fork naming that turn
    // would keep an answer that has not been written yet.
    // The running turn is not a branch point: the answer being written carries
    // no anchor, and neither does the streaming placeholder loadHistory adopts
    // for it. A fork naming that turn would keep a half-turn.
    expect(anchors[5]).toBe("assistant-turn-B:-");
    expect(anchors).toHaveLength(7);
    expect(anchors[6]).toMatch(/^assistant-\d+:-$/);
  });

  it("stamps turn usage onto the final assistant message so reload shows the token chip", async () => {
    const detail = {
      latest_seq: 12,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the tests",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 25, prompt_cache_hit_tokens: 40 },
          item_ids: ["u1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the tests", detail: "run the tests", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistantMsgs = provider.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      prompt_cache_hit_tokens: 40,
    });
  });

  it("stamps turn usage only on the final segment of a steered turn", async () => {
    const detail = {
      latest_seq: 20,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "run the tests",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          usage: { input_tokens: 500, output_tokens: 60 },
          item_ids: ["u1", "a1", "u2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the tests", detail: "run the tests", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "Starting...", detail: "Starting...", status: "completed" },
        { id: "u2", kind: "user_message", summary: "focus on vitest", detail: "focus on vitest", status: "completed" },
        { id: "a2", kind: "agent_message", summary: "Done with vitest", detail: "Done with vitest", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const segments = provider.messages.filter((m) => m.role === "assistant");
    expect(segments).toHaveLength(2);
    expect(segments[0].usage).toBeUndefined();
    expect(segments[1].usage).toEqual({ input_tokens: 500, output_tokens: 60 });
  });

  it("reconstructs the full prompt-input total from billable + cached + cache-write classes", async () => {
    const detail = {
      latest_seq: 0,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [],
      items: [],
    };
    const { provider, api } = createProvider(detail);
    (api as any).getThreadUsage = vi.fn(async () => ({
      input_tokens: 10,
      output_tokens: 30,
      cached_tokens: 20,
      cache_write_tokens: 5,
      reasoning_tokens: 0,
      cost_usd: 0,
      cost_cny: 0,
      turns: 1,
    }));
    (provider as any).apiCapabilities.threadUsage = true;

    await (provider as any).loadHistory("thread-1");

    // totals.input_tokens is the billable (cache-miss) slice; the status
    // bar must show the same full-prompt total as the transcript chips.
    expect(provider.totalInputTokens).toBe(35);
    expect(provider.totalOutputTokens).toBe(30);
    expect(provider.totalTokens).toBe(65);
  });

  it("applies tool results that arrive after a steer to the pre-steer segment's tool", async () => {
    const detail = {
      latest_seq: 30,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "check files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "t1", "u2", "t1r", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "check files", detail: "check files", status: "completed" },
        { id: "t1", kind: "tool_call", summary: "read_file: a.txt", detail: null, status: "completed", metadata: { tool_use_id: "tool-1" } },
        { id: "u2", kind: "user_message", summary: "hurry up", detail: "hurry up", status: "completed" },
        { id: "t1r", kind: "tool_call", summary: "contents from a.txt", detail: "hello world", status: "completed", metadata: { tool_result_for: "tool-1", is_error: false } },
        { id: "a1", kind: "agent_message", summary: "All checked", detail: "All checked", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const segments = provider.messages.filter((m) => m.role === "assistant");
    expect(segments).toHaveLength(2);
    // The tool call lives in the pre-steer segment...
    expect(segments[0].toolCalls).toHaveLength(1);
    // ...and its result, persisted after the steer item, still lands on it.
    expect(segments[0].toolCalls?.[0].output).toBe("hello world");
    expect(segments[0].toolCalls?.[0].status).toBe("complete");
    expect(segments[1].content).toBe("All checked");
  });

});
