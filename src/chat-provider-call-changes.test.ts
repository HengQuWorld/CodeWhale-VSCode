/**
 * A command's own file changes, as the extension wires them.
 *
 * A shell command records no `metadata.mutation`: the engine classifies the
 * call as a command execution, and its writes survive only as the difference
 * between the workspace restore points taken around that one call. So the
 * wiring has two passes, and both are asserted here — the paths the `post-tool`
 * receipt already carries, which draw the card immediately, and the engine's
 * call-change answer, which adds the change kind, the line counts and the
 * patch. The reload path has to reproduce the same records from the thread
 * detail alone, and a runtime without the route has to keep the first paint
 * rather than an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {},
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "./chat-provider";
import type { RuntimeEvent, ThreadRecord, TurnItemRecord, TurnRecord } from "./types";

function makeThread(id: string): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-06-29T00:00:00Z",
    updated_at: "2026-06-29T00:00:00Z",
    model: "deepseek-v4-pro",
    workspace: "/tmp/repo",
    mode: "agent",
    allow_shell: false,
    trust_mode: false,
    auto_approve: false,
    latest_turn_id: null,
    archived: false,
  };
}

function createProvider() {
  // Loosely typed on purpose: each test replaces a mock's resolution with the
  // shape that case is about, and a narrow inferred type would freeze the
  // first one.
  const api: Record<string, any> = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => makeThread(id)),
    getThreadDetail: vi.fn(async () => ({ latest_seq: 0, turns: [], items: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    streamEvents: vi.fn(() => ({ abort: () => {} })),
    getCallChanges: vi.fn(async () => ({
      thread_id: "thr_1",
      turn_id: "turn_1",
      tool_call_id: "call_shell",
      tool_name: "exec_shell",
      state: "captured",
      reason: null,
      files: [],
      truncated: false,
    })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).currentThread = makeThread("thr_1");
  return { provider, api, postMessage: provider.postMessage as any };
}

function runtimeEvent(over: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    seq: 1,
    timestamp: "2026-06-29T00:00:00Z",
    thread_id: "thr_1",
    turn_id: "turn_1",
    item_id: null,
    event: "",
    payload: {},
    ...over,
  };
}

/** The streaming assistant message a live turn's items land on. */
function seedAssistantMessage(provider: ChatProvider): void {
  provider.messages.push({
    id: "assistant-turn_1",
    role: "assistant",
    content: "",
    status: "streaming",
    timestamp: Date.now(),
  });
}

/** A shell call starting, as the live item router sees it. */
function startShellCall(provider: ChatProvider, callId = "call_shell"): void {
  (provider as any).handleRuntimeEvent(
    runtimeEvent({
      seq: 1,
      item_id: "item_1",
      event: "item.started",
      payload: {
        item: { kind: "command_execution", id: "item_1", summary: "exec_shell started" },
        tool: { id: callId, name: "exec_shell", input: { command: "python gen.py" } },
      },
    }),
  );
}

/** The `post-tool` receipt that closes one call's workspace span. */
function postToolSnapshot(
  provider: ChatProvider,
  changedPaths: string[],
  callId = "call_shell",
): void {
  (provider as any).handleRuntimeEvent(
    runtimeEvent({
      seq: 2,
      item_id: null,
      event: "turn.workspace_snapshot",
      payload: {
        kind: "post_tool",
        tool_call_id: callId,
        changed_paths: changedPaths,
        snapshot_id: "c2",
        tree_id: "t2",
        session_id: "thr_1",
      },
    }),
  );
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg && msg.type === type);
}

/** The transcript row a call's changes hang off. */
function toolRow(provider: ChatProvider, callId = "call_shell") {
  for (const msg of provider.messages) {
    for (const tc of msg.toolCalls || []) {
      if (tc.callId === callId) return tc;
    }
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a command's own file changes", () => {
  it("draws the paths its post-tool receipt named, on the call's card", () => {
    const { provider, postMessage } = createProvider();
    seedAssistantMessage(provider);
    startShellCall(provider);

    postToolSnapshot(provider, ["out/result.json", "build/log.txt"]);

    const draw = messagesOfType(postMessage, "callChangesDetected");
    expect(draw).toHaveLength(1);
    expect(draw[0].messageId).toBe("assistant-turn_1");
    expect(draw[0].fileChanges.map((fc: any) => fc.filePath)).toEqual([
      "out/result.json",
      "build/log.txt",
    ]);
    // Before the engine answers, the row claims only that the path changed.
    expect(draw[0].fileChanges[0].changeType).toBe("modified");
    expect(draw[0].fileChanges[0].fromCommand).toBe(true);
    expect(draw[0].fileChanges[0].diff).toBeUndefined();

    // The same records are what the sidebar panel is shown, so the two views
    // cannot disagree about what a call changed.
    const changesState = messagesOfType(postMessage, "changesState").pop();
    expect(changesState.changes.map((c: any) => c.filePath)).toEqual([
      "out/result.json",
      "build/log.txt",
    ]);
    expect(changesState.turns).toHaveLength(1);
    expect(toolRow(provider)?.fileChanges).toHaveLength(2);
  });

  it("paints the paths first, then replaces them with the engine's answer", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.callChanges = true;
    api.getCallChanges.mockResolvedValue({
      thread_id: "thr_1",
      turn_id: "turn_1",
      tool_call_id: "call_shell",
      tool_name: "exec_shell",
      state: "captured",
      reason: null,
      truncated: false,
      files: [
        {
          path: "out/result.json",
          change: "created",
          added: 12,
          removed: 0,
          size: 210,
          revision: "a".repeat(64),
          restore_snapshot_id: "t1",
          diff: "@@ -0,0 +1,12 @@\n+{}\n",
          diff_truncated: false,
        },
      ],
    });
    seedAssistantMessage(provider);
    startShellCall(provider);
    postToolSnapshot(provider, ["out/result.json"]);

    // The first paint is synchronous: the receipt is in hand, the route's
    // answer is not. Read it before awaiting anything, or the assertion below
    // would be measuring whichever promise happened to resolve first.
    const first = messagesOfType(postMessage, "callChangesDetected");
    expect(first).toHaveLength(1);
    expect(first[0].fileChanges[0].changeType).toBe("modified");
    expect(first[0].fileChanges[0].diff).toBeUndefined();

    // A second receipt for the same call re-posts nothing: the records are
    // already drawn, and re-sending the session's change list is not free.
    postToolSnapshot(provider, ["out/result.json"]);
    expect(messagesOfType(postMessage, "callChangesDetected")).toHaveLength(1);

    await vi.waitFor(() => {
      expect(messagesOfType(postMessage, "callChangesDetected")).toHaveLength(2);
    });
    expect(api.getCallChanges).toHaveBeenCalledTimes(1);
    expect(api.getCallChanges).toHaveBeenCalledWith("thr_1", "turn_1", "call_shell");

    // The second draw rewrites the same record in place — which is why the
    // skip above is scoped to the first paint and not to this path, and why
    // this says "replaces": the card must not keep the placeholder.
    const final = messagesOfType(postMessage, "callChangesDetected").pop();
    expect(final.fileChanges).toHaveLength(1);
    expect(final.fileChanges[0].changeType).toBe("created");
    expect(final.fileChanges[0].addedLines).toBe(12);
    expect(final.fileChanges[0].diff).toContain("+{}");
    // The digest is the span's own revision, so a revert is checked against the
    // bytes this change produced rather than against the file as it is later.
    expect(toolRow(provider)?.fileChanges?.[0].expectedHash).toBe(`sha256:${"a".repeat(64)}`);
  });
  it("keeps the first paint when the engine has no call-change route", () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.callChanges = false;
    seedAssistantMessage(provider);
    startShellCall(provider);
    postToolSnapshot(provider, ["out/result.json"]);

    expect(api.getCallChanges).not.toHaveBeenCalled();
    const draw = messagesOfType(postMessage, "callChangesDetected");
    expect(draw).toHaveLength(1);
    expect(draw[0].fileChanges[0].filePath).toBe("out/result.json");
  });

  it("never reads a file tool's receipt as a command's span", () => {
    const { provider, postMessage } = createProvider();
    seedAssistantMessage(provider);
    // A file tool: same receipt shape, and its change already arrives as a
    // mutation. Reading the receipt too would list the same path twice under
    // two identities.
    (provider as any).handleRuntimeEvent(
      runtimeEvent({
        seq: 1,
        item_id: "item_2",
        event: "item.started",
        payload: {
          item: { kind: "file_change", id: "item_2", summary: "write started" },
          tool: { id: "call_write", name: "write", input: { file_path: "a.ts" } },
        },
      }),
    );
    postToolSnapshot(provider, ["a.ts"], "call_write");

    expect(messagesOfType(postMessage, "callChangesDetected")).toHaveLength(0);
    expect((provider as any).turnFileChanges).toEqual([]);
  });

  it("reproduces a command's changes from the thread detail on a reload", async () => {
    const { provider, api, postMessage } = createProvider();
    seedAssistantMessage(provider);
    const turn: TurnRecord = {
      schema_version: 1,
      id: "turn_1",
      thread_id: "thr_1",
      status: "completed",
      input_summary: "run a script",
      created_at: "2026-06-29T00:00:00Z",
      item_ids: ["item_1"],
      steer_count: 0,
      workspace_snapshots: [
        {
          kind: "tool",
          snapshot_id: "c1",
          tree_id: "t1",
          session_id: "thr_1",
          tool_call_id: "call_shell",
        },
        {
          kind: "post_tool",
          snapshot_id: "c2",
          tree_id: "t2",
          session_id: "thr_1",
          tool_call_id: "call_shell",
          changed_paths: ["out/result.json"],
        },
      ],
    };
    const item: TurnItemRecord = {
      schema_version: 1,
      id: "item_1",
      turn_id: "turn_1",
      kind: "command_execution",
      status: "completed",
      summary: "exec_shell started",
      detail: "wrote out/result.json",
      metadata: { tool_use_id: "call_shell", tool_name: "exec_shell" },
      artifact_refs: [],
    };
    api.getThreadDetail.mockResolvedValue({
      latest_seq: 3,
      turns: [turn],
      items: [item],
    });

    await (provider as any).loadHistory("thr_1");

    const changesState = messagesOfType(postMessage, "changesState").pop();
    expect(changesState.changes.map((c: any) => c.filePath)).toEqual(["out/result.json"]);
    expect(changesState.changes[0].fromCommand).toBe(true);
    expect(changesState.changes[0].turnIndex).toBe(1);
    expect(toolRow(provider)?.fileChanges).toHaveLength(1);
  });

  it("says a call was never bounded instead of claiming it changed nothing", async () => {
    // `unavailable` is a fact about the span, not an empty change list; a row
    // drawn from it would be a claim the engine never made.
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.callChanges = true;
    api.getCallChanges.mockResolvedValue({
      thread_id: "thr_1",
      turn_id: "turn_1",
      tool_call_id: "call_shell",
      tool_name: "exec_shell",
      state: "unavailable",
      reason: "call_not_bounded",
      files: [],
      truncated: false,
    });
    seedAssistantMessage(provider);
    startShellCall(provider);
    postToolSnapshot(provider, []);

    await vi.waitFor(() => {
      expect(api.getCallChanges).toHaveBeenCalledTimes(1);
    });
    expect(messagesOfType(postMessage, "callChangesDetected")).toHaveLength(0);
    expect(messagesOfType(postMessage, "changesState").pop().changes).toEqual([]);
  });
});
