import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SlashCommandHandler, type SlashCommandContext } from "./commands/slash-command-handler";
import {
  CodeWhaleApiClient,
  CodeWhaleEngine,
  ProviderEntry,
  RuntimeApiCapabilities,
  RuntimeEvent,
  TaskRecord,
  ThreadRecord,
  TurnRecord,
  TurnItemRecord,
} from "./types";
import type {
  TaskSummary,
  ThreadDetailResponse,
  CreateFleetRunRequest,
  ThreadSummary,
  ThreadGoal,
} from "./types";
import { formatError, getErrorMessage } from "./utils/error-handler";
import { providerEntryRouteKey, providerRouteKey } from "./utils/provider-route";
import { getWebviewHtml } from "./webview/webview-html";
import { renderMarkdown } from "./utils/markdown";
import { finalizeAssistantMessage } from "./utils/event-helpers";
import { formatCostAmount, resolveCostCurrency } from "./utils/cost-calculator";
import {
  MODE_LABELS,
  POSTURE_LABELS,
  POSTURE_WIRE,
  normalizeMode,
  normalizePosture,
  postureFromThread,
  startupPosture,
  type PermissionPosture,
  type TuiMode,
} from "./utils/modes";
import {
  parseDiffToSides,
  stripTurnMeta,
  isInternalRuntimeHandoff,
  reconstructOldContent,
  getDiffStateForIndex,
  extractRecordedEdits,
  reverseApplyRecordedEdits,
  formatRecordedEditsAsDiff,
  type RecordedEdit,
} from "./utils/diff-utils";
import { resolveRecordedFilePath } from "./utils/file-paths";
import { MAX_EAGER_HASH_BYTES, sha256OfFile } from "./utils/file-hash";
import { t, webviewTranslations, currentLocale } from "./i18n";
import { ConfigPanel } from "./config-panel";
import {
  SessionStateStore,
  type ChatMessage,
  type ContentBlock,
  type ToolCallInfo,
  type FileChangeInfo,
  type StrategyStep,
  type SessionCostSnapshot,
  type UserInputState,
} from "./utils/session-state";
import {
  friendlyToolName,
  isFileChangeTool,
  extractFilePath,
  extractToolNameFromSummary,
  buildApprovalSummary,
  detectFileChange,
} from "./utils/tool-utils";

/** Normalize file path for dedup comparison: backslashes to forward, strip trailing slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

// TUI-compatible artifact path resolution
function getHomeDirectory(): string {
  return os.homedir();
}

function defaultTasksDir(): string {
  const deepseekTasksDir = process.env.DEEPSEEK_TASKS_DIR;
  if (deepseekTasksDir && deepseekTasksDir.trim()) {
    return deepseekTasksDir;
  }
  const home = getHomeDirectory();
  const primary = path.join(home, ".codewhale", "tasks");
  try {
    if (fs.existsSync(primary) && fs.statSync(primary).isDirectory()) {
      return primary;
    }
  } catch {
    // ignore
  }
  const legacy = path.join(home, ".deepseek", "tasks");
  try {
    if (fs.existsSync(legacy) && fs.statSync(legacy).isDirectory()) {
      return legacy;
    }
  } catch {
    // ignore
  }
  return primary;
}

function resolveTaskArtifactPath(relativeOrAbsolute: string): string {
  if (path.isAbsolute(relativeOrAbsolute)) {
    return path.normalize(relativeOrAbsolute);
  }
  return path.normalize(path.join(defaultTasksDir(), relativeOrAbsolute));
}

function mergeThreadRecord(
  current: ThreadRecord,
  updated: Partial<ThreadRecord> | undefined,
  fallback: Partial<ThreadRecord> = {},
): ThreadRecord {
  return {
    ...current,
    ...fallback,
    ...(updated || {}),
  };
}

/**
 * Identify an image's format from its magic bytes, mirroring TUI
 * image_attach.rs sniff_media_type: the provider validates the payload,
 * not the file extension or the label the sender chose. Returns null for
 * anything outside the four accepted formats.
 */
function sniffImageMime(bytes: Buffer): string | null {
  const head = (len: number) => bytes.subarray(0, len).toString("latin1");
  if (bytes.length >= 8 && head(8) === "\x89PNG\r\n\x1a\n") {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const gif = head(6);
    if (gif === "GIF87a" || gif === "GIF89a") {
      return "image/gif";
    }
  }
  if (bytes.length >= 12 && head(4) === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function imageBytesMatchMime(bytes: Buffer, mime: string): boolean {
  return sniffImageMime(bytes) === mime;
}

/**
 * One pending attachment. `previewUrl` is a transient thumbnail payload: it is
 * delivered to the webview once in its own message (see
 * `announceAttachmentPreview`) and deliberately kept out of the
 * `attachmentsChanged` list, which is re-published on every add / remove /
 * send.
 */
interface AttachmentRecord {
  id: string;
  kind: string;
  path: string;
  name: string;
  previewUrl?: string;
}

/**
 * Lightweight per-thread runtime cursor for a thread the view is not showing.
 * The runtime owns the turn (runtime_threads.rs owns the turn lifecycle), so
 * this only tracks what the rail badge, the attention notification, the
 * auto-save target and the "is it still busy" decision need while the user
 * works elsewhere.
 */
interface BackgroundThreadState {
  lastEventSeq: number;
  currentTurnId: string | null;
  running: boolean;
  attention: number;
  /** Auto-save in-place target (same thread → same session). */
  sessionId: string | null;
  goal: ThreadGoal | null;
  goalChecked: boolean;
  notifiedAttention: boolean;
}

/** Socket-level failures that mean "the engine is not there right now".
 *  A webview reload relaunches the Runtime on a fresh port, so a request
 *  issued in that window hits a dead listener and is worth one retry. */
const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Whether a failed thread-list fetch is worth retrying.
 *
 * A timeout is not transient here: `GET /v1/threads/summary` builds every row
 * from a full thread-detail read, so it legitimately takes seconds-per-thread
 * and a second attempt would just spend the same time again. A refused or
 * reset connection is transient, because the engine is coming back.
 */
function isTransientFetchError(err: unknown): boolean {
  if (err instanceof Error && err.message.startsWith("Request timed out")) return false;
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_SOCKET_CODES.has(code);
}

export class ChatProvider implements vscode.WebviewViewProvider, SlashCommandContext {
  public static readonly viewType = "brotherwhale.chat";

  /**
   * Socket timeout for `GET /v1/threads/summary`.
   *
   * The runtime builds every summary row from a full thread-detail read, so
   * this endpoint costs roughly a quarter-second per thread (25.4s at 72
   * threads, 189MB store, measured 2026-09-17). It needs real headroom over
   * that — the point of this constant is that the timeout should not be the
   * thing that breaks the rail.
   */
  private static readonly THREAD_SUMMARY_TIMEOUT_MS = 60_000;

  /** Fetch attempts per refresh. Only a transient (connection-level) failure
   *  is retried inside `fetchThreadSummaries`; a timeout is not. */
  private static readonly THREAD_LIST_ATTEMPTS = 2;

  private view?: vscode.WebviewView;
  public readonly api: CodeWhaleApiClient;
  public readonly engine: CodeWhaleEngine;
  private sessionState = new SessionStateStore();
  private slashHandler: SlashCommandHandler;
  private eventController: AbortController | null = null;
  private taskRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private taskDetailRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private activeTaskDetailId: string | null = null;
  private fleetDetailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private fleetEventController: AbortController | null = null;
  private fleetDetailPollTimer: ReturnType<typeof setInterval> | null = null;
  private activeFleetRunId: string | null = null;
  private _disposables: vscode.Disposable[] = [];
  private currentAttachments: AttachmentRecord[] = [];
  /** Monotonic source of attachment ids; see AttachmentRecord. */
  private attachmentSeq = 0;
  private showAllWorkspaces: boolean = false;
  /** Fallback workspace from the TUI, used when VS Code has no folder open. */
  private tuiWorkspace: string | null = null;
  /** Monotonic task-list refresh token used to drop stale async enrichment results. */
  private taskListRefreshToken: number = 0;
  /** Monotonic thread-list refresh token. The summary endpoint takes ~25s on a
   *  large store, so overlapping refreshes (sidebar opens, watcher errors) do
   *  finish out of order and a stale list must not clobber a newer one. */
  private threadListRefreshToken: number = 0;
  private runtimeVersion: string | null = null;
  /** Cached provider list from `GET /v1/providers`. Refreshed on init and
   * after the active provider changes so the webview picker stays in sync. */
  private providersCache: ProviderEntry[] | null = null;
  /** Active provider id (mirrors `GuiConfigResponse.provider`). Used to
   * render the picker's selected value without waiting for a config refresh. */
  private currentProvider: string | null = null;
  /** Exact configured id of the active route, when the catalog reports one —
   * the `model_provider_id` that distinguishes two user-defined
   * `[providers.<name>]` routes from each other, both of which report the
   * generic `custom` id. Null when the route has no exact id (the legacy
   * root-level custom route) or the runtime predates the field. */
  private currentProviderId: string | null = null;
  private apiCapabilities: RuntimeApiCapabilities = {
    saveSession: false,
    threadUndo: false,
    threadPatchUndo: false,
    threadRetry: false,
    turnSteer: false,
    snapshotList: false,
    snapshotRestore: false,
    threadUsage: false,
    threadFileRevert: false,
  };
  // Guard to prevent concurrent autoSaveSession calls.  When multiple
  // turn.completed events fire in quick succession (e.g. SSE reconnection
  // replaying buffered events) and currentSessionId is null, each call
  // would create a new session on the server, producing duplicates.
  private autoSaveInProgress = false;
  private readonly textArtifactPreviewStore = new Map<string, { content: string; language?: string }>();

  // ── Background (non-viewed) thread support ──
  // The runtime owns every turn: it keeps running server-side when the
  // client switches away (runtime_threads.rs owns the turn lifecycle). The
  // GUI parks the outgoing thread here and keeps a lightweight per-thread
  // SSE watch so badges, notifications, and auto-save stay live.

  /** Lightweight runtime cursor for a thread that is not the current view. */
  private backgroundThreads = new Map<string, BackgroundThreadState>();
  /** The goal of the thread the view is on, as last read by refreshGoal().
   *  parkCurrentThread() reads it: an Active goal keeps the runtime working on
   *  that thread after the view leaves — the continuations are armed by the
   *  runtime, not by this stream — so the goal alone needs a watch, including
   *  between two passes when no turn is in flight. */
  private currentGoal: ThreadGoal | null = null;
  /** One SSE subscription per watched background thread. */
  private watchControllers = new Map<string, AbortController>();
  /** User inputs pending on background threads, answerable cross-thread
   *  (`POST /v1/user-input/{threadId}/{inputId}` names the thread). Unlike
   *  sessionState.pendingUserInputs this map survives view switches. */
  private backgroundUserInputs = new Map<string, UserInputState>();
  /** Latest summary titles, for notification wording. */
  private threadTitles = new Map<string, string>();
  /** Debounced thread-list refresh driven by watcher events. */
  private threadListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a summary fetch is in flight, so a quiet discovery pass can
   *  yield to it instead of superseding the refresh that owns the rail. */
  private threadListFetchInFlight = false;
  /** Slow discovery sweep for attention nothing is watching yet. Chained, never
   *  fixed-interval, and cleared with the view. */
  private attentionDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private attentionDiscoveryActive = false;
  /** Threads with an in-flight background auto-save. */
  private backgroundSavingThreads = new Set<string>();
  /** The mode the turn in `currentTurnId` was started with, used only when the
   *  runtime does not report a mode on the turn record itself (see `turnMode`). */
  private activeTurnMode: { turnId: string; mode: TuiMode } | null = null;

  // Convenience accessors for session state
  public get currentThread(): ThreadRecord | null { return this.sessionState.data.currentThread; }
  public set currentThread(v: ThreadRecord | null) { this.sessionState.data.currentThread = v; }
  private get viewingSessionId(): string | null { return this.sessionState.data.viewingSessionId; }
  private set viewingSessionId(v: string | null) {
    this.sessionState.data.viewingSessionId = v;
    // The viewed route describes exactly the session being viewed: with no
    // session there is nothing on screen for it to describe, and a leftover
    // value would name a route the next message will not use. Cleared here so
    // every path that leaves a session (resume, delete, 新建会话) is covered by
    // one rule rather than five.
    if (v === null) {
      this.sessionState.data.viewingSessionProvider = null;
      this.sessionState.data.viewingSessionProviderId = null;
      this.sessionState.data.viewingSessionModel = null;
    }
  }
  private get viewingSessionWorkspace(): string | null { return this.sessionState.data.viewingSessionWorkspace; }
  private set viewingSessionWorkspace(v: string | null) { this.sessionState.data.viewingSessionWorkspace = v; }
  private get viewingSessionProvider(): string | null { return this.sessionState.data.viewingSessionProvider; }
  private set viewingSessionProvider(v: string | null) { this.sessionState.data.viewingSessionProvider = v; }
  private get viewingSessionProviderId(): string | null { return this.sessionState.data.viewingSessionProviderId; }
  private set viewingSessionProviderId(v: string | null) { this.sessionState.data.viewingSessionProviderId = v; }
  private get viewingSessionModel(): string | null { return this.sessionState.data.viewingSessionModel; }
  private set viewingSessionModel(v: string | null) { this.sessionState.data.viewingSessionModel = v; }
  private get currentSessionId(): string | null { return this.sessionState.data.currentSessionId; }
  private set currentSessionId(v: string | null) { this.sessionState.data.currentSessionId = v; }
  private get pendingSessionCost(): SessionCostSnapshot | null { return this.sessionState.data.pendingSessionCost; }
  private set pendingSessionCost(v: SessionCostSnapshot | null) { this.sessionState.data.pendingSessionCost = v; }
  public get messages(): ChatMessage[] { return this.sessionState.data.messages; }
  public set messages(v: ChatMessage[]) { this.sessionState.data.messages = v; }
  private get lastEventSeq(): number { return this.sessionState.data.lastEventSeq; }
  private set lastEventSeq(v: number) { this.sessionState.data.lastEventSeq = v; }
  private get currentTurnId(): string | null { return this.sessionState.data.currentTurnId; }
  private set currentTurnId(v: string | null) { this.sessionState.data.currentTurnId = v; }
  private get pendingApprovals(): Map<string, ToolCallInfo> { return this.sessionState.data.pendingApprovals; }
  private get pendingUserInputs() { return this.sessionState.data.pendingUserInputs; }
  private get activeItems() { return this.sessionState.data.activeItems; }
  private get currentTextBlockIdx(): number { return this.sessionState.data.currentTextBlockIdx; }
  private set currentTextBlockIdx(v: number) { this.sessionState.data.currentTextBlockIdx = v; }
  private get currentThinkingBlockIdx(): number { return this.sessionState.data.currentThinkingBlockIdx; }
  private set currentThinkingBlockIdx(v: number) { this.sessionState.data.currentThinkingBlockIdx = v; }
  private get checklistItems() { return this.sessionState.data.checklistItems; }
  private set checklistItems(v: { id: string; content: string; status: string }[]) { this.sessionState.data.checklistItems = v; }
  private get checklistCompletionPct(): number { return this.sessionState.data.checklistCompletionPct; }
  private set checklistCompletionPct(v: number) { this.sessionState.data.checklistCompletionPct = v; }
  private get strategySteps(): StrategyStep[] { return this.sessionState.data.strategySteps; }
  private set strategySteps(v: StrategyStep[]) { this.sessionState.data.strategySteps = v; }
  private get turnFileChanges(): FileChangeInfo[] { return this.sessionState.data.turnFileChanges; }
  private set turnFileChanges(v: FileChangeInfo[]) { this.sessionState.data.turnFileChanges = v; }
  public get sessionCostUsd(): number { return this.sessionState.data.stats.sessionCostUsd; }
  public set sessionCostUsd(v: number) { this.sessionState.data.stats.sessionCostUsd = v; }
  public get sessionCostCny(): number { return this.sessionState.data.stats.sessionCostCny; }
  public set sessionCostCny(v: number) { this.sessionState.data.stats.sessionCostCny = v; }
  public get displayedCostHighWaterUsd(): number { return this.sessionState.data.stats.displayedCostHighWaterUsd; }
  public set displayedCostHighWaterUsd(v: number) { this.sessionState.data.stats.displayedCostHighWaterUsd = v; }
  public get displayedCostHighWaterCny(): number { return this.sessionState.data.stats.displayedCostHighWaterCny; }
  public set displayedCostHighWaterCny(v: number) { this.sessionState.data.stats.displayedCostHighWaterCny = v; }
  public get totalTokens(): number { return this.sessionState.data.stats.totalTokens; }
  public set totalTokens(v: number) { this.sessionState.data.stats.totalTokens = v; }
  public get cumulativeTurnSecs(): number { return this.sessionState.data.stats.cumulativeTurnSecs; }
  public set cumulativeTurnSecs(v: number) { this.sessionState.data.stats.cumulativeTurnSecs = v; }
  public get lastCacheHitTokens(): number { return this.sessionState.data.stats.lastCacheHitTokens; }
  public set lastCacheHitTokens(v: number) { this.sessionState.data.stats.lastCacheHitTokens = v; }
  public get lastCacheMissTokens(): number { return this.sessionState.data.stats.lastCacheMissTokens; }
  public set lastCacheMissTokens(v: number) { this.sessionState.data.stats.lastCacheMissTokens = v; }
  public get lastInputTokens(): number { return this.sessionState.data.stats.lastInputTokens; }
  public set lastInputTokens(v: number) { this.sessionState.data.stats.lastInputTokens = v; }
  public get lastOutputTokens(): number { return this.sessionState.data.stats.lastOutputTokens; }
  public set lastOutputTokens(v: number) { this.sessionState.data.stats.lastOutputTokens = v; }
  public get totalInputTokens(): number { return this.sessionState.data.stats.totalInputTokens; }
  public set totalInputTokens(v: number) { this.sessionState.data.stats.totalInputTokens = v; }
  public get totalOutputTokens(): number { return this.sessionState.data.stats.totalOutputTokens; }
  public set totalOutputTokens(v: number) { this.sessionState.data.stats.totalOutputTokens = v; }

  constructor(
    private readonly extensionUri: vscode.Uri,
    engine: CodeWhaleEngine,
    api: CodeWhaleApiClient
  ) {
    this.engine = engine;
    this.api = api;
    this.api.bindEngine(engine);
    this.slashHandler = new SlashCommandHandler(this);
  }

  private debugLog(msg: string): void {
    try {
      const logDir = path.join(os.homedir(), ".codewhale-vscode-logs");
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, "debug.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch { /* ignore */ }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext
  ): void {
    this.debugLog("resolveWebviewView called");
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    const html = getWebviewHtml(webviewView.webview, this.extensionUri, webviewTranslations(t()));
    this.debugLog("webview HTML set, length=" + html.length);
    webviewView.webview.html = html;

    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          this.debugLog(`onDidReceiveMessage: ${msg.type}`);
          await this.handleWebviewMessage(msg);
        } catch (err) {
          this.debugLog(`onDidReceiveMessage error: ${getErrorMessage(err)}`);
          this.postMessage({ type: "error", message: formatError("Internal error", err) });
        }
      },
      null,
      this._disposables
    );

    webviewView.onDidDispose(() => this.cleanup());

    this.startAttentionDiscoveryPoll();

    this.initializeThread().catch((err) => {
      this.debugLog(`initializeThread FAILED: ${getErrorMessage(err)}`);
      this.postMessage({ type: "error", message: formatError("Initialization failed", err) });
      this.postMessage({ type: "status", text: "Failed to connect to engine" });
    });
  }

  // ── WebView messages ──

  private async handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type as string) {
      case "debugUiProbe":
        this.debugLog(`debugUiProbe: ${JSON.stringify(msg.payload ?? {})}`);
        break;
      case "sendMessage":
        await this.handleSendMessage(msg.text as string);
        break;
      case "steer":
        await this.handleSteer(msg.text as string);
        break;
      case "slashCommand":
        await this.handleSlashCommand(
          msg.command as string,
          msg.args as string
        );
        break;
      case "setPosture":
        await this.handleSetPosture(msg.posture as string);
        break;
      case "setDefaultMode":
        await this.handleSetDefaultMode(msg.mode as string);
        break;
      case "setDefaultPosture":
        await this.handleSetDefaultPosture(msg.posture as string);
        break;
      case "approvePlan":
        await this.handleApprovePlan(msg.text as string | undefined);
        break;
      case "switchProvider":
        await this.handleSwitchProvider(
          msg.provider as string,
          msg.model as string | undefined,
          msg.providerId as string | undefined
        );
        break;
      case "switchProviderFromSlash":
        // Forwarded from the /provider slash command handler — convert to the
        // standard switchProvider flow so all state updates go through one path.
        await this.handleSwitchProvider(
          msg.provider as string,
          msg.model as string | undefined,
          msg.providerId as string | undefined
        );
        break;
      case "requestProviderModels":
        await this.handleRequestProviderModels(
          msg.provider as string,
          undefined,
          msg.providerId as string | undefined
        );
        break;
      case "newThread":
        await this.handleNewThread();
        break;
      case "interrupt":
        await this.handleInterrupt();
        break;
      case "compact":
        await this.handleCompact();
        break;
      case "approvalDecision":
        await this.handleApprovalDecision(
          msg.approvalId as string,
          msg.decision as "allow" | "deny",
          !!msg.remember
        );
        break;
      case "userInputSelect":
        await this.handleUserInputSelect(
          msg.inputId as string,
          msg.questionId as string,
          msg.optionIdx as number,
          msg.optionLabel as string
        );
        break;
      case "userInputCancel":
        await this.handleUserInputCancel(msg.inputId as string);
        break;
      case "loadSession":
        await this.loadSessionMessages(msg.sessionId as string);
        break;
      case "loadThread":
        await this.loadThread(msg.threadId as string);
        break;
      case "toggleAllWorkspaces":
        this.showAllWorkspaces = !this.showAllWorkspaces;
        // Fire all three refreshes in parallel — they're independent.
        await Promise.all([
          this.refreshSessionList(),
          this.refreshThreadList(),
          this.refreshTaskList(),
        ]);
        break;
      case "webviewReady":
        try {
          // A reloaded webview has lost both its preview cache and its copy
          // of the attachment list, while the host still holds the records
          // and would send them with the next turn. Re-announce the
          // thumbnails first, then republish the list, so the chips and
          // their thumbs come back together.
          this.reannounceAttachmentPreviews();
          this.postAttachmentsChanged();
          await this.api.ensureReady();
          await this.syncWebviewState();
        } catch (err) {
          this.postMessage({
            type: "error",
            message: formatError("Failed to initialize", err),
          });
        }
        break;
      case "refreshSidebar":
        if (this.engine.isRunning) {
          this.api.syncFromEngine();
          this.refreshSessionList();
          this.refreshThreadList();
          this.refreshTaskList();
          this.refreshWorkPanel();
          this.refreshAgentRuns();
          void this.refreshFleetRuns();
          void this.refreshGoal();
        }
        break;
      case "retryThreadList":
        // The rail's manual retry after a failed fetch. Unlike the automatic
        // refreshes this one is the user asking, so it always runs.
        await this.refreshThreadList();
        break;
      case "openDiff":
        this.handleOpenDiff(msg.filePath as string, msg.diff as string | undefined, msg.changeIndex as number | undefined);
        break;
      case "openFile":
        this.handleOpenFile(msg.filePath as string);
        break;
      case "openExternal":
        await this.handleOpenExternal(msg.url as string);
        break;
      case "attachFile":
        await this.handleAttachFile();
        break;
      case "removeAttachment":
        this.handleRemoveAttachment(msg.index as number);
        break;
      case "attachImage":
        await this.handleAttachImageInline(
          msg.mime as string,
          msg.dataUrl as string,
          typeof msg.name === "string" ? msg.name : undefined
        );
        break;
      case "attachPaths":
        this.handleAttachPaths(Array.isArray(msg.uris) ? msg.uris as string[] : []);
        break;
      case "attachFileBlob":
        this.handleAttachFileBlob(
          typeof msg.name === "string" ? msg.name : undefined,
          msg.dataUrl as string
        );
        break;
      case "dropTooLarge":
        this.postMessage({ type: "error", message: t().fileDropTooLarge });
        break;
      case "undoLastTurn":
        await this.handleUndoLastTurn();
        break;
      case "retryLastTurn":
        await this.handleRetryLastTurn();
        break;
      case "revertFileChange":
        await this.handleRevertFileChange(
          msg.filePath as string,
          msg.changeType as string,
          msg.diff as string | undefined,
          msg.callId as string | undefined
        );
        break;
      case "deleteSession":
        await this.handleDeleteSession(msg.sessionId as string, msg.sessionTitle as string);
        break;
      case "searchSessions":
        await this.handleSearchSessions(msg.query as string);
        break;
      case "openConfigPanel":
        ConfigPanel.createOrShow(this.extensionUri, this.api);
        break;
      case "showAgentSessions":
        this.handleShowAgentSessions(msg.runId as string);
        break;
      case "showTaskDetail":
        this.handleShowTaskDetail(msg.taskId as string);
        break;
      case "closeTaskDetail":
        this.handleCloseTaskDetail();
        break;
      case "openTaskThread":
        await this.loadThread(msg.threadId as string);
        break;
      case "createTask":
        await this.handleCreateTaskFromSidebar(msg.prompt as string);
        break;
      case "cancelTask":
        await this.handleCancelTaskFromSidebar(msg.taskId as string);
        break;
      case "refreshTaskList":
        await this.refreshTaskList();
        break;
      case "refreshFleetRuns":
        await this.refreshFleetRuns();
        break;
      case "showFleetDetail":
        await this.showFleetDetail(msg.runId as string);
        break;
      case "closeFleetDetail":
        this.handleCloseFleetDetail();
        break;
      case "startFleetRun":
        await this.handleStartFleetRun(msg.runId as string);
        break;
      case "stopFleetRun":
        await this.handleStopFleetRun(msg.runId as string);
        break;
      case "fleetWorkerAction":
        await this.handleFleetWorkerAction(msg.action as string, msg.workerId as string);
        break;
      case "createFleetRun":
        await this.handleCreateFleetRun(
          msg.payload as CreateFleetRunRequest,
          msg.startAfterCreate === true
        );
        break;
      case "requestFleetProfiles":
        await this.handleRequestFleetProfiles();
        break;
      case "fleetOpenSession":
        await this.handleFleetOpenSession(msg.sessionId as string);
        break;
      case "setGoal":
        await this.handleSetGoal(
          msg.objective as string,
          msg.tokenBudget as number | undefined,
          msg.background === true,
        );
        break;
      case "resumeGoal":
        await this.handleResumeGoal();
        break;
      case "showThreadAttention":
        await this.handleShowThreadAttention(msg.threadId as string);
        break;
      case "completeGoal":
        await this.handleCompleteGoal();
        break;
      case "blockGoal":
        await this.handleBlockGoal();
        break;
      case "deleteGoal":
        await this.handleDeleteGoal();
        break;
    }
  }

  private async syncWebviewState(): Promise<void> {
    await this.refreshRuntimeVersion();
    await this.refreshApiCapabilities();
    await this.refreshProviders();
    this.refreshSessionList();
    this.refreshThreadList();
    this.refreshTaskList();
    this.refreshWorkPanel();
    this.refreshAgentRuns();
    void this.refreshFleetRuns();
    void this.refreshGoal();

    if (this.currentThread?.id) {
      await this.loadHistory(this.currentThread.id);
      this.subscribeToEvents();
    } else if (this.messages.length > 0) {
      this.postMessage({ type: "loadHistory", messages: this.messages });
    } else {
      this.postMessage({ type: "clearChat" });
    }

    this.postMessage({
        type: "ready",
        model: this.getCurrentModel(),
        mode: this.getCurrentMode(),
        posture: this.getEffectivePosture(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        providerId: this.currentProviderId || undefined,
        runtimeVersion: this.runtimeVersion,
      });
    this.postScopedDefaults();
  }

  /** The startup defaults new threads inherit. They are process-scoped, not
   *  thread state, so they travel on their own message instead of riding
   *  `settingsUpdated` — the webview marks each dropdown group against its own
   *  source, and this is the source for the "new threads" group.
   *
   *  Both values come from the same resolution the chips and a new thread use,
   *  so the group's mark cannot name a posture the next session will not start
   *  under (a legacy `defaultMode: "yolo"`, for instance, is Full Access). */
  public postScopedDefaults(): void {
    this.postMessage({
      type: "scopedDefaults",
      mode: this.getCurrentMode(),
      posture: this.getCurrentPosture(),
    });
  }

  /** Publish the active thread's mode, permission, model, and reasoning.
   *
   *  Every path that assigns `currentThread` from `createThread` has to call
   *  this. The status-bar chips describe the *active thread*, so a thread the
   *  webview was never told about leaves them describing the one before it —
   *  and the disagreement stays invisible until a turn runs under the mode the
   *  chips do not show.
   *
   *  With no active thread (新建会话 has just cleared one) this publishes the
   *  startup defaults, which is exactly what the next thread will inherit. */
  private postCurrentSettings(): void {
    this.postMessage({
      type: "settingsUpdated",
      mode: normalizeMode(this.currentThread?.mode || this.getCurrentMode()),
      posture: this.getEffectivePosture(),
      model: this.currentThread?.model || this.getCurrentModel(),
      reasoningEffort: this.getCurrentReasoningEffort(),
    });
    // The picker describes the route the view is bound to, and the view's
    // binding changes with the conversation — so every thread change re-states
    // it. Sent from the same place as the model chip, because the two are the
    // same answer and must not be able to disagree.
    this.postProviders();
  }

  /** A `brotherwhale.*` setting changed outside this panel: the VS Code
   *  settings editor, another window, or the config panel.
   *
   *  Nothing in the webview reads the settings directly. The chips were last
   *  told the active thread's values and the dropdown's "New threads" group the
   *  startup defaults, so a change made anywhere else has to be re-announced —
   *  otherwise the toolbar goes on describing what a new session would have
   *  started with before the change, and the session that does start uses a
   *  mode and permission the UI never showed. */
  public handleConfigurationChanged(): void {
    this.postCurrentSettings();
    this.postScopedDefaults();
  }

  /** Change the startup mode for new threads only: the active thread keeps its
   *  own mode, which is the scope the dropdown's second group promises. */
  private async handleSetDefaultMode(mode: string): Promise<void> {
    const resolved = normalizeMode(mode);
    await vscode.workspace.getConfiguration("brotherwhale").update(
      "defaultMode",
      resolved,
      vscode.ConfigurationTarget.Global,
    );
    this.postScopedDefaults();
    this.postMessage({
      type: "info",
      message: `New threads will start in ${MODE_LABELS[resolved]}`,
    });
  }

  /** Change the startup permission posture for new threads only. */
  private async handleSetDefaultPosture(posture: string): Promise<void> {
    const resolved = normalizePosture(posture);
    await vscode.workspace.getConfiguration("brotherwhale").update(
      "defaultPermissionPosture",
      POSTURE_WIRE[resolved],
      vscode.ConfigurationTarget.Global,
    );
    this.postScopedDefaults();
    this.postMessage({
      type: "info",
      message: `New threads will start with ${POSTURE_LABELS[resolved]}`,
    });
  }

  // ── Initialization ──

  private async initializeThread(): Promise<void> {
    this.debugLog("initializeThread START");
    try {
      this.debugLog("calling api.ensureReady()...");
      await this.api.ensureReady();
      this.debugLog(`engine running on ${this.engine.baseUrl}`);
      // Cache the TUI workspace as a fallback for when VS Code has no folder open.
      this.api.getWorkspaceStatus().then(r => { this.tuiWorkspace = r.workspace; }).catch(() => {});
      await this.refreshRuntimeVersion();
      await this.refreshApiCapabilities();

      this.debugLog("calling listThreads...");
      const allThreads = await this.api.listThreads({ limit: 100 });
      this.debugLog(`listThreads returned ${allThreads.length} threads`);
      await this.refreshSessionList();

      // Filter threads to the current workspace. The runtime thread store is
      // global (not scoped by workspace), so listThreads may return stale
      // threads from a previously-opened project.
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const threads = currentWorkspace
        ? allThreads.filter(t => t.workspace === currentWorkspace)
        : allThreads;

      const threadWithContent = threads.find(t => t.latest_turn_id !== null);
      
      if (threadWithContent) {
        this.currentThread = threadWithContent;
        // The conversation this window was last in keeps the session it writes
        // to. Dropping it here is how a reload turned the next auto-save into a
        // second document for the same history.
        this.currentSessionId = threadWithContent.session_id ?? null;
        await this.loadHistory();
        this.subscribeToEvents();
      } else if (threads.length > 0) {
        this.currentThread = threads[0];
        this.currentSessionId = threads[0].session_id ?? null;
        this.postMessage({ type: "clearChat" });
        this.postMessage({ 
          type: "status", 
          text: "Ready - Start a new conversation" 
        });
      } else {
        this.postMessage({ type: "clearChat" });
        this.postMessage({ type: "status", text: "Ready - No threads yet" });
      }

      this.debugLog("initializeThread SUCCESS, posting ready");
      // Refresh provider list in the background so the picker is populated
      // even on first load. Don't await — this is best-effort and must not
      // block the ready signal.
      void this.refreshProviders();
      this.postMessage({ 
        type: "ready", 
        model: this.currentThread?.model || this.getCurrentModel(),
        mode: normalizeMode(this.currentThread?.mode || this.getCurrentMode()),
        posture: this.getEffectivePosture(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        providerId: this.currentProviderId || undefined,
        runtimeVersion: this.runtimeVersion,
      });
    } catch (err) {
      this.debugLog(`initializeThread ERROR: ${getErrorMessage(err)}\n${(err as Error).stack}`);
      this.postMessage({
        type: "error",
        message: formatError("Failed to initialize", err),
      });
      this.postMessage({
        type: "ready",
        model: this.currentThread?.model || this.getCurrentModel(),
        mode: normalizeMode(this.currentThread?.mode || this.getCurrentMode()),
        posture: this.getEffectivePosture(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        providerId: this.currentProviderId || undefined,
        runtimeVersion: this.runtimeVersion,
      });
    }
  }

  private async loadHistory(threadId?: string): Promise<number> {
    const id = threadId ?? this.currentThread?.id;
    if (!id) return 0;
    try {
      const detail = await this.api.getThreadDetail(id);
      this.messages = [];
      this.turnFileChanges = [];
      this.lastEventSeq = detail.latest_seq ?? 0;
      const itemById = new Map(detail.items.map((item) => [item.id, item]));

      for (const turn of detail.turns) {
        // A mid-turn steer splits the turn into multiple assistant segments.
        // Segment state below resets at each steer boundary so history
        // renders like the live view: assistant → steer bubble → assistant
        // (TUI dispatch.rs flush_active_cell ordering).
        let content = "";
        let thinking = "";
        let toolCalls: ToolCallInfo[] = [];
        let blocks: ContentBlock[] = [];
        let currentTextBlock: ContentBlock | undefined;
        let currentThinkingBlock: ContentBlock | undefined;
        let segmentIdx = 0;
        let emittedUserBubble = false;
        const turnStartIdx = this.messages.length;

        // Turn-level: a tool in flight when the steer landed has its result
        // item persisted AFTER the steer item, so resolve by object
        // reference rather than a per-segment index.
        const toolCallById = new Map<string, ToolCallInfo>();
        const applyToolResult = (
          toolUseId: string,
          output: string,
          isError: boolean,
          metadata?: Record<string, unknown>,
        ): void => {
          const tc = toolCallById.get(toolUseId);
          if (!tc) return;
          tc.output = output;
          tc.status = isError ? "error" : "complete";
          if (isError) {
            // A failed file tool never produced a mutation item live; keep the
            // replay aligned by dropping the provisional card we built from the
            // seed tool_use input.
            tc.fileChange = undefined;
            return;
          }
          // Rebuild the file-change card now that the real result (and any
          // mutation metadata) is available — seed-path tool items are first
          // seen with only their input.
          tc.fileChange = detectFileChange({
            toolName: tc.name,
            input: tc.input as Record<string, unknown> | undefined,
            output,
            metadata,
          });
        };

        const flushAssistantSegment = (): void => {
          if (content || thinking || toolCalls.length > 0 || blocks.length > 0) {
            for (const b of blocks) {
              if ((b.type === "text" || b.type === "thinking") && b.content) {
                try { b.contentHtml = renderMarkdown(b.content); } catch { b.contentHtml = b.content; }
              }
            }
            this.messages.push({
              id: segmentIdx === 0 ? `assistant-${turn.id}` : `assistant-${turn.id}-s${segmentIdx}`,
              role: "assistant",
              content: content || (segmentIdx === 0 ? turn.input_summary.slice(0, 100) : ""),
              thinking: thinking || undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              blocks: blocks.length > 0 ? blocks : undefined,
              status: turn.status === "completed" ? "complete" : "error",
              timestamp: new Date(turn.ended_at || turn.created_at).getTime(),
            });

            for (const tc of toolCalls) {
              // One record per change: the panel lists what each tool call did,
              // so reverting one of them leaves the others reviewable.
              if (tc.fileChange) this.appendFileChange(tc.fileChange);
            }
          }
          content = "";
          thinking = "";
          toolCalls = [];
          blocks = [];
          currentTextBlock = undefined;
          currentThinkingBlock = undefined;
          segmentIdx++;
        };

        const turnItems = (turn.item_ids || [])
          .map((itemId) => itemById.get(itemId))
          .filter((item): item is TurnItemRecord => !!item);

        for (const item of turnItems) {
          switch (item.kind) {
            case "user_message": {
              const text = stripTurnMeta(item.detail || item.summary || "").trim();
              if (!text) break;
              if (!emittedUserBubble) {
                emittedUserBubble = true;
                this.messages.push({
                  id: `user-${turn.id}`,
                  role: "user",
                  content: text.slice(0, 280),
                  status: "complete",
                  timestamp: new Date(item.started_at || turn.created_at).getTime(),
                });
              } else {
                // Steer (TUI parity): flush the segment above it, then the
                // steer bubble, then continue accumulating into a fresh
                // segment — matching the live interrupt rendering.
                flushAssistantSegment();
                this.messages.push({
                  id: `user-steer-${item.id}`,
                  role: "user",
                  content: text,
                  status: "complete",
                  timestamp: new Date(item.started_at || turn.created_at).getTime(),
                  steered: true,
                });
              }
              break;
            }
            case "agent_message": {
              const text = item.detail || item.summary;
              if (!text) break;
              if (currentTextBlock) {
                currentTextBlock.content = (currentTextBlock.content || "") + text;
              } else {
                currentTextBlock = { type: "text", content: text };
                blocks.push(currentTextBlock);
              }
              content += text;
              break;
            }
            case "agent_reasoning": {
              const th = item.detail || item.summary;
              if (!th) break;
              if (currentThinkingBlock) {
                currentThinkingBlock.content = (currentThinkingBlock.content || "") + th;
              } else {
                currentThinkingBlock = { type: "thinking", content: th };
                blocks.push(currentThinkingBlock);
              }
              thinking += th;
              break;
            }
            case "tool_call": {
              currentTextBlock = undefined;
              currentThinkingBlock = undefined;
              const metadata = (item.metadata as Record<string, unknown>) || {};
              const toolResultFor = typeof metadata.tool_result_for === "string"
                ? metadata.tool_result_for
                : undefined;
              if (toolResultFor) {
                applyToolResult(
                  toolResultFor,
                  item.detail || item.summary || "",
                  !!metadata.is_error,
                  metadata,
                );
                break;
              }
              const tcIdx = toolCalls.length;
              // The TUI runtime persists seed-path tool_use items with summary
              // `name(input_json)` and tags them with `metadata.tool_name`.
              // `extractToolNameFromSummary` handles the live formats
              // (`name: output`, `name started`) but not the seed `name(...)`
              // form — so when the runtime supplies `tool_name`, it is the
              // authoritative name and must win over summary parsing.
              const rawName = typeof metadata.tool_name === "string"
                ? metadata.tool_name
                : extractToolNameFromSummary(item.summary || "");
              // Seed-path tool_use items persist their full arguments as a JSON
              // string in `detail` and tag themselves with `metadata.tool_name`.
              // Live-executed items overwrite `detail` with output, so only the
              // seed form carries recoverable input here. (The one live item
              // that also sets `tool_name` — request_user_input — stores a
              // non-JSON redaction marker in `detail`, so it never reaches the
              // parse branch.)
              let toolInput: Record<string, unknown> = metadata;
              let toolOutput: string | undefined = item.detail || undefined;
              if (typeof metadata.tool_name === "string" && item.detail) {
                try {
                  const parsed = JSON.parse(item.detail);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    toolInput = parsed as Record<string, unknown>;
                    // `detail` held the tool's *arguments*, not its output —
                    // don't also surface it as `output`, or the same arguments
                    // render twice (inline input block + a mislabeled output
                    // chunk) whenever no tool result overwrites it.
                    toolOutput = undefined;
                  }
                } catch {
                  // detail is not JSON (e.g. plain output) — keep metadata.
                }
              }
              const tc: ToolCallInfo = {
                name: rawName,
                input: toolInput,
                output: toolOutput,
                status: item.status === "completed" ? "complete" : "error",
                itemId: typeof metadata.tool_use_id === "string" ? metadata.tool_use_id : item.id,
              };
              if (tc.itemId) {
                toolCallById.set(tc.itemId, tc);
              }
              // Authoritative signal first: current TUI file tools carry
              // `metadata.mutation` (diff + per-file outcome). The legacy
              // name-based fallback covers old recordings and seed replay.
              const fileChange = detectFileChange({
                toolName: tc.name,
                input: tc.input as Record<string, unknown> | undefined,
                output: tc.output || "",
                metadata,
              });
              if (fileChange) {
                tc.fileChange = fileChange;
              }
              toolCalls.push(tc);
              blocks.push({ type: "tool_call", toolCallIdx: tcIdx });
              break;
            }
            case "file_change": {
              currentTextBlock = undefined;
              currentThinkingBlock = undefined;
              const tcIdx2 = toolCalls.length;
              const fcOutput = item.detail || "";
              const fcMeta = (item.metadata as Record<string, unknown>) || {};
              const fcToolName = extractToolNameFromSummary(item.summary || "");
              const fileChange = detectFileChange({
                toolName: fcToolName,
                input: fcMeta,
                output: fcOutput,
                metadata: fcMeta,
              });
              const fcTc: ToolCallInfo = {
                name: fcToolName || "file_change",
                displayName: friendlyToolName(fcToolName || "file_change"),
                input: fcMeta,
                output: fcOutput,
                status: item.status === "completed" ? "complete" : "error",
                fileChange,
              };
              toolCalls.push(fcTc);
              blocks.push({ type: "tool_call", toolCallIdx: tcIdx2 });
              break;
            }
          }
        }

        // Turns without a persisted user_message item (e.g. runtime-initiated
        // turns) still show the input summary as the turn's user bubble.
        if (!emittedUserBubble && turn.input_summary.trim()) {
          this.messages.splice(turnStartIdx, 0, {
            id: `user-${turn.id}`,
            role: "user",
            content: turn.input_summary.trim().slice(0, 280),
            status: "complete",
            timestamp: new Date(turn.created_at).getTime(),
          });
        }

        flushAssistantSegment();

        // Stamp the turn's usage onto its final assistant bubble so the
        // reloaded view shows the same ↑/↓ token chip as the live view
        // (which attaches usage to the last assistant message on
        // turn.completed). Only the last segment carries it, matching the
        // live path where messageComplete fires once per turn.
        if (turn.usage) {
          for (let mi = this.messages.length - 1; mi >= turnStartIdx; mi--) {
            if (this.messages[mi].role === "assistant") {
              this.messages[mi].usage = turn.usage;
              break;
            }
          }
        }

        // Preserve the legacy behavior for turns with no assistant output
        // at all: emit the fallback bubble (input summary preview) rather
        // than rendering nothing for the turn.
        if (!this.messages.slice(turnStartIdx).some((m) => m.role === "assistant")) {
          this.messages.push({
            id: `assistant-${turn.id}`,
            role: "assistant",
            content: turn.input_summary.slice(0, 100),
            status: turn.status === "completed" ? "complete" : "error",
            timestamp: new Date(turn.ended_at || turn.created_at).getTime(),
          });
        }
      }

      if (this.turnFileChanges.length > 0) {
        this.refreshWorkPanel();
      }

      // "Last turn" cache stats come from the most recent persisted usage
      // record; token/cost TOTALS are fetched from the TUI runtime below,
      // which owns the rate tables and the recorded-time pricing.
      for (const turn of detail.turns) {
        if (turn.usage) {
          const u = turn.usage;
          this.lastCacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
          this.lastCacheMissTokens = u.prompt_cache_miss_tokens ?? Math.max(0, u.input_tokens - (u.prompt_cache_hit_tokens ?? 0));
          this.lastInputTokens = u.input_tokens;
          this.lastOutputTokens = u.output_tokens;
        }
      }
      await this.refreshThreadUsage(id);

      // Switching back into a thread whose turn is still running server-side:
      // re-align the view with that turn so live SSE routes correctly, the
      // Stop/Steer controls work, and turn.completed bookkeeping (usage,
      // auto-save) applies. The runtime kept the turn alive while we were
      // away; we only resume observing it.
      const lastTurn = detail.turns[detail.turns.length - 1];
      if (lastTurn && (lastTurn.status === "in_progress" || lastTurn.status === "queued")) {
        this.currentTurnId = lastTurn.id;
        this.ensureAssistantPlaceholderForExternalTurn();
        this.startPeriodicTaskRefresh();
        this.postMessage({ type: "turnStarted", turnId: lastTurn.id });
      }

      // A conversation rebuilt from history keeps what it is still waiting on.
      // The runtime holds a pending approval across a view switch, but the
      // `approval.required` event that announced it sits behind the cursor this
      // view resumes from, so the stream never repeats it — without this a
      // thread the rail calls "needs you" opens looking idle, with no card and
      // no panel. Seeded *before* the rebuild so the webview's own copy of the
      // tool row carries it, which is what lets a later re-render redraw it.
      this.seedPendingApprovals(detail);
      this.postMessage({
        type: "loadHistory",
        messages: this.messages,
        planApprovalFor: this.planApprovalTargetId(this.turnMode(lastTurn)),
      });
      // After the rebuild, never before: it clears the approval panel, so a
      // prompt offered ahead of it would be wiped by its own history draw.
      this.postPendingPrompts(id, detail);
      this.postMessage({ type: "status", text: `Loaded ${this.messages.length / 2} turns` });
      return this.lastEventSeq;
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to load history", err),
      });
      return this.lastEventSeq;
    }
  }

  /** Re-attach the approvals a rebuilt conversation is still waiting on.
   *
   *  An approval outlives the view that raised it: the runtime keeps the
   *  waiter across a view switch, but the event that announced it is behind
   *  the cursor this view resumes from (`replay_events` skips
   *  `seq <= since_seq`), so the stream never repeats it. The typed pending
   *  list is the authority instead, and the tool row — not just the panel — is
   *  seeded with it: the renderer draws the request's line from the tool
   *  call's own state and re-hands every still-pending approval to the panel
   *  on each rebuild, so a re-render cannot quietly drop a request nobody
   *  answered.
   *
   *  `tool_call_id` is the correlator the runtime documents for exactly this
   *  ("a client resuming from a snapshot needs it to attach the prompt to the
   *  tool row it belongs to"), and it is the id history restores onto the row
   *  from the item's `tool_use_id`. */
  private seedPendingApprovals(detail: ThreadDetailResponse): void {
    for (const req of detail.pending_approvals || []) {
      const tc = req.tool_call_id ? this.findToolCall(req.tool_call_id) : undefined;
      if (!tc) continue;
      tc.status = "awaiting_approval";
      tc.displayName = friendlyToolName(req.tool_name);
      tc.approvalId = req.id;
      tc.approvalSummary =
        req.description || req.intent_summary || friendlyToolName(req.tool_name);
    }
  }

  /** Offer the prompts the message list cannot carry.
   *
   *  A user-input question is drawn into a message body by its own message
   *  rather than by the renderer, and an approval whose tool row never made it
   *  into the conversation has no card to hang a line on. The panel is the only
   *  place either can be answered, and a question has to sit in one of the maps
   *  `handleUserInputSelect` reads — an input the rail never expanded is in
   *  neither of them, so its buttons would post an answer nowhere. */
  private postPendingPrompts(threadId: string, detail: ThreadDetailResponse): void {
    for (const req of detail.pending_user_inputs || []) {
      // A rail card may already hold this question, with answers collected
      // there. Leave that state where it is — `handleUserInputSelect` reads both
      // maps — instead of registering a second, blank copy that would win the
      // lookup and throw the collected answers away. The bar is posted either
      // way: the question is on screen now, so it has to be answerable here.
      if (!this.pendingUserInputs.has(req.id) && !this.backgroundUserInputs.has(req.id)) {
        this.pendingUserInputs.set(req.id, {
          threadId,
          questions: req.request.questions,
          answers: [],
          answeredQuestions: new Set(),
        });
      }
      this.postMessage({
        type: "userInputRequired",
        messageId: this.messageIdForTurn(req.turn_id),
        inputId: req.id,
        questions: req.request.questions,
      });
    }
    for (const req of detail.pending_approvals || []) {
      // A row that rendered already carries this one; posting it again would
      // only re-open a panel that is already open.
      if (req.tool_call_id && this.findToolCall(req.tool_call_id)) continue;
      this.postMessage({
        type: "approvalRequired",
        approvalId: req.id,
        toolName: friendlyToolName(req.tool_name),
        rawToolName: req.tool_name,
        summary: req.description || req.intent_summary || friendlyToolName(req.tool_name),
      });
    }
  }

  /** Retire an approval everywhere this client still holds it: the live entry
   *  it was registered under, and every rebuilt tool row the same id was seeded
   *  onto (`seedPendingApprovals`). Passing null retires all of them, which is
   *  the interrupt case — nothing this client is holding is still pending then.
   *
   *  The rows need this as much as the live entry does: the webview draws a
   *  pending approval's line, and hands the request to the panel, from the tool
   *  call's own state, so a row still naming an answered approval would offer
   *  buttons for it again the next time the conversation is rebuilt from that
   *  state. */
  private retireApproval(approvalId: string | null, status: "running" | "error"): void {
    if (approvalId === null) this.pendingApprovals.clear();
    else this.pendingApprovals.delete(approvalId);
    // The map's entry is one of these calls (it is resolved out of
    // `this.messages`), so the scan retires it along with the seeded rows.
    for (const msg of this.messages) {
      for (const tc of msg.toolCalls || []) {
        if (!tc.approvalId) continue;
        if (approvalId !== null && tc.approvalId !== approvalId) continue;
        tc.status = status;
        tc.approvalId = undefined;
      }
    }
  }

  /** The rebuilt tool row a pending approval gates, by provider call id. */
  private findToolCall(toolCallId: string): ToolCallInfo | undefined {
    for (const msg of this.messages) {
      for (const tc of msg.toolCalls || []) {
        if (tc.itemId === toolCallId) return tc;
      }
    }
    return undefined;
  }

  /** The message a turn's output rendered into, so a prompt belonging to that
   *  turn lands on it instead of on whatever came last. */
  private messageIdForTurn(turnId: string | undefined): string | undefined {
    const id = turnId ? `assistant-${turnId}` : "";
    if (id && this.messages.some((msg) => msg.id === id)) return id;
    return this.messages[this.messages.length - 1]?.id;
  }

  public async loadSessionMessages(sessionId: string): Promise<void> {
    this.parkCurrentThread();
    try {
      const session = await this.api.getSession(sessionId);
      const title = session.metadata.title || "Session";

      this.sessionState.reset();
      this.viewingSessionId = sessionId;
      this.viewingSessionWorkspace = session.metadata.workspace || null;
      // The session's own provider route, not the picker's: this session was
      // saved on it and `POST /v1/sessions/{id}/resume-thread` builds its
      // thread from exactly these two fields. Without them the toolbar
      // described the picker's route while the conversation on screen would
      // run on its own as soon as a message resumed it — the model chip
      // followed the session and the provider chip did not.
      this.viewingSessionProvider = session.metadata.model_provider?.trim() || null;
      this.viewingSessionProviderId = session.metadata.model_provider_id?.trim() || null;
      this.viewingSessionModel = session.metadata.model?.trim() || null;

      // Tell the webview which model/mode this session uses so the status
      // bar reflects the loaded session (not the user's global default).
      // We deliberately do NOT update the global VSCode config — that would
      // permanently change defaultModel/defaultMode and cause every new
      // conversation to inherit the session's mode, even after the user
      // moves on to a different task (e.g. a plan-mode session would lock
      // the extension into plan mode forever).
      const sessionModel = session.metadata.model;
      const sessionMode = normalizeMode(session.metadata.mode || "agent");
      const cfg = vscode.workspace.getConfiguration("brotherwhale");
      // A session with no model recorded falls back to the model its own route
      // would run, not to one global value shared by every provider.
      const currentModel = this.getCurrentModel();
      this.postMessage({
        type: "settingsUpdated",
        model: sessionModel || currentModel,
        mode: sessionMode,
        posture: this.getCurrentPosture(),
        reasoningEffort: cfg.get<string>("reasoningEffort", "auto"),
      });
      // The provider chip and the model menu describe the route on screen, and
      // for a viewed session that route is this session's — so it is published
      // now, not only after a message resumes it into a thread.
      this.postProviders();

      // Stash the session's persisted cost so it can be restored after
      // resumeSessionThread + loadThread (which zero stats because seeded
      // turns have no usage data). Mirrors TUI's apply_loaded_session.
      const cost = session.metadata.cost;
      if (cost) {
        this.pendingSessionCost = {
          sessionCostUsd: cost.session_cost_usd || 0,
          sessionCostCny: cost.session_cost_cny || 0,
          subagentCostUsd: cost.subagent_cost_usd || 0,
          subagentCostCny: cost.subagent_cost_cny || 0,
          displayedCostHighWaterUsd: cost.displayed_cost_high_water_usd || 0,
          displayedCostHighWaterCny: cost.displayed_cost_high_water_cny || 0,
          totalTokens: session.metadata.total_tokens || 0,
          cumulativeTurnSecs: session.metadata.cumulative_turn_secs || 0,
        };
      }

      const rawMessages = session.messages as Array<{
        role: string;
        content: Array<{
          type: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: string;
          content_blocks?: Array<{ type: string; text?: string }>;
          is_error?: boolean;
        }>;
      }>;

    const globalToolCalls: ToolCallInfo[] = [];
    const globalToolIdMap: Map<string, number> = new Map();
    const getToolResultText = (block: {
      content?: string;
      content_blocks?: Array<{ type: string; text?: string }>;
    }): string => {
      if (typeof block.content === "string") {
        return block.content;
      }
      if (Array.isArray(block.content_blocks)) {
        return block.content_blocks
          .map((part) => part.text || "")
          .filter((text) => text.length > 0)
          .join("\n");
      }
      return "";
    };
    const updateFileChangeCard = (toolCall: ToolCallInfo, failed: boolean): void => {
      if (failed) {
        // An unsuccessful file tool changed nothing, and the live view shows
        // no card for it either: the runtime reports it as `item.failed`,
        // which never reaches the change-card path. Drop the card the
        // tool_use block provisionally created so a replay matches.
        toolCall.fileChange = undefined;
        return;
      }
      if (!isFileChangeTool(toolCall.name) || !toolCall.input) return;
      const fileChange = detectFileChange({
        toolName: toolCall.name,
        input: toolCall.input as Record<string, unknown> | undefined,
        output: toolCall.output || "",
      });
      if (fileChange) {
        toolCall.fileChange = fileChange;
      }
    };

    let i = 0;
    while (i < rawMessages.length) {
      const msg = rawMessages[i];

      if (msg.role === "user" && msg.content.every((b) => b.type === "tool_result")) {
        for (const block of msg.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const idx = globalToolIdMap.get(block.tool_use_id);
            if (idx !== undefined && globalToolCalls[idx]) {
              const outputText = getToolResultText(block);
              globalToolCalls[idx].output = outputText;
              globalToolCalls[idx].status = block.is_error ? "error" : "complete";
              updateFileChangeCard(globalToolCalls[idx], !!block.is_error);
            }
          }
        }
        i++;
        continue;
      }

      if (msg.role === "user") {
        // Consecutive user text messages are mid-turn steers (the engine
        // appends each steered prompt as its own user message). Render each
        // as its own bubble — the first is the turn input, later ones carry
        // the steer badge — instead of concatenating them into one blob.
        let isFirstUserText = true;
        while (i < rawMessages.length && rawMessages[i].role === "user") {
          const textBlocks: string[] = [];
          for (const block of rawMessages[i].content || []) {
            if (block.type === "text" && block.text) {
              textBlocks.push(block.text);
            }
          }
          i++;

          const combined = stripTurnMeta(textBlocks.join("\n"));
          if (!combined.trim()) continue;
          if (isInternalRuntimeHandoff(textBlocks)) continue;

          this.messages.push({
            id: `user-turn-${this.messages.length}`,
            role: "user",
            content: combined,
            status: "complete" as const,
            timestamp: Date.now(),
            steered: !isFirstUserText || undefined,
            _realContent: true,
          } as ChatMessage & { _realContent: boolean });
          isFirstUserText = false;
        }
      } else {
        const blocks: ContentBlock[] = [];
        const turnToolCallIndices: number[] = [];

        while (i < rawMessages.length && rawMessages[i].role !== "user") {
          for (const block of rawMessages[i].content || []) {
            if (block.type === "text" && block.text) {
              blocks.push({ type: "text", content: block.text });
            } else if (block.type === "thinking" && (block.thinking || block.text)) {
              blocks.push({ type: "thinking", content: block.thinking || block.text || "" });
            } else if ((block.type === "tool_use" || block.type === "server_tool_use") && block.id && block.name) {
              const idx = globalToolCalls.length;
              globalToolIdMap.set(block.id, idx);
              const toolCall: ToolCallInfo = {
                name: block.name,
                displayName: friendlyToolName(block.name),
                input: block.input || {},
                status: "pending",
                itemId: block.id,
              };
              updateFileChangeCard(toolCall, false);
              globalToolCalls.push(toolCall);
              blocks.push({ type: "tool_call", toolCallIdx: idx });
              turnToolCallIndices.push(idx);
            } else if (block.type === "tool_result" && block.tool_use_id) {
              const idx = globalToolIdMap.get(block.tool_use_id);
              if (idx !== undefined && globalToolCalls[idx]) {
                const outputText = getToolResultText(block);
                globalToolCalls[idx].output = outputText;
                globalToolCalls[idx].status = block.is_error ? "error" : "complete";
                updateFileChangeCard(globalToolCalls[idx], !!block.is_error);
              }
            }
          }
          i++;
        }

        while (i < rawMessages.length && rawMessages[i].role === "user"
          && rawMessages[i].content.every((b) => b.type === "tool_result")) {
          for (const block of rawMessages[i].content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const idx = globalToolIdMap.get(block.tool_use_id);
              if (idx !== undefined && globalToolCalls[idx]) {
                const outputText = getToolResultText(block);
                globalToolCalls[idx].output = outputText;
                globalToolCalls[idx].status = block.is_error ? "error" : "complete";
                updateFileChangeCard(globalToolCalls[idx], !!block.is_error);
              }
            }
          }
          i++;
        }

        const finalText = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.content || "")
          .join("\n")
          .trim();
        const hasThinking = blocks.some((b) => b.type === "thinking");

        const turnToolCalls = turnToolCallIndices.length > 0
          ? turnToolCallIndices.map((idx) => globalToolCalls[idx])
          : undefined;

        if (!finalText && !hasThinking && !turnToolCalls) continue;

        if (turnToolCallIndices.length > 0) {
          const globalToLocal = new Map<number, number>();
          turnToolCallIndices.forEach((gIdx, lIdx) => globalToLocal.set(gIdx, lIdx));
          for (const b of blocks) {
            if (b.type === "tool_call" && b.toolCallIdx !== undefined) {
              b.toolCallIdx = globalToLocal.get(b.toolCallIdx) ?? b.toolCallIdx;
            }
          }
        }

        this.messages.push({
          id: `assistant-turn-${this.messages.length}`,
          role: "assistant",
          content: finalText,
          toolCalls: turnToolCalls,
          blocks: blocks.length > 0 ? blocks : undefined,
          status: "complete" as const,
          timestamp: Date.now(),
          _realContent: true,
        } as ChatMessage & { _realContent: boolean });
      }
    }

    // Collect file changes from reconstructed tool calls so the sidebar
    // Changes panel reflects the loaded session (mirrors loadHistory).
    for (const tc of globalToolCalls) {
      if (tc.fileChange) this.appendFileChange(tc.fileChange);
    }
    this.backfillSessionFileDiffs(globalToolCalls);
    this.refreshChangesPanel();

    // ── Restore Work state from tool calls (checklist + strategy) ──
    // When viewing a saved session, the SSE event stream is not replaying,
    // so checklist / strategy must be reconstructed from the tool call inputs.
    // The tool output is just a text confirmation; the real data is in tc.input.
    let workRestored = false;
    for (let ti = globalToolCalls.length - 1; ti >= 0; ti--) {
      const tc = globalToolCalls[ti];
      if (!tc.input || Object.keys(tc.input).length === 0) continue;
      // Restore checklist from the last checklist_write (full state replacement)
      if (!workRestored && tc.name === "checklist_write") {
        const todos = tc.input.todos;
        if (Array.isArray(todos)) {
          const items = (todos as Array<Record<string, unknown>>).map((t, idx) => ({
            id: String(idx + 1),
            content: (t.content || "") as string,
            status: (t.status || "pending") as string,
          }));
          if (items.length > 0) {
            this.checklistItems = items;
            const done = items.filter(it => it.status === "completed").length;
            this.checklistCompletionPct = Math.round((done / items.length) * 100);
            workRestored = true;
          }
        }
      }
      // Restore strategy from the last update_plan
      if (tc.name === "update_plan") {
        const plan = tc.input.plan;
        if (Array.isArray(plan)) {
          this.strategySteps = (plan as Array<Record<string, unknown>>)
            .filter(s => typeof s.step === "string")
            .map(s => ({
              text: (s.step as string),
              status: (s.status || "pending") as string,
            }));
        }
      }
    }
    this.refreshWorkPanel();

    const msgCount = this.messages.length;
    const costUsd = session.metadata.cost?.session_cost_usd ?? 0;
    const costStr = costUsd > 0 ? ` | $${costUsd.toFixed(2)}` : "";
    const modelStr = session.metadata.model ? ` | ${session.metadata.model}` : "";

    this.postMessage({ type: "loadHistory", messages: this.messages, compactMode: true });
    this.postMessage({
      type: "status",
      text: `Viewing: ${title.slice(0, 50)}${msgCount ? ` (${msgCount} msgs${costStr}${modelStr})` : ""}`
    });
    this.postMessage({
      type: "info",
      message: `Viewing session: ${title.slice(0, 80)}\n${msgCount} messages | ${session.metadata.total_tokens.toLocaleString()} tokens${costStr}${modelStr}\n\nStart typing to resume this session and continue the conversation.`
    });
    this.postMessage({ type: "sessionLoaded", sessionId: session.metadata.id });
    // The Work panel's goal slot is thread-scoped and this view has no thread
    // yet, so it is re-pushed here the way the new-chat path does it: the slot
    // is reset by the sessionLoaded handler, and this replaces the previous
    // thread's goal with the session's own state (no goal, plus any background
    // goals still running).
    void this.refreshGoal();

    // Reflect the session's recorded stats so the stats bar doesn't keep
    // stale chips from the previously viewed thread. Cost metadata written
    // by TUI's runtime-API save endpoint is zero (it snapshots
    // messages/tokens but drops cost), so sessions with tokens but no
    // recorded cost render "—" in sendSessionStats instead of a fake
    // "<$0.0001". Input/output split is not recorded per session, so the
    // ↑/↓ chips stay hidden in view mode (totals appear in the info line).
    const viewCost = session.metadata.cost;
    this.sessionCostUsd = viewCost?.session_cost_usd || 0;
    this.sessionCostCny = viewCost?.session_cost_cny || 0;
    this.displayedCostHighWaterUsd = Math.max(
      viewCost?.displayed_cost_high_water_usd || 0,
      viewCost?.session_cost_usd || 0,
    );
    this.displayedCostHighWaterCny = Math.max(
      viewCost?.displayed_cost_high_water_cny || 0,
      viewCost?.session_cost_cny || 0,
    );
    this.totalTokens = session.metadata.total_tokens || 0;
    this.sendSessionStats();
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      this.debugLog(`loadSessionMessages error: ${errorMsg}`);

      // Provide user-friendly error messages for common errors
      if (errorMsg.includes("404") || errorMsg.includes("not found")) {
        this.postMessage({
          type: "error",
          message: `Session not found. This session may have been deleted or is from a different workspace.\n\nSession ID: ${sessionId.slice(0, 8)}...`,
        });
        // Refresh session list to show current state
        this.refreshSessionList();
      } else if (errorMsg.includes("500") || errorMsg.includes("internal")) {
        this.postMessage({
          type: "error",
          message: `Server error while loading session. Please try again later.`,
        });
      } else {
        this.postMessage({
          type: "error",
          message: formatError("Failed to load session", err),
        });
      }

      // Reset state on error
      this.cleanup();
      this.postMessage({ type: "clearChat" });
    }
  }

  /** Forget the session binding this client is holding, because the thread it
   *  belongs to must not be saved under it.
   *
   *  `PUT /v1/sessions` makes the stored document match the saving thread's
   *  engine — it rewrites the transcript — so two threads must never write one
   *  document. Two of them otherwise would: a thread the runtime just created is
   *  empty and owns no session yet (the id still held belongs to the thread it
   *  replaced), and a fork's history is a prefix of the thread it came from, so
   *  *that* thread's document is the one thing it must not overwrite. Adopting a
   *  binding is `loadThread`'s job — never an inference from whatever id happened
   *  to be around. */
  private forgetSessionBinding(): void {
    this.currentSessionId = null;
  }

  private async loadThread(threadId: string): Promise<void> {
    // Switching parks the outgoing thread instead of interrupting it: the
    // runtime keeps the turn running server-side and the background watcher
    // keeps its badges/notifications alive (upstream web client behaviour).
    this.parkCurrentThread();
    // The thread we are about to view is no longer background: drop the
    // watcher it may still have, or its stream keeps delivering the same
    // events a second time (duplicate notifications, duplicate auto-saves).
    this.stopBackgroundWatch(threadId);
    this.backgroundThreads.delete(threadId);
    this.sessionState.reset();

    try {
      this.currentThread = await this.api.getThread(threadId);

      // If the thread's workspace doesn't match the current workspace,
      // update it so the engine operates on the current workspace's files
      // and events flow correctly through the current engine.
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (currentWorkspace && this.currentThread.workspace !== currentWorkspace) {
        const oldWorkspace = this.currentThread.workspace;
        try {
          const updatedThread = await this.api.updateThread(threadId, {
            workspace: currentWorkspace,
          });
          this.currentThread = mergeThreadRecord(this.currentThread, updatedThread, {
            workspace: currentWorkspace,
          });
          this.postMessage({
            type: "info",
            message: `Thread workspace updated: ${oldWorkspace} → ${currentWorkspace}`,
          });
        } catch {
          // Non-critical: the turn may still work with the old workspace
          this.postMessage({
            type: "info",
            message: `Thread workspace (${oldWorkspace}) differs from current (${currentWorkspace}). Continuing may redirect output to the original workspace.`,
          });
        }
      }

      // The runtime owns the thread → session binding and this record is the
      // only place a client can read it. Adopting it keeps auto-save an update
      // of the conversation's own document: without it the next completed turn
      // saves with no session id, the runtime mints a second document for the
      // same history, and the one this thread was bound to is left behind.
      // Every path that establishes `currentThread` has to read it from here.
      this.currentSessionId = this.currentThread.session_id ?? null;

      await this.loadHistory(threadId);
      this.subscribeToEvents();
      this.postMessage({
        type: "threadLoaded",
        thread: this.currentThread,
        messages: this.messages,
      });
      // threadLoaded carries the thread itself, but nothing reads mode or
      // permission out of it, so the chips would otherwise keep naming the
      // thread we just left. Every switch lands here — the Threads rail, a
      // resumed session, undo's and retry's forked threads — which makes this
      // the one place the change has to be published.
      this.postCurrentSettings();
      this.postMessage({
        type: "status",
        text: `Thread ${threadId.slice(0, 12)}: ${this.messages.length} messages`,
      });
      // Refresh sidebar task/agent lists for the new thread before returning
      // so the webview and tests observe a stable post-load state.
      await Promise.allSettled([
        this.refreshTaskList(),
        this.refreshAgentRuns(),
      ]);
      // Push current work/changes state for this thread
      this.refreshWorkPanel();
      // Push the thread-scoped goal (or null) for the newly loaded thread.
      void this.refreshGoal();
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to load thread", err),
      });
    }
  }

  // ── User actions ──

  private static readonly MEDIA_EXTENSIONS: Record<string, string> = {
    ".png": "image", ".jpg": "image", ".jpeg": "image",
    ".gif": "image", ".webp": "image", ".bmp": "image",
    ".tif": "image", ".tiff": "image", ".ppm": "image",
    ".mp4": "video", ".mov": "video", ".m4v": "video",
    ".webm": "video", ".avi": "video", ".mkv": "video",
  };

  public async handleAttachFile(): Promise<void> {
    try {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: t().attachFiles,
        title: t().attachFiles,
      });
      if (!uris || uris.length === 0) return;

      let attached = false;
      for (const uri of uris) {
        // Isolation per path: one unreadable entry (a stat that fails with
        // something other than ENOENT) must not cost the user the rest of
        // the selection.
        try {
          attached = this.attachPathAsAttachment(uri.fsPath) || attached;
        } catch (err) {
          this.postMessage({
            type: "error",
            message: formatError("Failed to attach file", err),
          });
        }
      }

      // Reached even when a path throws, so the webview and the host can never
      // disagree about what the next send will carry.
      if (attached) {
        this.postAttachmentsChanged();
      }
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to attach file", err),
      });
    }
  }

  /**
   * Publish the current attachment list to the webview.
   *
   * The list carries no previewUrl. A 5 MiB image is a ~6.7 MiB base64 string
   * and this list is re-published on every add / remove / send, so re-sending
   * those bytes each time would push megabytes through postMessage to rebuild
   * a 44px thumbnail the webview already has. Previews travel once, in their
   * own message; see announceAttachmentPreview.
   */
  private postAttachmentsChanged(): void {
    this.postMessage({
      type: "attachmentsChanged",
      attachments: this.currentAttachments.map((att) => ({
        id: att.id,
        kind: att.kind,
        path: att.path,
        name: att.name,
      })),
    });
  }

  /** Hand the webview one thumbnail payload, keyed by attachment id. Sent when
   *  the attachment is created — and again on webview reload, where the
   *  webview's cache is gone. Never sent as part of the list. */
  private announceAttachmentPreview(att: AttachmentRecord): void {
    if (!att.previewUrl) return;
    this.postMessage({
      type: "attachmentPreview",
      id: att.id,
      previewUrl: att.previewUrl,
    });
  }

  /** Re-announce every live thumbnail, for a webview that just reloaded and
   *  therefore has an empty preview cache. */
  private reannounceAttachmentPreviews(): void {
    for (const att of this.currentAttachments) {
      this.announceAttachmentPreview(att);
    }
  }

  /**
   * Attach one path as an attachment record. Image-kind paths are validated
   * here at attach time — TUI /attach parity (contract.rs attach_media →
   * image_attach.rs): empty, oversized (>5 MiB) or bytes that sniff to none
   * of PNG/JPEG/GIF/WebP are refused up front with the shared image errors,
   * instead of failing in-band at send time (expand_attachment_blocks).
   * Failures post their own error and return false; callers must not add a
   * second message. Video and plain files carry no content restrictions
   * (the engine reads them via the @path mention).
   */
  private attachPathAsAttachment(filePath: string, displayName?: string): boolean {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      this.postMessage({ type: "error", message: t().fileNotSupported });
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    const kind = ChatProvider.MEDIA_EXTENSIONS[ext] ?? "file";
    const record: AttachmentRecord = {
      id: this.nextAttachmentId(),
      kind,
      path: filePath,
      name: displayName ? path.basename(displayName) : path.basename(filePath),
    };
    if (kind === "image") {
      if (stat.size > ChatProvider.MAX_INLINE_IMAGE_BYTES) {
        this.postMessage({ type: "error", message: t().imagePasteTooLarge });
        return false;
      }
      // A missing preview means the bytes failed the magic-byte sniff:
      // BMP/TIFF/SVG/renamed files or empty/corrupt content (readImage-
      // PreviewDataUrl re-stats and re-reads under the same 5 MiB bound).
      const previewUrl = this.readImagePreviewDataUrl(filePath);
      if (!previewUrl) {
        this.postMessage({ type: "error", message: t().imagePasteUnsupported });
        return false;
      }
      record.previewUrl = previewUrl;
    }
    this.currentAttachments.push(record);
    // Announced before the caller publishes the list, so the webview's cache
    // is populated by the time it renders the chip.
    this.announceAttachmentPreview(record);
    return true;
  }

  private nextAttachmentId(): string {
    this.attachmentSeq += 1;
    return `att-${this.attachmentSeq}`;
  }

  /** Best-effort data-URL thumbnail for an image file; undefined when the
   *  file is unreadable, oversized, or not a sniffable image. Preview only —
   *  the engine re-validates at expansion time regardless. */
  private readImagePreviewDataUrl(filePath: string): string | undefined {
    try {
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile() || stat.size > ChatProvider.MAX_INLINE_IMAGE_BYTES) return undefined;
      const bytes = fs.readFileSync(filePath);
      const mime = sniffImageMime(bytes);
      return mime ? `data:${mime};base64,${bytes.toString("base64")}` : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Attach one or more local paths referenced by uri-list / text drops from
   * the editor. Mirrors the normal file picker flow so drag-and-drop and the
   * attach button share the same attachment model. Per-file failures (missing
   * file, invalid image) are reported by attachPathAsAttachment itself.
   */
  private handleAttachPaths(uris: string[]): void {
    let attached = false;
    for (const uri of uris) {
      if (typeof uri !== "string" || !uri.trim()) continue;
      // Isolation per path: one bad entry (a stat that fails with something
      // other than ENOENT, a malformed file: URI) must not cost the user the
      // rest of the drop.
      try {
        // file: URIs arrive from uri-list drops; bare paths from text drops.
        // A home-relative path is accepted by the webview's text heuristic,
        // so expand it here — fs.statSync does not.
        const filePath = uri.startsWith("file:")
          ? vscode.Uri.parse(uri).fsPath
          : uri.startsWith("~/")
            ? path.join(os.homedir(), uri.slice(2))
            : uri;
        attached = this.attachPathAsAttachment(filePath) || attached;
      } catch (err) {
        this.postMessage({
          type: "error",
          message: formatError("Failed to attach dropped file", err),
        });
      }
    }
    // Reached even when a path throws, so the webview and the host can never
    // disagree about what the next send will carry.
    if (attached) {
      this.postAttachmentsChanged();
    }
  }

  /** Inline image mimes accepted from paste/drop, mirroring the TUI's sniff
   *  list in image_attach.rs (PNG/JPEG/GIF/WebP only). */
  private static readonly INLINE_IMAGE_EXTS: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };

  /** Per-image ceiling shared with TUI image_attach.rs MAX_IMAGE_BYTES. */
  private static readonly MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

  /**
   * Persist a pasted/dropped image and register it as an attachment.
   *
   * TUI clipboard.rs parity: bytes land in ~/.codewhale/clipboard-images/
   * under a generated name, then flow through the existing
   * `[Attached image: <path>]` placeholder the engine expands into
   * ContentBlock::ImageUrl blocks. Validation (magic-byte sniff + 5 MiB)
   * matches image_attach.rs so failures surface here, before the turn is
   * sent, instead of as an in-band notice after it.
   */
  private async handleAttachImageInline(mime: string, dataUrl: string, name?: string): Promise<void> {
    try {
      const ext = ChatProvider.INLINE_IMAGE_EXTS[mime];
      const marker = `data:${mime};base64,`;
      if (!ext || !dataUrl.startsWith(marker)) {
        this.postMessage({ type: "error", message: t().imagePasteUnsupported });
        return;
      }
      const bytes = Buffer.from(dataUrl.slice(marker.length), "base64");
      if (bytes.length === 0 || !imageBytesMatchMime(bytes, mime)) {
        this.postMessage({ type: "error", message: t().imagePasteInvalid });
        return;
      }
      if (bytes.length > ChatProvider.MAX_INLINE_IMAGE_BYTES) {
        this.postMessage({ type: "error", message: t().imagePasteTooLarge });
        return;
      }
      const dir = path.join(os.homedir(), ".codewhale", "clipboard-images");
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `clipboard-${Date.now()}-${Math.floor(Math.random() * 1e4)}${ext}`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, bytes);
      // Display the original name (drag & drop), fall back to the stored one.
      const displayName = name ? path.basename(name) : fileName;
      const record: AttachmentRecord = {
        id: this.nextAttachmentId(),
        kind: "image",
        path: filePath,
        name: displayName,
        // The incoming data URL is already the exact preview payload.
        previewUrl: dataUrl,
      };
      this.currentAttachments.push(record);
      this.announceAttachmentPreview(record);
      this.postAttachmentsChanged();
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to attach image", err),
      });
    }
  }

  /** Transport cap for blob drops serialised through postMessage; the
   *  attach-file button has no cap because it references paths directly. */
  private static readonly MAX_DROPPED_FILE_BYTES = 50 * 1024 * 1024;

  /**
   * Persist a dropped OS file (Finder / Explorer) and register it as a file
   * attachment. Webview drops carry bytes, not paths, so the blob lands in
   * ~/.codewhale/dropped-files/ under a sanitized name and re-enters the
   * same @<path> mention the attach-file button produces. Mirrors the
   * clipboard-image flow above.
   */
  private handleAttachFileBlob(name: string | undefined, dataUrl: string): void {
    try {
      const marker = ";base64,";
      const idx = typeof dataUrl === "string" ? dataUrl.indexOf(marker) : -1;
      if (idx < 0) {
        this.postMessage({ type: "error", message: t().fileNotSupported });
        return;
      }
      const bytes = Buffer.from(dataUrl.slice(idx + marker.length), "base64");
      if (bytes.length === 0) {
        this.postMessage({ type: "error", message: t().fileNotSupported });
        return;
      }
      if (bytes.length > ChatProvider.MAX_DROPPED_FILE_BYTES) {
        this.postMessage({ type: "error", message: t().fileDropTooLarge });
        return;
      }
      const dir = path.join(os.homedir(), ".codewhale", "dropped-files");
      fs.mkdirSync(dir, { recursive: true });
      const safeName = ((name || "").split("/").pop() || "")
        .replace(/[^\w.-]+/g, "_")
        .slice(-80);
      const fileName = `dropped-${Date.now()}-${Math.floor(Math.random() * 1e4)}${safeName ? "-" + safeName : ""}`;
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, bytes);
      // Display the original name (drag & drop), fall back to the stored one.
      if (this.attachPathAsAttachment(filePath, name ? path.basename(name) : fileName)) {
        this.postAttachmentsChanged();
      }
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to attach dropped file", err),
      });
    }
  }

  private handleRemoveAttachment(index: number): void {
    if (index >= 0 && index < this.currentAttachments.length) {
      this.currentAttachments.splice(index, 1);
      this.postAttachmentsChanged();
    }
  }

  private async handleSendMessage(text: string): Promise<void> {
    if (!text.trim() && this.currentAttachments.length === 0) return;

    const attachments = [...this.currentAttachments];
    this.currentAttachments = [];
    this.postAttachmentsChanged();

    // The optimistic user bubble is created inside the try block below, but a
    // refusal has to retract that exact bubble by id — so the id is minted
    // here, where the catch can still see it.
    const userMsgId = `user-${Date.now()}`;

    let fullText = text;
    if (attachments.length > 0) {
      const attachmentLines = attachments.map((a) => {
        if (a.kind === "file") {
          return `@${a.path}`;
        }
        return `[Attached ${a.kind}: ${a.path}]`;
      });
      if (fullText.trim()) {
        fullText = fullText.trimEnd() + "\n" + attachmentLines.join("\n");
      } else {
        fullText = attachmentLines.join("\n");
      }
    }

    try {
      await this.api.ensureReady();

      if (this.viewingSessionId) {
        await this.resumeViewedSession(this.viewingSessionId);
      }

      if (!this.currentThread) {
        const cfg = vscode.workspace.getConfiguration("brotherwhale");
        // The route, not just the model: a new thread is created for the
        // provider the picker is on, and the model remembered for that
        // provider. Sending the model alone let the runtime pair it with
        // whichever provider was active — `deepseek-flash` under the Zhipu
        // route answered `400 模型不存在`.
        const route = this.newThreadRoute();
        const mode = normalizeMode(cfg.get<string>("defaultMode", "agent"));
        const posture = this.getCurrentPosture();
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const autoApprove = posture === "full_access" || cfg.get<boolean>("autoApprove", false);
        this.currentThread = await this.api.createThread({
          model: route.model,
          model_provider: route.model_provider,
          model_provider_id: route.model_provider_id,
          mode,
          workspace,
          permission_posture: POSTURE_WIRE[posture],
          auto_approve: autoApprove,
          trust_mode: posture === "full_access",
        });
        this.forgetSessionBinding();
        this.subscribeToEvents();
        this.refreshSessionList();
        this.postCurrentSettings();
      }

      this.activeItems.clear();
      this.currentTextBlockIdx = -1;
      this.currentThinkingBlockIdx = -1;
      this.turnFileChanges = [];

      const userMsg: ChatMessage = {
        id: userMsgId,
        role: "user",
        content: fullText,
        status: "complete",
        timestamp: Date.now(),
      };
      this.messages.push(userMsg);
      this.postMessage({ type: "addMessage", message: userMsg });

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        status: "streaming",
        timestamp: Date.now(),
        toolCalls: [],
        blocks: [],
      };
      this.messages.push(assistantMsg);
      this.postMessage({ type: "addMessage", message: assistantMsg });

      // Verify current thread is still valid (may have been deleted)
      let threadOk = true;
      try { await this.api.getThread(this.currentThread.id); } catch { threadOk = false; }
      if (!threadOk) {
        // The engine no longer has this thread (an empty thread is discarded,
        // a cleared runtime store loses it). This is a *recovery* of the
        // conversation the user is already in, so it must carry that thread's
        // mode and permission: rebuilding from the startup defaults would
        // silently re-mode and re-permission a conversation the user had
        // already configured. The chips are republished below, so they follow
        // whatever this recovery produces instead of disagreeing with it.
        const replaced = this.currentThread;
        const mode = normalizeMode(replaced.mode);
        const posture = postureFromThread(replaced);
        // The recovery keeps the conversation's own route, not the picker's:
        // a thread that was running on `bigmodel-cn` must come back on
        // `bigmodel-cn` even if the picker has since moved on.
        const route = this.threadRoute(replaced);
        this.currentThread = await this.api.createThread({
          model: route.model,
          model_provider: route.model_provider,
          model_provider_id: route.model_provider_id,
          mode,
          workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          permission_posture: POSTURE_WIRE[posture],
          // Derived from the posture, like every other create site: the engine
          // reads `auto_approve` only when no posture is given, and never reads
          // `trust_mode` at all, so copying the replaced record's bits would
          // carry dead state — including the `trust_mode` + non-full posture
          // pairing that already cost this surface an approval bug.
          auto_approve: posture === "full_access",
          trust_mode: posture === "full_access",
        });
        this.forgetSessionBinding();
        this.subscribeToEvents();
        this.refreshSessionList();
        this.postCurrentSettings();
      }

      // Ensure thread workspace matches current workspace before starting turn
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (currentWorkspace && this.currentThread.workspace !== currentWorkspace) {
        try {
          const updatedThread = await this.api.updateThread(this.currentThread.id, {
            workspace: currentWorkspace,
          });
          this.currentThread = mergeThreadRecord(this.currentThread, updatedThread, {
            workspace: currentWorkspace,
          });
        } catch { /* non-critical */ }
      }

      const cfg = vscode.workspace.getConfiguration("brotherwhale");
      const reasoningEffort = cfg.get<string>("reasoningEffort", "auto");
      const mode = normalizeMode(this.currentThread.mode);
      const model = this.currentThread.model;
      // Use the thread's persisted permission posture / auto_approve /
      // trust_mode instead of the config defaults.  When the user approves with
      // "remember", the TUI flips thread.auto_approve to true
      // (remember_thread_auto_approve) and the GUI mirrors that in
      // handleApprovalDecision.  Sending the config value (typically false)
      // here would override the thread's persisted state on every new turn,
      // causing "remember" to silently revert and re-prompting for approvals
      // the user already granted — which then surface as "Request cancelled
      // while awaiting approval" when the turn is interrupted.  The explicit
      // posture is what keeps a non-full-access posture (e.g. Auto-Review) from
      // being re-derived to Ask by the auto_approve compatibility input.
      const result = await this.api.startTurn(this.currentThread.id, fullText, {
        mode,
        model,
        reasoning_effort: reasoningEffort,
        permission_posture: POSTURE_WIRE[postureFromThread(this.currentThread)],
        auto_approve: this.currentThread.auto_approve,
        trust_mode: this.currentThread.trust_mode,
      });
      this.currentTurnId = result.turn.id;
      this.activeTurnMode = { turnId: result.turn.id, mode };
      this.postMessage({ type: "turnStarted", turnId: result.turn.id });
    } catch (err) {
      // A thread that already has a turn running is a state to recover from
      // rather than a send to report as failed: the prompt was refused
      // *because* there is a turn to stop, and stopping it is what unblocks
      // the user. See `recoverRefusedSend`.
      const recovered =
        this.isActiveTurnRefusal(err) &&
        (await this.recoverRefusedSend(userMsgId, text, attachments));
      if (recovered) return;
      this.postMessage({
        type: "error",
        message: formatError("Failed to send message", err),
      });
    }
  }

  /** The mode a turn ran in. The runtime records it on the turn itself, which
   *  is the only source that also answers for turns this client did not start
   *  (a retry, a background kickoff, a thread adopted mid-turn); the mode
   *  recorded here when the turn was started stands in for runtimes that
   *  predate the field, and the thread's mode for turns it never started. */
  private turnMode(turn: { id?: string; mode?: string | null } | undefined): TuiMode {
    if (turn?.mode) return normalizeMode(turn.mode);
    if (turn?.id && this.activeTurnMode?.turnId === turn.id) return this.activeTurnMode.mode;
    return normalizeMode(this.currentThread?.mode);
  }

  /** The message a rebuilt conversation should hang the plan-approval action on:
   *  the last one, when it is a finished assistant turn and the turn that
   *  produced it ran in plan mode. Without this the action only exists on the
   *  live turn-complete event, so reopening the thread silently loses it while
   *  the plan it belongs to is still the last thing in the conversation. */
  private planApprovalTargetId(mode: TuiMode): string | undefined {
    if (mode !== "plan") return undefined;
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant" || last.status !== "complete") return undefined;
    return last.id;
  }

  /** Steer the active turn: append mid-turn user guidance without starting a
   *  new turn (mirrors TUI's steering input via POST /threads/{id}/turns/{turn_id}/steer).
   *  TUI parity (dispatch.rs steer_user_message): call the engine first and
   *  only touch the transcript on success; flush the streaming assistant
   *  segment so the steer bubble interrupts it, and route subsequent output
   *  to a fresh segment. The steered prompt is persisted server-side as a
   *  user_message item on the turn, so loadHistory renders it after reload. */
  private async handleSteer(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const thread = this.currentThread;
    const turnId = this.currentTurnId;
    if (!thread || !turnId) {
      this.postMessage({ type: "error", message: t().steerNoActiveTurn });
      return;
    }
    if (!this.apiCapabilities.turnSteer) {
      this.postMessage({ type: "error", message: t().steerUnsupported });
      return;
    }

    // TUI parity (dispatch.rs steer_user_message): the engine is called
    // FIRST and the transcript is only touched on success — on failure the
    // TUI restores state and surfaces the error without visual changes.
    // The engine rejects steering when the turn is stopping (interrupt
    // requested) or already finished.
    try {
      await this.api.steerTurn(thread.id, turnId, trimmed);
    } catch (err) {
      // The engine refused the guidance — a turn that moved on, a turn that is
      // stopping, a lost connection. The webview cleared the box the moment
      // the text left it, so the words go back where they came from: TUI
      // parity (`dispatch.rs` restores the failed steer plus anything
      // unattempted, "so nothing is lost"), and the same recovery a refused
      // send already gets. The steer button re-arms with the restored text.
      this.restoreComposerText(trimmed);
      this.postMessage({
        type: "error",
        message: formatError(t().steerFailed, err),
      });
      return;
    }

    const steerMsg: ChatMessage = {
      id: `user-steer-${Date.now()}`,
      role: "user",
      content: trimmed,
      status: "complete",
      timestamp: Date.now(),
      steered: true,
    };
    // Display-only: do NOT push into this.messages. The SSE router keys
    // item deltas and turn completion off this.messages[last] being the
    // streaming assistant message — appending a user message mid-turn
    // hijacks that routing (AI output invisible, streaming never cleared).
    // The steered prompt is persisted server-side as a user_message item
    // on the turn, so loadHistory restores it after any reload.
    this.postMessage({ type: "addMessage", message: steerMsg });

    // Interruption semantics (TUI parity, dispatch.rs steer_user_message):
    // flush_active_cell() commits the streaming content so the steer bubble
    // appears below what chronologically preceded it — but an EMPTY active
    // cell is discarded, not finalized. Same here: a streaming placeholder
    // with no content yet (steer raced the first delta, or a double-steer)
    // is removed instead of left as an empty bubble.
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant" && lastMsg.status === "streaming") {
      const isEmpty = !lastMsg.content && !lastMsg.thinking
        && !(lastMsg.toolCalls && lastMsg.toolCalls.length > 0)
        && !(lastMsg.blocks && lastMsg.blocks.length > 0);

      if (isEmpty) {
        this.messages.pop();
        this.postMessage({ type: "removeMessage", messageId: lastMsg.id });
      } else {
        lastMsg.status = "complete";
        this.postMessage({ type: "messageComplete", messageId: lastMsg.id });
        // activeItems is intentionally kept: tool calls started before the
        // steer still route their item.completed updates to the old segment.
      }

      // New segment starts fresh blocks (text/thinking indices reset).
      this.currentTextBlockIdx = -1;
      this.currentThinkingBlockIdx = -1;

      const nextMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: "",
        status: "streaming",
        timestamp: Date.now(),
        toolCalls: [],
        blocks: [],
      };
      this.messages.push(nextMsg);
      this.postMessage({ type: "addMessage", message: nextMsg });
    }
  }

  private async handleNewThread(): Promise<void> {
    // A running turn keeps running server-side; park it for the watcher
    // instead of clearing it with the view.
    this.parkCurrentThread();
    this.sessionState.reset();
    this.postMessage({ type: "clearChat" });
    // clearChat resets the conversation, not the mode and permission chips, so
    // they would otherwise keep showing the thread that was just cleared. With
    // no active thread this republishes the startup defaults — what the new
    // thread actually inherits, which is what the chips should describe.
    this.postCurrentSettings();
    // Clear stale sidebar data
    this.postMessage({ type: "taskList", tasks: [] });
    this.postMessage({ type: "agentRunList", runs: [] });
    void this.refreshGoal();
  }

  /** Auto-save the current thread as a session after each completed turn.
   *  Same thread → same session (via PUT with session_id), mirroring TUI's
   *  build_session_snapshot → SessionSnapshot persistence flow. */
  private async autoSaveSession(): Promise<void> {
    // Prevent concurrent saves.  When multiple turn.completed events fire
    // in quick succession (e.g. SSE reconnection replay) and
    // currentSessionId is still null, each concurrent call would create a
    // new session on the server, producing duplicates.
    if (this.autoSaveInProgress) {
      this.debugLog("[autoSaveSession] Save already in progress, skipping");
      return;
    }
    const thread = this.currentThread;
    if (!thread) {
      this.debugLog("[autoSaveSession] No current thread, skipping");
      return;
    }
    if (!this.apiCapabilities.saveSession) {
      this.debugLog("[autoSaveSession] saveSession capability not available, skipping");
      return;
    }
    this.autoSaveInProgress = true;
    try {
      this.debugLog(`[autoSaveSession] Saving thread ${thread.id} with sessionId=${this.currentSessionId}`);
      const result = await this.api.saveCurrentSession(thread.id, this.currentSessionId ?? undefined);
      this.currentSessionId = result.session_id;
      this.debugLog(`[autoSaveSession] Saved successfully, sessionId=${result.session_id}`);
    } catch (err) {
      this.debugLog(`[autoSaveSession] Failed: ${err instanceof Error ? err.message : String(err)}`);
      // Auto-save is best-effort; don't disrupt the UI on failure.
    } finally {
      this.autoSaveInProgress = false;
    }
  }

  /** Refresh the session list shown in the sidebar */
  public async refreshSessionList(): Promise<void> {
    const fetchAndSend = async () => {
      const result = await this.api.listSessions({ limit: 100 });
      let sessions = result.sessions || [];
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!this.showAllWorkspaces && currentWorkspace) {
        sessions = sessions.filter(s => s.workspace === currentWorkspace);
      }
      // Defensive: the backend can return the same session id multiple times
      // (e.g. when both TUI auto-save and an explicit /save fire for the same
      // thread). When duplicates collide, keep the record with the most recent
      // updated_at so the sidebar shows the latest snapshot, not a stale one.
      const latestById = new Map<string, typeof sessions[number]>();
      for (const s of sessions) {
        if (!s || !s.id) continue;
        const prev = latestById.get(s.id);
        if (!prev || (s.updated_at && (!prev.updated_at || s.updated_at > prev.updated_at))) {
          latestById.set(s.id, s);
        }
      }
      const deduped = Array.from(latestById.values());
      this.postMessage({ type: "sessionList", sessions: deduped, showAllWorkspaces: this.showAllWorkspaces });
    };
    try {
      await fetchAndSend();
    } catch {
      setTimeout(async () => {
        try { await fetchAndSend(); } catch { /* silent */ }
      }, 2000);
    }
  }

  /** Refresh the thread list shown in the sidebar. Also drives the background
   *  watcher reconciliation (threads with running turns / pending attention
   *  get a lightweight SSE stream) and the toolbar Agent badge total. */
  private async refreshThreadList(quiet = false): Promise<void> {
    // A quiet pass exists to discover attention nothing is watching yet. It
    // must never take the rail over from a refresh that will publish, so it
    // yields to one already in flight.
    if (quiet && this.threadListFetchInFlight) return;
    const token = ++this.threadListRefreshToken;
    // The fetch below takes seconds-to-tens-of-seconds on a large store. A
    // silent wait behind an empty rail reads as "you have no threads", so the
    // rail is told a fetch is in flight and can say so. A quiet pass stays off
    // the rail entirely: it is a discovery sweep, not a repaint.
    if (!quiet) this.postMessage({ type: "threadListLoading", loading: true });

    this.threadListFetchInFlight = true;
    let threads: ThreadSummary[] | null;
    try {
      threads = await this.fetchThreadSummaries(token);
    } finally {
      this.threadListFetchInFlight = false;
    }
    // A newer refresh owns the rail now; let it publish instead.
    if (token !== this.threadListRefreshToken) return;
    if (threads === null) {
      // Never fail to silence again: an unexplained empty rail is
      // indistinguishable from a dead panel. The rail offers a manual retry.
      // A quiet pass has nothing to report to, so it just tries again later.
      if (!quiet) this.postMessage({ type: "threadListLoading", loading: false, failed: true });
      return;
    }

    this.threadTitles.clear();
    for (const s of threads) {
      if (s.title) this.threadTitles.set(s.id, s.title);
    }
    try {
      this.syncBackgroundWatchers(threads);
    } catch (err) {
      // A watcher problem must not cost the user the list itself, which is
      // exactly what the shared silent catch used to do.
      this.debugLog(`syncBackgroundWatchers failed: ${getErrorMessage(err)}`);
    }
    if (quiet) return;
    // The list is the whole story: the rail and the toolbar's Agent chip both
    // count attention off these summaries themselves (excluding the thread on
    // screen, whose cards are inline), so a second total computed here could
    // only ever disagree with what that chip says is waiting.
    this.postMessage({
      type: "threadList",
      threads,
      showAllWorkspaces: this.showAllWorkspaces,
    });
  }

  /**
   * Fetch the thread summaries for one refresh.
   *
   * Returns `null` when the fetch failed after its one transient retry, or
   * when a newer refresh superseded this one (the caller distinguishes the two
   * by the token). The per-call timeout is deliberately not the client default:
   * `GET /v1/threads/summary` cost 25.4s against a 72-thread / 189MB store
   * (measured 2026-09-17), which sat inside a 30s default and crossed it as
   * soon as a turn was writing to the store.
   */
  private async fetchThreadSummaries(token: number): Promise<ThreadSummary[] | null> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= ChatProvider.THREAD_LIST_ATTEMPTS; attempt++) {
      try {
        return await this.api.listThreadsSummary({
          limit: 100,
          timeoutMs: ChatProvider.THREAD_SUMMARY_TIMEOUT_MS,
        });
      } catch (err) {
        lastError = err;
        if (token !== this.threadListRefreshToken) return null;
        if (attempt >= ChatProvider.THREAD_LIST_ATTEMPTS || !isTransientFetchError(err)) break;
        // The engine is mid-restart; give it the same moment the next health
        // probe waits for before asking again.
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (token !== this.threadListRefreshToken) return null;
      }
    }
    this.debugLog(`refreshThreadList failed: ${getErrorMessage(lastError)}`);
    return null;
  }

  /** Delete a session with confirmation dialog */
  private async handleDeleteSession(sessionId: string, sessionTitle: string): Promise<void> {
    const confirmMsg = t().deleteSessionConfirmMessage.replace("{title}", sessionTitle || sessionId.slice(0, 8));
    const confirm = await vscode.window.showWarningMessage(
      t().deleteSessionConfirmTitle,
      { modal: true },
      confirmMsg,
    );
    if (confirm !== confirmMsg) return;
    try {
      await this.api.deleteSession(sessionId);
      // If the deleted session was the current one, clear the view
      if (this.viewingSessionId === sessionId) {
        this.viewingSessionId = null;
        this.messages = [];
        this.postMessage({ type: "clearChat" });
        this.postMessage({ type: "status", text: "Ready" });
      }
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
      }
      await this.refreshSessionList();
      vscode.window.setStatusBarMessage(t().deleteSessionSuccess, 3000);
    } catch (err) {
      vscode.window.showErrorMessage(`${t().deleteSessionFailed}: ${getErrorMessage(err)}`);
    }
  }

  /** Search sessions by query and update the sidebar */
  private async handleSearchSessions(query: string): Promise<void> {
    try {
      const result = await this.api.listSessions({ limit: 100, search: query || undefined });
      let sessions = result.sessions || [];
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!this.showAllWorkspaces && currentWorkspace) {
        sessions = sessions.filter(s => s.workspace === currentWorkspace);
      }
      this.postMessage({ type: "sessionList", sessions, showAllWorkspaces: this.showAllWorkspaces });
    } catch {
      // best-effort
    }
  }

  /** Refresh the task list shown in the sidebar, scoped to the current workspace */
  public async refreshTaskList(): Promise<void> {
    try {
      const refreshToken = ++this.taskListRefreshToken;
      // Determine current workspace: VS Code folder first, then TUI fallback.
      const currentWorkspace =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.tuiWorkspace ?? undefined;
      const result = await this.api.listTasks({
        limit: 50,
        workspace: !this.showAllWorkspaces ? currentWorkspace : undefined,
      });
      // Backend handles workspace filtering; push raw list immediately.
      this.postMessage({ type: "taskList", tasks: result.tasks });
      // Enrichment (attention badges from thread detail) runs async.
      void this.enrichTaskList(result.tasks, refreshToken);
    } catch {
      // best-effort
    }
  }

  /** Enrich task list with pending-approval/input counts from thread details. */
  private async enrichTaskList(tasks: TaskSummary[], refreshToken: number): Promise<void> {
    try {
      const threadDetailCache = new Map<string, Promise<ThreadDetailResponse | null>>();
      const enriched = await Promise.all(
        tasks.map((task) => this.enrichTaskSummary(task, threadDetailCache))
      );
      if (refreshToken !== this.taskListRefreshToken) {
        return;
      }
      this.postMessage({ type: "taskList", tasks: enriched });
    } catch {
      // best-effort
    }
  }

  private async enrichTaskSummary(
    task: TaskSummary,
    threadDetailCache: Map<string, Promise<ThreadDetailResponse | null>>,
  ): Promise<TaskSummary> {
    if (!task.thread_id || this.isTerminalTaskStatus(task.status) || typeof this.api.getThreadDetail !== "function") {
      return task;
    }

    let detailPromise = threadDetailCache.get(task.thread_id);
    if (!detailPromise) {
      detailPromise = this.api.getThreadDetail(task.thread_id).catch(() => null);
      threadDetailCache.set(task.thread_id, detailPromise);
    }

    const threadDetail = await detailPromise;
    if (!threadDetail) {
      return task;
    }

    return {
      ...task,
      pending_approvals: threadDetail.pending_approvals || [],
      pending_user_inputs: threadDetail.pending_user_inputs || [],
    };
  }

  /** Refresh the agent runs list shown in the sidebar */
  public async refreshAgentRuns(): Promise<void> {
    try {
      const result = await this.api.listAgentRuns();
      this.postMessage({ type: "agentRunList", runs: result.runs });
    } catch {
      // best-effort — endpoint may not exist on older TUI versions
    }
  }

  // ── Fleet (managed multi-agent runs) ──

  /** Refresh the Fleet run list shown in the sidebar. */
  public async refreshFleetRuns(): Promise<void> {
    try {
      const result = await this.api.listFleetRuns();
      this.postMessage({ type: "fleetRunList", status: result.status, runs: result.runs });
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
      this.api.getFleetRun(runId),
      this.api.listFleetRunWorkers(runId),
      this.api.listFleetRunReceipts(runId),
    ]);
    return {
      run,
      workers: workersResp.workers,
      receipts: receiptsResp.receipts,
    };
  }

  /** Load a Fleet run's detail (workers + tasks + receipts) into the overlay,
   *  then subscribe to its live SSE event stream for real-time refreshes. */
  private async showFleetDetail(runId: string): Promise<void> {
    try {
      this.activeFleetRunId = runId;
      const payload = await this.fetchFleetDetailPayload(runId);
      this.postMessage({ type: "fleetRunDetail", ...payload });
      const status = (payload.run as { lifecycle_status?: string }).lifecycle_status;
      if (this.isTerminalFleetStatus(status)) {
        this.stopFleetEventStream();
      } else {
        this.startFleetEventStream(runId);
      }
    } catch (err) {
      if (this.activeFleetRunId === runId) {
        this.activeFleetRunId = null;
      }
      this.stopFleetEventStream();
      vscode.window.showErrorMessage(`Failed to load Fleet run: ${(err as Error).message}`);
    }
  }

  private handleCloseFleetDetail(): void {
    this.activeFleetRunId = null;
    this.stopFleetEventStream();
  }

  private async refreshActiveFleetDetail(): Promise<void> {
    if (!this.activeFleetRunId) return;
    try {
      const payload = await this.fetchFleetDetailPayload(this.activeFleetRunId);
      this.postMessage({ type: "fleetRunDetail", ...payload });
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
    if (this.fleetDetailRefreshTimer) return;
    this.fleetDetailRefreshTimer = setTimeout(() => {
      this.fleetDetailRefreshTimer = null;
      void this.refreshActiveFleetDetail();
    }, 400);
  }

  /** Subscribe to the run's live SSE stream. Falls back to a slow poll if the
   *  stream errors, so the overlay never silently freezes. */
  private startFleetEventStream(runId: string): void {
    this.stopFleetEventStream();
    this.fleetEventController = this.api.streamFleetEvents(
      runId,
      (event) => {
        // Forward the raw event to the webview for the live timeline, then
        // debounce a full detail refresh (workers/tasks/receipts).
        this.postMessage({ type: "fleetEvent", event });
        this.scheduleFleetDetailRefresh();
        void this.refreshFleetRuns();
      },
      () => {
        this.fleetEventController = null;
        this.startFleetDetailPollFallback();
      }
    );
  }

  private stopFleetEventStream(): void {
    this.fleetEventController?.abort();
    this.fleetEventController = null;
    if (this.fleetDetailRefreshTimer) {
      clearTimeout(this.fleetDetailRefreshTimer);
      this.fleetDetailRefreshTimer = null;
    }
    this.stopFleetDetailPollFallback();
  }

  private startFleetDetailPollFallback(): void {
    if (!this.activeFleetRunId || this.fleetDetailPollTimer) return;
    this.fleetDetailPollTimer = setInterval(() => {
      void this.refreshActiveFleetDetail();
    }, 3000);
  }

  private stopFleetDetailPollFallback(): void {
    if (this.fleetDetailPollTimer) {
      clearInterval(this.fleetDetailPollTimer);
      this.fleetDetailPollTimer = null;
    }
  }

  private async handleCreateFleetRun(
    req: CreateFleetRunRequest,
    startAfterCreate: boolean
  ): Promise<void> {
    try {
      const result = await this.api.createFleetRun(req);
      if (startAfterCreate && result.run?.id) {
        // TUI semantics: creation only queues the run; `/start` activates it.
        // The checkbox chains both steps so one click = one running fleet.
        try {
          await this.api.startFleetRun(result.run.id);
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

  private async handleRequestFleetProfiles(): Promise<void> {
    try {
      const resp = await this.api.listFleetProfiles();
      this.postMessage({
        type: "fleetProfiles",
        profiles: resp?.profiles ?? [],
        loadError: resp?.load_error ?? null,
      });
    } catch {
      // Older TUI or transient failure: send an empty list so the webview
      // falls back to free-text agent_profile entry.
      this.postMessage({ type: "fleetProfiles", profiles: [], loadError: null });
    }
  }

  private async handleStartFleetRun(runId: string): Promise<void> {
    try {
      await this.api.startFleetRun(runId);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to start Fleet run: ${(err as Error).message}`);
    }
    await this.refreshFleetRuns();
    if (this.activeFleetRunId === runId) {
      await this.refreshActiveFleetDetail();
    }
  }

  private async handleStopFleetRun(runId: string): Promise<void> {
    try {
      await this.api.stopFleetRun(runId);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to stop Fleet run: ${(err as Error).message}`);
    }
    await this.refreshFleetRuns();
    if (this.activeFleetRunId === runId) {
      await this.refreshActiveFleetDetail();
    }
  }

  private async handleFleetWorkerAction(action: string, workerId: string): Promise<void> {
    try {
      if (action === "interrupt") await this.api.interruptFleetWorker(workerId);
      else if (action === "stop") await this.api.stopFleetWorker(workerId);
      else if (action === "restart") await this.api.restartFleetWorker(workerId);
      else return;
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to ${action} worker: ${(err as Error).message}`);
    }
    if (this.activeFleetRunId) {
      await this.refreshActiveFleetDetail();
    }
    await this.refreshFleetRuns();
  }

  /** Resolve a Fleet receipt's saved exec session and surface the worker's
   *  final assistant reply — the same transcript a normal chat shows. */
  private async handleFleetOpenSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.api.ensureReady();
      const session = await this.api.getSession(sessionId);
      const messages = session.messages || [];
      let reply = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const role = (messages[i] as { role?: unknown }).role;
        if (role !== "assistant") continue;
        reply = this.extractTextFromSessionMessage(messages[i]);
        if (reply) break;
      }
      this.postMessage({ type: "fleetSessionReply", sessionId, reply });
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

  /** Resume the saved session the view is showing into a thread of its own.
   *  Both callers that can be the first thing done to a viewed session —
   *  sending its first message, and setting its first goal — need the same
   *  thread, so they get it the same way: a goal attached to a thread of its
   *  own would run on a conversation the next message never uses, and nothing
   *  would be watching it. */
  private async resumeViewedSession(sessionId: string): Promise<void> {
    // Don't pass model/mode — let the backend use the session's persisted
    // values (runtime_api.rs:911-918 unwraps to session.metadata.model/mode).
    // Passing cfg defaults would override the session's original model/mode,
    // busting the prefix cache because the system prompt and tool catalog
    // change with the model/mode.
    const result = await this.api.resumeSessionThread(sessionId);
    // Only a thread this call *created* needs the placeholder title. A `200`
    // hands back the thread that already held the session, whose title is the
    // user's (or the one a previous resume gave it) — renaming it here would
    // overwrite that.
    if (result.created) {
      try {
        await this.api.updateThread(result.thread_id, {
          title: `Resumed: ${result.summary.slice(0, 50)}`,
        });
      } catch { /* non-critical */ }
    }

    this.viewingSessionId = null;
    await this.loadThread(result.thread_id);
    // Restore cost from the original session's metadata. loadThread →
    // loadHistory may already have computed totals from the new
    // thread's turns; MERGE with max rather than overwrite, because
    // sessions saved by TUI's runtime-API endpoint carry zero cost
    // metadata (the endpoint snapshots messages/tokens but drops cost)
    // and a plain assignment would zero out real figures. Mirrors TUI's
    // monotonic (high-water) cost display philosophy.
    if (this.pendingSessionCost) {
      this.sessionCostUsd = Math.max(this.sessionCostUsd, this.pendingSessionCost.sessionCostUsd);
      this.sessionCostCny = Math.max(this.sessionCostCny, this.pendingSessionCost.sessionCostCny);
      this.displayedCostHighWaterUsd = Math.max(this.displayedCostHighWaterUsd, this.pendingSessionCost.displayedCostHighWaterUsd);
      this.displayedCostHighWaterCny = Math.max(this.displayedCostHighWaterCny, this.pendingSessionCost.displayedCostHighWaterCny);
      this.totalTokens = Math.max(this.totalTokens, this.pendingSessionCost.totalTokens);
      this.cumulativeTurnSecs = Math.max(this.cumulativeTurnSecs, this.pendingSessionCost.cumulativeTurnSecs);
      this.pendingSessionCost = null;
      this.sendSessionStats();
    }
    // Preserve the original session ID so subsequent auto-saves update
    // the same session in-place (mirrors TUI's /load behavior). This is
    // safe because seed_thread_from_messages now stores the full original
    // messages (with tool_use/tool_result blocks) on the thread record
    // via seeded_messages, and ensure_engine_loaded uses those directly
    // for SyncSession — so the engine's session preserves the exact
    // prefix. Auto-save (PUT /v1/sessions) snapshots the engine's live
    // state, which includes the full tool blocks, so the original
    // session's messages stay cache-friendly for future resumes.
    this.currentSessionId = sessionId;
    this.refreshSessionList();
  }

  // ── Thread Goal (control plane) ──

  /** Push the active thread's goal (or null) plus any background goals to the
   *  webview. The Work panel's goal slot renders from this same message, so
   *  the goal is stated once. Background goals come from the watcher's
   *  per-thread cache (threads with active goals that are not the view). */
  public async refreshGoal(): Promise<void> {
    const threadId = this.currentThread?.id;
    let goal: ThreadGoal | null = null;
    if (threadId) {
      try {
        goal = await this.api.getThreadGoal(threadId);
      } catch {
        // Goal endpoint may not exist on older TUI versions — leave panel empty.
      }
    }
    const backgroundGoals: Array<ThreadGoal & { threadId: string }> = [];
    for (const [id, st] of this.backgroundThreads) {
      if (id === threadId) continue;
      if (st.goal && st.goal.status === "active") {
        backgroundGoals.push({ ...st.goal, threadId: id });
      }
    }
    this.currentGoal = goal;
    this.postMessage({ type: "goalState", goal, backgroundGoals });
  }

  private async handleSetGoal(
    objective: string,
    tokenBudget: number | undefined,
    background = false,
  ): Promise<void> {
    const trimmed = objective?.trim();
    if (!trimmed) {
      return;
    }
    try {
      if (background) {
        // Run the goal on a dedicated background thread: the runtime kicks
        // off the goal turn server-side on PUT and drives every continuation
        // itself (activate_thread_goal / settle_thread_goal_after_turn), so
        // the loop keeps running while the user works elsewhere. We stay on
        // the current thread and just watch the new one.
        //
        // The posture is pinned to the one the warning below talks about: a
        // new thread created without it takes the runtime's configured
        // default, which is not necessarily what the user runs here.
        //
        // There may be no current thread to inherit from (新建会话, or a saved
        // session opened from the Sessions tab); the configured defaults stand
        // in, because a background goal must not need a thread already running.
        const posture = this.getEffectivePosture();
        // The goal's thread runs on the conversation's own route when there is
        // one, and on the picker's active route when there is not — the same
        // pair the first message would create.
        const route = this.currentThread
          ? this.threadRoute(this.currentThread)
          : this.newThreadRoute();
        const thread = await this.api.createThread({
          model: route.model,
          model_provider: route.model_provider,
          model_provider_id: route.model_provider_id,
          mode: this.currentThread?.mode || this.getCurrentMode(),
          workspace: this.currentThread?.workspace ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          title: trimmed.slice(0, 80),
          permission_posture: POSTURE_WIRE[posture],
          auto_approve: posture === "full_access",
          trust_mode: posture === "full_access",
        });
        await this.api.upsertThreadGoal(thread.id, trimmed, tokenBudget);
        const st = this.ensureBackgroundState(thread.id);
        st.lastEventSeq = 0;
        // Arming the watch also fetches the new thread's goal state.
        this.startBackgroundWatch(thread.id, ChatProvider.UNWATCHED_SINCE_SEQ);
        let message = t().backgroundGoalStarted;
        // Posture decides how autonomous the loop is: under Ask, every tool
        // approval blocks the background turn and auto-denies after the
        // engine's timeout — warn instead of failing silently.
        if (posture === "ask") {
          message += "\n" + t().backgroundGoalAskHint;
        }
        this.postMessage({ type: "info", message });
        this.scheduleThreadListRefresh(0);
        return;
      }
      // A goal is thread-scoped, but the GUI spends real time in a threadless
      // state: 新建会话 clears currentThread (handleNewThread), and a saved
      // session from the Sessions tab has none until it is resumed. This used
      // to return silently here — no thread, no error, no answer to the
      // webview — so the Work panel's "＋ Set goal" button looked dead. Get the
      // thread the goal belongs to the same way the first message would, so it
      // lands on the conversation the user is about to have.
      if (!this.currentThread) {
        await this.ensureGoalThread();
      }
      const threadId = this.currentThread?.id;
      if (!threadId) {
        this.reportMissingGoalThread();
        return;
      }
      await this.api.upsertThreadGoal(threadId, trimmed, tokenBudget);
      await this.refreshGoal();
    } catch (err) {
      const message = `Failed to set goal: ${(err as Error).message}`;
      vscode.window.showErrorMessage(message);
      // The panel has to answer too: a dropped setGoal used to leave the
      // webview on a stale editor, which read as "the button does nothing".
      // keepStreaming: this error is not the turn's, and the turn it did not
      // come from may still be running — the banner is the whole answer.
      this.postMessage({ type: "error", message, keepStreaming: true });
    }
  }

  /** The thread a goal set from this view belongs to, obtained the way the
   *  first message would obtain it. Two views have no thread yet: 新建会话
   *  (handleNewThread), and a saved session opened from the Sessions tab —
   *  which is resumed into its own thread here rather than left behind, since
   *  the next message will resume it anyway and a goal is thread-scoped. */
  private async ensureGoalThread(): Promise<void> {
    if (this.viewingSessionId) {
      await this.resumeViewedSession(this.viewingSessionId);
      return;
    }
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    const mode = normalizeMode(cfg.get<string>("defaultMode", "agent"));
    const posture = this.getEffectivePosture();
    const route = this.newThreadRoute();
    this.currentThread = await this.api.createThread({
      model: route.model,
      model_provider: route.model_provider,
      model_provider_id: route.model_provider_id,
      mode,
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      permission_posture: POSTURE_WIRE[posture],
      auto_approve: posture === "full_access",
      trust_mode: posture === "full_access",
    });
    this.forgetSessionBinding();
    this.subscribeToEvents();
    await this.refreshSessionList();
    // This thread did not exist a moment ago and the webview has never been
    // told about it: without this the chips keep describing whatever the view
    // showed before the goal created one.
    this.postCurrentSettings();
  }

  /** Re-arm the current thread's goal. The runtime drives goal continuations
   *  on its own, but a Runtime restart leaves an Active goal parked until an
   *  explicit PUT or a user turn re-triggers it (activate_thread_goal has no
   *  startup sweep) — this button is that explicit trigger. */
  private async handleResumeGoal(): Promise<void> {
    const threadId = this.currentThread?.id;
    if (!threadId) {
      this.reportMissingGoalThread();
      return;
    }
    try {
      const goal = await this.api.getThreadGoal(threadId);
      if (!goal?.objective) return;
      await this.api.upsertThreadGoal(threadId, goal.objective, goal.token_budget || undefined);
      await this.refreshGoal();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to resume goal: ${(err as Error).message}`);
    }
  }

  private async handleCompleteGoal(): Promise<void> {
    const threadId = this.currentThread?.id;
    if (!threadId) {
      this.reportMissingGoalThread();
      return;
    }
    try {
      await this.api.completeThreadGoal(threadId);
      await this.refreshGoal();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to complete goal: ${(err as Error).message}`);
    }
  }

  private async handleBlockGoal(): Promise<void> {
    const threadId = this.currentThread?.id;
    if (!threadId) {
      this.reportMissingGoalThread();
      return;
    }
    try {
      await this.api.blockThreadGoal(threadId);
      await this.refreshGoal();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to block goal: ${(err as Error).message}`);
    }
  }

  private async handleDeleteGoal(): Promise<void> {
    const threadId = this.currentThread?.id;
    if (!threadId) {
      this.reportMissingGoalThread();
      return;
    }
    try {
      await this.api.deleteThreadGoal(threadId);
      await this.refreshGoal();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete goal: ${(err as Error).message}`);
    }
  }

  /** Answer a goal action that has no thread to act on. Complete/Block/
   *  Delete/Resume used to return in silence, so the goal card's buttons
   *  looked broken whenever the view had moved to a saved session. */
  private reportMissingGoalThread(): void {
    const message = t().goalNeedsThread;
    vscode.window.showErrorMessage(message);
    // keepStreaming: see handleSetGoal — a goal error must not stop the
    // streaming indicator of a turn it did not come from.
    this.postMessage({ type: "error", message, keepStreaming: true });
  }

  /** Open session panel showing a specific task's detail */
  private async handleShowTaskDetail(taskId: string): Promise<void> {
    try {
      this.activeTaskDetailId = taskId;
      const task = await this.api.getTask(taskId);
      const enrichedTask = await this.enrichTaskDetail(task);
      this.postMessage({ type: "taskDetail", task: enrichedTask });
      this.syncActiveTaskDetailPolling(enrichedTask.status);
    } catch (err) {
      if (this.activeTaskDetailId === taskId) {
        this.activeTaskDetailId = null;
      }
      this.stopActiveTaskDetailRefresh();
      vscode.window.showErrorMessage(`Failed to load task: ${(err as Error).message}`);
    }
  }

  private handleCloseTaskDetail(): void {
    this.activeTaskDetailId = null;
    this.stopActiveTaskDetailRefresh();
  }

  private async refreshActiveTaskDetail(): Promise<void> {
    if (!this.activeTaskDetailId) {
      return;
    }

    try {
      const task = await this.api.getTask(this.activeTaskDetailId);
      const enrichedTask = await this.enrichTaskDetail(task);
      this.postMessage({ type: "taskDetail", task: enrichedTask });
      this.syncActiveTaskDetailPolling(enrichedTask.status);
    } catch {
      this.stopActiveTaskDetailRefresh();
    }
  }

  private isTerminalTaskStatus(status: string | null | undefined): boolean {
    return status === "completed"
      || status === "failed"
      || status === "interrupted"
      || status === "canceled"
      || status === "cancelled";
  }

  private startActiveTaskDetailRefresh(): void {
    if (!this.activeTaskDetailId || this.taskDetailRefreshTimer) {
      return;
    }
    this.taskDetailRefreshTimer = setInterval(() => {
      void this.refreshActiveTaskDetail();
    }, 1500);
  }

  private stopActiveTaskDetailRefresh(): void {
    if (this.taskDetailRefreshTimer) {
      clearInterval(this.taskDetailRefreshTimer);
      this.taskDetailRefreshTimer = null;
    }
  }

  private syncActiveTaskDetailPolling(status: string | null | undefined): void {
    if (!this.activeTaskDetailId) {
      this.stopActiveTaskDetailRefresh();
      return;
    }
    if (this.isTerminalTaskStatus(status)) {
      this.stopActiveTaskDetailRefresh();
      return;
    }
    this.startActiveTaskDetailRefresh();
  }

  private async pollTaskStatus(taskId: string, attempts = 6, delayMs = 1000): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const task = await this.api.getTask(taskId);
        if (this.activeTaskDetailId === taskId) {
          const enrichedTask = await this.enrichTaskDetail(task);
          this.postMessage({ type: "taskDetail", task: enrichedTask });
        }
        await this.refreshTaskList();
        if (this.isTerminalTaskStatus(task.status)) {
          return;
        }
      } catch {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  private async handleCreateTaskFromSidebar(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    try {
      await this.api.ensureReady();
      const taskCfg = vscode.workspace.getConfiguration("brotherwhale");
      // A task runs on a thread of its own, so it starts from the same
      // new-session defaults a chat thread does — including the permission,
      // which used to fall to the runtime's own default here, and the route,
      // which used to be the global `defaultModel` under whichever provider
      // happened to be active.
      const posture = this.getCurrentPosture();
      const route = this.newThreadRoute();
      const task = await this.api.createTask({
        prompt: trimmed,
        model: route.model,
        model_provider: route.model_provider,
        model_provider_id: route.model_provider_id,
        mode: normalizeMode(taskCfg.get<string>("defaultMode", "agent")),
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        permission_posture: POSTURE_WIRE[posture],
        auto_approve: posture === "full_access" || taskCfg.get<boolean>("autoApprove", false),
      });
      await this.refreshTaskList();
      // Every task runs on a runtime thread of its own, and the watcher
      // reconciles threads: without a list refresh nothing watches the new one,
      // so an approval it needs would sit unanswered with no notice and no
      // inline card. Refresh now, while we still know which thread to look for.
      this.scheduleThreadListRefresh();
      await this.handleShowTaskDetail(task.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to create task: ${(err as Error).message}`);
    }
  }

  private async handleCancelTaskFromSidebar(taskId: string): Promise<void> {
    if (!taskId) {
      return;
    }

    try {
      await this.api.ensureReady();
      await this.api.cancelTask(taskId);
      await this.refreshTaskList();
      void this.pollTaskStatus(taskId);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to cancel task: ${(err as Error).message}`);
    }
  }

  /** Show an agent run detail inside the main webview when a run id is known. */
  private async handleShowAgentSessions(runId: string): Promise<void> {
    if (!runId) {
      return;
    }
    try {
      const run = await this.api.getAgentRun(runId);
      this.postMessage({ type: "agentDetail", run });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to load agent run: ${(err as Error).message}`);
    }
  }

  private normalizeOptionalPath(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
  }

  private cacheTextArtifactPreview(filePath: string | null, content: string, language?: string): void {
    if (!filePath || !content) {
      return;
    }
    this.textArtifactPreviewStore.set(filePath, { content, language });
    if (path.isAbsolute(filePath)) {
      this.textArtifactPreviewStore.set(path.normalize(filePath), { content, language });
    }
  }

  private async readTaskTextArtifact(
    filePath: string | null,
    maxBytes = 256 * 1024,
  ): Promise<{ content: string; truncated: boolean } | null> {
    if (!filePath) {
      return null;
    }

    try {
      const absPath = resolveTaskArtifactPath(filePath);
      const buffer = await fs.promises.readFile(absPath);

      // Skip binary-ish content and keep the GUI focused on textual artifacts.
      if (buffer.includes(0)) {
        return null;
      }

      const truncated = buffer.length > maxBytes;
      const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
      return {
        content: slice.toString("utf8"),
        truncated,
      };
    } catch {
      return null;
    }
  }

  private async enrichTaskDetail(task: TaskRecord): Promise<TaskRecord> {
    const resultDetailPath = this.normalizeOptionalPath((task as TaskRecord & Record<string, unknown>).result_detail_path);
    const resultDetail = await this.readTaskTextArtifact(resultDetailPath);
    let pendingApprovals = ((task as TaskRecord & Record<string, unknown>).pending_approvals as TaskRecord["pending_approvals"] | undefined) || [];
    let pendingUserInputs = ((task as TaskRecord & Record<string, unknown>).pending_user_inputs as TaskRecord["pending_user_inputs"] | undefined) || [];

    if (task.thread_id) {
      try {
        const threadDetail = await this.api.getThreadDetail(task.thread_id);
        pendingApprovals = threadDetail.pending_approvals || [];
        pendingUserInputs = threadDetail.pending_user_inputs || [];
        for (const pending of pendingUserInputs) {
          this.pendingUserInputs.set(pending.id, {
            threadId: task.thread_id,
            questions: (pending.request?.questions || []).map((question) => ({
              header: question.header,
              id: question.id,
              question: question.question,
              options: question.options || [],
            })),
            answers: [],
            answeredQuestions: new Set(),
          });
        }
      } catch {
        // Keep task detail usable even when linked thread detail is unavailable.
      }
    }

    if (resultDetailPath && resultDetail?.content) {
      this.cacheTextArtifactPreview(resultDetailPath, resultDetail.content, "markdown");
    }

    return {
      ...task,
      result_detail_path: resultDetailPath,
      result_detail_content: resultDetail?.content ?? null,
      result_detail_truncated: resultDetail?.truncated ?? false,
      tool_calls: (task.tool_calls || []).map((toolCall) => ({
        ...toolCall,
        detail_path: this.normalizeOptionalPath(toolCall.detail_path),
        patch_ref: this.normalizeOptionalPath(toolCall.patch_ref),
      })),
      timeline: (task.timeline || []).map((entry) => ({
        ...entry,
        detail_path: this.normalizeOptionalPath(entry.detail_path),
      })),
      gates: ((task as TaskRecord & Record<string, unknown>).gates as TaskRecord["gates"] | undefined)?.map((gate) => ({
        ...gate,
        log_path: this.normalizeOptionalPath(gate.log_path),
      })) || [],
      attempts: ((task as TaskRecord & Record<string, unknown>).attempts as TaskRecord["attempts"] | undefined)?.map((attempt) => ({
        ...attempt,
        patch_path: this.normalizeOptionalPath(attempt.patch_path),
      })) || [],
      artifacts: ((task as TaskRecord & Record<string, unknown>).artifacts as TaskRecord["artifacts"] | undefined)?.map((artifact) => ({
        ...artifact,
        path: this.normalizeOptionalPath(artifact.path) || artifact.path,
      })) || [],
      github_events: ((task as TaskRecord & Record<string, unknown>).github_events as TaskRecord["github_events"] | undefined) || [],
      pending_approvals: pendingApprovals,
      pending_user_inputs: pendingUserInputs,
    };
  }

  /** Push the current work state to the webview Work panel.
   *
   *  The goal is not part of this payload: it is owned by the goal control plane
   *  (`goalState`), which the Work panel renders in its first slot. */
  public refreshWorkPanel(): void {
    this.postMessage({
      type: "workState",
      checklist: this.checklistItems,
      checklistCompletionPct: this.checklistCompletionPct,
      strategy: this.strategySteps,
    });
    this.refreshChangesPanel();
  }

  /**
   * Rebuilds the diffs a replayed session cannot recover from its own log.
   *
   * Session recordings keep no `file.mutation` receipt — the runtime stores the
   * authoritative diff on turn items, which belong to a thread the session log
   * does not name — and the contract `edit` tool answers with a one-line
   * summary rather than a diff. A reloaded Changes panel therefore had no diff
   * to offer for any file edited through `edit`, and its Diff action vanished.
   *
   * Each call's input still records the exact replacements it made, so the
   * diffs are reconstructed from those: walk a file's calls backwards from the
   * content on disk, emitting one hunk per recorded replacement. A chain that
   * does not line up (the file moved on since the session) is left without a
   * diff rather than given a fabricated one.
   */
  private backfillSessionFileDiffs(toolCalls: ToolCallInfo[]): void {
    const callsByPath = new Map<string, ToolCallInfo[]>();
    const editsByCall = new Map<ToolCallInfo, RecordedEdit[]>();
    for (const tc of toolCalls) {
      if (!tc.input || !isFileChangeTool(tc.name)) continue;
      const filePath = extractFilePath(tc.name, tc.input);
      if (!filePath) continue;
      const key = normalizePath(filePath);
      const calls = callsByPath.get(key) ?? [];
      calls.push(tc);
      callsByPath.set(key, calls);

      const edits = extractRecordedEdits(tc.input);
      if (edits.length > 0) {
        editsByCall.set(tc, edits);
      }
    }

    for (const calls of callsByPath.values()) {
      const recordedEditCalls = calls.filter((call) => editsByCall.has(call) && call.fileChange);
      if (recordedEditCalls.length === 0) continue;

      const missingCallDiff = recordedEditCalls.some((call) => !call.fileChange?.diff);
      const reconstructedByCall = new Map<ToolCallInfo, string>();

      if (missingCallDiff) {
        const absPath = resolveRecordedFilePath(
          recordedEditCalls[0].fileChange!.filePath,
          this.recordedPathRoots(),
          defaultTasksDir()
        );
        let content: string;
        try {
          content = fs.readFileSync(absPath, "utf8");
        } catch {
          continue;
        }

        for (let i = recordedEditCalls.length - 1; i >= 0; i--) {
          const call = recordedEditCalls[i];
          const edits = editsByCall.get(call)!;
          const patch = formatRecordedEditsAsDiff(call.fileChange!.filePath, content, edits);
          const before = patch === null ? null : reverseApplyRecordedEdits(content, edits);
          if (patch === null || before === null) {
            reconstructedByCall.clear();
            break;
          }
          reconstructedByCall.set(call, patch);
          content = before;
        }
      }

      if (!missingCallDiff || reconstructedByCall.size === recordedEditCalls.length) {
        for (const call of recordedEditCalls) {
          const fileChange = call.fileChange!;
          const diff = fileChange.diff ?? reconstructedByCall.get(call);
          if (diff) fileChange.diff = diff;
        }
      }
      // A diff that cannot be walked back is left absent rather than replaced
      // by an earlier one: showing the wrong patch for a change is worse than
      // showing none.
    }
    // Every change carries its own position in its file's history; the diff
    // reconstruction above may have filled in diffs that shift later ones.
    this.reindexFileChanges();
  }

  /**
   * Append one change record. Records share their object with the tool call
   * card that produced them, so the panel and the card always agree on the
   * change's identity, index and reviewed digest.
   */
  private appendFileChange(change: FileChangeInfo): void {
    if (this.turnFileChanges.includes(change)) return;
    this.turnFileChanges.push(change);
    this.reindexFileChanges();
  }

  /**
   * Number each change within its own file's history, counting only changes
   * that carry a diff. `changeIndex` is what a card's Diff action sends back:
   * reconstructing a change's before/after content means walking the file's
   * *later* changes back from what is on disk, so the index has to describe
   * the change, not the file.
   */
  private reindexFileChanges(): void {
    const nextIndexByPath = new Map<string, number>();
    for (const change of this.turnFileChanges) {
      if (!change.diff) {
        change.changeIndex = undefined;
        continue;
      }
      const key = normalizePath(change.filePath);
      const index = nextIndexByPath.get(key) ?? 0;
      change.changeIndex = index;
      nextIndexByPath.set(key, index + 1);
    }
  }

  /** The diffs of one file's changes, in the order `changeIndex` counts them. */
  private diffsForPath(filePath: string): string[] {
    const key = normalizePath(filePath);
    return this.turnFileChanges
      .filter((change) => normalizePath(change.filePath) === key && change.diff)
      .map((change) => change.diff!);
  }

  /** Push the recorded changes to the webview Changes panel.
   *
   *  One entry per change, not per file: the panel's Diff action reconstructs
   *  the change at `changeIndex` within its file's history, and its Revert
   *  action names the exact tool call (`callId`) whose restore point it wants. */
  private refreshChangesPanel(): void {
    this.postMessage({
      type: "changesState",
      changes: this.turnFileChanges.map(fc => ({
        filePath: fc.filePath,
        changeType: fc.changeType,
        addedLines: fc.addedLines,
        removedLines: fc.removedLines,
        diff: fc.diff,
        changeIndex: fc.changeIndex,
        callId: fc.callId,
        toolName: fc.toolName,
      })),
    });
  }

  private getWebviewCapabilities(): {
    saveSession: boolean;
    undoLastTurn: boolean;
    retryLastTurn: boolean;
    revertFileChange: boolean;
    turnSteer: boolean;
  } {
    return {
      saveSession: this.apiCapabilities.saveSession,
      undoLastTurn: this.apiCapabilities.threadPatchUndo,
      retryLastTurn: this.apiCapabilities.threadRetry,
      // Per-file restore needs the engine's file-scoped `file-revert` route.
      // Without it the panel keeps the button disabled with an explanation:
      // the only other restore surface is the whole-workspace snapshot
      // restore, which would silently roll back unrelated files.
      revertFileChange: this.apiCapabilities.threadFileRevert,
      turnSteer: this.apiCapabilities.turnSteer,
    };
  }

  private postApiCapabilities(): void {
    this.postMessage({
      type: "apiCapabilities",
      capabilities: this.getWebviewCapabilities(),
    });
  }

  private async refreshApiCapabilities(): Promise<void> {
    try {
      this.apiCapabilities = await this.api.probeRuntimeCapabilities();
      // The probe result is otherwise invisible: a capability can be silently
      // false on an engine that supports the feature, and every gated control
      // just renders disabled with no reason. Log the raw set so a "button is
      // greyed out" report can be answered from this file instead of guesswork.
      this.debugLog(`apiCapabilities: ${JSON.stringify(this.apiCapabilities)}`);
    } catch (err) {
      // Never swallow the cause: an all-false set here is indistinguishable
      // from "the engine is old", and that misdiagnosis is expensive.
      this.debugLog(`probeRuntimeCapabilities failed: ${getErrorMessage(err)}`);
      this.apiCapabilities = {
        saveSession: false,
        threadUndo: false,
        threadPatchUndo: false,
        threadRetry: false,
        turnSteer: false,
        snapshotList: false,
        snapshotRestore: false,
        threadUsage: false,
        threadFileRevert: false,
      };
    }
    this.postApiCapabilities();
  }

  private async refreshRuntimeVersion(): Promise<void> {
    try {
      const info = await this.api.getRuntimeInfo();
      this.runtimeVersion = info.version || null;
    } catch {
      this.runtimeVersion = null;
    }
  }

  /**
   * Fetch the provider list from `GET /v1/providers` and push it to the
   * webview. Called on init and after a provider switch so the picker stays
   * in sync with the backend.
   *
   * Failures are logged but not surfaced to the user — the picker falls
   * back to the hard-coded deepseek-only list baked into the HTML.
   */
  private async refreshProviders(): Promise<void> {
    try {
      const resp = await this.api.listProviders();
      this.providersCache = resp.providers;
      this.currentProvider = resp.current;
      this.currentProviderId = resp.current_provider_id || null;
      this.postProviders(true);
    } catch (err) {
      this.debugLog(`refreshProviders failed: ${getErrorMessage(err)}`);
    }
  }

  /** The last route answer published. `postCurrentSettings()` runs on every
   *  chip-affecting action (an approval, a mode change, a thread switch), and
   *  every publish makes the webview re-request the route's model list, so a
   *  republish that says nothing new is skipped. `force` is for the one caller
   *  whose payload really changed: the catalog refresh itself. */
  private publishedRouteKey: string | null = null;

  /** Push the cached provider list + active provider to the webview. */
  private postProviders(force = false): void {
    if (!this.providersCache) return;
    const view = this.viewRoute();
    const routeKey = [
      this.currentProvider || "",
      this.currentProviderId || "",
      view?.provider || "",
      view?.providerId || "",
    ].join("|");
    if (!force && routeKey === this.publishedRouteKey) return;
    this.publishedRouteKey = routeKey;
    this.postMessage({
      type: "providersUpdated",
      providers: this.providersCache,
      current: this.currentProvider || "",
      currentProviderId: this.currentProviderId || "",
      // The route whatever is on screen will actually run on, which is not the
      // runtime's active route once the picker has moved: a conversation keeps
      // the provider it was created on (runtime_threads.rs::
      // provider_identity_for_thread), no endpoint re-routes one, and a saved
      // session that is only being viewed already knows the route its resume
      // will use. The webview reads its chip and its model list from this, so
      // neither can describe a route the next message will not use.
      viewProvider: view?.provider || "",
      viewProviderId: view?.providerId || "",
      viewModel: this.getCurrentModel(),
    });
  }

  /**
   * Handle `switchProvider` webview message: delegate to the TUI's
   * `POST /v1/providers/{id}/switch` endpoint, which atomically persists
   * `provider` (+ optional `model`), reloads config, and returns the
   * backend-resolved active model.
   *
   * This mirrors the TUI's `/provider` command flow exactly: the backend
   * decides whether to persist `model` based on whether the caller passed
   * one. Previously the GUI emulated this with separate
   * `setConfig({key:"provider"})` + `setConfig({key:"model"})` + `reloadConfig`
   * calls, which clobbered the user's per-provider `model` config with the
   * catalog default when the picker was clicked without an explicit model.
   *
   * The resolved `model` in the response is what the runtime will actually
   * use for new turns — display THAT, not the cached
   * `ProviderEntry.default_model`, so the UI matches reality when the user
   * has `[providers.<id>].model` configured.
   *
   * `modelProviderId` carries the exact configured route when the picker
   * selected a user-defined `[providers.<name>]` entry: those share the
   * generic `custom` id, so the pair is what names one route.
   */
  private async handleSwitchProvider(
    providerId: string,
    model?: string,
    modelProviderId?: string
  ): Promise<void> {
    const trimmed = providerId.trim();
    if (!trimmed) {
      this.postMessage({ type: "error", message: "Empty provider id" });
      return;
    }
    const exactRoute = modelProviderId?.trim() || undefined;
    try {
      // Single backend call: persists provider (+ model only when given),
      // reloads config, syncs to engines, and returns the resolved model.
      const effectiveModel = model?.trim() || undefined;
      const resp = await this.api.switchProvider(trimmed, effectiveModel, exactRoute);
      const resolvedModel = resp.model;

      // Remember the model the backend resolved for the route that is now
      // active, so the next thread created under it starts from the model the
      // user is looking at. This write lands in `modelByProvider` under this
      // route's key, never in the single global `defaultModel`: one global
      // value is what paired `deepseek-flash` with the Zhipu route when the
      // picker was switched here without naming a model.
      await this.refreshProviders();
      // Keyed by the route that was *asked for*: `refreshProviders` swallows a
      // failed catalog read, and a memory written under a stale active route
      // would pin this route's model onto another one.
      await this.rememberModelForRoute(resolvedModel, resp.provider || trimmed, exactRoute);

      await this.handleRequestProviderModels(trimmed, resolvedModel, exactRoute);
      this.postMessage({
        type: "settingsUpdated",
        model: resolvedModel,
        mode: this.getCurrentMode(),
        posture: this.getEffectivePosture(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: resp.provider || trimmed,
        providerId: this.currentProviderId || undefined,
      });
      this.postMessage({
        type: "info",
        message: resp.message ||
          `Provider switched to ${resp.provider || trimmed} (model: ${resolvedModel}).`,
      });

      // A conversation keeps the provider it was created on — a deliberate
      // engine decision, for prefix-cache economics — and no endpoint can move
      // one: `PATCH /v1/threads` and `POST .../turns` carry no provider. So a
      // message sent here still goes to the old provider. The picker keeps
      // describing the conversation, and the one action that does move it is
      // offered rather than left to be discovered.
      const conversation = this.threadRouteOf(this.currentThread);
      const conversationKey = providerRouteKey(conversation?.provider, conversation?.providerId);
      const activeKey = providerRouteKey(this.currentProvider, this.currentProviderId);
      if (conversationKey && activeKey && conversationKey !== activeKey) {
        const action = "New conversation";
        const choice = await vscode.window.showWarningMessage(
          `Switched to ${activeKey} (model: ${resolvedModel}). This conversation keeps running on ${conversationKey}, so its next message still goes there — the switch applies to new conversations.`,
          action
        );
        if (choice === action) await this.handleNewThread();
      }
    } catch (err) {
      this.postMessage({
        type: "error",
        message: `Failed to switch provider: ${getErrorMessage(err)}`,
      });
    }
  }

  /**
   * Handle `requestProviderModels` webview message: fetch the model catalog
   * for a provider and push it to the webview so the model dropdown can be
   * re-rendered. Used when the user picks a different provider.
   */
  private async handleRequestProviderModels(
    providerId: string,
    currentModel?: string,
    modelProviderId?: string
  ): Promise<void> {
    const trimmed = providerId.trim();
    if (!trimmed) return;
    // The list belongs to the route the *view* is bound to, not to the route
    // the caller named: once the picker has moved on, a conversation keeps
    // running on the provider it was created with, and offering the picker's
    // models is how `deepseek-flash` was chosen for a thread pinned to the
    // Zhipu route. The answer is labelled with the route it describes, so the
    // webview's own guard — chip route vs answer route — still matches.
    const bound = this.viewRoute();
    const targetProvider = bound?.provider || trimmed;
    const targetExact = bound ? bound.providerId : modelProviderId?.trim() || undefined;
    try {
      const resp = await this.api.listProviderModels(targetProvider, targetExact);
      // Determine whether this provider has a built-in catalog so the
      // webview can show a free-text hint when models is empty. The exact
      // route decides which entry owns the answer: two named routes share the
      // generic id.
      const info = this.findProviderEntry(targetProvider, targetExact);
      // The answer names the route it describes, and the webview drops an
      // answer whose route is not the one on screen. That id comes from the
      // catalog rather than from the caller: the provider catalog reports an
      // exact id for built-in providers too, so echoing only what the caller
      // passed would make every answer for a built-in provider look stale.
      const answeredRoute = info?.model_provider_id ?? targetExact ?? "";
      // The model of whatever is on screen wins over the caller's suggestion:
      // the chip and the list have to describe the same conversation the route
      // does. A viewed session has no thread to read, so its saved model is
      // the answer — falling through to the route's default here would repaint
      // the chip with a model the session never used.
      const effectiveCurrentModel = this.currentThread?.model?.trim()
        || (this.viewingSessionId ? this.viewingSessionModel?.trim() : undefined)
        || currentModel?.trim()
        || info?.default_model
        || undefined;
      this.postMessage({
        type: "providerModels",
        provider: targetProvider,
        providerId: answeredRoute,
        models: resp.models.map(m => m.id),
        currentModel: effectiveCurrentModel,
        hasCatalog: info ? info.has_model_catalog : (resp.models.length > 0),
      });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: `Failed to list models for provider ${targetProvider}: ${getErrorMessage(err)}`,
      });
    }
  }

  /** Public accessor for slash command handlers (`/provider`, `/models`). */
  public getProvidersCache(): ProviderEntry[] | null {
    return this.providersCache;
  }

  /** Public accessor for the active provider id. */
  public getCurrentProvider(): string | null {
    return this.currentProvider;
  }

  /** Public accessor for the active route's exact configured id, when it has
   *  one. A user-defined `[providers.<name>]` route is named by this, not by
   *  its generic `custom` kind. */
  public getCurrentProviderId(): string | null {
    return this.currentProviderId;
  }

  /** The catalog entry for one route. The exact id is the tiebreaker: two
   *  named custom routes share the generic id, so matching on the id alone
   *  would answer with whichever one happens to be listed first. */
  private findProviderEntry(
    providerId: string,
    modelProviderId?: string
  ): ProviderEntry | undefined {
    const exact = modelProviderId?.trim();
    const candidates = this.providersCache?.filter(p => p.id === providerId) ?? [];
    if (exact) {
      const match = candidates.find(p => (p.model_provider_id || "") === exact);
      if (match) return match;
    }
    return candidates.find(p => !p.model_provider_id) || candidates[0];
  }

  /** The catalog entry for the route the picker is on, when the runtime has
   *  published one. */
  private activeProviderEntry(): ProviderEntry | undefined {
    if (!this.currentProvider) return undefined;
    return this.findProviderEntry(this.currentProvider, this.currentProviderId ?? undefined);
  }

  /** Every route's remembered model, keyed by `model_provider_id || id`.
   *
   *  One global `defaultModel` cannot serve two providers: it holds whatever
   *  route was touched last, so a thread created under a different route was
   *  pinned to that route's provider with another route's model id —
   *  `deepseek-flash` under the Zhipu route is `400 模型不存在`, and the same
   *  pairing failed the DeepSeek Anthropic route's credential check. Each
   *  route remembers its own; `defaultModel` stays as the last-resort
   *  fallback. */
  private providerModelMemory(): Record<string, string> {
    const raw = vscode.workspace
      .getConfiguration("brotherwhale")
      .get<Record<string, unknown>>("modelByProvider", {});
    const memory: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.trim()) memory[key] = value.trim();
      }
    }
    return memory;
  }

  /** The model a new thread of this route starts from.
   *
   *  Precedence: what this route last remembered, then the model the runtime's
   *  own catalog publishes for it (the user's `[providers.<id>].model`, which
   *  is provider-correct by construction), then the global `defaultModel` for a
   *  route the catalog cannot describe. A pass-through route publishes no
   *  catalog, so it keeps the fallback rather than a placeholder model id. */
  public getModelForRoute(provider?: string | null, providerId?: string | null): string {
    const key = providerRouteKey(provider, providerId);
    const remembered = key ? this.providerModelMemory()[key] : undefined;
    if (remembered) return remembered;
    const entry = provider ? this.findProviderEntry(provider, providerId ?? undefined) : undefined;
    const catalogModel = entry?.default_model?.trim();
    if (entry?.has_model_catalog && catalogModel) return catalogModel;
    return vscode.workspace
      .getConfiguration("brotherwhale")
      .get<string>("defaultModel", "deepseek-v4-pro");
  }

  /** Remember `model` for a route — the model its new threads start from.
   *
   *  Public because `/model` writes through the same path the provider picker
   *  does (`SlashCommandContext`), so the memory has exactly one author. */
  public async rememberModelForRoute(
    model: string,
    provider?: string | null,
    providerId?: string | null
  ): Promise<void> {
    const trimmed = model?.trim();
    if (!trimmed) return;
    // An explicit route wins outright; with none, the route *on screen* is the
    // one remembered for — the picker's only when nothing is open. Falling back
    // per-field instead would mix the two (`/provider volcengine` names no
    // exact id, and inheriting the previous provider's would write the model
    // onto the route the user just left).
    const explicit = provider !== undefined || providerId !== undefined;
    const route = explicit
      ? { provider: provider ?? undefined, providerId: providerId ?? undefined }
      : this.viewRoute();
    const key = providerRouteKey(route?.provider, route?.providerId);
    if (!key) return;
    const memory = this.providerModelMemory();
    if (memory[key] === trimmed) return;
    memory[key] = trimmed;
    await vscode.workspace
      .getConfiguration("brotherwhale")
      .update("modelByProvider", memory, vscode.ConfigurationTarget.Global);
  }

  /** The provider pair a thread created now must carry.
   *
   *  Only returned when the runtime published an exact id for the active
   *  route: the pair is what names one route, and `model_provider: "custom"`
   *  without it would mean the legacy root-level route instead of the named one
   *  the picker is showing. A runtime that publishes no exact id therefore
   *  keeps the pre-existing behaviour — provider omitted, the runtime's own
   *  active route used — rather than being pointed at the wrong one. */
  private activeRoutePair(): { model_provider?: string; model_provider_id?: string } {
    const active = this.activeProviderEntry();
    const provider = active?.id || this.currentProvider || undefined;
    const providerId = active?.model_provider_id || this.currentProviderId || undefined;
    if (!provider || !providerId) return {};
    return { model_provider: provider, model_provider_id: providerId };
  }

  /** Public accessor for `SlashCommandContext`: a command that creates a
   *  conversation sends the same three fields a chat thread's creation does. */
  public routeForNewConversation(): {
    model: string;
    model_provider?: string;
    model_provider_id?: string;
  } {
    return this.newThreadRoute();
  }

  /** The route a brand-new thread is created on: the picker's active provider
   *  plus the model remembered for it. */
  private newThreadRoute(): {
    model: string;
    model_provider?: string;
    model_provider_id?: string;
  } {
    const pair = this.activeRoutePair();
    return {
      ...pair,
      model: this.getModelForRoute(pair.model_provider, pair.model_provider_id),
    };
  }

  /** The route a thread record already carries, for a thread this client is
   *  rebuilding: its own provider pair and model, never the picker's. */
  private threadRoute(thread: ThreadRecord): {
    model: string;
    model_provider?: string;
    model_provider_id?: string;
  } {
    const provider = thread.model_provider?.trim() || undefined;
    const providerId = thread.model_provider_id?.trim() || undefined;
    const model = thread.model?.trim() || this.getModelForRoute(provider, providerId);
    if (!provider) return { model };
    // A built-in kind stands on its own: the runtime resolves it back to that
    // route and fills the exact id (verified against an engine — `POST
    // /v1/threads` with the kind alone answers 201 and stores both). The
    // literal `custom` kind does not: without an exact id it names the legacy
    // root-level route, which the runtime refuses outright once the live config
    // selects a named one ("legacy session records only the generic `custom`
    // provider kind, but the live config selects 'bigmodel-cn' … will not guess
    // or fall back"). That record keeps the pre-route behaviour — the runtime's
    // own active route — rather than turning a rebuild into a 400.
    if (!providerId && provider.toLowerCase() === "custom") return { model };
    return providerId
      ? { model, model_provider: provider, model_provider_id: providerId }
      : { model, model_provider: provider };
  }

  /** The provider pair a thread record carries, when it has one. */
  private threadRouteOf(
    thread: ThreadRecord | null | undefined
  ): { provider: string; providerId?: string } | null {
    const provider = thread?.model_provider?.trim();
    if (!provider) return null;
    return { provider, providerId: thread?.model_provider_id?.trim() || undefined };
  }

  /** The route this view is bound to: the open conversation's own route when it
   *  has one, then the route of a saved session being *viewed* (its next
   *  message resumes it into a thread on that route), then the picker's active
   *  route.
   *
   *  A conversation keeps the provider it was created on (`runtime_threads.rs::
   *  provider_identity_for_thread` resolves the thread's persisted route, and
   *  neither `PATCH /v1/threads` nor `POST .../turns` carries a provider), so
   *  once the picker has moved on, these are two different answers. Everything
   *  that describes "what will happen when I send" — the provider chip, the
   *  model chip, the model list — has to read this one. */
  private viewRoute(): { provider: string; providerId?: string } | null {
    const thread = this.threadRouteOf(this.currentThread);
    if (thread) return thread;
    if (this.viewingSessionId && this.viewingSessionProvider) {
      return {
        provider: this.viewingSessionProvider,
        providerId: this.viewingSessionProviderId ?? undefined,
      };
    }
    if (!this.currentProvider) return null;
    return { provider: this.currentProvider, providerId: this.currentProviderId ?? undefined };
  }

  /** Whether `model` belongs to a provider route other than the one this view
   *  is bound to.
   *
   *  `/model <id>` can name any id at all, and an id that belongs to another
   *  provider is exactly the pair a provider answers `400 模型不存在` for (the
   *  Zhipu route received `deepseek-flash` this way). The rule is deliberately
   *  narrow — the id must be one another route is *known* to use, as that
   *  route's own catalog default or as the model remembered for it — because
   *  the engine itself accepts a name-shaped id for a route whose catalog does
   *  not list it (`normalize_runtime_config_model` validates the shape, not
   *  membership). Refusing everything outside the route's catalog would make
   *  the GUI stricter than the engine and reject models that work, which is a
   *  worse failure than passing one through to a provider that says no. */
  public modelFitsViewRoute(model: string): {
    ok: boolean;
    route: string;
    /** The other route this id is known to belong to, when it is one. */
    foreign?: string;
  } {
    const trimmed = model?.trim() ?? "";
    const route = this.viewRoute();
    const routeKey = providerRouteKey(route?.provider, route?.providerId);
    if (!trimmed || !route) return { ok: true, route: routeKey };
    const memory = this.providerModelMemory();
    for (const entry of this.providersCache ?? []) {
      const entryKey = providerEntryRouteKey(entry);
      if (!entryKey || entryKey === routeKey) continue;
      if (entry.default_model?.trim() === trimmed || memory[entryKey] === trimmed) {
        return { ok: false, route: routeKey, foreign: entryKey };
      }
    }
    return { ok: true, route: routeKey };
  }

  private startPeriodicTaskRefresh(): void {
    this.stopPeriodicTaskRefresh();
    this.taskRefreshTimer = setInterval(() => {
      this.refreshTaskList();
    }, 2500);
  }

  // ── Background thread watcher ──
  // The runtime allows any number of concurrent per-thread event streams
  // (`GET /v1/threads/{id}/events?since_seq=N`), so instead of polling the
  // summary we open one lightweight SSE per background thread that has a
  // running turn or pending attention. Only lifecycle/approval/user-input
  // events are processed here — item deltas for a non-viewed thread are
  // dropped (its transcript is rebuilt from the server on switch-back).

  /** since_seq for a thread we have never watched: skip the durable replay
   *  entirely and only receive live events. Attention counts for the badge
   *  come from the summary refresh, so nothing is lost. */
  private static readonly UNWATCHED_SINCE_SEQ = Number.MAX_SAFE_INTEGER;

  /** Gap between quiet discovery sweeps (see startAttentionDiscoveryPoll).
   *  Long on purpose: this is a bootstrap for attention the watchers cannot
   *  see, not a live feed — a watch covers everything the moment it exists. */
  private static readonly ATTENTION_DISCOVERY_MS = 30_000;

  private ensureBackgroundState(threadId: string): BackgroundThreadState {
    let st = this.backgroundThreads.get(threadId);
    if (!st) {
      st = {
        lastEventSeq: 0,
        currentTurnId: null,
        running: false,
        attention: 0,
        sessionId: null,
        goal: null,
        goalChecked: false,
        notifiedAttention: false,
      };
      this.backgroundThreads.set(threadId, st);
    }
    return st;
  }

  /**
   * Open the watch for one background thread.
   *
   * `parked` is true when the caller is parking the thread it is leaving: at
   * that moment `currentThread` still names it, so the "never watch the thread
   * the view is on" rule has to be waived for that one call. Every other
   * caller relies on the rule. */
  private startBackgroundWatch(threadId: string, sinceSeq: number, parked = false): void {
    if (this.watchControllers.has(threadId)) return;
    if (!parked && threadId === this.currentThread?.id) return;
    const controller = this.api.streamEvents(
      threadId,
      sinceSeq,
      (event: RuntimeEvent) => this.handleBackgroundEvent(threadId, event),
      () => {
        // Drop the stream on error; the next summary refresh re-arms it if
        // the thread still needs watching (fresh cursor from the summary).
        this.stopBackgroundWatch(threadId);
        this.scheduleThreadListRefresh();
      },
    );
    this.watchControllers.set(threadId, controller);
    // One hook for "learn this thread's goal": goal state decides whether the
    // watch outlives the turn (an Active goal keeps continuing on its own).
    const st = this.backgroundThreads.get(threadId);
    if (st && !st.goalChecked) void this.refreshBackgroundGoal(threadId);
  }

  private stopBackgroundWatch(threadId: string): void {
    const controller = this.watchControllers.get(threadId);
    if (controller) controller.abort();
    this.watchControllers.delete(threadId);
  }

  private stopAllBackgroundWatches(): void {
    for (const controller of this.watchControllers.values()) controller.abort();
    this.watchControllers.clear();
  }

  /** Reconcile the watch set with a fresh summary list. Called from
   *  refreshThreadList — the summary is the authority for which threads
   *  are running or need attention; watcher events refine it in between. */
  private syncBackgroundWatchers(threads: ThreadSummary[]): void {
    const currentId = this.currentThread?.id;
    const wanted = new Set<string>();
    for (const sum of threads) {
      if (sum.id === currentId) continue;
      const status = String(sum.latest_turn_status || "");
      // The runtime's Debug-lowercased status spells "inprogress" without
      // the underscore; the turn record spells it "in_progress". Accept both.
      const running = status === "in_progress" || status === "inprogress" || status === "queued";
      const authoritativeAttention = sum.pending_attention_count || 0;
      const attention = authoritativeAttention > 0;
      if (!running && !attention) continue;
      wanted.add(sum.id);
      const st = this.ensureBackgroundState(sum.id);
      st.running = running || st.running;
      // The summary is the authority, so assign instead of ratcheting. The old
      // `Math.max` could only ever raise the count, so one lost decrement
      // pinned the badge (and the notification latch) for the rest of the
      // session.
      st.attention = authoritativeAttention;
      // Attention -> notification is decided here, off the authoritative
      // count, and never off a raw `approval.required` event.
      //
      // The runtime emits `approval.required` on its auto-approve path too
      // (runtime_threads.rs), where it registers *no* pending approval and
      // follows the event immediately with `approval.decided` (`"auto": true`).
      // Nothing in that path needs the user, so an event-driven notice fired
      // once per auto-approved tool call — a background thread running shell
      // commands under a remembered "always allow" became an endless stream of
      // notices. The runtime's own notifier already guards on
      // `detail.pending_approvals` (runtime_api/notification_delivery.rs);
      // this is that same guard on the GUI side.
      //
      // Reading it from the summary cannot miss a *real* request: the runtime
      // registers the pending approval before it sequences the event
      // ("Register before sequencing the event" in runtime_threads.rs), so any
      // event we have already seen is visible to a fetch issued afterwards.
      if (authoritativeAttention > 0) {
        this.notifyBackgroundAttention(sum.id);
      } else {
        st.notifiedAttention = false;
      }
    }
    for (const id of wanted) {
      const st = this.backgroundThreads.get(id)!;
      this.startBackgroundWatch(id, st.lastEventSeq > 0 ? st.lastEventSeq : ChatProvider.UNWATCHED_SINCE_SEQ);
    }
    for (const [id, controller] of this.watchControllers) {
      if (wanted.has(id)) continue;
      const st = this.backgroundThreads.get(id);
      // Keep watching a thread whose goal is still active so continuation
      // turns and completion are observed (the runtime drives them alone).
      if (st?.goalChecked && st.goal?.status === "active") continue;
      controller.abort();
      this.watchControllers.delete(id);
    }
    // Drop cursor state for threads the summary no longer reports as busy and
    // that have no live stream: an aborted watcher or a park that never armed
    // one otherwise leaves its entry (and its sticky `running`) behind for the
    // rest of the session.
    for (const [id, st] of this.backgroundThreads) {
      if (wanted.has(id) || this.watchControllers.has(id)) continue;
      if (st.goalChecked && st.goal?.status === "active") continue;
      this.backgroundThreads.delete(id);
    }
  }

  private handleBackgroundEvent(threadId: string, event: RuntimeEvent): void {
    const st = this.backgroundThreads.get(threadId);
    if (!st) {
      this.stopBackgroundWatch(threadId);
      return;
    }
    st.lastEventSeq = event.seq;
    switch (event.event) {
      case "turn.lifecycle": {
        const pl = event.payload as { status?: string };
        if (pl.status === "running" || pl.status === "in_progress" || pl.status === "queued") {
          st.running = true;
          if (event.turn_id) st.currentTurnId = event.turn_id;
        }
        break;
      }
      case "turn.completed": {
        st.running = false;
        st.currentTurnId = null;
        void this.autoSaveSessionForThread(threadId);
        if (st.goalChecked && st.goal) void this.refreshBackgroundGoal(threadId);
        this.scheduleThreadListRefresh();
        this.refreshSessionList();
        // A finished task turn changes the Tasks panel too.
        this.refreshTaskList();
        break;
      }
      case "approval.required":
      case "user_input.required": {
        // Fast path for the rail badge only. Whether this is really the user's
        // turn to act is decided from the authoritative pending count in
        // syncBackgroundWatchers — see the note there.
        st.attention += 1;
        this.scheduleThreadListRefresh();
        // The rail card is not the only surface: the Tasks panel reads the same
        // pending approvals off the task's thread (enrichTaskSummary), so a
        // background task must not keep showing a stale badge while the watch
        // is already telling the user it needs them.
        this.refreshTaskList();
        break;
      }
      case "approval.decided":
      case "approval.timeout":
      case "user_input.answered":
      case "user_input.canceled": {
        st.attention = Math.max(0, st.attention - 1);
        // `notifiedAttention` is deliberately NOT cleared here. Clearing it on
        // an event-derived zero re-armed the notice while a real approval was
        // still unanswered: one auto-approved tool call in between would drop
        // the latch to false, and the next summary refresh would then announce
        // the same still-pending approval a second time. The latch is owned by
        // the summary, which is the only place that knows the truth.
        // Only the user-input events carry an id from the map we keep here;
        // approval ids belong to a different namespace and are never cached.
        if (event.event === "user_input.answered" || event.event === "user_input.canceled") {
          const inputId = (event.payload as { id?: string }).id;
          if (inputId) this.backgroundUserInputs.delete(inputId);
        }
        this.scheduleThreadListRefresh();
        // The badge has to come down the same way it went up.
        this.refreshTaskList();
        break;
      }
      case "thread_goal_updated": {
        void this.refreshBackgroundGoal(threadId);
        break;
      }
      default:
        // item.* deltas for a non-viewed thread are intentionally ignored.
        break;
    }
    if (!st.running && st.attention <= 0 && !(st.goalChecked && st.goal?.status === "active")) {
      this.stopBackgroundWatch(threadId);
      this.backgroundThreads.delete(threadId);
    }
  }

  /** VS Code-native attention notice for a background thread. Called only from
   *  `syncBackgroundWatchers`, and only with an authoritative nonzero pending
   *  count, so it fires once per "attention episode" (the latch clears when
   *  that count returns to 0). Never call this from a raw `approval.required`
   *  event: the runtime emits those for approvals it resolves itself. */
  private notifyBackgroundAttention(threadId: string): void {
    const enabled = vscode.workspace
      .getConfiguration("brotherwhale")
      .get("backgroundThreadNotifications", true);
    if (!enabled) return;
    const st = this.backgroundThreads.get(threadId);
    if (!st || st.notifiedAttention) return;
    st.notifiedAttention = true;
    const title = this.threadTitles.get(threadId) || threadId.slice(0, 8);
    const open = t().backgroundAttentionOpen;
    vscode.window
      .showInformationMessage(
        t().backgroundAttentionNotification.replace("{title}", title),
        open,
      )
      .then((choice) => {
        if (choice === open) void this.loadThread(threadId);
      });
  }

  /** Debounced refresh so a burst of watcher events costs one summary fetch. */
  private scheduleThreadListRefresh(delayMs = 500): void {
    if (this.threadListRefreshTimer) return;
    this.threadListRefreshTimer = setTimeout(() => {
      this.threadListRefreshTimer = null;
      void this.refreshThreadList();
    }, delayMs);
  }

  /**
   * Discover attention that no watch can see yet.
   *
   * Everything else in this file reacts: a watch exists because a summary
   * refresh said the thread was busy, and the events that would open one only
   * arrive on a watch we already hold. A task or a goal started somewhere else
   * — the CLI, another window, the TUI — can therefore be waiting on an
   * approval that nothing here observes, and no amount of listening fixes it.
   * This sweep is that bootstrap: one quiet summary fetch, no rail republish,
   * and the next pass is chained after the previous one finishes rather than
   * fired on a fixed interval (the fetch has been measured at 25s on a large
   * store, so a fixed interval would stack them).
   */
  private startAttentionDiscoveryPoll(): void {
    this.attentionDiscoveryActive = true;
    this.scheduleAttentionDiscovery();
  }

  private stopAttentionDiscoveryPoll(): void {
    this.attentionDiscoveryActive = false;
    if (this.attentionDiscoveryTimer) {
      clearTimeout(this.attentionDiscoveryTimer);
      this.attentionDiscoveryTimer = null;
    }
  }

  private scheduleAttentionDiscovery(
    delayMs: number = ChatProvider.ATTENTION_DISCOVERY_MS,
  ): void {
    if (!this.attentionDiscoveryActive || this.attentionDiscoveryTimer) return;
    this.attentionDiscoveryTimer = setTimeout(() => {
      this.attentionDiscoveryTimer = null;
      void this.discoverBackgroundAttention()
        .catch(() => undefined)
        .then(() => this.scheduleAttentionDiscovery());
    }, delayMs);
  }

  /**
   * One discovery pass, gated on there being anything it could find.
   *
   * The summary walk is the expensive half (25s measured on a large store), so
   * it only runs when a thread this window already tracks exists, or when the
   * task list — small, and shared with every window on this workspace — still
   * holds something unfinished. An idle window with neither spends one small
   * request per tick and never touches the summary store.
   *
   * What the gate gives up: a window that knows of no thread and no task cannot
   * discover one that was started elsewhere in the meantime. That case waits for
   * the next foreground refresh (a user action, or a turn of this window) — the
   * alternative is walking the summary store every 30 seconds, forever.
   */
  private async discoverBackgroundAttention(): Promise<void> {
    if (this.backgroundThreads.size === 0 && !(await this.hasUnfinishedTask())) return;
    await this.refreshThreadList(true);
  }

  private async hasUnfinishedTask(): Promise<boolean> {
    try {
      const currentWorkspace =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.tuiWorkspace ?? undefined;
      const result = await this.api.listTasks({
        limit: 50,
        workspace: !this.showAllWorkspaces ? currentWorkspace : undefined,
      });
      return result.tasks.some((task) => !this.isTerminalTaskStatus(task.status));
    } catch {
      // A gate that cannot be read must not become a silent skip: one summary
      // fetch costs less than never noticing that something needs the user.
      return true;
    }
  }

  /** Auto-save a background thread's completed turn as a session (same
   *  thread → same session via PUT with session_id, mirroring the current
   *  view's autoSaveSession). Best-effort: the durable transcript lives in
   *  the runtime thread store either way — this only keeps the Sessions
   *  list fresh. */
  private async autoSaveSessionForThread(threadId: string): Promise<void> {
    if (!this.apiCapabilities.saveSession) return;
    if (this.backgroundSavingThreads.has(threadId)) return;
    this.backgroundSavingThreads.add(threadId);
    try {
      const st = this.backgroundThreads.get(threadId);
      const result = await this.api.saveCurrentSession(threadId, st?.sessionId ?? undefined);
      if (st) st.sessionId = result.session_id;
    } catch {
      // best-effort
    } finally {
      this.backgroundSavingThreads.delete(threadId);
    }
  }

  private async refreshBackgroundGoal(threadId: string): Promise<void> {
    const st = this.backgroundThreads.get(threadId);
    if (!st) return;
    try {
      st.goal = await this.api.getThreadGoal(threadId);
    } catch {
      st.goal = null;
    }
    st.goalChecked = true;
    // Republish the goal panel so background goal cards stay current.
    if (this.currentThread && this.currentThread.id !== threadId) {
      void this.refreshGoal();
    }
  }

  /** Fetch a background thread's pending approvals / user inputs for inline
   *  answering from the sidebar. Approval ids are global one-shot
   *  capabilities (`POST /v1/approvals/{id}` has no thread dimension), and
   *  user inputs name their thread, so both are answerable without
   *  switching. */
  private async handleShowThreadAttention(threadId: string): Promise<void> {
    if (threadId === this.currentThread?.id) return;
    try {
      const detail = await this.api.getThreadDetail(threadId);
      const approvals = detail.pending_approvals || [];
      const inputs = detail.pending_user_inputs || [];
      for (const req of inputs) {
        this.backgroundUserInputs.set(req.id, {
          threadId,
          questions: req.request.questions,
          answers: [],
          answeredQuestions: new Set(),
        });
      }
      this.postMessage({ type: "threadAttention", threadId, approvals, inputs });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to load thread attention", err),
      });
    }
  }

  /** Park the outgoing thread instead of interrupting it: the runtime keeps
   *  the turn running server-side, so record the cursor + pending counts and
   *  open a background watch. Mirrors the upstream web client's switch
   *  behaviour (selectThread → stopStream, never interrupt). */
  private parkCurrentThread(): void {
    const thread = this.currentThread;
    // A thread whose goal is still Active keeps working after the view leaves
    // it, and not only while a turn is in flight: the runtime arms the next
    // continuation pass itself (it is what keeps the loop alive for a thread
    // nobody is watching). The watcher already keeps such a watch — it is only
    // dropped when the thread is neither running, nor waiting, nor goal-active
    // — so arming it here is the other half of that same rule.
    const goalActive =
      !!thread && this.currentGoal?.status === "active" && this.currentGoal.thread_id === thread.id;
    if (thread && (this.currentTurnId || this.pendingApprovals.size > 0 || this.pendingUserInputs.size > 0 || goalActive)) {
      const st = this.ensureBackgroundState(thread.id);
      st.lastEventSeq = this.lastEventSeq;
      // The parked thread keeps writing to the session it is bound to. Seeded
      // from what this client is holding for it — not from the record — because
      // a binding it deliberately dropped (`forgetSessionBinding`) must not come
      // back through the background path.
      st.sessionId ??= this.currentSessionId;
      if (this.currentTurnId) {
        st.currentTurnId = this.currentTurnId;
        st.running = true;
      }
      st.attention = Math.max(st.attention, this.pendingApprovals.size + this.pendingUserInputs.size);
      // `parked: true` — currentThread still names this thread until the
      // caller resets it, and the whole point of parking is to keep watching.
      this.startBackgroundWatch(thread.id, this.lastEventSeq, true);
      if (this.currentTurnId) {
        this.postMessage({ type: "status", text: t().turnContinuesInBackground });
      }
    }
    this.abortEventStream();
    this.stopPeriodicTaskRefresh();
  }

  private abortEventStream(): void {
    this.eventController?.abort();
    this.eventController = null;
  }

  private stopPeriodicTaskRefresh(): void {
    if (this.taskRefreshTimer) {
      clearInterval(this.taskRefreshTimer);
      this.taskRefreshTimer = null;
    }
  }

  public async handleInterrupt(): Promise<void> {
    if (this.currentThread) {
      try {
        await this.api.ensureReady();

        // A Stop the client cannot attribute to a turn id still has to reach
        // the engine. The id is missing exactly when the turn was not started
        // here — another client started it, or this view parked the thread and
        // left it running — and in those cases clearing only the view would
        // leave the thread busy, which is the state that refuses the next send.
        const turnId = this.currentTurnId ?? (await this.activeTurnFromEngine())?.id;
        if (turnId) {
          try {
            await this.api.interruptTurn(this.currentThread.id, turnId);
          } catch {
            // ignore - turn may already be completed
          }
        }

        this.currentTurnId = null;
        // Clear pending approvals immediately so the UI doesn't leave
        // approval bars visible while waiting for the turn.completed
        // event (which may be delayed or missed if the SSE stream
        // reconnects).  The turn.completed handler also clears these,
        // but this ensures the UI is responsive right away.
        //
        // Retiring the status on the way out is part of that: the webview
        // draws an approval's buttons from the tool call's own state, so a
        // re-render before turn.completed lands (view switch, reopened
        // sidebar, restored session) would otherwise offer buttons for an
        // approval this client has already dropped. Same retirement the
        // terminal path does, and the same the approval timeout does —
        // including rows a rebuilt conversation still names.
        this.retireApproval(null, "error");
        this.postMessage({ type: "turnInterrupted" });
      } catch {
        // ignore
      }
    }
  }

  /** The engine's refusal to start a turn on a thread that already has one
   *  (runtime_threads.rs `start_turn` → 409 "Thread already has an active
   *  turn"). Unlike the other refusals on the send path it names a state the
   *  user can act on, so it is recovered from instead of reported: the turn it
   *  refuses the prompt for is still there, and it is the way out. */
  private isActiveTurnRefusal(err: unknown): boolean {
    const message = getErrorMessage(err);
    return message.includes("API error 409") && message.includes("already has an active turn");
  }

  /** The turn the engine currently holds for this thread, as the engine sees
   *  it.
   *
   *  The GUI only knows turn ids for turns it started or adopted; a turn that
   *  another client started, or that this view parked and left running, lives
   *  only in the engine's active slot. Both Stop and the refusal recovery need
   *  that id, and the thread record is where the runtime publishes it — the
   *  same `in_progress`/`queued` rule `loadHistory` adopts a running turn by.
   *
   *  Returns undefined when the thread has no running turn and when the read
   *  itself failed: a read that answers nothing leaves callers on the state
   *  they already had rather than reporting a second failure. */
  private async activeTurnFromEngine(): Promise<TurnRecord | undefined> {
    const thread = this.currentThread;
    if (!thread) return undefined;
    try {
      const detail = await this.api.getThreadDetail(thread.id);
      const lastTurn = detail.turns[detail.turns.length - 1];
      if (lastTurn && (lastTurn.status === "in_progress" || lastTurn.status === "queued")) {
        return lastTurn;
      }
    } catch {
      // best-effort read
    }
    return undefined;
  }

  /** Resume observing a turn the engine is already running on this thread:
   *  record its id so Stop can interrupt it, give its output a streaming
   *  message to land in, and tell the webview the turn is live (the send/stop
   *  button follows that message). Without the id, `handleInterrupt` has
   *  nothing to interrupt, so the composer would offer a Stop button that
   *  cannot stop anything and a Send button the engine keeps refusing. */
  private adoptActiveTurn(turn: TurnRecord): void {
    this.currentTurnId = turn.id;
    this.activeTurnMode = { turnId: turn.id, mode: this.turnMode(turn) };
    this.ensureAssistantPlaceholderForExternalTurn();
    this.startPeriodicTaskRefresh();
    // An open stream for this thread is already delivering this turn's events;
    // re-subscribing would only re-read what it is about to deliver. With no
    // stream (a parked thread, an engine restarted under us) the turn would
    // otherwise never report its completion.
    if (!this.eventController) this.subscribeToEvents();
    this.postMessage({ type: "turnStarted", turnId: turn.id });
  }

  /** Recover a send the engine refused for the thread's own running turn.
   *
   *  The refusal happens before the engine creates a turn, so the prompt was
   *  never accepted: the optimistic user bubble has to be retracted and the
   *  text (and its attachments) handed back, because the transcript must not
   *  claim a message the thread does not have, and the user's next move is to
   *  stop the turn that blocked them rather than retype what they wrote. The
   *  streaming placeholder stays — it is where the running turn's output
   *  lands, and `adoptActiveTurn` turns the composer's send button into a Stop
   *  button that this turn answers to.
   *
   *  Returns true when a running turn was adopted. False means the turn ended
   *  between the refusal and the read — there is nothing left to stop, so the
   *  caller reports the refusal with the text already restored. */
  private async recoverRefusedSend(
    userMsgId: string,
    text: string,
    attachments: readonly AttachmentRecord[]
  ): Promise<boolean> {
    // Read the running turn before touching the transcript: this await is the
    // window in which the turn can still finish, and the retraction below is
    // the same either way.
    const turn = await this.activeTurnFromEngine();

    const idx = this.messages.findIndex((m) => m.id === userMsgId);
    if (idx >= 0) {
      this.messages.splice(idx, 1);
      this.postMessage({ type: "removeMessage", messageId: userMsgId });
    }
    this.restoreComposerText(text);
    if (attachments.length > 0) {
      this.currentAttachments = [...attachments];
      this.postAttachmentsChanged();
    }

    if (!turn) return false;
    this.adoptActiveTurn(turn);
    this.postMessage({ type: "info", message: t().sendRefusedActiveTurn });
    return true;
  }

  // confirmSwitchWhenActive was removed: switching no longer interrupts a
  // running turn. The runtime owns every turn and keeps it running when the
  // client walks away, so there is nothing to confirm — parkCurrentThread()
  // opens a background watch instead. Interruption stays explicit (Stop).

  /**
   * Undo the last turn, fully aligned with TUI's `/undo` command:
   * 1. Try snapshot-based file rollback (patch_undo)
   * 2. Remove the last conversation turn (fork_at_user_message)
   * 3. Save the updated session
   */
  public async handleUndoLastTurn(): Promise<void> {
    if (!this.apiCapabilities.threadPatchUndo) {
      this.postMessage({ type: "info", message: t().undoNotSupported });
      return;
    }

    // If viewing a session (not a live thread), resume it first.
    if (this.viewingSessionId && !this.currentThread) {
      try {
        await this.api.ensureReady();
        const sessionId = this.viewingSessionId;
        // Stash cost before resume — loadThread will zero stats.
        const session = await this.api.getSession(sessionId);
        const cost = session.metadata.cost;
        if (cost) {
          this.pendingSessionCost = {
            sessionCostUsd: cost.session_cost_usd || 0,
            sessionCostCny: cost.session_cost_cny || 0,
            subagentCostUsd: cost.subagent_cost_usd || 0,
            subagentCostCny: cost.subagent_cost_cny || 0,
            displayedCostHighWaterUsd: cost.displayed_cost_high_water_usd || 0,
            displayedCostHighWaterCny: cost.displayed_cost_high_water_cny || 0,
            totalTokens: session.metadata.total_tokens || 0,
            cumulativeTurnSecs: session.metadata.cumulative_turn_secs || 0,
          };
        }
        const result = await this.api.resumeSessionThread(sessionId);
        this.viewingSessionId = null;
        await this.loadThread(result.thread_id);
        // Restore cost (merge with max — see the resume-restore comment
        // above) and preserve original session ID for auto-save.
        if (this.pendingSessionCost) {
          this.sessionCostUsd = Math.max(this.sessionCostUsd, this.pendingSessionCost.sessionCostUsd);
          this.sessionCostCny = Math.max(this.sessionCostCny, this.pendingSessionCost.sessionCostCny);
          this.displayedCostHighWaterUsd = Math.max(this.displayedCostHighWaterUsd, this.pendingSessionCost.displayedCostHighWaterUsd);
          this.displayedCostHighWaterCny = Math.max(this.displayedCostHighWaterCny, this.pendingSessionCost.displayedCostHighWaterCny);
          this.totalTokens = Math.max(this.totalTokens, this.pendingSessionCost.totalTokens);
          this.cumulativeTurnSecs = Math.max(this.cumulativeTurnSecs, this.pendingSessionCost.cumulativeTurnSecs);
          this.pendingSessionCost = null;
          this.sendSessionStats();
        }
        this.currentSessionId = sessionId;
        this.refreshSessionList();
      } catch (err) {
        this.postMessage({ type: "error", message: formatError("Failed to resume session", err) });
        return;
      }
    }

    if (!this.currentThread) {
      this.postMessage({ type: "info", message: t().undoNoTurns });
      return;
    }

    try {
      await this.api.ensureReady();

      // The engine owns the trust decision, because it is the only side that
      // knows whether a rollback target actually exists. That lets it tell
      // "nothing to revert" (fork the turn, touch no files) apart from
      // "something to revert but this thread is not trusted" (refuse outright,
      // fork nothing). The GUI must not second-guess it by picking an endpoint,
      // or the two surfaces drift into "one refuses while the other silently
      // half-undoes" — a fork whose file changes stay on disk is a workspace
      // the transcript can no longer account for.
      const result = await this.api.patchUndoThreadTurn(this.currentThread.id);

      // Report the file outcome either way. Staying silent when nothing was
      // restored is how a user comes to believe their workspace was rolled
      // back when it was not.
      if (result.patch_result.summary) {
        this.postMessage({ type: "info", message: result.patch_result.summary });
      }

      // Which document the thread being forked writes to. A runtime that gives
      // a fork a document of its own answers with a different id below; one that
      // predates that hands the fork the source's id.
      const forkedFromSession = this.currentSessionId;

      // Switch to the new forked thread.
      this.currentThread = result.thread;
      this.messages = [];
      this.turnFileChanges = [];
      this.currentTurnId = null;
      this.activeItems.clear();
      this.currentTextBlockIdx = -1;
      this.currentThinkingBlockIdx = -1;
      this.lastEventSeq = 0;

      // Load the forked thread's history.
      await this.loadThread(result.thread.id);
      // A fork's history is a prefix of the thread it came from, so that
      // thread's document is the one it must not rewrite: `PUT /v1/sessions`
      // replaces the stored transcript, and the source thread would be left
      // describing bytes that are gone. Nothing to do when the runtime gave the
      // fork a document of its own.
      if (this.currentSessionId && this.currentSessionId === forkedFromSession) {
        this.forgetSessionBinding();
      }

      // Put the user's message back in the input box so they can edit & re-send.
      if (result.original_user_text) {
        this.postMessage({ type: "setInputText", text: result.original_user_text });
      }

      this.postMessage({
        type: "info",
        message: t().undoSuccess(result.thread.id),
      });
      this.refreshWorkPanel();
      this.refreshSessionList();
      this.postMessage({ type: "historyUpdated" });
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("exceeds") || msg.includes("No user turn")) {
        this.postMessage({ type: "info", message: t().undoNoTurns });
      } else if (msg.includes("outside trusted mode")) {
        // An expected refusal, not a failure: the engine declined to roll the
        // workspace back and said how to enable it. Surface that sentence on
        // its own rather than wrapping a deliberate policy answer in HTTP
        // framing ("Undo failed: API error 409: …").
        this.postMessage({ type: "info", message: msg.replace(/^API error \d+: /, "") });
      } else {
        this.postMessage({ type: "error", message: formatError("Undo failed", err) });
      }
    }
  }

  /**
   * Retry the last turn via the server-side undo + re-send API.
   * This creates a new thread with the last turn removed and immediately
   * starts a new turn with the original user message, matching TUI's
   * `retry` behavior.
   */
  public async handleRetryLastTurn(): Promise<void> {
    if (!this.apiCapabilities.threadRetry) {
      this.postMessage({ type: "info", message: t().retryNotSupported });
      return;
    }

    // If viewing a session (not a live thread), resume it first.
    if (this.viewingSessionId && !this.currentThread) {
      try {
        await this.api.ensureReady();
        const sessionId = this.viewingSessionId;
        // Stash cost before resume — loadThread will zero stats.
        const session = await this.api.getSession(sessionId);
        const cost = session.metadata.cost;
        if (cost) {
          this.pendingSessionCost = {
            sessionCostUsd: cost.session_cost_usd || 0,
            sessionCostCny: cost.session_cost_cny || 0,
            subagentCostUsd: cost.subagent_cost_usd || 0,
            subagentCostCny: cost.subagent_cost_cny || 0,
            displayedCostHighWaterUsd: cost.displayed_cost_high_water_usd || 0,
            displayedCostHighWaterCny: cost.displayed_cost_high_water_cny || 0,
            totalTokens: session.metadata.total_tokens || 0,
            cumulativeTurnSecs: session.metadata.cumulative_turn_secs || 0,
          };
        }
        const result = await this.api.resumeSessionThread(sessionId);
        this.viewingSessionId = null;
        await this.loadThread(result.thread_id);
        // Restore cost (merge with max — see the resume-restore comment
        // above) and preserve original session ID for auto-save.
        if (this.pendingSessionCost) {
          this.sessionCostUsd = Math.max(this.sessionCostUsd, this.pendingSessionCost.sessionCostUsd);
          this.sessionCostCny = Math.max(this.sessionCostCny, this.pendingSessionCost.sessionCostCny);
          this.displayedCostHighWaterUsd = Math.max(this.displayedCostHighWaterUsd, this.pendingSessionCost.displayedCostHighWaterUsd);
          this.displayedCostHighWaterCny = Math.max(this.displayedCostHighWaterCny, this.pendingSessionCost.displayedCostHighWaterCny);
          this.totalTokens = Math.max(this.totalTokens, this.pendingSessionCost.totalTokens);
          this.cumulativeTurnSecs = Math.max(this.cumulativeTurnSecs, this.pendingSessionCost.cumulativeTurnSecs);
          this.pendingSessionCost = null;
          this.sendSessionStats();
        }
        this.currentSessionId = sessionId;
        this.refreshSessionList();
      } catch (err) {
        this.postMessage({ type: "error", message: formatError("Failed to resume session", err) });
        return;
      }
    }

    if (!this.currentThread) {
      this.postMessage({ type: "info", message: t().retryNoTurns });
      return;
    }

    try {
      await this.api.ensureReady();

      const result = await this.api.retryThreadTurn(this.currentThread.id);

      // Which document the thread being retried writes to — see the same
      // capture in `handleUndoLastTurn`.
      const forkedFromSession = this.currentSessionId;

      // Switch to the new forked thread and subscribe to its events.
      this.currentThread = result.thread;
      this.messages = [];
      this.turnFileChanges = [];
      this.currentTurnId = result.turn.id;
      this.activeItems.clear();
      this.currentTextBlockIdx = -1;
      this.currentThinkingBlockIdx = -1;
      this.lastEventSeq = 0;

      // Load the forked thread's history.
      await this.loadThread(result.thread.id);
      // Same reason as `handleUndoLastTurn`: the retried thread's document is
      // the one this fork must not rewrite.
      if (this.currentSessionId && this.currentSessionId === forkedFromSession) {
        this.forgetSessionBinding();
      }

      this.postMessage({
        type: "info",
        message: t().retrySuccess(result.thread.id),
      });
      this.refreshWorkPanel();
      this.refreshSessionList();
      this.postMessage({ type: "historyUpdated" });
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes("exceeds") || msg.includes("No user") || msg.includes("no user text")) {
        this.postMessage({ type: "info", message: t().retryNoTurns });
      } else {
        this.postMessage({ type: "error", message: formatError("Retry failed", err) });
      }
    }
  }

  /**
   * Restore one change from the Changes panel.
   *
   * Uses the engine's file-scoped `file-revert` endpoint, never
   * `restoreSnapshot`: the snapshot restore endpoint restores the whole
   * workspace, so using it for "revert one file" would silently roll back
   * every other file the session touched.
   *
   * The callers name the change they are showing — the engine's
   * `tool:<call_id>` restore point taken before that tool call — and only that
   * record is dropped afterwards. Earlier changes to the same file are still
   * on disk, so they stay listed and stay revertable.
   *
   * When the connected engine predates the endpoint the button renders
   * disabled (see `getWebviewCapabilities`); replayed messages are refused
   * here as well rather than falling back to a workspace-wide restore.
   */
  private async handleRevertFileChange(
    filePath: string,
    _changeType: string,
    _diff: string | undefined,
    callId?: string
  ): Promise<void> {
    if (!this.apiCapabilities.threadFileRevert) {
      // Reject old/replayed webview messages as well as hiding the button.
      this.postMessage({ type: "info", message: t().revertNotSupported });
      return;
    }
    if (!this.currentThread) {
      this.postMessage({ type: "info", message: t().undoNoTurns });
      return;
    }

    const changesForPath = this.turnFileChanges.filter(
      (fc) => normalizePath(fc.filePath) === normalizePath(filePath)
    );
    // The card names the tool call that produced the change it is showing. A
    // message without one (an older webview bundle, or a replayed action)
    // falls back to the file's most recent change, which is what that button
    // always meant.
    const record = callId
      ? changesForPath.find((fc) => fc.callId === callId)
      : changesForPath[changesForPath.length - 1];

    // The engine restores exactly the restore point the client names; it never
    // picks "the newest snapshot that differs". The panel's identity for a
    // change is the tool call that produced it — the engine snapshots the
    // workspace as `tool:<call_id>` before every file-modifying call — so a
    // record without that id has nothing safe to name.
    if (!record?.callId) {
      this.postMessage({ type: "info", message: t().revertNoSnapshot });
      return;
    }

    try {
      await this.api.ensureReady();

      // Prove the revision before asking. An unprovable digest is refused
      // here rather than replaced by one taken at request time: the engine's
      // check for "the file moved since the review" can only protect the
      // user's own edits if the client sends the revision it actually showed.
      const expectedHash = this.expectedHashFor(record);
      if (!expectedHash) {
        this.postMessage({ type: "info", message: t().revertUnreadableFile });
        return;
      }

      const snapshotId = await this.findSnapshotId(`tool:${record.callId}`);
      if (!snapshotId) {
        this.postMessage({ type: "info", message: t().revertNoSnapshot });
        return;
      }

      const reverted = await this.api.revertThreadFile(this.currentThread.id, {
        path: record.filePath || filePath,
        snapshotId,
        expectedHash,
      });

      // Drop only the change that was unwound: earlier changes to the same
      // file are still on disk, so their records stay reviewable.
      this.turnFileChanges = this.turnFileChanges.filter((fc) => fc !== record);
      this.reindexFileChanges();
      this.refreshChangesPanel();
      this.postMessage({
        type: "info",
        message: t().revertSuccess(reverted.path || filePath),
      });
    } catch (err) {
      if (this.explainRevertRefusal(getErrorMessage(err), record)) return;
      this.postMessage({
        type: "error",
        message: formatError(t().revertFailed, err),
      });
    }
  }

  /** The `tool:<call_id>` restore point that preceded a recorded change, if the
   *  engine still lists it. The listing is workspace-wide and capped at 100 by
   *  the endpoint, so a pruned or aged-out snapshot reads as "not there" and
   *  the caller explains that instead of reverting some other revision. */
  private async findSnapshotId(label: string): Promise<string | undefined> {
    try {
      const snapshots = await this.api.listSnapshots({ limit: 100 });
      return snapshots.find((snapshot) => snapshot.label === label)?.id;
    } catch {
      return undefined;
    }
  }

  /** Roots for resolving a path the runtime recorded, engine workspace first:
   *  the engine hashes and restores the file *it* sees, so resolving against a
   *  different folder would describe a different revision. */
  private revertPathRoots(): string[] {
    const roots = [this.currentThread?.workspace, ...this.recordedPathRoots()];
    return roots.filter((root, index): root is string => !!root && roots.indexOf(root) === index);
  }

  private hashCurrentFile(filePath: string): string | undefined {
    const absPath = resolveRecordedFilePath(
      filePath,
      this.revertPathRoots(),
      defaultTasksDir()
    );
    return sha256OfFile(absPath);
  }

  /**
   * The digest the file-revert endpoint expects for a change record.
   *
   * A record carries the digest taken while it was recorded, so the engine can
   * tell "the user edited this file after the panel showed it" apart from
   * "restore as reviewed". Records rebuilt from an earlier session have no
   * such capture — the panel rebuilt them against the file's current contents,
   * so their digest is taken now. `undefined` means the revision cannot be
   * proved, and the caller refuses rather than send a digest it never saw.
   */
  private expectedHashFor(change: FileChangeInfo): string | undefined {
    return change.expectedHash ?? this.hashCurrentFile(change.filePath);
  }

  /**
   * Record the revision a change was recorded from, at the moment it is
   * recorded — before the user can edit the file behind the panel's back.
   *
   * Best-effort by design: a file too large to hash cheaply, or one that cannot
   * be read, simply leaves the record without a digest, and `expectedHashFor`
   * falls back to the current bytes when the user acts on it.
   */
  private stampReviewedHash(change: FileChangeInfo): void {
    if (!change.callId) return;
    const absPath = resolveRecordedFilePath(
      change.filePath,
      this.revertPathRoots(),
      defaultTasksDir()
    );
    const hash = sha256OfFile(absPath, { maxBytes: MAX_EAGER_HASH_BYTES });
    if (hash === undefined) return;
    // "absent" is a claim that the panel saw a deletion. Any other missing
    // path is a resolution problem, not a fact about the file.
    if (hash === "absent" && change.changeType !== "deleted") return;
    change.expectedHash = hash;
  }

  /**
   * Turn an engine refusal into the sentence the user needs, and refresh what
   * the engine reported as stale. Returns true when it was handled here.
   *
   * A 409 is a decision, not a failure: the engine declines exactly because the
   * client cannot see whether a restore point exists, is current, or is allowed
   * by the thread's trust. Reporting it as "Revert failed: API error 409" hides
   * the one piece of guidance that resolves it.
   */
  private explainRevertRefusal(message: string, record: FileChangeInfo): boolean {
    if (message.includes("outside trusted mode")) {
      this.postMessage({ type: "info", message: t().revertUntrusted });
      return true;
    }
    if (message.includes("changed after the selected change record")) {
      // The engine refused because the file moved since the panel recorded it.
      // Re-read the bytes now and keep them on the record, so the next click is
      // the deliberate re-review the engine asks for rather than a digest
      // invented at request time.
      record.expectedHash = this.hashCurrentFile(record.filePath);
      this.postMessage({ type: "info", message: t().revertFileChanged });
      return true;
    }
    if (message.includes("already matches snapshot")) {
      this.postMessage({ type: "info", message: t().revertNothingToRevert });
      return true;
    }
    if (
      message.includes("restore point is unavailable") ||
      message.includes("belongs to another session")
    ) {
      this.postMessage({ type: "info", message: t().revertStaleRecord });
      return true;
    }
    if (message.includes("active turn") || message.includes("is not available")) {
      this.postMessage({ type: "info", message: t().revertBusy });
      return true;
    }
    if (message.includes("no bound session")) {
      this.postMessage({ type: "info", message: t().revertNoSnapshot });
      return true;
    }
    return false;
  }

  public async handleCompact(): Promise<void> {
    if (this.currentThread) {
      try {
        await this.api.compactThread(this.currentThread.id);
        this.postMessage({ type: "info", message: "Context compacted" });
      } catch (err) {
        this.postMessage({
          type: "error",
          message: formatError("Compact failed", err),
        });
      }
    }
  }

  private async handleSlashCommand(command: string, args: string): Promise<void> {
    await this.slashHandler.handle(command, args);
  }

  /** Switch this thread's permission posture. Patches only
   *  `permission_posture` so the runtime derives `auto_approve` / `trust_mode`
   *  from the posture instead of the GUI sending stale cached booleans.
   *
   *  Thread-scoped on purpose: the startup default for *new* threads is a
   *  separate setting with its own dropdown group (`setDefaultPosture`), so a
   *  change here cannot silently move it. */
  private async handleSetPosture(posture: string): Promise<void> {
    const normalized = normalizePosture(posture);
    const wire = POSTURE_WIRE[normalized];

    let effective: PermissionPosture = normalized;
    let infoMessage: string;
    if (!this.currentThread) {
      // Threadless view (a new chat, or a saved session being viewed): the
      // startup default is the only scope a posture choice can move, and the
      // toast names it instead of letting the click land nowhere.
      await vscode.workspace.getConfiguration("brotherwhale").update(
        "defaultPermissionPosture",
        wire,
        vscode.ConfigurationTarget.Global,
      );
      this.postScopedDefaults();
      infoMessage = `No conversation yet — new threads will start with ${POSTURE_LABELS[normalized]}`;
    } else {
      try {
        const updated = await this.api.updateThread(this.currentThread.id, {
          permission_posture: wire,
        });
        this.currentThread = mergeThreadRecord(this.currentThread, updated, {
          permission_posture: wire,
        });
      } catch (err) {
        this.postMessage({
          type: "error",
          message: formatError("Failed to update permission posture", err),
        });
      }
      effective = postureFromThread(this.currentThread);
      infoMessage = `Permission posture changed to ${POSTURE_LABELS[effective]}`;
    }
    this.postMessage({
      type: "settingsUpdated",
      mode: normalizeMode(this.currentThread?.mode || this.getCurrentMode()),
      posture: effective,
      model: this.currentThread?.model || this.getCurrentModel(),
      reasoningEffort: this.getCurrentReasoningEffort(),
    });
    this.postMessage({ type: "info", message: infoMessage });
  }

  /** Approve the plan produced in plan mode: switch the thread (and the
   *  startup default) to Act, then send a follow-up turn telling the agent
   *  the mode changed so it executes the plan already in the conversation.
   *  `prompt` is whatever the user had typed in the composer when they clicked:
   *  a plan is rarely executed verbatim, so that instruction rides along with
   *  the approval instead of forcing a separate send afterwards. */
  private async handleApprovePlan(prompt?: string): Promise<void> {
    // Normalized once: it is both the instruction for the Act turn and the
    // text handed back to the composer when the approval does not go through.
    const instruction = (prompt || "").trim();
    try {
      // Switch to Act through the same path as `/mode agent` so the config
      // default and the current thread stay in sync, then let the follow-up
      // turn start with the thread's now-Act mode.
      await this.handleSlashCommand("/mode", "agent");
      // `/mode` reports a failed thread PATCH by message only and returns
      // normally, so confirm the thread actually switched before executing:
      // sending the follow-up turn while it is still in Plan mode produces
      // another plan, under an "approve & execute" button that promised Act.
      if (this.currentThread && normalizeMode(this.currentThread.mode) !== "agent") {
        this.postMessage({ type: "error", message: t().planApproveModeFailed });
        this.restoreComposerText(instruction);
        return;
      }
      // Two shapes, because one sentence cannot serve both: with no user
      // input the proceed line is the whole instruction ("execute the plan
      // above"), but appending a user override to that imperative would put
      // two conflicting orders in one message. When the user wrote something,
      // the plan stops being the order and becomes the default that their
      // instruction takes precedence over.
      await this.handleSendMessage(
        instruction
          ? `${t().planApproveWithPrompt}\n\n${instruction}`
          : t().planApproveProceed
      );
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to approve plan", err),
      });
      // Restoring here can leave the text in the composer as well as in the
      // transcript if the turn had already started and only the send failed.
      // That is recoverable — losing the instruction is not.
      this.restoreComposerText(instruction);
    }
  }

  /** Hand text back to the composer after a send that never happened. The
   *  webview clears its own input the moment the plan-approve button is
   *  clicked, so anything that stops the Act turn has to give the text back:
   *  otherwise the failure costs the user their instruction as well as the
   *  turn. No-op when the composer was empty, and harmless for a webview that
   *  cleared nothing. */
  private restoreComposerText(text: string): void {
    if (!text) return;
    this.postMessage({ type: "setInputText", text });
  }

  private async handleApprovalDecision(
    approvalId: string,
    decision: "allow" | "deny",
    remember = false
  ): Promise<void> {
    try {
      await this.api.decideApproval(approvalId, decision, remember);
      // When the user checks "remember" and allows, the runtime flips the
      // thread to Full Access (see runtime_threads.rs
      // remember_thread_auto_approve).  Mirror that locally, because the
      // foreground `approval.required` handler below decides whether to open a
      // dialog from *this* thread's posture (postureFromThread), never from the
      // runtime's — a local copy still reading "ask" would open a dialog for a
      // tool the runtime is already resolving on its own. The runtime does emit
      // a matching `approval.decided` (`"auto": true`) on that path, so such a
      // dialog would close again rather than hang; keeping the two views in
      // step is what stops the flicker.
      if (remember && decision === "allow" && this.currentThread) {
        // The runtime persists Full Access for the thread (see
        // runtime_threads.rs remember_thread_auto_approve); mirror both the
        // legacy boolean and the canonical posture so the status bar agrees
        // with the engine. Report the *thread's* mode, not the global default:
        // a loaded session may run in a mode the startup default does not name.
        this.currentThread = {
          ...this.currentThread,
          auto_approve: true,
          permission_posture: POSTURE_WIRE.full_access,
        };
        this.postMessage({
          type: "settingsUpdated",
          mode: normalizeMode(this.currentThread.mode),
          posture: POSTURE_WIRE.full_access,
          model: this.currentThread.model || this.getCurrentModel(),
          reasoningEffort: this.getCurrentReasoningEffort(),
        });
      }
      this.retireApproval(approvalId, decision === "allow" ? "running" : "error");
      this.postMessage({ type: "approvalResolved", approvalId, decision });
      await this.refreshActiveTaskDetail();
      await this.refreshTaskList();
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Approval failed", err),
      });
    }
  }

  private showApprovalDialog(
    _approvalId: string,
    _toolName: string,
    _summary: string
  ): void {
    this.view?.show?.(true);
  }

  private async handleUserInputSelect(
    inputId: string,
    questionId: string,
    _optionIdx: number,
    optionLabel: string
  ): Promise<void> {
    // Background threads register their pending inputs in a separate map
    // that survives view switches; the view's map is checked first.
    let pending = this.pendingUserInputs.get(inputId);
    let owner: "view" | "background" = "view";
    if (!pending) {
      pending = this.backgroundUserInputs.get(inputId);
      owner = "background";
    }
    if (!pending) return;

    pending.answers.push({
      id: questionId,
      label: optionLabel,
      value: optionLabel,
    });
    pending.answeredQuestions.add(questionId);

    const allAnswered = pending.questions.every(q => pending!.answeredQuestions.has(q.id));
    if (allAnswered) {
      try {
        await this.api.submitUserInput(pending.threadId, inputId, pending.answers);
        if (owner === "view") this.pendingUserInputs.delete(inputId);
        else this.backgroundUserInputs.delete(inputId);
        this.postMessage({
          type: "userInputResolved",
          inputId,
          cancelled: false,
          answers: pending.answers,
        });
        await this.refreshActiveTaskDetail();
        await this.refreshTaskList();
      } catch (err) {
        this.postMessage({
          type: "error",
          message: `${formatError("Failed to submit user input", err)}. Use /interrupt to clear the stuck turn.`,
        });
        if (owner === "view") this.pendingUserInputs.delete(inputId);
        else this.backgroundUserInputs.delete(inputId);
      }
    }
  }

  private async handleUserInputCancel(inputId: string): Promise<void> {
    const pending = this.pendingUserInputs.get(inputId) ?? this.backgroundUserInputs.get(inputId);
    try {
      if (pending) {
        await this.api.submitUserInput(pending.threadId, inputId, []);
      }
    } catch {
      // ignore cancellation errors
    }
    this.pendingUserInputs.delete(inputId);
    this.backgroundUserInputs.delete(inputId);
    this.postMessage({
      type: "userInputResolved",
      inputId,
      cancelled: true,
    });
    this.postMessage({
      type: "info",
      message: "User input cancelled. The turn will be interrupted. Use /interrupt if needed.",
    });
    await this.refreshActiveTaskDetail();
    await this.refreshTaskList();
  }

  private diffContentStore = new Map<string, string>();
  private diffProviderDisposable: vscode.Disposable | null = null;

  private ensureDiffProvider(): void {
    if (this.diffProviderDisposable) return;

    const store = this.diffContentStore;
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: undefined,
      provideTextDocumentContent(uri: vscode.Uri): string {
        return store.get(uri.toString()) || "";
      },
    };
    this.diffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider("brotherwhale-diff", provider);
  }

  /** Workspace folders of the open VSCode window, in VSCode's order. */
  private workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.fsPath)
      .filter((root): root is string => !!root);
  }

  /**
   * Roots to try when resolving a path the runtime recorded, most specific
   * first: a viewed session's own workspace, then the open window's folders.
   */
  private recordedPathRoots(): string[] {
    const roots = [this.viewingSessionWorkspace, ...this.workspaceRoots()];
    return roots.filter((root, index): root is string => !!root && roots.indexOf(root) === index);
  }

  private async handleOpenDiff(filePath: string, diff?: string, changeIndex?: number): Promise<void> {
    try {
      const absPath = resolveRecordedFilePath(filePath, this.recordedPathRoots(), defaultTasksDir());

      const diffs = this.diffsForPath(filePath);

      if (diff) {
        this.ensureDiffProvider();

        let oldContent: string;
        let newContent: string;

        if (changeIndex !== undefined && changeIndex >= 0 && changeIndex < diffs.length) {
          // Reconstruct this change's own before/after from the file's later
          // changes: a record describes one change, so the diff that opened
          // must be that change's, not the file's running total.
          try {
            const currentUri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(currentUri);
            const state = getDiffStateForIndex(diffs, doc.getText(), changeIndex);
            if (state) {
              oldContent = state.oldContent;
              newContent = state.newContent;
            } else {
              // Reconstruction failed, fall back to parsing diff
              const parsed = parseDiffToSides(diff);
              oldContent = parsed.oldContent;
              newContent = parsed.newContent;
            }
          } catch {
            const parsed = parseDiffToSides(diff);
            oldContent = parsed.oldContent;
            newContent = parsed.newContent;
          }
        } else {
          // No recorded index (a single change, or a card from a session whose
          // chain no longer lines up): read the file and reverse-apply it.
          try {
            const currentUri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(currentUri);
            newContent = doc.getText();
            const reconstructed = reconstructOldContent(newContent, diff);
            oldContent = reconstructed !== null ? reconstructed : parseDiffToSides(diff).oldContent;
          } catch {
            const parsed = parseDiffToSides(diff);
            oldContent = parsed.oldContent;
            newContent = parsed.newContent;
          }
        }

        const diffId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const oldUri = vscode.Uri.parse(`brotherwhale-diff:${absPath}?old&id=${diffId}`);
        const newUri = vscode.Uri.parse(`brotherwhale-diff:${absPath}?new&id=${diffId}`);

        this.diffContentStore.set(oldUri.toString(), oldContent);
        this.diffContentStore.set(newUri.toString(), newContent);

        const title = `${path.basename(filePath)} (Diff)`;
        await vscode.commands.executeCommand("vscode.diff", oldUri, newUri, title);
      } else {
        const currentUri = vscode.Uri.file(absPath);
        const doc = await vscode.workspace.openTextDocument(currentUri);
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      this.postMessage({ type: "error", message: formatError("Failed to open diff", err) });
    }
  }

  private async handleOpenFile(filePath: string): Promise<void> {
    try {
      // The card carries the path the runtime recorded, which for file tools is
      // workspace-relative — resolving that against the task artifacts dir
      // alone reported every ordinary edit as "no longer available".
      const normalizedAbsPath = resolveRecordedFilePath(
        filePath,
        this.recordedPathRoots(),
        defaultTasksDir(),
      );
      const preview = this.textArtifactPreviewStore.get(filePath) || this.textArtifactPreviewStore.get(normalizedAbsPath);

      if (!fs.existsSync(normalizedAbsPath)) {
        if (preview) {
          const doc = await vscode.workspace.openTextDocument({
            content: preview.content,
            language: preview.language || "plaintext",
          });
          await vscode.window.showTextDocument(doc);
          return;
        }
        void vscode.window.showWarningMessage(`Artifact file is no longer available: ${filePath}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(normalizedAbsPath));
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      this.postMessage({ type: "error", message: formatError("Failed to open file", err) });
    }
  }

  private async handleOpenExternal(url: string): Promise<void> {
    try {
      if (!url) {
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      this.postMessage({ type: "error", message: formatError("Failed to open link", err) });
    }
  }

  // ── SSE event stream ──

  private subscribeToEvents(): void {
    if (!this.currentThread) return;
    this.eventController?.abort();

    this.eventController = this.api.streamEvents(
      this.currentThread.id,
      this.lastEventSeq,
      (event: RuntimeEvent) => this.handleRuntimeEvent(event),
      (err: Error) => {
        this.postMessage({ type: "error", message: `Event stream error: ${err.message}` });
      }
    );
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    this.lastEventSeq = event.seq;

    // Drop stale events from a previous turn. SSE is ordered within a single
    // connection, but a delayed turn.completed for turn A can arrive after
    // turn B has started (e.g. across reconnects or buffered chunks). Without
    // this guard the stale turn.completed would clobber currentTurnId (set to
    // null) so every subsequent item event for turn B gets dropped by the old
    // `currentTurnId` truthiness check — the root cause of "agent responds
    // with the previous message" in multi-turn chats.
    //
    // We intentionally do NOT require currentTurnId to be set before routing
    // item events: the backend (runtime_threads.rs::start_turn) emits the
    // first item events before the HTTP response carrying the turn id reaches
    // us. Routing by lastMsg instead of currentTurnId means those early
    // deltas are appended to the new assistant message instead of being
    // dropped on the floor.
    if (event.turn_id && this.currentTurnId && event.turn_id !== this.currentTurnId) {
      this.debugLog(
        `[handleRuntimeEvent] dropping stale event seq=${event.seq} ` +
        `type=${event.event} turn=${event.turn_id} (current=${this.currentTurnId})`
      );
      return;
    }

    if (event.item_id) {
      this.handleItemEvent(event);
    }

    try {
    switch (event.event) {
      case "turn.lifecycle": {
        const pl = event.payload as { status?: string };
        if (pl.status === "completed") break;
        if (pl.status === "running" || pl.status === "in_progress") {
          this.startPeriodicTaskRefresh();
          // Server-initiated turns (goal kickoff/continuation, agent mail)
          // have no preceding user message in this.messages, so the item
          // router would drop their assistant output. Ensure a streaming
          // placeholder exists so the work is visible instead of the goal
          // appearing to stay "active" without running.
          this.ensureAssistantPlaceholderForExternalTurn();
          this.scheduleThreadListRefresh();
        }
        this.postMessage({ type: "status", text: `Turn: ${pl.status || "unknown"}` });
        break;
      }

      case "turn.completed": {
        const pl = event.payload as { turn?: TurnRecord };
        this.currentTurnId = null;
        if (pl.turn?.usage) {
          const u = pl.turn.usage;
          this.lastInputTokens = u.input_tokens;
          this.lastOutputTokens = u.output_tokens;
          this.lastCacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
          this.lastCacheMissTokens = u.prompt_cache_miss_tokens ?? Math.max(0, u.input_tokens - (u.prompt_cache_hit_tokens ?? 0));
          this.totalInputTokens += u.input_tokens;
          this.totalOutputTokens += u.output_tokens;
          this.totalTokens += u.input_tokens + u.output_tokens;
          // Cost comes from the TUI runtime (recorded-time provider rates),
          // not a client-side rate table. Fire-and-forget: the totals are
          // SET from the server response, so a delayed fetch can never
          // double-count, and the monotonic high-water mark keeps the
          // display stable meanwhile.
          void this.refreshThreadUsage();
        }

        // TUI emits turn.completed for ALL terminal turn states
        // (completed / interrupted / failed) — it never emits
        // "turn.failed" or "turn.interrupted" (see runtime_threads.rs:3492).
        // Determine the effective status from the turn record.
        const turnStatus = pl.turn?.status || "completed";
        const isTerminalError = turnStatus === "failed" || turnStatus === "interrupted";

        // Safety net: finalize any toolCalls still "running" or
        // "awaiting_approval".  If their item.completed/item.failed/
        // item.interrupted events were missed (or never sent because the
        // turn was interrupted mid-execution), the toolCall would stay
        // "running" forever and the UI would freeze on "⟳ running...".
        // This mirrors the TUI's own cleanup in runtime_threads.rs:3395.
        // Scan ALL messages, not just the last one: a mid-turn steer splits
        // the turn into multiple assistant segments, and a tool started in
        // an earlier segment can still be running when the turn ends.
        const lastMsg = this.messages[this.messages.length - 1];
        for (const msg of this.messages) {
          if (!msg.toolCalls) continue;
          for (let i = 0; i < msg.toolCalls.length; i++) {
            const tc = msg.toolCalls[i];
            if (tc.status === "running" || tc.status === "awaiting_approval") {
              tc.status = isTerminalError ? "error" : "complete";
              tc.approvalId = undefined;
              if (isTerminalError && !tc.output) {
                tc.output = turnStatus === "interrupted"
                  ? "Interrupted"
                  : (pl.turn?.error || "Turn failed");
              }
              this.postMessage({
                type: "updateToolCall",
                messageId: msg.id,
                toolCallIdx: i,
                toolName: tc.name,
                status: tc.status,
                output: tc.output,
              });
            }
          }
        }
        // Clear pending approvals and active items for this turn.
        this.pendingApprovals.clear();
        this.activeItems.clear();

        if (lastMsg?.role === "assistant") {
          // TUI parity (flush_active_cell): a streaming placeholder that
          // never received output (steer raced the turn end, or the model
          // returned nothing) is discarded, not finalized as an empty
          // bubble. loadHistory skips empty segments the same way, so the
          // live view and the reloaded view stay consistent.
          const isEmpty = lastMsg.status === "streaming" && !lastMsg.content
            && !lastMsg.thinking && !(lastMsg.toolCalls && lastMsg.toolCalls.length > 0)
            && !(lastMsg.blocks && lastMsg.blocks.length > 0);
          if (isEmpty) {
            this.messages.pop();
            // messageComplete is the webview's streaming-end signal (clears
            // the streaming flag, spinner timeout, and status bar); it is
            // sent even though the node is removed right after, because
            // removeMessage alone would leave the status bar stuck on
            // "streaming".
            this.postMessage(
              finalizeAssistantMessage(lastMsg, isTerminalError ? "error" : "complete", { usage: pl.turn?.usage }),
            );
            this.postMessage({ type: "removeMessage", messageId: lastMsg.id });
          } else {
            const payload = finalizeAssistantMessage(
              lastMsg,
              isTerminalError ? "error" : "complete",
              {
                usage: pl.turn?.usage,
                // In plan mode a successfully completed turn is the plan the
                // agent just produced; surface an "approve & execute" action
                // so the user can switch to Act and continue in one click.
                // The turn's own mode decides (the thread's may have moved on
                // since), but that is still "ran in Plan mode", not "is a
                // plan": the runtime reports nothing that marks a message as
                // *a plan* and Plan mode produces ordinary prose, so an answer
                // given in Plan mode offers the action too.
                planApproval: !isTerminalError && this.turnMode(pl.turn) === "plan",
              },
            );
            this.postMessage(payload);
          }
        }
        // Auto-save session after each completed turn (mirrors TUI's
        // build_session_snapshot → SessionSnapshot). Same thread always
        // saves to the same session via PUT with session_id.
        if (this.activeTurnMode?.turnId === pl.turn?.id) this.activeTurnMode = null;
        this.autoSaveSession();
        this.refreshSessionList();
        this.stopPeriodicTaskRefresh();
        this.refreshTaskList();
        this.refreshWorkPanel();
        // Refresh the thread list too so running badges / groups update when
        // the current thread's turn ends.
        this.scheduleThreadListRefresh();
        // The runtime writes goal usage back at the terminal-turn boundary,
        // so re-fetch the goal to surface updated tokens_used/status instead
        // of leaving the panel on its pre-turn value.
        void this.refreshGoal();
        break;
      }

      case "approval.required": {
        const pl = event.payload as Record<string, unknown>;
        const request = pl.request as Record<string, unknown> | undefined;
        const approvalId = (request?.approval_id as string) || (pl.approval_id as string) || (pl.id as string);
        const callId = (request?.call_id as string) || (pl.call_id as string) || (pl.id as string);
        const toolName = (request?.tool_name as string) || (pl.tool_name as string) || "unknown";
        const toolInput = (request || pl) as Record<string, unknown>;
        if (!approvalId) break;

        // Only Ask reaches a client: the engine resolves the other postures
        // itself (Full Access auto-approves, Auto-Review auto-denies) and emits
        // the decision along with the request, so there is nothing to answer.
        // Ask registers a waiter and nothing but this client can answer it.
        // Decide from the posture for the same reason the engine does — the
        // legacy auto_approve / trust_mode bits outlive a posture switch
        // (handleSetPosture patches permission_posture alone), so a thread that
        // was in Full Access, or once remembered an allow, still reports
        // auto_approve: true while the engine is waiting on a dialog that this
        // guard would drop.
        const posture = this.currentThread ? postureFromThread(this.currentThread) : "ask";
        if (posture !== "ask") {
          break;
        }

        const lastMsg = this.messages[this.messages.length - 1];
        let tc: ToolCallInfo | undefined;
        let tcIdx: number | undefined;
        let tcMsg: ChatMessage | undefined = lastMsg;
        if (callId) {
          const active = this.activeItems.get(callId);
          if (active?.toolCallIdx !== undefined) {
            tcMsg = this.resolveActiveMessage(active, lastMsg);
            tcIdx = active.toolCallIdx;
            tc = tcMsg?.toolCalls?.[tcIdx];
          }
        }
        if (!tc && tcMsg?.toolCalls) {
          tc = tcMsg.toolCalls.find((t) => t.status === "running");
          if (tc) tcIdx = tcMsg.toolCalls.indexOf(tc);
        }

        // Safety net: if the tool call is already complete, the TUI has
        // already auto-approved and finished it.  Showing an approval
        // dialog now would freeze the UI (no approval.decided will arrive).
        if (tc && tc.status === "complete") {
          break;
        }

        const actualInput = tc?.input || toolInput;
        const summary = buildApprovalSummary(toolName, actualInput);

        if (tc) {
          tc.status = "awaiting_approval";
          tc.approvalId = approvalId;
          tc.displayName = friendlyToolName(toolName);
          tc.approvalSummary = summary;
          this.pendingApprovals.set(approvalId, tc);
        }
        this.postMessage({
          type: "approvalRequired",
          messageId: lastMsg?.id,
          toolCallIdx: tcIdx,
          approvalId,
          toolName: friendlyToolName(toolName),
          rawToolName: toolName,
          toolInput: actualInput,
          summary,
        });

        this.showApprovalDialog(approvalId, toolName, summary);
        break;
      }

      case "approval.decided": {
        const pl = event.payload as {
          approval_id?: string;
          decision?: string;
          remember?: boolean;
        };
        const approvalId = pl.approval_id;
        if (!approvalId) break;
        // Mirror the optimistic auto_approve update when the TUI reports
        // a remember=true allow decision (covers the case where the
        // decision was made via a different code path, e.g. TUI UI).
        if (pl.remember && pl.decision === "allow" && this.currentThread) {
          this.currentThread = { ...this.currentThread, auto_approve: true };
        }
        this.retireApproval(approvalId, pl.decision === "allow" ? "running" : "error");
        this.postMessage({
          type: "approvalResolved",
          approvalId,
          decision: pl.decision || "deny",
        });
        break;
      }

      case "approval.timeout": {
        const pl = event.payload as {
          approval_id?: string;
          timeout_secs?: number;
        };
        const approvalId = pl.approval_id;
        if (!approvalId) break;
        this.retireApproval(approvalId, "error");
        this.postMessage({
          type: "approvalResolved",
          approvalId,
          decision: "deny",
        });
        this.postMessage({
          type: "error",
          message: `Approval timed out after ${pl.timeout_secs || 30}s — tool call was denied automatically`,
        });
        break;
      }

      case "sandbox.denied": {
        // Informational: TUI denied a tool call due to sandbox policy
        // (see runtime_threads.rs:3274).  The engine subsequently calls
        // deny_tool_call which produces item.completed/item.failed —
        // here we just surface the denial reason to the user so they
        // understand why the tool was rejected.
        const pl = event.payload as {
          tool_id?: string;
          tool_name?: string;
          reason?: string;
        };
        const toolName = pl.tool_name || "unknown";
        const reason = pl.reason || "sandbox policy";
        this.postMessage({
          type: "status",
          text: `${toolName} denied by sandbox: ${reason}`,
        });
        break;
      }

      case "user_input.required": {
        const pl = event.payload as {
          id?: string;
          request?: {
            questions?: Array<{
              header: string;
              id: string;
              question: string;
              options: Array<{ label: string; description: string }>;
            }>;
          };
        };
        const inputId = pl.id;
        const questions = pl.request?.questions;
        if (!inputId || !questions) break;

        const lastMsg = this.messages[this.messages.length - 1];
        let messageId: string | undefined;
        if (event.item_id) {
          const active = this.activeItems.get(event.item_id);
          if (active) {
            messageId = active.msgId;
          }
        }
        if (!messageId) {
          messageId = lastMsg?.id;
        }

        this.pendingUserInputs.set(inputId, {
          threadId: event.thread_id,
          questions,
          answers: [],
          answeredQuestions: new Set(),
        });
        this.postMessage({
          type: "userInputRequired",
          messageId,
          inputId,
          questions,
        });
        break;
      }
    }
    } catch (err) {
      this.debugLog(`handleRuntimeEvent error on ${event.event}: ${getErrorMessage(err)}`);
    }
  }

  /** Resolve the message an active item belongs to. Mid-turn steers split a
   *  turn into multiple assistant segments, so an item started before a
   *  steer must keep routing its events to its original (earlier) segment —
   *  `messages[last]` is only correct for items started after the steer. */
  private resolveActiveMessage(
    active: { msgId?: string } | undefined,
    fallback: ChatMessage | undefined,
  ): ChatMessage | undefined {
    if (!active?.msgId) return fallback;
    return this.messages.find((m) => m.id === active.msgId) ?? fallback;
  }

  /** Ensure a streaming assistant placeholder exists for a server-initiated
   *  turn (goal kickoff/continuation, agent mail). Without it, `handleItemEvent`
   *  drops the turn's assistant output because there is no preceding user
   *  message in `this.messages`. */
  private ensureAssistantPlaceholderForExternalTurn(): void {
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant" && lastMsg.status === "streaming") {
      return;
    }
    this.activeItems.clear();
    this.currentTextBlockIdx = -1;
    this.currentThinkingBlockIdx = -1;
    this.turnFileChanges = [];
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      status: "streaming",
      timestamp: Date.now(),
      toolCalls: [],
      blocks: [],
    };
    this.messages.push(assistantMsg);
    this.postMessage({ type: "addMessage", message: assistantMsg });
  }

  private handleItemEvent(event: RuntimeEvent): void {
    const itemId = event.item_id!;
    const lastMsg = this.messages[this.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    switch (event.event) {
      case "item.started": {
        const pl = event.payload as {
          item?: { kind?: string; id?: string; summary?: string; detail?: string };
          tool?: { id?: string; name?: string; input?: Record<string, unknown> };
        };
        const kind = pl.item?.kind;
        if (!kind || !itemId) break;

        this.activeItems.set(itemId, { kind, msgId: lastMsg.id });

        if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          this.currentTextBlockIdx = -1;
          this.currentThinkingBlockIdx = -1;

          const rawToolName = pl.tool?.name || "";
          const tc: ToolCallInfo = {
            name: rawToolName || pl.item?.summary || "unknown",
            input: pl.tool?.input || {},
            status: "running",
            itemId,
          };
          lastMsg.toolCalls = lastMsg.toolCalls || [];
          lastMsg.blocks = lastMsg.blocks || [];
          const tcIdx = lastMsg.toolCalls.length;
          lastMsg.toolCalls.push(tc);
          const blockIdx = lastMsg.blocks.length;
          lastMsg.blocks.push({ type: "tool_call", toolCallIdx: tcIdx });
          const entry = {
            kind,
            msgId: lastMsg.id,
            toolCallName: rawToolName || tc.name,
            toolCallIdx: tcIdx,
            blockIdx,
          };
          this.activeItems.set(itemId, entry);
          if (pl.tool?.id) {
            this.activeItems.set(pl.tool.id, entry);
          }
          this.postMessage({
            type: "addToolCall",
            messageId: lastMsg.id,
            toolCallIdx: tcIdx,
            blockIdx,
            toolCall: tc,
          });
        }
        this.postMessage({ type: "status", text: `${kind} started` });
        break;
      }

      case "item.delta": {
        const pl = event.payload as { delta?: string; kind?: string };
        const delta = pl.delta || "";
        const kind = pl.kind;

        if (kind === "agent_message") {
          lastMsg.blocks = lastMsg.blocks || [];
          if (this.currentTextBlockIdx < 0) {
            this.currentTextBlockIdx = lastMsg.blocks.length;
            lastMsg.blocks.push({ type: "text", content: "" });
            this.postMessage({
              type: "addTextBlock",
              messageId: lastMsg.id,
              blockIdx: this.currentTextBlockIdx,
            });
          }
          const textBlock = lastMsg.blocks[this.currentTextBlockIdx];
          textBlock.content = (textBlock.content || "") + delta;
          lastMsg.content += delta;
          this.postMessage({
            type: "updateMessage",
            messageId: lastMsg.id,
            content: textBlock.content,
            blockIdx: this.currentTextBlockIdx,
          });
        } else if (kind === "agent_reasoning") {
          if (!delta) break;
          lastMsg.blocks = lastMsg.blocks || [];
          if (this.currentThinkingBlockIdx < 0) {
            this.currentThinkingBlockIdx = lastMsg.blocks.length;
            lastMsg.blocks.push({ type: "thinking", content: "" });
            this.postMessage({
              type: "addThinkingBlock",
              messageId: lastMsg.id,
              blockIdx: this.currentThinkingBlockIdx,
            });
          }
          const thinkingBlock = lastMsg.blocks[this.currentThinkingBlockIdx];
          thinkingBlock.content = (thinkingBlock.content || "") + delta;
          lastMsg.thinking = (lastMsg.thinking || "") + delta;
          this.postMessage({
            type: "updateThinking",
            messageId: lastMsg.id,
            thinking: thinkingBlock.content,
            blockIdx: this.currentThinkingBlockIdx,
          });
        }
        break;
      }

      case "item.completed": {
        const pl = event.payload as {
          item?: {
            kind?: string;
            id?: string;
            summary?: string;
            detail?: string;
            status?: string;
            metadata?: Record<string, unknown>;
          };
        };
        const kind = pl.item?.kind;
        const active = this.activeItems.get(itemId);
        this.activeItems.delete(itemId);

        if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          const msg = this.resolveActiveMessage(active, lastMsg)!;
          const tcIdx = active?.toolCallIdx;
          const tc = tcIdx !== undefined ? msg.toolCalls?.[tcIdx] : undefined;
          const toolName = active?.toolCallName || extractToolNameFromSummary(pl.item?.summary || "");

          if (tc) {
            tc.status = "complete";
            tc.output = pl.item?.detail || pl.item?.summary;
            this.postMessage({
              type: "updateToolCall",
              messageId: msg.id,
              toolCallIdx: tcIdx!,
              toolName: tc.name,
              status: "complete",
              output: tc.output,
            });
          }

          // Authoritative signal first: current TUI file tools attach
          // `metadata.mutation` to item.completed, independent of naming.
          const fcSignal = detectFileChange({
            toolName,
            input: tc?.input as Record<string, unknown> | undefined,
            output: pl.item?.detail || tc?.output || "",
            metadata: pl.item?.metadata as Record<string, unknown> | undefined,
          });
          if (fcSignal) {
            const fc: FileChangeInfo = fcSignal;
            this.stampReviewedHash(fc);
            if (tc) {
              tc.fileChange = fc;
            }
            // Appended, never merged into a per-file total: the card, the
            // Changes panel and the revert target all describe this one call.
            this.appendFileChange(fc);
            if (tcIdx !== undefined) {
              this.postMessage({
                type: "fileChangeDetected",
                messageId: msg.id,
                toolCallIdx: tcIdx,
                fileChange: fc,
              });
            }
            this.refreshWorkPanel();
          }
          if (pl.item?.metadata?.task_updates) {
            const checklist = (pl.item.metadata.task_updates as Record<string, unknown>).checklist;
            if (checklist && typeof checklist === "object") {
              const cl = checklist as Record<string, unknown>;
              if (Array.isArray(cl.items)) {
                this.checklistItems = cl.items as { id: string; content: string; status: string }[];
              }
              if (typeof cl.completion_pct === "number") {
                this.checklistCompletionPct = cl.completion_pct;
              }
              this.refreshWorkPanel();
            }
          }
          if ([
            "agent_open", "agent_spawn", "agent_close", "agent_cancel",
            "todo_write", "todo_add", "todo_update",
            "checklist_write", "checklist_add", "checklist_update",
            "task_shell_start", "exec_shell",
          ].includes(toolName)) {
            this.refreshTaskList();
            this.refreshAgentRuns();
          }
        }
        break;
      }

      case "item.failed": {
        // TUI emits item.failed (not item.completed) when a tool execution
        // fails (e.g. edit_file search-not-found, non-unique match, stale
        // prior read).  Without this handler the toolCall status stays
        // "running" forever and the UI freezes on "⟳ running...".
        const pl = event.payload as {
          item?: {
            kind?: string;
            id?: string;
            summary?: string;
            detail?: string;
            status?: string;
            metadata?: Record<string, unknown>;
          };
        };
        const kind = pl.item?.kind;
        const active = this.activeItems.get(itemId);
        this.activeItems.delete(itemId);

        if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          const msg = this.resolveActiveMessage(active, lastMsg)!;
          const tcIdx = active?.toolCallIdx;
          const tc = tcIdx !== undefined ? msg.toolCalls?.[tcIdx] : undefined;

          if (tc) {
            tc.status = "error";
            tc.output = pl.item?.detail || pl.item?.summary;
            this.postMessage({
              type: "updateToolCall",
              messageId: msg.id,
              toolCallIdx: tcIdx!,
              toolName: tc.name,
              status: "error",
              output: tc.output,
            });
          }
        }
        break;
      }

      case "item.interrupted": {
        // TUI emits item.interrupted when a turn is interrupted (user
        // clicks stop, or a new turn supersedes the current one) for all
        // in-progress items (see runtime_threads.rs:3412,3437).  Without
        // this handler the toolCall status stays "running" forever.
        const pl = event.payload as {
          item?: {
            kind?: string;
            id?: string;
            summary?: string;
            detail?: string;
            status?: string;
          };
        };
        const kind = pl.item?.kind;
        const active = this.activeItems.get(itemId);
        this.activeItems.delete(itemId);

        if (kind === "tool_call" || kind === "file_change" || kind === "command_execution") {
          const msg = this.resolveActiveMessage(active, lastMsg)!;
          const tcIdx = active?.toolCallIdx;
          const tc = tcIdx !== undefined ? msg.toolCalls?.[tcIdx] : undefined;

          if (tc) {
            tc.status = "error";
            tc.approvalId = undefined;
            tc.output = pl.item?.detail || pl.item?.summary || "Interrupted";
            this.postMessage({
              type: "updateToolCall",
              messageId: msg.id,
              toolCallIdx: tcIdx!,
              toolName: tc.name,
              status: "error",
              output: tc.output,
            });
          }
        }
        break;
      }
    }
  }

  // ── Command handlers (called from extension.ts) ──

  handleNewThreadCommand(): void {
    this.handleNewThread();
  }

  handleCompactCommand(): void {
    this.handleCompact();
  }

  // ── Helpers ──

  /** Pull thread-scoped usage + cost totals from the TUI runtime — the
   *  authoritative source for the session-cost display. Prefers the
   *  dedicated per-thread endpoint (recorded-time provider pricing in both
   *  published currencies, native CNY included); on older runtimes falls
   *  back to the `/v1/usage?group_by=thread` bucket (USD only). Totals are
   *  SET (never incremented), so retries cannot double-count, and the
   *  monotonic high-water mark keeps the display from reversing. */
  private async refreshThreadUsage(threadId?: string): Promise<void> {
    const id = threadId ?? this.currentThread?.id;
    if (!id) return;
    try {
      const totals = this.apiCapabilities.threadUsage
        ? await this.api.getThreadUsage(id)
        : (await this.api.getThreadUsageBucket(id)) ?? {
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            cost_usd: 0,
            turns: 0,
          };
      // `totals.input_tokens` from the TUI's usage endpoint is the *billable*
      // (non-cached) input produced by `token_usage_for_pricing`, NOT the total
      // prompt input. The per-turn `usage.input_tokens` shown in the transcript
      // (and the TUI header "in") is the full prompt including cache hits and
      // cache writes. Reconstruct that same total so the status bar matches the
      // transcript instead of showing only the cache-miss slice.
      const totalInput = totals.input_tokens
        + totals.cached_tokens
        + (totals.cache_write_tokens ?? 0);
      this.totalInputTokens = totalInput;
      this.totalOutputTokens = totals.output_tokens;
      this.totalTokens = totalInput + totals.output_tokens;
      // CNY is the provider-published subtotal from the TUI pricing engine,
      // never an FX projection of the USD column. Absent (older runtime) or
      // zero (USD-only route) means "no native CNY coverage"; the display
      // then falls back to USD, mirroring TUI's cost_display_currency.
      this.sessionCostUsd = totals.cost_usd || 0;
      this.sessionCostCny = totals.cost_cny || 0;
      // Maintain monotonic high-water mark so the displayed cost never
      // decreases across turns or server-side undo (mirrors TUI #244).
      this.displayedCostHighWaterUsd = Math.max(this.displayedCostHighWaterUsd, this.sessionCostUsd);
      this.displayedCostHighWaterCny = Math.max(this.displayedCostHighWaterCny, this.sessionCostCny);
      this.sendSessionStats();
    } catch {
      // Best-effort refresh: keep the last known totals on failure.
    }
  }

  private sendSessionStats(): void {
    const totalCacheHit = this.lastCacheHitTokens;
    const totalCacheMiss = this.lastCacheMissTokens;
    const total = totalCacheHit + totalCacheMiss;
    const cacheHitRate = total > 0 ? (totalCacheHit / total * 100) : 0;
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    const configured = resolveCostCurrency(
      cfg.get<string>("costCurrency", "auto"),
      currentLocale(),
    );
    // Mirror the TUI's cost_display_currency: a CNY preference with no
    // native-CNY-priced spend falls back to USD rather than showing a
    // fabricated ¥0. Both figures use the monotonic high-water mark so the
    // cost never decreases across turns or session restarts (TUI #244).
    const currency: "usd" | "cny" = configured === "cny" && this.displayedCostHighWaterCny > 0
      ? "cny"
      : "usd";
    const costHighWater = currency === "cny"
      ? this.displayedCostHighWaterCny
      : this.displayedCostHighWaterUsd;
    let costDisplay: string;
    if (costHighWater > 0) {
      costDisplay = formatCostAmount(costHighWater, currency);
    } else {
      // Zero cost with tokens means "not recorded" (e.g. a session saved by
      // an older runtime that dropped cost metadata), not "free". An em
      // dash is honest; "<$0.0001" next to six-figure token counts would be
      // actively wrong. A genuinely empty session still shows the floor
      // marker, matching the pre-existing behavior.
      costDisplay = this.totalTokens > 0 || this.totalInputTokens > 0 || this.totalOutputTokens > 0
        ? "—"
        : formatCostAmount(0, currency);
    }
    this.postMessage({
      type: "sessionStats",
      cost: costDisplay,
      // Omit cacheHitRate when no cache sample exists (e.g. session view
      // mode): the webview hides the chip entirely rather than showing a
      // misleading "0.0%".
      ...(total > 0 ? { cacheHitRate: cacheHitRate.toFixed(1) } : {}),
      cacheHitTokens: totalCacheHit,
      cacheMissTokens: totalCacheMiss,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      // Grand total for view modes that record no input/output split; the
      // webview renders a Σ chip when the split is unavailable.
      totalTokens: this.totalTokens,
      lastInputTokens: this.lastInputTokens,
      lastOutputTokens: this.lastOutputTokens,
    });
  }

  /** The model of whatever this view is on: the open conversation's, else the
   *  viewed session's, else the one the picker's route would start a new
   *  conversation with. One answer, so the chip, `/model` with no argument and
   *  the model menu cannot name three different models. */
  public getCurrentModel(): string {
    const threadModel = this.currentThread?.model?.trim();
    if (threadModel) return threadModel;
    if (this.viewingSessionId && this.viewingSessionModel) return this.viewingSessionModel;
    return this.getModelForRoute(this.currentProvider, this.currentProviderId);
  }

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public setCurrentSessionId(id: string | null): void {
    this.currentSessionId = id;
  }

  public async saveCurrentSession(threadId: string, sessionId?: string): Promise<{ session_id: string }> {
    return this.api.saveCurrentSession(threadId, sessionId);
  }

  private getCurrentMode(): string {
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    return normalizeMode(cfg.get<string>("defaultMode", "agent"));
  }

  /** Startup default permission posture. Legacy `defaultMode: "yolo"` is a
   *  one-way shorthand for Act + Full Access and still wins when set. */
  private getCurrentPosture(): PermissionPosture {
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    return startupPosture(
      cfg.get<string>("defaultMode", "agent"),
      cfg.get<string>("defaultPermissionPosture", "ask"),
    );
  }

  /** Effective posture for the active thread, falling back to the startup default. */
  private getEffectivePosture(): PermissionPosture {
    if (this.currentThread) return postureFromThread(this.currentThread);
    return this.getCurrentPosture();
  }

  private getCurrentReasoningEffort(): string {
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    return cfg.get<string>("reasoningEffort", "auto");
  }

  /** Post a message to the webview, pre-rendering markdown fields */
  public postMessage(msg: Record<string, unknown>): void {
    // Pre-render markdown content for the webview
    switch (msg.type) {
      case "addMessage": {
        const m = msg.message as Record<string, unknown>;
        if (m && typeof m.content === "string") {
          try { m.contentHtml = renderMarkdown(m.content); } catch { m.contentHtml = m.content; }
        }
        if (m && typeof m.thinking === "string" && m.thinking) {
          try { m.thinkingHtml = renderMarkdown(m.thinking); } catch { m.thinkingHtml = m.thinking; }
        }
        if (m && Array.isArray(m.blocks)) {
          for (const b of m.blocks as Record<string, unknown>[]) {
            if ((b.type === "text" || b.type === "thinking") && typeof b.content === "string" && b.content) {
              try { b.contentHtml = renderMarkdown(b.content as string); } catch { b.contentHtml = b.content; }
            }
          }
        }
        break;
      }
      case "updateMessage":
        break;
      case "updateThinking":
        break;
      case "loadHistory":
      case "threadLoaded":
        if (Array.isArray(msg.messages)) {
          for (const m of msg.messages as Record<string, unknown>[]) {
            if (m && typeof m.content === "string") {
              try { m.contentHtml = renderMarkdown(m.content); } catch { m.contentHtml = m.content; }
            }
            if (m && typeof m.thinking === "string" && m.thinking) {
              try { m.thinkingHtml = renderMarkdown(m.thinking); } catch { m.thinkingHtml = m.thinking; }
            }
            if (m && Array.isArray(m.blocks)) {
              for (const b of m.blocks as Record<string, unknown>[]) {
                if ((b.type === "text" || b.type === "thinking") && typeof b.content === "string" && b.content) {
                  try { b.contentHtml = renderMarkdown(b.content as string); } catch { b.contentHtml = b.content; }
                }
              }
            }
          }
        }
        break;
    }
    this.debugLog(`postMessage: ${String(msg.type)}`);
    this.view?.webview.postMessage(msg);
  }

  private cleanup(): void {
    this.abortEventStream();
    this.stopPeriodicTaskRefresh();
    this.stopActiveTaskDetailRefresh();
    this.stopAttentionDiscoveryPoll();
    this.activeTaskDetailId = null;
    this.stopFleetEventStream();
    this.activeFleetRunId = null;
    this.diffContentStore.clear();
    this.diffProviderDisposable?.dispose();
    this.diffProviderDisposable = null;
  }

  dispose(): void {
    this.cleanup();
    if (this.threadListRefreshTimer) {
      clearTimeout(this.threadListRefreshTimer);
      this.threadListRefreshTimer = null;
    }
    this.stopAllBackgroundWatches();
    this.backgroundThreads.clear();
    this.backgroundUserInputs.clear();
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
