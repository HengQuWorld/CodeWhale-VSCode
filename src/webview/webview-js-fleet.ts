/**
 * Webview JS Fleet module — injected into the webview as an IIFE.
 * Renders the Fleet run list (sidebar) and the run detail overlay
 * (workers / tasks / receipts) with start/stop and worker controls.
 */
import type { WebviewTranslations } from "./webview-html";

export function getFleetScript(tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var __wvFormatRelativeTime = window.__wvFormatRelativeTime;
  var vscode = window.__wvVscode;

  // ── Fleet state ──
  var fleetRuns = [];
  var fleetStatus = null;
  var activeRunId = null;
  var detailOpen = false;
  var fleetEvents = [];
  var MAX_FLEET_EVENTS = 80;
  var fleetProfiles = [];
  var taskSeq = 0;
  // Detail-overlay refresh state: last payload (to skip no-op re-renders)
  // and the run backing the open detail (prefill source for "new from run").
  var lastDetailJson = '';
  var detailRun = null;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function autoWorkflowId() {
    var d = new Date();
    // Seconds + random suffix: creating two runs within the same minute
    // (e.g. "new from this run" twice in a row) must not mint the same
    // workflow id. The backend does not enforce workflow-id uniqueness;
    // distinct ids just keep run identities visually separable.
    return 'run-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
      '-' + Math.random().toString(36).slice(2, 6);
  }
  function nextTaskId() { taskSeq += 1; return 'task-' + taskSeq; }

  function titleCase(status) {
    if (!status) return 'unknown';
    return String(status).replace(/_/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
  }

  // Localized status labels — the TUI ledger emits snake_case statuses
  // (enqueued / leased / failed / online / ...); raw English badges were the
  // top "看不明白" complaint. Unknown values fall back to titleCase.
  var STATUS_LABELS = {
    enqueued: __i18n.fleetStEnqueued,
    leased: __i18n.fleetStLeased,
    completed: __i18n.fleetStCompleted,
    failed: __i18n.fleetStFailed,
    cancelled: __i18n.fleetStCancelled,
    unknown: __i18n.fleetStUnknown,
    online: __i18n.fleetStOnline,
    busy: __i18n.fleetStBusy,
    offline: __i18n.fleetStOffline,
    unhealthy: __i18n.fleetStUnhealthy,
    draining: __i18n.fleetStDraining,
    retired: __i18n.fleetStRetired,
    queued: __i18n.fleetStQueued,
    pending: __i18n.fleetStPending,
    running: __i18n.fleetStRunning,
    paused: __i18n.fleetStPaused,
  };
  function statusLabel(status) {
    return STATUS_LABELS[status] || titleCase(status);
  }

  // ── Status visual helpers (run lifecycle / worker / task / receipt) ──
  function lifecycleIcon(status) {
    if (status === 'completed') return '✓';
    if (status === 'failed') return '✕';
    if (status === 'cancelled') return '⊗';
    if (status === 'running') return '↻';
    if (status === 'queued') return '⏳';
    if (status === 'pending') return '○';
    if (status === 'paused') return '⏸';
    return '●';
  }
  function lifecycleClass(status) {
    if (status === 'completed') return 'status-completed';
    if (status === 'failed') return 'status-failed';
    if (status === 'cancelled') return 'status-canceled';
    if (status === 'running') return 'status-running';
    if (status === 'queued' || status === 'pending') return 'status-queued';
    if (status === 'paused') return 'status-muted';
    return 'status-muted';
  }
  function workerIcon(status) {
    if (status === 'online') return '●';
    if (status === 'busy') return '↻';
    if (status === 'offline') return '○';
    if (status === 'unhealthy') return '⚠';
    if (status === 'draining') return '◐';
    return '●';
  }
  function workerClass(status) {
    if (status === 'online') return 'status-completed';
    if (status === 'busy') return 'status-running';
    if (status === 'offline') return 'status-muted';
    if (status === 'unhealthy') return 'status-failed';
    return 'status-muted';
  }
  function taskIcon(status) {
    if (status === 'completed') return '✓';
    if (status === 'running' || status === 'leased' || status === 'in_progress') return '↻';
    if (status === 'failed') return '✕';
    if (status === 'queued' || status === 'pending') return '⏳';
    return '●';
  }
  function taskClass(status) {
    if (status === 'completed') return 'status-completed';
    if (status === 'running' || status === 'leased' || status === 'in_progress') return 'status-running';
    if (status === 'failed') return 'status-failed';
    if (status === 'queued' || status === 'pending') return 'status-queued';
    return 'status-muted';
  }
  function receiptIcon(result) {
    if (result === 'pass') return '✓';
    if (result === 'partial') return '◐';
    if (result === 'fail' || result === 'timeout') return '✕';
    if (result === 'skip') return '⊘';
    return '●';
  }
  function receiptClass(result) {
    if (result === 'pass') return 'status-completed';
    if (result === 'partial') return 'status-running';
    if (result === 'fail' || result === 'timeout') return 'status-failed';
    return 'status-muted';
  }

  function formatTime(value) {
    if (!value) return '-';
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  }

  function shortId(id) {
    return id ? String(id).slice(0, 8) : '';
  }

  function isRunActive(status) {
    return status === 'pending' || status === 'queued' || status === 'running' || status === 'paused';
  }

  // ── Render Fleet list (sidebar) ──
  function renderFleet() {
    var container = document.getElementById('tab-fleet');
    if (!container) return;
    container.innerHTML = '';

    var toolbar = document.createElement('div');
    toolbar.className = 'task-toolbar';
    var createBtn = document.createElement('button');
    createBtn.className = 'task-icon-btn primary';
    createBtn.type = 'button';
    createBtn.title = __i18n.fleetCreate;
    createBtn.setAttribute('aria-label', __i18n.fleetCreate);
    createBtn.textContent = '+';
    createBtn.onclick = function() { openFleetCreateDialog(); };
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'task-icon-btn';
    refreshBtn.type = 'button';
    refreshBtn.title = __i18n.taskRefresh || 'Refresh';
    refreshBtn.setAttribute('aria-label', __i18n.taskRefresh || 'Refresh');
    refreshBtn.textContent = '↻';
    refreshBtn.onclick = function() { vscode.postMessage({ type: 'refreshFleetRuns' }); };
    toolbar.appendChild(createBtn);
    toolbar.appendChild(refreshBtn);
    container.appendChild(toolbar);

    if (!fleetRuns || fleetRuns.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'work-empty';
      empty.innerHTML = '<div class="work-empty-icon">🚀</div><div class="work-empty-text">' + __wvEscapeHtml(__i18n.noFleetRuns) + '</div>';
      container.appendChild(empty);
      return;
    }

    // Sort active runs first, then by updated_at desc.
    var sorted = fleetRuns.slice().sort(function(a, b) {
      var aActive = isRunActive(a.lifecycle_status) ? 0 : 1;
      var bActive = isRunActive(b.lifecycle_status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });

    for (var i = 0; i < sorted.length; i++) {
      var run = sorted[i];
      var card = document.createElement('div');
      card.className = 'fleet-card' + (isRunActive(run.lifecycle_status) ? ' fleet-active' : '');
      var lc = run.lifecycle_status;
      var name = run.name || run.id || '';
      var html =
        '<div class="fleet-header">' +
          '<span class="fleet-status-icon ' + lifecycleClass(lc) + '">' + lifecycleIcon(lc) + '</span>' +
          '<span class="fleet-title">' + __wvEscapeHtml(name) + '</span>' +
        '</div>' +
        '<div class="fleet-meta">' +
          '<span class="fleet-status-badge ' + lifecycleClass(lc) + '">' + __wvEscapeHtml(titleCase(lc)) + '</span>' +
          '<span class="fleet-badge">' + __wvEscapeHtml(__i18n.fleetTaskCount) + ': ' + (run.task_count || 0) + '</span>' +
          '<span class="fleet-badge">' + __wvEscapeHtml(__i18n.fleetWorkerCount) + ': ' + (run.worker_count || 0) + '</span>' +
        '</div>';
      if (run.roles && run.roles.length > 0) {
        html += '<div class="fleet-roles">';
        for (var ri = 0; ri < run.roles.length && ri < 4; ri++) {
          html += '<span class="fleet-role-chip">' + __wvEscapeHtml(run.roles[ri]) + '</span>';
        }
        if (run.roles.length > 4) html += '<span class="fleet-role-more">+' + (run.roles.length - 4) + '</span>';
        html += '</div>';
      }
      card.innerHTML = html;
      (function(runId) {
        card.addEventListener('click', function(e) {
          if (e.target.tagName === 'BUTTON') return;
          vscode.postMessage({ type: 'showFleetDetail', runId: runId });
        });
      })(run.id);
      container.appendChild(card);
    }
  }

  // ── Render Fleet run detail overlay ──
  function renderCounters(status) {
    if (!status) return '';
    var defs = [
      ['queued', '⏳'], ['running', '↻'], ['completed', '✓'], ['partial', '◐'],
      ['failed', '✕'], ['cancelled', '⊗'], ['restarted', '↺'], ['escalated', '↑'],
      ['transport_failed', '⚠'], ['task_failed', '⚠'], ['verifier_failed', '⚠'], ['stale', '○']
    ];
    var parts = [];
    for (var i = 0; i < defs.length; i++) {
      var key = defs[i][0];
      var val = status[key];
      if (typeof val === 'number' && val > 0) {
        parts.push('<span class="fleet-counter fleet-counter-' + key + '"><span class="fleet-counter-icon">' + defs[i][1] + '</span>' + __wvEscapeHtml(titleCase(key)) + ' ' + val + '</span>');
      }
    }
    if (parts.length === 0) return '';
    return '<div class="fleet-counters">' + parts.join('') + '</div>';
  }

  function renderWorkerCard(w, taskNames) {
    var status = w.status || 'unknown';
    var rt = w.runtime_state || {};
    taskNames = taskNames || {};
    var html = '<div class="fleet-worker-card">';
    html += '<div class="fleet-worker-header">';
    html += '<span class="fleet-status-icon ' + workerClass(status) + '">' + workerIcon(status) + '</span>';
    html += '<span class="fleet-worker-id">' + __wvEscapeHtml(shortId(w.worker_id)) + '</span>';
    if (w.role) html += '<span class="fleet-role-chip">' + __wvEscapeHtml(w.role) + '</span>';
    html += '<span class="fleet-status-badge ' + workerClass(status) + '">' + __wvEscapeHtml(statusLabel(status)) + '</span>';
    html += '</div>';
    if (w.objective) html += '<div class="fleet-worker-objective">' + __wvEscapeHtml(w.objective) + '</div>';
    html += '<div class="fleet-worker-meta">';
    html += '<span>' + __wvEscapeHtml(__i18n.agentSteps) + ': ' + (rt.steps_taken || 0) + '</span>';
    if (w.task_id) html += ' · <span title="' + __wvEscapeHtml(w.task_id) + '">' + __wvEscapeHtml(__i18n.fleetTasks) + ': ' + __wvEscapeHtml(taskNames[w.task_id] || shortId(w.task_id)) + '</span>';
    if (w.host) html += ' · <span>' + __wvEscapeHtml(w.host) + '</span>';
    html += '</div>';
    if (rt.latest_message) {
      var lm = String(rt.latest_message);
      // Long worker output is expandable instead of hard-truncated — the
      // tail of the message is often exactly what explains a failure.
      if (lm.length > 160) {
        html += '<details class="fleet-worker-message-details"><summary>' + __wvEscapeHtml(lm.slice(0, 160)) + '…</summary><pre class="fleet-worker-message-full">' + __wvEscapeHtml(lm) + '</pre></details>';
      } else {
        html += '<div class="fleet-worker-message">' + __wvEscapeHtml(lm) + '</div>';
      }
    }
    if (rt.result_summary) html += '<div class="fleet-worker-result">' + __wvEscapeHtml(String(rt.result_summary).slice(0, 160)) + '</div>';
    var werr = w.last_error || rt.error;
    if (werr) {
      var werrText = String(werr);
      html += '<div class="fleet-worker-error" title="' + __wvEscapeHtml(werrText) + '">' + __wvEscapeHtml(werrText.length > 240 ? werrText.slice(0, 240) + '…' : werrText) + '</div>';
    }
    if (w.artifacts && w.artifacts.length > 0) {
      html += '<div class="fleet-worker-artifacts">';
      for (var ai = 0; ai < w.artifacts.length && ai < 3; ai++) {
        var artFullPath = w.artifacts[ai].path || '';
        var artPath = artFullPath.split('/').pop() || artFullPath;
        html += '<span class="fleet-artifact-chip" title="' + __wvEscapeHtml(artFullPath) + '">' + __wvEscapeHtml(artPath) + '</span>';
      }
      if (w.artifacts.length > 3) html += '<span class="fleet-artifact-more">+' + (w.artifacts.length - 3) + '</span>';
      html += '</div>';
    }
    html += '<div class="fleet-worker-actions">';
    html += '<button class="fleet-action-btn" data-fleet-worker-action="interrupt" data-worker-id="' + __wvEscapeHtml(w.worker_id) + '">' + __wvEscapeHtml(__i18n.fleetInterrupt) + '</button>';
    html += '<button class="fleet-action-btn" data-fleet-worker-action="stop" data-worker-id="' + __wvEscapeHtml(w.worker_id) + '">' + __wvEscapeHtml(__i18n.fleetStop) + '</button>';
    html += '<button class="fleet-action-btn" data-fleet-worker-action="restart" data-worker-id="' + __wvEscapeHtml(w.worker_id) + '">' + __wvEscapeHtml(__i18n.fleetRestart) + '</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  /** Task row: shows the creation-time name / role / objective / instructions
   *  from the run's task_specs, joined with the live status row. The spec is
   *  optional so status-only rows (older payloads) still render. failureNote
   *  (receipt classification / terminal reason / worker last_error) is shown
   *  on failed rows so the cause is readable without digging through events. */
  function renderTaskRow(t, spec, failureNote) {
    spec = spec || {};
    var status = t.status || 'unknown';
    var taskId = t.task_id || spec.id || '';
    var name = spec.name || taskId;
    var role = (spec.worker && spec.worker.role) || '';
    var html = '<div class="fleet-task-row">';
    html += '<div class="fleet-task-head">' +
      '<span class="fleet-status-icon ' + taskClass(status) + '">' + taskIcon(status) + '</span>' +
      '<span class="fleet-task-name" title="' + __wvEscapeHtml(taskId) + '">' + __wvEscapeHtml(name) + '</span>' +
      (role ? '<span class="fleet-role-chip">' + __wvEscapeHtml(role) + '</span>' : '') +
      '<span class="fleet-status-badge ' + taskClass(status) + '">' + __wvEscapeHtml(statusLabel(status)) + '</span>' +
      '<span class="fleet-task-meta">' + __wvEscapeHtml(__i18n.fleetAttempts) + ': ' + (t.attempts || 0) + (t.leased_to ? ' · ' + __wvEscapeHtml(shortId(t.leased_to)) : '') + '</span>' +
    '</div>';
    if (spec.objective) html += '<div class="fleet-task-objective">' + __wvEscapeHtml(spec.objective) + '</div>';
    if (status === 'enqueued') {
      html += '<div class="fleet-task-wait-hint">' + __wvEscapeHtml(__i18n.fleetStEnqueuedHint) + '</div>';
    }
    if (failureNote && status === 'failed') {
      html += '<div class="fleet-task-failure"><span class="fleet-task-failure-label">' + __wvEscapeHtml(__i18n.fleetTaskFailure) + '</span>' + __wvEscapeHtml(failureNote) + '</div>';
    }
    if (spec.instructions) {
      html += '<details class="fleet-task-details" data-task-id="' + __wvEscapeHtml(taskId) + '"><summary>' + __wvEscapeHtml(__i18n.fleetTaskInstructions) + '</summary>' +
        '<pre class="fleet-task-instructions">' + __wvEscapeHtml(spec.instructions) + '</pre>' +
      '</details>';
    }
    html += '</div>';
    return html;
  }

  function renderReceiptCard(r, taskNames) {
    taskNames = taskNames || {};
    var score = r.score ? (r.score.value + '/' + r.score.max) : '';
    var html = '<div class="fleet-receipt-card">';
    html += '<div class="fleet-receipt-header">';
    html += '<span class="fleet-status-icon ' + receiptClass(r.result) + '">' + receiptIcon(r.result) + '</span>';
    html += '<span class="fleet-task-name" title="' + __wvEscapeHtml(r.task_id || '') + '">' + __wvEscapeHtml(taskNames[r.task_id] || shortId(r.task_id)) + '</span>';
    html += '<span class="fleet-status-badge ' + receiptClass(r.result) + '">' + __wvEscapeHtml(titleCase(r.result)) + '</span>';
    if (score) html += '<span class="fleet-badge">' + __wvEscapeHtml(__i18n.fleetScore) + ': ' + __wvEscapeHtml(score) + '</span>';
    html += '</div>';
    html += '<div class="fleet-receipt-meta">';
    html += __wvEscapeHtml(__i18n.fleetAttempts) + ': ' + (r.attempt || 0);
    if (r.worker_id) html += ' · ' + __wvEscapeHtml(shortId(r.worker_id));
    if (r.completed_at) html += ' · ' + __wvEscapeHtml(formatTime(r.completed_at));
    html += '</div>';
    if (r.failure_kind) html += '<div class="fleet-receipt-failure">' + __wvEscapeHtml(titleCase(r.failure_kind)) + (r.failure_class ? ': ' + __wvEscapeHtml(r.failure_class) : '') + '</div>';
    var scoreNotes = r.score && r.score.notes ? String(r.score.notes) : '';
    if (scoreNotes) {
      // The receipt note is the bounded deliverable excerpt for report/summary
      // tasks (or the scorer's explanation). Long notes collapse by default.
      if (scoreNotes.length > 200) {
        html += '<details class="fleet-receipt-notes"><summary>' + __wvEscapeHtml(scoreNotes.slice(0, 200)) + '…</summary><pre class="fleet-worker-message-full">' + __wvEscapeHtml(scoreNotes) + '</pre></details>';
      } else {
        html += '<div class="fleet-receipt-notes">' + __wvEscapeHtml(scoreNotes) + '</div>';
      }
    }
    // The worker persists its full transcript as a saved session on completion;
    // surface a way to pull the final assistant reply from it.
    if (r.session_id) {
      html += '<button class="fleet-action-btn fleet-session-btn" data-fleet-session-id="' + __wvEscapeHtml(r.session_id) + '">' + __wvEscapeHtml(__i18n.fleetViewReply) + '</button>';
    }
    html += '</div>';
    return html;
  }

  function showFleetDetail(payload) {
    var overlay = document.getElementById('fleet-detail-overlay');
    if (!overlay) return;
    var run = payload.run || {};
    var workers = payload.workers || [];
    var receipts = payload.receipts || [];
    // SSE-triggered refreshes re-post the same payload; a full innerHTML
    // rebuild on every one of them is what made the panel flash. Skip the
    // re-render entirely when nothing changed.
    var payloadJson = '';
    try { payloadJson = JSON.stringify(payload); } catch (e) { payloadJson = ''; }
    var isRefresh = detailOpen && activeRunId === run.id && !!overlay.innerHTML;
    if (isRefresh && payloadJson && payloadJson === lastDetailJson) return;
    lastDetailJson = payloadJson;
    // Creation-time task authoring data (name / role / objective / prompt)
    // from the detail endpoint's task_specs, joined with live status rows.
    var specById = {};
    var taskNames = {};
    var specs = run.task_specs || [];
    for (var si = 0; si < specs.length; si++) {
      specById[specs[si].id] = specs[si];
      taskNames[specs[si].id] = specs[si].name || specs[si].id;
    }
    // Why a task failed: the receipt's failure classification is the
    // authoritative answer, the terminal failed event's reason and the
    // worker's last_error are fallbacks. Surfaced on the task row itself.
    var taskFailures = {};
    for (var fi = 0; fi < receipts.length; fi++) {
      var rc = receipts[fi];
      if ((rc.result === 'fail' || rc.result === 'timeout') && rc.failure_class) {
        taskFailures[rc.task_id] = rc.failure_class;
      }
    }
    for (var fj = 0; fj < fleetEvents.length; fj++) {
      var fe = fleetEvents[fj];
      var fp = (fe.payload && typeof fe.payload === 'object') ? fe.payload : {};
      if (fp.state === 'failed' && fe.task_id && fp.reason && !taskFailures[fe.task_id]) {
        taskFailures[fe.task_id] = fp.reason;
      }
    }
    for (var fk = 0; fk < workers.length; fk++) {
      var werr = workers[fk].last_error || ((workers[fk].runtime_state || {}).error || '');
      if (workers[fk].task_id && werr && !taskFailures[workers[fk].task_id]) {
        taskFailures[workers[fk].task_id] = werr;
      }
    }
    detailTaskNames = taskNames;
    var lc = run.lifecycle_status;
    var previousRunId = activeRunId;
    activeRunId = run.id || null;
    detailOpen = true;
    detailRun = run;
    // Keep the live timeline across refreshes of the same run; clear it
    // only when a different run's detail is opened.
    if (previousRunId !== activeRunId) fleetEvents = [];
    // View state to restore after the re-render (same-run refresh only):
    // expanded task prompts + panel scroll position.
    var openTaskIds = [];
    var scrollTop = 0;
    if (isRefresh) {
      var panel = overlay.querySelector('.fleet-detail-panel');
      scrollTop = panel ? panel.scrollTop : 0;
      overlay.querySelectorAll('.fleet-task-details[open]').forEach(function(d) {
        var tid = d.getAttribute('data-task-id');
        if (tid) openTaskIds.push(tid);
      });
    }

    var html = '<div class="fleet-detail-panel">';
    html += '<button class="close-btn" type="button">✕</button>';
    html += '<div class="fleet-detail-header">';
    html += '<h3><span class="fleet-status-icon ' + lifecycleClass(lc) + '">' + lifecycleIcon(lc) + '</span> ' + __wvEscapeHtml(run.name || run.id || '') + '</h3>';
    html += '<span class="fleet-status-badge ' + lifecycleClass(lc) + '">' + __wvEscapeHtml(statusLabel(lc)) + '</span>';
    html += '</div>';

    html += '<div class="fleet-detail-actions">';
    if (lc === 'queued' || lc === 'pending' || lc === 'paused') {
      html += '<button class="detail-action-btn fleet-run-start" data-run-id="' + __wvEscapeHtml(run.id) + '">▶ ' + __wvEscapeHtml(__i18n.fleetStart) + '</button>';
    }
    if (isRunActive(lc)) {
      html += '<button class="detail-action-btn fleet-run-stop" data-run-id="' + __wvEscapeHtml(run.id) + '">■ ' + __wvEscapeHtml(__i18n.fleetStop) + '</button>';
    }
    html += '<button class="detail-action-btn fleet-detail-refresh" data-run-id="' + __wvEscapeHtml(run.id) + '">↻ ' + __wvEscapeHtml(__i18n.taskRefresh || 'Refresh') + '</button>';
    html += '<button class="detail-action-btn fleet-run-new" data-run-id="' + __wvEscapeHtml(run.id) + '" title="' + __wvEscapeHtml(__i18n.fleetNewFromRunHint) + '">＋ ' + __wvEscapeHtml(__i18n.fleetNewFromRun) + '</button>';
    html += '</div>';

    html += '<div class="fleet-detail-meta">';
    html += '<div class="fleet-detail-row"><span class="fleet-detail-label">' + __wvEscapeHtml(__i18n.fleetRunId) + '</span><span class="fleet-detail-value">' + __wvEscapeHtml(run.id || '-') + '</span></div>';
    if (run.workflow) {
      html += '<div class="fleet-detail-row"><span class="fleet-detail-label">Workflow</span><span class="fleet-detail-value">' + __wvEscapeHtml(run.workflow.id || '-') + ' · ' + __wvEscapeHtml(run.workflow.kind || '') + '</span></div>';
    }
    html += '<div class="fleet-detail-row"><span class="fleet-detail-label">Target</span><span class="fleet-detail-value">' + __wvEscapeHtml(run.target || '-') + '</span></div>';
    html += '<div class="fleet-detail-row"><span class="fleet-detail-label">' + __wvEscapeHtml(__i18n.fleetStatus) + '</span><span class="fleet-detail-value">' + __wvEscapeHtml(formatTime(run.created_at)) + ' → ' + __wvEscapeHtml(formatTime(run.completed_at)) + '</span></div>';
    html += '</div>';

    html += renderCounters(run.status);

    // Live event timeline (fed by the SSE stream while this detail is open).
    // Filter chips keep the noise (heartbeats) out of the way and make
    // failures the first thing the eye lands on.
    html += '<div class="fleet-detail-section">';
    html += '<div class="fleet-detail-section-title">📡 Events (<span id="fleet-event-count">0</span>)</div>';
    html += '<div class="fleet-event-filters">';
    html += '<button class="fleet-event-filter' + (fleetEventFilter === 'issues' ? ' active' : '') + '" data-filter="issues">' + __wvEscapeHtml(__i18n.fleetEvFilterIssues) + '<span class="fleet-event-issue-count" id="fleet-event-issues" style="display:none"></span></button>';
    html += '<button class="fleet-event-filter' + (fleetEventFilter === 'progress' ? ' active' : '') + '" data-filter="progress">' + __wvEscapeHtml(__i18n.fleetEvFilterProgress) + '</button>';
    html += '<button class="fleet-event-filter' + (fleetEventFilter === 'all' ? ' active' : '') + '" data-filter="all">' + __wvEscapeHtml(__i18n.fleetEvFilterAll) + '</button>';
    html += '</div>';
    html += '<div class="fleet-event-list" id="fleet-event-list"></div>';
    html += '</div>';

    // Workers
    html += '<div class="fleet-detail-section"><div class="fleet-detail-section-title">🤖 ' + __wvEscapeHtml(__i18n.fleetWorkers) + ' (' + workers.length + ')</div>';
    if (workers.length === 0) {
      html += '<div class="work-empty"><div class="work-empty-text">' + __wvEscapeHtml(__i18n.fleetNoWorkers) + '</div></div>';
    } else {
      for (var wi = 0; wi < workers.length; wi++) html += renderWorkerCard(workers[wi], taskNames);
    }
    html += '</div>';

    // Tasks — status rows joined with creation-time specs; spec-only rows
    // (detail fetched before any ledger status) still render with unknown status.
    var tasks = run.tasks || [];
    html += '<div class="fleet-detail-section"><div class="fleet-detail-section-title">☑ ' + __wvEscapeHtml(__i18n.fleetTasks) + ' (' + (tasks.length || specs.length) + ')</div>';
    if (tasks.length === 0 && specs.length === 0) {
      html += '<div class="work-empty"><div class="work-empty-text">' + __wvEscapeHtml(__i18n.fleetNoTasks) + '</div></div>';
    } else if (tasks.length > 0) {
      for (var ti = 0; ti < tasks.length; ti++) html += renderTaskRow(tasks[ti], specById[tasks[ti].task_id], taskFailures[tasks[ti].task_id]);
    } else {
      for (var spi = 0; spi < specs.length; spi++) html += renderTaskRow({ task_id: specs[spi].id }, specs[spi], taskFailures[specs[spi].id]);
    }
    html += '</div>';

    // Receipts
    html += '<div class="fleet-detail-section"><div class="fleet-detail-section-title">📄 ' + __wvEscapeHtml(__i18n.fleetReceipts) + ' (' + receipts.length + ')</div>';
    if (receipts.length === 0) {
      html += '<div class="work-empty"><div class="work-empty-text">' + __wvEscapeHtml(__i18n.fleetNoReceipts) + '</div></div>';
    } else {
      for (var ri2 = 0; ri2 < receipts.length; ri2++) html += renderReceiptCard(receipts[ri2], taskNames);
    }
    html += '</div>';

    html += '</div>';
    overlay.innerHTML = html;
    overlay.style.display = 'flex';

    // Rebuild the accumulated event timeline (fleetEvents survives refreshes
    // of the same run, so the count and rows no longer reset mid-stream).
    renderEventList();

    // Restore the pre-refresh view state: expanded prompts + scroll.
    if (openTaskIds.length) {
      overlay.querySelectorAll('.fleet-task-details').forEach(function(d) {
        if (openTaskIds.indexOf(d.getAttribute('data-task-id')) >= 0) d.open = true;
      });
    }
    if (isRefresh) {
      var newPanel = overlay.querySelector('.fleet-detail-panel');
      if (newPanel) newPanel.scrollTop = scrollTop;
    }

    overlay.onclick = function(e) {
      var target = e.target;
      if (target === overlay) { closeFleetDetail(); return; }
      var closeBtn = target.closest && target.closest('.close-btn');
      if (closeBtn) { e.stopPropagation(); closeFleetDetail(); return; }
      var startBtn = target.closest && target.closest('.fleet-run-start');
      if (startBtn) {
        e.stopPropagation();
        var runId = startBtn.getAttribute('data-run-id');
        if (runId) vscode.postMessage({ type: 'startFleetRun', runId: runId });
        return;
      }
      var stopBtn = target.closest && target.closest('.fleet-run-stop');
      if (stopBtn) {
        e.stopPropagation();
        var runId2 = stopBtn.getAttribute('data-run-id');
        if (runId2) vscode.postMessage({ type: 'stopFleetRun', runId: runId2 });
        return;
      }
      var filterBtn = target.closest && target.closest('.fleet-event-filter');
      if (filterBtn) {
        e.stopPropagation();
        fleetEventFilter = filterBtn.getAttribute('data-filter') || 'progress';
        overlay.querySelectorAll('.fleet-event-filter').forEach(function(b) {
          b.classList.toggle('active', b === filterBtn);
        });
        renderEventList();
        return;
      }
      var refreshDetailBtn = target.closest && target.closest('.fleet-detail-refresh');
      if (refreshDetailBtn) {
        e.stopPropagation();
        var runId3 = refreshDetailBtn.getAttribute('data-run-id');
        if (runId3) vscode.postMessage({ type: 'showFleetDetail', runId: runId3 });
        return;
      }
      var newFromRunBtn = target.closest && target.closest('.fleet-run-new');
      if (newFromRunBtn) {
        e.stopPropagation();
        if (detailRun) openFleetCreateDialog(detailRun);
        return;
      }
      var sessionBtn = target.closest && target.closest('.fleet-session-btn');
      if (sessionBtn) {
        e.stopPropagation();
        var sessionId = sessionBtn.getAttribute('data-fleet-session-id');
        if (sessionId) vscode.postMessage({ type: 'fleetOpenSession', sessionId: sessionId });
        return;
      }
      var workerBtn = target.closest && target.closest('.fleet-action-btn');
      if (workerBtn) {
        e.stopPropagation();
        var action = workerBtn.getAttribute('data-fleet-worker-action');
        var workerId = workerBtn.getAttribute('data-worker-id');
        if (action && workerId) vscode.postMessage({ type: 'fleetWorkerAction', action: action, workerId: workerId });
        return;
      }
    };
  }

  function closeFleetDetail() {
    var overlay = document.getElementById('fleet-detail-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.onclick = null;
    }
    activeRunId = null;
    detailOpen = false;
    detailRun = null;
    lastDetailJson = '';
    vscode.postMessage({ type: 'closeFleetDetail' });
  }

  // Replace a receipt's "view reply" button with the worker's full final reply.
  function showFleetReply(sessionId, reply) {
    var overlay = document.getElementById('fleet-detail-overlay');
    if (!overlay) return;
    var btn = overlay.querySelector('.fleet-session-btn[data-fleet-session-id="' + sessionId + '"]');
    if (!btn) return;
    var holder = document.createElement('span');
    holder.innerHTML = '<details class="fleet-receipt-reply" open><summary>' + __wvEscapeHtml(__i18n.fleetViewReply) + '</summary><pre class="fleet-worker-message-full">' + __wvEscapeHtml(String(reply || '')) + '</pre></details>';
    var el = holder.firstElementChild;
    if (el) btn.parentNode.replaceChild(el, btn);
  }

  // ── Live event timeline ──
  // Event kinds come from the TUI ledger (fleet.run.*, fleet.task.*,
  // fleet.worker.*); worker-event payloads carry a "state" tag with
  // per-state fields (reason / exit_code / tool / model / ...).

  var fleetEventFilter = 'progress'; // 'issues' | 'progress' | 'all'
  var detailTaskNames = {};

  function eventTime(value) {
    if (!value) return '-';
    var d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (isNaN(d.getTime())) return String(value);
    return d.toTimeString().slice(0, 8);
  }

  function payloadObject(ev) {
    return (ev.payload && typeof ev.payload === 'object') ? ev.payload : {};
  }

  function payloadState(ev) {
    var p = payloadObject(ev);
    return p.state ? String(p.state) : '';
  }

  /** error = task/worker failure paths; warn = degraded/interrupted;
   *  ok = success paths; dim = heartbeat noise; info = everything else. */
  function eventSeverity(ev) {
    var kind = String(ev.event || '');
    var st = payloadState(ev);
    var p = payloadObject(ev);
    if (st === 'failed' || kind.indexOf('fail') >= 0 || kind.indexOf('error') >= 0) return 'error';
    if (st === 'stale' || st === 'interrupted' || st === 'escalated' || kind.indexOf('alert') >= 0) return 'warn';
    if (st === 'cancelled') return 'warn';
    if (kind.indexOf('receipt') >= 0 && (p.result === 'fail' || p.result === 'timeout')) return 'error';
    if (kind.indexOf('receipt') >= 0 && p.result === 'pass') return 'ok';
    if (st === 'completed') {
      return (typeof p.exit_code === 'number' && p.exit_code !== 0) ? 'error' : 'ok';
    }
    if (kind.indexOf('heartbeat') >= 0 || st === 'heartbeat') return 'dim';
    return 'info';
  }

  /** Human-readable one-liner instead of raw JSON. */
  function eventMessage(ev) {
    var kind = String(ev.event || '');
    var p = payloadObject(ev);
    var st = p.state ? String(p.state) : '';
    var msg = '';
    if (st === 'failed') msg = p.reason || '';
    else if (st === 'completed') {
      msg = (typeof p.exit_code === 'number' && p.exit_code !== 0)
        ? ('exit code ' + p.exit_code + (p.summary ? ' · ' + p.summary : ''))
        : (p.summary || '');
    }
    else if (st === 'cancelled') msg = p.cancelled_by ? ('cancelled by ' + p.cancelled_by) : '';
    else if (st === 'interrupted') msg = p.signal ? ('signal ' + p.signal) : '';
    else if (st === 'stale') msg = p.last_heartbeat_at ? ('last heartbeat ' + formatTime(p.last_heartbeat_at)) : '';
    else if (st === 'running_tool') msg = p.tool ? '🔧 ' + p.tool : '';
    else if (st === 'model_wait') msg = p.model ? '⏳ ' + p.model : '';
    else if (st === 'usage_report') msg = (p.input_tokens != null) ? ('tokens ' + p.input_tokens + ' in / ' + p.output_tokens + ' out') : '';
    else if (st === 'artifact' && p.path) msg = String(p.path);
    else if (st === 'workflow_event' && p.event_type) msg = String(p.event_type);
    else if (kind === 'fleet.run.status_changed' && p.status) msg = '→ ' + titleCase(String(p.status));
    else if (kind === 'fleet.task.terminal' && p.status) msg = titleCase(String(p.status));
    else if (kind === 'fleet.task.enqueued') msg = 'priority ' + (p.priority != null ? p.priority : 0);
    else if (kind === 'fleet.task.leased' && ev.worker_id) msg = '→ ⚙' + shortId(ev.worker_id);
    else if (kind.indexOf('receipt') >= 0 && (p.result === 'fail' || p.result === 'timeout')) msg = p.failure_class || '';
    if (!msg) {
      try {
        var s = JSON.stringify(p);
        if (s && s !== '{}') msg = s.length > 90 ? s.slice(0, 90) + '…' : s;
      } catch (e) { msg = ''; }
    }
    return String(msg || '');
  }

  function eventKindLabel(kind) {
    var map = {
      'fleet.run.created': __i18n.fleetEvRunCreated,
      'fleet.run.status_changed': __i18n.fleetEvRunStatus,
      'fleet.task.enqueued': __i18n.fleetEvEnqueued,
      'fleet.task.leased': __i18n.fleetEvLeased,
      'fleet.task.terminal': __i18n.fleetEvTerminal,
      'fleet.task.receipt_recorded': __i18n.fleetEvReceipt,
      'fleet.worker.heartbeat': __i18n.fleetEvHeartbeat,
      'fleet.alert.sent': __i18n.fleetEvAlert,
    };
    if (map[kind]) return map[kind];
    return titleCase(String(kind || 'event').replace(/^fleet\./, ''));
  }

  function eventPassesFilter(ev) {
    if (fleetEventFilter === 'all') return true;
    var sev = eventSeverity(ev);
    if (fleetEventFilter === 'issues') return sev === 'error' || sev === 'warn';
    return sev !== 'dim'; // progress: everything except heartbeat noise
  }

  function eventRowHtml(ev) {
    var sev = eventSeverity(ev);
    var st = payloadState(ev);
    var chip = st ? titleCase(st) : eventKindLabel(ev.event);
    var msg = eventMessage(ev);
    var meta = [];
    if (ev.task_id) meta.push(detailTaskNames[ev.task_id] || shortId(ev.task_id));
    if (ev.worker_id) meta.push('⚙' + shortId(ev.worker_id));
    var payloadPretty = '';
    try {
      if (ev.payload && typeof ev.payload === 'object') {
        var keys = Object.keys(ev.payload);
        if (keys.length) payloadPretty = JSON.stringify(ev.payload, null, 2);
      } else if (ev.payload) {
        payloadPretty = String(ev.payload);
      }
    } catch (e) { payloadPretty = ''; }
    var html = '<div class="fleet-event-row sev-' + sev + '">';
    html += '<span class="fleet-event-time">' + __wvEscapeHtml(eventTime(ev.timestamp)) + '</span>';
    html += '<span class="fleet-event-chip sev-' + sev + '">' + __wvEscapeHtml(chip) + '</span>';
    if (meta.length) html += '<span class="fleet-event-meta">' + __wvEscapeHtml(meta.join(' · ')) + '</span>';
    if (msg) html += '<span class="fleet-event-msg" title="' + __wvEscapeHtml(msg) + '">' + __wvEscapeHtml(msg) + '</span>';
    if (payloadPretty) {
      html += '<details class="fleet-event-detail"><summary>JSON</summary><pre>' + __wvEscapeHtml(payloadPretty) + '</pre></details>';
    }
    html += '</div>';
    return html;
  }

  function updateEventCounts() {
    var count = document.getElementById('fleet-event-count');
    if (count) count.textContent = String(fleetEvents.length);
    var badge = document.getElementById('fleet-event-issues');
    if (badge) {
      var n = 0;
      for (var i = 0; i < fleetEvents.length; i++) {
        var s = eventSeverity(fleetEvents[i]);
        if (s === 'error' || s === 'warn') n++;
      }
      badge.textContent = String(n);
      badge.style.display = n ? '' : 'none';
    }
  }

  function renderEventList() {
    var list = document.getElementById('fleet-event-list');
    if (!list) return;
    var rows = '';
    for (var i = 0; i < fleetEvents.length; i++) {
      if (eventPassesFilter(fleetEvents[i])) rows += eventRowHtml(fleetEvents[i]);
    }
    list.innerHTML = rows;
    updateEventCounts();
  }

  function handleFleetEvent(ev) {
    if (!ev || !detailOpen || (ev.run_id !== activeRunId)) return;
    fleetEvents.unshift(ev);
    if (fleetEvents.length > MAX_FLEET_EVENTS) fleetEvents.pop();
    var list = document.getElementById('fleet-event-list');
    if (list && eventPassesFilter(ev)) list.insertAdjacentHTML('afterbegin', eventRowHtml(ev));
    updateEventCounts();
  }

  // ── Fleet run creation dialog ──

  /** agent_profile picker: a roster select element when the backend reported
   *  profiles, otherwise a free-text input (older TUI without the endpoint). */
  function profileFieldHtml(value) {
    var hint = __wvEscapeHtml(__i18n.fleetCreateRolesHint);
    if (!fleetProfiles.length) {
      return '<input class="fleet-create-role-profile" placeholder="agent_profile" title="' + hint + '" value="' + __wvEscapeHtml(value || '') + '" />';
    }
    var html = '<select class="fleet-create-role-profile" title="' + hint + '">';
    html += '<option value="">' + __wvEscapeHtml(__i18n.fleetProfileNone) + '</option>';
    for (var i = 0; i < fleetProfiles.length; i++) {
      var p = fleetProfiles[i];
      var label = p.display_name || p.id;
      if (p.origin) label += ' (' + p.origin + ')';
      var sel = value && value === p.id ? ' selected' : '';
      html += '<option value="' + __wvEscapeHtml(p.id) + '"' + sel + ' title="' + __wvEscapeHtml(p.description || '') + '">' + __wvEscapeHtml(label) + '</option>';
    }
    return html + '</select>';
  }

  function roleRowHtml(role) {
    role = role || {};
    return '<div class="fleet-create-role-row">' +
      '<input class="fleet-create-role-name" placeholder="' + __wvEscapeHtml(__i18n.fleetCreateTaskRole) + '" title="' + __wvEscapeHtml(__i18n.fleetCreateTokenError) + '" value="' + __wvEscapeHtml(role.name || '') + '" />' +
      profileFieldHtml(role.agent_profile) +
      '<button class="fleet-create-remove fleet-create-role-remove" type="button" title="' + __wvEscapeHtml(__i18n.fleetCreateRemove) + '">✕</button>' +
    '</div>';
  }

  function roleSelectOptions(roleNames, selected) {
    var html = '<option value="">' + __wvEscapeHtml(__i18n.fleetCreateTaskRole) + '</option>';
    for (var i = 0; i < roleNames.length; i++) {
      var sel = selected === roleNames[i] ? ' selected' : '';
      html += '<option value="' + __wvEscapeHtml(roleNames[i]) + '"' + sel + '>' + __wvEscapeHtml(roleNames[i]) + '</option>';
    }
    return html;
  }

  function taskCardHtml(task, roleNames) {
    task = task || {};
    roleNames = roleNames || [];
    return '<div class="fleet-create-task-card">' +
      '<div class="fleet-create-task-head">' +
        '<span class="fleet-create-task-title">' + __wvEscapeHtml(__i18n.fleetTasks) + '</span>' +
        '<button class="fleet-create-remove fleet-create-task-remove" type="button" title="' + __wvEscapeHtml(__i18n.fleetCreateRemove) + '">✕</button>' +
      '</div>' +
      '<div class="fleet-create-row">' +
        '<input class="fleet-create-task-id" placeholder="' + __wvEscapeHtml(__i18n.fleetCreateTaskId) + '" value="' + __wvEscapeHtml(task.id || nextTaskId()) + '" />' +
        '<input class="fleet-create-task-name" placeholder="' + __wvEscapeHtml(__i18n.fleetCreateTaskName) + '" value="' + __wvEscapeHtml(task.name || '') + '" />' +
      '</div>' +
      '<div class="fleet-create-row">' +
        '<select class="fleet-create-task-role">' + roleSelectOptions(roleNames, task.role) + '</select>' +
        '<input class="fleet-create-task-objective" placeholder="' + __wvEscapeHtml(__i18n.fleetCreateTaskObjective) + '" value="' + __wvEscapeHtml(task.objective || '') + '" />' +
      '</div>' +
      '<textarea class="fleet-create-task-instructions" placeholder="' + __wvEscapeHtml(__i18n.fleetCreateTaskInstructions) + '">' + __wvEscapeHtml(task.instructions || '') + '</textarea>' +
    '</div>';
  }

  function collectRoleNames() {
    var names = [];
    document.querySelectorAll('.fleet-create-role-name').forEach(function(input) {
      var v = input.value.trim();
      if (v) names.push(v);
    });
    return names;
  }

  function refreshRoleSelects() {
    var names = collectRoleNames();
    document.querySelectorAll('.fleet-create-task-card').forEach(function(card) {
      var select = card.querySelector('.fleet-create-task-role');
      if (!select) return;
      var current = select.value;
      select.innerHTML = roleSelectOptions(names, null);
      if (current && names.indexOf(current) >= 0) select.value = current;
    });
  }

  function stepHeadHtml(num, title, desc) {
    return '<div class="fleet-create-step-head">' +
      '<span class="fleet-create-step-num">' + num + '</span>' +
      '<span class="fleet-create-step-text">' +
        '<span class="fleet-create-step-title">' + __wvEscapeHtml(title) + '</span>' +
        '<span class="fleet-create-section-desc">' + __wvEscapeHtml(desc) + '</span>' +
      '</span>' +
    '</div>';
  }

  /** Open the create dialog. sourceRun (optional) prefills name / roles /
   *  tasks from an existing run — the "new from this run" path that stands
   *  in for the editing the managed API does not offer. */
  function openFleetCreateDialog(sourceRun) {
    var overlay = document.getElementById('fleet-create-overlay');
    if (!overlay) return;

    var prefillRoles = [];
    var prefillTasks = [];
    if (sourceRun) {
      var srcRoles = sourceRun.roles || [];
      for (var pri = 0; pri < srcRoles.length; pri++) {
        prefillRoles.push({ name: srcRoles[pri], agent_profile: null });
      }
      var srcSpecs = sourceRun.task_specs || [];
      for (var psi = 0; psi < srcSpecs.length; psi++) {
        prefillTasks.push({
          id: srcSpecs[psi].id,
          name: srcSpecs[psi].name || '',
          role: (srcSpecs[psi].worker && srcSpecs[psi].worker.role) || '',
          objective: srcSpecs[psi].objective || '',
          instructions: srcSpecs[psi].instructions || '',
        });
      }
    }
    var prefillRoleNames = [];
    for (var prn = 0; prn < prefillRoles.length; prn++) prefillRoleNames.push(prefillRoles[prn].name);

    taskSeq = prefillTasks.length;
    // ids are required by the runtime; prefill sane defaults so the user
    // only edits them when they care. The workflow id is always fresh so
    // the new run never collides with the source run's identity.
    var workflowDefault = autoWorkflowId();

    var html = '<div class="fleet-create-panel">';
    html += '<div class="task-create-header">';
    html += '<h3>🚀 ' + __wvEscapeHtml(__i18n.fleetCreate) + '</h3>';
    html += '<button class="close-btn fleet-create-close" type="button">✕</button>';
    html += '</div>';
    html += '<div class="fleet-create-desc">' + __wvEscapeHtml(__i18n.fleetCreateDesc) + '</div>';
    html += '<div class="fleet-create-body">';
    html += stepHeadHtml('1', __i18n.fleetCreateBasics, __i18n.fleetCreateBasicsDesc);
    html += '<div class="fleet-create-row">';
    html += '<label class="fleet-create-field"><span>' + __wvEscapeHtml(__i18n.fleetCreateName) + '</span><input id="fleet-create-name" value="' + __wvEscapeHtml(sourceRun ? (sourceRun.name || '') : '') + '" /></label>';
    html += '<label class="fleet-create-field"><span>' + __wvEscapeHtml(__i18n.fleetCreateWorkflowId) + '</span><input id="fleet-create-workflow" value="' + __wvEscapeHtml(workflowDefault) + '" /></label>';
    html += '</div>';
    html += '<label class="fleet-create-field"><span>' + __wvEscapeHtml(__i18n.fleetCreateMaxWorkers) + '</span><input id="fleet-create-maxworkers" type="number" min="1" max="128" /></label>';

    html += stepHeadHtml('2', __i18n.fleetCreateRoles, __i18n.fleetCreateRolesDesc);
    var rolesHtml = '';
    if (prefillRoles.length) {
      for (var ri = 0; ri < prefillRoles.length; ri++) rolesHtml += roleRowHtml(prefillRoles[ri]);
    } else {
      rolesHtml = roleRowHtml();
    }
    html += '<div class="fleet-create-roles" id="fleet-create-roles">' + rolesHtml + '</div>';
    html += '<button class="fleet-create-add-task" id="fleet-create-add-role" type="button">+ ' + __wvEscapeHtml(__i18n.fleetCreateAddRole) + '</button>';

    html += stepHeadHtml('3', __i18n.fleetCreateTasks, __i18n.fleetCreateTasksDesc);
    var tasksHtml = '';
    if (prefillTasks.length) {
      for (var ti = 0; ti < prefillTasks.length; ti++) tasksHtml += taskCardHtml(prefillTasks[ti], prefillRoleNames);
    } else {
      tasksHtml = taskCardHtml();
    }
    html += '<div class="fleet-create-tasks" id="fleet-create-tasks">' + tasksHtml + '</div>';
    html += '<button class="fleet-create-add-task" id="fleet-create-add-task" type="button">+ ' + __wvEscapeHtml(__i18n.fleetCreateAddTask) + '</button>';
    html += '<label class="fleet-create-startnow"><input type="checkbox" id="fleet-create-startnow" checked /><span>' + __wvEscapeHtml(__i18n.fleetCreateStartNow) + '</span></label>';
    html += '<div class="fleet-create-error" id="fleet-create-error"></div>';
    html += '</div>';
    html += '<div class="task-create-footer">';
    html += '<button class="detail-action-btn fleet-create-cancel" type="button">' + __wvEscapeHtml(__i18n.cancel) + '</button>';
    html += '<button class="detail-action-btn fleet-create-submit" type="button">' + __wvEscapeHtml(__i18n.fleetCreateSubmit) + '</button>';
    html += '</div>';
    html += '</div>';

    overlay.innerHTML = html;
    overlay.style.display = 'flex';

    overlay.onclick = function(e) {
      var target = e.target;
      if (target === overlay) { closeFleetCreateDialog(); return; }
      if (target.closest && target.closest('.fleet-create-close')) { e.stopPropagation(); closeFleetCreateDialog(); return; }
      if (target.closest && target.closest('.fleet-create-cancel')) { e.stopPropagation(); closeFleetCreateDialog(); return; }
      if (target.closest && target.closest('#fleet-create-add-role')) {
        e.stopPropagation();
        var rolesEl = document.getElementById('fleet-create-roles');
        var rcard = document.createElement('div');
        rcard.innerHTML = roleRowHtml();
        var rrow = rcard.firstElementChild;
        rolesEl.appendChild(rrow);
        bindRoleRow(rrow);
        return;
      }
      if (target.closest && target.closest('#fleet-create-add-task')) {
        e.stopPropagation();
        var tasksEl = document.getElementById('fleet-create-tasks');
        var card = document.createElement('div');
        card.innerHTML = taskCardHtml(null, collectRoleNames());
        var cardEl = card.firstElementChild;
        tasksEl.appendChild(cardEl);
        bindTaskCard(cardEl);
        return;
      }
      if (target.closest && target.closest('.fleet-create-submit')) { e.stopPropagation(); submitCreateForm(); return; }
    };

    var initialRoles = overlay.querySelectorAll('.fleet-create-role-row');
    for (var ri = 0; ri < initialRoles.length; ri++) bindRoleRow(initialRoles[ri]);
    var initialCards = overlay.querySelectorAll('.fleet-create-task-card');
    for (var i = 0; i < initialCards.length; i++) bindTaskCard(initialCards[i]);
    var nameInput = document.getElementById('fleet-create-name');
    if (nameInput) nameInput.focus();
    // Roster may arrive after the dialog opens; the profile pickers upgrade
    // in place when the fleetProfiles message lands.
    vscode.postMessage({ type: 'requestFleetProfiles' });
  }

  function bindRoleRow(row) {
    var nameInput = row.querySelector('.fleet-create-role-name');
    if (nameInput) nameInput.addEventListener('input', refreshRoleSelects);
    var removeBtn = row.querySelector('.fleet-create-role-remove');
    if (removeBtn) {
      removeBtn.onclick = function(e) {
        e.stopPropagation();
        row.remove();
        refreshRoleSelects();
      };
    }
  }

  function bindTaskCard(card) {
    var removeBtn = card.querySelector('.fleet-create-task-remove');
    if (removeBtn) {
      removeBtn.onclick = function(e) {
        e.stopPropagation();
        card.remove();
      };
    }
  }

  function showCreateError(message) {
    var el = document.getElementById('fleet-create-error');
    if (el) el.textContent = message || '';
  }

  function isFleetToken(value) {
    return !!value && value.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(value);
  }

  function submitCreateForm() {
    var name = document.getElementById('fleet-create-name');
    var workflow = document.getElementById('fleet-create-workflow');
    var maxWorkers = document.getElementById('fleet-create-maxworkers');

    var nameVal = name ? name.value.trim() : '';
    var workflowVal = workflow ? workflow.value.trim() : '';
    var maxWorkersVal = maxWorkers && maxWorkers.value ? parseInt(maxWorkers.value, 10) : undefined;

    if (!workflowVal) { showCreateError(__i18n.fleetCreateWorkflowId + ' is required'); return; }
    if (!isFleetToken(workflowVal)) {
      showCreateError(__i18n.fleetCreateWorkflowId + ' "' + workflowVal + '": ' + __i18n.fleetCreateTokenError);
      return;
    }

    var roles = [];
    document.querySelectorAll('.fleet-create-role-row').forEach(function(row) {
      var n = row.querySelector('.fleet-create-role-name');
      var p = row.querySelector('.fleet-create-role-profile');
      var nameVal2 = n ? n.value.trim() : '';
      if (!nameVal2) return;
      var profileVal = p ? p.value.trim() : '';
      roles.push({ name: nameVal2, agent_profile: profileVal || null });
    });
    if (roles.length === 0) { showCreateError(__i18n.fleetCreateRoles + ' is required'); return; }
    var seenRoles = {};
    for (var ri = 0; ri < roles.length; ri++) {
      if (!isFleetToken(roles[ri].name)) {
        showCreateError(__i18n.fleetCreateRoles + ' "' + roles[ri].name + '": ' + __i18n.fleetCreateTokenError);
        return;
      }
      // Within-run role names must be unique (the runtime rejects duplicates);
      // surface it inline instead of as a post-submit 400 toast.
      if (seenRoles[roles[ri].name]) {
        showCreateError(__i18n.fleetCreateRoles + ' "' + roles[ri].name + '": ' + __i18n.fleetCreateDuplicate);
        return;
      }
      seenRoles[roles[ri].name] = true;
    }

    var tasks = [];
    document.querySelectorAll('.fleet-create-task-card').forEach(function(card) {
      var id = card.querySelector('.fleet-create-task-id');
      var tname = card.querySelector('.fleet-create-task-name');
      var trole = card.querySelector('.fleet-create-task-role');
      var objective = card.querySelector('.fleet-create-task-objective');
      var instructions = card.querySelector('.fleet-create-task-instructions');
      var idVal = id ? id.value.trim() : '';
      var nameVal3 = tname ? tname.value.trim() : '';
      var roleVal = trole ? trole.value : '';
      var objVal = objective ? objective.value.trim() : '';
      var insVal = instructions ? instructions.value : '';
      if (!idVal || !nameVal3 || !roleVal || !insVal.trim()) return;
      tasks.push({ id: idVal, name: nameVal3, role: roleVal, objective: objVal || null, instructions: insVal });
    });
    if (tasks.length === 0) { showCreateError(__i18n.fleetCreateTasks + ' is required'); return; }
    var seenTaskIds = {};
    for (var ti = 0; ti < tasks.length; ti++) {
      if (!isFleetToken(tasks[ti].id)) {
        showCreateError(__i18n.fleetCreateTaskId + ' "' + tasks[ti].id + '": ' + __i18n.fleetCreateTokenError);
        return;
      }
      // Within-run task ids must be unique; ids shared with OTHER runs are
      // fine (the ledger keys tasks by run_id + task_id), so this check is
      // about the rows in this dialog only.
      if (seenTaskIds[tasks[ti].id]) {
        showCreateError(__i18n.fleetCreateTaskId + ' "' + tasks[ti].id + '": ' + __i18n.fleetCreateDuplicate);
        return;
      }
      seenTaskIds[tasks[ti].id] = true;
    }

    var startNow = document.getElementById('fleet-create-startnow');
    vscode.postMessage({
      type: 'createFleetRun',
      payload: {
        name: nameVal || undefined,
        workflow_id: workflowVal,
        max_workers: maxWorkersVal,
        roles: roles,
        tasks: tasks,
      },
      startAfterCreate: !!(startNow && startNow.checked),
    });
    closeFleetCreateDialog();
  }

  function closeFleetCreateDialog() {
    var overlay = document.getElementById('fleet-create-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.onclick = null;
    }
  }

  /** Store the roster and upgrade any free-text agent_profile inputs that
   *  are already rendered in an open create dialog. */
  function setFleetProfiles(list) {
    fleetProfiles = list || [];
    var overlay = document.getElementById('fleet-create-overlay');
    if (!overlay || overlay.style.display === 'none' || !fleetProfiles.length) return;
    var rows = overlay.querySelectorAll('.fleet-create-role-row');
    for (var i = 0; i < rows.length; i++) {
      var field = rows[i].querySelector('.fleet-create-role-profile');
      if (!field || field.tagName === 'SELECT') continue;
      var holder = document.createElement('span');
      holder.innerHTML = profileFieldHtml(field.value);
      var upgraded = holder.firstElementChild;
      if (upgraded) field.parentNode.replaceChild(upgraded, field);
    }
  }

  // ── Expose for event handler ──
  window.__wvFleet = {
    renderFleet: renderFleet,
    showFleetDetail: showFleetDetail,
    closeFleetDetail: closeFleetDetail,
    showFleetReply: showFleetReply,
    handleFleetEvent: handleFleetEvent,
    openFleetCreateDialog: openFleetCreateDialog,
    closeFleetCreateDialog: closeFleetCreateDialog,
    setFleetProfiles: setFleetProfiles,
    setFleetRuns: function(v) { fleetRuns = v; },
    getFleetRuns: function() { return fleetRuns; },
    setFleetStatus: function(v) { fleetStatus = v; },
    getFleetStatus: function() { return fleetStatus; },
    getActiveRunId: function() { return activeRunId; },
    isDetailOpen: function() { return detailOpen; },
  };
  })();`;
}
