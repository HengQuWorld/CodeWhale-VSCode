/**
 * Tests for P0-Problem4: Unified SessionState management.
 *
 * Verifies that SessionStateStore correctly manages session state
 * with a single reset() method, replacing scattered manual resets.
 */
import { describe, it, expect } from "vitest";
import {
  SessionStateStore,
  type SessionStateData,
  type ChatMessage,
  type FileChangeInfo,
  type ToolCallInfo,
  type ActiveItem,
} from "./session-state";

// ── Tests ──

describe("SessionStateStore - initial state", () => {
  it("starts with all fields at their default values", () => {
    const store = new SessionStateStore();
    const s = store.data;

    expect(s.currentThread).toBeNull();
    expect(s.viewingSessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.lastEventSeq).toBe(0);
    expect(s.currentTurnId).toBeNull();
    expect(s.activeItems.size).toBe(0);
    expect(s.currentTextBlockIdx).toBe(-1);
    expect(s.currentThinkingBlockIdx).toBe(-1);
    expect(s.cycleCount).toBe(0);
    expect(s.checklistItems).toEqual([]);
    expect(s.checklistCompletionPct).toBe(0);
    expect(s.coherenceState).toBe("healthy");
    expect(s.coherenceLabel).toBe("");
    expect(s.turnFileChanges).toEqual([]);
    expect(s.stats.sessionCostUsd).toBe(0);
    expect(s.stats.sessionCostCny).toBe(0);
    expect(s.stats.totalInputTokens).toBe(0);
    expect(s.stats.totalOutputTokens).toBe(0);
    expect(s.pendingApprovals.size).toBe(0);
    expect(s.pendingUserInputs.size).toBe(0);
  });

  it("hasActiveThread is false initially", () => {
    const store = new SessionStateStore();
    expect(store.hasActiveThread).toBe(false);
  });

  it("isViewingSession is false initially", () => {
    const store = new SessionStateStore();
    expect(store.isViewingSession).toBe(false);
  });
});

describe("SessionStateStore - reset()", () => {
  it("resets all fields after they have been modified", () => {
    const store = new SessionStateStore();

    // Simulate an active session with lots of state
    store.update({
      currentThread: { id: "thread-1", workspace: "/ws", created_at: "", updated_at: "" } as any,
      viewingSessionId: "session-1",
      messages: [
        { id: "msg-1", role: "user", content: "Hello", status: "complete", timestamp: Date.now() },
        { id: "msg-2", role: "assistant", content: "Hi!", status: "complete", timestamp: Date.now() },
      ],
      lastEventSeq: 42,
      currentTurnId: "turn-5",
      currentTextBlockIdx: 3,
      currentThinkingBlockIdx: 1,
      cycleCount: 7,
      checklistItems: [
        { id: "1", content: "Step 1", status: "completed" },
        { id: "2", content: "Step 2", status: "in_progress" },
      ],
      checklistCompletionPct: 50,
      coherenceState: "refreshing_context",
      coherenceLabel: "Refreshing context...",
      turnFileChanges: [
        { filePath: "/src/main.ts", changeType: "modified", addedLines: 0, removedLines: 0 },
      ],
    });
    store.updateStats({
      sessionCostUsd: 0.5,
      sessionCostCny: 3.5,
      lastCacheHitTokens: 8000,
      lastCacheMissTokens: 2000,
      lastInputTokens: 10000,
      lastOutputTokens: 2000,
      totalInputTokens: 50000,
      totalOutputTokens: 10000,
    });
    store.data.activeItems.set("item-1", {
      kind: "tool_call",
      msgId: "msg-2",
      toolCallName: "read_file",
    });
    store.data.pendingApprovals.set("appr-1", {
      name: "exec_shell",
      input: {},
      status: "awaiting_approval",
    });

    // Verify state is dirty
    expect(store.hasActiveThread).toBe(true);
    expect(store.isViewingSession).toBe(true);
    expect(store.data.messages).toHaveLength(2);
    expect(store.data.stats.sessionCostUsd).toBe(0.5);

    // Reset
    store.reset();

    // Verify everything is back to defaults
    const s = store.data;
    expect(s.currentThread).toBeNull();
    expect(s.viewingSessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.lastEventSeq).toBe(0);
    expect(s.currentTurnId).toBeNull();
    expect(s.activeItems.size).toBe(0);
    expect(s.currentTextBlockIdx).toBe(-1);
    expect(s.currentThinkingBlockIdx).toBe(-1);
    expect(s.cycleCount).toBe(0);
    expect(s.checklistItems).toEqual([]);
    expect(s.checklistCompletionPct).toBe(0);
    expect(s.coherenceState).toBe("healthy");
    expect(s.coherenceLabel).toBe("");
    expect(s.turnFileChanges).toEqual([]);
    expect(s.stats.sessionCostUsd).toBe(0);
    expect(s.stats.sessionCostCny).toBe(0);
    expect(s.stats.lastCacheHitTokens).toBe(0);
    expect(s.stats.lastCacheMissTokens).toBe(0);
    expect(s.stats.lastInputTokens).toBe(0);
    expect(s.stats.lastOutputTokens).toBe(0);
    expect(s.stats.totalInputTokens).toBe(0);
    expect(s.stats.totalOutputTokens).toBe(0);
    expect(s.pendingApprovals.size).toBe(0);
    expect(s.pendingUserInputs.size).toBe(0);
    expect(store.hasActiveThread).toBe(false);
    expect(store.isViewingSession).toBe(false);
  });

  it("creates fresh Map instances on reset (no shared references)", () => {
    const store = new SessionStateStore();
    const oldActiveItems = store.data.activeItems;
    const oldApprovals = store.data.pendingApprovals;

    oldActiveItems.set("item-1", { kind: "tool_call", msgId: "msg-1" });
    oldApprovals.set("appr-1", { name: "exec_shell", input: {}, status: "awaiting_approval" });

    store.reset();

    // Old maps should not affect new state
    expect(store.data.activeItems.size).toBe(0);
    expect(store.data.pendingApprovals.size).toBe(0);

    // Mutating old maps should not affect new state
    oldActiveItems.set("item-2", { kind: "text", msgId: "msg-2" });
    expect(store.data.activeItems.size).toBe(0);
  });

  it("creates fresh array instances on reset (no shared references)", () => {
    const store = new SessionStateStore();
    store.update({
      messages: [{ id: "msg-1", role: "user", content: "Hi", status: "complete", timestamp: 1 }],
      checklistItems: [{ id: "1", content: "Step", status: "pending" }],
      turnFileChanges: [{ filePath: "/a.ts", changeType: "modified", addedLines: 0, removedLines: 0 }],
    });

    const oldMessages = store.data.messages;
    const oldChecklist = store.data.checklistItems;

    store.reset();

    // Mutating old arrays should not affect new state
    oldMessages.push({ id: "msg-2", role: "assistant", content: "Hey", status: "complete", timestamp: 2 });
    oldChecklist.push({ id: "2", content: "New", status: "pending" });

    expect(store.data.messages).toHaveLength(0);
    expect(store.data.checklistItems).toHaveLength(0);
  });
});

describe("SessionStateStore - update()", () => {
  it("updates individual fields without affecting others", () => {
    const store = new SessionStateStore();
    store.update({ currentTurnId: "turn-1" });
    expect(store.data.currentTurnId).toBe("turn-1");
    expect(store.data.viewingSessionId).toBeNull(); // unchanged
    expect(store.data.stats.sessionCostUsd).toBe(0); // unchanged
  });

  it("updates multiple fields at once", () => {
    const store = new SessionStateStore();
    store.update({
      currentTurnId: "turn-1",
      cycleCount: 3,
    });
    expect(store.data.currentTurnId).toBe("turn-1");
    expect(store.data.cycleCount).toBe(3);
  });

  it("updateStats only affects stats sub-object", () => {
    const store = new SessionStateStore();
    store.updateStats({
      sessionCostUsd: 1.5,
      totalInputTokens: 50000,
    });
    expect(store.data.stats.sessionCostUsd).toBe(1.5);
    expect(store.data.stats.totalInputTokens).toBe(50000);
    expect(store.data.stats.sessionCostCny).toBe(0); // unchanged
    expect(store.data.currentTurnId).toBeNull(); // top-level unchanged
  });
});

describe("SessionStateStore - matches current chat-provider reset patterns", () => {
  it("reset() covers all fields from handleNewThread()", () => {
    const store = new SessionStateStore();

    // Set all fields that handleNewThread resets
    store.update({
      currentThread: { id: "thread-old", workspace: "/ws", created_at: "", updated_at: "" } as any,
      messages: [{ id: "1", role: "user", content: "x", status: "complete", timestamp: 1 }],
      lastEventSeq: 99,
      currentTurnId: "turn-old",
      currentTextBlockIdx: 5,
      currentThinkingBlockIdx: 3,
      cycleCount: 10,
      checklistItems: [{ id: "1", content: "Done", status: "completed" }],
      checklistCompletionPct: 100,
      coherenceState: "refreshing_context",
      coherenceLabel: "Refreshing...",
      turnFileChanges: [{ filePath: "/a.ts", changeType: "modified", addedLines: 0, removedLines: 0 }],
    });
    store.updateStats({
      sessionCostUsd: 5.0,
      sessionCostCny: 35.0,
      lastCacheHitTokens: 5000,
      lastCacheMissTokens: 1000,
      lastInputTokens: 6000,
      lastOutputTokens: 500,
      totalInputTokens: 60000,
      totalOutputTokens: 5000,
    });

    store.reset();

    // All fields should be at defaults
    const s = store.data;
    expect(s.currentThread).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.lastEventSeq).toBe(0);
    expect(s.currentTurnId).toBeNull();
    expect(s.currentTextBlockIdx).toBe(-1);
    expect(s.currentThinkingBlockIdx).toBe(-1);
    expect(s.cycleCount).toBe(0);
    expect(s.checklistItems).toEqual([]);
    expect(s.checklistCompletionPct).toBe(0);
    expect(s.coherenceState).toBe("healthy");
    expect(s.coherenceLabel).toBe("");
    expect(s.turnFileChanges).toEqual([]);
    expect(s.stats.sessionCostUsd).toBe(0);
    expect(s.stats.sessionCostCny).toBe(0);
    expect(s.stats.totalInputTokens).toBe(0);
    expect(s.stats.totalOutputTokens).toBe(0);
  });

  it("reset() covers all fields from loadThread()", () => {
    const store = new SessionStateStore();

    store.update({
      currentThread: { id: "thread-old", workspace: "/ws", created_at: "", updated_at: "" } as any,
      viewingSessionId: "session-old",
      messages: [{ id: "1", role: "user", content: "x", status: "complete", timestamp: 1 }],
      lastEventSeq: 50,
      currentTurnId: "turn-old",
      activeItems: new Map([["item-1", { kind: "tool_call", msgId: "msg-1" }]]),
      currentTextBlockIdx: 2,
      currentThinkingBlockIdx: 1,
      cycleCount: 5,
      checklistItems: [{ id: "1", content: "Step", status: "completed" }],
      checklistCompletionPct: 75,
      coherenceState: "getting_crowded",
      coherenceLabel: "Crowded",
      turnFileChanges: [{ filePath: "/b.ts", changeType: "created", addedLines: 0, removedLines: 0 }],
    });
    store.updateStats({ sessionCostUsd: 2.0, totalInputTokens: 20000 });

    store.reset();

    const s = store.data;
    expect(s.viewingSessionId).toBeNull();
    expect(s.activeItems.size).toBe(0);
  });

  it("reset() covers cleanup() fields (viewingSessionId)", () => {
    const store = new SessionStateStore();
    store.update({ viewingSessionId: "session-1" });
    store.reset();
    expect(store.data.viewingSessionId).toBeNull();
  });

  it("reset() covers pendingApprovals and pendingUserInputs", () => {
    const store = new SessionStateStore();
    store.data.pendingApprovals.set("appr-1", {
      name: "exec_shell",
      input: {},
      status: "awaiting_approval",
    });
    store.data.pendingUserInputs.set("input-1", {
      threadId: "thread-1",
      questions: [{ header: "H", id: "q1", question: "Q?", options: [] }],
      answers: [],
      answeredQuestions: new Set(),
    });

    store.reset();

    expect(store.data.pendingApprovals.size).toBe(0);
    expect(store.data.pendingUserInputs.size).toBe(0);
  });
});

describe("SessionStateStore - accumulated stats across turns", () => {
  it("accumulates token counts correctly", () => {
    const store = new SessionStateStore();

    // Turn 1
    store.updateStats({
      lastInputTokens: 1000,
      lastOutputTokens: 500,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
    });

    // Turn 2
    store.updateStats({
      lastInputTokens: 2000,
      lastOutputTokens: 800,
      totalInputTokens: 3000,
      totalOutputTokens: 1300,
    });

    expect(store.data.stats.lastInputTokens).toBe(2000);
    expect(store.data.stats.lastOutputTokens).toBe(800);
    expect(store.data.stats.totalInputTokens).toBe(3000);
    expect(store.data.stats.totalOutputTokens).toBe(1300);
  });

  it("resets all stats on reset()", () => {
    const store = new SessionStateStore();
    store.updateStats({
      sessionCostUsd: 1.5,
      sessionCostCny: 10.5,
      lastCacheHitTokens: 8000,
      lastCacheMissTokens: 2000,
      lastInputTokens: 10000,
      lastOutputTokens: 2000,
      totalInputTokens: 50000,
      totalOutputTokens: 10000,
    });

    store.reset();

    const s = store.data.stats;
    expect(s.sessionCostUsd).toBe(0);
    expect(s.sessionCostCny).toBe(0);
    expect(s.lastCacheHitTokens).toBe(0);
    expect(s.lastCacheMissTokens).toBe(0);
    expect(s.lastInputTokens).toBe(0);
    expect(s.lastOutputTokens).toBe(0);
    expect(s.totalInputTokens).toBe(0);
    expect(s.totalOutputTokens).toBe(0);
  });
});
