import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

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
import { reconstructOldContent, reconstructOriginalContent } from "./utils/diff-utils";

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

  it("re-pushes the goal slot state for the session it just loaded", async () => {
    // A viewed session has no thread yet, so it has no goal of its own: the
    // Work panel must not keep showing the previous thread's goal card while
    // the user reads the session.
    const session = {
      metadata: { id: "sess-plain", title: "A saved session", total_tokens: 10 },
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };

    const { provider, postMessage } = createProvider(session);
    await provider.loadSessionMessages("sess-plain");

    expect(postMessage).toHaveBeenCalledWith({
      type: "goalState",
      goal: null,
      backgroundGoals: [],
    });
  });

  it("renders file-change cards for new TUI write tools via metadata.mutation", async () => {
    // Current TUI `write` tool: the model-facing output carries no diff —
    // the diff and per-file outcome only exist in metadata.mutation.
    const detail = {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "create a file",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "create a file", detail: "create a file", status: "completed" },
        {
          id: "t1",
          kind: "tool_call",
          summary: "write: Successfully wrote 12 bytes to src/new.ts",
          detail: "Successfully wrote 12 bytes to src/new.ts",
          status: "completed",
          metadata: {
            tool_use_id: "tool-1",
            tool_name: "write",
            event: "file.mutation",
            mutation: {
              diff: [
                "diff --git a/src/new.ts b/src/new.ts",
                "--- /dev/null",
                "+++ b/src/new.ts",
                "@@ -0,0 +1,2 @@",
                "+hello",
                "+world",
              ].join("\n"),
              files: [{ path: "src/new.ts", outcome: "created" }],
              renames: [],
            },
          },
        },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls).toHaveLength(1);
    const fc = assistant?.toolCalls?.[0].fileChange;
    expect(fc).toMatchObject({
      filePath: "src/new.ts",
      changeType: "created",
      addedLines: 2,
      removedLines: 0,
      toolName: "write",
    });
    expect(fc?.diff).toContain("+hello");
  });

  it("renders apply_patch preflight mutation metadata as a diff card", async () => {
    const detail = {
      latest_seq: 5,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "patch two files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "patch two files", detail: "patch two files", status: "completed" },
        {
          id: "t1",
          kind: "file_change",
          summary: "apply_patch: applied 1/1 hunks",
          detail: '{"success":true,"hunks_applied":1,"hunks_total":1}',
          status: "completed",
          metadata: {
            event: "apply_patch.preflight",
            mutation: {
              diff: [
                "diff --git a/src/app.ts b/src/app.ts",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
              ].join("\n"),
              files: [{ path: "src/app.ts", outcome: "updated" }],
              renames: [],
            },
          },
        },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls).toHaveLength(1);
    const tc = assistant?.toolCalls?.[0];
    expect(tc?.name).toBe("apply_patch");
    expect(tc?.fileChange).toMatchObject({
      filePath: "src/app.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      toolName: "apply_patch",
    });
    expect(tc?.fileChange?.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
  });

  it("upgrades the seed-path file-change card when the tool result with a diff arrives later", async () => {
    const detail = {
      latest_seq: 6,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "edit the app",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "t1r", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "edit the app", detail: "edit the app", status: "completed" },
        {
          id: "t1",
          kind: "tool_call",
          summary: 'edit_file({"file_path":"src/app.ts","search":"old","replace":"new"})',
          detail: JSON.stringify({ file_path: "src/app.ts", search: "old", replace: "new" }),
          status: "completed",
          metadata: { tool_use_id: "tool-1", tool_name: "edit_file" },
        },
        {
          id: "t1r",
          kind: "tool_call",
          summary: "edit_file: replaced",
          detail: [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
            "Replaced 1 occurrence in src/app.ts",
          ].join("\n"),
          status: "completed",
          metadata: { tool_result_for: "tool-1", is_error: false },
        },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    const fc = assistant?.toolCalls?.[0].fileChange;
    // The card was first built from the input alone (no diff); the later
    // tool result must upgrade it with the real embedded diff.
    expect(fc).toMatchObject({
      filePath: "src/app.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      toolName: "edit_file",
    });
    expect(fc?.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
  });

  it("recovers seed tool args from detail JSON and prefers metadata.tool_name over the seed summary", async () => {
    const detail = {
      latest_seq: 3,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "list files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "list files", detail: "list files", status: "completed" },
        // Seed-path tool_use: summary is `name(input_json)`, detail is the JSON
        // input, and metadata.tool_name names the tool. The summary format is
        // NOT parseable by extractToolNameFromSummary, so tool_name must win.
        { id: "t1", kind: "tool_call", summary: "exec_shell({\"command\":\"ls -la\"})", detail: JSON.stringify({ command: "ls -la", timeout: 30 }), status: "completed", metadata: { tool_use_id: "tool-1", tool_name: "exec_shell" } },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.toolCalls).toHaveLength(1);
    const tc = assistant!.toolCalls![0];
    expect(tc.name).toBe("exec_shell");
    expect(tc.input).toEqual({ command: "ls -la", timeout: 30 });
    // detail held the arguments, not output — must not surface as output.
    expect(tc.output).toBeUndefined();
  });

  it("keeps the tool result as output when one follows a seeded tool call", async () => {
    const detail = {
      latest_seq: 4,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "list files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "t1r", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "list files", detail: "list files", status: "completed" },
        { id: "t1", kind: "tool_call", summary: "exec_shell({\"command\":\"ls -la\"})", detail: JSON.stringify({ command: "ls -la", timeout: 30 }), status: "completed", metadata: { tool_use_id: "tool-1", tool_name: "exec_shell" } },
        { id: "t1r", kind: "tool_call", summary: "exec_shell: total 0", detail: "total 0", status: "completed", metadata: { tool_result_for: "tool-1", is_error: false } },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.toolCalls).toHaveLength(1);
    const tc = assistant!.toolCalls![0];
    expect(tc.name).toBe("exec_shell");
    expect(tc.input).toEqual({ command: "ls -la", timeout: 30 });
    expect(tc.output).toBe("total 0");
  });

  it("falls back to summary parsing and keeps output for live tool items without tool_name", async () => {
    const detail = {
      latest_seq: 3,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "list files",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:05Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "list files", detail: "list files", status: "completed" },
        // Live-executed item: summary `name: output`, detail is real output,
        // and there is no metadata.tool_name marker.
        { id: "t1", kind: "tool_call", summary: "exec_shell: total 0", detail: "total 0", status: "completed", metadata: { tool_use_id: "tool-1" } },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const assistant = provider.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.toolCalls).toHaveLength(1);
    const tc = assistant!.toolCalls![0];
    expect(tc.name).toBe("exec_shell");
    expect(tc.output).toBe("total 0");
    // No tool_name marker, so input falls back to metadata (tool_use_id).
    expect(tc.input).toEqual({ tool_use_id: "tool-1" });
  });

  it("rebuilds a replay's missing diff from the recorded edit inputs", async () => {
    // A saved session keeps no `file.mutation` receipt: the runtime stores the
    // authoritative diff on turn items, and the contract `edit` tool answers
    // with a one-line summary. Replaying such a session used to drop the diff,
    // which left the Changes panel without its Diff action.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: { id: "sess-edit", title: "edit replay", total_tokens: 10 },
        messages: [
          { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-edit-1",
                content: "Successfully replaced 1 block(s) in src/app.ts.",
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-edit");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState).toBeDefined();
      expect(changesState.changes[0]).toMatchObject({
        filePath: "src/app.ts",
        changeType: "modified",
      });
      expect(changesState.changes[0].diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      // One record per change, and the panel reads the diff from it.
      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0].diff).toBe(changesState.changes[0].diff);
      expect(records[0].changeIndex).toBe(0);
      // The reconstructed diff recovers exactly the pre-edit content.
      expect(reconstructOldContent("one\nTWO\nthree\n", changesState.changes[0].diff)).toBe(
        "one\ntwo\nthree\n",
      );

      // The card in the message stream carries the same diff, indexed so its
      // own Diff action can pick the right step of the chain.
      const card = provider.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((toolCall) => toolCall.name === "edit");
      expect(card?.fileChange?.diff).toBe(changesState.changes[0].diff);
      expect(card?.fileChange?.changeIndex).toBe(0);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the diff absent when the file no longer matches the recorded edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // The recorded replacement is not in this file: a rebuilt diff would be
      // fiction, so the card must stay without one instead.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "something else\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: { id: "sess-edit-2", title: "stale edit", total_tokens: 10 },
        messages: [
          { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-edit-2");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].diff).toBeUndefined();
      const records = (provider as any).turnFileChanges as Array<{ diff?: string }>;
      expect(records).toHaveLength(1);
      expect(records[0].diff).toBeUndefined();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a viewed session's paths against that session's own workspace", async () => {
    // A session recorded elsewhere keeps workspace-relative paths; they must
    // resolve against the workspace it was recorded in, not the one that
    // happens to be open now.
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-ws-"));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-open-ws-"));
    try {
      fs.mkdirSync(path.join(sessionDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: otherDir } },
      ];

      const session = {
        metadata: {
          id: "sess-other-ws",
          title: "recorded elsewhere",
          total_tokens: 10,
          workspace: sessionDir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-other-ws");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].filePath).toBe("src/app.ts");
      expect(changesState.changes[0].diff).toContain("diff --git a/src/app.ts");
      expect(reconstructOldContent("one\nTWO\nthree\n", changesState.changes[0].diff)).toBe(
        "one\ntwo\nthree\n",
      );
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("does not report a file change for a file tool that failed", async () => {
    // The runtime reports an unsuccessful tool as `item.failed`, which never
    // produces a change card live; a replay has to agree, or the Changes panel
    // lists files that were never touched.
    const session = {
      metadata: { id: "sess-failed", title: "failed edit", total_tokens: 10 },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "edit_file",
              input: { path: "src/app.ts", search: "a", replace: "b" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              is_error: true,
              content: "Error: Invalid input for tool 'edit_file': search and replace are identical",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "failed" }] },
      ],
    };

    const { provider, postMessage } = createProvider(session);
    await provider.loadSessionMessages("sess-failed");

    const changesState = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .find((message: Record<string, any>) => message.type === "changesState");
    expect(changesState.changes).toEqual([]);
    const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(cards[0].fileChange).toBeUndefined();
    expect(cards[0].status).toBe("error");
  });

  it("does not keep a provisional file card for a failed thread-history tool call", async () => {
    const detail = {
      latest_seq: 12,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "edit src/app.ts",
          created_at: "2026-09-12T10:00:00Z",
          ended_at: "2026-09-12T10:00:02Z",
          status: "completed",
          item_ids: ["u1", "tool-call-1", "tool-result-1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "edit src/app.ts", detail: "edit src/app.ts", status: "completed" },
        {
          id: "tool-call-1",
          kind: "tool_call",
          summary: "edit({\"path\":\"src/app.ts\"})",
          detail: JSON.stringify({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] }),
          status: "completed",
          metadata: {
            tool_name: "edit",
            tool_use_id: "tool-1",
          },
        },
        {
          id: "tool-result-1",
          kind: "tool_call",
          summary: "tool failed",
          detail: "tool failed",
          status: "completed",
          metadata: {
            tool_result_for: "tool-1",
            is_error: true,
          },
        },
        { id: "a1", kind: "agent_message", summary: "failed", detail: "failed", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(cards[0].status).toBe("error");
    expect(cards[0].fileChange).toBeUndefined();
    expect((provider as any).turnFileChanges).toEqual([]);
  });

  it("rebuilds missing edit diffs even when the same file already has another diff", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-mixed-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-mixed",
          title: "write then edit",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "write then edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-write-1",
                name: "write",
                input: { path: "src/app.ts", content: "one\ntwo\n" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-write-1", content: "wrote file" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider } = createProvider(session);
      await provider.loadSessionMessages("sess-mixed");

      const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
      const writeCall = cards.find((toolCall) => toolCall.name === "write");
      const editCall = cards.find((toolCall) => toolCall.name === "edit");

      expect(writeCall?.fileChange?.diff).toContain("+++ b/src/app.ts");
      expect(writeCall?.fileChange?.changeIndex).toBe(0);
      expect(editCall?.fileChange?.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(editCall?.fileChange?.changeIndex).toBe(1);

      // Two changes to one file are two records: reverting either leaves the
      // other reviewable.
      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      expect(records[0].changeIndex).toBe(0);
      expect(records[1].changeIndex).toBe(1);
      expect(records[1].diff).toBe(editCall?.fileChange?.diff);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds a chain of multiple recorded edits in chronological order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-chain-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "ONE\nTWO\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-edit-chain",
          title: "two edits",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "edit src/app.ts twice" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "one", newText: "ONE" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-2",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-2", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider } = createProvider(session);
      await provider.loadSessionMessages("sess-edit-chain");

      const cards = provider.messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter((toolCall) => toolCall.name === "edit");
      expect(cards).toHaveLength(2);
      expect(cards[0].fileChange?.changeIndex).toBe(0);
      expect(cards[1].fileChange?.changeIndex).toBe(1);

      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      const secondDiff = records[1].diff;
      expect(secondDiff).toBeDefined();
      expect(reconstructOldContent("ONE\nTWO\n", secondDiff!)).toBe("ONE\ntwo\n");
      const chainedDiffs = records.map((record) => record.diff!);
      expect(reconstructOriginalContent(chainedDiffs, "ONE\nTWO\n")).toBe("one\ntwo\n");
      expect(records[0].diff).toBe(cards[0].fileChange?.diff);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps each change's own diff when a later edit no longer matches the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-stale-mixed-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // Final file has moved on since the recorded edit, so only the earlier
      // write diff remains individually trustworthy.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "something else\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-stale-mixed",
          title: "write then stale edit",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "write then edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-write-1",
                name: "write",
                input: { path: "src/app.ts", content: "one\ntwo\n" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-write-1", content: "wrote file" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-stale-mixed");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].diff).toContain("+++ b/src/app.ts");
      expect(changesState.changes[1].diff).toBeUndefined();

      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      expect(records[0].diff).toContain("+++ b/src/app.ts");
      expect(records[0].changeIndex).toBe(0);
      expect(records[1].diff).toBeUndefined();
      // A change with no diff does not consume an index: reconstruction
      // counts the diffs that exist.
      expect(records[1].changeIndex).toBeUndefined();

      const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
      const writeCall = cards.find((toolCall) => toolCall.name === "write");
      const editCall = cards.find((toolCall) => toolCall.name === "edit");
      expect(writeCall?.fileChange?.diff).toContain("+++ b/src/app.ts");
      expect(editCall?.fileChange?.diff).toBeUndefined();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
