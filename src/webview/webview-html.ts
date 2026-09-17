import * as vscode from "vscode";
import { getWebviewCss } from "./webview-css";
import { getUtilitiesScript } from "./webview-js-utilities";
import { getDebugScript } from "./webview-js-debug";
import { getTooltipScript } from "./webview-js-tooltip";
import { getSidebarScript } from "./webview-js-sidebar";
import { getMessagesScript } from "./webview-js-messages";
import { getInputScript } from "./webview-js-input";
import { getEventHandlerScript } from "./webview-js-event-handler";
import { getFleetScript } from "./webview-js-fleet";
import { getGoalScript } from "./webview-js-goal";
import {
  MODE_LABELS,
  MODE_VALUES,
  POSTURE_LABELS,
  POSTURE_VALUES,
} from "../utils/modes";

/** Status-bar dropdown options, generated from the single source of truth in
 *  `utils/modes.ts` so a roster change cannot drift between engine and UI. */
const MODE_DROPDOWN_ITEMS = MODE_VALUES.map(
  (value) => `<div class="dropdown-item" data-value="${value}">${MODE_LABELS[value]}</div>`,
).join("\n              ");
const POSTURE_DROPDOWN_ITEMS = POSTURE_VALUES.map(
  (value) => `<div class="dropdown-item" data-value="${value}">${POSTURE_LABELS[value]}</div>`,
).join("\n              ");

export interface WebviewTranslations {
  locale: string; // "en" or "zh-cn"
  history: string;
  threads: string;
  sessions: string;
  tasks: string;
  work: string;
  newThread: string;
  compact: string;
  interrupt: string;
  toggleHistory: string;
  send: string;
  inputPlaceholder: string;
  initializing: string;
  ready: string;
  thinking: string;
  streaming: string;
  processing: string;
  error: string;
  approvalAwaiting: string;
  noConversations: string;
  threadAttention: string;
  noTasks: string;
  taskCreate: string;
  taskCreateTitle: string;
  taskCreatePlaceholder: string;
  taskCreateSubmit: string;
  taskRefresh: string;
  taskDetails: string;
  taskOpenThread: string;
  taskAttention: string;
  taskNeedsAttention: string;
  taskPendingApprovals: string;
  taskPendingInputs: string;
  taskContinueInThread: string;
  threadsCountPattern: string; // "{n} threads" / "{n} 个会话"
  modelLabel: string;
  workspaceLabel: string;
  loadedThreadPattern: string; // "Loaded: {0}" / "已加载: {0}"
  showAllWorkspaces: string;
  filterCurrentWorkspace: string;
  approvalRequired: string;
  allow: string;
  deny: string;
  thinkingToggle: string;
  thinkingOpen: string;
  thinkingClose: string;
  steerPlaceholder: string;
  steerBadge: string;
  steerBadgeTitle: string;
  modeLabel: string;
  permissionLabel: string;
  reasoningEffortLabel: string;
  welcomeTitle: string;
  welcomeSubtitle: string;
  welcomeQuote: string;
  welcomeQuoteAuthor: string;
  welcomeSuggestionTitle: string;
  welcomeSuggestion1: string;
  welcomeSuggestion2: string;
  welcomeSuggestion3: string;
  welcomeSuggestion4: string;
  noActiveWork: string;
  cancel: string;
  goal: string;
  checklist: string;
  strategy: string;
  completionPct: string;
  readyTimedOut: string;
  note: string;
  noPreviousMessage: string;
  justNow: string;
  minutesAgoPattern: string;
  hoursAgoPattern: string;
  daysAgoPattern: string;
  commandMode: string;
  commandModel: string;
  commandModels: string;
  commandReasoning: string;
  commandConfig: string;
  commandSettings: string;
  commandClear: string;
  commandInterrupt: string;
  commandHelp: string;
  commandCompact: string;
  commandExit: string;
  commandRename: string;
  commandSave: string;
  commandExport: string;
  commandContext: string;
  commandTokens: string;
  commandCost: string;
  commandStatus: string;
  commandHome: string;
  commandWorkspace: string;
  commandTask: string;
  commandJobs: string;
  commandNote: string;
  commandMemory: string;
  commandTrust: string;
  commandVerbose: string;
  commandTheme: string;
  commandUndo: string;
  commandRetry: string;
  commandShare: string;
  commandGoal: string;
  commandSkills: string;
  commandSkill: string;
  commandMcp: string;
  commandNetwork: string;
  commandProvider: string;
  commandQueue: string;
  commandStash: string;
  commandHooks: string;
  commandSubagents: string;
  commandAgent: string;
  commandLinks: string;
  commandFeedback: string;
  commandAttach: string;
  commandAnchor: string;
  commandSessions: string;
  commandLoad: string;
  commandCycles: string;
  commandCycle: string;
  commandRecall: string;
  commandRelay: string;
  commandInit: string;
  commandLsp: string;
  commandReview: string;
  commandRestore: string;
  commandRlm: string;
  commandChange: string;
  commandCache: string;
  commandProfile: string;
  commandTranslate: string;
  commandSystem: string;
  commandEdit: string;
  commandDiff: string;
  commandStatusline: string;
  commandLogout: string;
  commandNotAvailableInGui: string;
  attachFiles: string;
  removeAttachment: string;
  attachedFileCount: string;
  fileNotSupported: string;
  changes: string;
  noFileChanges: string;
  undoLastTurn: string;
  retryLastTurn: string;
  undoLabel: string;
  retryLabel: string;
  undoUnsupportedTooltip: string;
  retryUnsupportedTooltip: string;
  revertUnsupportedTooltip: string;
  fileCreated: string;
  fileDeleted: string;
  fileModified: string;
  viewDiff: string;
  viewDiffTooltip: string;
  openFile: string;
  openFileTooltip: string;
  revertFile: string;
  revertFileTooltip: string;
  fileChanges: string;
  userInputAwaiting: string;
  // Session search & delete
  searchSessions: string;
  searchPlaceholder: string;
  deleteSession: string;
  deleteSessionConfirmTitle: string;
  deleteSessionConfirmMessage: string;
  deleteSessionConfirmButton: string;
  deleteSessionSuccess: string;
  deleteSessionFailed: string;
  noSearchResults: string;
  // Agent panel
  agents: string;
  noAgentRuns: string;
  agentStatusQueued: string;
  agentStatusStarting: string;
  agentStatusRunning: string;
  agentStatusWaitingForUser: string;
  agentStatusModelWait: string;
  agentStatusRunningTool: string;
  agentStatusCompleted: string;
  agentStatusFailed: string;
  agentStatusCancelled: string;
  agentStatusInterrupted: string;
  agentObjective: string;
  agentModel: string;
  agentSteps: string;
  agentResult: string;
  agentError: string;
  agentRole: string;
  agentArtifacts: string;
  agentUsage: string;
  agentSpawned: string;
  agentDelegating: string;
  agentFanout: string;
  // Fleet panel
  fleet: string;
  noFleetRuns: string;
  fleetWorkers: string;
  fleetTasks: string;
  fleetReceipts: string;
  fleetStart: string;
  fleetStop: string;
  fleetRestart: string;
  fleetStatus: string;
  fleetAttempts: string;
  fleetScore: string;
  fleetViewReply: string;
  fleetTaskInstructions: string;
  fleetNewFromRun: string;
  fleetNewFromRunHint: string;
  fleetEvFilterIssues: string;
  fleetEvFilterProgress: string;
  fleetEvFilterAll: string;
  fleetTaskFailure: string;
  fleetEvRunCreated: string;
  fleetEvRunStatus: string;
  fleetEvEnqueued: string;
  fleetEvLeased: string;
  fleetEvTerminal: string;
  fleetEvReceipt: string;
  fleetEvHeartbeat: string;
  fleetEvAlert: string;
  fleetInterrupt: string;
  fleetStEnqueued: string;
  fleetStLeased: string;
  fleetStCompleted: string;
  fleetStFailed: string;
  fleetStCancelled: string;
  fleetStUnknown: string;
  fleetStOnline: string;
  fleetStBusy: string;
  fleetStOffline: string;
  fleetStUnhealthy: string;
  fleetStDraining: string;
  fleetStRetired: string;
  fleetStQueued: string;
  fleetStPending: string;
  fleetStRunning: string;
  fleetStPaused: string;
  fleetStEnqueuedHint: string;
  fleetLatestMessage: string;
  fleetNoWorkers: string;
  fleetNoTasks: string;
  fleetNoReceipts: string;
  fleetRunId: string;
  fleetTaskCount: string;
  fleetWorkerCount: string;
  fleetCreate: string;
  fleetCreateDesc: string;
  fleetCreateName: string;
  fleetCreateWorkflowId: string;
  fleetCreateMaxWorkers: string;
  fleetCreateRoles: string;
  fleetCreateRolesHint: string;
  fleetProfileNone: string;
  fleetCreateStartNow: string;
  fleetCreateBasics: string;
  fleetCreateBasicsDesc: string;
  fleetCreateRolesDesc: string;
  fleetCreateTasksDesc: string;
  fleetCreateTasks: string;
  fleetCreateAddRole: string;
  fleetCreateAddTask: string;
  fleetCreateTaskId: string;
  fleetCreateTaskName: string;
  fleetCreateTaskRole: string;
  fleetCreateTaskObjective: string;
  fleetCreateTaskInstructions: string;
  fleetCreateRemove: string;
  fleetCreateSubmit: string;
  fleetCreateTokenError: string;
  fleetCreateDuplicate: string;
  // Goal control plane
  goalStatus: string;
  goalBudget: string;
  goalTokensUsed: string;
  goalTimeUsed: string;
  goalContinuations: string;
  goalSet: string;
  goalEdit: string;
  goalComplete: string;
  goalBlock: string;
  goalDelete: string;
  goalObjectivePlaceholder: string;
  goalNoGoal: string;
  goalTokenBudgetLabel: string;
  goalCreatedAt: string;
  goalBudgetTooltip: string;
  goalTokensUsedTooltip: string;
  goalTimeUsedTooltip: string;
  goalContinuationsTooltip: string;
  goalBudgetExceeded: string;
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  tr: WebviewTranslations
): string {
  const nonce = getNonce();
  const css = getWebviewCss();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeWhale Chat</title>
  <style nonce="${nonce}">
${css}
  </style>
</head>
<body>
  <div id="task-detail-overlay" class="task-detail-overlay"></div>
  <div id="agent-detail-overlay" class="task-detail-overlay"></div>
  <div id="fleet-detail-overlay" class="task-detail-overlay"></div>
  <div id="fleet-create-overlay" class="task-detail-overlay"></div>
  <div id="task-create-overlay" class="task-detail-overlay"></div>
  <div id="layout">
    <div id="threads-panel">
      <div class="sidebar-section" id="sidebar-threads" data-active-tab="sessions">
        <div class="sidebar-tabs">
          <button class="sidebar-tab active" id="tab-sessions-btn" data-tab="sessions">${tr.sessions}</button>
          <button class="sidebar-tab" id="tab-threads-btn" data-tab="threads">${tr.threads}</button>
          <span class="sidebar-section-action" id="workspace-filter-toggle" title="${tr.showAllWorkspaces}">🌐</span>
        </div>
        <div class="sidebar-section-body" id="tab-sessions"></div>
        <div class="sidebar-section-body" id="tab-threads-list"></div>
      </div>
      <div class="sidebar-section" id="sidebar-work">
        <div class="sidebar-section-header" id="work-section-toggle">
          <span class="sidebar-section-title">🎯 ${tr.work}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-work">
          <div id="work-goal"></div>
          <div id="work-body"></div>
        </div>
      </div>
      <div class="sidebar-section" id="sidebar-fleet">
        <div class="sidebar-section-header" id="fleet-section-toggle">
          <span class="sidebar-section-title">🚀 ${tr.fleet}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-fleet"></div>
      </div>
      <div class="sidebar-section" id="sidebar-tasks">
        <div class="sidebar-section-header" id="tasks-section-toggle">
          <span class="sidebar-section-title">⚙ ${tr.tasks}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-tasks"></div>
      </div>
      <div class="sidebar-section" id="sidebar-agents">
        <div class="sidebar-section-header" id="agents-section-toggle">
          <span class="sidebar-section-title">🤖 ${tr.agents}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-agents"></div>
      </div>
      <div class="sidebar-section" id="sidebar-changes">
        <div class="sidebar-section-header" id="changes-section-toggle">
          <span class="sidebar-section-title">📝 ${tr.changes}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-changes"></div>
      </div>
    </div>
    <div id="sidebar-resize-handle" title="Drag to resize sidebar"></div>

    <div id="chat-area">
      <div id="settings-bar">
        <button id="btn-threads" title="${tr.toggleHistory}">📋</button>
        <div class="setting-item">
          <span class="setting-label">${tr.modeLabel}:</span>
          <div class="setting-dropdown" data-setting="mode">
            <span class="setting-value" id="current-mode" data-value="${MODE_VALUES[0]}">${MODE_LABELS[MODE_VALUES[0]]}</span>
            <div class="dropdown-menu" id="dropdown-mode">
              ${MODE_DROPDOWN_ITEMS}
            </div>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-label">${tr.permissionLabel}:</span>
          <div class="setting-dropdown" data-setting="posture">
            <span class="setting-value" id="current-posture" data-value="${POSTURE_VALUES[0]}">${POSTURE_LABELS[POSTURE_VALUES[0]]}</span>
            <div class="dropdown-menu" id="dropdown-posture">
              ${POSTURE_DROPDOWN_ITEMS}
            </div>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-label">Provider:</span>
          <div class="setting-dropdown" data-setting="provider">
            <span class="setting-value" id="current-provider">deepseek</span>
            <div class="dropdown-menu" id="dropdown-provider">
              <div class="dropdown-item" data-value="deepseek">deepseek</div>
            </div>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-label">${tr.modelLabel}:</span>
          <div class="setting-dropdown" data-setting="model">
            <span class="setting-value" id="current-model">deepseek-v4-pro</span>
            <div class="dropdown-menu" id="dropdown-model">
              <div class="dropdown-item" data-value="deepseek-v4-pro">deepseek-v4-pro</div>
              <div class="dropdown-item" data-value="deepseek-v4-flash">deepseek-v4-flash</div>
              <div class="dropdown-item" data-value="deepseek-chat">deepseek-chat</div>
              <div class="dropdown-item" data-value="deepseek-reasoner">deepseek-reasoner</div>
            </div>
          </div>
        </div>
        <div class="setting-item">
          <span class="setting-label">${tr.reasoningEffortLabel}:</span>
          <div class="setting-dropdown" data-setting="reasoning">
            <span class="setting-value" id="current-reasoning">auto</span>
            <div class="dropdown-menu" id="dropdown-reasoning">
              <div class="dropdown-item" data-value="auto">auto</div>
              <div class="dropdown-item" data-value="off">off</div>
              <div class="dropdown-item" data-value="low">low</div>
              <div class="dropdown-item" data-value="medium">medium</div>
              <div class="dropdown-item" data-value="high">high</div>
              <div class="dropdown-item" data-value="max">max</div>
            </div>
          </div>
        </div>
      </div>
      <div id="messages-wrapper">
        <div id="messages"></div>
        <div id="message-nav"></div>
      </div>
      <div id="toolbar">
        <button id="btn-new-thread">${tr.newThread}</button>
        <button id="btn-compact">${tr.compact}</button>
        <button id="btn-undo" title="${tr.undoLastTurn}">↩ ${tr.undoLabel}</button>
        <button id="btn-retry" title="${tr.retryLastTurn}">🔁 ${tr.retryLabel}</button>
        <span class="thread-count" id="thread-count" title="${tr.toggleHistory}">0 sessions</span>
      </div>
      <div id="input-resize-handle" title="Drag to resize input area"></div>
      <div id="input-area">
        <div id="slash-menu"></div>
        <div id="attachments-area"></div>
        <div id="input-box">
          <textarea id="input" placeholder="${tr.inputPlaceholder}" rows="1"></textarea>
          <div id="input-toolbar">
            <button id="btn-attach" title="${tr.attachFiles}">📎</button>
            <button id="btn-send-stop" class="btn-send-stop" title="${tr.send}" aria-label="${tr.send}">
              <svg class="btn-icon-send" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>
              <svg class="btn-icon-stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4.5" y="4.5" width="15" height="15" rx="2.5" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="status-bar" id="status">
        <span class="status-left" id="status-text">${tr.initializing}</span>
        <span class="status-right" id="status-stats"></span>
      </div>
      <div id="ui-tooltip" role="tooltip" aria-hidden="true"></div>
      <div id="debug-panel" class="debug-panel"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    // ── Shared state initialization (must run before IIFE modules) ──
    (function() {
      'use strict';
      // Acquire vscode API and store on window for all modules
      var vscode;
      try {
        vscode = acquireVsCodeApi();
      } catch(e) {
        document.title = 'FATAL: acquireVsCodeApi failed: ' + e.message;
      }
      if (!vscode) {
        document.body.innerHTML = '<div class="fatal-webview-message">FATAL: acquireVsCodeApi() returned null. Webview cannot communicate with extension.</div>';
      }
      window.__wvVscode = vscode;

      // Shared diff store for file changes
      window.__wvDiffStore = new Map();
      window.__wvDiffIdCounter = { value: 0 };

      // Shared API capabilities
      window.__wvApiCapabilities = { saveSession: false, undoLastTurn: false, retryLastTurn: false, revertFileChange: false };

      // Sidebar state exposed for event handler
      window.__wvSidebar = {
        sessions: [],
        activeSessionId: null,
        threads: [],
        activeThreadId: null,
        showAllWorkspaces: false,
        sidebarTab: 'sessions',
        workState: { checklist: [], checklistCompletionPct: 0, strategy: [] },
        renderSessions: function() {},
        renderThreads: function() {},
        renderTasks: function() {},
        renderWork: function() {},
        renderChanges: function() {},
        switchSidebarTab: function() {},
        closeTaskDetail: function() {},
        showTaskDetail: function() {},
        closeAgentDetail: function() {},
        showAgentDetail: function() {},
        setSessions: function(s) { this.sessions = s; },
        setActiveSessionId: function(id) { this.activeSessionId = id; },
        setThreads: function(t) { this.threads = t; },
        setActiveThreadId: function(id) { this.activeThreadId = id; },
        setShowAllWorkspaces: function(v) { this.showAllWorkspaces = v; },
        setWorkState: function(ws) { this.workState = ws; },
        setChangesState: function(cs) { this.changesState = cs; },
      };
    })();
  </script>
  <script nonce="${nonce}">
    ${getUtilitiesScript(tr)}
  </script>
  <script nonce="${nonce}">
    (function() {
      'use strict';
      var handle = document.getElementById('sidebar-resize-handle');
      var panel = document.getElementById('threads-panel');
      if (!handle || !panel) return;

      // Restore saved width from previous session
      try {
        var savedWidth = localStorage.getItem('codewhale:sidebarWidth');
        if (savedWidth) {
          var w = parseInt(savedWidth, 10);
          if (w >= 120 && w <= 600) {
            panel.style.width = w + 'px';
          }
        }
      } catch(e) { /* localStorage may not be available */ }

      var startX, startWidth;
      var lastClientX = 0;
      var rafId = null;

      function onMouseDown(e) {
        startX = e.clientX;
        startWidth = panel.getBoundingClientRect().width;
        handle.classList.add('active');
        document.body.classList.add('is-resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mouseleave', onMouseUp);
        window.addEventListener('blur', onMouseUp);
        e.preventDefault();
      }

      function onMouseMove(e) {
        if (startX === undefined) return;
        lastClientX = e.clientX;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(function() {
          rafId = null;
          if (startX === undefined) return;
          var newWidth = startWidth + (lastClientX - startX);
          if (newWidth < 120) newWidth = 120;
          if (newWidth > 600) newWidth = 600;
          panel.style.width = newWidth + 'px';
        });
      }

      function onMouseUp() {
        handle.classList.remove('active');
        document.body.classList.remove('is-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mouseleave', onMouseUp);
        window.removeEventListener('blur', onMouseUp);
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        // Save width for next session
        try {
          var finalWidth = panel.getBoundingClientRect().width;
          localStorage.setItem('codewhale:sidebarWidth', String(Math.round(finalWidth)));
        } catch(e) { /* ignore localStorage errors */ }
        startX = undefined;
        startWidth = undefined;
      }

      handle.addEventListener('mousedown', onMouseDown);
    })();
  </script>
  <script nonce="${nonce}">
    (function() {
      'use strict';
      var handle = document.getElementById('input-resize-handle');
      var inputArea = document.getElementById('input-area');
      var inputEl = document.getElementById('input');
      if (!handle || !inputArea || !inputEl) return;

      // The drag sizes the textarea itself; the composer box and #input-area are
      // content-sized and simply follow it. These bounds mirror webview-css.ts:
      // the textarea's two-row min-height, and 340px which keeps the whole input
      // area inside its own 400px max-height.
      var MIN_INPUT_HEIGHT = 52;
      var MAX_INPUT_HEIGHT = 340;

      // Restore the height chosen in a previous session
      try {
        var savedHeight = localStorage.getItem('codewhale:inputHeight');
        if (savedHeight) {
          var h = parseInt(savedHeight, 10);
          if (h >= MIN_INPUT_HEIGHT && h <= MAX_INPUT_HEIGHT) {
            inputEl.style.height = h + 'px';
          }
        }
      } catch(e) { /* localStorage may not be available */ }

      var startY, startHeight;
      var lastClientY = 0;
      var rafId = null;

      function onMouseDown(e) {
        startY = e.clientY;
        startHeight = inputEl.getBoundingClientRect().height;
        handle.classList.add('active');
        // Freezes #input-area's height transition so the box tracks the drag.
        inputArea.classList.add('resizing');
        document.body.classList.add('is-resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mouseleave', onMouseUp);
        window.addEventListener('blur', onMouseUp);
        e.preventDefault();
      }

      function onMouseMove(e) {
        if (startY === undefined) return;
        var newHeight = startHeight - (e.clientY - startY);
        if (newHeight < MIN_INPUT_HEIGHT) newHeight = MIN_INPUT_HEIGHT;
        if (newHeight > MAX_INPUT_HEIGHT) newHeight = MAX_INPUT_HEIGHT;
        inputEl.style.height = newHeight + 'px';
      }

      function onMouseUp() {
        handle.classList.remove('active');
        inputArea.classList.remove('resizing');
        document.body.classList.remove('is-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mouseleave', onMouseUp);
        window.removeEventListener('blur', onMouseUp);
        // Save the height for next session
        try {
          var finalHeight = inputEl.getBoundingClientRect().height;
          localStorage.setItem('codewhale:inputHeight', String(Math.round(finalHeight)));
        } catch(e) { /* ignore localStorage errors */ }
        startY = undefined;
        startHeight = undefined;
      }

      handle.addEventListener('mousedown', onMouseDown);
    })();
  </script>
  <script nonce="${nonce}">
    ${getDebugScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getTooltipScript()}
  </script>
  <script nonce="${nonce}">
    ${getSidebarScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getMessagesScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getInputScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getFleetScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getGoalScript(tr)}
  </script>
  <script nonce="${nonce}">
    ${getEventHandlerScript(tr)}
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let result = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
