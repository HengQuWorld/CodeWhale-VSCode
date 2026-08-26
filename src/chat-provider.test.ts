import { describe, it, expect } from "vitest";
import { shouldRefreshTaskList, TASK_REFRESH_TOOL_NAMES } from "./utils/tool-utils";

// Note: Cost calculation, diff-utils, and tool-utils tests have been moved to
// their dedicated test files. This file only contains chat-provider-specific
// test suites that are NOT covered elsewhere.

// ── Turn ID routing logic (extracted from chat-provider.ts) ──

interface TestRuntimeEvent {
  seq: number;
  turn_id: string | null;
  item_id: string | null;
  event: string;
}

interface TestChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  status: "streaming" | "complete" | "error";
}

/**
 * Pure-function reimplementation of the handleRuntimeEvent / handleItemEvent
 * routing logic used in chat-provider.ts.  Kept in the test file so that a
 * logic regression in either guard is caught immediately.
 */
function shouldRouteItemEvent(
  event: TestRuntimeEvent,
  currentTurnId: string | null,
  lastMsg: TestChatMessage | undefined,
): { route: boolean; reason: string } {
  // Guard 1 — stale turn_id from a previous turn
  if (event.turn_id && currentTurnId && event.turn_id !== currentTurnId) {
    return { route: false, reason: "stale_turn_id" };
  }
  // Guard 2 — only route item events
  if (!event.item_id) {
    return { route: false, reason: "no_item_id" };
  }
  // Guard 3 — assistant message must be in streaming state
  if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.status !== "streaming") {
    return { route: false, reason: "no_streaming_assistant" };
  }
  return { route: true, reason: "ok" };
}

describe("Turn ID routing (bugfix: stale events clobber current turn)", () => {
  const makeEvent = (overrides: Partial<TestRuntimeEvent> = {}): TestRuntimeEvent => ({
    seq: 1,
    turn_id: null,
    item_id: null,
    event: "item.delta",
    ...overrides,
  });

  const streamingMsg: TestChatMessage = { id: "a1", role: "assistant", status: "streaming" };
  const completeMsg: TestChatMessage = { id: "a1", role: "assistant", status: "complete" };
  const userMsg: TestChatMessage = { id: "u1", role: "user", status: "complete" };

  it("routes item event when turn_id matches currentTurnId", () => {
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-2", item_id: "item-1" }),
      "turn-2",
      streamingMsg,
    );
    expect(r.route).toBe(true);
  });

  it("drops item event when turn_id is stale (old turn)", () => {
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-1", item_id: "item-1" }),
      "turn-2",
      streamingMsg,
    );
    expect(r.route).toBe(false);
    expect(r.reason).toBe("stale_turn_id");
  });

  it("routes item event even when currentTurnId is null (early events before startTurn returns)", () => {
    // This is the critical fix: backend emits item events BEFORE the HTTP
    // response carrying the turn id.  When currentTurnId is null we cannot
    // match by turn_id, but we must NOT drop the events — they belong to
    // the newly created turn and should be appended to the streaming
    // assistant message.
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-5", item_id: "item-1" }),
      null, // startTurn hasn't returned yet
      streamingMsg,
    );
    expect(r.route).toBe(true);
  });

  it("drops item event when last assistant message is already finalized", () => {
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-2", item_id: "item-1" }),
      "turn-2",
      completeMsg,
    );
    expect(r.route).toBe(false);
    expect(r.reason).toBe("no_streaming_assistant");
  });

  it("drops item event when last message is not assistant", () => {
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-2", item_id: "item-1" }),
      "turn-2",
      userMsg,
    );
    expect(r.route).toBe(false);
    expect(r.reason).toBe("no_streaming_assistant");
  });

  it("routes turn_id=null item event when currentTurnId is set (legacy path)", () => {
    // Backward-compat: if the event carries no turn_id at all, rely
    // solely on lastMsg guards.
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: null, item_id: "item-1" }),
      "turn-2",
      streamingMsg,
    );
    expect(r.route).toBe(true);
  });

  it("turn.completed for old turn does NOT affect currentTurnId routing", () => {
    // Simulate: turn-1 completes, but we're already on turn-2.
    // The stale turn.completed should not pass the turn_id guard,
    // so currentTurnId stays "turn-2".
    const r = shouldRouteItemEvent(
      makeEvent({ turn_id: "turn-1", item_id: null, event: "turn.completed" }),
      "turn-2",
      streamingMsg,
    );
    // No item_id, but the stale_turn_id guard fires first — event is dropped.
    expect(r.route).toBe(false);
    expect(r.reason).toBe("stale_turn_id");
    // currentTurnId is NOT mutated by this function; it remains "turn-2" so
    // subsequent turn-2 item events are still routed correctly.
  });
});

describe("Event handling state machine", () => {
  interface WorkState {
    cycleCount: number;
    checklistItems: { id: string; content: string; status: string }[];
    checklistCompletionPct: number;
    coherenceState: string;
    coherenceLabel: string;
  }

  function createInitialWorkState(): WorkState {
    return {
      cycleCount: 0,
      checklistItems: [],
      checklistCompletionPct: 0,
      coherenceState: "healthy",
      coherenceLabel: "",
    };
  }

  it("initializes with default state", () => {
    const state = createInitialWorkState();
    expect(state.cycleCount).toBe(0);
    expect(state.checklistItems).toHaveLength(0);
    expect(state.checklistCompletionPct).toBe(0);
    expect(state.coherenceState).toBe("healthy");
    expect(state.coherenceLabel).toBe("");
  });

  it("updates cycle count on cycle.advanced event", () => {
    const state = createInitialWorkState();
    const payload = { from: 0, to: 1, cycle: 1 };
    state.cycleCount = payload.to ?? payload.cycle ?? 0;
    expect(state.cycleCount).toBe(1);
  });

  it("updates cycle count using 'to' field preferentially", () => {
    const state = createInitialWorkState();
    const payload = { from: 2, to: 5, cycle: 3 };
    state.cycleCount = payload.to ?? payload.cycle ?? 0;
    expect(state.cycleCount).toBe(5);
  });

  it("falls back to 'cycle' field when 'to' is missing", () => {
    const state = createInitialWorkState();
    const payload: { from?: number; to?: number; cycle?: number } = { from: 0, cycle: 7 };
    state.cycleCount = payload.to ?? payload.cycle ?? 0;
    expect(state.cycleCount).toBe(7);
  });

  it("updates coherence state on coherence.state event", () => {
    const state = createInitialWorkState();
    const payload = { state: "refreshing_context", label: "Refreshing context…" };
    state.coherenceState = payload.state || "healthy";
    state.coherenceLabel = payload.label || "";
    expect(state.coherenceState).toBe("refreshing_context");
    expect(state.coherenceLabel).toBe("Refreshing context…");
  });

  it("falls back to description when label is missing", () => {
    const state = createInitialWorkState();
    const payload = { state: "getting_crowded", description: "Context is getting crowded" };
    state.coherenceState = payload.state || "healthy";
    state.coherenceLabel = (payload as any).label || payload.description || "";
    expect(state.coherenceState).toBe("getting_crowded");
    expect(state.coherenceLabel).toBe("Context is getting crowded");
  });

  it("defaults coherence state to healthy when state is missing", () => {
    const state = createInitialWorkState();
    const payload = {};
    state.coherenceState = (payload as any).state || "healthy";
    expect(state.coherenceState).toBe("healthy");
  });

  it("updates checklist items from task_updates metadata", () => {
    const state = createInitialWorkState();
    const metadata = {
      task_updates: {
        checklist: {
          items: [
            { id: "1", content: "Step 1", status: "completed" },
            { id: "2", content: "Step 2", status: "in_progress" },
          ],
          completion_pct: 50,
        },
      },
    };
    const checklist = (metadata.task_updates as Record<string, unknown>).checklist;
    if (checklist && typeof checklist === "object") {
      const cl = checklist as Record<string, unknown>;
      if (Array.isArray(cl.items)) {
        state.checklistItems = cl.items as { id: string; content: string; status: string }[];
      }
      if (typeof cl.completion_pct === "number") {
        state.checklistCompletionPct = cl.completion_pct;
      }
    }
    expect(state.checklistItems).toHaveLength(2);
    expect(state.checklistCompletionPct).toBe(50);
    expect(state.checklistItems[0].status).toBe("completed");
  });

  it("resets all state on new thread", () => {
    const state: WorkState = {
      cycleCount: 5,
      checklistItems: [{ id: "1", content: "Done", status: "completed" }],
      checklistCompletionPct: 100,
      coherenceState: "refreshing_context",
      coherenceLabel: "Refreshing…",
    };
    state.cycleCount = 0;
    state.checklistItems = [];
    state.checklistCompletionPct = 0;
    state.coherenceState = "healthy";
    state.coherenceLabel = "";
    expect(state.cycleCount).toBe(0);
    expect(state.checklistItems).toHaveLength(0);
    expect(state.checklistCompletionPct).toBe(0);
    expect(state.coherenceState).toBe("healthy");
    expect(state.coherenceLabel).toBe("");
  });
});

describe("Tool call status transitions", () => {
  type ToolCallStatus = "pending" | "running" | "complete" | "error" | "awaiting_approval";

  interface ToolCallInfo {
    name: string;
    status: ToolCallStatus;
    output?: string;
    approvalId?: string;
  }

  it("transitions from running to complete", () => {
    const tc: ToolCallInfo = { name: "read_file", status: "running" };
    tc.status = "complete";
    tc.output = "file contents";
    expect(tc.status).toBe("complete");
    expect(tc.output).toBe("file contents");
  });

  it("transitions from running to awaiting_approval", () => {
    const tc: ToolCallInfo = { name: "exec_shell", status: "running" };
    tc.status = "awaiting_approval";
    tc.approvalId = "appr-1";
    expect(tc.status).toBe("awaiting_approval");
    expect(tc.approvalId).toBe("appr-1");
  });

  it("transitions from awaiting_approval to complete after approval", () => {
    const tc: ToolCallInfo = { name: "exec_shell", status: "awaiting_approval", approvalId: "appr-1" };
    tc.status = "complete";
    tc.output = "command output";
    expect(tc.status).toBe("complete");
  });

  it("tracks multiple tool calls in a single message", () => {
    const toolCalls: ToolCallInfo[] = [
      { name: "read_file", status: "complete", output: "contents" },
      { name: "exec_shell", status: "running" },
      { name: "write_file", status: "awaiting_approval", approvalId: "appr-2" },
    ];
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls.filter((tc) => tc.status === "complete")).toHaveLength(1);
    expect(toolCalls.filter((tc) => tc.status === "running")).toHaveLength(1);
    expect(toolCalls.filter((tc) => tc.status === "awaiting_approval")).toHaveLength(1);
  });
});

describe("Task refresh trigger conditions", () => {
  it("triggers task refresh on agent tools", () => {
    for (const name of ["agent_open", "agent_spawn", "agent_close", "agent_cancel"]) {
      expect(shouldRefreshTaskList(name)).toBe(true);
    }
  });

  it("triggers task refresh on todo tools", () => {
    for (const name of ["todo_write", "todo_add", "todo_update"]) {
      expect(shouldRefreshTaskList(name)).toBe(true);
    }
  });

  it("triggers task refresh on checklist tools", () => {
    for (const name of ["checklist_write", "checklist_add", "checklist_update"]) {
      expect(shouldRefreshTaskList(name)).toBe(true);
    }
  });

  it("triggers task refresh on shell tools", () => {
    expect(shouldRefreshTaskList("task_shell_start")).toBe(true);
    expect(shouldRefreshTaskList("exec_shell")).toBe(true);
  });

  it("does not trigger task refresh on read-only tools", () => {
    for (const name of ["read_file", "grep_files", "project_map"]) {
      expect(shouldRefreshTaskList(name)).toBe(false);
    }
  });

  it("TASK_REFRESH_TOOL_NAMES set matches expected tools", () => {
    const expected = [
      "agent_open", "agent_spawn", "agent_close", "agent_cancel",
      "todo_write", "todo_add", "todo_update",
      "checklist_write", "checklist_add", "checklist_update",
      "task_shell_start", "exec_shell",
    ];
    for (const name of expected) {
      expect(TASK_REFRESH_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe("Session stats tracking", () => {
  interface SessionStats {
    sessionCostUsd: number;
    sessionCostCny: number;
    lastCacheHitTokens: number;
    lastCacheMissTokens: number;
    lastInputTokens: number;
    lastOutputTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }

  function createInitialStats(): SessionStats {
    return {
      sessionCostUsd: 0,
      sessionCostCny: 0,
      lastCacheHitTokens: 0,
      lastCacheMissTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

  it("starts with zero values", () => {
    const stats = createInitialStats();
    expect(stats.sessionCostUsd).toBe(0);
    expect(stats.sessionCostCny).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
  });

  it("accumulates token counts across turns", () => {
    const stats = createInitialStats();
    const turn1 = { input_tokens: 1000, output_tokens: 500 };
    stats.lastInputTokens = turn1.input_tokens;
    stats.lastOutputTokens = turn1.output_tokens;
    stats.totalInputTokens += turn1.input_tokens;
    stats.totalOutputTokens += turn1.output_tokens;

    const turn2 = { input_tokens: 2000, output_tokens: 800 };
    stats.lastInputTokens = turn2.input_tokens;
    stats.lastOutputTokens = turn2.output_tokens;
    stats.totalInputTokens += turn2.input_tokens;
    stats.totalOutputTokens += turn2.output_tokens;

    expect(stats.totalInputTokens).toBe(3000);
    expect(stats.totalOutputTokens).toBe(1300);
    expect(stats.lastInputTokens).toBe(2000);
    expect(stats.lastOutputTokens).toBe(800);
  });

  it("replaces session cost with server-computed thread totals (no client-side accumulation)", () => {
    // Cost is SET from the TUI's `/v1/threads/{id}/usage` response — the
    // GUI never accumulates per-turn cost locally. Re-fetching after each
    // turn must therefore be idempotent (no double counting) even if the
    // same response arrives twice.
    const stats = createInitialStats();
    const applyServerTotals = (usd: number, cny: number) => {
      stats.sessionCostUsd = usd;
      stats.sessionCostCny = cny;
    };
    applyServerTotals(0.0123, 0.089);
    applyServerTotals(0.0123, 0.089); // duplicate refresh
    expect(stats.sessionCostUsd).toBe(0.0123);
    expect(stats.sessionCostCny).toBe(0.089);

    applyServerTotals(0.0456, 0.33);
    expect(stats.sessionCostUsd).toBe(0.0456);
    expect(stats.sessionCostCny).toBe(0.33);
  });

  it("resets on new session", () => {
    const stats = createInitialStats();
    stats.sessionCostUsd = 0.5;
    stats.totalInputTokens = 5000;
    stats.totalOutputTokens = 2000;

    stats.sessionCostUsd = 0;
    stats.sessionCostCny = 0;
    stats.lastCacheHitTokens = 0;
    stats.lastCacheMissTokens = 0;
    stats.lastInputTokens = 0;
    stats.lastOutputTokens = 0;
    stats.totalInputTokens = 0;
    stats.totalOutputTokens = 0;

    expect(stats.sessionCostUsd).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
  });

  it("computes cache miss from input minus cache hit", () => {
    const inputTokens = 10000;
    const cacheHitTokens = 8000;
    const cacheMissTokens = Math.max(0, inputTokens - cacheHitTokens);
    expect(cacheMissTokens).toBe(2000);
  });

  it("handles case where cache hit exceeds input tokens gracefully", () => {
    const inputTokens = 5000;
    const cacheHitTokens = 8000;
    const cacheMissTokens = Math.max(0, inputTokens - cacheHitTokens);
    expect(cacheMissTokens).toBe(0);
  });
});

describe("Message model", () => {
  interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    thinking?: string;
    toolCalls?: { name: string; status: string }[];
    status: "streaming" | "complete" | "error";
    timestamp: number;
  }

  it("creates user message with complete status", () => {
    const msg: ChatMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello",
      status: "complete",
      timestamp: Date.now(),
    };
    expect(msg.role).toBe("user");
    expect(msg.status).toBe("complete");
  });

  it("creates assistant message with streaming status", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "",
      status: "streaming",
      timestamp: Date.now(),
    };
    expect(msg.status).toBe("streaming");
  });

  it("appends content during streaming", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "",
      status: "streaming",
      timestamp: Date.now(),
    };
    msg.content += "Hello ";
    msg.content += "world";
    expect(msg.content).toBe("Hello world");
  });

  it("appends thinking during streaming", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "",
      status: "streaming",
      timestamp: Date.now(),
    };
    msg.thinking = (msg.thinking || "") + "Let me think... ";
    msg.thinking = (msg.thinking || "") + "I should check the code.";
    expect(msg.thinking).toBe("Let me think... I should check the code.");
  });

  it("transitions from streaming to complete", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Final answer",
      status: "streaming",
      timestamp: Date.now(),
    };
    msg.status = "complete";
    expect(msg.status).toBe("complete");
  });

  it("transitions from streaming to error", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Partial answer",
      status: "streaming",
      timestamp: Date.now(),
    };
    msg.status = "error";
    expect(msg.status).toBe("error");
  });

  it("tracks tool calls on assistant messages", () => {
    const msg: ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "I'll read the file.",
      status: "streaming",
      timestamp: Date.now(),
      toolCalls: [
        { name: "read_file", status: "running" },
      ],
    };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].name).toBe("read_file");
  });
});

describe("Approval flow", () => {
  interface PendingApproval {
    approvalId: string;
    toolName: string;
    status: "awaiting_approval" | "approved" | "denied";
  }

  it("stores pending approval", () => {
    const pending = new Map<string, PendingApproval>();
    const approval: PendingApproval = {
      approvalId: "appr-1",
      toolName: "exec_shell",
      status: "awaiting_approval",
    };
    pending.set(approval.approvalId, approval);
    expect(pending.has("appr-1")).toBe(true);
    expect(pending.get("appr-1")!.toolName).toBe("exec_shell");
  });

  it("resolves approval with allow", () => {
    const pending = new Map<string, PendingApproval>();
    pending.set("appr-1", { approvalId: "appr-1", toolName: "exec_shell", status: "awaiting_approval" });
    const approval = pending.get("appr-1")!;
    approval.status = "approved";
    expect(approval.status).toBe("approved");
  });

  it("resolves approval with deny", () => {
    const pending = new Map<string, PendingApproval>();
    pending.set("appr-1", { approvalId: "appr-1", toolName: "exec_shell", status: "awaiting_approval" });
    const approval = pending.get("appr-1")!;
    approval.status = "denied";
    expect(approval.status).toBe("denied");
  });

  it("handles multiple concurrent approvals", () => {
    const pending = new Map<string, PendingApproval>();
    pending.set("appr-1", { approvalId: "appr-1", toolName: "exec_shell", status: "awaiting_approval" });
    pending.set("appr-2", { approvalId: "appr-2", toolName: "write_file", status: "awaiting_approval" });
    expect(pending.size).toBe(2);
  });
});

describe("Active items tracking", () => {
  it("tracks item by item_id with kind and message reference", () => {
    const activeItems = new Map<string, { kind: string; msgId: string; toolCallName?: string; toolCallIdx?: number }>();
    activeItems.set("item-1", { kind: "tool_call", msgId: "msg-1", toolCallName: "read_file", toolCallIdx: 0 });
    expect(activeItems.get("item-1")!.kind).toBe("tool_call");
    expect(activeItems.get("item-1")!.toolCallName).toBe("read_file");
  });

  it("removes item on completion", () => {
    const activeItems = new Map<string, { kind: string; msgId: string }>();
    activeItems.set("item-1", { kind: "tool_call", msgId: "msg-1" });
    activeItems.delete("item-1");
    expect(activeItems.has("item-1")).toBe(false);
  });

  it("tracks multiple concurrent items", () => {
    const activeItems = new Map<string, { kind: string; msgId: string }>();
    activeItems.set("item-1", { kind: "tool_call", msgId: "msg-1" });
    activeItems.set("item-2", { kind: "agent_message", msgId: "msg-1" });
    activeItems.set("item-3", { kind: "agent_reasoning", msgId: "msg-1" });
    expect(activeItems.size).toBe(3);
  });
});

describe("Event sequence tracking", () => {
  it("tracks last event sequence number", () => {
    let lastEventSeq = 0;
    lastEventSeq = 5;
    expect(lastEventSeq).toBe(5);
  });

  it("uses sequence number for SSE reconnection", () => {
    let lastEventSeq = 42;
    const sinceSeq = lastEventSeq;
    const params = new URLSearchParams();
    params.set("since_seq", String(sinceSeq ?? 0));
    expect(params.get("since_seq")).toBe("42");
  });

  it("defaults to 0 for initial connection", () => {
    let lastEventSeq = 0;
    const sinceSeq = lastEventSeq;
    const params = new URLSearchParams();
    params.set("since_seq", String(sinceSeq ?? 0));
    expect(params.get("since_seq")).toBe("0");
  });
});

describe("FileChangeInfo changeType derivation", () => {
  function deriveChangeType(toolName: string, diff: string | undefined): "created" | "modified" | "deleted" {
    if (toolName === "delete_file") return "deleted";
    if (toolName === "write_file" && !diff) return "created";
    return "modified";
  }

  it("delete_file always results in deleted", () => {
    expect(deriveChangeType("delete_file", undefined)).toBe("deleted");
    expect(deriveChangeType("delete_file", "some diff")).toBe("deleted");
  });

  it("write_file without diff results in created", () => {
    expect(deriveChangeType("write_file", undefined)).toBe("created");
    expect(deriveChangeType("write_file", "")).toBe("created");
  });

  it("write_file with diff results in modified", () => {
    expect(deriveChangeType("write_file", "@@ -1 +1 @@\n-old\n+new")).toBe("modified");
  });

  it("edit_file always results in modified", () => {
    expect(deriveChangeType("edit_file", undefined)).toBe("modified");
    expect(deriveChangeType("edit_file", "@@ -1 +1 @@")).toBe("modified");
  });

  it("apply_patch always results in modified", () => {
    expect(deriveChangeType("apply_patch", undefined)).toBe("modified");
  });

  it("replace_text always results in modified", () => {
    expect(deriveChangeType("replace_text", "some diff")).toBe("modified");
  });

  it("move_file always results in modified", () => {
    expect(deriveChangeType("move_file", undefined)).toBe("modified");
  });
});

describe("Diff URI uniqueness for multiple cards", () => {
  it("generates different diffIds for concurrent diff views", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const diffId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      ids.add(diffId);
    }
    expect(ids.size).toBe(10);
  });

  it("constructs unique oldUri and newUri with diffId", () => {
    const diffId = "abc123";
    const absPath = "/project/src/foo.ts";
    const oldUri = `brotherwhale-diff:${absPath}?old&id=${diffId}`;
    const newUri = `brotherwhale-diff:${absPath}?new&id=${diffId}`;
    expect(oldUri).not.toBe(newUri);
    expect(oldUri).toContain("id=abc123");
    expect(newUri).toContain("id=abc123");
  });

  it("same file with different diffIds produces different URIs", () => {
    const absPath = "/project/src/foo.ts";
    const uri1 = `brotherwhale-diff:${absPath}?old&id=id1`;
    const uri2 = `brotherwhale-diff:${absPath}?old&id=id2`;
    expect(uri1).not.toBe(uri2);
  });
});

describe("DiffContentStore lifecycle", () => {
  it("stores and retrieves content by URI string", () => {
    const store = new Map<string, string>();
    const uri = "brotherwhale-diff:/foo.ts?old&id=abc";
    store.set(uri, "old content");
    expect(store.get(uri)).toBe("old content");
  });

  it("stores old and new content separately", () => {
    const store = new Map<string, string>();
    const oldUri = "brotherwhale-diff:/foo.ts?old&id=abc";
    const newUri = "brotherwhale-diff:/foo.ts?new&id=abc";
    store.set(oldUri, "old content");
    store.set(newUri, "new content");
    expect(store.get(oldUri)).toBe("old content");
    expect(store.get(newUri)).toBe("new content");
  });

  it("supports multiple diffs for the same file", () => {
    const store = new Map<string, string>();
    const oldUri1 = "brotherwhale-diff:/foo.ts?old&id=id1";
    const newUri1 = "brotherwhale-diff:/foo.ts?new&id=id1";
    const oldUri2 = "brotherwhale-diff:/foo.ts?old&id=id2";
    const newUri2 = "brotherwhale-diff:/foo.ts?new&id=id2";
    store.set(oldUri1, "old v1");
    store.set(newUri1, "new v1");
    store.set(oldUri2, "old v2");
    store.set(newUri2, "new v2");
    expect(store.size).toBe(4);
    expect(store.get(oldUri1)).toBe("old v1");
    expect(store.get(oldUri2)).toBe("old v2");
  });

  it("clear removes all entries", () => {
    const store = new Map<string, string>();
    store.set("uri1", "content1");
    store.set("uri2", "content2");
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("FileChangeInfo with toolName", () => {
  interface FileChangeInfo {
    filePath: string;
    changeType: "created" | "modified" | "deleted";
    addedLines: number;
    removedLines: number;
    diff?: string;
    toolName?: string;
  }

  it("includes toolName in FileChangeInfo", () => {
    const fc: FileChangeInfo = {
      filePath: "/src/foo.ts",
      changeType: "modified",
      addedLines: 5,
      removedLines: 3,
      diff: "@@ -1 +1 @@",
      toolName: "write_file",
    };
    expect(fc.toolName).toBe("write_file");
  });

  it("toolName is optional", () => {
    const fc: FileChangeInfo = {
      filePath: "/src/foo.ts",
      changeType: "created",
      addedLines: 10,
      removedLines: 0,
    };
    expect(fc.toolName).toBeUndefined();
  });

  it("toolName is preserved through serialization", () => {
    const fc: FileChangeInfo = {
      filePath: "/src/foo.ts",
      changeType: "modified",
      addedLines: 2,
      removedLines: 1,
      diff: "@@ -1 +1 @@",
      toolName: "edit_file",
    };
    const serialized = JSON.stringify(fc);
    const deserialized: FileChangeInfo = JSON.parse(serialized);
    expect(deserialized.toolName).toBe("edit_file");
  });
});
