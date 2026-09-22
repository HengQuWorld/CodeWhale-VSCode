/**
 * Webview JS sidebar module — injected into the webview as an IIFE.
 * Handles sessions, threads, tasks, work panel rendering, and sidebar tab switching.
 */
import type { WebviewTranslations } from "./webview-html";

export function getSidebarScript(_tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var __wvFormatRelativeTime = window.__wvFormatRelativeTime;
  var vscode = window.__wvVscode;

  // ── Sidebar state ──
  var sessions = [];
  var activeSessionId = null;
  var threads = [];
  var activeThreadId = null;
  var showAllWorkspaces = false;
  var sidebarTab = 'sessions';
  var agentPanelToggleEl = document.getElementById('agent-panel-toggle');
  var sessionSearchQuery = '';
  var taskDraftPrompt = '';

  // ── Work state ──
  var workState = { checklist: [], checklistCompletionPct: 0, strategy: [] };

  // ── Changes state ──
  var changesState = [];

  // ── Agent runs state ──
  var agentRuns = [];

  // ── Agent status label helper ──
  function agentStatusLabel(status) {
    var map = {
      queued: __i18n.agentStatusQueued,
      starting: __i18n.agentStatusStarting,
      running: __i18n.agentStatusRunning,
      waiting_for_user: __i18n.agentStatusWaitingForUser,
      model_wait: __i18n.agentStatusModelWait,
      running_tool: __i18n.agentStatusRunningTool,
      completed: __i18n.agentStatusCompleted,
      failed: __i18n.agentStatusFailed,
      cancelled: __i18n.agentStatusCancelled,
      interrupted: __i18n.agentStatusInterrupted,
    };
    return map[status] || status;
  }

  function agentStatusIcon(status) {
    if (status === 'completed') return '\\u2713';
    if (status === 'failed') return '\\u2717';
    if (status === 'cancelled') return '\\u2298';
    if (status === 'interrupted') return '\\u2717';
    if (status === 'running' || status === 'starting' || status === 'running_tool' || status === 'model_wait') return '\\u27F3';
    if (status === 'queued') return '\\u23F3';
    if (status === 'waiting_for_user') return '\\u2709';
    return '\\u00B7';
  }

  function agentStatusColor(status) {
    if (status === 'completed') return '#4caf50';
    if (status === 'failed' || status === 'interrupted') return '#f44336';
    if (status === 'cancelled') return '#888';
    if (status === 'running' || status === 'starting' || status === 'running_tool' || status === 'model_wait') return '#ff9800';
    if (status === 'queued') return '#888';
    if (status === 'waiting_for_user') return '#2196f3';
    return '#888';
  }

  function agentStatusClass(status) {
    if (status === 'completed') return 'status-completed';
    if (status === 'failed' || status === 'interrupted') return 'status-failed';
    if (status === 'cancelled') return 'status-canceled';
    if (status === 'running' || status === 'starting' || status === 'running_tool' || status === 'model_wait') return 'status-running';
    if (status === 'queued') return 'status-queued';
    if (status === 'waiting_for_user') return 'status-muted';
    return 'status-muted';
  }

  function formatAgentTokenUsage(usage) {
    if (!usage) return '';
    var inp = usage.input_tokens || 0;
    var out = usage.output_tokens || 0;
    if (inp === 0 && out === 0) return '';
    var inpK = inp >= 1000 ? (inp / 1000).toFixed(1) + 'k' : String(inp);
    var outK = out >= 1000 ? (out / 1000).toFixed(1) + 'k' : String(out);
    return inpK + ' / ' + outK;
  }

  function formatDetailTime(value) {
    if (!value) return '-';
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  }

  function agentIsRunning(status) {
    return status === 'running' || status === 'starting' || status === 'running_tool' || status === 'model_wait';
  }

  function agentIsLive(status) {
    return agentIsRunning(status) || status === 'queued' || status === 'waiting_for_user';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Full local timestamp — YYYY-MM-DD HH:MM:SS — for an epoch-ms instant,
   *  or '' when the instant is absent. The date belongs in it: an agent can
   *  outlive the session it was started from, so a bare clock time cannot say
   *  which day it ran. */
  function formatAgentTimestamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    var date = new Date(ms);
    if (isNaN(date.getTime())) return '';
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  /** Compact elapsed time: 12s, 3m07s, 2h14m. */
  function formatAgentDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    var total = Math.floor(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    if (hours > 0) return hours + 'h' + pad2(minutes) + 'm';
    if (minutes > 0) return minutes + 'm' + pad2(seconds) + 's';
    return seconds + 's';
  }

  /** Run-time line for one agent: the moment it started running, plus how
   *  long it has run (still live) or took (settled). Records that never
   *  started — queued, or waiting on the user — fall back to their creation
   *  time so the card still answers "when?". Values are read from the run
   *  record at render time; the panel re-renders as runs change. */
  function formatAgentRunTime(r) {
    var startedMs = typeof r.started_at_ms === 'number' ? r.started_at_ms : 0;
    var completedMs = typeof r.completed_at_ms === 'number' ? r.completed_at_ms : 0;
    var startedAt = formatAgentTimestamp(startedMs);
    if (startedAt) {
      var parts = [__i18n.agentStartTime + ' ' + startedAt];
      var endMs = completedMs > 0 ? completedMs : (agentIsRunning(r.status) ? Date.now() : 0);
      var duration = endMs > startedMs ? formatAgentDuration(endMs - startedMs) : '';
      if (duration) {
        parts.push((completedMs > 0 ? __i18n.agentDuration : __i18n.agentElapsed) + ' ' + duration);
      }
      return parts.join(' \\u00B7 ');
    }
    var createdAt = formatAgentTimestamp(typeof r.created_at_ms === 'number' ? r.created_at_ms : 0);
    return createdAt ? (__i18n.agentCreatedAt + ' ' + createdAt) : '';
  }

  function hasOwnData(value) {
    if (!value) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  function renderJsonBlock(value) {
    return '<pre class="detail-json">' + __wvEscapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
  }

  function taskToolStatusIcon(status) {
    if (status === 'completed' || status === 'success') return '\\u2713';
    if (status === 'running' || status === 'in_progress' || status === 'queued') return '\\u27F3';
    if (status === 'failed' || status === 'error' || status === 'interrupted') return '\\u2717';
    if (status === 'canceled' || status === 'cancelled') return '\\u2298';
    return '\\u00B7';
  }

  function taskStatusIcon(status) {
    if (status === 'completed') return '\\u2713';
    if (status === 'running' || status === 'in_progress') return '\\u27F3';
    if (status === 'failed' || status === 'interrupted') return '\\u2717';
    if (status === 'queued') return '\\u23F3';
    if (status === 'canceled' || status === 'cancelled') return '\\u2298';
    return '\\u00B7';
  }

  function taskStatusColor(status) {
    if (status === 'completed') return '#4caf50';
    if (status === 'running' || status === 'in_progress') return '#ff9800';
    if (status === 'failed' || status === 'interrupted') return '#f44336';
    if (status === 'queued') return '#888';
    if (status === 'canceled' || status === 'cancelled') return '#888';
    return '#888';
  }

  function taskStatusClass(status) {
    if (status === 'completed') return 'status-completed';
    if (status === 'running' || status === 'in_progress') return 'status-running';
    if (status === 'failed' || status === 'interrupted') return 'status-failed';
    if (status === 'queued') return 'status-queued';
    if (status === 'canceled' || status === 'cancelled') return 'status-canceled';
    return 'status-muted';
  }

  function taskIsCancelable(status) {
    return status === 'running' || status === 'in_progress' || status === 'queued';
  }

  function timelineKindLabel(kind) {
    if (!kind) return 'event';
    return String(kind).replace(/_/g, ' ');
  }

  function renderOpenFileButton(filePath, label) {
    if (!filePath) return '';
    return '<button class="detail-action-btn detail-open-file" data-file-path="' + __wvEscapeHtml(filePath) + '">' + __wvEscapeHtml(label || 'Open') + '</button>';
  }

  function renderOpenExternalButton(url, label) {
    if (!url) return '';
    return '<button class="detail-action-btn detail-open-external" data-url="' + __wvEscapeHtml(url) + '">' + __wvEscapeHtml(label || 'Open Link') + '</button>';
  }

  function renderDetailCodeBlock(text, className) {
    return '<pre class="' + __wvEscapeHtml(className || 'detail-text-block') + '">' + __wvEscapeHtml(text || '') + '</pre>';
  }

  function attachDetailOverlayActions(overlay, closeFn) {
    overlay.onclick = function(e) {
      if (e.target === overlay) {
        closeFn();
        return;
      }
      var target = e.target;
      var closeBtn = target.closest && target.closest('.close-btn');
      if (closeBtn) {
        e.stopPropagation();
        closeFn();
        return;
      }
      var openFileBtn = target.closest && target.closest('.detail-open-file');
      if (openFileBtn) {
        e.stopPropagation();
        var filePath = openFileBtn.getAttribute('data-file-path');
        if (filePath) vscode.postMessage({ type: 'openFile', filePath: filePath });
        return;
      }
      var openExternalBtn = target.closest && target.closest('.detail-open-external');
      if (openExternalBtn) {
        e.stopPropagation();
        var url = openExternalBtn.getAttribute('data-url');
        if (url) vscode.postMessage({ type: 'openExternal', url: url });
        return;
      }
      var taskCancelBtn = target.closest && target.closest('.detail-task-cancel');
      if (taskCancelBtn) {
        e.stopPropagation();
        var taskId = taskCancelBtn.getAttribute('data-task-id');
        if (taskId) vscode.postMessage({ type: 'cancelTask', taskId: taskId });
        return;
      }
      var taskRefreshBtn = target.closest && target.closest('.detail-task-refresh');
      if (taskRefreshBtn) {
        e.stopPropagation();
        var refreshTaskId = taskRefreshBtn.getAttribute('data-task-id');
        if (refreshTaskId) vscode.postMessage({ type: 'showTaskDetail', taskId: refreshTaskId });
        else vscode.postMessage({ type: 'refreshTaskList' });
        return;
      }
      var taskThreadBtn = target.closest && target.closest('.detail-task-open-thread');
      if (taskThreadBtn) {
        e.stopPropagation();
        var threadId = taskThreadBtn.getAttribute('data-thread-id');
        if (threadId) vscode.postMessage({ type: 'openTaskThread', threadId: threadId });
        return;
      }
      var approvalBtn = target.closest && target.closest('.detail-approval-action');
      if (approvalBtn) {
        e.stopPropagation();
        var approvalId = approvalBtn.getAttribute('data-approval-id');
        var decision = approvalBtn.getAttribute('data-decision');
        if (approvalId && decision) {
          // Read the box from this row, never from the document: the same
          // approval can be on a rail card at the same time, and the first
          // match in DOM order would decide for the user without being asked.
          var approvalRow = approvalBtn.closest ? approvalBtn.closest('.detail-list-item') : null;
          var rememberBox = approvalRow ? approvalRow.querySelector('.remember-check[data-approval-id="' + approvalId + '"]') : null;
          vscode.postMessage({ type: 'approvalDecision', approvalId: approvalId, decision: decision, remember: !!(rememberBox && rememberBox.checked) });
        }
        return;
      }
      var userInputOptionBtn = target.closest && target.closest('.detail-user-input-option');
      if (userInputOptionBtn) {
        e.stopPropagation();
        var inputId = userInputOptionBtn.getAttribute('data-input-id');
        var questionId = userInputOptionBtn.getAttribute('data-question-id');
        var optionIdx = userInputOptionBtn.getAttribute('data-option-idx');
        var optionLabel = userInputOptionBtn.getAttribute('data-option-label');
        if (inputId && questionId && optionIdx !== null && optionLabel) {
          vscode.postMessage({
            type: 'userInputSelect',
            inputId: inputId,
            questionId: questionId,
            optionIdx: parseInt(optionIdx),
            optionLabel: optionLabel,
          });
        }
        return;
      }
      var userInputCancelBtn = target.closest && target.closest('.detail-user-input-cancel');
      if (userInputCancelBtn) {
        e.stopPropagation();
        var cancelInputId = userInputCancelBtn.getAttribute('data-input-id');
        if (cancelInputId) vscode.postMessage({ type: 'userInputCancel', inputId: cancelInputId });
      }
    };
  }
  var _diffStore = window.__wvDiffStore;
  var _diffIdCounter = window.__wvDiffIdCounter;

  // ── Render Sessions ──
  var _sessionSearchInited = false;
  var _searchDebounce = null;

  function initSessionSearch() {
    if (_sessionSearchInited) return;
    var searchInput = document.getElementById('session-search-input');
    if (!searchInput) return;
    searchInput.value = sessionSearchQuery;
    searchInput.addEventListener('input', function() {
      sessionSearchQuery = searchInput.value;
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(function() {
        vscode.postMessage({ type: 'searchSessions', query: sessionSearchQuery });
      }, 300);
    });
    _sessionSearchInited = true;
  }

  function renderSessions() {
    var container = document.getElementById('tab-sessions');
    if (!container) return;
    var count = sessions.length;

    var filterToggle = document.getElementById('workspace-filter-toggle');
    if (filterToggle) {
      filterToggle.textContent = showAllWorkspaces ? '\\uD83C\\uDF0D' : '\\uD83C\\uDF10';
      filterToggle.title = showAllWorkspaces ? __i18n.filterCurrentWorkspace : __i18n.showAllWorkspaces;
      filterToggle.style.opacity = showAllWorkspaces ? '1' : '0.5';
    }

    // Ensure search bar exists (only created once)
    initSessionSearch();

    // Remove only session items, keep the hint and the search bar
    var existing = container.querySelectorAll('.thread-item, .work-empty');
    for (var r = 0; r < existing.length; r++) {
      existing[r].remove();
    }

    if (count === 0) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      var msg = sessionSearchQuery ? __i18n.noSearchResults : __i18n.noConversations;
      el.innerHTML = '<div class="work-empty-icon">\\uD83D\\uDCCB</div><div class="work-empty-text">' + __wvEscapeHtml(msg) + '</div>';
      container.appendChild(el);
      return;
    }

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var el = document.createElement('div');
      el.className = 'thread-item' + (s.id === activeSessionId ? ' active' : '');

      var titleEl = document.createElement('div');
      titleEl.className = 'thread-title';
      titleEl.textContent = s.title || s.id.slice(0, 8);
      el.appendChild(titleEl);

      var metaEl = document.createElement('div');
      metaEl.className = 'thread-meta';

      var modeEl = document.createElement('span');
      modeEl.className = 'session-mode-badge';
      modeEl.textContent = s.mode || 'agent';
      metaEl.appendChild(modeEl);

      if (showAllWorkspaces && s.workspace) {
        var wsEl = document.createElement('span');
        wsEl.className = 'session-workspace';
        var wsName = s.workspace.split('/').pop() || s.workspace;
        wsEl.textContent = wsName;
        wsEl.title = s.workspace;
        metaEl.appendChild(wsEl);
      }

      if (s.message_count) {
        var msgEl = document.createElement('span');
        msgEl.textContent = s.message_count + ' msgs';
        metaEl.appendChild(msgEl);
      }

      // Cost (if available)
      if (s.cost && typeof s.cost.session_cost_usd === 'number' && s.cost.session_cost_usd > 0) {
        var costEl = document.createElement('span');
        costEl.className = 'session-cost';
        costEl.textContent = '$' + s.cost.session_cost_usd.toFixed(2);
        metaEl.appendChild(costEl);
      }

      // Total tokens (if available)
      if (typeof s.total_tokens === 'number' && s.total_tokens > 0) {
        var tokEl = document.createElement('span');
        tokEl.className = 'session-tokens';
        if (s.total_tokens >= 1000) {
          tokEl.textContent = (s.total_tokens / 1000).toFixed(1) + 'k';
        } else {
          tokEl.textContent = String(s.total_tokens);
        }
        metaEl.appendChild(tokEl);
      }

      if (s.updated_at) {
        var timeEl = document.createElement('span');
        timeEl.textContent = __wvFormatRelativeTime(s.updated_at);
        metaEl.appendChild(timeEl);
      }

      el.appendChild(metaEl);

      // Delete button
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete-btn';
      deleteBtn.textContent = '\\u2715';
      deleteBtn.title = __i18n.deleteSession;
      (function(sessionId, sessionTitle) {
        deleteBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSession', sessionId: sessionId, sessionTitle: sessionTitle });
        });
      })(s.id, s.title || s.id.slice(0, 8));
      el.appendChild(deleteBtn);

      (function(sessionId) {
        el.addEventListener('click', function() {
          vscode.postMessage({ type: 'loadSession', sessionId: sessionId });
        });
      })(s.id);

      container.appendChild(el);
    }
  }

  // ── Render Threads ──
  // Threads are grouped like the upstream web client's rail: "Needs you"
  // (pending_attention_count > 0, excluding the active view which shows its
  // cards inline), "Running" (turn in progress), then "Recent". The server's
  // typed pending count is the only attention authority — status prose never
  // participates in the grouping decision.
  function threadIsRunning(t) {
    var s = String(t.latest_turn_status || '');
    return s === 'in_progress' || s === 'inprogress' || s === 'queued';
  }

  function renderThreadItem(t) {
    var el = document.createElement('div');
    el.className = 'thread-item' + (t.id === activeThreadId ? ' active' : '');
    el.setAttribute('data-thread-id', t.id);

    var headRow = document.createElement('div');
    headRow.className = 'thread-head-row';

    var titleEl = document.createElement('div');
    titleEl.className = 'thread-title';
    titleEl.textContent = t.title || t.id.slice(0, 8);
    headRow.appendChild(titleEl);

    // Attention badge: a background thread is waiting for an approval or
    // user input. The active thread already shows its own approval card
    // inline, so skip it there.
    var attention = t.pending_attention_count;
    if (attention && attention > 0 && t.id !== activeThreadId) {
      el.classList.add('has-attention');
      el.title = __i18n.threadAttention;
      var badge = document.createElement('button');
      badge.className = 'thread-attention-count';
      badge.type = 'button';
      badge.title = __i18n.threadAttention;
      badge.textContent = String(attention);
      (function(threadId) {
        badge.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'showThreadAttention', threadId: threadId });
        });
      })(t.id);
      headRow.appendChild(badge);
    }

    el.appendChild(headRow);

    if (t.preview) {
      var previewEl = document.createElement('div');
      previewEl.className = 'thread-preview';
      previewEl.textContent = t.preview;
      el.appendChild(previewEl);
    }

    var metaEl = document.createElement('div');
    metaEl.className = 'thread-meta';

    if (t.latest_turn_status) {
      var statusEl = document.createElement('span');
      statusEl.className = 'turn-status ' + t.latest_turn_status;
      statusEl.textContent = t.latest_turn_status;
      metaEl.appendChild(statusEl);
    }

    var modeEl = document.createElement('span');
    modeEl.textContent = t.mode || '';
    metaEl.appendChild(modeEl);

    if (t.updated_at) {
      var timeEl = document.createElement('span');
      timeEl.textContent = __wvFormatRelativeTime(t.updated_at);
      metaEl.appendChild(timeEl);
    }

    el.appendChild(metaEl);

    (function(threadId) {
      el.addEventListener('click', function() {
        vscode.postMessage({ type: 'loadThread', threadId: threadId });
      });
    })(t.id);

    return el;
  }

  function renderThreadGroupHeader(label) {
    var header = document.createElement('div');
    header.className = 'thread-group-header';
    header.textContent = label;
    return header;
  }

  // ── Thread rail fetch status ──
  // The summary fetch behind this rail costs roughly a quarter-second per
  // thread on the runtime, so an empty rail is normally "still loading", not
  // "you have no threads". Say which one it is, and when the fetch failed say
  // that too instead of leaving the rail blank.
  function renderThreadListStatus(kind) {
    var container = document.getElementById('tab-threads-list');
    if (!container) return;
    var stale = container.querySelectorAll('.thread-list-status');
    for (var s = 0; s < stale.length; s++) {
      stale[s].remove();
    }
    // Any other value is a clear: the caller has real content to show instead.
    if (kind !== 'loading' && kind !== 'failed') return;
    // A populated rail already answers the question, so a refresh behind it is
    // invisible on purpose — a spinner under the list on every panel open would
    // be noise. The empty rail is the case that misleads.
    if (kind === 'loading' && container.querySelectorAll('.thread-item').length > 0) {
      return;
    }
    // While a fetch is in flight, "no conversations yet" is a guess, not a fact.
    if (kind === 'loading') {
      var guesses = container.querySelectorAll('.work-empty');
      for (var g = 0; g < guesses.length; g++) {
        guesses[g].remove();
      }
    }

    var el = document.createElement('div');
    el.className = 'thread-list-status ' + kind;

    if (kind === 'failed') {
      var failedText = document.createElement('span');
      failedText.className = 'thread-list-status-text';
      failedText.textContent = __i18n.threadsLoadFailed;
      el.appendChild(failedText);

      var retry = document.createElement('button');
      retry.className = 'thread-list-retry';
      retry.type = 'button';
      retry.textContent = __i18n.threadsRetry;
      retry.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'retryThreadList' });
      });
      el.appendChild(retry);
    } else {
      var spinner = document.createElement('span');
      spinner.className = 'thread-list-spinner';
      el.appendChild(spinner);

      var loadingText = document.createElement('span');
      loadingText.className = 'thread-list-status-text';
      loadingText.textContent = __i18n.threadsLoading;
      el.appendChild(loadingText);
    }

    container.appendChild(el);
  }

  // ── Toolbar Agent chip ──
  // The chip is the only chrome that says "another thread is waiting on you".
  // Its label, its tooltip and its click target are all derived from this one
  // list, so what it promises and where it lands cannot disagree. The number
  // is the pending-item total (approvals + user inputs), not a thread count:
  // one thread can be waiting on two things.
  var ATTENTION_TITLE_MAX = 24;

  function threadAttentionCount(t) {
    var n = Number(t && t.pending_attention_count);
    return isFinite(n) && n > 0 ? n : 0;
  }

  // Threads waiting on the user, longest wait first. The active thread is
  // excluded: its cards render inline, so it is not "elsewhere".
  function agentAttentionThreads() {
    var waiting = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      if (!t || !t.id || t.id === activeThreadId) continue;
      if (threadAttentionCount(t) > 0) {
        waiting.push({ t: t, index: i, at: Date.parse(t.updated_at || '') });
      }
    }
    // Oldest first: updated_at is when the thread last moved, so the oldest
    // one has been sitting unanswered the longest. A thread with no usable
    // timestamp cannot be ordered; it queues behind the dated ones in list
    // order rather than jumping the line.
    waiting.sort(function(a, b) {
      var aDated = !isNaN(a.at), bDated = !isNaN(b.at);
      if (aDated && bDated && a.at !== b.at) return a.at - b.at;
      if (aDated !== bDated) return aDated ? -1 : 1;
      return a.index - b.index;
    });
    var out = [];
    for (var w = 0; w < waiting.length; w++) out.push(waiting[w].t);
    return out;
  }

  function attentionTitle(t) {
    var title = String((t && t.title) || '').trim();
    if (!title) title = String((t && t.id) || '').slice(0, 8);
    if (title.length > ATTENTION_TITLE_MAX) title = title.slice(0, ATTENTION_TITLE_MAX - 1) + '\u2026';
    return title;
  }

  function setAgentChipHint(text) {
    if (!agentPanelToggleEl) return;
    agentPanelToggleEl.setAttribute('data-tooltip', text);
    agentPanelToggleEl.setAttribute('title', text);
    agentPanelToggleEl.setAttribute('aria-label', text);
  }

  // The chip says what it counts and names where a click lands. "Agent · 1"
  // read as an agent count; the number is a work queue on other threads, and
  // an unexplained yellow is worse than no badge at all.
  function refreshAgentAttentionBadge() {
    if (!agentPanelToggleEl) return;
    var waiting = agentAttentionThreads();
    if (waiting.length === 0) {
      agentPanelToggleEl.textContent = __i18n.agentStatus;
      agentPanelToggleEl.classList.remove('has-attention');
      setAgentChipHint(__i18n.agentStatusTitle);
      return;
    }
    var items = 0;
    for (var i = 0; i < waiting.length; i++) items += threadAttentionCount(waiting[i]);
    var oldest = attentionTitle(waiting[0]);
    var template = waiting.length === 1 ? __i18n.agentStatusWaitingOne : __i18n.agentStatusWaitingMany;
    var hint = String(template).replace('{title}', oldest).replace('{count}', String(waiting.length));
    agentPanelToggleEl.textContent = __i18n.agentStatus + ' \u00b7 ' +
      String(__i18n.agentStatusWaiting).replace('{count}', String(items));
    agentPanelToggleEl.classList.add('has-attention');
    setAgentChipHint(hint);
  }

  // Clicking the chip shows the waiting thread's card where attention is
  // answered — expanded in the panel, on the tab that holds it — instead of
  // switching threads out from under a conversation the user is in the middle
  // of. Going to the thread is still one click away, from the card itself.
  function showAgentAttentionInPanel() {
    var waiting = agentAttentionThreads();
    if (waiting.length === 0) return false;
    setThreadsPanelOpen(true);
    switchSidebarTab('threads');
    vscode.postMessage({ type: 'showThreadAttention', threadId: waiting[0].id });
    return true;
  }

  function renderThreads() {
    // The chip counts the same list this function paints, so it is refreshed
    // here: a thread that just became active stops being counted as
    // "elsewhere", and its cards are the ones already on screen.
    refreshAgentAttentionBadge();
    var container = document.getElementById('tab-threads-list');
    if (!container) return;
    var count = threads.length;

    // Preserve the hint header; remove only thread items, the fetch status and
    // the empty placeholder.
    var existing = container.querySelectorAll('.thread-item, .work-empty, .thread-group-header, .thread-list-status');
    for (var r = 0; r < existing.length; r++) {
      existing[r].remove();
    }

    if (count === 0) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      el.innerHTML = '<div class="work-empty-icon">\\uD83D\\uDCCB</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noConversations) + '</div>';
      container.appendChild(el);
      return;
    }

    var needsYou = [], running = [], recent = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      var attention = (t.pending_attention_count || 0) > 0 && t.id !== activeThreadId;
      if (attention) needsYou.push(t);
      else if (threadIsRunning(t)) running.push(t);
      else recent.push(t);
    }

    var groups = [
      { label: __i18n.threadsNeedsYou, items: needsYou },
      { label: __i18n.threadsRunning, items: running },
      { label: __i18n.threadsRecent, items: recent },
    ];
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].items.length === 0) continue;
      container.appendChild(renderThreadGroupHeader(groups[g].label));
      for (var j = 0; j < groups[g].items.length; j++) {
        container.appendChild(renderThreadItem(groups[g].items[j]));
      }
    }
    // Every one of those items is new, so an expanded attention card was
    // thrown away with the row that held it — draw it again from its payload.
    renderThreadAttention(false);
  }

  // ── Inline background-thread attention ──
  // Renders a background thread's pending approvals / user inputs inside its
  // thread card so they can be answered without switching. Buttons reuse the
  // approvalDecision / userInputSelect / userInputCancel messages; approval
  // ids are global one-shot capabilities and user inputs name their thread,
  // so both are answerable cross-thread.

  // The expanded card, kept as the payload rather than as whatever DOM happens
  // to be on screen: the rail is rebuilt out of every thread list, and a rebuild
  // replaces the row that holds the card. Re-rendering it from this puts it back
  // where it was, instead of vanishing under the pointer of someone about to
  // click Allow.
  var expandedAttention = null;

  function forgetThreadAttention() {
    expandedAttention = null;
  }

  function showThreadAttention(msg) {
    expandedAttention = {
      threadId: msg.threadId || '',
      approvals: (msg.approvals || []).slice(),
      inputs: (msg.inputs || []).slice(),
    };
    renderThreadAttention(true);
  }

  /** Put the expanded card back on its thread's row. The allow-fallback flag
   *  belongs to the request that asked for it: a card the rail cannot hold
   *  (another workspace, or past the summary limit) leaves opening the thread as
   *  the only way left to reach its approvals. A repaint after a rebuild never
   *  falls back — a row that is not there is not somewhere to send the user. */
  function renderThreadAttention(allowFallback) {
    if (!expandedAttention) return;
    var container = document.getElementById('tab-threads-list');
    if (!container) return;
    var threadId = expandedAttention.threadId;
    if (threadId === activeThreadId) {
      // The thread is on screen now, and its requests are answered in the
      // conversation: one request, one place to answer it.
      forgetThreadAttention();
      return;
    }
    var item = container.querySelector('.thread-item[data-thread-id="' + threadId + '"]');
    if (!item) {
      if (allowFallback && threadId) {
        vscode.postMessage({ type: 'loadThread', threadId: threadId });
      }
      return;
    }

    // Exactly one card is expanded, and this payload is it: anything a
    // previous payload left on another row is stale, and would be the one to
    // vanish on the next rebuild rather than this one.
    var openCards = container.querySelectorAll('.thread-attention');
    for (var c = 0; c < openCards.length; c++) openCards[c].remove();

    var approvals = expandedAttention.approvals;
    var inputs = expandedAttention.inputs;
    if (approvals.length === 0 && inputs.length === 0) {
      forgetThreadAttention();
      return;
    }

    var panel = document.createElement('div');
    panel.className = 'thread-attention';
    // Clicks on the panel must not bubble to the thread item's own click
    // handler (which switches threads).
    panel.addEventListener('click', function(e) { e.stopPropagation(); });

    for (var a = 0; a < approvals.length; a++) {
      var approval = approvals[a];
      var row = document.createElement('div');
      row.className = 'thread-attention-approval';
      row.setAttribute('data-approval-id', approval.id || '');
      row.innerHTML =
        '<div class="thread-attention-text"><strong>' + __wvEscapeHtml(approval.tool_name || 'tool') + '</strong> ' +
        __wvEscapeHtml(approval.description || approval.intent_summary || '') + '</div>';
      // The same remember box the approval float and the task detail panel
      // offer: allowing with it flips this thread to Full Access, so a card the
      // user is not even looking at stops asking once per tool call.
      var rememberLabel = document.createElement('label');
      rememberLabel.className = 'approval-remember';
      var rememberBox = document.createElement('input');
      rememberBox.type = 'checkbox';
      rememberBox.className = 'remember-check';
      rememberBox.setAttribute('data-approval-id', approval.id || '');
      rememberLabel.appendChild(rememberBox);
      rememberLabel.appendChild(document.createTextNode(' ' + __i18n.approvalRemember));

      var btns = document.createElement('div');
      btns.className = 'thread-attention-buttons';
      (function(approvalId, box) {
        var allow = document.createElement('button');
        allow.className = 'thread-attention-btn allow';
        allow.type = 'button';
        allow.textContent = __i18n.allow;
        allow.addEventListener('click', function(e) { e.stopPropagation(); vscode.postMessage({ type: 'approvalDecision', approvalId: approvalId, decision: 'allow', remember: !!box.checked }); });
        var deny = document.createElement('button');
        deny.className = 'thread-attention-btn deny';
        deny.type = 'button';
        deny.textContent = __i18n.deny;
        deny.addEventListener('click', function(e) { e.stopPropagation(); vscode.postMessage({ type: 'approvalDecision', approvalId: approvalId, decision: 'deny', remember: !!box.checked }); });
        btns.appendChild(allow);
        btns.appendChild(deny);
      })(approval.id || '', rememberBox);
      row.appendChild(rememberLabel);
      row.appendChild(btns);
      panel.appendChild(row);
    }

    for (var u = 0; u < inputs.length; u++) {
      var pending = inputs[u];
      var questions = pending.request && Array.isArray(pending.request.questions) ? pending.request.questions : [];
      var inputRow = document.createElement('div');
      inputRow.className = 'thread-attention-input';
      inputRow.setAttribute('data-input-id', pending.id || '');
      for (var q = 0; q < questions.length; q++) {
        var question = questions[q];
        var qEl = document.createElement('div');
        qEl.className = 'thread-attention-question';
        qEl.innerHTML = '<div class="thread-attention-text"><strong>' + __wvEscapeHtml(question.header || '') + '</strong> ' + __wvEscapeHtml(question.question || '') + '</div>';
        var opts = document.createElement('div');
        opts.className = 'thread-attention-buttons';
        for (var o = 0; o < (question.options || []).length; o++) {
          (function(inputId, questionId, optIdx, optLabel) {
            var btn = document.createElement('button');
            btn.className = 'thread-attention-btn';
            btn.type = 'button';
            btn.textContent = optLabel.label;
            btn.title = optLabel.description || '';
            btn.addEventListener('click', function(e) {
              e.stopPropagation();
              vscode.postMessage({ type: 'userInputSelect', inputId: inputId, questionId: questionId, optionIdx: optIdx, optionLabel: optLabel.label });
            });
            opts.appendChild(btn);
          })(pending.id || '', question.id, o, question.options[o]);
        }
        qEl.appendChild(opts);
        inputRow.appendChild(qEl);
      }
      (function(inputId) {
        var cancel = document.createElement('button');
        cancel.className = 'thread-attention-btn cancel';
        cancel.type = 'button';
        cancel.textContent = __i18n.cancel;
        cancel.addEventListener('click', function(e) { e.stopPropagation(); vscode.postMessage({ type: 'userInputCancel', inputId: inputId }); });
        inputRow.appendChild(cancel);
      })(pending.id || '');
      panel.appendChild(inputRow);
    }

    item.appendChild(panel);
  }

  /** Remove one inline attention row, plus any panel it leaves empty. */
  function removeThreadAttentionRow(rowSelector) {
    var container = document.getElementById('tab-threads-list');
    if (!container) return;
    var row = container.querySelector(rowSelector);
    if (row) row.remove();
    var panels = container.querySelectorAll('.thread-attention');
    for (var i = 0; i < panels.length; i++) {
      if (!panels[i].querySelector('.thread-attention-approval, .thread-attention-input')) {
        panels[i].remove();
      }
    }
  }

  function removeThreadAttentionApproval(approvalId) {
    if (!approvalId) return;
    dropThreadAttentionEntry('approvals', approvalId);
    removeThreadAttentionRow('.thread-attention-approval[data-approval-id="' + approvalId + '"]');
  }

  function removeThreadAttentionInput(inputId) {
    if (!inputId) return;
    dropThreadAttentionEntry('inputs', inputId);
    removeThreadAttentionRow('.thread-attention-input[data-input-id="' + inputId + '"]');
  }

  /** Retire an answered row from the expanded payload too. Removing the row
   *  empties the card either way, but the rail is rebuilt on the next thread
   *  list, and a payload still holding a request that has been answered would
   *  put its buttons back on the card. */
  function dropThreadAttentionEntry(list, id) {
    if (!expandedAttention) return;
    expandedAttention[list] = expandedAttention[list].filter(function(entry) {
      return String((entry && entry.id) || '') !== String(id);
    });
    if (expandedAttention.approvals.length === 0 && expandedAttention.inputs.length === 0) {
      forgetThreadAttention();
    }
  }

  // ── Switch Sidebar Tab ──
  // Sessions / Threads / Activity are peers and always visible; there is no
  // setting that hides one of them.
  function switchSidebarTab(tab) {
    sidebarTab = tab;
    var section = document.getElementById('sidebar-threads');
    var tabs = ['sessions', 'threads', 'activity'];
    for (var i = 0; i < tabs.length; i++) {
      var btn = document.getElementById('tab-' + tabs[i] + '-btn');
      if (btn) btn.classList.toggle('active', tabs[i] === tab);
    }
    if (section) section.setAttribute('data-active-tab', tab);
  }

  function closeTaskCreateDialog() {
    var overlay = document.getElementById('task-create-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.onclick = null;
    }
  }

  function submitTaskDraftAndClose() {
    var trimmed = String(taskDraftPrompt || '').trim();
    if (!trimmed) return;
    vscode.postMessage({ type: 'createTask', prompt: trimmed });
    taskDraftPrompt = '';
    closeTaskCreateDialog();
  }

  function openTaskCreateDialog() {
    var overlay = document.getElementById('task-create-overlay');
    if (!overlay) return;
    var html = '<div class="task-create-panel">';
    html += '<div class="task-create-header">';
    html += '<h3>' + __wvEscapeHtml(__i18n.taskCreateTitle || __i18n.taskCreate || 'Create Task') + '</h3>';
    html += '<button class="close-btn task-create-close" type="button">\\u2715</button>';
    html += '</div>';
    html += '<div class="task-create-body">';
    html += '<textarea class="task-create-textarea" id="task-create-textarea" placeholder="' + __wvEscapeHtml(__i18n.taskCreatePlaceholder || 'Describe the background task...') + '">' + __wvEscapeHtml(taskDraftPrompt) + '</textarea>';
    html += '</div>';
    html += '<div class="task-create-footer">';
    html += '<button class="detail-action-btn task-create-cancel" type="button">' + __wvEscapeHtml(__i18n.cancel || 'Cancel') + '</button>';
    html += '<button class="detail-action-btn task-create-submit" type="button">' + __wvEscapeHtml(__i18n.taskCreateSubmit || 'Create') + '</button>';
    html += '</div></div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
    overlay.onclick = function(e) {
      var target = e.target;
      if (target === overlay || (target.closest && (target.closest('.task-create-close') || target.closest('.task-create-cancel')))) {
        closeTaskCreateDialog();
        return;
      }
      if (target.closest && target.closest('.task-create-submit')) {
        var submitInput = document.getElementById('task-create-textarea');
        if (submitInput && typeof submitInput.value === 'string') {
          taskDraftPrompt = submitInput.value;
        }
        submitTaskDraftAndClose();
      }
    };
    var input = document.getElementById('task-create-textarea');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener('input', function() {
        taskDraftPrompt = input.value;
      });
      input.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          submitTaskDraftAndClose();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeTaskCreateDialog();
        }
      });
    }
  }

  // ── Render Tasks ──
  function renderTasks(tasks) {
    var container = document.getElementById('tab-tasks');
    if (!container) return;
    container.innerHTML = '';
    var controls = document.createElement('div');
    controls.className = 'task-toolbar';
    var createBtn = document.createElement('button');
    createBtn.className = 'task-icon-btn primary';
    createBtn.type = 'button';
    createBtn.title = __i18n.taskCreate || 'New Task';
    createBtn.setAttribute('aria-label', __i18n.taskCreate || 'New Task');
    createBtn.textContent = '+';
    createBtn.onclick = function() {
      openTaskCreateDialog();
    };
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'task-icon-btn';
    refreshBtn.type = 'button';
    refreshBtn.title = __i18n.taskRefresh || 'Refresh';
    refreshBtn.setAttribute('aria-label', __i18n.taskRefresh || 'Refresh');
    refreshBtn.textContent = '\\u21BB';
    refreshBtn.onclick = function() {
      vscode.postMessage({ type: 'refreshTaskList' });
    };
    controls.appendChild(createBtn);
    controls.appendChild(refreshBtn);
    container.appendChild(controls);
    if (!tasks || tasks.length === 0) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      el.innerHTML = '<div class="work-empty-icon">\\u2699</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noTasks) + '</div>';
      container.appendChild(el);
      return;
    }
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var card = document.createElement('div');
      card.className = 'task-card';
      var statusIcon = taskStatusIcon(t.status);
      var statusClass = taskStatusClass(t.status);
      var title = (t.prompt_summary || t.id).slice(0, 30);
      var pendingApprovalCount = Array.isArray(t.pending_approvals) ? t.pending_approvals.length : 0;
      var pendingInputCount = Array.isArray(t.pending_user_inputs) ? t.pending_user_inputs.length : 0;
      var attentionCount = pendingApprovalCount + pendingInputCount;
      var attentionTitle = __i18n.taskNeedsAttention || 'Needs attention';
      if (pendingApprovalCount > 0 || pendingInputCount > 0) {
        var parts = [];
        if (pendingApprovalCount > 0) parts.push(pendingApprovalCount + ' ' + (__i18n.taskPendingApprovals || 'Pending Approvals'));
        if (pendingInputCount > 0) parts.push(pendingInputCount + ' ' + (__i18n.taskPendingInputs || 'Pending Inputs'));
        attentionTitle += ': ' + parts.join(' · ');
      }
      var attentionBadge = attentionCount > 0
        ? '<span class="task-attention-badge" title="' + __wvEscapeHtml(attentionTitle) + '">' + attentionCount + '</span>'
        : '';
      var attentionMeta = attentionCount > 0
        ? ' <span class="task-attention-meta" title="' + __wvEscapeHtml(attentionTitle) + '">\\u26A0 ' + __wvEscapeHtml(__i18n.taskAttention || 'Attention') + '</span>'
        : '';
      card.innerHTML =
        '<div class="task-header">' +
          '<span class="task-status-icon ' + statusClass + '">' + statusIcon + '</span>' +
          '<span class="task-title">' + __wvEscapeHtml(title) + '</span>' +
          attentionBadge +
        '</div>' +
        '<div class="task-meta">' + __wvEscapeHtml(t.status) + ' \\u00B7 ' + __wvEscapeHtml(t.model || '') + attentionMeta + '</div>';
      (function(taskId, taskStatus, hasResult) {
        card.addEventListener('click', function(e) {
          if (e.target.tagName === 'BUTTON') return;
          vscode.postMessage({ type: 'showTaskDetail', taskId: taskId });
        });
        var actions = document.createElement('div');
        actions.className = 'task-actions';
        var detailsBtn = document.createElement('button');
        detailsBtn.type = 'button';
        detailsBtn.className = 'task-action-btn';
        detailsBtn.title = __i18n.taskDetails || 'Details';
        detailsBtn.setAttribute('aria-label', __i18n.taskDetails || 'Details');
        detailsBtn.textContent = '\\u2139';
        detailsBtn.onclick = function() {
          vscode.postMessage({ type: 'showTaskDetail', taskId: taskId });
        };
        actions.appendChild(detailsBtn);
        if (hasResult) {
          var resultBtn = document.createElement('button');
          resultBtn.type = 'button';
          resultBtn.className = 'task-action-btn';
          resultBtn.title = __i18n.agentResult || 'Result';
          resultBtn.setAttribute('aria-label', __i18n.agentResult || 'Result');
          resultBtn.textContent = '\\u25A4';
          resultBtn.onclick = function() {
            vscode.postMessage({ type: 'showTaskDetail', taskId: taskId });
          };
          actions.appendChild(resultBtn);
        }
        if (taskIsCancelable(taskStatus)) {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'task-action-btn danger';
          cancelBtn.title = __i18n.cancel;
          cancelBtn.setAttribute('aria-label', __i18n.cancel);
          cancelBtn.textContent = '\\u25A0';
          cancelBtn.onclick = function() {
            vscode.postMessage({ type: 'cancelTask', taskId: taskId });
          };
          actions.appendChild(cancelBtn);
        }
        card.appendChild(actions);
      })(t.id, t.status, !!(t.result_detail_path || t.result_summary));
      container.appendChild(card);
    }
  }

  // ── Render Agent Runs ──
  function renderAgents(runs) {
    var container = document.getElementById('tab-agents');
    if (!container) return;
    container.innerHTML = '';
    if (!runs || runs.length === 0) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      el.innerHTML = '<div class="work-empty-icon">\\uD83E\\uDD16</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noAgentRuns) + '</div>';
      container.appendChild(el);
      return;
    }
    // Sort: running first, then by updated_at desc
    var sorted = runs.slice().sort(function(a, b) {
      var aActive = agentIsLive(a.status) ? 0 : 1;
      var bActive = agentIsLive(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (b.updated_at_ms || 0) - (a.updated_at_ms || 0);
    });
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      var spec = r.spec || {};
      var card = document.createElement('div');
      card.className = 'agent-card' + (agentIsRunning(r.status) ? ' agent-active' : '');
      var icon = agentStatusIcon(r.status);
      var statusClass = agentStatusClass(r.status);
      var statusLabel = agentStatusLabel(r.status);
      var objective = (spec.objective || r.spec.run_id || '').slice(0, 60);
      var role = spec.role || '';
      var model = spec.model || '';
      var steps = r.steps_taken || 0;
      var html =
        '<div class="agent-header">' +
          '<span class="agent-status-icon ' + statusClass + '">' + icon + '</span>' +
          '<span class="agent-objective">' + __wvEscapeHtml(objective) + '</span>' +
        '</div>' +
        '<div class="agent-meta">' +
          '<span class="agent-status-badge ' + statusClass + '">' + __wvEscapeHtml(statusLabel) + '</span>';
      if (role) {
        html += ' <span class="agent-role-badge">' + __wvEscapeHtml(role) + '</span>';
      }
      html += ' <span class="agent-model-badge">' + __wvEscapeHtml(model) + '</span>';
      html += '</div>';
      // Steps & tokens
      var tokenUsage = formatAgentTokenUsage(r.usage);
      html += '<div class="agent-detail">';
      html += __i18n.agentSteps + ': ' + steps;
      if (tokenUsage) {
        html += ' \\u00B7 ' + __i18n.agentUsage + ': ' + __wvEscapeHtml(tokenUsage);
      }
      html += '</div>';
      // Run time — the clock moment this agent started running and how long
      // it has been at it.
      var runTime = formatAgentRunTime(r);
      if (runTime) {
        html += '<div class="agent-detail agent-runtime">' + __wvEscapeHtml(runTime) + '</div>';
      }
      // Result or error
      if (r.status === 'completed' && r.result_summary) {
        html += '<div class="agent-result">' + __wvEscapeHtml(r.result_summary.slice(0, 120)) + '</div>';
      }
      if ((r.status === 'failed' || r.status === 'interrupted') && r.error) {
        html += '<div class="agent-error-text">' + __wvEscapeHtml(r.error.slice(0, 120)) + '</div>';
      }
      // Artifacts
      if (r.artifacts && r.artifacts.length > 0) {
        html += '<div class="agent-artifacts">';
        for (var ai = 0; ai < r.artifacts.length && ai < 3; ai++) {
          var art = r.artifacts[ai];
          var artPath = (art.path || '').split('/').pop() || art.path || '';
          html += '<span class="agent-artifact-chip">' + __wvEscapeHtml(artPath) + '</span>';
        }
        if (r.artifacts.length > 3) {
          html += '<span class="agent-artifact-more">+' + (r.artifacts.length - 3) + '</span>';
        }
        html += '</div>';
      }
      card.innerHTML = html;
      (function(runData) {
        card.addEventListener('click', function(e) {
          if (e.target.tagName === 'BUTTON') return;
          var runId = runData.spec && (runData.spec.run_id || runData.spec.worker_id);
          vscode.postMessage({ type: 'showAgentSessions', runId: runId || '' });
        });
      })(r);
      container.appendChild(card);
    }
  }

  // ── Render Work ──
  // The panel's first slot (#work-goal) is the goal control plane, owned by the
  // goal module; this renders the body below it. The goal is deliberately not
  // repeated here.
  function renderWork() {
    var container = document.getElementById('work-body');
    if (!container) return;
    container.innerHTML = '';
    var hasContent = workState.checklist.length > 0 || workState.strategy.length > 0;
    if (!hasContent) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      el.innerHTML = '<div class="work-empty-icon">&#9668;&#65039;</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noActiveWork) + '</div>';
      container.appendChild(el);
      return;
    }
    // ── Checklist ──
    if (workState.checklist.length > 0) {
      var section = document.createElement('div');
      section.className = 'work-section';
      var html = '<div class="work-section-title"><span class="work-section-title-icon">\\u2611</span>' + __wvEscapeHtml(__i18n.checklist);
      if (workState.checklistCompletionPct > 0) {
        var pct = Number(workState.checklistCompletionPct);
        var pctStr = __i18n.completionPct.replace('{n}', String(pct));
        html += ' <span class="work-section-subtitle">' + __wvEscapeHtml(pctStr) + '</span>';
      }
      html += '</div>';
      // Progress bar
      if (workState.checklistCompletionPct > 0) {
        var pct = Number(workState.checklistCompletionPct);
        var fillClass = pct >= 100 ? 'completed' : pct >= 40 ? 'in-progress' : 'partial';
        html += '<div class="work-progress-bar-bg"><div class="work-progress-bar-fill ' + fillClass + '" data-progress-pct="' + pct + '"></div></div>';
      }
      for (var ci = 0; ci < workState.checklist.length; ci++) {
        var item = workState.checklist[ci];
        var icon = item.status === 'completed' ? '\\u2713' : item.status === 'in_progress' ? '\\u27F3' : '\\u25CB';
        var itemClass = 'work-checklist-item' + (item.status === 'completed' ? ' completed' : '') + (item.status === 'in_progress' ? ' in-progress' : '');
        html += '<div class="' + itemClass + '"><span class="work-checklist-icon">' + icon + '</span><span class="work-checklist-text">' + __wvEscapeHtml(item.content) + '</span></div>';
      }
      section.innerHTML = html;
      section.querySelectorAll('.work-progress-bar-fill[data-progress-pct]').forEach(function(fillEl) {
        var pctAttr = fillEl.getAttribute('data-progress-pct');
        if (pctAttr) fillEl.style.width = pctAttr + '%';
      });
      container.appendChild(section);
    }
    // ── Strategy Steps ──
    if (workState.strategy.length > 0) {
      var section = document.createElement('div');
      section.className = 'work-section';
      var html = '<div class="work-section-title"><span class="work-section-title-icon">\\uD83D\\uDCD0</span>' + __wvEscapeHtml(__i18n.strategy) + '</div>';
      for (var si = 0; si < workState.strategy.length; si++) {
        var step = workState.strategy[si];
        var icon = step.status === 'completed' ? '\\u2713' : step.status === 'in_progress' ? '\\u27F3' : '\\u25CB';
        var stepClass = 'work-strategy-step' + (step.status === 'completed' ? ' completed' : '') + (step.status === 'in_progress' ? ' in-progress' : '');
        html += '<div class="' + stepClass + '"><span class="work-strategy-icon">' + icon + '</span><span class="work-strategy-text">' + __wvEscapeHtml(step.text) + '</span></div>';
      }
      section.innerHTML = html;
      container.appendChild(section);
    }
  }

  // ── Render Changes ──
  /** One path, one spelling: mirror the extension's own path normalisation, so
   *  the file count cannot double-count a path written with backslashes. */
  function normalizeChangePath(filePath) {
    return String(filePath === undefined || filePath === null ? '' : filePath).replace(/\\\\/g, '/').replace(/\\/+$/, '');
  }

  /** How many distinct files the change list touches.
   *
   *  The panel lists one row per recorded change, so a file edited three times
   *  is three rows; the header also reports the file count, which is the number
   *  a reader asking "what did this turn touch" actually wants. */
  function countChangedFiles(changes) {
    // A prototype-less map, not a plain object: a file can be called
    // "constructor" or "toString", and those read as already-seen on a bare
    // object literal. (This block is a template literal: no backticks here.)
    var seen = Object.create(null);
    var count = 0;
    for (var i = 0; i < changes.length; i++) {
      var path = normalizeChangePath(changes[i].filePath);
      if (!path || seen[path]) continue;
      seen[path] = true;
      count++;
    }
    return count;
  }

  function renderChanges() {
    var container = document.getElementById('tab-changes');
    if (!container) return;
    container.innerHTML = '';
    // NOTE: Do NOT clear _diffStore or reset _diffIdCounter here.
    // Message cards in the stream share this store; clearing it invalidates
    // their diff keys (especially during real-time inference where
    // fileChangeDetected is sent before refreshWorkPanel).
    // The store is cleared on loadHistory/clearChat instead.
    if (!changesState || changesState.length === 0) {
      var el = document.createElement('div');
      el.className = 'work-empty';
      el.innerHTML = '<div class="work-empty-icon">\\uD83D\\uDCC4</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noFileChanges) + '</div>';
      container.appendChild(el);
      return;
    }
    // Summary header. Entries are changes, not files: a file edited three
    // times is three rows, each with its own diff and its own revert target.
    var header = document.createElement('div');
    header.className = 'work-section';
    var createdCount = 0, modifiedCount = 0, deletedCount = 0;
    var totalAdded = 0, totalRemoved = 0;
    for (var si = 0; si < changesState.length; si++) {
      if (changesState[si].changeType === 'created') createdCount++;
      else if (changesState[si].changeType === 'deleted') deletedCount++;
      else modifiedCount++;
      totalAdded += changesState[si].addedLines || 0;
      totalRemoved += changesState[si].removedLines || 0;
    }
    var fileCount = countChangedFiles(changesState);
    var summaryParts = [];
    if (createdCount > 0) summaryParts.push('<span class="change-summary-item change-summary-created">' + createdCount + ' ' + __wvEscapeHtml(__i18n.fileCreated) + '</span>');
    if (modifiedCount > 0) summaryParts.push('<span class="change-summary-item change-summary-modified">' + modifiedCount + ' ' + __wvEscapeHtml(__i18n.fileModified) + '</span>');
    if (deletedCount > 0) summaryParts.push('<span class="change-summary-item change-summary-deleted">' + deletedCount + ' ' + __wvEscapeHtml(__i18n.fileDeleted) + '</span>');
    if (totalAdded > 0 || totalRemoved > 0) {
      summaryParts.push('<span class="change-summary-item change-summary-lines"><span class="change-added">+' + totalAdded + '</span> <span class="change-removed">-' + totalRemoved + '</span></span>');
    }
    // The two readings side by side: how many change records are listed, and
    // how many distinct files those records touch.
    var countLabel = __i18n.changesCount.replace('{n}', String(changesState.length)) +
      ' \\u00B7 ' + __i18n.filesCount.replace('{n}', String(fileCount));
    header.innerHTML = '<div class="work-section-title"><span class="work-section-title-icon">\\uD83D\\uDCC1</span>' + __wvEscapeHtml(__i18n.fileChanges) + ' <span class="work-section-subtitle">(' + __wvEscapeHtml(countLabel) + ')</span></div><div class="change-summary-row">' + summaryParts.join(' ') + '</div>';
    container.appendChild(header);

    // Change list
    var list = document.createElement('div');
    list.className = 'work-section change-list';
    var html = '';
    for (var fi = 0; fi < changesState.length; fi++) {
      var fc = changesState[fi];
      var changeIcon = fc.changeType === 'created' ? 'A' : fc.changeType === 'deleted' ? 'D' : 'M';
      var changeTypeLabel = fc.changeType === 'created' ? __i18n.fileCreated : fc.changeType === 'deleted' ? __i18n.fileDeleted : __i18n.fileModified;
      var shortP = fc.filePath.replace(/\\\\/g, '/').split('/').slice(-3).join('/');
      var displayPath = fc.filePath.replace(/\\\\/g, '/').split('/').length > 3 ? '\\u2026/' + shortP : fc.filePath;
      var diffKey = fc.filePath + '@' + (++_diffIdCounter.value);
      if (fc.diff) _diffStore.set(diffKey, fc.diff);
      html += '<div class="change-item change-type-' + fc.changeType + '">';
      html += '<span class="change-badge change-badge-' + fc.changeType + '" title="' + __wvEscapeHtml(changeTypeLabel) + '">' + changeIcon + '</span>';
      html += '<span class="change-path" title="' + __wvEscapeHtml(fc.filePath) + '">' + __wvEscapeHtml(displayPath) + '</span>';
      if (fc.addedLines > 0 || fc.removedLines > 0) {
        html += '<span class="change-stats">';
        if (fc.addedLines > 0) html += '<span class="change-added">+' + fc.addedLines + '</span>';
        if (fc.removedLines > 0) html += '<span class="change-removed">-' + fc.removedLines + '</span>';
        html += '</span>';
      }
      html += '<span class="change-actions">';
      if (fc.diff) {
        html += '<button class="change-btn change-view-diff" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" data-diff-key="' + diffKey + '" data-change-index="' + (fc.changeIndex !== undefined ? fc.changeIndex : '') + '" title="' + __wvEscapeHtml(__i18n.viewDiffTooltip) + '">Diff</button>';
      }
      if (fc.changeType !== 'deleted') {
        html += '<button class="change-btn change-open-file" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" title="' + __wvEscapeHtml(__i18n.openFileTooltip) + '">Open</button>';
      }
      // Locate, not open: this change also has a card in the stream, inside the
      // tool call that made it, and that card is the context this row only
      // summarizes. The row carries the same identity the card does (see
      // revealFileChangeCard), so one file changing several times cannot send
      // the reader to the wrong change.
      html += '<button class="change-btn change-goto-card" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" data-change-index="' + (fc.changeIndex !== undefined && fc.changeIndex !== null ? fc.changeIndex : '') + '" data-call-id="' + __wvEscapeHtml(fc.callId || '') + '" title="' + __wvEscapeHtml(__i18n.locateChangeTooltip) + '">' + __wvEscapeHtml(__i18n.locateChange) + '</button>';
      html += '</span>';
      html += '</div>';
    }
    list.innerHTML = html;
    container.appendChild(list);

    // Click delegation for the diff / open / locate actions
    list.addEventListener('click', function(e) {
      var target = e.target;
      if (target.classList.contains('change-view-diff')) {
        var filePath = target.getAttribute('data-file-path');
        var diffKey = target.getAttribute('data-diff-key');
        var changeIdx = target.getAttribute('data-change-index');
        vscode.postMessage({ type: 'openDiff', filePath: filePath, diff: (diffKey ? _diffStore.get(diffKey) : undefined) || undefined, changeIndex: changeIdx !== null && changeIdx !== '' ? parseInt(changeIdx) : undefined });
      } else if (target.classList.contains('change-open-file')) {
        var filePath = target.getAttribute('data-file-path');
        vscode.postMessage({ type: 'openFile', filePath: filePath });
      } else if (target.classList.contains('change-goto-card')) {
        // The card lives in this same document, so this is a scroll rather than
        // a round trip through the extension. The messages module owns the
        // lookup and loads after this one, hence the guard.
        var gotoIndex = target.getAttribute('data-change-index');
        if (window.__wvMessages && window.__wvMessages.revealFileChangeCard) {
          window.__wvMessages.revealFileChangeCard({
            filePath: target.getAttribute('data-file-path'),
            callId: target.getAttribute('data-call-id') || undefined,
            changeIndex: gotoIndex !== null && gotoIndex !== '' ? parseInt(gotoIndex, 10) : undefined
          });
        }
      }
    });
  }

  // ── Task Detail ──
  function closeTaskDetail() {
    var overlay = document.getElementById('task-detail-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.onclick = null;
    }
    vscode.postMessage({ type: 'closeTaskDetail' });
  }

  function showTaskDetail(task) {
    var overlay = document.getElementById('task-detail-overlay');
    if (!overlay) return;
    var statusIcon = taskStatusIcon(task.status);
    var statusClass = taskStatusClass(task.status);
    var duration = task.duration_ms ? (task.duration_ms / 1000).toFixed(1) + 's' : '-';
    var prompt = task.prompt || task.prompt_summary || '';
    var resultText = task.result_summary || '';
    var fullResultText = task.result_detail_content || '';
    var checklistItems = task.checklist && Array.isArray(task.checklist.items) ? task.checklist.items : [];
    var gates = Array.isArray(task.gates) ? task.gates : [];
    var attempts = Array.isArray(task.attempts) ? task.attempts : [];
    var artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    var githubEvents = Array.isArray(task.github_events) ? task.github_events : [];
    var pendingApprovals = Array.isArray(task.pending_approvals) ? task.pending_approvals : [];
    var pendingInputs = Array.isArray(task.pending_user_inputs) ? task.pending_user_inputs : [];
    var html = '<div class="task-detail-panel">';
    html += '<button class="close-btn" type="button">\\u2715</button>';
    html += '<h3>' + statusIcon + ' Task ' + __wvEscapeHtml((task.id || '').slice(0, 8)) + '</h3>';
    html += '<div class="detail-actions">';
    html += '<button class="detail-action-btn detail-task-refresh" data-task-id="' + __wvEscapeHtml(task.id || '') + '">' + __wvEscapeHtml(__i18n.taskRefresh || 'Refresh') + '</button>';
    if (task.thread_id) {
      html += '<button class="detail-action-btn detail-task-open-thread" data-thread-id="' + __wvEscapeHtml(task.thread_id) + '">' + __wvEscapeHtml(__i18n.taskOpenThread || 'Open Thread') + '</button>';
    }
    if (taskIsCancelable(task.status)) {
      html += '<button class="detail-action-btn detail-task-cancel" data-task-id="' + __wvEscapeHtml(task.id || '') + '">' + __wvEscapeHtml(__i18n.cancel) + '</button>';
    }
    html += '</div>';
    html += '<div class="detail-section"><div class="detail-label">Status</div><div class="detail-value ' + statusClass + '">' + __wvEscapeHtml(task.status) + '</div></div>';
    html += '<div class="detail-section"><div class="detail-label">Model / Mode</div><div class="detail-value">' + __wvEscapeHtml(task.model) + ' \\u00B7 ' + __wvEscapeHtml(task.mode) + '</div></div>';
    if (task.workspace) {
      html += '<div class="detail-section"><div class="detail-label">Workspace</div><div class="detail-value">' + __wvEscapeHtml(task.workspace) + '</div></div>';
    }
    html += '<div class="detail-section"><div class="detail-label">Created / Started / Ended</div><div class="detail-value">' + __wvEscapeHtml(formatDetailTime(task.created_at)) + ' \\u00B7 ' + __wvEscapeHtml(formatDetailTime(task.started_at)) + ' \\u00B7 ' + __wvEscapeHtml(formatDetailTime(task.ended_at)) + '</div></div>';
    html += '<div class="detail-section"><div class="detail-label">Duration</div><div class="detail-value">' + duration + '</div></div>';
    if (task.runtime_event_count) {
      html += '<div class="detail-section"><div class="detail-label">Runtime Events</div><div class="detail-value">' + __wvEscapeHtml(String(task.runtime_event_count)) + '</div></div>';
    }
    if (task.hunt_verdict) {
      html += '<div class="detail-section"><div class="detail-label">Verdict</div><div class="detail-value">' + __wvEscapeHtml(task.hunt_verdict) + '</div></div>';
    }
    if (task.thread_id || task.turn_id) {
      html += '<div class="detail-section"><div class="detail-label">Thread / Turn</div><div class="detail-value">' + __wvEscapeHtml(task.thread_id || '-') + ' \\u00B7 ' + __wvEscapeHtml(task.turn_id || '-') + '</div></div>';
    }
    html += '<div class="detail-section"><div class="detail-label">Prompt</div><div class="detail-value">' + __wvEscapeHtml(prompt) + '</div></div>';
    if (resultText) {
      html += '<div class="detail-section"><div class="detail-label">Result</div><div class="detail-value result">' + __wvEscapeHtml(resultText) + '</div></div>';
    }
    if (task.result_detail_path) {
      html += '<div class="detail-section"><div class="detail-label">Result Artifact</div><div class="detail-value">' + __wvEscapeHtml(task.result_detail_path) + '</div><div class="detail-actions">' + renderOpenFileButton(task.result_detail_path, 'Open Result File') + '</div></div>';
    }
    if (fullResultText) {
      html += '<div class="detail-section"><div class="detail-label">Full Result</div><div class="detail-value"><div class="markdown">' + simpleMarkdown(fullResultText) + '</div></div>';
      if (task.result_detail_truncated) {
        html += '<div class="detail-subtle">Preview truncated in GUI. Use "Open Result File" for the full artifact.</div>';
      }
      html += '</div>';
    }
    if (task.error) {
      html += '<div class="detail-section"><div class="detail-label">Error</div><div class="detail-value error">' + __wvEscapeHtml(task.error) + '</div></div>';
    }
    if (pendingApprovals.length > 0 || pendingInputs.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.taskAttention || 'Attention') + '</div>';
      if (pendingApprovals.length > 0) {
        html += '<div class="detail-subsection"><div class="detail-sublabel">' + __wvEscapeHtml(__i18n.taskPendingApprovals || 'Pending Approvals') + '</div>';
        for (var pa = 0; pa < pendingApprovals.length; pa++) {
          var approval = pendingApprovals[pa];
          var approvalIdAttr = __wvEscapeHtml(approval.id || '');
          html += '<div class="detail-list-item">';
          html += '<div><strong>' + __wvEscapeHtml(approval.tool_name || 'tool') + '</strong></div>';
          html += '<div class="detail-subtle">' + __wvEscapeHtml(approval.description || approval.intent_summary || '') + '</div>';
          // The same remember box the approval float offers. Allowing with it
          // flips the whole thread to Full Access (the runtime's
          // remember_thread_auto_approve), which is what makes a background
          // task workable without answering every tool call by hand.
          html += '<label class="approval-remember"><input type="checkbox" class="remember-check" data-approval-id="' + approvalIdAttr + '" /> ' + __wvEscapeHtml(__i18n.approvalRemember) + '</label>';
          html += '<div class="detail-actions">';
          html += '<button class="detail-action-btn detail-approval-action" data-approval-id="' + approvalIdAttr + '" data-decision="allow">' + __wvEscapeHtml(__i18n.allow) + '</button>';
          html += '<button class="detail-action-btn detail-approval-action" data-approval-id="' + approvalIdAttr + '" data-decision="deny">' + __wvEscapeHtml(__i18n.deny) + '</button>';
          html += '</div></div>';
        }
        html += '</div>';
      }
      if (pendingInputs.length > 0) {
        html += '<div class="detail-subsection"><div class="detail-sublabel">' + __wvEscapeHtml(__i18n.taskPendingInputs || 'Pending Inputs') + '</div>';
        for (var pu = 0; pu < pendingInputs.length; pu++) {
          var pending = pendingInputs[pu];
          var questions = pending.request && Array.isArray(pending.request.questions) ? pending.request.questions : [];
          html += '<div class="detail-list-item">';
          for (var pq = 0; pq < questions.length; pq++) {
            var question = questions[pq];
            html += '<div><strong>' + __wvEscapeHtml(question.header || '') + '</strong></div>';
            html += '<div class="detail-subtle">' + __wvEscapeHtml(question.question || '') + '</div>';
            html += '<div class="detail-option-list">';
            for (var po = 0; po < (question.options || []).length; po++) {
              var option = question.options[po];
              html += '<button class="detail-action-btn detail-user-input-option" data-input-id="' + __wvEscapeHtml(pending.id || '') + '" data-question-id="' + __wvEscapeHtml(question.id || '') + '" data-option-idx="' + po + '" data-option-label="' + __wvEscapeHtml(option.label || '') + '">' + __wvEscapeHtml(option.label || '') + ': ' + __wvEscapeHtml(option.description || '') + '</button>';
            }
            html += '</div>';
          }
          html += '<div class="detail-actions">';
          html += '<button class="detail-action-btn detail-user-input-cancel" data-input-id="' + __wvEscapeHtml(pending.id || '') + '">' + __wvEscapeHtml(__i18n.cancel || 'Cancel') + '</button>';
          if (task.thread_id) {
            html += '<button class="detail-action-btn detail-task-open-thread" data-thread-id="' + __wvEscapeHtml(task.thread_id) + '">' + __wvEscapeHtml(__i18n.taskContinueInThread || 'Continue in thread') + '</button>';
          }
          html += '</div></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (checklistItems.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Checklist</div>';
      if (typeof task.checklist.completion_pct === 'number') {
        html += '<div class="detail-subtle">Completion: ' + __wvEscapeHtml(String(task.checklist.completion_pct)) + '%</div>';
      }
      for (var ci = 0; ci < checklistItems.length; ci++) {
        var item = checklistItems[ci];
        html += '<div class="detail-list-item"><span class="detail-chip">' + __wvEscapeHtml(item.status || 'pending') + '</span> ' + __wvEscapeHtml(item.content || '') + '</div>';
      }
      html += '</div>';
    }
    if (task.tool_calls && task.tool_calls.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Tool Calls (' + task.tool_calls.length + ')</div>';
      for (var tci = 0; tci < task.tool_calls.length; tci++) {
        var tc = task.tool_calls[tci];
        var tcStatus = taskToolStatusIcon(tc.status);
        var tcDur = tc.duration_ms ? ' (' + (tc.duration_ms / 1000).toFixed(1) + 's)' : '';
        html += '<div class="tool-call-item">' + tcStatus + ' ' + __wvEscapeHtml(tc.name) + tcDur;
        if (tc.input_summary) html += '<div class="tool-call-subtle">In: ' + __wvEscapeHtml(tc.input_summary) + '</div>';
        if (tc.output_summary) html += '<div class="tool-call-subtle">Out: ' + __wvEscapeHtml(tc.output_summary) + '</div>';
        if (tc.detail_path || tc.patch_ref) {
          html += '<div class="detail-actions">';
          html += renderOpenFileButton(tc.detail_path, 'Open Detail');
          html += renderOpenFileButton(tc.patch_ref, 'Open Patch');
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (task.timeline && task.timeline.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Timeline</div>';
      for (var ti = 0; ti < task.timeline.length; ti++) {
        var entry = task.timeline[ti];
        var time = entry.timestamp ? formatDetailTime(entry.timestamp) : '';
        html += '<div class="timeline-item">[' + __wvEscapeHtml(time) + '] ' + __wvEscapeHtml(timelineKindLabel(entry.kind)) + ': ' + __wvEscapeHtml(entry.summary || '');
        if (entry.detail_path) {
          html += '<div class="detail-actions">' + renderOpenFileButton(entry.detail_path, 'Open Detail') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (gates.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Verification Gates (' + gates.length + ')</div>';
      for (var gi = 0; gi < gates.length; gi++) {
        var gate = gates[gi];
        html += '<div class="detail-list-item">';
        html += '<div><span class="detail-chip">' + __wvEscapeHtml(gate.status || 'unknown') + '</span> <strong>' + __wvEscapeHtml(gate.gate || 'gate') + '</strong> \\u00B7 ' + __wvEscapeHtml(gate.summary || '') + '</div>';
        html += '<div class="detail-subtle">' + __wvEscapeHtml(gate.command || '') + '</div>';
        html += '<div class="detail-subtle">cwd: ' + __wvEscapeHtml(gate.cwd || '') + '</div>';
        if (gate.log_path) {
          html += '<div class="detail-actions">' + renderOpenFileButton(gate.log_path, 'Open Log') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (attempts.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Attempts (' + attempts.length + ')</div>';
      for (var ai = 0; ai < attempts.length; ai++) {
        var attempt = attempts[ai];
        html += '<div class="detail-list-item">';
        html += '<div><span class="detail-chip">' + __wvEscapeHtml(attempt.selected ? 'selected' : 'candidate') + '</span> Attempt ' + __wvEscapeHtml(String(attempt.attempt_index)) + '/' + __wvEscapeHtml(String(attempt.attempt_count)) + '</div>';
        html += '<div>' + __wvEscapeHtml(attempt.summary || '') + '</div>';
        if (attempt.changed_files && attempt.changed_files.length > 0) {
          html += '<div class="detail-subtle">Files: ' + __wvEscapeHtml(attempt.changed_files.slice(0, 6).join(', '));
          if (attempt.changed_files.length > 6) html += ' …';
          html += '</div>';
        }
        if (attempt.verification && attempt.verification.length > 0) {
          html += '<div class="detail-subtle">Verification: ' + __wvEscapeHtml(attempt.verification.join(' · ')) + '</div>';
        }
        if (attempt.patch_path) {
          html += '<div class="detail-actions">' + renderOpenFileButton(attempt.patch_path, 'Open Patch') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (artifacts.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Artifacts (' + artifacts.length + ')</div>';
      for (var ar = 0; ar < artifacts.length; ar++) {
        var artifact = artifacts[ar];
        html += '<div class="detail-list-item">';
        html += '<div><strong>' + __wvEscapeHtml(artifact.label || 'artifact') + '</strong></div>';
        if (artifact.summary) html += '<div>' + __wvEscapeHtml(artifact.summary) + '</div>';
        html += '<div class="detail-subtle">' + __wvEscapeHtml(artifact.path || '') + '</div>';
        html += '<div class="detail-actions">' + renderOpenFileButton(artifact.path, 'Open Artifact') + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    if (githubEvents.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">GitHub Events (' + githubEvents.length + ')</div>';
      for (var ge = 0; ge < githubEvents.length; ge++) {
        var event = githubEvents[ge];
        html += '<div class="detail-list-item">';
        html += '<div><span class="detail-chip">' + __wvEscapeHtml(event.action || 'event') + '</span> ' + __wvEscapeHtml(event.summary || '') + '</div>';
        html += '<div class="detail-subtle">' + __wvEscapeHtml(event.target || '') + ' #' + __wvEscapeHtml(String(event.number || '')) + ' \\u00B7 ' + __wvEscapeHtml(formatDetailTime(event.recorded_at)) + '</div>';
        if (event.url) {
          html += '<div class="detail-actions">' + renderOpenExternalButton(event.url, 'Open GitHub') + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
    attachDetailOverlayActions(overlay, closeTaskDetail);
  }

  // ── Agent Detail ──
  function closeAgentDetail() {
    var overlay = document.getElementById('agent-detail-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.onclick = null;
    }
  }

  function showAgentDetail(run) {
    var overlay = document.getElementById('agent-detail-overlay');
    if (!overlay) return;
    var spec = run.spec || {};
    var statusIcon = agentStatusIcon(run.status);
    var statusClass = agentStatusClass(run.status);
    var statusLabel = agentStatusLabel(run.status);
    var objective = spec.objective || '';
    var role = spec.role || '';
    var model = spec.model || '';
    var steps = run.steps_taken || 0;
    var tokenUsage = formatAgentTokenUsage(run.usage);
    var runId = spec.run_id || spec.worker_id || '';
    var parentId = run.parent_run_id || '';
    var createdAt = run.created_at_ms ? new Date(run.created_at_ms).toLocaleString() : '-';
    var updatedAt = run.updated_at_ms ? new Date(run.updated_at_ms).toLocaleString() : '-';
    var startedAt = run.started_at_ms ? new Date(run.started_at_ms).toLocaleString() : '-';
    var completedAt = run.completed_at_ms ? new Date(run.completed_at_ms).toLocaleString() : '-';
    var events = Array.isArray(run.events) ? run.events : [];

    var html = '<div class="task-detail-panel">';
    html += '<button class="close-btn" type="button">\\u2715</button>';
    html += '<h3>' + statusIcon + ' ' + __wvEscapeHtml(__i18n.agents) + '</h3>';

    // Status
    html += '<div class="detail-section"><div class="detail-label">Status</div>';
    html += '<div class="detail-value ' + statusClass + '">' + __wvEscapeHtml(statusLabel) + '</div></div>';

    // Run ID
    if (runId) {
      html += '<div class="detail-section"><div class="detail-label">Run ID</div>';
      html += '<div class="detail-value detail-monospace">' + __wvEscapeHtml(runId) + '</div></div>';
    }

    // Objective
    if (objective) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentObjective) + '</div>';
      html += '<div class="detail-value">' + __wvEscapeHtml(objective) + '</div></div>';
    }

    // Role & Model
    if (role || model) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentRole) + ' / ' + __wvEscapeHtml(__i18n.agentModel) + '</div>';
      html += '<div class="detail-value">';
      if (role) html += __wvEscapeHtml(role);
      if (role && model) html += ' \\u00B7 ';
      if (model) html += __wvEscapeHtml(model);
      html += '</div></div>';
    }

    // Steps & tokens
    html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentSteps) + ' / ' + __wvEscapeHtml(__i18n.agentUsage) + '</div>';
    html += '<div class="detail-value">' + steps;
    if (tokenUsage) html += ' \\u00B7 ' + __wvEscapeHtml(tokenUsage);
    html += '</div></div>';

    // Parent run
    if (parentId) {
      html += '<div class="detail-section"><div class="detail-label">Parent Run</div>';
      html += '<div class="detail-value detail-monospace">' + __wvEscapeHtml(parentId) + '</div></div>';
    }

    // Timestamps
    html += '<div class="detail-section"><div class="detail-label">Created</div>';
    html += '<div class="detail-value">' + __wvEscapeHtml(createdAt) + '</div></div>';
    html += '<div class="detail-section"><div class="detail-label">Started</div>';
    html += '<div class="detail-value">' + __wvEscapeHtml(startedAt) + '</div></div>';
    html += '<div class="detail-section"><div class="detail-label">Updated</div>';
    html += '<div class="detail-value">' + __wvEscapeHtml(updatedAt) + '</div></div>';
    html += '<div class="detail-section"><div class="detail-label">Completed</div>';
    html += '<div class="detail-value">' + __wvEscapeHtml(completedAt) + '</div></div>';

    if (run.latest_message) {
      html += '<div class="detail-section"><div class="detail-label">Latest Activity</div>';
      html += '<div class="detail-value">' + __wvEscapeHtml(run.latest_message) + '</div></div>';
    }

    // Result
    if (run.result_summary) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentResult) + '</div>';
      html += '<div class="detail-value result">' + __wvEscapeHtml(run.result_summary) + '</div></div>';
    }

    // Error
    if (run.error) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentError) + '</div>';
      html += '<div class="detail-value error">' + __wvEscapeHtml(run.error) + '</div></div>';
    }

    // Artifacts
    if (run.artifacts && run.artifacts.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">' + __wvEscapeHtml(__i18n.agentArtifacts) + ' (' + run.artifacts.length + ')</div>';
      for (var ai = 0; ai < run.artifacts.length; ai++) {
        var art = run.artifacts[ai];
        var artPath = art.path || '';
        var artKind = art.kind || '';
        html += '<div class="tool-call-item">\\u00B7 ' + __wvEscapeHtml(artPath);
        if (artKind) html += ' <span class="text-muted">(' + __wvEscapeHtml(artKind) + ')</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    if (events.length > 0) {
      html += '<div class="detail-section"><div class="detail-label">Events</div>';
      for (var ei = 0; ei < events.length; ei++) {
        var ev = events[ei];
        html += '<div class="timeline-item">[' + __wvEscapeHtml(formatDetailTime(ev.timestamp_ms)) + '] ' + __wvEscapeHtml(timelineKindLabel(ev.kind)) + ': ' + __wvEscapeHtml(ev.summary || '') + '</div>';
      }
      html += '</div>';
    }

    if (hasOwnData(run.follow_up)) {
      html += '<div class="detail-section"><div class="detail-label">Follow Up</div><div class="detail-value">' + renderJsonBlock(run.follow_up) + '</div></div>';
    }

    if (hasOwnData(run.recommended_action)) {
      html += '<div class="detail-section"><div class="detail-label">Recommended Action</div><div class="detail-value">' + renderJsonBlock(run.recommended_action) + '</div></div>';
    }

    if (hasOwnData(run.verification)) {
      html += '<div class="detail-section"><div class="detail-label">Verification</div><div class="detail-value">' + renderJsonBlock(run.verification) + '</div></div>';
    }

    html += '</div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';
    attachDetailOverlayActions(overlay, closeAgentDetail);
  }

  // ── Sidebar toggle ──
  function setThreadsPanelOpen(open) {
    var threadsPanel = document.getElementById('threads-panel');
    if (!threadsPanel) return;
    var opening = open && !threadsPanel.classList.contains('open');
    threadsPanel.classList.toggle('open', open);
    if (opening) {
      void threadsPanel.offsetHeight;
      vscode.postMessage({ type: 'refreshSidebar' });
    }
  }

  function toggleThreadsPanel() {
    var threadsPanel = document.getElementById('threads-panel');
    setThreadsPanelOpen(!(threadsPanel && threadsPanel.classList.contains('open')));
  }

  // ── Sidebar section collapse toggle ──
  document.querySelectorAll('.sidebar-section-header').forEach(function(header) {
    header.addEventListener('click', function() {
      var section = header.parentElement;
      section.classList.toggle('collapsed');
    });
  });

  // ── Tab switching ──
  document.getElementById('tab-sessions-btn').addEventListener('click', function() {
    switchSidebarTab('sessions');
  });
  document.getElementById('tab-threads-btn').addEventListener('click', function() {
    switchSidebarTab('threads');
  });
  document.getElementById('tab-activity-btn').addEventListener('click', function() {
    switchSidebarTab('activity');
  });

  // ── Close (collapse) button ──
  document.getElementById('sidebar-close-btn').addEventListener('click', function() {
    var panel = document.getElementById('threads-panel');
    if (panel) panel.classList.remove('open');
  });

  // ── Workspace filter toggle ──
  document.getElementById('workspace-filter-toggle').addEventListener('click', function(e) {
    e.stopPropagation();
    vscode.postMessage({ type: 'toggleAllWorkspaces' });
  });

  // ── Threads panel toggle buttons ──
  document.getElementById('btn-threads').addEventListener('click', toggleThreadsPanel);
  if (agentPanelToggleEl) {
    agentPanelToggleEl.addEventListener('click', function() {
      if (showAgentAttentionInPanel()) return;
      toggleThreadsPanel();
    });
    // The chip carries role="button", so it has to answer Enter and Space the
    // way the pointer does — a clickable span that ignores the keyboard is
    // only half an affordance.
    agentPanelToggleEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (showAgentAttentionInPanel()) return;
      toggleThreadsPanel();
    });
  }

  // ── Escape closes the panel ──
  // Same effect as the ✕ button, without hunting for it. Inputs keep their own
  // Escape handling (slash menu, task draft) — skip when one has focus.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    var panel = document.getElementById('threads-panel');
    if (panel && panel.classList.contains('open')) panel.classList.remove('open');
  });

  // ── Expose for event handler module ──
  window.__wvSidebar = {
    renderSessions: renderSessions,
    renderThreads: renderThreads,
    renderThreadListStatus: renderThreadListStatus,
    showThreadAttention: showThreadAttention,
    removeThreadAttentionApproval: removeThreadAttentionApproval,
    removeThreadAttentionInput: removeThreadAttentionInput,
    renderTasks: renderTasks,
    renderAgents: renderAgents,
    renderWork: renderWork,
    renderChanges: renderChanges,
    switchSidebarTab: switchSidebarTab,
    closeTaskDetail: closeTaskDetail,
    showTaskDetail: showTaskDetail,
    closeAgentDetail: closeAgentDetail,
    showAgentDetail: showAgentDetail,
    getSessions: function() { return sessions; },
    setSessions: function(v) { sessions = v; },
    getActiveSessionId: function() { return activeSessionId; },
    setActiveSessionId: function(v) { activeSessionId = v; },
    getThreads: function() { return threads; },
    setThreads: function(v) { threads = v; },
    getActiveThreadId: function() { return activeThreadId; },
    setActiveThreadId: function(v) { activeThreadId = v; },
    getShowAllWorkspaces: function() { return showAllWorkspaces; },
    setShowAllWorkspaces: function(v) { showAllWorkspaces = v; },
    getWorkState: function() { return workState; },
    setWorkState: function(v) { workState = v; },
    getChangesState: function() { return changesState; },
    setChangesState: function(v) { changesState = v; },
    getAgentRuns: function() { return agentRuns; },
    setAgentRuns: function(v) { agentRuns = v; },
    getSessionSearchQuery: function() { return sessionSearchQuery; },
    setSessionSearchQuery: function(v) { sessionSearchQuery = v; },
  };

  closeTaskDetail();
  closeAgentDetail();
  // Paint the chip from whatever is already known before the first thread
  // list lands; the template's base label stays as the no-JS fallback.
  refreshAgentAttentionBadge();
  })();`;
}
