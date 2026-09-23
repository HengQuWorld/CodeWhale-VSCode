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

/**
 * One recorded change to one file.
 *
 * A record describes a single tool call's edit, never a running total for the
 * path: the panel lists what each call did, and reverting one of them must
 * leave the others reviewable. Per-file statistics are summed where they are
 * displayed (the sidebar's summary row), not stored.
 */
export interface FileChangeInfo {
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  addedLines: number;
  removedLines: number;
  diff?: string;
  /** Position of this change within its file's history, counting only the
   *  changes that carry a diff (0-based). Rebuilding a change's before/after
   *  content walks the file's later changes back from what is on disk, so each
   *  change needs its own index. Assigned by `reindexFileChanges`. */
  changeIndex?: number;
  /** Engine call id of the tool call this record describes, when the runtime
   *  published one. The engine snapshots the whole workspace as
   *  `tool:<call_id>` before every file-modifying call, and the file-revert
   *  endpoint requires the client to name *that* snapshot — it never guesses
   *  "the newest snapshot that differs", because an unrelated newer snapshot
   *  can erase the user's later edits while leaving this change in place. */
  callId?: string;
  /** `sha256:<hex>` of the bytes this record was built from, or `absent` when
   *  the panel saw the file deleted. Sent as `expected_hash`, so the engine can
   *  tell "the file moved since the panel showed it" apart from "restore as
   *  reviewed". Captured when the change is recorded; records restored from an
   *  earlier session fall back to the current bytes at click time. */
  expectedHash?: string;
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
  /** Per-turn usage, stamped onto a turn's final assistant message so the
   *  reloaded view shows the same ↑/↓ token chip as the live view. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  } | null;
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
  /** Workspace a viewed session was recorded in. Its file tools recorded
   *  workspace-relative paths against *that* root, which is not necessarily
   *  the workspace currently open in VSCode. */
  viewingSessionWorkspace: string | null;
  /** Provider route a viewed session was saved on. A session that is only
   *  being *viewed* has no thread yet, so without this the toolbar described
   *  the picker's route while the conversation on screen would run on its own
   *  the moment a message resumed it. */
  viewingSessionProvider: string | null;
  viewingSessionProviderId: string | null;
  /** Model a viewed session was saved with. The toolbar's model chip and the
   *  route's model list both describe what is on screen, and for a viewed
   *  session that is this model — not the route's current default, which is
   *  what a lookup with no thread to read would fall back to. */
  viewingSessionModel: string | null;
  /** Session ID for auto-save — same thread always saves to the same session */
  currentSessionId: string | null;
  messages: ChatMessage[];
  lastEventSeq: number;
  currentTurnId: string | null;
  activeItems: Map<string, ActiveItem>;
  currentTextBlockIdx: number;
  currentThinkingBlockIdx: number;
  checklistItems: ChecklistItem[];
  checklistCompletionPct: number;
  /** Strategy steps from update_plan tool calls */
  strategySteps: StrategyStep[];
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
    viewingSessionWorkspace: null,
    viewingSessionProvider: null,
    viewingSessionProviderId: null,
    viewingSessionModel: null,
    currentSessionId: null,
    messages: [],
    lastEventSeq: 0,
    currentTurnId: null,
    activeItems: new Map(),
    currentTextBlockIdx: -1,
    currentThinkingBlockIdx: -1,
    checklistItems: [],
    checklistCompletionPct: 0,
    strategySteps: [],
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
