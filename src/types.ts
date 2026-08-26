// ── Types matching DeepSeek Runtime API ──
// Extracted from api-client.ts for clean module boundaries.
// api-client.ts re-exports these for backward compatibility.

export interface ThreadRecord {
  schema_version: number;
  id: string;
  created_at: string;
  updated_at: string;
  model: string;
  workspace: string;
  mode: string;
  allow_shell: boolean;
  trust_mode: boolean;
  auto_approve: boolean;
  latest_turn_id: string | null;
  latest_response_bookmark?: string | null;
  archived: boolean;
  system_prompt?: string | null;
  task_id?: string | null;
  title?: string | null;
  coherence_state: string;
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
  path: string;
  enabled: boolean;
  is_bundled: boolean;
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

export interface SessionMetadata {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_tokens: number;
  model: string;
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
   * when persisting `provider = "<id>"` or comparing. */
  id: string;
  /** Human-friendly name for picker UIs (e.g. "DeepSeek", "OpenAI"). */
  display_name: string;
  /** Default base URL. Informational; the live value may be overridden in
   * config.toml. */
  default_base_url: string;
  /** Default model id for this provider, or empty string for pass-through
   * providers (Ollama / Custom). */
  default_model: string;
  /** When false, the provider exposes no built-in model list — render a
   * free-text input instead of calling `/v1/providers/{id}/models`. */
  has_model_catalog: boolean;
  /** API key environment variable candidates. */
  env_vars: string[];
}

export interface ProvidersResponse {
  /** Currently active provider id (matches `GuiConfigResponse.provider`). */
  current: string;
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
 *  `model` key — mirroring the TUI's `/provider <id>` command (model: None). */
export interface SwitchProviderRequest {
  model?: string;
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

// ── Re-exports from other modules ──

export { CodeWhaleEngine } from "./api/engine";
export { CodeWhaleApiClient } from "./api/api-client";
