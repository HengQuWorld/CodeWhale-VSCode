/**
 * Fleet: managed multi-agent runs, as the sidebar shows them.
 *
 * Extracted from `chat-provider.ts`, which keeps `refreshFleetRuns` as its
 * entry point — the webview's messages and the sidebar's initial paint route
 * through it.
 *
 * A run is owned by the engine and watched from here: `GET /v1/fleet/runs` is
 * the list, the detail payload is a read of its own, and while a run is open
 * the client holds a stream for it with a polling fallback for an engine whose
 * stream ends early. Opening a run, closing it, and switching to another are
 * all the same "one run is being watched" state, which lives here.
 */

import * as vscode from "vscode";
import type { CodeWhaleApiClient, CreateFleetRunRequest } from "../types";

/** What the controller needs from the provider it serves. */
export interface FleetHost {
  readonly api: CodeWhaleApiClient;
  postMessage(msg: Record<string, unknown>): void;
}

export class FleetController {
  /** The run whose detail is open, if any. */
  private activeRunId: string | null = null;
  /** The debounce before re-reading an open run's detail. */
  private detailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The fallback poll for an engine whose event stream ends early. */
  private detailPollTimer: ReturnType<typeof setInterval> | null = null;
  /** The open run's event stream. */
  private eventController: AbortController | null = null;

  constructor(private readonly host: FleetHost) {}

  /** The panel is going away: drop the stream, the timers and the open run. */
  public cleanup(): void {
    this.stopFleetEventStream();
    this.activeRunId = null;
  }

  /** Refresh the Fleet run list shown in the sidebar. */
  public async refreshFleetRuns(): Promise<void> {
    try {
      const result = await this.host.api.listFleetRuns();
      this.host.postMessage({ type: "fleetRunList", status: result.status, runs: result.runs });
    } catch {
      // best-effort — endpoint may not exist on older TUI versions
    }
  }

  private isTerminalFleetStatus(status: string | null | undefined): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private async fetchFleetDetailPayload(runId: string): Promise<{
    run: unknown;
    workers: unknown[];
    receipts: unknown[];
  }> {
    const [run, workersResp, receiptsResp] = await Promise.all([
      this.host.api.getFleetRun(runId),
      this.host.api.listFleetRunWorkers(runId),
      this.host.api.listFleetRunReceipts(runId),
    ]);
    return {
      run,
      workers: workersResp.workers,
      receipts: receiptsResp.receipts,
    };
  }

  /** Load a Fleet run's detail (workers + tasks + receipts) into the overlay,
   *  then subscribe to its live SSE event stream for real-time refreshes. */
  public async showFleetDetail(runId: string): Promise<void> {
    try {
      this.activeRunId = runId;
      const payload = await this.fetchFleetDetailPayload(runId);
      this.host.postMessage({ type: "fleetRunDetail", ...payload });
      const status = (payload.run as { lifecycle_status?: string }).lifecycle_status;
      if (this.isTerminalFleetStatus(status)) {
        this.stopFleetEventStream();
      } else {
        this.startFleetEventStream(runId);
      }
    } catch (err) {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.stopFleetEventStream();
      vscode.window.showErrorMessage(`Failed to load Fleet run: ${(err as Error).message}`);
    }
  }

  public handleCloseFleetDetail(): void {
    this.activeRunId = null;
    this.stopFleetEventStream();
  }

  private async refreshActiveFleetDetail(): Promise<void> {
    if (!this.activeRunId) return;
    try {
      const payload = await this.fetchFleetDetailPayload(this.activeRunId);
      this.host.postMessage({ type: "fleetRunDetail", ...payload });
      const status = (payload.run as { lifecycle_status?: string }).lifecycle_status;
      if (this.isTerminalFleetStatus(status)) {
        this.stopFleetEventStream();
      }
    } catch {
      this.stopFleetEventStream();
    }
  }

  /** Debounce a detail refresh triggered by a streamed event. */
  private scheduleFleetDetailRefresh(): void {
    if (this.detailRefreshTimer) return;
    this.detailRefreshTimer = setTimeout(() => {
      this.detailRefreshTimer = null;
      void this.refreshActiveFleetDetail();
    }, 400);
  }

  /** Subscribe to the run's live SSE stream. Falls back to a slow poll if the
   *  stream errors, so the overlay never silently freezes. */
  private startFleetEventStream(runId: string): void {
    this.stopFleetEventStream();
    this.eventController = this.host.api.streamFleetEvents(
      runId,
      (event) => {
        // Forward the raw event to the webview for the live timeline, then
        // debounce a full detail refresh (workers/tasks/receipts).
        this.host.postMessage({ type: "fleetEvent", event });
        this.scheduleFleetDetailRefresh();
        void this.refreshFleetRuns();
      },
      () => {
        this.eventController = null;
        this.startFleetDetailPollFallback();
      }
    );
  }

  private stopFleetEventStream(): void {
    this.eventController?.abort();
    this.eventController = null;
    if (this.detailRefreshTimer) {
      clearTimeout(this.detailRefreshTimer);
      this.detailRefreshTimer = null;
    }
    this.stopFleetDetailPollFallback();
  }

  private startFleetDetailPollFallback(): void {
    if (!this.activeRunId || this.detailPollTimer) return;
    this.detailPollTimer = setInterval(() => {
      void this.refreshActiveFleetDetail();
    }, 3000);
  }

  private stopFleetDetailPollFallback(): void {
    if (this.detailPollTimer) {
      clearInterval(this.detailPollTimer);
      this.detailPollTimer = null;
    }
  }

  public async handleCreateFleetRun(
    req: CreateFleetRunRequest,
    startAfterCreate: boolean
  ): Promise<void> {
    try {
      const result = await this.host.api.createFleetRun(req);
      if (startAfterCreate && result.run?.id) {
        // TUI semantics: creation only queues the run; `/start` activates it.
        // The checkbox chains both steps so one click = one running fleet.
        try {
          await this.host.api.startFleetRun(result.run.id);
        } catch (startErr) {
          vscode.window.showWarningMessage(
            `Fleet run queued, but auto-start failed: ${(startErr as Error).message}`
          );
        }
      }
      await this.refreshFleetRuns();
      if (result.run?.id) {
        await this.showFleetDetail(result.run.id);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to create Fleet run: ${(err as Error).message}`);
    }
  }

  public async handleRequestFleetProfiles(): Promise<void> {
    try {
      const resp = await this.host.api.listFleetProfiles();
      this.host.postMessage({
        type: "fleetProfiles",
        profiles: resp?.profiles ?? [],
        loadError: resp?.load_error ?? null,
      });
    } catch {
      // Older TUI or transient failure: send an empty list so the webview
      // falls back to free-text agent_profile entry.
      this.host.postMessage({ type: "fleetProfiles", profiles: [], loadError: null });
    }
  }

  public async handleStartFleetRun(runId: string): Promise<void> {
    try {
      await this.host.api.startFleetRun(runId);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to start Fleet run: ${(err as Error).message}`);
    }
    await this.refreshFleetRuns();
    if (this.activeRunId === runId) {
      await this.refreshActiveFleetDetail();
    }
  }

  public async handleStopFleetRun(runId: string): Promise<void> {
    try {
      await this.host.api.stopFleetRun(runId);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to stop Fleet run: ${(err as Error).message}`);
    }
    await this.refreshFleetRuns();
    if (this.activeRunId === runId) {
      await this.refreshActiveFleetDetail();
    }
  }

  public async handleFleetWorkerAction(action: string, workerId: string): Promise<void> {
    try {
      if (action === "interrupt") await this.host.api.interruptFleetWorker(workerId);
      else if (action === "stop") await this.host.api.stopFleetWorker(workerId);
      else if (action === "restart") await this.host.api.restartFleetWorker(workerId);
      else return;
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to ${action} worker: ${(err as Error).message}`);
    }
    if (this.activeRunId) {
      await this.refreshActiveFleetDetail();
    }
    await this.refreshFleetRuns();
  }

  /** Resolve a Fleet receipt's saved exec session and surface the worker's
   *  final assistant reply — the same transcript a normal chat shows. */
  public async handleFleetOpenSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.host.api.ensureReady();
      const session = await this.host.api.getSession(sessionId);
      const messages = session.messages || [];
      let reply = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const role = (messages[i] as { role?: unknown }).role;
        if (role !== "assistant") continue;
        reply = this.extractTextFromSessionMessage(messages[i]);
        if (reply) break;
      }
      this.host.postMessage({ type: "fleetSessionReply", sessionId, reply });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to load fleet reply: ${(err as Error).message}`);
    }
  }

  private extractTextFromSessionMessage(message: Record<string, unknown>): string {
    const content = message.content;
    if (!Array.isArray(content)) return "";
    let out = "";
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b && b.type === "text" && typeof b.text === "string") out += b.text;
    }
    return out;
  }
}
