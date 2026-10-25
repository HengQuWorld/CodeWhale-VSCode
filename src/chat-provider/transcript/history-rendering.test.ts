import { beforeEach, describe, expect, it, vi } from "vitest";

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
    // numbered off the same counter here too, and every user text opens its own
    // group: with no turn record behind the document, that is the only number
    // the bubble can honestly carry.
    const session = {
      metadata: { id: "sess-turns", title: "a conversation", workspace: "/workspace" },
      messages: [
        { role: "user", content: [{ type: "text", text: "run the tests" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "now the docs" }] },
        { role: "assistant", content: [{ type: "text", text: "documented" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-turns");

    const bubbles = provider.messages.filter((message) => message.role === "user");
    expect(bubbles.map((message) => message.content)).toEqual(["run the tests", "now the docs"]);
    expect(bubbles.map((message) => message.turnIndex)).toEqual([1, 2]);
  });

  it("never guesses that a viewed session's message was a steer", async () => {
    // A saved session stores a steer and a fresh turn identically. A compacted
    // history makes the guess fail loudly: it keeps the user prompts of the
    // turns it summarized and drops their answers, so "follows another user
    // message" badged every retained prompt after the first as a steer — the
    // pile of STEER bubbles the session view showed.
    const session = {
      metadata: { id: "sess-retained", title: "a compacted conversation", workspace: "/workspace" },
      messages: [
        { role: "user", content: [{ type: "text", text: "first ask" }] },
        { role: "user", content: [{ type: "text", text: "second ask" }] },
        { role: "user", content: [{ type: "text", text: "third ask" }] },
        { role: "assistant", content: [{ type: "text", text: "still working" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-retained");

    const bubbles = provider.messages.filter((message) => message.role === "user");
    expect(bubbles.map((message) => message.content)).toEqual([
      "first ask",
      "second ask",
      "third ask",
    ]);
    expect(bubbles.some((message) => message.steered)).toBe(false);
    expect(bubbles.some((message) => message.undelivered)).toBe(false);
  });

  it("draws a compacted session's handoff note as a note, not as a user prompt", async () => {
    // The engine persists a compaction checkpoint as a user-role message
    // (strict chat templates accept no other role mid-conversation). Rendered
    // as a bubble it reads as a giant prompt the person never typed; it is the
    // record of the turns it replaced, so it takes the note slot the thread
    // view gives the same event — collapsed body and all.
    const session = {
      metadata: { id: "sess-checkpoint", title: "compacted", workspace: "/workspace" },
      messages: [
        { role: "user", content: [{ type: "text", text: "old ask" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Codewhale handoff note. Earlier turns of this session were condensed to make room.\n\n## Progress\n- built the timeline",
            },
            { type: "text", text: "<!-- codewhale.compaction-checkpoint.v1 -->" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next ask" }] },
        { role: "assistant", content: [{ type: "text", text: "on it" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-checkpoint");

    expect(provider.messages.filter((message) => message.role === "user").map((m) => m.content)).toEqual([
      "old ask",
      "next ask",
    ]);
    const note = provider.messages.find((message) => message.role === "system");
    expect(note).toBeTruthy();
    expect(note!.content).toBe("Context compacted");
    expect(note!.compactionSummary).toContain("built the timeline");
    // The provenance marker is bookkeeping, not part of the handoff.
    expect(note!.compactionSummary).not.toContain("compaction-checkpoint.v1");
  });

  it("keeps a person's own message that quotes the handoff phrase", async () => {
    // Recognition needs both blocks: the opening phrase alone is a sentence
    // anyone may type.
    const session = {
      metadata: { id: "sess-quote", title: "quoted", workspace: "/workspace" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Codewhale handoff note. Why does that appear in my transcript?" }],
        },
        { role: "assistant", content: [{ type: "text", text: "explained" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-quote");

    const users = provider.messages.filter((message) => message.role === "user");
    expect(users.map((message) => message.content)).toEqual([
      "Codewhale handoff note. Why does that appear in my transcript?",
    ]);
    expect(provider.messages.some((message) => message.role === "system")).toBe(false);
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

  it("keeps the whole prompt on a reloaded turn instead of a 280-char preview", async () => {
    // The live view showed every word; a reload used to cut the bubble at 280
    // characters with no ellipsis and no way to see the rest. The full text is
    // what the rebuild must hand back — the engine's own `input_summary` is the
    // only place a preview belongs.
    const prompt = "先把两个机位的素材看一遍，再按仪程排序，".repeat(30);
    const detail = {
      latest_seq: 10,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: prompt.slice(0, 80),
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: prompt.slice(0, 80), detail: prompt, status: "completed" },
        { id: "a1", kind: "agent_message", summary: "ok", detail: "ok", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const user = provider.messages.find((m) => m.role === "user");
    expect(user?.content).toBe(prompt);
    expect(user?.content.length).toBeGreaterThan(280);
  });

  it("hides the runtime's own notices that a resumed session stored as user turns", async () => {
    // Seeding joins a message's blocks into one `detail`, so a runtime notice
    // reaches the thread path as a single string: envelope first, the
    // provenance block last. The thread rebuild had no runtime-owned check at
    // all, so a resumed session showed the MCP-server note and the background
    // shell completions as things the person had said.
    const envelope =
      '<codewhale:runtime_event kind="mcp_configured_servers" visibility="internal">\nThe MCP servers named below are configured for this session.\n- chrome-devtools\n</codewhale:runtime_event>';
    const runtimeMeta = "<turn_meta>\nInput provenance: runtime (non-authoritative)\n</turn_meta>";
    const shellEnvelope =
      '<codewhale:runtime_event kind="background_shell_completion" visibility="internal">\nThis is an internal runtime event.\n</codewhale:runtime_event>';
    const shellMeta =
      "<turn_meta>\nInput provenance: shell_completion (non-authoritative)\n</turn_meta>";
    const detail = {
      latest_seq: 8,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "ask one",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "u2", "u3", "u4"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "ask one", detail: "ask one", status: "completed" },
        { id: "u2", kind: "user_message", summary: "runtime", detail: `${envelope}\n${runtimeMeta}`, status: "completed" },
        { id: "u3", kind: "user_message", summary: "shell", detail: `${shellEnvelope}\n${shellMeta}`, status: "completed" },
        { id: "u4", kind: "user_message", summary: "ask two", detail: "ask two", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const users = provider.messages.filter((m) => m.role === "user");
    // Both notices are gone and the two real prompts stay in order. The second
    // is a steer by the turn's own item list (a notice in between is not a
    // prompt and does not open the turn), which is the thread path's standing
    // rule and not something this filter should change.
    expect(users.map((m) => m.content)).toEqual(["ask one", "ask two"]);
    expect(users.map((m) => !!m.steered)).toEqual([false, true]);
    expect(users.some((m) => m.content.includes("<codewhale:"))).toBe(false);
  });

  it("draws a compaction checkpoint stored as a user turn as a note", async () => {
    // A resumed compacted session carries the handoff note as a user item: the
    // note, then the provenance marker. It is the record of the turns it
    // replaced, so it takes the note slot — the same one a live compaction's
    // result gets — and keeps the whole handoff, collapsed.
    const note = "Codewhale handoff note. Earlier turns of this session were condensed to make room.\n\n## Progress\n- cut v2";
    const detail = {
      latest_seq: 9,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "next ask",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "u2"],
        },
      ],
      items: [
        {
          id: "u1",
          kind: "user_message",
          summary: "checkpoint",
          detail: `${note}\n<!-- codewhale.compaction-checkpoint.v1 -->`,
          status: "completed",
        },
        { id: "u2", kind: "user_message", summary: "next ask", detail: "next ask", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "next ask",
    ]);
    const noteMsg = provider.messages.find((m) => m.role === "system");
    expect(noteMsg).toBeTruthy();
    expect(noteMsg!.content).toBe("Context compacted");
    expect(noteMsg!.compactionSummary).toContain("cut v2");
  });

  it("never answers a turn that has no answer", async () => {
    // A compaction condenses the turns it replaces into one handoff note and
    // keeps their user prompts. Seeded into a thread, each retained prompt is a
    // turn with a user item and no assistant item — and the legacy fallback
    // printed `input_summary` underneath as if it were the model's reply, so the
    // question appeared twice: once as asked, once as answered.
    const detail = {
      latest_seq: 4,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "old ask",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:00Z",
          status: "completed",
          item_ids: ["u1"],
        },
        {
          id: "turn-2",
          input_summary: "live ask",
          created_at: "2026-08-20T10:01:00Z",
          ended_at: "2026-08-20T10:01:10Z",
          status: "completed",
          item_ids: ["u2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "old ask", detail: "old ask", status: "completed" },
        { id: "u2", kind: "user_message", summary: "live ask", detail: "live ask", status: "completed" },
        { id: "a2", kind: "agent_message", summary: "real answer", detail: "real answer", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:old ask",
      "user:live ask",
      "assistant:real answer",
    ]);
  });

  it("leaves an answer bubble textless when the turn only ran tools", async () => {
    // A segment that produced tool calls and no prose has no answer text. The
    // old fallback filled the bubble with the question's first 100 characters,
    // which is the same invented answer one step earlier.
    const detail = {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "check the files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "t1", "t1r"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "check the files", detail: "check the files", status: "completed" },
        { id: "t1", kind: "tool_call", summary: "read_file: a.txt", detail: null, status: "completed", metadata: { tool_use_id: "tool-1" } },
        { id: "t1r", kind: "tool_call", summary: "contents", detail: "hello", status: "completed", metadata: { tool_result_for: "tool-1", is_error: false } },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistant!.content).toBe("");
    // The call itself is still on the bubble — that is what the turn produced.
    expect(assistant!.toolCalls).toHaveLength(1);
  });

  it("strips the turn_meta envelope a turn's item carries after the prompt", async () => {
    // A seeded thread (a saved session resumed into one) persists the engine's
    // metadata block inside the item's detail: `prompt + "\n<turn_meta>…"`.
    // It is engine bookkeeping, not the person's words, and the TUI drops it
    // per block — so a reload must not print the date and workspace in the
    // bubble, for the turn's prompt or for a steer.
    const meta =
      "<turn_meta>\nCurrent local date: 2026-10-19\nCurrent workspace: /Volumes/MAC2/magic/codewhale-all\n</turn_meta>";
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
        { id: "u1", kind: "user_message", summary: "run the tests", detail: `run the tests\n${meta}`, status: "completed" },
        { id: "a1", kind: "agent_message", summary: "Starting...", detail: "Starting...", status: "completed" },
        { id: "u2", kind: "user_message", summary: "focus on vitest", detail: `focus on vitest\n${meta}`, status: "completed" },
        { id: "a2", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const users = provider.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["run the tests", "focus on vitest"]);
    expect(users.some((m) => m.content.includes("<turn_meta>"))).toBe(false);
  });

  it("marks a dropped steer as not delivered, keeping the words where they were typed", async () => {
    // `turn.steer_dropped` flips the steer's item to `canceled`: the model
    // never read it. Rendering it as a plain steer after a reload claimed a
    // delivery the runtime says did not happen.
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
          item_ids: ["u1", "a1", "u2", "a2", "u3", "a3"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "run the tests", detail: "run the tests", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "Starting...", detail: "Starting...", status: "completed" },
        { id: "u2", kind: "user_message", summary: "focus on vitest", detail: "focus on vitest", status: "completed" },
        { id: "a2", kind: "agent_message", summary: "Focused", detail: "Focused", status: "completed" },
        { id: "u3", kind: "user_message", summary: "also the docs", detail: "also the docs", status: "canceled" },
        { id: "a3", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const steers = provider.messages.filter((m) => m.role === "user" && m.steered);
    expect(steers.map((m) => ({ content: m.content, undelivered: m.undelivered }))).toEqual([
      { content: "focus on vitest", undelivered: undefined },
      { content: "also the docs", undelivered: true },
    ]);
  });

  it("drops the engine's metadata block from a viewed session's prompt and steer", async () => {
    // A live turn is stored as two text blocks — the prompt, then the
    // `<turn_meta>` envelope. The rebuild used to join them and peel only a
    // *leading* envelope, so every bubble carried the date, workspace and
    // posture lines the engine wrote for the model.
    const meta =
      "<turn_meta>\nCurrent local date: 2026-10-19\nCurrent workspace: /Volumes/MAC2/magic/codewhale-all\nCurrent permission posture: Full Access\n</turn_meta>";
    const session = {
      metadata: { id: "sess-meta", title: "a conversation", workspace: "/workspace", total_tokens: 0 },
      messages: [
        { role: "user", content: [{ type: "text", text: "视频素材怎么剪" }, { type: "text", text: meta }] },
        { role: "assistant", content: [{ type: "text", text: "先按仪程排序" }] },
        { role: "user", content: [{ type: "text", text: "再补一段口播" }, { type: "text", text: meta }] },
        { role: "assistant", content: [{ type: "text", text: "好" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-meta");

    const users = provider.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["视频素材怎么剪", "再补一段口播"]);
    expect(users.some((m) => m.content.includes("<turn_meta>"))).toBe(false);
  });

  it("hides a runtime-owned event in a viewed session instead of showing it as user input", async () => {
    // The runtime writes its own notices into the user role because strict
    // chat templates reject any other role mid-conversation. The TUI drops
    // them; this rebuild kept the `mcp_configured_servers` note as a user
    // bubble — with a steer badge, since it followed the first user text.
    const session = {
      metadata: { id: "sess-runtime", title: "a conversation", workspace: "/workspace", total_tokens: 0 },
      messages: [
        { role: "user", content: [{ type: "text", text: "视频素材怎么剪" }, { type: "text", text: "<turn_meta>\nCurrent local date: 2026-10-19\n</turn_meta>" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                '<codewhale:runtime_event kind="mcp_configured_servers" visibility="internal">\nThe MCP servers named below are configured for this session.\n- chrome-devtools\n</codewhale:runtime_event>',
            },
            { type: "text", text: "<turn_meta>\nInput provenance: runtime (non-authoritative)\n</turn_meta>" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "先按仪程排序" }] },
      ],
    };

    const { provider } = createProvider(session);

    await provider.loadSessionMessages("sess-runtime");

    const users = provider.messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["视频素材怎么剪"]);
    expect(users.some((m) => m.content.includes("<codewhale:"))).toBe(false);
  });
});
