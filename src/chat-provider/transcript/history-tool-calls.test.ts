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

describe("ChatProvider history tool calls and change cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

});

// A completed live turn persists each call as ONE item holding both halves —
// the call's own identity (`tool_use_id`, `tool_name`, `tool_input`) plus the
// result marker `tool_result_for`, naming that same call. Seeded history
// persists them apart. Both shapes are rebuilt here; a merged item read as a
// result alone dropped every tool call out of the transcript.
describe("ChatProvider rebuilds a tool call the engine persisted as one item", () => {
  it("renders a merged call+result item as a completed row", async () => {
    const detail = {
      latest_seq: 9,
      thread: { id: "thread-1", model: "deepseek-flash" },
      turns: [
        {
          id: "turn-1",
          input_summary: "check the store",
          created_at: "2026-10-12T11:22:42Z",
          ended_at: "2026-10-12T11:23:10Z",
          status: "completed",
          item_ids: ["u1", "r1", "c1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "check the store", detail: "check the store", status: "completed" },
        { id: "r1", kind: "agent_reasoning", summary: "thinking", detail: "thinking", status: "completed" },
        {
          id: "c1",
          kind: "tool_call",
          summary: "bash: total 0",
          detail: "total 0",
          status: "completed",
          metadata: {
            tool_use_id: "call-1",
            tool_name: "bash",
            tool_input: JSON.stringify({ command: "ls -la" }),
            tool_result_for: "call-1",
            is_error: false,
            exit_code: 0,
          },
        },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);
    await (provider as any).loadHistory("thread-1");

    const calls = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("bash");
    // The arguments come from `metadata.tool_input`; this item's `detail` is
    // the result and must not be parsed as the input as well.
    expect(calls[0].input).toEqual({ command: "ls -la" });
    expect(calls[0].output).toBe("total 0");
    expect(calls[0].status).toBe("complete");
    expect(calls[0].callId).toBe("call-1");
    // One row, reached through the block list the webview iterates.
    const blocks = provider.messages.flatMap((message) => message.blocks ?? []);
    expect(blocks.filter((b) => b.type === "tool_call")).toHaveLength(1);
    // A shell call is registered as one, so the restore points the engine
    // recorded around it can still be read back into the Changes panel.
    expect((provider as any).shellCallRefs.has("call-1")).toBe(true);
  });

  it("settles a merged failed call as an error", async () => {
    const detail = {
      latest_seq: 4,
      thread: { id: "thread-1", model: "deepseek-flash" },
      turns: [
        {
          id: "turn-1",
          input_summary: "",
          created_at: "2026-10-12T11:22:42Z",
          ended_at: "2026-10-12T11:23:10Z",
          status: "completed",
          item_ids: ["c1", "a1"],
        },
      ],
      items: [
        {
          id: "c1",
          kind: "tool_call",
          summary: "bash failed: Failed to execute tool",
          detail: "Failed to execute tool",
          status: "failed",
          metadata: {
            tool_use_id: "call-9",
            tool_name: "bash",
            tool_input: JSON.stringify({ command: "exit 1" }),
            tool_result_for: "call-9",
            is_error: true,
          },
        },
        { id: "a1", kind: "agent_message", summary: "failed", detail: "failed", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);
    await (provider as any).loadHistory("thread-1");

    const calls = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe("error");
    expect(calls[0].output).toBe("Failed to execute tool");
    expect(calls[0].input).toEqual({ command: "exit 1" });
  });

  it("keeps the seeded call+result pair working in the same turn", async () => {
    // The shape older engines (and a session-seeded thread) write: the call
    // item, then the result item that answers it. A result item must settle
    // the call it names and never become a row of its own.
    const detail = {
      latest_seq: 12,
      thread: { id: "thread-1", model: "deepseek-flash" },
      turns: [
        {
          id: "turn-1",
          input_summary: "read both",
          created_at: "2026-10-12T11:22:42Z",
          ended_at: "2026-10-12T11:23:10Z",
          status: "completed",
          item_ids: ["u1", "seed-1", "result-1", "merged-1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "read both", detail: "read both", status: "completed" },
        {
          id: "seed-1",
          kind: "tool_call",
          summary: 'read({"path":"a.txt"})',
          detail: JSON.stringify({ path: "a.txt" }),
          status: "completed",
          metadata: { tool_use_id: "call-seed", tool_name: "read" },
        },
        {
          id: "result-1",
          kind: "tool_call",
          summary: "hello",
          detail: "hello",
          status: "completed",
          metadata: { tool_result_for: "call-seed", is_error: false },
        },
        {
          id: "merged-1",
          kind: "tool_call",
          summary: "bash: done",
          detail: "done",
          status: "completed",
          metadata: {
            tool_use_id: "call-merged",
            tool_name: "bash",
            tool_input: JSON.stringify({ command: "echo done" }),
            tool_result_for: "call-merged",
            is_error: false,
          },
        },
        { id: "a1", kind: "agent_message", summary: "Both read", detail: "Both read", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);
    await (provider as any).loadHistory("thread-1");

    const calls = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.name)).toEqual(["read", "bash"]);
    // The pair's result landed on its own call, not on a row of its own.
    expect(calls[0].output).toBe("hello");
    expect(calls[0].status).toBe("complete");
    expect(calls[1].output).toBe("done");
  });
});
