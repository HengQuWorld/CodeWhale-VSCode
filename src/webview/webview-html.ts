import * as vscode from "vscode";
import { getWebviewCss } from "./webview-css";
import { getUtilitiesScript } from "./webview-js-utilities";
import { getDebugScript } from "./webview-js-debug";
import { getTooltipScript } from "./webview-js-tooltip";
import { getSidebarScript } from "./webview-js-sidebar";
import { getMessagesScript } from "./webview-js-messages";
import { getInputScript } from "./webview-js-input";
import { getEventHandlerScript } from "./webview-js-event-handler";

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
  modeLabel: string;
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
  cycles: string;
  coherenceHealthy: string;
  coherenceGettingCrowded: string;
  coherenceRefreshingContext: string;
  coherenceVerifyingRecentWork: string;
  coherenceResettingPlan: string;
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
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeWhale Chat</title>
  <style nonce="${nonce}">
${css}
  </style>
</head>
<body>
  <div id="task-detail-overlay" class="task-detail-overlay"></div>
  <div id="agent-detail-overlay" class="task-detail-overlay"></div>
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
          <span class="sidebar-section-title">◆ ${tr.work}</span>
          <span class="sidebar-section-arrow">▼</span>
        </div>
        <div class="sidebar-section-body" id="tab-work"></div>
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
            <span class="setting-value" id="current-mode">agent</span>
            <div class="dropdown-menu" id="dropdown-mode">
              <div class="dropdown-item" data-value="agent">agent</div>
              <div class="dropdown-item" data-value="plan">plan</div>
              <div class="dropdown-item" data-value="yolo">yolo</div>
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
        <button id="btn-config" title="Open Config Panel">⚙</button>
      </div>
      <div id="messages-wrapper">
        <div id="messages"></div>
        <div id="message-nav"></div>
      </div>
      <div id="toolbar">
        <button id="btn-new-thread">${tr.newThread}</button>
        <button id="btn-compact">${tr.compact}</button>
        <button id="btn-undo" title="Undo last turn">↩ Undo</button>
        <button id="btn-retry" title="Retry last turn">🔁 Retry</button>
        <span class="thread-count" id="thread-count" title="${tr.toggleHistory}">0 sessions</span>
      </div>
      <div id="input-resize-handle" title="Drag to resize input area"></div>
      <div id="input-area">
        <div id="slash-menu"></div>
        <div id="attachments-area"></div>
        <div id="input-row">
          <button id="btn-attach" title="${tr.attachFiles}">📎</button>
          <textarea id="input" placeholder="${tr.inputPlaceholder}" rows="1"></textarea>
          <button id="btn-send-stop" class="btn-send-stop">
            <span class="btn-text-send">${tr.send}</span>
            <span class="btn-text-stop">${tr.interrupt}</span>
          </button>
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
        workState: { goal: null, checklist: [], checklistCompletionPct: 0, strategy: [], cycleCount: 0, coherenceState: 'healthy', coherenceLabel: '' },
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

      function onMouseDown(e) {
        startX = e.clientX;
        startWidth = panel.getBoundingClientRect().width;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      }

      function onMouseMove(e) {
        if (startX === undefined) return;
        var newWidth = startWidth + (e.clientX - startX);
        if (newWidth < 120) newWidth = 120;
        if (newWidth > 600) newWidth = 600;
        panel.style.width = newWidth + 'px';
      }

      function onMouseUp() {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
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
      if (!handle || !inputArea) return;

      // Restore saved height from previous session
      try {
        var savedHeight = localStorage.getItem('codewhale:inputAreaHeight');
        if (savedHeight) {
          var h = parseInt(savedHeight, 10);
          if (h >= 56 && h <= 400) {
            inputArea.style.height = h + 'px';
            // Reset textarea height so it fills the restored container
            var input = document.getElementById('input');
            if (input) input.style.height = 'auto';
          }
        }
      } catch(e) { /* localStorage may not be available */ }

      var startY, startHeight;

      function onMouseDown(e) {
        startY = e.clientY;
        startHeight = inputArea.getBoundingClientRect().height;
        handle.classList.add('active');
        inputArea.classList.add('resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      }

      function onMouseMove(e) {
        if (startY === undefined) return;
        var newHeight = startHeight - (e.clientY - startY);
        if (newHeight < 56) newHeight = 56;
        if (newHeight > 400) newHeight = 400;
        inputArea.style.height = newHeight + 'px';
        // Keep textarea filling the container during resize
        var input = document.getElementById('input');
        if (input) input.style.height = 'auto';
      }

      function onMouseUp() {
        handle.classList.remove('active');
        inputArea.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        // Save height for next session
        try {
          var finalHeight = inputArea.getBoundingClientRect().height;
          localStorage.setItem('codewhale:inputAreaHeight', String(Math.round(finalHeight)));
        } catch(e) { /* ignore localStorage errors */ }
        // Reset textarea height so it fills the resized container
        var input = document.getElementById('input');
        if (input) input.style.height = 'auto';
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
