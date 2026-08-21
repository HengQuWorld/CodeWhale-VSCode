/**
 * Unified session state for ChatProvider.
 *
 * Replaces the 20+ scattered instance variables that were manually
 * reset in handleNewThread(), loadThread(), loadSessionMessages(),
 * and cleanup(). A single reset() call now covers all fields.
 */

import type { ThreadRecord } from "../types";

export interface ContentBlock {
  type: "text" | "thinking" | "tool_call";
  content?: string;
  contentHtml?: string;
  toolCallIdx?: number;
}

export interface ToolCallInfo {
  name: string;
  displayName?: string;
  input: Record<string, unknown>;
  output?: string;
  status: "pending" | "running" | "complete" | "error" | "awaiting_approval";
  approvalId?: string;
  approvalSummary?: string;
  itemId?: string;
  fileChange?: FileChangeInfo;
}

export interface FileChangeInfo {
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  addedLines: number;
  removedLines: number;
  diff?: string;
  /** All diffs for this file across the session, in chronological order */
  diffs?: string[];
  /** Index of this diff in the diffs array, used to reconstruct state for per-card diff */
  diffIndex?: number;
  oldContent?: string;
  newContent?: string;
  toolName?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  contentHtml?: string;
  thinkingHtml?: string;
  toolCalls?: ToolCallInfo[];
  blocks?: ContentBlock[];
  status: "streaming" | "complete" | "error";
  timestamp: number;
  /** True when this user message was sent as mid-turn steering (TUI steer). */
  steered?: boolean;
}

export interface ChecklistItem {
  id: string;
  content: string;
  status: string;
}

/** A single step in an update_plan strategy, restored from session tool calls */
export interface StrategyStep {
  text: string;
  status: string;
}

export interface ActiveItem {
  kind: string;
  msgId: string;
  toolCallName?: string;
  toolCallIdx?: number;
  blockIdx?: number;
}

export interface UserInputState {
  threadId: string;
  questions: Array<{
    header: string;
    id: string;
    question: string;
    options: Array<{ label: string; description: string }>;
  }>;
  answers: Array<{ id: string; label: string; value: string }>;
  answeredQuestions: Set<string>;
}

export interface SessionStats {
  sessionCostUsd: number;
  sessionCostCny: number;
  /** Monotonic high-water mark for displayed cost — survives session
   *  restarts so the UI never shows a lower total than previously seen
   *  (mirrors TUI's displayed_cost_high_water, ui.rs:9560-9567). */
  displayedCostHighWaterUsd: number;
  displayedCostHighWaterCny: number;
  lastCacheHitTokens: number;
  lastCacheMissTokens: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Cumulative input tokens across all turns (for display parity with
   *  TUI's session.total_tokens, ui.rs:9549). */
  totalTokens: number;
  /** Cumulative turn duration in seconds (mirrors TUI's
   *  cumulative_turn_duration, ui.rs:9573). */
  cumulativeTurnSecs: number;
}

// ── Session State ──

export interface SessionStateData {
  currentThread: ThreadRecord | null;
  viewingSessionId: string | null;
  /** Session ID for auto-save — same thread always saves to the same session */
  currentSessionId: string | null;
  messages: ChatMessage[];
  lastEventSeq: number;
  currentTurnId: string | null;
  activeItems: Map<string, ActiveItem>;
  currentTextBlockIdx: number;
  currentThinkingBlockIdx: number;
  cycleCount: number;
  checklistItems: ChecklistItem[];
  checklistCompletionPct: number;
  /** Strategy steps from update_plan tool calls */
  strategySteps: StrategyStep[];
  coherenceState: string;
  coherenceLabel: string;
  turnFileChanges: FileChangeInfo[];
  stats: SessionStats;
  pendingApprovals: Map<string, ToolCallInfo>;
  pendingUserInputs: Map<string, UserInputState>;
  /** Cost snapshot from the original session, stashed by loadSessionMessages
   *  and restored after resumeSessionThread + loadThread (which zero stats
   *  because seeded turns have no usage data). Mirrors TUI's
   *  apply_loaded_session cost restoration. */
  pendingSessionCost: SessionCostSnapshot | null;
}

/** Cost fields restored from session.metadata.cost after resume. */
export interface SessionCostSnapshot {
  sessionCostUsd: number;
  sessionCostCny: number;
  subagentCostUsd: number;
  subagentCostCny: number;
  displayedCostHighWaterUsd: number;
  displayedCostHighWaterCny: number;
  totalTokens: number;
  cumulativeTurnSecs: number;
}

function createEmptyState(): SessionStateData {
  return {
    currentThread: null,
    viewingSessionId: null,
    currentSessionId: null,
    messages: [],
    lastEventSeq: 0,
    currentTurnId: null,
    activeItems: new Map(),
    currentTextBlockIdx: -1,
    currentThinkingBlockIdx: -1,
    cycleCount: 0,
    checklistItems: [],
    checklistCompletionPct: 0,
    strategySteps: [],
    coherenceState: "healthy",
    coherenceLabel: "",
    turnFileChanges: [],
    stats: {
      sessionCostUsd: 0,
      sessionCostCny: 0,
      displayedCostHighWaterUsd: 0,
      displayedCostHighWaterCny: 0,
      lastCacheHitTokens: 0,
      lastCacheMissTokens: 0,
      lastInputTokens: 0,
      lastOutputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      cumulativeTurnSecs: 0,
    },
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    pendingSessionCost: null,
  };
}

/**
 * Manages session state with a single reset point.
 * All state transitions go through update() or direct property access.
 */
export class SessionStateStore {
  private state: SessionStateData = createEmptyState();

  /** Reset all session state to initial values */
  reset(): void {
    this.state = createEmptyState();
  }

  /** Get the mutable state object (for direct property access) */
  get data(): SessionStateData {
    return this.state;
  }

  /** Update specific fields of the state */
  update(patch: Partial<SessionStateData>): void {
    Object.assign(this.state, patch);
  }

  /** Update only the stats sub-object */
  updateStats(patch: Partial<SessionStats>): void {
    Object.assign(this.state.stats, patch);
  }

  /** Check if a thread is currently active */
  get hasActiveThread(): boolean {
    return this.state.currentThread !== null;
  }

  /** Check if viewing a saved session */
  get isViewingSession(): boolean {
    return this.state.viewingSessionId !== null;
  }
}
