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

function createProvider(detail: Record<string, unknown>) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();

  return { provider, api, postMessage: provider.postMessage as any };
}

describe("ChatProvider thread history rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("renders file-edit tool calls from session history as diff cards", async () => {
    const session = {
      metadata: {
        id: "sess-1",
        title: "Session with file edit",
        total_tokens: 123,
      },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "edit src/app.ts" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "write_file",
              input: { file_path: "src/app.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              content: [
                "Updated src/app.ts",
                "diff --git a/src/app.ts b/src/app.ts",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -1 +1 @@",
                "-old line",
                "+new line",
              ].join("\n"),
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
    };

    const { provider, postMessage } = createProvider(session);

    await provider.loadSessionMessages("sess-1");

    expect(provider.messages[0].role).toBe("user");
    const assistantMsg = provider.messages.find(
      (message) => message.role === "assistant" && (message.toolCalls?.length || 0) > 0,
    );
    expect(assistantMsg).toBeDefined();
    if (!assistantMsg) {
      throw new Error("Expected assistant message with tool calls");
    }
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.toolCalls).toHaveLength(1);
    expect(assistantMsg.toolCalls?.[0].fileChange).toEqual(
      expect.objectContaining({
        filePath: "src/app.ts",
        changeType: "modified",
        toolName: "write_file",
      }),
    );
    expect(assistantMsg.toolCalls?.[0].fileChange?.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(postMessage).toHaveBeenCalledWith({
      type: "loadHistory",
      messages: provider.messages,
      compactMode: true,
    });
  });
});
