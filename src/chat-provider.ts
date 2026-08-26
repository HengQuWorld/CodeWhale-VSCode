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
import type { TaskSummary, ThreadDetailResponse } from "./types";
import { formatError, getErrorMessage } from "./utils/error-handler";
import { getWebviewHtml } from "./webview/webview-html";
import { renderMarkdown } from "./utils/markdown";
import { finalizeAssistantMessage } from "./utils/event-helpers";
import { formatCostAmount, resolveCostCurrency } from "./utils/cost-calculator";
import {
  parseDiffStats,
  extractDiffFromOutput,
  extractDiffForTool,
  extractFilePathFromDiff,
  parseDiffToSides,
  stripTurnMeta,
  reconstructOldContent,
  reconstructOriginalContent,
  getDiffStateForIndex,
} from "./utils/diff-utils";
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
} from "./utils/session-state";
import {
  friendlyToolName,
  isFileChangeTool,
  extractFilePath,
  extractToolNameFromSummary,
  buildApprovalSummary,
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

export class ChatProvider implements vscode.WebviewViewProvider, SlashCommandContext {
  public static readonly viewType = "brotherwhale.chat";

  private view?: vscode.WebviewView;
  public readonly api: CodeWhaleApiClient;
  public readonly engine: CodeWhaleEngine;
  private sessionState = new SessionStateStore();
  private slashHandler: SlashCommandHandler;
  private eventController: AbortController | null = null;
  private taskRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private taskDetailRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private activeTaskDetailId: string | null = null;
  private _disposables: vscode.Disposable[] = [];
  private currentAttachments: Array<{ kind: string; path: string; name: string }> = [];
  private showAllWorkspaces: boolean = false;
  /** Fallback workspace from the TUI, used when VS Code has no folder open. */
  private tuiWorkspace: string | null = null;
  /** Monotonic task-list refresh token used to drop stale async enrichment results. */
  private taskListRefreshToken: number = 0;
  private runtimeVersion: string | null = null;
  /** Cached provider list from `GET /v1/providers`. Refreshed on init and
   * after the active provider changes so the webview picker stays in sync. */
  private providersCache: ProviderEntry[] | null = null;
  /** Active provider id (mirrors `GuiConfigResponse.provider`). Used to
   * render the picker's selected value without waiting for a config refresh. */
  private currentProvider: string | null = null;
  private apiCapabilities: RuntimeApiCapabilities = {
    saveSession: false,
    threadUndo: false,
    threadPatchUndo: false,
    threadRetry: false,
    turnSteer: false,
    snapshotList: false,
    snapshotRestore: false,
    threadUsage: false,
  };
  // Guard to prevent concurrent autoSaveSession calls.  When multiple
  // turn.completed events fire in quick succession (e.g. SSE reconnection
  // replaying buffered events) and currentSessionId is null, each call
  // would create a new session on the server, producing duplicates.
  private autoSaveInProgress = false;
  private readonly textArtifactPreviewStore = new Map<string, { content: string; language?: string }>();

  // Convenience accessors for session state
  public get currentThread(): ThreadRecord | null { return this.sessionState.data.currentThread; }
  public set currentThread(v: ThreadRecord | null) { this.sessionState.data.currentThread = v; }
  private get viewingSessionId(): string | null { return this.sessionState.data.viewingSessionId; }
  private set viewingSessionId(v: string | null) { this.sessionState.data.viewingSessionId = v; }
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
  private get cycleCount(): number { return this.sessionState.data.cycleCount; }
  private set cycleCount(v: number) { this.sessionState.data.cycleCount = v; }
  private get checklistItems() { return this.sessionState.data.checklistItems; }
  private set checklistItems(v: { id: string; content: string; status: string }[]) { this.sessionState.data.checklistItems = v; }
  private get checklistCompletionPct(): number { return this.sessionState.data.checklistCompletionPct; }
  private set checklistCompletionPct(v: number) { this.sessionState.data.checklistCompletionPct = v; }
  private get strategySteps(): StrategyStep[] { return this.sessionState.data.strategySteps; }
  private set strategySteps(v: StrategyStep[]) { this.sessionState.data.strategySteps = v; }
  private get coherenceState(): string { return this.sessionState.data.coherenceState; }
  private set coherenceState(v: string) { this.sessionState.data.coherenceState = v; }
  private get coherenceLabel(): string { return this.sessionState.data.coherenceLabel; }
  private set coherenceLabel(v: string) { this.sessionState.data.coherenceLabel = v; }
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
      case "switchProvider":
        await this.handleSwitchProvider(msg.provider as string, msg.model as string | undefined);
        break;
      case "switchProviderFromSlash":
        // Forwarded from the /provider slash command handler — convert to the
        // standard switchProvider flow so all state updates go through one path.
        await this.handleSwitchProvider(msg.provider as string, msg.model as string | undefined);
        break;
      case "requestProviderModels":
        await this.handleRequestProviderModels(msg.provider as string);
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
        }
        break;
      case "openDiff":
        this.handleOpenDiff(msg.filePath as string, msg.diff as string | undefined, msg.useCumulative as boolean, msg.diffIndex as number | undefined);
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
          msg.diff as string | undefined
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

    if (this.currentThread?.id) {
      await this.loadHistory(this.currentThread.id);
      this.subscribeToEvents();
    } else if (this.messages.length > 0) {
      this.postMessage({ type: "loadHistory", messages: this.messages });
    } else {
      this.postMessage({ type: "clearChat" });
    }

    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    this.postMessage({
        type: "ready",
        model: this.getCurrentModel(),
        mode: this.getCurrentMode(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        runtimeVersion: this.runtimeVersion,
        showThreadList: cfg.get<boolean>("showThreadList", false),
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
        await this.loadHistory();
        this.subscribeToEvents();
      } else if (threads.length > 0) {
        this.currentThread = threads[0];
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
      var initCfg = vscode.workspace.getConfiguration("brotherwhale");
      this.postMessage({ 
        type: "ready", 
        model: this.currentThread?.model || this.getCurrentModel(),
        mode: this.currentThread?.mode || this.getCurrentMode(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        runtimeVersion: this.runtimeVersion,
        showThreadList: initCfg.get<boolean>("showThreadList", false),
      });
    } catch (err) {
      this.debugLog(`initializeThread ERROR: ${getErrorMessage(err)}\n${(err as Error).stack}`);
      var errCfg = vscode.workspace.getConfiguration("brotherwhale");
      this.postMessage({
        type: "error",
        message: formatError("Failed to initialize", err),
      });
      this.postMessage({
        type: "ready",
        model: this.currentThread?.model || this.getCurrentModel(),
        mode: this.currentThread?.mode || this.getCurrentMode(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: this.currentProvider || undefined,
        runtimeVersion: this.runtimeVersion,
        showThreadList: errCfg.get<boolean>("showThreadList", false),
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
        const applyToolResult = (toolUseId: string, output: string, isError: boolean): void => {
          const tc = toolCallById.get(toolUseId);
          if (!tc) return;
          tc.output = output;
          tc.status = isError ? "error" : "complete";
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
              if (tc.fileChange) {
                const normPath = normalizePath(tc.fileChange.filePath);
                const existingIdx = this.turnFileChanges.findIndex(existing => normalizePath(existing.filePath) === normPath);
                if (existingIdx >= 0) {
                  // Merge with existing change for cumulative stats
                  const existing = this.turnFileChanges[existingIdx];
                  const existingDiffs = existing.diffs ?? (existing.diff ? [existing.diff] : []);
                  const newDiffs = tc.fileChange.diff ? [...existingDiffs, tc.fileChange.diff] : existingDiffs;
                  this.turnFileChanges[existingIdx] = {
                    ...tc.fileChange,
                    addedLines: existing.addedLines + tc.fileChange.addedLines,
                    removedLines: existing.removedLines + tc.fileChange.removedLines,
                    changeType: tc.fileChange.changeType === "created" ? "created" :
                               tc.fileChange.changeType === "deleted" && existing.changeType !== "created" ? "deleted" :
                               existing.changeType,
                    diff: tc.fileChange.diff ?? existing.diff,
                    diffs: newDiffs,
                    toolName: tc.fileChange.toolName ?? existing.toolName,
                  };
                } else {
                  this.turnFileChanges.push({
                    ...tc.fileChange,
                    diffs: tc.fileChange.diff ? [tc.fileChange.diff] : [],
                  });
                }
              }
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
                );
                break;
              }
              const tcIdx = toolCalls.length;
              const rawName = extractToolNameFromSummary(item.summary || "");
              const tc: ToolCallInfo = {
                name: rawName,
                input: metadata,
                output: item.detail || undefined,
                status: item.status === "completed" ? "complete" : "error",
                itemId: typeof metadata.tool_use_id === "string" ? metadata.tool_use_id : item.id,
              };
              if (tc.itemId) {
                toolCallById.set(tc.itemId, tc);
              }
              if (isFileChangeTool(tc.name) && tc.input) {
                const filePath = extractFilePath(tc.name, tc.input);
                if (filePath) {
                  const output = tc.output || "";
                  const diff = extractDiffForTool(tc.name, tc.input as Record<string, unknown> | undefined, output);
                  const stats = diff ? parseDiffStats(diff) : { added: 0, removed: 0 };
                  const changeType: "created" | "modified" | "deleted" =
                    tc.name === "delete_file" ? "deleted" :
                    tc.name === "write_file" && !diff ? "created" : "modified";
                  tc.fileChange = {
                    filePath,
                    changeType,
                    addedLines: stats.added,
                    removedLines: stats.removed,
                    diff,
                    toolName: tc.name,
                  };
                }
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
              const fcDiff = extractDiffForTool(fcToolName, fcMeta as Record<string, unknown> | undefined, fcOutput);
              const fcStats = fcDiff ? parseDiffStats(fcDiff) : { added: 0, removed: 0 };
              let fcFilePath = fcDiff ? extractFilePathFromDiff(fcDiff) : "";
              if (!fcFilePath && fcMeta.file_path) fcFilePath = fcMeta.file_path as string;
              if (!fcFilePath && fcMeta.path) fcFilePath = fcMeta.path as string;
              const fcChangeType = (fcMeta.change_type as "created" | "modified" | "deleted") ||
                (fcToolName === "delete_file" ? "deleted" :
                 fcToolName === "write_file" && !fcDiff ? "created" : "modified");
              const fcTc: ToolCallInfo = {
                name: fcToolName || "file_change",
                displayName: friendlyToolName(fcToolName || "file_change"),
                input: fcMeta,
                output: fcOutput,
                status: item.status === "completed" ? "complete" : "error",
                fileChange: fcFilePath ? {
                  filePath: fcFilePath,
                  changeType: fcChangeType,
                  addedLines: fcStats.added,
                  removedLines: fcStats.removed,
                  diff: fcDiff,
                  toolName: fcToolName || "file_change",
                } : undefined,
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

      this.postMessage({ type: "loadHistory", messages: this.messages });
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

  public async loadSessionMessages(sessionId: string): Promise<void> {
    if (!(await this.confirmSwitchWhenActive())) return;
    try {
      const session = await this.api.getSession(sessionId);
      const title = session.metadata.title || "Session";

      this.cleanup();
      this.sessionState.reset();
      this.viewingSessionId = sessionId;

      // Tell the webview which model/mode this session uses so the status
      // bar reflects the loaded session (not the user's global default).
      // We deliberately do NOT update the global VSCode config — that would
      // permanently change defaultModel/defaultMode and cause every new
      // conversation to inherit the session's mode, even after the user
      // moves on to a different task (e.g. a plan-mode session would lock
      // the extension into plan mode forever).
      const sessionModel = session.metadata.model;
      const sessionMode = session.metadata.mode || "agent";
      const cfg = vscode.workspace.getConfiguration("brotherwhale");
      const currentModel = cfg.get<string>("defaultModel", "deepseek-v4-pro");
      this.postMessage({
        type: "settingsUpdated",
        model: sessionModel || currentModel,
        mode: sessionMode,
        reasoningEffort: cfg.get<string>("reasoningEffort", "auto"),
      });

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
    const updateFileChangeCard = (toolCall: ToolCallInfo): void => {
      if (!isFileChangeTool(toolCall.name) || !toolCall.input) return;
      const filePath = extractFilePath(toolCall.name, toolCall.input);
      if (!filePath) return;
      const output = toolCall.output || "";
      const diff = extractDiffForTool(toolCall.name, toolCall.input as Record<string, unknown> | undefined, output);
      const stats = diff ? parseDiffStats(diff) : { added: 0, removed: 0 };
      const changeType: "created" | "modified" | "deleted" =
        toolCall.name === "delete_file" ? "deleted" :
        toolCall.name === "write_file" && !diff ? "created" : "modified";
      toolCall.fileChange = {
        filePath,
        changeType,
        addedLines: stats.added,
        removedLines: stats.removed,
        diff,
        toolName: toolCall.name,
      };
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
              updateFileChangeCard(globalToolCalls[idx]);
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
              updateFileChangeCard(toolCall);
              globalToolCalls.push(toolCall);
              blocks.push({ type: "tool_call", toolCallIdx: idx });
              turnToolCallIndices.push(idx);
            } else if (block.type === "tool_result" && block.tool_use_id) {
              const idx = globalToolIdMap.get(block.tool_use_id);
              if (idx !== undefined && globalToolCalls[idx]) {
                const outputText = getToolResultText(block);
                globalToolCalls[idx].output = outputText;
                globalToolCalls[idx].status = block.is_error ? "error" : "complete";
                updateFileChangeCard(globalToolCalls[idx]);
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
                updateFileChangeCard(globalToolCalls[idx]);
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
      if (tc.fileChange) {
        const normPath = normalizePath(tc.fileChange.filePath);
        const existingIdx = this.turnFileChanges.findIndex(existing => normalizePath(existing.filePath) === normPath);
        if (existingIdx >= 0) {
          // Merge with existing change for cumulative stats
          const existing = this.turnFileChanges[existingIdx];
          const existingDiffs = existing.diffs ?? (existing.diff ? [existing.diff] : []);
          const newDiffs = tc.fileChange.diff ? [...existingDiffs, tc.fileChange.diff] : existingDiffs;
          this.turnFileChanges[existingIdx] = {
            ...tc.fileChange,
            addedLines: existing.addedLines + tc.fileChange.addedLines,
            removedLines: existing.removedLines + tc.fileChange.removedLines,
            changeType: tc.fileChange.changeType === "created" ? "created" :
                       tc.fileChange.changeType === "deleted" && existing.changeType !== "created" ? "deleted" :
                       existing.changeType,
            diff: tc.fileChange.diff ?? existing.diff,
            diffs: newDiffs,
            toolName: tc.fileChange.toolName ?? existing.toolName,
          };
        } else {
          this.turnFileChanges.push({
            ...tc.fileChange,
            diffs: tc.fileChange.diff ? [tc.fileChange.diff] : [],
          });
        }
      }
    }
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

  private async loadThread(threadId: string): Promise<void> {
    if (!(await this.confirmSwitchWhenActive())) return;
    this.cleanup();
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

      await this.loadHistory(threadId);
      this.subscribeToEvents();
      this.postMessage({
        type: "threadLoaded",
        thread: this.currentThread,
        messages: this.messages,
      });
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

      for (const uri of uris) {
        const ext = path.extname(uri.fsPath).toLowerCase();
        const kind = ChatProvider.MEDIA_EXTENSIONS[ext];
        if (kind) {
          this.currentAttachments.push({
            kind,
            path: uri.fsPath,
            name: path.basename(uri.fsPath),
          });
        } else {
          this.currentAttachments.push({
            kind: "file",
            path: uri.fsPath,
            name: path.basename(uri.fsPath),
          });
        }
      }

      this.postMessage({
        type: "attachmentsChanged",
        attachments: this.currentAttachments,
      });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to attach file", err),
      });
    }
  }

  private handleRemoveAttachment(index: number): void {
    if (index >= 0 && index < this.currentAttachments.length) {
      this.currentAttachments.splice(index, 1);
      this.postMessage({
        type: "attachmentsChanged",
        attachments: this.currentAttachments,
      });
    }
  }

  private async handleSendMessage(text: string): Promise<void> {
    if (!text.trim() && this.currentAttachments.length === 0) return;

    const attachments = [...this.currentAttachments];
    this.currentAttachments = [];
    this.postMessage({ type: "attachmentsChanged", attachments: [] });

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
        const sessionId = this.viewingSessionId;
        // Don't pass model/mode — let the backend use the session's persisted
        // values (runtime_api.rs:911-918 unwraps to session.metadata.model/mode).
        // Passing cfg defaults would override the session's original model/mode,
        // busting the prefix cache because the system prompt and tool catalog
        // change with the model/mode.
        const result = await this.api.resumeSessionThread(sessionId);
        try {
          await this.api.updateThread(result.thread_id, {
            title: `Resumed: ${result.summary.slice(0, 50)}`,
          });
        } catch { /* non-critical */ }

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

      if (!this.currentThread) {
        const cfg = vscode.workspace.getConfiguration("brotherwhale");
        const model = cfg.get<string>("defaultModel", "deepseek-v4-pro");
        const mode = cfg.get<string>("defaultMode", "agent");
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const isYolo = mode === "yolo";
        const autoApprove = isYolo || cfg.get<boolean>("autoApprove", false);
        this.currentThread = await this.api.createThread({
          model,
          mode,
          workspace,
          auto_approve: autoApprove,
          trust_mode: isYolo,
        });
        this.subscribeToEvents();
        this.refreshSessionList();
      }

      this.activeItems.clear();
      this.currentTextBlockIdx = -1;
      this.currentThinkingBlockIdx = -1;
      this.turnFileChanges = [];

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
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
        const cfg = vscode.workspace.getConfiguration("brotherwhale");
        const mode = cfg.get<string>("defaultMode", "agent");
        const autoApprove = cfg.get<boolean>("autoApprove", false);
        this.currentThread = await this.api.createThread({
          model: this.getCurrentModel(),
          mode,
          workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          auto_approve: autoApprove,
          trust_mode: mode === "yolo",
        });
        this.subscribeToEvents();
        this.refreshSessionList();
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
      const mode = this.currentThread.mode;
      const model = this.currentThread.model;
      // Use the thread's persisted auto_approve / trust_mode instead of the
      // config defaults.  When the user approves with "remember", the TUI
      // flips thread.auto_approve to true (remember_thread_auto_approve) and
      // the GUI mirrors that in handleApprovalDecision.  Sending the config
      // value (typically false) here would override the thread's persisted
      // state on every new turn, causing "remember" to silently revert and
      // re-prompting for approvals the user already granted — which then
      // surface as "Request cancelled while awaiting approval" when the turn
      // is interrupted.
      const result = await this.api.startTurn(this.currentThread.id, fullText, {
        mode,
        model,
        reasoning_effort: reasoningEffort,
        auto_approve: this.currentThread.auto_approve,
        trust_mode: this.currentThread.trust_mode,
      });
      this.currentTurnId = result.turn.id;
      this.postMessage({ type: "turnStarted", turnId: result.turn.id });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: formatError("Failed to send message", err),
      });
    }
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
    this.cleanup();
    this.sessionState.reset();
    this.postMessage({ type: "clearChat" });
    // Clear stale sidebar data
    this.postMessage({ type: "taskList", tasks: [] });
    this.postMessage({ type: "agentRunList", runs: [] });
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
    } catch (err) {
      setTimeout(async () => {
        try { await fetchAndSend(); } catch { /* silent */ }
      }, 2000);
    }
  }

  /** Refresh the thread list shown in the sidebar (legacy threads) */
  private async refreshThreadList(): Promise<void> {
    try {
      const threads = await this.api.listThreadsSummary({ limit: 100 });
      this.postMessage({ type: "threadList", threads, showAllWorkspaces: this.showAllWorkspaces });
    } catch {
      // best-effort, silent fail
    }
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
      const task = await this.api.createTask({
        prompt: trimmed,
        model: taskCfg.get<string>("defaultModel", "deepseek-v4-pro"),
        mode: taskCfg.get<string>("defaultMode", "agent"),
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        auto_approve: taskCfg.get<boolean>("autoApprove", false),
      });
      await this.refreshTaskList();
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

  /** Push the current work state to the webview Work panel */
  public refreshWorkPanel(): void {
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    const goal = cfg.get<string | undefined>("goalObjective") || null;
    this.postMessage({
      type: "workState",
      goal,
      checklist: this.checklistItems,
      checklistCompletionPct: this.checklistCompletionPct,
      strategy: this.strategySteps,
      cycleCount: this.cycleCount,
      coherenceState: this.coherenceState,
      coherenceLabel: this.coherenceLabel,
    });
    this.refreshChangesPanel();
  }

  /** Push file changes to the webview Changes panel */
  private refreshChangesPanel(): void {
    this.postMessage({
      type: "changesState",
      changes: this.turnFileChanges.map(fc => ({
        filePath: fc.filePath,
        changeType: fc.changeType,
        addedLines: fc.addedLines,
        removedLines: fc.removedLines,
        diff: fc.diff,
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
      revertFileChange:
        this.apiCapabilities.snapshotList && this.apiCapabilities.snapshotRestore,
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
    } catch {
      this.apiCapabilities = {
        saveSession: false,
        threadUndo: false,
        threadPatchUndo: false,
        threadRetry: false,
        turnSteer: false,
        snapshotList: false,
        snapshotRestore: false,
        threadUsage: false,
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
      this.postProviders();
    } catch (err) {
      this.debugLog(`refreshProviders failed: ${getErrorMessage(err)}`);
    }
  }

  /** Push the cached provider list + active provider to the webview. */
  private postProviders(): void {
    if (!this.providersCache) return;
    this.postMessage({
      type: "providersUpdated",
      providers: this.providersCache,
      current: this.currentProvider || "",
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
   */
  private async handleSwitchProvider(providerId: string, model?: string): Promise<void> {
    const trimmed = providerId.trim();
    if (!trimmed) {
      this.postMessage({ type: "error", message: "Empty provider id" });
      return;
    }
    try {
      // Single backend call: persists provider (+ model only when given),
      // reloads config, syncs to engines, and returns the resolved model.
      const effectiveModel = model?.trim() || undefined;
      const resp = await this.api.switchProvider(trimmed, effectiveModel);
      const resolvedModel = resp.model;

      // Keep the VSCode-side `defaultModel` config in sync with the
      // backend-resolved model so other UI surfaces (status bar, slash
      // commands) read the same value. Only write when the user explicitly
      // chose a model — when they didn't, the backend's resolved model may
      // already reflect their per-provider config and we don't want to
      // surface it as a global default.
      if (effectiveModel) {
        await vscode.workspace.getConfiguration("brotherwhale").update(
          "defaultModel", resolvedModel, vscode.ConfigurationTarget.Global
        );
      }

      await this.refreshProviders();
      await this.handleRequestProviderModels(trimmed, resolvedModel);
      this.postMessage({
        type: "settingsUpdated",
        model: resolvedModel,
        mode: this.getCurrentMode(),
        reasoningEffort: this.getCurrentReasoningEffort(),
        provider: resp.provider || trimmed,
      });
      this.postMessage({
        type: "info",
        message: resp.message ||
          `Provider switched to ${resp.provider || trimmed} (model: ${resolvedModel}).`,
      });
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
  private async handleRequestProviderModels(providerId: string, currentModel?: string): Promise<void> {
    const trimmed = providerId.trim();
    if (!trimmed) return;
    try {
      const resp = await this.api.listProviderModels(trimmed);
      // Determine whether this provider has a built-in catalog so the
      // webview can show a free-text hint when models is empty.
      const info = this.providersCache?.find(p => p.id === trimmed);
      const effectiveCurrentModel = currentModel?.trim()
        || info?.default_model
        || undefined;
      this.postMessage({
        type: "providerModels",
        provider: trimmed,
        models: resp.models.map(m => m.id),
        currentModel: effectiveCurrentModel,
        hasCatalog: info ? info.has_model_catalog : (resp.models.length > 0),
      });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: `Failed to list models for provider ${trimmed}: ${getErrorMessage(err)}`,
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

  private startPeriodicTaskRefresh(): void {
    this.stopPeriodicTaskRefresh();
    this.taskRefreshTimer = setInterval(() => {
      this.refreshTaskList();
    }, 2500);
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

        if (this.currentTurnId) {
          try {
            await this.api.interruptTurn(this.currentThread.id, this.currentTurnId);
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
        this.pendingApprovals.clear();
        this.postMessage({ type: "turnInterrupted" });
      } catch {
        // ignore
      }
    }
  }

  /** Show confirmation dialog if a turn is currently in progress.
   *  Returns true if it's safe to proceed (no active turn or user confirmed). */
  private async confirmSwitchWhenActive(): Promise<boolean> {
    if (!this.currentTurnId) return true;

    const confirm = await vscode.window.showWarningMessage(
      t().switchSessionActiveTurnTitle,
      { modal: true },
      t().switchSessionActiveTurnButton,
    );
    if (confirm !== t().switchSessionActiveTurnButton) return false;

    // Interrupt the current turn before switching
    if (this.currentThread && this.currentTurnId) {
      try {
        await this.api.interruptTurn(this.currentThread.id, this.currentTurnId);
      } catch {
        // ignore
      }
      this.currentTurnId = null;
      this.pendingApprovals.clear();
      this.postMessage({ type: "turnInterrupted" });
    }
    return true;
  }

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

      // Use patch-undo endpoint: tries snapshot file rollback first,
      // then removes the last conversation turn — same as TUI's `/undo`.
      const result = await this.api.patchUndoThreadTurn(this.currentThread.id);

      // Show file rollback info if files were restored.
      if (result.patch_result.files_restored && result.patch_result.summary) {
        this.postMessage({ type: "info", message: result.patch_result.summary });
      }

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
   * Revert a file change by restoring the most recent pre-turn snapshot
   * via the server-side SnapshotRepo API. This matches TUI's `patch_undo`
   * behavior — using git-based snapshots instead of client-side diff
   * reconstruction, which is more reliable and supports multiple undos.
   */
  private async handleRevertFileChange(
    filePath: string,
    _changeType: string,
    _diff: string | undefined
  ): Promise<void> {
    if (
      !this.apiCapabilities.snapshotList ||
      !this.apiCapabilities.snapshotRestore
    ) {
      this.postMessage({ type: "info", message: t().revertNotSupported });
      return;
    }

    try {
      await this.api.ensureReady();

      // Find the most recent pre-turn snapshot.
      const snapshots = await this.api.listSnapshots({ limit: 20 });
      const preTurn = snapshots.find((s) => s.label.startsWith("pre-turn:"));

      if (!preTurn) {
        this.postMessage({ type: "info", message: t().revertNotAvailable });
        return;
      }

      // Restore the snapshot on the server side.
      await this.api.restoreSnapshot(preTurn.id);

      // Remove the change from the in-memory turn record.
      this.turnFileChanges = this.turnFileChanges.filter(
        (fc) => fc.filePath !== filePath
      );
      this.refreshWorkPanel();

      this.postMessage({ type: "info", message: t().revertSuccess(filePath) });
    } catch (err) {
      this.postMessage({
        type: "error",
        message: t().revertFailure(filePath, getErrorMessage(err)),
      });
    }
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

  private async handleApprovalDecision(
    approvalId: string,
    decision: "allow" | "deny",
    remember = false
  ): Promise<void> {
    try {
      await this.api.decideApproval(approvalId, decision, remember);
      // When the user checks "remember" and allows, the TUI flips
      // thread.auto_approve to true (see runtime_threads.rs
      // remember_thread_auto_approve).  Update our local cache immediately
      // so subsequent approval.required events are correctly filtered out
      // — otherwise the stale cache causes the GUI to show approval
      // dialogs for tools the TUI has already auto-approved server-side,
      // leading to a frozen UI (no approval.decided event arrives for
      // auto-approved calls, so the dialog never clears).
      if (remember && decision === "allow" && this.currentThread) {
        this.currentThread = { ...this.currentThread, auto_approve: true };
      }
      const tc = this.pendingApprovals.get(approvalId);
      if (tc) {
        tc.status = decision === "allow" ? "running" : "error";
        tc.approvalId = undefined;
      }
      this.pendingApprovals.delete(approvalId);
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
    const pending = this.pendingUserInputs.get(inputId);
    if (!pending) return;

    pending.answers.push({
      id: questionId,
      label: optionLabel,
      value: optionLabel,
    });
    pending.answeredQuestions.add(questionId);

    const allAnswered = pending.questions.every(q => pending.answeredQuestions.has(q.id));
    if (allAnswered) {
      try {
        await this.api.submitUserInput(pending.threadId, inputId, pending.answers);
        this.pendingUserInputs.delete(inputId);
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
        this.pendingUserInputs.delete(inputId);
      }
    }
  }

  private async handleUserInputCancel(inputId: string): Promise<void> {
    const pending = this.pendingUserInputs.get(inputId);
    try {
      if (pending) {
        await this.api.submitUserInput(pending.threadId, inputId, []);
      }
    } catch {
      // ignore cancellation errors
    }
    this.pendingUserInputs.delete(inputId);
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

  private async handleOpenDiff(filePath: string, diff?: string, useCumulative?: boolean, diffIndex?: number): Promise<void> {
    try {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspace) return;

      const absPath = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);

      // Look up the full diffs array from turnFileChanges for multi-edit files
      const normPath = normalizePath(filePath);
      const existing = this.turnFileChanges.find(fc => normalizePath(fc.filePath) === normPath);
      const diffs = existing?.diffs;
      // Use cumulative mode only when explicitly requested (changes sidebar)
      const useCumulativeMode = useCumulative && diffs && diffs.length > 0;

      if (useCumulativeMode || diff) {
        this.ensureDiffProvider();

        let oldContent: string;
        let newContent: string;

        if (useCumulativeMode) {
          // Cumulative mode (changes sidebar): read current file, reverse-apply all diffs
          try {
            const currentUri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(currentUri);
            newContent = doc.getText();
          } catch (err) {
            const parsed = parseDiffToSides(diffs![0]);
            newContent = parsed.newContent;
          }

          const reconstructed = reconstructOriginalContent(diffs!, newContent);
          if (reconstructed !== null) {
            oldContent = reconstructed;
          } else {
            const fallbackDiff = diff || diffs![diffs!.length - 1];
            const singleReconstructed = reconstructOldContent(newContent, fallbackDiff);
            oldContent = singleReconstructed !== null ? singleReconstructed : parseDiffToSides(fallbackDiff).oldContent;
          }
        } else if (diffs && diffs.length > 0 && diffIndex !== undefined && diffIndex >= 0) {
          // Single diff with precise indexing: reconstruct full-file old/new for this specific change
          try {
            const currentUri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(currentUri);
            const state = getDiffStateForIndex(diffs, doc.getText(), diffIndex);
            if (state) {
              oldContent = state.oldContent;
              newContent = state.newContent;
            } else {
              // Reconstruction failed, fall back to parsing diff
              const parsed = parseDiffToSides(diff!);
              oldContent = parsed.oldContent;
              newContent = parsed.newContent;
            }
          } catch (err) {
            const parsed = parseDiffToSides(diff!);
            oldContent = parsed.oldContent;
            newContent = parsed.newContent;
          }
        } else {
          // Single diff without indexing (only one modification): read file, reverse-apply
          try {
            const currentUri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(currentUri);
            newContent = doc.getText();
            const reconstructed = reconstructOldContent(newContent, diff!);
            oldContent = reconstructed !== null ? reconstructed : parseDiffToSides(diff!).oldContent;
          } catch (err) {
            const parsed = parseDiffToSides(diff!);
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
      // Try task artifact path first, then fallback to workspace relative
      const absPath = resolveTaskArtifactPath(filePath);
      const normalizedAbsPath = path.normalize(absPath);
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
              { usage: pl.turn?.usage },
            );
            this.postMessage(payload);
          }
        }
        // Auto-save session after each completed turn (mirrors TUI's
        // build_session_snapshot → SessionSnapshot). Same thread always
        // saves to the same session via PUT with session_id.
        this.autoSaveSession();
        this.refreshSessionList();
        this.stopPeriodicTaskRefresh();
        this.refreshTaskList();
        this.refreshWorkPanel();
        break;
      }

      case "cycle.advanced": {
        const pl = event.payload as { from?: number; to?: number; cycle?: number };
        this.cycleCount = pl.to ?? pl.cycle ?? 0;
        this.refreshWorkPanel();
        break;
      }

      case "coherence.state": {
        const pl = event.payload as { state?: string; label?: string; description?: string };
        this.coherenceState = pl.state || "healthy";
        this.coherenceLabel = pl.label || pl.description || "";
        this.refreshWorkPanel();
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

        // In YOLO/auto-approve mode, the TUI runtime auto-approves after
        // emitting this event (see runtime_threads.rs:2748-2761).  Mirror
        // the TUI UI behaviour (ui.rs:2427) and skip the approval dialog
        // entirely so the user isn't shown a confusing confirmation that
        // has already been decided server-side.
        const thread = this.currentThread;
        if (thread?.auto_approve || thread?.trust_mode) {
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
        const tc = this.pendingApprovals.get(approvalId);
        if (tc) {
          tc.status = pl.decision === "allow" ? "running" : "error";
          tc.approvalId = undefined;
        }
        this.pendingApprovals.delete(approvalId);
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
        const tc = this.pendingApprovals.get(approvalId);
        if (tc) {
          tc.status = "error";
          tc.approvalId = undefined;
        }
        this.pendingApprovals.delete(approvalId);
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

          if (isFileChangeTool(toolName)) {
            let filePath = "";
            let diff: string | undefined;
            if (tc?.input) {
              filePath = extractFilePath(toolName, tc.input);
            }
            const output = pl.item?.detail || tc?.output || "";
            diff = extractDiffForTool(toolName, tc?.input as Record<string, unknown> | undefined, output);
            if (!filePath && diff) {
              filePath = extractFilePathFromDiff(diff);
            }
            if (!filePath && pl.item?.metadata) {
              const meta = pl.item.metadata;
              filePath = (meta.file_path || meta.path || "") as string;
            }
            if (filePath) {
              const stats = diff ? parseDiffStats(diff) : { added: 0, removed: 0 };
              const changeType: "created" | "modified" | "deleted" =
                toolName === "delete_file" ? "deleted" :
                toolName === "write_file" && !diff ? "created" : "modified";
              const fc: FileChangeInfo = {
                filePath,
                changeType,
                addedLines: stats.added,
                removedLines: stats.removed,
                diff,
                toolName,
              };
              if (tc) {
                tc.fileChange = fc;
              }
              const normPath = normalizePath(fc.filePath);
              const existingIdx = this.turnFileChanges.findIndex(existing => normalizePath(existing.filePath) === normPath);
              // Set diffIndex on fc before merging (index in the diffs array this diff will occupy)
              if (fc.diff) {
                const prevDiffs = existingIdx >= 0
                  ? (this.turnFileChanges[existingIdx].diffs ?? (this.turnFileChanges[existingIdx].diff ? [this.turnFileChanges[existingIdx].diff] : []))
                  : [];
                fc.diffIndex = prevDiffs.length;
              }
              if (existingIdx >= 0) {
                // Merge with existing change for cumulative stats
                const existing = this.turnFileChanges[existingIdx];
                const existingDiffs = existing.diffs ?? (existing.diff ? [existing.diff] : []);
                const newDiffs = fc.diff ? [...existingDiffs, fc.diff] : existingDiffs;
                this.turnFileChanges[existingIdx] = {
                  ...fc,
                  addedLines: existing.addedLines + fc.addedLines,
                  removedLines: existing.removedLines + fc.removedLines,
                  changeType: fc.changeType === "created" ? "created" :
                             fc.changeType === "deleted" && existing.changeType !== "created" ? "deleted" :
                             existing.changeType,
                  diff: fc.diff ?? existing.diff,
                  diffs: newDiffs,
                  toolName: fc.toolName ?? existing.toolName,
                };
              } else {
                this.turnFileChanges.push({
                  ...fc,
                  diffs: fc.diff ? [fc.diff] : [],
                });
              }
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
            reasoning_tokens: 0,
            cost_usd: 0,
            turns: 0,
          };
      this.totalInputTokens = totals.input_tokens;
      this.totalOutputTokens = totals.output_tokens;
      this.totalTokens = totals.input_tokens + totals.output_tokens;
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

  public getCurrentModel(): string {
    const cfg = vscode.workspace.getConfiguration("brotherwhale");
    return cfg.get<string>("defaultModel", "deepseek-v4-pro");
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
    return cfg.get<string>("defaultMode", "agent");
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
    this.eventController?.abort();
    this.eventController = null;
    this.stopPeriodicTaskRefresh();
    this.stopActiveTaskDetailRefresh();
    this.activeTaskDetailId = null;
    this.diffContentStore.clear();
    this.diffProviderDisposable?.dispose();
    this.diffProviderDisposable = null;
  }

  dispose(): void {
    this.cleanup();
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
