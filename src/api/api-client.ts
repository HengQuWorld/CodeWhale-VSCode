import * as http from "http";
import type {
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
  TurnItemRecord,
  RuntimeEvent,
  StartTurnResponse,
  UndoTurnResponse,
  PatchUndoResult,
  PatchUndoResponse,
  RetryTurnResponse,
  SnapshotEntry,
  ThreadDetailResponse,
  ApprovalRequest,
  PendingApprovalRequest,
  PendingUserInputRequest,
  TaskSummary,
  TaskCounts,
  TaskToolCallSummary,
  TaskTimelineEntry,
  TaskRecord,
  SkillEntry,
  SkillsResponse,
  SetSkillEnabledResponse,
  SessionMetadata,
  SessionsResponse,
  SessionDetailResponse,
  ResumeSessionResponse,
  SaveThreadAsSessionRequest,
  SaveThreadAsSessionResponse,
  WorkspaceStatusResponse,
  RuntimeInfoResponse,
  RuntimeApiCapabilities,
  UsageTotals,
  UsageBucket,
  UsageAggregation,
  AutomationStatus,
  AutomationRunStatus,
  AutomationRecord,
  AutomationRunRecord,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  AgentRunRecord,
  AgentRunsResponse,
  GuiConfigResponse,
  SetConfigRequest,
  SetConfigResponse,
  ReloadConfigResponse,
  ProvidersResponse,
  ProviderModelsResponse,
  SwitchProviderResponse,
  EventListener,
  EngineRef,
} from "../types";

// Re-export types for backward compatibility
export type {
  ThreadRecord,
  ThreadSummary,
  TurnRecord,
  TurnItemRecord,
  RuntimeEvent,
  StartTurnResponse,
  UndoTurnResponse,
  PatchUndoResult,
  PatchUndoResponse,
  RetryTurnResponse,
  SnapshotEntry,
  ThreadDetailResponse,
  ApprovalRequest,
  PendingApprovalRequest,
  PendingUserInputRequest,
  TaskSummary,
  TaskCounts,
  TaskToolCallSummary,
  TaskTimelineEntry,
  TaskRecord,
  SkillEntry,
  SkillsResponse,
  SetSkillEnabledResponse,
  SessionMetadata,
  SessionsResponse,
  SessionDetailResponse,
  ResumeSessionResponse,
  SaveThreadAsSessionRequest,
  SaveThreadAsSessionResponse,
  WorkspaceStatusResponse,
  RuntimeInfoResponse,
  RuntimeApiCapabilities,
  UsageTotals,
  UsageBucket,
  UsageAggregation,
  AutomationStatus,
  AutomationRunStatus,
  AutomationRecord,
  AutomationRunRecord,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  AgentRunRecord,
  AgentRunsResponse,
  EventListener,
  EngineRef,
  ProvidersResponse,
  ProviderModelsResponse,
  SwitchProviderResponse,
};

const NOT_SYNCED: unique symbol = Symbol("NOT_SYNCED");

export class CodeWhaleApiClient {
  private authToken: string | null;
  private engine: EngineRef | null = null;
  private _lastSyncedBaseUrl: string | typeof NOT_SYNCED = NOT_SYNCED;
  private _lastSyncedToken: string | null | typeof NOT_SYNCED = NOT_SYNCED;

  constructor(private baseUrl: string, token?: string) {
    this.authToken = token ?? null;
  }

  /** Bind this API client to an engine for automatic sync */
  bindEngine(engine: EngineRef): void {
    this.engine = engine;
  }

  setToken(token: string | null): void {
    this.authToken = token;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * Ensures the engine is running and synchronizes baseUrl/token
   * from the engine to this client. Replaces the repeated 3-line pattern:
   *   await engine.ensureRunning();
   *   api.setBaseUrl(engine.baseUrl);
   *   api.setToken(engine.token);
   */
  async ensureReady(): Promise<void> {
    if (this.engine) {
      await this.engine.ensureRunning();
    }
    this.syncFromEngine();
  }

  /**
   * Syncs baseUrl and token from the bound engine without calling
   * ensureRunning(). Useful when the engine is already known to be running.
   */
  syncFromEngine(): void {
    if (!this.engine) return;
    const currentUrl = this.engine.baseUrl;
    const currentToken = this.engine.token;

    if (this._lastSyncedBaseUrl !== currentUrl) {
      this.setBaseUrl(currentUrl);
      this._lastSyncedBaseUrl = currentUrl;
    }
    if (this._lastSyncedToken !== currentToken) {
      this.setToken(currentToken);
      this._lastSyncedToken = currentToken;
    }
  }

  // ── Threads ──

  async createThread(opts?: {
    model?: string;
    mode?: string;
    workspace?: string;
    allow_shell?: boolean;
    trust_mode?: boolean;
    auto_approve?: boolean;
    system_prompt?: string;
    title?: string;
  }): Promise<ThreadRecord> {
    const body: Record<string, unknown> = {};
    if (opts?.model) body.model = opts.model;
    if (opts?.mode) body.mode = opts.mode;
    if (opts?.workspace) body.workspace = opts.workspace;
    if (opts?.allow_shell !== undefined) body.allow_shell = opts.allow_shell;
    if (opts?.trust_mode !== undefined) body.trust_mode = opts.trust_mode;
    if (opts?.auto_approve !== undefined) body.auto_approve = opts.auto_approve;
    if (opts?.system_prompt) body.system_prompt = opts.system_prompt;
    if (opts?.title) body.title = opts.title;
    return (await this.post("/v1/threads", body)) as ThreadRecord;
  }

  async listThreads(opts?: {
    limit?: number;
    include_archived?: boolean;
  }): Promise<ThreadRecord[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.include_archived) params.set("include_archived", "true");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/threads${qs}`)) as ThreadRecord[];
  }

  async listThreadsSummary(opts?: {
    limit?: number;
    search?: string;
  }): Promise<ThreadSummary[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.search) params.set("search", opts.search);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/threads/summary${qs}`)) as ThreadSummary[];
  }

  async getThread(threadId: string): Promise<ThreadRecord> {
    const resp = (await this.get(`/v1/threads/${threadId}`)) as any;
    // The server returns ThreadDetail { thread, turns, items, latest_seq }
    // so we must extract the inner ThreadRecord.
    if (resp && typeof resp === 'object' && resp.thread) {
      return resp.thread as ThreadRecord;
    }
    return resp as ThreadRecord;
  }

  async updateThread(threadId: string, updates: {
    archived?: boolean;
    allow_shell?: boolean;
    trust_mode?: boolean;
    auto_approve?: boolean;
    mode?: string;
    model?: string;
    title?: string;
    workspace?: string;
  }): Promise<ThreadRecord> {
    return (await this.patch(`/v1/threads/${threadId}`, updates)) as ThreadRecord;
  }

  // ── Turns ──

  async startTurn(
    threadId: string,
    prompt: string,
    opts?: { model?: string; mode?: string; reasoning_effort?: string; auto_approve?: boolean; trust_mode?: boolean }
  ): Promise<StartTurnResponse> {
    const body: Record<string, unknown> = { prompt };
    if (opts?.model) body.model = opts.model;
    if (opts?.mode) body.mode = opts.mode;
    if (opts?.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;
    if (opts?.auto_approve !== undefined) body.auto_approve = opts.auto_approve;
    if (opts?.trust_mode !== undefined) body.trust_mode = opts.trust_mode;
    return (await this.post(
      `/v1/threads/${threadId}/turns`,
      body
    )) as StartTurnResponse;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.post(`/v1/threads/${threadId}/turns/${turnId}/interrupt`, {});
  }

  /** Steer a running turn (mid-turn user guidance). Mirrors TUI's steering
   *  input: the prompt is appended as a user message on the active turn and
   *  delivered to the engine mid-stream. */
  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<TurnRecord> {
    return (await this.post(
      `/v1/threads/${threadId}/turns/${turnId}/steer`,
      { prompt }
    )) as TurnRecord;
  }

  async compactThread(threadId: string, reason?: string): Promise<void> {
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    await this.post(`/v1/threads/${threadId}/compact`, body);
  }

  // ── Undo / Retry ──

  async undoThreadTurn(
    threadId: string,
    opts?: { depth?: number }
  ): Promise<UndoTurnResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.depth !== undefined) body.depth = opts.depth;
    return (await this.post(
      `/v1/threads/${threadId}/undo`,
      body
    )) as UndoTurnResponse;
  }

  /** Full undo that mirrors TUI's `/undo`: tries snapshot-based file
   *  rollback first, then removes the last conversation turn. */
  async patchUndoThreadTurn(
    threadId: string,
    opts?: { depth?: number }
  ): Promise<PatchUndoResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.depth !== undefined) body.depth = opts.depth;
    return (await this.post(
      `/v1/threads/${threadId}/patch-undo`,
      body
    )) as PatchUndoResponse;
  }

  async retryThreadTurn(
    threadId: string,
    opts?: { depth?: number; prompt?: string }
  ): Promise<RetryTurnResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.depth !== undefined) body.depth = opts.depth;
    if (opts?.prompt) body.prompt = opts.prompt;
    return (await this.post(
      `/v1/threads/${threadId}/retry`,
      body
    )) as RetryTurnResponse;
  }

  // ── Snapshots ──

  async listSnapshots(opts?: { limit?: number }): Promise<SnapshotEntry[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const path = `/v1/snapshots${qs ? "?" + qs : ""}`;
    return (await this.get(path)) as SnapshotEntry[];
  }

  async restoreSnapshot(snapshotId: string): Promise<{ restored: string }> {
    return (await this.post(
      `/v1/snapshots/${snapshotId}/restore`,
      {}
    )) as { restored: string };
  }

  // ── Approvals ──

  async decideApproval(
    approvalId: string,
    decision: "allow" | "deny",
    remember = false
  ): Promise<void> {
    await this.post(`/v1/approvals/${approvalId}`, { decision, remember });
  }

  // ── User Input ──

  async submitUserInput(
    threadId: string,
    inputId: string,
    answers: Array<{ id: string; label: string; value: string }>
  ): Promise<void> {
    await this.post(`/v1/user-input/${threadId}/${inputId}`, { answers });
  }

  // ── Detail ──

  async getThreadDetail(threadId: string): Promise<ThreadDetailResponse> {
    return (await this.get(
      `/v1/threads/${threadId}`
    )) as ThreadDetailResponse;
  }

  // ── Health ──

  async health(): Promise<{ status: string; service: string; mode: string }> {
    return (await this.get("/health")) as { status: string; service: string; mode: string };
  }

  // ── Tasks ──

  async listTasks(opts?: { limit?: number; workspace?: string }): Promise<{ tasks: TaskSummary[]; counts: TaskCounts }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.workspace) params.set("workspace", opts.workspace);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/tasks${qs}`)) as { tasks: TaskSummary[]; counts: TaskCounts };
  }

  async createTask(opts: {
    prompt: string;
    model?: string;
    mode?: string;
    workspace?: string;
    auto_approve?: boolean;
  }): Promise<TaskRecord> {
    return (await this.post("/v1/tasks", opts)) as TaskRecord;
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    return (await this.get(`/v1/tasks/${taskId}`)) as TaskRecord;
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.post(`/v1/tasks/${taskId}/cancel`, {});
  }

  // ── Skills ──

  async listSkills(): Promise<SkillsResponse> {
    return (await this.get("/v1/skills")) as SkillsResponse;
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<SetSkillEnabledResponse> {
    return (await this.post(`/v1/skills/${name}`, { enabled })) as SetSkillEnabledResponse;
  }

  // ── Sessions ──

  async listSessions(opts?: { limit?: number; search?: string }): Promise<SessionsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.search) params.set("search", opts.search);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/sessions${qs}`)) as SessionsResponse;
  }

  async getSession(sessionId: string): Promise<SessionDetailResponse> {
    return (await this.get(`/v1/sessions/${sessionId}`)) as SessionDetailResponse;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.delete(`/v1/sessions/${sessionId}`);
  }

  async resumeSessionThread(sessionId: string, opts?: { model?: string; mode?: string }): Promise<ResumeSessionResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.model) body.model = opts.model;
    if (opts?.mode) body.mode = opts.mode;
    return (await this.post(`/v1/sessions/${sessionId}/resume-thread`, body)) as ResumeSessionResponse;
  }

  async saveThreadAsSession(threadId: string, sessionId?: string): Promise<SaveThreadAsSessionResponse> {
    const result = (await this.post(
      `/v1/sessions`,
      { thread_id: threadId }
    )) as SaveThreadAsSessionResponse;
    const normalizedSessionId = sessionId?.trim();
    if (normalizedSessionId && normalizedSessionId !== result.session_id) {
      try {
        await this.delete(`/v1/sessions/${normalizedSessionId}`);
      } catch {
        // Best-effort cleanup when the runtime lacks in-place session update.
      }
    }
    return result;
  }

  /**
   * PUT /v1/sessions — save (or update) a session from the engine's live state.
   * If `sessionId` is provided, updates the existing session in-place (same
   * thread → same session). Otherwise creates a new session.
   * This mirrors TUI's `build_session_snapshot` auto-save behavior.
   *
   * Falls back to POST /v1/sessions on TUI < v0.8.61 (which lacks PUT).
   * POST always creates a new session, so same-thread dedup won't work,
   * but at least the save itself succeeds.
   */
  async saveCurrentSession(threadId: string, sessionId?: string): Promise<SaveThreadAsSessionResponse> {
    const body: Record<string, unknown> = { thread_id: threadId };
    if (sessionId) body.session_id = sessionId;
    try {
      return (await this.put(`/v1/sessions`, body)) as SaveThreadAsSessionResponse;
    } catch (err) {
      // PUT /v1/sessions was added in v0.8.61.  On older TUI the endpoint
      // returns 405 Method Not Allowed.  Fall back to POST which always
      // creates a new session (no in-place update, but at least the save
      // succeeds). The caller is responsible for logging the outcome.
      if (err instanceof Error && err.message.includes("405")) {
        return (await this.post(`/v1/sessions`, { thread_id: threadId })) as SaveThreadAsSessionResponse;
      }
      throw err;
    }
  }

  // ── Workspace ──

  async getWorkspaceStatus(): Promise<WorkspaceStatusResponse> {
    return (await this.get("/v1/workspace/status")) as WorkspaceStatusResponse;
  }

  // ── Runtime ──

  async getRuntimeInfo(): Promise<RuntimeInfoResponse> {
    return (await this.get("/v1/runtime/info")) as RuntimeInfoResponse;
  }

  async probeRuntimeCapabilities(): Promise<RuntimeApiCapabilities> {
    const [
      saveSession,
      threadUndo,
      threadPatchUndo,
      threadRetry,
      turnSteer,
      snapshotList,
      snapshotRestore,
    ] = await Promise.all([
      this.probePath("/v1/sessions"),
      this.probePath("/v1/threads/__probe__/undo"),
      this.probePath("/v1/threads/__probe__/patch-undo"),
      this.probePath("/v1/threads/__probe__/retry"),
      this.probePath("/v1/threads/__probe__/turns/__probe__/steer"),
      this.probePath("/v1/snapshots"),
      this.probePath("/v1/snapshots/__probe__/restore"),
    ]);

    return {
      saveSession,
      threadUndo,
      threadPatchUndo,
      threadRetry,
      turnSteer,
      snapshotList,
      snapshotRestore,
    };
  }

  // ── Usage ──

  async getUsage(opts?: { since?: string; until?: string; group_by?: string }): Promise<UsageAggregation> {
    const params = new URLSearchParams();
    if (opts?.since) params.set("since", opts.since);
    if (opts?.until) params.set("until", opts.until);
    if (opts?.group_by) params.set("group_by", opts.group_by);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/usage${qs}`)) as UsageAggregation;
  }

  // ── Automations ──

  async listAutomations(): Promise<AutomationRecord[]> {
    return (await this.get("/v1/automations")) as AutomationRecord[];
  }

  async getAutomation(automationId: string): Promise<AutomationRecord> {
    return (await this.get(`/v1/automations/${automationId}`)) as AutomationRecord;
  }

  async createAutomation(req: CreateAutomationRequest): Promise<AutomationRecord> {
    return (await this.post("/v1/automations", req)) as AutomationRecord;
  }

  async updateAutomation(automationId: string, req: UpdateAutomationRequest): Promise<AutomationRecord> {
    return (await this.patch(`/v1/automations/${automationId}`, req)) as AutomationRecord;
  }

  async deleteAutomation(automationId: string): Promise<void> {
    await this.delete(`/v1/automations/${automationId}`);
  }

  async runAutomation(automationId: string): Promise<AutomationRecord> {
    return (await this.post(`/v1/automations/${automationId}/run`, {})) as AutomationRecord;
  }

  async pauseAutomation(automationId: string): Promise<AutomationRecord> {
    return (await this.post(`/v1/automations/${automationId}/pause`, {})) as AutomationRecord;
  }

  async resumeAutomation(automationId: string): Promise<AutomationRecord> {
    return (await this.post(`/v1/automations/${automationId}/resume`, {})) as AutomationRecord;
  }

  async listAutomationRuns(automationId: string, opts?: { limit?: number }): Promise<AutomationRunRecord[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return (await this.get(`/v1/automations/${automationId}/runs${qs}`)) as AutomationRunRecord[];
  }

  // ── Agent Runs ──

  async listAgentRuns(): Promise<AgentRunsResponse> {
    return (await this.get("/v1/agent-runs")) as AgentRunsResponse;
  }

  async getAgentRun(runId: string): Promise<AgentRunRecord> {
    return (await this.get(`/v1/agent-runs/${runId}`)) as AgentRunRecord;
  }

  // ── Config ──

  async getConfig(): Promise<GuiConfigResponse> {
    return (await this.get("/v1/config")) as GuiConfigResponse;
  }

  async setConfig(req: SetConfigRequest): Promise<SetConfigResponse> {
    return (await this.post("/v1/config", req)) as SetConfigResponse;
  }

  async reloadConfig(): Promise<ReloadConfigResponse> {
    return (await this.post("/v1/config/reload", {})) as ReloadConfigResponse;
  }

  // ── Provider / Model catalog ──

  /**
   * List all supported providers and the currently active one.
   *
   * Backed by `GET /v1/providers`. The GUI should call this on startup and
   * whenever the provider picker needs to be rendered, then cache the result
   * for the session.
   */
  async listProviders(): Promise<ProvidersResponse> {
    return (await this.get("/v1/providers")) as ProvidersResponse;
  }

  /**
   * List the built-in model catalog for a provider.
   *
   * Backed by `GET /v1/providers/{id}/models`. Returns an empty list for
   * pass-through providers (Ollama, Custom) — callers should fall back to a
   * free-text input when `ProviderEntry.has_model_catalog` is false.
   */
  async listProviderModels(providerId: string): Promise<ProviderModelsResponse> {
    return (await this.get(`/v1/providers/${encodeURIComponent(providerId)}/models`)) as ProviderModelsResponse;
  }

  /**
   * Switch the active provider, optionally overriding the model.
   *
   * Backed by `POST /v1/providers/{id}/switch` — the GUI-facing counterpart
   * of the TUI's `/provider` slash command. The backend persists `provider`
   * always, and persists `model` only when `model` is provided, mirroring
   * `tui/ui.rs::switch_provider`. The resolved active model is returned in
   * the response and must be used for display (NOT the cached
   * `ProviderEntry.default_model`).
   *
   * Callers SHOULD NOT chain `setConfig({key:"provider"})` + `reloadConfig()`
   * around this — that flow historically clobbered the user's per-provider
   * `model` config with the catalog default.
   */
  async switchProvider(providerId: string, model?: string): Promise<SwitchProviderResponse> {
    const body: Record<string, unknown> = {};
    const trimmedModel = model?.trim();
    if (trimmedModel) body.model = trimmedModel;
    return (await this.post(
      `/v1/providers/${encodeURIComponent(providerId)}/switch`,
      body
    )) as SwitchProviderResponse;
  }

  // ── SSE Event Stream ──

  streamEvents(
    threadId: string,
    sinceSeq: number | null,
    onEvent: EventListener,
    onError?: (err: Error) => void
  ): AbortController {
    const controller = new AbortController();
    const params = new URLSearchParams();
    // always send since_seq param (0 for initial)
    params.set("since_seq", String(sinceSeq ?? 0));
    const qs = params.toString();
    const path = `/v1/threads/${threadId}/events?${qs}`;
    const url = new URL(path, this.baseUrl);

    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const req = http.get(
      url,
      { headers, signal: controller.signal },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => onError?.(new Error(`SSE error ${res.statusCode}: ${body}`)));
          return;
        }

        let buffer = "";
        let currentEvent: string | null = null;
        let currentData: string | null = null;

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              currentData = line.slice(5).trim();
            } else if (line === "" && currentEvent && currentData) {
              try {
                const parsed = JSON.parse(currentData) as RuntimeEvent;
                onEvent(parsed);
              } catch {
                // skip malformed events
              }
              currentEvent = null;
              currentData = null;
            }
            // ignore comment lines (starting with ':') and empty lines without event+data
          }
        });

        res.on("error", (err: Error) => {
          if (!controller.signal.aborted) onError?.(err);
        });
      }
    );

    req.on("error", (err: Error) => {
      if (!controller.signal.aborted) onError?.(err);
    });
    return controller;
  }

  // ── HTTP helpers ──

  private async get(path: string): Promise<unknown> {
    return this.request("GET", path, undefined);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    return this.request("PATCH", path, body);
  }

  private async delete(path: string): Promise<unknown> {
    return this.request("DELETE", path, undefined);
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    return this.request("PUT", path, body);
  }

  private async probePath(path: string): Promise<boolean> {
    try {
      // Use GET instead of HEAD since TUI doesn't explicitly support HEAD.
      // For 404, return false; for other errors (401, 500), still return true
      // since the endpoint exists (just requires auth or has internal error).
      const { statusCode } = await this.requestRaw("GET", path, undefined);
      return statusCode !== 404;
    } catch {
      return false;
    }
  }

  private request(
    method: string,
    path: string,
    body: unknown
  ): Promise<unknown> {
    return this.requestRaw(method, path, body).then(({ statusCode, data }) => {
      if (statusCode >= 400) {
        throw new Error(`API error ${statusCode}: ${data.slice(0, 500)}`);
      }
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    });
  }

  private requestRaw(
    method: string,
    path: string,
    body: unknown
  ): Promise<{ statusCode: number; data: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const payload = body ? JSON.stringify(body) : undefined;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.authToken) {
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }
      if (payload) {
        headers["Content-Length"] = String(Buffer.byteLength(payload));
      }

      const req = http.request(
        url,
        { method, headers },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              data,
            });
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error("Request timed out (30s)"));
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
