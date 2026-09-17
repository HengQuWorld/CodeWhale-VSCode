/**
 * Webview JS Goal module — injected into the webview as an IIFE.
 * Renders the thread-scoped Goal control plane: view / set / edit /
 * complete / block / delete. Backed by the TUI `/v1/threads/{id}/goal` API.
 */
import type { WebviewTranslations } from "./webview-html";

export function getGoalScript(_tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var vscode = window.__wvVscode;

  var goal = null;
  var editing = false;
  var editorMode = 'create';
  var draftObjective = '';
  var draftBudget = '';
  var draftBackground = false;
  // Goals owned by other (background/parked) threads; pushed by the backend
  // alongside the current thread's goal so the Work panel shows them too.
  var backgroundGoals = [];
  // The objective of the last goal handed to the extension, kept so a failed
  // save can restore the draft instead of discarding what the user wrote. It is
  // cleared once a goalState confirms the goal landed.
  var submittedObjective = null;
  // What renderGoal() last drew into #work-goal. The extension pushes goalState
  // on every sidebar refresh, thread switch and turn end; rebuilding the slot
  // for an unchanged state swaps the DOM nodes under the user's cursor — a click
  // whose mousedown and mouseup straddle the rebuild is dispatched on the
  // nearest common ancestor, so the button's own handler never fires — and it
  // throws away an editor the user is typing into. Redraw only on real change.
  var renderedKey = null;

  function renderKey() {
    // Deliberately not the drafts: while an editor is open the user owns that
    // DOM, and keying on the text they are typing would make every keystroke a
    // licence to rebuild it on the next state push.
    return JSON.stringify([
      editing ? 'edit:' + editorMode : 'view',
      goal || null,
      backgroundGoals || [],
    ]);
  }

  function titleCase(status) {
    if (!status) return 'unknown';
    return String(status).replace(/_/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
  }

  function statusIcon(status) {
    if (status === 'active') return '↻';
    if (status === 'complete') return '✓';
    if (status === 'blocked') return '⛔';
    if (status === 'paused') return '⏸';
    if (status === 'usage_limited') return '⚠';
    if (status === 'budget_limited') return '⚠';
    return '●';
  }
  function statusClass(status) {
    if (status === 'active') return 'status-running';
    if (status === 'complete') return 'status-completed';
    if (status === 'blocked') return 'status-failed';
    if (status === 'paused') return 'status-muted';
    if (status === 'usage_limited' || status === 'budget_limited') return 'status-queued';
    return 'status-muted';
  }

  function formatDuration(totalSeconds) {
    var s = Number(totalSeconds || 0);
    if (s <= 0) return '0s';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString();
  }

  function shortId(id) {
    return id ? String(id).slice(0, 8) : '';
  }

  function formatTime(value) {
    if (!value) return '-';
    var date = typeof value === 'number' ? new Date(value * 1000) : new Date(String(value));
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  }

  function renderGoal(force) {
    var container = document.getElementById('work-goal');
    if (!container) return;
    var key = renderKey();
    if (!force && key === renderedKey) return;
    renderedKey = key;
    container.innerHTML = '';

    if (editing) {
      renderEditor(container);
      renderBackgroundGoals(container);
      return;
    }

    if (!goal) {
      // Compact, not a full-height empty state: this sits at the top of the Work
      // panel above the live checklist, so it must not push the work down. A
      // goal-less thread showing no goal title is also the TUI's behaviour.
      var empty = document.createElement('div');
      empty.className = 'goal-empty';
      empty.innerHTML =
        '<span class="goal-empty-text">' + __wvEscapeHtml(__i18n.goalNoGoal) + '</span>' +
        '<button class="goal-set-btn" type="button"><span class="goal-btn-icon">＋</span>' + __wvEscapeHtml(__i18n.goalSet) + '</button>';
      empty.querySelector('.goal-set-btn').onclick = function() { openEditor('create'); };
      container.appendChild(empty);
      renderBackgroundGoals(container);
      return;
    }

    var status = goal.status || 'active';
    var html = '<div class="goal-card">';
    html += '<div class="goal-header">';
    html += '<span class="goal-label">' + __wvEscapeHtml(__i18n.goal) + '</span>';
    html += '<span class="fleet-status-icon ' + statusClass(status) + '">' + statusIcon(status) + '</span>';
    html += '<span class="fleet-status-badge ' + statusClass(status) + '">' + __wvEscapeHtml(titleCase(status)) + '</span>';
    html += '</div>';
    html += '<div class="goal-objective">' + __wvEscapeHtml(goal.objective || '') + '</div>';

    // Token budget progress (used / total). The TUI treats the token budget as
    // advisory telemetry — goals run until done/blocked/paused, not until the
    // budget is consumed — so an exceeded budget is surfaced as "over budget"
    // instead of a misleading 100% complete.
    if (goal.token_budget && goal.token_budget > 0) {
      var overBudget = goal.tokens_used > goal.token_budget;
      var pct = Math.min(100, Math.round((goal.tokens_used / goal.token_budget) * 100));
      var pctClass = overBudget ? 'over-budget' : (pct >= 100 ? 'completed' : pct >= 60 ? 'in-progress' : 'partial');
      var budgetSuffix = overBudget ? (' (' + __wvEscapeHtml(__i18n.goalBudgetExceeded) + ')') : (' (' + pct + '%)');
      html += '<div class="goal-budget-row" title="' + __wvEscapeHtml(__i18n.goalBudgetTooltip) + '">' +
        '<span class="goal-budget-label">🎯 ' + __wvEscapeHtml(__i18n.goalBudget) + '</span>' +
        '<span class="goal-budget-value' + (overBudget ? ' goal-budget-over' : '') + '">' + formatNumber(goal.tokens_used) + ' / ' + formatNumber(goal.token_budget) + budgetSuffix + '</span></div>';
      html += '<div class="work-progress-bar-bg"><div class="work-progress-bar-fill ' + pctClass + '" data-goal-pct="' + pct + '"></div></div>';
    }

    html += '<div class="goal-stats">';
    html += '<div class="goal-stat" title="' + __wvEscapeHtml(__i18n.goalTokensUsedTooltip) + '"><span class="goal-stat-label">🪙 ' + __wvEscapeHtml(__i18n.goalTokensUsed) + '</span><span class="goal-stat-value">' + formatNumber(goal.tokens_used) + '</span></div>';
    html += '<div class="goal-stat" title="' + __wvEscapeHtml(__i18n.goalTimeUsedTooltip) + '"><span class="goal-stat-label">⏱ ' + __wvEscapeHtml(__i18n.goalTimeUsed) + '</span><span class="goal-stat-value">' + __wvEscapeHtml(formatDuration(goal.time_used_seconds)) + '</span></div>';
    html += '<div class="goal-stat" title="' + __wvEscapeHtml(__i18n.goalContinuationsTooltip) + '"><span class="goal-stat-label">🔁 ' + __wvEscapeHtml(__i18n.goalContinuations) + '</span><span class="goal-stat-value">' + formatNumber(goal.continuation_count) + '</span></div>';
    html += '</div>';

    html += '<div class="goal-meta">📅 ' + __wvEscapeHtml(__i18n.goalCreatedAt) + ': ' + __wvEscapeHtml(formatTime(goal.created_at)) + '</div>';
    if (goal.thread_id) {
      html += '<div class="goal-meta goal-thread-meta" title="' + __wvEscapeHtml(goal.thread_id) + '">' + __wvEscapeHtml(__i18n.threads) + ': ' + __wvEscapeHtml(shortId(goal.thread_id)) + '</div>';
    }

    html += '<div class="goal-actions">';
    if (goal.thread_id) {
      html += '<button class="goal-action-btn" data-goal-action="open-thread"><span class="goal-btn-icon">🔗</span>' + __wvEscapeHtml(__i18n.taskOpenThread) + '</button>';
    }
    if (status === 'active') {
      // A Runtime restart leaves an Active goal parked (no startup sweep);
      // Resume re-PUTs the goal as the explicit re-arm trigger.
      html += '<button class="goal-action-btn" data-goal-action="resume" title="' + __wvEscapeHtml(__i18n.goalResume) + '"><span class="goal-btn-icon">▶</span>' + __wvEscapeHtml(__i18n.goalResume) + '</button>';
    }
    html += '<button class="goal-action-btn" data-goal-action="edit"><span class="goal-btn-icon">✏️</span>' + __wvEscapeHtml(__i18n.goalEdit) + '</button>';
    if (status === 'complete') {
      html += '<button class="goal-action-btn primary" data-goal-action="new"><span class="goal-btn-icon">＋</span>' + __wvEscapeHtml(__i18n.goalSet) + '</button>';
    } else {
      html += '<button class="goal-action-btn" data-goal-action="complete"><span class="goal-btn-icon">✅</span>' + __wvEscapeHtml(__i18n.goalComplete) + '</button>';
    }
    if (status !== 'blocked' && status !== 'complete') {
      html += '<button class="goal-action-btn" data-goal-action="block"><span class="goal-btn-icon">⛔</span>' + __wvEscapeHtml(__i18n.goalBlock) + '</button>';
    }
    html += '<button class="goal-action-btn danger" data-goal-action="delete"><span class="goal-btn-icon">🗑️</span>' + __wvEscapeHtml(__i18n.goalDelete) + '</button>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;
    var bar = container.querySelector('.work-progress-bar-fill[data-goal-pct]');
    if (bar) bar.style.width = bar.getAttribute('data-goal-pct') + '%';

    container.querySelectorAll('.goal-action-btn').forEach(function(btn) {
      btn.onclick = function() {
        var action = btn.getAttribute('data-goal-action');
        if (action === 'edit') openEditor('edit');
        else if (action === 'new') openEditor('create');
        else if (action === 'open-thread') vscode.postMessage({ type: 'loadThread', threadId: goal.thread_id });
        else if (action === 'resume') vscode.postMessage({ type: 'resumeGoal' });
        else if (action === 'complete') vscode.postMessage({ type: 'completeGoal' });
        else if (action === 'block') vscode.postMessage({ type: 'blockGoal' });
        else if (action === 'delete') vscode.postMessage({ type: 'deleteGoal' });
      };
    });

    renderBackgroundGoals(container);
  }

  // ── Background goal cards ──
  // Rendered below the current thread's goal so the Work panel also surfaces
  // goals running on other threads. Open Thread parks this thread and switches
  // (the same message the thread rail uses).
  function renderBackgroundGoals(container) {
    if (!backgroundGoals || backgroundGoals.length === 0) return;
    var html = '<div class="goal-bg-section">';
    html += '<div class="goal-bg-header">' + __wvEscapeHtml(__i18n.goalBackgroundSection) + '</div>';
    for (var i = 0; i < backgroundGoals.length; i++) {
      var bg = backgroundGoals[i];
      var st = bg.status || 'active';
      // Server payloads name it thread_id; the backend cache re-tags it as
      // threadId when re-broadcasting — accept either.
      var tid = bg.thread_id || bg.threadId;
      html += '<div class="goal-bg-card">';
      html += '<div class="goal-bg-top">';
      html += '<span class="fleet-status-icon ' + statusClass(st) + '">' + statusIcon(st) + '</span>';
      html += '<span class="fleet-status-badge ' + statusClass(st) + '">' + __wvEscapeHtml(titleCase(st)) + '</span>';
      if (tid) {
        html += '<span class="goal-bg-thread" title="' + __wvEscapeHtml(tid) + '">' + __wvEscapeHtml(shortId(tid)) + '</span>';
      }
      html += '</div>';
      html += '<div class="goal-bg-objective">' + __wvEscapeHtml(bg.objective || '') + '</div>';
      html += '<div class="goal-bg-meta">';
      if (bg.token_budget && bg.token_budget > 0) {
        html += '<span>🪙 ' + formatNumber(bg.tokens_used) + ' / ' + formatNumber(bg.token_budget) + '</span>';
      } else if (bg.tokens_used) {
        html += '<span>🪙 ' + formatNumber(bg.tokens_used) + '</span>';
      }
      html += '<span>⏱ ' + __wvEscapeHtml(formatDuration(bg.time_used_seconds)) + '</span>';
      html += '</div>';
      if (tid) {
        html += '<div class="goal-bg-actions">';
        html += '<button class="goal-action-btn" data-bg-action="open" data-bg-index="' + i + '"><span class="goal-btn-icon">🔗</span>' + __wvEscapeHtml(__i18n.taskOpenThread) + '</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    container.insertAdjacentHTML('beforeend', html);
    container.querySelectorAll('.goal-action-btn[data-bg-action]').forEach(function(btn) {
      btn.onclick = function() {
        var bg = backgroundGoals[parseInt(btn.getAttribute('data-bg-index'), 10)];
        var tid = bg && (bg.thread_id || bg.threadId);
        if (tid && btn.getAttribute('data-bg-action') === 'open') {
          vscode.postMessage({ type: 'loadThread', threadId: tid });
        }
      };
    });
  }

  function renderEditor(container) {
    var isEdit = editorMode === 'edit';
    var html = '<div class="goal-editor">';
    html += '<div class="goal-editor-title">' + __wvEscapeHtml(isEdit ? __i18n.goalEdit : __i18n.goalSet) + '</div>';
    html += '<textarea class="goal-editor-textarea" placeholder="' + __wvEscapeHtml(__i18n.goalObjectivePlaceholder) + '">' + __wvEscapeHtml(draftObjective) + '</textarea>';
    html += '<div class="goal-editor-budget"><label>' + __wvEscapeHtml(__i18n.goalTokenBudgetLabel) + '</label><input class="goal-editor-input" type="number" min="0" placeholder="0" value="' + __wvEscapeHtml(draftBudget) + '" /></div>';
    if (!isEdit) {
      // Only offered on create: a background goal spins up a NEW thread
      // (inheriting model/mode), so it is not a switch for an existing goal.
      html += '<div class="goal-editor-bg">';
      html += '<label class="goal-editor-bg-label"><input class="goal-editor-bg-check" type="checkbox"' + (draftBackground ? ' checked' : '') + ' /><span>' + __wvEscapeHtml(__i18n.goalBackgroundRun) + '</span></label>';
      html += '<div class="goal-editor-bg-hint">' + __wvEscapeHtml(__i18n.goalBackgroundHint) + '</div>';
      html += '</div>';
    }
    var canSave = String(draftObjective || '').trim() !== '';
    html += '<div class="goal-editor-actions">';
    html += '<button class="goal-action-btn" data-goal-editor-action="cancel"><span class="goal-btn-icon">✕</span>' + __wvEscapeHtml(__i18n.cancel) + '</button>';
    // Saving an empty objective used to end in a silent early return.
    // Keep the button disabled (and dimmed inline, so the module needs no CSS
    // entry) until there is something to save.
    html += '<button class="goal-action-btn primary" data-goal-editor-action="save"' + (canSave ? '' : ' disabled style="opacity:0.5;cursor:not-allowed;"') + '><span class="goal-btn-icon">✓</span>' + __wvEscapeHtml(isEdit ? __i18n.goalEdit : __i18n.goalSet) + '</button>';
    html += '</div>';
    html += '</div>';
    container.innerHTML = html;

    var textarea = container.querySelector('.goal-editor-textarea');
    var input = container.querySelector('.goal-editor-input');
    var saveBtn = container.querySelector('.goal-action-btn[data-goal-editor-action="save"]');

    function syncSaveEnabled() {
      if (!saveBtn) return;
      var hasObjective = String(draftObjective || '').trim() !== '';
      saveBtn.disabled = !hasObjective;
      saveBtn.style.opacity = hasObjective ? '' : '0.5';
      saveBtn.style.cursor = hasObjective ? '' : 'not-allowed';
    }

    if (textarea) {
      textarea.focus();
      textarea.addEventListener('input', function() {
        draftObjective = textarea.value;
        textarea.style.borderColor = '';
        syncSaveEnabled();
      });
      textarea.addEventListener('keydown', function(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
    }
    if (input) {
      input.addEventListener('input', function() { draftBudget = input.value; });
    }

    function submit() {
      var objective = String(draftObjective || '').trim();
      if (!objective) {
        // Cmd/Ctrl+Enter is the only way left to reach an empty submit (the
        // button is disabled); land the gesture on the field that needs it.
        if (textarea) {
          textarea.focus();
          textarea.style.borderColor = '#e05555';
        }
        return;
      }
      var tokenBudget = undefined;
      var rawBudget = String(draftBudget || '').trim();
      if (rawBudget !== '') {
        var parsed = parseInt(rawBudget, 10);
        if (!isNaN(parsed)) tokenBudget = parsed;
      }
      var bgCheck = container.querySelector('.goal-editor-bg-check');
      submittedObjective = objective;
      vscode.postMessage({ type: 'setGoal', objective: objective, tokenBudget: tokenBudget, background: !!(bgCheck && bgCheck.checked) });
      // Close the editor here rather than leaving it mounted: the old code only
      // flipped editing and never redrew, so a dropped setGoal froze the
      // editor on screen — indistinguishable from a dead button. The slot now
      // shows the pending state, and the extension always answers (goalState,
      // or an error banner).
      editing = false;
      renderGoal();
    }
    function cancel() {
      draftObjective = '';
      draftBudget = '';
      draftBackground = false;
      submittedObjective = null;
      editing = false;
      renderGoal();
    }
    container.querySelectorAll('.goal-action-btn[data-goal-editor-action]').forEach(function(btn) {
      btn.onclick = function() {
        var action = btn.getAttribute('data-goal-editor-action');
        if (action === 'save') submit();
        else if (action === 'cancel') cancel();
      };
    });
  }

  function openEditor(mode) {
    editorMode = mode === 'edit' ? 'edit' : 'create';
    editing = true;
    // The previous submission is either already answered or superseded; the
    // draft, though, is kept so a failed save can be reopened and retried.
    submittedObjective = null;
    // Create-mode keeps whatever draft survived a failed save; Cancel is the
    // explicit way to throw a draft away (edit-mode always re-seeds from goal).
    draftObjective = (editorMode === 'edit' && goal) ? goal.objective : draftObjective;
    draftBudget = (editorMode === 'edit' && goal && goal.token_budget) ? String(goal.token_budget) : draftBudget;
    draftBackground = false;
    renderGoal();
  }

  // ── State intake ──
  // The extension pushes goalState for the current thread plus every active
  // background goal. Adopting it must not disturb an editor the user has open:
  // the push is usually unrelated (a sidebar refresh, a turn ending) and a
  // redraw would wipe the draft and swap the button out from under the pointer.
  // A genuine view change is the exception, and it does not come through here:
  // the event handler resets the slot on clearChat / threadLoaded /
  // sessionLoaded, so the editor cannot outlive the thread it was opened on.
  // renderGoal() itself decides whether a redraw is needed.
  function applyState(nextGoal, nextBackgroundGoals) {
    goal = nextGoal || null;
    backgroundGoals = Array.isArray(nextBackgroundGoals) ? nextBackgroundGoals : [];
    if (
      !editing &&
      goal &&
      submittedObjective !== null &&
      String(goal.objective || '').trim() === submittedObjective
    ) {
      // The extension answered with the goal we asked for: the save landed, so
      // the draft is no longer a recovery copy.
      submittedObjective = null;
      draftObjective = '';
      draftBudget = '';
      draftBackground = false;
    }
    if (editing) {
      // Never redraw over an open editor. The data above is already current, so
      // the slot draws the fresh state the moment the editor closes.
      return;
    }
    renderGoal();
  }

  /** Drop the whole control plane (new thread / loaded session / cleared view).
   *  A fresh view must not inherit the previous conversation's goal, its
   *  background list, or a half-written draft. */
  function reset() {
    goal = null;
    backgroundGoals = [];
    editing = false;
    editorMode = 'create';
    draftObjective = '';
    draftBudget = '';
    draftBackground = false;
    submittedObjective = null;
    renderGoal(true);
  }

  // ── Expose for event handler ──
  // applyState is the only way in: a caller that could assign goal / editing
  // directly would be free to rebuild the slot over an open editor, which is
  // exactly the regression these two entry points exist to prevent.
  window.__wvGoal = {
    renderGoal: renderGoal,
    applyState: applyState,
    reset: reset,
  };
  })();`;
}
