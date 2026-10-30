import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** A poll of a background shell task carries a task id and a timeout, never
 *  the command — so a card drawn from its arguments said that *something* was
 *  running and nothing about what. These tests hold the two places the command
 *  is learned instead: the call that started the task (its input names the
 *  command, the engine's result names the task id) and the poll's own result
 *  (the engine returns both). */

function createProvider(detail: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
    listProviderModels: vi.fn(async () => ({ provider: "custom", models: [{ id: "glm-5.3" }] })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();

  return { provider, postMessage: provider.postMessage as any };
}

function postedMessages(postMessage: any): Record<string, any>[] {
  return postMessage.mock.calls.map((call: unknown[]) => call[0] as Record<string, any>);
}

function startItem(provider: any, id: string, name: string, input: Record<string, unknown>) {
  return provider.handleItemEvent({
    event: "item.started",
    item_id: `item-${id}`,
    turn_id: "turn-1",
    payload: {
      item: { kind: "tool_call", id: `item-${id}`, summary: `${name} started` },
      tool: { id, name, input },
    },
  });
}

function completeItem(
  provider: any,
  id: string,
  summary: string,
  detail: string,
  metadata: Record<string, unknown>,
) {
  return provider.handleItemEvent({
    event: "item.completed",
    item_id: `item-${id}`,
    turn_id: "turn-1",
    payload: {
      item: { kind: "tool_call", id: `item-${id}`, summary, detail, metadata },
    },
  });
}

describe("background shell task cards name what the task runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names a poll from the call that started the task, before the poll returns", () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [
      { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
    ] as any;

    startItem(provider, "call-1", "exec_shell", { command: "cargo build --workspace" });
    completeItem(provider, "call-1", "exec_shell: moved to the background", "Output so far:", {
      task_id: "shell_1",
      status: "Running",
    });

    // The poll starts with a task id only. The card is drawn at that moment —
    // a `wait` can block for its whole timeout, so waiting for the result to
    // name the command would leave it anonymous exactly while it runs.
    startItem(provider, "call-2", "task_shell_wait", {
      task_id: "shell_1",
      timeout_ms: 900000,
      wait: true,
    });

    const poll = (provider.messages[0] as any).toolCalls[1];
    expect(poll.name).toBe("task_shell_wait");
    expect(poll.taskCommand).toBe("cargo build --workspace");

    const added = postedMessages(postMessage).filter((msg) => msg.type === "addToolCall");
    expect(added[1].toolCall.taskCommand).toBe("cargo build --workspace");
  });

  it("names a poll of a task this view never saw start, from the poll's own result", () => {
    const { provider, postMessage } = createProvider();
    provider.messages = [
      { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
    ] as any;

    startItem(provider, "call-1", "task_shell_wait", { task_id: "shell_2", wait: true });
    expect((provider.messages[0] as any).toolCalls[0].taskCommand).toBeUndefined();

    completeItem(provider, "call-1", "task_shell_wait: still running", "Task shell_2 still running.", {
      task_id: "shell_2",
      command: "npm run test",
      status: "Running",
    });

    expect((provider.messages[0] as any).toolCalls[0].taskCommand).toBe("npm run test");
    const update = postedMessages(postMessage).find((msg) => msg.type === "updateToolCall");
    expect(update?.taskCommand).toBe("npm run test");
  });

  it("keeps the pairing for later polls instead of asking each result again", () => {
    const { provider } = createProvider();
    provider.messages = [
      { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
    ] as any;

    startItem(provider, "call-1", "task_shell_wait", { task_id: "shell_3" });
    completeItem(provider, "call-1", "task_shell_wait: done", "task shell_3 completed", {
      task_id: "shell_3",
      command: "cargo test",
      status: "Completed",
    });

    startItem(provider, "call-2", "task_shell_wait", { task_id: "shell_3" });
    expect((provider.messages[0] as any).toolCalls[1].taskCommand).toBe("cargo test");
  });

  it("leaves a multi-task wait unnamed rather than naming one of its tasks", () => {
    // `exec_shell_wait` can wait on several tasks at once. There is no single
    // command to put on that card, and showing the first one would claim the
    // wait was about that task alone.
    const { provider } = createProvider();
    provider.messages = [
      { id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] },
    ] as any;

    startItem(provider, "call-1", "exec_shell_wait", {
      task_ids: ["shell_1", "shell_2"],
      until: "all",
    });

    expect((provider.messages[0] as any).toolCalls[0].taskCommand).toBeUndefined();
  });

  it("names a poll in a rebuilt transcript, from the call that started the task", async () => {
    // The reload path reads stored items, not the live stream: the start
    // call's own item carries the command in `tool_input` and the task id in
    // its result metadata, so the pairing survives a session reload.
    const { provider } = createProvider({
      latest_seq: 4,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "build the workspace",
          created_at: "2026-10-30T10:00:00Z",
          ended_at: "2026-10-30T10:00:02Z",
          status: "completed",
          item_ids: ["item-1", "item-2"],
        },
      ],
      items: [
        {
          id: "item-1",
          kind: "command_execution",
          status: "completed",
          summary: "exec_shell: moved to the background",
          detail: "Output so far:",
          metadata: {
            tool_use_id: "call-1",
            tool_result_for: "call-1",
            tool_name: "exec_shell",
            tool_input: JSON.stringify({ command: "cargo build --workspace" }),
            task_id: "shell_9",
            status: "Running",
          },
        },
        {
          id: "item-2",
          kind: "tool_call",
          status: "in_progress",
          summary: "task_shell_wait started",
          detail: JSON.stringify({ task_id: "shell_9", timeout_ms: 900000, wait: true }),
          metadata: { tool_use_id: "call-2", tool_name: "task_shell_wait" },
        },
      ],
    });

    await (provider as any).loadHistory("thread-1");

    const poll = (provider.messages as any[])
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.itemId === "call-2");
    expect(poll?.taskCommand).toBe("cargo build --workspace");
    expect(poll?.displayName).toBe("Shell task");
  });
});
