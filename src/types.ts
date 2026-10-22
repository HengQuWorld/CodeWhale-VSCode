// ── Types matching DeepSeek Runtime API ──
// Extracted from api-client.ts for clean module boundaries.
// api-client.ts re-exports these for backward compatibility.

export interface ThreadRecord {
  schema_version: number;
  id: string;
  created_at: string;
  updated_at: string;
  model: string;
  /** The provider kind this thread runs on, with the exact configured route in
   *  `model_provider_id` when it has one — the pair `POST /v1/threads` pins at
   *  creation. Both are optional: a runtime older than the fields omits them,
   *  and absent means "the runtime's active route", which is how this client
   *  behaved before it sent an explicit pair. */
  model_provider?: string | null;
  model_provider_id?: string | null;
  workspace: string;
  mode: string;
  /** Named default permission posture for new turns: `ask` | `auto_review` |
   *  `full_access`. Absent on legacy records, whose effective posture is
   *  derived from `auto_approve` / `trust_mode`. */
  permission_posture?: string | null;
  allow_shell: boolean;
  trust_mode: boolean;
  auto_approve: boolean;
  latest_turn_id: string | null;
  latest_response_bookmark?: string | null;
  archived: boolean;
  system_prompt?: string | null;
  task_id?: string | null;
  title?: string | null;
  /** The saved session this thread reads and writes. The runtime owns this
   *  binding, and `PUT /v1/sessions` updates that document in place — a client
   *  that drops the id has its next auto-save mint a second document for the
   *  same conversation and orphan the first. */
  session_id?: string | null;
}

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id: string | null;
  latest_turn_status: string | null;
  /** Count of pending approvals / user inputs on the thread's latest turn.
   *  Non-zero on a background thread (e.g. a goal loop waiting for a tool
   *  approval) is surfaced as an attention badge in the sidebar. */
  pending_attention_count?: number | null;
  /** The saved session this thread reads and writes.
   *
   *  `GET /v1/threads/summary` does not carry the binding — this client reads
   *  it from `GET /v1/threads` and merges it onto the row. It is the only link
   *  from a branch back to the conversation it was cut from: the session a
   *  fork is given names its source in `parent_session_id`, while the two
   *  conversations carry the same title, both deriving it from the same first
   *  user message. Absent when the runtime reports no session, which is also
   *  read as "no branch to draw". */
  session_id?: string | null;
}

export interface TurnRecord {
  schema_version: number;
  id: string;
  thread_id: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled";
  input_summary: string;
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    reasoning_tokens?: number;
  } | null;
  error?: string | null;
  item_ids: string[];
  steer_count: number;
  /** Mode this turn ran in (`agent` / `plan` / `operate`). Recorded per turn
   *  because the thread's own `mode` may have been switched while the turn was
   *  running; runtimes older than this field omit it. */
  mode?: string | null;
  /** Workspace restore points the engine reported while this turn ran, in the
   *  order it reported them.
   *
   *  With `record_restore_points` (every Runtime thread) the engine brackets
   *  each call that may write — a file tool, a shell command, a program, a
   *  write-capable MCP tool — with a `tool:<call_id>` receipt before it and a
   *  `post_tool:<call_id>` receipt after it, and takes `pre_turn`/`post_turn`
   *  around the turn itself. `post_tool.changed_paths` is what that one call
   *  changed, which is how a command's writes are attributable at all: a
   *  shell call records no `metadata.mutation` for them. Absent on turns
   *  recorded before receipts existed, on turns imported from a saved session,
   *  and on turns that ran with snapshots off. */
  workspace_snapshots?: WorkspaceSnapshotRef[];
}

/** One workspace restore point the engine took on behalf of a turn. */
export interface WorkspaceSnapshotRef {
  kind: "pre_turn" | "tool" | "post_tool" | "post_turn";
  /** Commit id when it was taken. A prune rebuilds the side repo and rewrites
   *  commit ids; `tree_id` still resolves the snapshot then. */
  snapshot_id: string;
  /** Root tree of the snapshot — the durable identity. */
  tree_id: string;
  /** The tag the snapshot was taken under: the thread's own id for turns a
   *  Runtime thread ran itself. */
  session_id: string;
  /** The call that runs from this snapshot to the next one of the turn. It is
   *  the same id `TurnItemRecord.metadata.tool_use_id` carries, so a receipt
   *  and its tool row can be matched without guessing. */
  tool_call_id?: string;
  /** For a `tool` receipt of a file tool: the paths the call declared it
   *  writes. Absent for a tool whose writes are not declared (a shell command,
   *  a program), which may change any path. */
  write_paths?: string[];
  /** Workspace-relative paths whose content changed since the turn's previous
   *  receipt — what happened in the span this receipt closes. Absent on
   *  `pre_turn`, and when it could not be computed. */
  changed_paths?: string[];
}

export interface TurnItemRecord {
  schema_version: number;
  id: string;
  turn_id: string;
  kind: "user_message" | "agent_message" | "agent_reasoning" | "tool_call" | "file_change" | "command_execution" | "context_compaction" | "status" | "error";
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled";
  summary: string;
  detail: string | null;
  metadata?: Record<string, unknown> | null;
  artifact_refs: string[];
  started_at?: string | null;
  ended_at?: string | null;
}

export interface RuntimeEvent {
  seq: number;
  timestamp: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  event: string;
  payload: Record<string, unknown>;
}

export interface StartTurnResponse {
  thread: ThreadRecord;
  turn: TurnRecord;
}

export interface UndoTurnResponse {
  thread: ThreadRecord;
  original_user_text: string | null;
}

export interface PatchUndoResult {
  files_restored: boolean;
  summary: string | null;
  snapshot_label: string | null;
}

export interface PatchUndoResponse {
  patch_result: PatchUndoResult;
  thread: ThreadRecord;
  original_user_text: string | null;
}

export interface RetryTurnResponse {
  thread: ThreadRecord;
  turn: TurnRecord;
}

export interface SnapshotEntry {
  id: string;
  label: string;
  timestamp: number;
}

/** Native memory entry from `GET /v1/memory` / `POST /v1/memory`.
 *  Field names mirror the TUI's `MemoryEntryRecord`
 *  (runtime_api.rs `memory_hit_to_record`). */
export interface MemoryEntryRecord {
  id: number;
  scope: string;
  workspace_id: string | null;
  summary: string;
  stale: boolean;
  line_start: number;
  line_end: number;
  status: string;
}

export interface MemoryListResponse {
  entries: MemoryEntryRecord[];
  total: number;
}

export interface MemoryEntryResponse {
  entry: MemoryEntryRecord;
}

export interface ClearMemoryResponse {
  cleared: boolean;
}

// ── Context Lens (`/v1/memory/lens`)
//
// A different view of the same store as `MemoryEntryRecord`. The flat listing
// above is filtered to live memory on the engine side, so a `candidate` is not
// visible there at all; the Lens is the only read that shows one, and the only
// one that reports whether the caller may review it. Field names mirror the
// TUI's `LensEntry` / `LensSnapshot` (crates/memory/src/lens.rs).

/** The four lifecycle states an entry can be reviewed out of, in the engine's
 *  own vocabulary. `candidate` is not in context and not yet a fact the model
 *  is given: it is the model's proposal, or a note that has not been reviewed. */
export type MemoryLensStatus =
  | "candidate"
  | "active"
  | "stale"
  | "superseded"
  | "rejected";

/** Which scope a memory belongs to. Global entries are the tenant/user pair;
 *  workspace entries add the id derived from the repo's git origin, which is
 *  what keeps one repo's notes out of another repo's prompt. */
export interface MemoryScopeDescriptor {
  tenant: string;
  user: string;
  workspace?: string;
  branch?: string;
  session?: string;
  agent?: string;
}

export interface MemoryEvidence {
  kind: string;
  uri: string;
  locator: string;
  sha256: string | null;
  observed_at: number;
}

export interface MemoryLensDraft {
  scope: MemoryScopeDescriptor;
  kind: string;
  title: string;
  body: string;
  key: string | null;
  tags: string[];
  confidence: number;
  importance: number;
  evidence: MemoryEvidence[];
  repository_revision: string | null;
  dependencies: Record<string, unknown>;
  expires_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  parent_ids: string[];
}

export interface MemoryLensPreferences {
  revision: number;
  /** Pinned entries keep their place in the context budget. */
  pinned: boolean;
  /** Suppressed entries stay in the store but are never injected. */
  suppressed: boolean;
}

export interface MemoryLensEntry {
  memory: {
    /** A UUID, unlike `MemoryEntryRecord.id`, which is the listing's row
     *  number. The two are not interchangeable. */
    id: string;
    revision: number;
    status: MemoryLensStatus;
    draft: MemoryLensDraft;
    created_at: number;
    updated_at: number;
    content_hash: string;
  };
  /** Why this entry is or is not in context right now. */
  freshness: string;
  preferences: MemoryLensPreferences;
  in_contexts: string[];
}

/** The engine's record of one assembled context packet. `appended_at` and
 *  `dispatched_at` are separate because a prepared packet is not proof of
 *  delivery: only the engine can acknowledge its own transport. */
export interface MemoryContextReceipt {
  id: string;
  trace_id: string;
  stage: string;
  packet_hash: string;
  created_at: number;
  appended_at: number | null;
  dispatched_at: number | null;
  used_units: number;
  unit: string;
  omitted: number;
  selected: Array<{ id: string; revision: number }>;
  /** Knowledge discovered later cannot rewrite what a previous request
   *  already contained. */
  invalidated_ids: string[];
}

export interface MemoryLensSnapshot {
  schema: string;
  entries: MemoryLensEntry[];
  next_after: string | null;
  contexts: MemoryContextReceipt[];
  as_of: number;
  /** The operator controls the bound request actually holds. A client shows
   *  or hides the review buttons from these rather than from an assumption
   *  about who is calling. */
  can_review: boolean;
  can_forget: boolean;
  can_dispatch: boolean;
}

/** One Lens mutation. `revision` is the revision the caller read: the engine
 *  refuses a write against an entry that moved on. */
export type MemoryLensAction =
  | { action: "approve"; id: string; revision: number }
  | { action: "reject"; id: string; revision: number }
  | { action: "forget"; id: string; revision: number }
  | {
      action: "preferences";
      id: string;
      revision: number;
      pinned: boolean;
      suppressed: boolean;
    };

export interface MemoryLensActionResponse {
  ok: boolean;
  refresh_required: boolean;
  /** The engine's standing caveat, carried on every Lens mutation: approving
   *  or forgetting changes what later turns are given, never what a model
   *  already received. */
  already_sent_context_cannot_be_retracted: boolean;
}


export interface ThreadDetailResponse {
  thread: ThreadRecord;
  turns: TurnRecord[];
  items: TurnItemRecord[];
  latest_seq?: number;
  pending_approvals?: PendingApprovalRequest[];
  pending_user_inputs?: PendingUserInputRequest[];
}

export interface ApprovalRequest {
  approval_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  reason: string;
}

export interface PendingApprovalRequest {
  id: string;
  turn_id: string;
  tool_name: string;
  description: string;
  intent_summary?: string | null;
  /** The provider tool-call id this approval gates, mirroring `tool_call_id`
   *  on `approval.required` (runtime_threads.rs). A client resuming from a
   *  snapshot matches it against the tool row the request belongs to; it is a
   *  correlator, never a capability — a decision is delivered against `id`. */
  tool_call_id?: string | null;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  header: string;
  id: string;
  question: string;
  options: UserInputOption[];
  allow_free_text?: boolean;
  multi_select?: boolean;
}

export interface PendingUserInputRequest {
  id: string;
  turn_id: string;
  request: {
    questions: UserInputQuestion[];
  };
}

export interface TaskSummary {
  id: string;
  status: string;
  prompt_summary: string;
  model: string;
  mode: string;
  workspace: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  error: string | null;
  thread_id: string | null;
  turn_id: string | null;
  pending_approvals?: PendingApprovalRequest[];
  pending_user_inputs?: PendingUserInputRequest[];
}

export interface TaskCounts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
}

export interface TaskToolCallSummary {
  id: string;
  name: string;
  status: string;
  input_summary: string | null;
  output_summary: string | null;
  duration_ms: number | null;
  detail_path: string | null;
  patch_ref: string | null;
}

export interface TaskTimelineEntry {
  timestamp: string;
  kind: string;
  summary: string;
  detail_path: string | null;
}

export interface TaskChecklistItem {
  id: number;
  content: string;
  status: string;
}

export interface TaskChecklistState {
  items: TaskChecklistItem[];
  completion_pct: number;
  in_progress_id?: number | null;
  updated_at?: string | null;
}

export interface TaskGateRecord {
  id: string;
  gate: string;
  command: string;
  cwd: string;
  exit_code?: number | null;
  status: string;
  classification: string;
  duration_ms: number;
  summary: string;
  log_path?: string | null;
  recorded_at: string;
}

export interface TaskAttemptRecord {
  id: string;
  attempt_group_id: string;
  attempt_index: number;
  attempt_count: number;
  base_ref?: string | null;
  base_sha?: string | null;
  head_ref?: string | null;
  head_sha?: string | null;
  summary: string;
  changed_files: string[];
  patch_path?: string | null;
  verification: string[];
  selected: boolean;
  recorded_at: string;
}

export interface TaskArtifactRef {
  label: string;
  path: string;
  summary: string;
  created_at: string;
}

export interface TaskGithubEvent {
  id: string;
  action: string;
  target: string;
  number: number;
  summary: string;
  url?: string | null;
  recorded_at: string;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  model: string;
  workspace: string;
  mode: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  result_summary: string | null;
  result_detail_path: string | null;
  error: string | null;
  thread_id: string | null;
  turn_id: string | null;
  tool_calls: TaskToolCallSummary[];
  timeline: TaskTimelineEntry[];
  hunt_verdict?: string | null;
  runtime_event_count?: number;
  checklist?: TaskChecklistState;
  gates?: TaskGateRecord[];
  attempts?: TaskAttemptRecord[];
  artifacts?: TaskArtifactRef[];
  github_events?: TaskGithubEvent[];
  result_detail_content?: string | null;
  result_detail_truncated?: boolean;
  allow_shell: boolean;
  trust_mode: boolean;
  auto_approve: boolean;
  pending_approvals?: PendingApprovalRequest[];
  pending_user_inputs?: PendingUserInputRequest[];
}

export interface SkillEntry {
  name: string;
  description: string;
  /** Native `SKILL.md` locator. Plugin skills run from a content-bound
   *  in-memory snapshot and deliberately carry no mutable path here. */
  path: string | null;
  enabled: boolean;
  is_bundled: boolean;
  /** `native` or `reviewed-plugin-snapshot:<plugin>`. Absent on engines
   *  older than the runtime that added routing metadata. */
  source?: string;
  plugin_id?: string | null;
  plugin_generation?: number | null;
  plugin_content_hash?: string | null;
  /** `model+user` | `explicit-only` | `model-only` | `disabled`. Only the
   *  first two are user-invocable; `disabled` and `model-only` refuse
   *  explicit activation. */
  invocation?: string;
  /** Alternate lookup names for the same body (never separate entries). */
  aliases?: string[];
  /** `core` | `tools` for bundled skills, `null` for custom ones. */
  bundled_tier?: string | null;
}

/** `GET /v1/skills/{name}` — one skill's routing metadata plus its body, the
 *  input to a client-side activation. */
export interface SkillDetail extends SkillEntry {
  body: string;
}

export interface SkillsResponse {
  directory: string;
  directories: string[];
  warnings: string[];
  skills: SkillEntry[];
}

export interface SetSkillEnabledResponse {
  name: string;
  enabled: boolean;
}

export interface SkillMutationReceiptResponse {
  name: string;
  /** `installed` | `updated` | `no_change` | `removed` | `trusted` |
   *  `imported` | `already_present`. */
  outcome: string;
  scope: string;
  safe_target_path: string;
  trust_note?: string | null;
}

export interface SkillAuditDigest {
  state: string;
  value?: string | null;
}

export interface SkillAuditEntry {
  name: string;
  safe_display_path: string;
  source_kind: string;
  scope: string;
  digest: SkillAuditDigest;
  trust: string;
  integrity: string;
  available_actions: string[];
  warnings: string[];
}

export interface SkillAuditResponse {
  /** `true` when the same name exists in more than one owned root; re-request
   *  with an explicit scope to disambiguate. */
  ambiguous: boolean;
  skills: SkillAuditEntry[];
}

export interface SessionMetadata {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_tokens: number;
  model: string;
  /** Provider route this session was saved on. The runtime stores both and
   *  reads them back when the session is resumed into a thread, so they are
   *  also what a merely-*viewed* session will run on the moment its next
   *  message creates — or reopens — that thread. */
  model_provider?: string | null;
  model_provider_id?: string | null;
  workspace: string;
  mode?: string | null;
  cost?: {
    session_cost_usd: number;
    session_cost_cny: number;
    subagent_cost_usd: number;
    subagent_cost_cny: number;
    displayed_cost_high_water_usd?: number;
    displayed_cost_high_water_cny?: number;
  };
  parent_session_id?: string | null;
  forked_from_message_count?: number | null;
  cumulative_turn_secs?: number;
}

export interface SessionsResponse {
  sessions: SessionMetadata[];
}

export interface SessionDetailResponse {
  metadata: SessionMetadata;
  messages: Record<string, unknown>[];
  system_prompt?: string | null;
}

export interface ResumeSessionResponse {
  thread_id: string;
  session_id: string;
  message_count: number;
  summary: string;
}

export interface SaveThreadAsSessionRequest {
  thread_id: string;
  session_id?: string;
  title?: string;
}

export interface SaveThreadAsSessionResponse {
  session_id: string;
  thread_id: string;
  message_count: number;
  title: string;
}

export interface WorkspaceStatusResponse {
  workspace: string;
  git_repo: boolean;
  branch?: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead?: number | null;
  behind?: number | null;
  /** Whether the engine found this workspace trusted in the user's config.
   *  `undefined` on engines older than the route that reports it — the
   *  difference matters, because a missing field means "cannot tell", while
   *  `false` is a verdict a banner can act on. */
  workspace_trusted?: boolean;
}

/** `POST /v1/workspace/trust` — the engine's record of the user's decision. */
export interface WorkspaceTrustResponse {
  workspace: string;
  workspace_trusted: boolean;
  /** The user config document the engine wrote. The GUI never edits it. */
  config_path: string;
  message: string;
}

export interface RuntimeInfoResponse {
  bind_host: string;
  port: number;
  auth_required: boolean;
  version: string;
}

export interface RuntimeApiCapabilities {
  saveSession: boolean;
  threadUndo: boolean;
  threadPatchUndo: boolean;
  threadRetry: boolean;
  turnSteer: boolean;
  snapshotList: boolean;
  snapshotRestore: boolean;
  /** `GET /v1/threads/{id}/usage` exists (TUI ≥ the version that exports
   *  native CNY cost). When true the GUI reads provider-published CNY
   *  directly; when false it falls back to the `/v1/usage?group_by=thread`
   *  bucket, which carries USD only. */
  threadUsage: boolean;
  /** `GET /v1/threads/{id}/context` exists (TUI ≥ the version that exports
   *  the live context-window posture). When true the status bar shows how
   *  full the model's context window is, read before each send and again when
   *  a turn settles; when false the reading is omitted rather than
   *  reconstructed from turn receipts, which carry tokens but not the
   *  window. */
  threadContext: boolean;
  /** `POST /v1/threads/{id}/file-revert` exists (TUI ≥ the version that added
   *  file-scoped snapshot restore). When false the Changes panel keeps the
   *  Revert button disabled with an explanation instead of falling back to
   *  the whole-workspace snapshot restore, which would silently roll back
   *  unrelated files. */
  threadFileRevert: boolean;
  /** `POST /v1/threads/{id}/fork-at-turn` exists (TUI ≥ the version that let a
   *  client name the turn to fork at). When false the transcript offers no
   *  per-turn branch action at all — the older engines can only fork the last
   *  turn, and a UI that offered "branch from this turn" through that one
   *  would cut somewhere else while reporting success. */
  threadForkAtTurn: boolean;
  /** `GET /v1/threads/{id}/turns/{turn_id}/calls/{tool_call_id}/changes`
   *  exists (TUI ≥ the version that made a call's own workspace span
   *  readable). When false the Changes panel and the command cards still list
   *  the paths a call changed — those come from the turn's own snapshot
   *  receipts, which the thread detail already carries — but without the
   *  change kind, the line counts, or a patch. */
  callChanges: boolean;
  /** `POST /v1/skills/install`, `POST /v1/skills/{name}/update`,
   *  `DELETE /v1/skills/{name}`, `POST /v1/skills/{name}/trust` and
   *  `GET /v1/skills/{name}/audit` exist (advertised as
   *  `capabilities.skill_lifecycle` on `GET /v1/runtime/info`). When false the
   *  Skills panel keeps install/update/remove/trust and the audit detail
   *  disabled rather than promising an operation the engine will 404. */
  skillLifecycle: boolean;
  /** `GET /v1/skills/{name}` returns a skill's body plus routing metadata
   *  (`capabilities.skill_detail`). This is what lets the GUI activate a
   *  skill: the body is composed into the next turn's prompt exactly as
   *  TUI's `/skill <name>` does. When false the GUI can list and toggle
   *  skills but offers no activation. */
  skillDetail: boolean;
  /** The MCP management family (`/v1/apps/mcp/servers*`, `/v1/apps/mcp/tools`,
   *  `/v1/apps/mcp/imports`) exists, advertised as
   *  `capabilities.mcp_server_management` on `GET /v1/runtime/info`. When
   *  false the MCP panel says which engine can serve it and offers no
   *  mutations, rather than promising a route the engine will 404. */
  mcpServerManagement: boolean;
}

/** One path a single tool call changed, as the call-change route reports it. */
export interface CallChangeFile {
  /** Workspace-relative, `/`-separated, as git names it. */
  path: string;
  change: "created" | "updated" | "deleted";
  /** Lines added and removed; `null` for a binary file. */
  added: number | null;
  removed: number | null;
  /** Byte size and SHA-256 hex of the revision this span left, so a client can
   *  send `expected_hash` to `file-revert`. Both `null` when the path was
   *  deleted here, or is too large to read. */
  size: number | null;
  revision: string | null;
  /** The restore point `POST /v1/threads/{id}/file-revert` accepts for this
   *  path: the call's `tool:` receipt. */
  restore_snapshot_id: string | null;
  /** Patch between the span's two restore points; `null` when there is
   *  nothing to render (a binary path, a mode-only change, no patch). */
  diff: string | null;
  diff_truncated: boolean;
}

/**
 * What one tool call changed, from the workspace restore points the engine
 * recorded around it.
 *
 * A shell command's writes are recorded by the engine as the difference
 * between those two restore points, so they are attributable to the call —
 * but as a *time window*, not by cause: anything else that wrote the same
 * workspace meanwhile is in it too, and paths the snapshots exclude are
 * invisible. `state: "unavailable"` says the span will never resolve (the
 * call was never bounded, or its closing snapshot was lost), which is not the
 * same answer as an empty `files` list.
 */
export interface CallChangesResponse {
  thread_id: string;
  turn_id: string;
  tool_call_id: string;
  tool_name: string | null;
  state: "captured" | "unavailable";
  reason: string | null;
  files: CallChangeFile[];
  truncated: boolean;
}

/**
 * Result of `POST /v1/threads/{id}/file-revert`.
 *
 * `action` describes what the restore did to the working tree: `modified`
 * (content came back from the snapshot), `recreated` (the file had been
 * deleted), `removed` (the file had been created after the snapshot).
 */
export interface RevertThreadFileResponse {
  /** Workspace-relative path that was restored. */
  path: string;
  action: "modified" | "recreated" | "removed";
  snapshot_id: string;
  snapshot_label: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  /** Cache-creation (write) tokens, billed at the cache-write rate on
   *  providers that publish one (Anthropic). Part of the prompt input. */
  cache_write_tokens?: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** Provider-published CNY subtotal (never an FX projection of
   *  `cost_usd`). Optional: absent on runtimes that predate the field. */
  cost_cny?: number;
  turns: number;
}

export interface UsageBucket {
  key: string;
  cache_write_tokens?: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_cny?: number;
  turns: number;
}

export interface UsageAggregation {
  since?: string | null;
  until?: string | null;
  group_by: string;
  totals: UsageTotals;
  buckets: UsageBucket[];
}

/** Response of `GET /v1/threads/{id}/usage`: thread-scoped token + cost
 *  totals computed by the TUI runtime (same accumulation as `/v1/usage`).
 *  This is the authoritative source for the GUI's session-cost display —
 *  recorded-time provider pricing in both published currencies. */
export interface ThreadUsageResponse {
  thread_id: string;
  totals: UsageTotals;
}

/** How full the model's context window is, as the engine classifies it.
 *  Labels mirror the runtime's `PressureLevel` (`low` / `moderate` / `high` /
 *  `critical`); thresholds are the engine's, not the GUI's. */
export type ContextPressure = "low" | "moderate" | "high" | "critical";

/** Response of `GET /v1/threads/{id}/context`: the live context-window
 *  posture for one thread. `input_tokens` is the engine's conservative
 *  estimate of the next prompt; `billed_input_tokens` is the last
 *  provider-counted prompt, when one exists. Every numeric field is nullable
 *  because a route that cannot bound a window has no percentage to report,
 *  and `live: false` marks an answer resolved from the stored route alone
 *  (no engine loaded), where the token readings and the percentage are
 *  absent. */
export interface ThreadContextResponse {
  thread_id: string;
  model: string;
  provider: string | null;
  model_provider_id: string | null;
  live: boolean;
  window_tokens: number | null;
  window_source: string | null;
  input_tokens: number | null;
  billed_input_tokens: number | null;
  output_cap_tokens: number | null;
  input_budget_ceiling: number | null;
  available_input_tokens: number | null;
  compaction_trigger_tokens: number | null;
  usage_percent: number | null;
  pressure: ContextPressure | null;
}

export type AutomationStatus = "active" | "paused";
export type AutomationRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface AutomationRecord {
  schema_version: number;
  id: string;
  name: string;
  prompt: string;
  rrule: string;
  cwds: string[];
  status: AutomationStatus;
  created_at: string;
  updated_at: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
}

export interface AutomationRunRecord {
  schema_version: number;
  id: string;
  automation_id: string;
  scheduled_for: string;
  status: AutomationRunStatus;
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  task_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  error?: string | null;
}

export interface CreateAutomationRequest {
  name: string;
  prompt: string;
  rrule: string;
  cwds?: string[];
  status?: AutomationStatus;
}

export interface UpdateAutomationRequest {
  name?: string;
  prompt?: string;
  rrule?: string;
  cwds?: string[];
  status?: AutomationStatus;
}

export type EventListener = (event: RuntimeEvent) => void;

/** Interface for the engine object that ApiClient syncs with */
export interface EngineRef {
  ensureRunning(): Promise<void>;
  readonly baseUrl: string;
  readonly token: string | null;
}

// ── Agent Run types (matching TUI's AgentWorkerRecord) ──

export type AgentWorkerStatus =
  | "queued" | "starting" | "running" | "waiting_for_user"
  | "model_wait" | "running_tool" | "completed" | "failed"
  | "cancelled" | "interrupted";

export interface AgentWorkerSpec {
  worker_id: string;
  run_id: string;
  parent_run_id: string | null;
  session_name: string | null;
  objective: string;
  role: string | null;
  agent_type: string;
  model: string;
  workspace: string;
  git_branch: string | null;
  context_mode: string;
  fork_context: boolean;
  max_steps: number;
  spawn_depth: number;
  max_spawn_depth: number;
}

export interface AgentRunUsage {
  status: string;
  input_tokens: number;
  output_tokens: number;
  budget_spent_tokens: number;
  budget_remaining_tokens: number;
}

export interface AgentRunArtifactRef {
  kind: string;
  path: string;
}

export interface AgentWorkerEvent {
  timestamp_ms: number;
  kind: string;
  summary: string;
}

export interface AgentRunRecord {
  spec: AgentWorkerSpec;
  actor_kind: string;
  parent_run_id: string | null;
  follow_up: Record<string, unknown>;
  takeover: Record<string, unknown>;
  artifacts: AgentRunArtifactRef[];
  usage: AgentRunUsage;
  verification: Record<string, unknown>;
  recommended_action: Record<string, unknown>;
  status: AgentWorkerStatus;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  latest_message: string | null;
  result_summary: string | null;
  error: string | null;
  steps_taken: number;
  events: AgentWorkerEvent[];
}

export interface AgentRunsResponse {
  runs: AgentRunRecord[];
}

// ── Config ──

export interface GuiConfigResponse {
  model: string;
  provider: string;
  approval_mode: string;
  reasoning_effort: string;
  auto_compact: boolean;
  cost_currency: string;
  default_mode: string;
  default_model: string;
  base_url: string;
  allow_shell: boolean;
  mcp_config_path: string;
  subagents_enabled: boolean;
  subagents_max_depth: number;
  show_thinking: boolean;
  show_tool_details: boolean;
  locale: string;
  max_history: number;
  prefer_external_pdftotext: boolean;
  workspace_follow_symlinks: boolean;
  calm_mode: boolean;
  sandbox_mode: string;
  strict_tool_mode: boolean;
  memory_enabled: boolean;
  search_provider: string;
  prompt_suggestion: boolean;
}

export interface SetConfigRequest {
  key: string;
  value: string;
  persist?: boolean;
}

export interface SetConfigResponse {
  key: string;
  value: string;
  message: string;
  persisted: boolean;
  requires_reload: boolean;
}

export interface ReloadConfigResponse {
  message: string;
}

// ── Provider / Model catalog ──

export interface ProviderEntry {
  /** Stable id matching `ApiProvider::as_str()`. Use as the canonical value
   * when persisting `provider = "<id>"` or comparing. A user-defined
   * `[providers.<name>]` route reports the generic `custom` kind here and its
   * own name in `model_provider_id`, so two named routes are two entries that
   * differ only by that field. */
  id: string;
  /** Exact configured id of this route, when it has one — the model-provider
   * identity every other endpoint takes: `?model_provider_id=` on the model
   * catalog, `model_provider_id` in the switch body, and on a new thread.
   * Null for the legacy root-level custom route. */
  model_provider_id?: string | null;
  /** Human-friendly name for picker UIs (e.g. "DeepSeek", "OpenAI", or
   * "bigmodel-cn (custom)" for a named route). */
  display_name: string;
  /** Default model id for this provider, or empty string for pass-through
   * providers (Ollama / Custom). */
  default_model: string;
  /** When false, the provider exposes no built-in model list — render a
   * free-text input instead of calling `/v1/providers/{id}/models`. */
  has_model_catalog: boolean;
  /** Legacy fixture-only fields. The Runtime's catalog has never sent these:
   * it is a non-secret projection and publishes credential *state*, not an
   * endpoint or an environment variable name. Kept optional so a stale
   * fixture cannot make a reader believe it is part of the wire contract. */
  default_base_url?: string;
  env_vars?: string[];
  /** Sanitized credential classification for this exact route. */
  credentialState?: "configured" | "login_required" | "missing" | "no_auth" | "local" | "legacy";
  /** Which class owns the credential — never a value, path, or env var name. */
  credentialSource?: "secret_store" | "config" | "external_auth" | "none";
  /** Whether `PUT`/`DELETE /v1/providers/{id}/key` would act on this route. */
  credentialWritable?: boolean;
  /** Why a write is refused. Present only when `credentialWritable` is false. */
  credentialWritableReason?: string;
}

export interface ProvidersResponse {
  /** Currently active provider id (matches `GuiConfigResponse.provider`). */
  current: string;
  /** Exact configured id of the active route, when it has one. A named custom
   * route reports `current = "custom"` plus this field, so the picker marks the
   * route that is actually selected instead of the first entry sharing the
   * generic kind. */
  current_provider_id?: string | null;
  providers: ProviderEntry[];
}

export interface ProviderModelEntry {
  /** Canonical model id suitable for `default_text_model` or
   * `POST /v1/threads/{id}` `model` field. */
  id: string;
}

export interface ProviderModelsResponse {
  provider: string;
  models: ProviderModelEntry[];
}

// ── Provider switch ──

/** Request body for `POST /v1/providers/{id}/switch`.
 *  `model` is optional: when omitted, the TUI resolves the active model from
 *  `[providers.<id>].model` (or its built-in default) and does NOT persist a
 *  `model` key — mirroring the TUI's `/provider <id>` command (model: None).
 *  `model_provider_id` names one exact configured route when the path holds the
 *  generic kind (`custom`), which is how a user-defined `[providers.<name>]`
 *  route is addressed. */
export interface SwitchProviderRequest {
  model?: string;
  model_provider_id?: string;
}

/** Response for `POST /v1/providers/{id}/switch`. The GUI must display
 *  `model` (the backend-resolved active model) instead of the cached
 *  `ProviderEntry.default_model`, so the UI matches the runtime's actual
 *  state when the user has a per-provider `model` configured. */
export interface SwitchProviderResponse {
  provider: string;
  model: string;
  message: string;
  persisted: boolean;
}

// ── Fleet (managed multi-agent runs) ──

/** Aggregate counters returned by `GET /v1/fleet/runs` and each run detail.
 *  `workers` maps worker id → status label for the whole fleet. */
export interface FleetStatusCounters {
  runs: number;
  queued: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  restarted: number;
  escalated: number;
  transport_failed: number;
  task_failed: number;
  verifier_failed: number;
  cancelled: number;
  stale: number;
  workers: Record<string, string>;
}

/** Per-task progress row inside a run summary. */
export interface FleetRunTaskStatus {
  task_id: string;
  status: string;
  leased_to: string | null;
  attempts: number;
}

/** Durable workflow identity carried on a run. */
export interface FleetWorkflowDescriptor {
  id: string;
  kind: string;
}

/** Task authoring spec (detail-only). Worker profile is narrowed to the
 *  fields the GUI surfaces; the full spec is opaque otherwise. */
export interface FleetTaskSpec {
  id: string;
  name: string;
  description?: string | null;
  objective?: string | null;
  instructions: string;
  worker?: { role?: string | null; agent_profile?: string | null; model?: string | null } | null;
  [key: string]: unknown;
}

export interface FleetRunSummary {
  id: string;
  name: string;
  lifecycle_status: string;
  status: FleetStatusCounters;
  target: string;
  workflow: FleetWorkflowDescriptor | null;
  roles: string[];
  task_count: number;
  worker_count: number;
  tasks: FleetRunTaskStatus[];
  labels: Record<string, string>;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  /** Present only on the detail endpoint (`GET /v1/fleet/runs/{id}`). */
  task_specs?: FleetTaskSpec[];
  worker_specs?: Array<Record<string, unknown>>;
}

export interface FleetWorkerRuntime {
  agent_status: string | null;
  steps_taken: number;
  latest_message: string | null;
  error: string | null;
  result_summary: string | null;
  has_session: boolean;
}

export interface FleetArtifactRef {
  kind: string;
  path: string;
  checksum: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface FleetWorker {
  worker_id: string;
  status: string;
  run_id: string | null;
  task_id: string | null;
  objective: string | null;
  role: string | null;
  host: string | null;
  latest_heartbeat_at: string | null;
  latest_event: Record<string, unknown> | null;
  artifacts: FleetArtifactRef[];
  last_error: string | null;
  alert_state: string | null;
  runtime_state: FleetWorkerRuntime | null;
}

export interface FleetReceipt {
  run_id: string;
  task_id: string;
  worker_id: string;
  attempt: number;
  terminal_seq: number | null;
  completed_at: string | null;
  result: string;
  failure_kind: string | null;
  failure_class: string | null;
  retry_eligible: boolean;
  score: { value: number; max: number; notes: string | null } | null;
  artifacts: FleetArtifactRef[];
  session_id: string | null;
  evidence_available: boolean;
}

export interface FleetRunsResponse {
  status: FleetStatusCounters;
  runs: FleetRunSummary[];
}

export interface FleetWorkersResponse {
  run_id: string;
  workers: FleetWorker[];
}

export interface FleetReceiptsResponse {
  run_id: string;
  receipts: FleetReceipt[];
}

/** One privacy-bounded durable event streamed from `GET /v1/fleet/runs/{id}/events`. */
export interface FleetRuntimeEvent {
  cursor: string;
  event: string;
  run_id: string;
  worker_id?: string | null;
  task_id?: string | null;
  timestamp?: string | null;
  worker_seq?: number | null;
  payload: Record<string, unknown>;
}

// ── Fleet run creation (managed, this_computer only) ──

/** One roster member from `GET /v1/fleet/profiles`. `origin` is the roster
 *  layer the profile was merged from (built-in / plugin / config / personal
 *  / workspace). */
export interface FleetProfile {
  id: string;
  display_name?: string | null;
  description?: string | null;
  origin?: string | null;
}

export interface FleetProfilesResponse {
  profiles: FleetProfile[];
  load_error?: string | null;
}

export interface FleetCreateRoleInput {
  name: string;
  agent_profile?: string | null;
}

export interface FleetCreateTaskInput {
  id: string;
  name: string;
  objective?: string | null;
  instructions: string;
  /** Must reference a declared role name. */
  role: string;
}

export interface CreateFleetRunRequest {
  name?: string;
  workflow_id: string;
  max_workers?: number;
  roles: FleetCreateRoleInput[];
  tasks: FleetCreateTaskInput[];
}

export interface CreateFleetRunResponse {
  execution: string;
  run: FleetRunSummary;
  warnings: string[];
}

// ── Thread Goal (control plane) ──

export type ThreadGoalStatus =
  | "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

export interface ThreadGoal {
  thread_id: string;
  goal_id: string;
  objective: string;
  status: ThreadGoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  continuation_count: number;
  created_at: number;
  updated_at: number;
}

// ── MCP server management (`/v1/apps/mcp/*`) ──
//
// The engine owns the MCP config (global `mcp.json` + a trusted project's
// `.mcp.json` + reviewed plugin entries) and redacts credentials before they
// reach a client: env/header values never come back, only the key names.

/** One row of `GET /v1/apps/mcp/servers`.
 *
 *  `origin` says which config layer owns the entry — `global`, `project`,
 *  `plugin`, or `unknown` — and only a `global` entry is writable through the
 *  API (`writable`); a shadowed project or plugin entry has to be changed at
 *  its own source. `connected` is live pool state, which is absent until a
 *  pool has been built (no server has been talked to yet). */
export interface McpServerSummary {
  name: string;
  origin: string;
  writable: boolean;
  auth_required: boolean;
  enabled: boolean;
  required: boolean;
  command: string | null;
  url: string | null;
  connected: boolean;
  enabled_tools: string[];
  disabled_tools: string[];
}

/** `GET /v1/apps/mcp/servers` — the list plus the revision every mutation
 *  must present in `If-Match` (the engine is the single writer, so a stale
 *  revision is refused with `412` rather than silently clobbering). */
export interface McpServersResponse {
  revision: string;
  servers: McpServerSummary[];
}

/** One server's live connection state, as the tool/reconnect routes report
 *  it. `error` carries the engine's own sentence for a failed connect. */
export interface McpConnectionOutcome {
  server: string;
  connected: boolean;
  auth_required: boolean;
  error?: string;
}

/** One tool the engine exposes from a connected MCP server. */
export interface McpToolEntry {
  server: string;
  name: string;
  prefixed_name: string;
  description?: string | null;
  input_schema: unknown;
}

/** `GET /v1/apps/mcp/tools` — the tools currently visible to the model, plus
 *  a connection outcome per server. With `connect` the engine actually tries
 *  to reach each server first, so the outcomes say whether that worked. */
export interface McpToolsResponse {
  tools: McpToolEntry[];
  connections: McpConnectionOutcome[];
}

/** The receipt `enable` / `disable` / `delete` / `reconnect` answer with. */
export interface McpServerActionReceipt {
  revision?: string;
  name: string;
  action: string;
  ok: boolean;
  connection?: McpConnectionOutcome;
}

/** One server's redacted config (`GET /v1/apps/mcp/servers/{name}`). Secret
 *  values are never included: env and header values appear as key names only,
 *  and `has_bearer_token_env_var` says whether a token source is configured
 *  without naming it. */
export interface McpServerDetail extends McpServerSummary {
  credential_configured: boolean;
  args: string[];
  env_keys: string[];
  transport: string | null;
  connect_timeout: number | null;
  execute_timeout: number | null;
  read_timeout: number | null;
  env_header_keys: string[];
  has_bearer_token_env_var: boolean;
  scopes: string[];
  oauth_resource: string | null;
}

/** Body of `POST /v1/apps/mcp/servers`. Exactly one of `command` (stdio) or
 *  `url` (http/sse) is required; the engine rejects a request that carries
 *  neither. */
export interface McpCreateServerRequest {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  /** Explicit transport override (`"sse"`). This is the only value the
   *  engine accepts: `stdio` and the default streamable HTTP are inferred from
   *  whether `command` or `url` is set, and sending either would be a 400 for
   *  repeating what the body already says. */
  transport?: string;
  enabled?: boolean;
  required?: boolean;
  env?: Record<string, string>;
  enabled_tools?: string[];
  disabled_tools?: string[];
}

/** One externally discovered server the engine could import, before consent.
 *
 *  `content_hash` covers exactly the name+entry parsed from the source, so an
 *  approval stays valid across unrelated rewrites of the same file — and the
 *  apply call has to echo it back, which is what makes the review binding. */
export interface McpImportCandidate {
  id: string;
  name: string;
  /** `claude_json` / `project_mcp_json` / `marketplace`. */
  source_kind: string;
  source_path: string;
  content_hash: string;
  transport: string;
  destination: string;
  argument_count: number;
  env_keys: string[];
  header_keys: string[];
  credential_configured: boolean;
  /** Present in the source but must never connect (e.g. `enabled: false`). */
  hard_blocked: boolean;
  /** The name already exists in the effective config. */
  conflict: boolean;
  review_token: string;
}

/** A source the engine could not read safely, with its own explanation. */
export interface McpImportProblem {
  source_kind: string;
  message: string;
}

/** `GET /v1/apps/mcp/imports` — reviewed candidates from external editors.
 *  Reading never connects or spawns anything. */
export interface McpImportPreview {
  revision: string;
  candidates: McpImportCandidate[];
  problems: McpImportProblem[];
}

/** The receipt `POST /v1/apps/mcp/imports` answers with. */
export interface McpImportReceipt {
  name: string;
  decision: string;
  imported: boolean;
  enabled: boolean;
  revision: string;
  consent_recorded: boolean;
  warning?: string | null;
}

// ── Re-exports from other modules ──

export { CodeWhaleEngine } from "./api/engine";
export { CodeWhaleApiClient } from "./api/api-client";
