/**
 * Webview JS event handler module — injected into the webview as an IIFE.
 * Handles the window 'message' event listener with the main switch statement.
 */
import type { WebviewTranslations } from "./webview-html";
import { MODE_LABELS, POSTURE_LABELS } from "../utils/modes";
import { PROVIDER_PICKER_JS } from "../utils/provider-route";

export function getEventHandlerScript(tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __cwProviderText = {
    needsLogin: ${JSON.stringify(tr.providerNeedsLogin)},
    noKey: ${JSON.stringify(tr.providerNoKey)}
  };
${PROVIDER_PICKER_JS}
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var __wvFormatLoadedThread = window.__wvFormatLoadedThread;
  var vscode = window.__wvVscode;
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var statusTextEl = document.getElementById('status-text');
  var statusStatsEl = document.getElementById('status-stats');
  var currentModeEl = document.getElementById('current-mode');
  var currentPostureEl = document.getElementById('current-posture');
  var currentModelEl = document.getElementById('current-model');
  var currentReasoningEl = document.getElementById('current-reasoning');
  var currentProviderEl = document.getElementById('current-provider');
  var dropdownProviderEl = document.getElementById('dropdown-provider');
  var dropdownModelEl = document.getElementById('dropdown-model');
  var _diffStore = window.__wvDiffStore;
  var _diffIdCounter = window.__wvDiffIdCounter;

  var apiCapabilities = window.__wvApiCapabilities || {};
  var runtimeVersion = '';
  var sessionStats = null;
  // Startup defaults for new threads, seeded by the backend's scopedDefaults
  // message. They are process-scoped, so they never ride settingsUpdated
  // (which describes the active thread) — the mode/permission dropdowns show
  // both scopes and each group is marked against its own source.
  var scopedDefaults = { mode: '', posture: '' };

  var approvalFloatEl = document.getElementById('approval-float');

  function showApprovalFloat(approvalId, summaryText, rawToolName, toolInput) {
    if (!approvalFloatEl || !approvalId) return;
    if (approvalFloatEl.querySelector('.approval-item[data-approval-id="' + approvalId + '"]')) return;
    approvalFloatEl.removeAttribute('hidden');
    if (!approvalFloatEl.querySelector('.approval-float-header')) {
      var header = document.createElement('div');
      header.className = 'approval-float-header';
      header.textContent = '\\u26A0 ' + __i18n.approvalRequired;
      approvalFloatEl.insertBefore(header, approvalFloatEl.firstChild);
    }
    var inputHtml = '';
    if (window.__wvMessages && window.__wvMessages.renderToolInput) {
      inputHtml = window.__wvMessages.renderToolInput({ name: rawToolName || '', input: toolInput || {} });
    }
    var item = document.createElement('div');
    item.className = 'approval-item';
    item.setAttribute('data-approval-id', approvalId);
    item.innerHTML =
      '<div class="approval-text">\\u26A0 ' + summaryText + '</div>' +
      inputHtml +
      '<label class="approval-remember"><input type="checkbox" data-approval-id="' + approvalId + '" class="remember-check" /> ' + __wvEscapeHtml(__i18n.approvalRemember) + '</label>' +
      '<div class="approval-buttons"><button class="btn-allow" data-approval-id="' + approvalId + '" data-decision="allow">' + __i18n.allow + '</button><button class="btn-deny" data-approval-id="' + approvalId + '" data-decision="deny">' + __i18n.deny + '</button></div>';
    approvalFloatEl.appendChild(item);
    // More than one approval can be outstanding and the newest is the one the
    // user has to see, so keep the panel scrolled to it.
    approvalFloatEl.scrollTop = approvalFloatEl.scrollHeight;
  }

  /**
   * Retire exactly one answered approval. Approvals are keyed by id in the
   * provider's pending map and several can be outstanding at once (a turn with
   * two tool calls, a parked thread's approval), so clearing the whole panel
   * here would leave the others pending with nothing left to click.
   */
  function removeApprovalItem(approvalId) {
    // A blank id is not an instruction to wipe the panel — that is what the
    // explicit clear() is for; this is the exported contract, so it must not
    // re-create the cleared-others bug for a future caller.
    if (!approvalFloatEl || !approvalId) return;
    var item = approvalFloatEl.querySelector('.approval-item[data-approval-id="' + approvalId + '"]');
    if (item) item.remove();
    if (!approvalFloatEl.querySelector('.approval-item')) hideApprovalFloat();
  }

  function hideApprovalFloat() {
    if (!approvalFloatEl) return;
    approvalFloatEl.innerHTML = '';
    approvalFloatEl.setAttribute('hidden', '');
  }

  // The panel is the only place an approval can be answered, so the message
  // renderer re-shows every approval that is still pending after it rebuilds a
  // conversation (view switch, reopened sidebar, restored session) — buttons
  // must not vanish just because the DOM was redrawn.
  window.__wvApproval = {
    show: showApprovalFloat,
    remove: removeApprovalItem,
    clear: hideApprovalFloat,
  };

  // Mode / permission-posture display maps, mirroring the TUI's
  // AppMode::display_name() and ApprovalMode::permission_chip_label().
  var __wvModeLabels = ${JSON.stringify(MODE_LABELS)};
  var __wvPostureLabels = ${JSON.stringify(POSTURE_LABELS)};

  function modeDisplay(value) {
    var key = String(value || '').trim().toLowerCase();
    return __wvModeLabels[key] || value || '';
  }

  function postureDisplay(value) {
    var key = String(value || '').trim().toLowerCase();
    return __wvPostureLabels[key] || value || '';
  }

  function applyModeDisplay(value) {
    if (!currentModeEl) return;
    var key = String(value || '').trim().toLowerCase();
    currentModeEl.setAttribute('data-value', key || 'agent');
    currentModeEl.textContent = modeDisplay(key || 'agent');
  }

  function applyPostureDisplay(value) {
    if (!currentPostureEl) return;
    var key = String(value || '').trim().toLowerCase();
    currentPostureEl.setAttribute('data-value', key || 'ask');
    currentPostureEl.textContent = postureDisplay(key || 'ask');
  }

  // ── Streaming state helpers ──
  var statusBarEl = document.getElementById('status');

  function setStreamingState(streaming, label) {
    if (statusBarEl) {
      if (streaming) {
        statusBarEl.classList.add('is-streaming');
      } else {
        statusBarEl.classList.remove('is-streaming');
      }
    }
    if (statusTextEl) {
      statusTextEl.textContent = label || (streaming ? __i18n.thinking : __i18n.ready);
    }
    // The button follows the turn, not the caller. This is also called by
    // messages that only paint the status line — 'ready' and
    // 'settingsUpdated' arrive right after a thread is loaded, when a turn may
    // still be running and adopted — and a button that trusted the argument
    // would offer Send for a live turn, or (with the flag armed) label itself
    // Stop while the click, which reads the flag, sent a new prompt instead.
    // The streaming flag is the same state Enter routes on, so the button and
    // the composer always agree: Stop exactly while the key steers.
    if (window.__wvInput && window.__wvInput.updateSendStopButton) {
      var live = !!(window.__wvMessages && window.__wvMessages.isStreaming());
      window.__wvInput.updateSendStopButton(live);
    }
  }

  // Informational engine prose ("<kind> started", "Turn: in_progress",
  // "Loaded N turns") arrives interleaved with stream deltas and says nothing
  // about whether the turn is still running. It may only repaint the
  // status-bar text: routing it through setStreamingState() cleared the
  // streaming flag on every one of those messages, so the send/stop button
  // flickered between send and stop throughout a turn.
  function setStatusText(text) {
    if (statusTextEl) statusTextEl.textContent = text;
  }

  /** Bound how long the view waits for a turn it has armed to say something.
   *
   *  Every place that arms the streaming state calls this, so an armed state
   *  always carries the same give-up deadline: a turn whose engine died, or
   *  one the runtime still describes as running after the client lost its
   *  stream, releases the composer instead of holding it as Stop/steer
   *  forever. Re-arming restarts the deadline, which is what the streaming
   *  placeholder is for — a turn nobody can be steered into is worse than one
   *  the next prompt starts fresh.
   */
  function armStallTimeout() {
    var st = window.__wvMessages.getStreamingTimeout();
    if (st) clearTimeout(st);
    window.__wvMessages.setStreamingTimeout(setTimeout(function() {
      if (window.__wvMessages.isStreaming()) {
        window.__wvMessages.setStreaming(false);
        setStreamingState(false, __i18n.readyTimedOut);
      }
    }, 300000));
  }

  function showThinkingActivity(messageId, label) {
    var bodyEl = document.getElementById('body-' + messageId);
    if (!bodyEl) return;
    var existing = bodyEl.querySelector('.thinking-activity');
    if (existing) {
      var labelEl = existing.querySelector('.thinking-activity-label');
      if (labelEl) labelEl.textContent = label || __i18n.thinking;
      return;
    }
    var indicator = document.createElement('div');
    indicator.className = 'thinking-activity';
    indicator.innerHTML = '<div class="thinking-activity-dots"><span></span><span></span><span></span></div><span class="thinking-activity-label">' + __wvEscapeHtml(label || __i18n.thinking) + '</span>';
    bodyEl.insertBefore(indicator, bodyEl.firstChild);
  }

  function updateThinkingActivityLabel(messageId, label) {
    var bodyEl = document.getElementById('body-' + messageId);
    if (!bodyEl) return;
    var indicator = bodyEl.querySelector('.thinking-activity');
    if (indicator) {
      var labelEl = indicator.querySelector('.thinking-activity-label');
      if (labelEl) labelEl.textContent = label || __i18n.thinking;
    }
  }

  function hideThinkingActivity(messageId) {
    var bodyEl = document.getElementById('body-' + messageId);
    if (!bodyEl) return;
    var indicator = bodyEl.querySelector('.thinking-activity');
    if (indicator) indicator.remove();
  }

  function renderStatusStats() {
    if (!statusStatsEl) return;
    var statsHtml = '';
    if (runtimeVersion) {
      statsHtml += '<span class="stat-chip">TUI ' + __wvEscapeHtml(runtimeVersion) + '</span>';
    }
    if (sessionStats && sessionStats.cost) {
      statsHtml += '<span class="stat-chip cost">' + __wvEscapeHtml(sessionStats.cost) + '</span>';
    }
    if (sessionStats && sessionStats.cacheHitRate !== undefined) {
      var rate = parseFloat(sessionStats.cacheHitRate);
      var cacheClass = 'cache-neutral';
      if (rate > 80) cacheClass = 'cache-good';
      else if (rate >= 40) cacheClass = 'cache-warn';
      else if (rate > 0) cacheClass = 'cache-bad';
      statsHtml += '<span class="stat-chip ' + cacheClass + '">Cache: ' + sessionStats.cacheHitRate + '%</span>';
    }
    if (sessionStats && (sessionStats.totalInputTokens || sessionStats.totalOutputTokens)) {
      statsHtml += '<span class="stat-chip tokens">\\u2191' + Number(sessionStats.totalInputTokens || 0).toLocaleString() + ' \\u2193' + Number(sessionStats.totalOutputTokens || 0).toLocaleString() + '</span>';
    } else if (sessionStats && sessionStats.totalTokens) {
      // Session view mode: the persisted session records only a grand
      // token total (no input/output split), so render a sum chip instead
      // of hiding all token information.
      statsHtml += '<span class="stat-chip tokens">\\u03a3' + Number(sessionStats.totalTokens).toLocaleString() + '</span>';
    }
    statusStatsEl.innerHTML = statsHtml;
  }

  // ── Provider / model dropdown renderers ──
  // These rebuild the dropdown items from data pushed by the backend so the
  // picker reflects the live provider registry instead of the hard-coded
  // deepseek-only list baked into the HTML.

  // The provider list + active ids last pushed by the backend. The dropdown,
  // the chip and the stale-response guard all read the same source, so a label
  // can never describe a different route than the one that is selected.
  var lastProviders = [];
  var lastProvider = '';
  var lastProviderId = '';
  // The route whatever is on screen runs on — the open conversation's, or a
  // viewed session's — pushed alongside the picker's.
  var lastViewProvider = '';
  var lastViewProviderId = '';

  // Two user-defined routes report the same generic id ('custom') and differ
  // only by 'model_provider_id', so an entry is the selected one only when
  // both match. An engine that does not report 'current_provider_id' predates
  // named routes entirely — fall back to the id so nothing regresses there.
  function providerEntryIsActive(p, currentId, currentExactId, exactKnown) {
    if (p.id !== currentId) return false;
    if (!exactKnown) return true;
    return (p.model_provider_id || '') === (currentExactId || '');
  }

  /** Whether what is on screen runs on a different route than the picker's.
   *
   *  A conversation keeps the provider it was created on and a viewed session
   *  carries its own, so once the picker has moved on, "where will my next
   *  message go" and "what did I just switch to" are different routes. The
   *  chip and the model list answer the first question; the dropdown still
   *  marks the second. */
  function threadRouteDiffers() {
    if (!lastViewProvider) return false;
    if (lastViewProvider !== (lastProvider || '')) return true;
    return (lastViewProviderId || '') !== (lastProviderId || '');
  }

  /** The provider pair the model list must be requested for: the one on screen
   *  when there is something, otherwise the picker's. */
  function modelListRoute() {
    if (lastViewProvider) {
      return { provider: lastViewProvider, providerId: lastViewProviderId || '' };
    }
    return { provider: lastProvider || '', providerId: lastProviderId || '' };
  }

  /** Paint the chip from the cached catalog — one place decides the label, so
   *  the chip, the dropdown's mark and the model guard cannot disagree. */
  function applyProviderLabel() {
    if (!currentProviderEl) return;
    var route = modelListRoute();
    // The chip carries the route the model list is fetched for, so the answer's
    // own guard (chip route vs answer route) compares like with like.
    currentProviderEl.setAttribute('data-provider-id', route.provider || '');
    currentProviderEl.setAttribute('data-model-provider-id', route.providerId || '');
    var entry = providerEntryFor(route.provider, route.providerId);
    var label = entry
      ? __cwProviderLabel(entry, lastProviders, __cwProviderText)
      : (route.providerId || route.provider || '');
    if (threadRouteDiffers()) label = label + ' · ' + __i18n.threadRouteMarker;
    currentProviderEl.textContent = label;
  }

  /** The catalog entry for a route, by the same pair the picker matches on. */
  function providerEntryFor(providerId, exactId) {
    if (!providerId) return null;
    var exactKnown = !!exactId;
    for (var i = 0; i < lastProviders.length; i++) {
      if (providerEntryIsActive(lastProviders[i], providerId, exactId, exactKnown)) {
        return lastProviders[i];
      }
    }
    return null;
  }

  function renderProviderDropdown(providers, currentId, currentExactId, viewProvider, viewProviderId) {
    if (!dropdownProviderEl) return;
    lastProviders = providers;
    lastProvider = currentId || '';
    lastProviderId = currentExactId || '';
    lastViewProvider = viewProvider || '';
    lastViewProviderId = viewProviderId || '';
    var exactKnown = !!lastProviderId;
    dropdownProviderEl.innerHTML = '';
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var isActive = providerEntryIsActive(p, currentId, currentExactId, exactKnown);
      // A route with no key configured is not a choice — it only spends the
      // user's first message to explain itself, and the two DeepSeek routes
      // proved how expensive that is. The route that is already active stays
      // listed whatever its state, or the chip would name a row the picker
      // cannot show.
      if (!__cwProviderVisible(p, isActive)) continue;
      var item = document.createElement('div');
      item.className = 'dropdown-item';
      item.setAttribute('data-value', p.id);
      // The exact configured id is what names one route when several share the
      // generic kind; the switch request carries both.
      item.setAttribute('data-model-provider-id', p.model_provider_id || '');
      // Route id appended whenever two rows share a display name (both DeepSeek
      // routes are called "DeepSeek"), plus the credential state when the route
      // is not ready.
      var label = __cwProviderLabel(p, providers, __cwProviderText);
      if (isActive) {
        label = label + ' \\u2713';
      }
      item.textContent = label;
      dropdownProviderEl.appendChild(item);
    }
    applyProviderLabel();
  }

  function renderModelDropdown(models, currentModel) {
    if (!dropdownModelEl) return;
    dropdownModelEl.innerHTML = '';
    for (var i = 0; i < models.length; i++) {
      var id = models[i];
      var item = document.createElement('div');
      item.className = 'dropdown-item';
      item.setAttribute('data-value', id);
      item.textContent = id === currentModel ? id + ' \\u2713' : id;
      dropdownModelEl.appendChild(item);
    }
  }

  // ── Tell extension we're ready ──
  vscode.postMessage({ type: 'webviewReady' });

  // ── Settings dropdown handlers ──
  (function(){
    var settingBars = ['settings-bar', 'toolbar']
      .map(function(id){ return document.getElementById(id); })
      .filter(Boolean);
    if (!settingBars.length) return;

    function closeAllDropdowns() {
      for (var i = 0; i < settingBars.length; i++) {
        var menus = settingBars[i].querySelectorAll('.dropdown-menu');
        for (var j = 0; j < menus.length; j++) { menus[j].classList.remove('open'); }
      }
    }

    function highlightCurrent(dropdown) {
      var wrapper = dropdown.parentElement;
      var valueEl = wrapper.querySelector('.setting-value');
      // Prefer the canonical data-value (mode/posture show friendly labels);
      // fall back to the visible text for dropdowns whose value is its label.
      var currentVal = valueEl
        ? (valueEl.getAttribute('data-value') || valueEl.textContent).trim()
        : '';
      var setting = wrapper.getAttribute('data-setting');
      var items = dropdown.querySelectorAll('.dropdown-item');
      for (var i = 0; i < items.length; i++) {
        // A dropdown holds the same roster twice, scoped: the top group is this
        // thread's value, the bottom one the startup default. Each group is
        // compared against its own source, so the two marks can differ without
        // either of them lying.
        var scope = items[i].getAttribute('data-scope') || 'thread';
        var expected = scope === 'default' ? (scopedDefaults[setting] || '') : currentVal;
        items[i].classList.toggle(
          'selected',
          !!expected && items[i].getAttribute('data-value') === expected,
        );
      }
    }

    function onClick(e) {
      var target = e.target;

      // Toggle dropdown on setting-value click
      if (target.classList.contains('setting-value')) {
        var dropdown = target.parentElement.querySelector('.dropdown-menu');
        if (!dropdown) return;
        var isOpen = dropdown.classList.contains('open');
        closeAllDropdowns();
        if (!isOpen) {
          highlightCurrent(dropdown);
          dropdown.classList.add('open');
        }
        e.stopPropagation();
        return;
      }

      // Select item from dropdown
      if (target.classList.contains('dropdown-item')) {
        var val = target.getAttribute('data-value');
        var exactVal = target.getAttribute('data-model-provider-id') || '';
        var dd = target.parentElement;
        var setting = dd.parentElement.getAttribute('data-setting');
        closeAllDropdowns();
        if (val && setting) {
          var scope = target.getAttribute('data-scope') || 'thread';
          if (scope === 'default' && (setting === 'mode' || setting === 'posture')) {
            // The lower group sets the startup default only. The active thread
            // keeps its own value, so nothing here patches it — that is the
            // whole point of splitting the two scopes apart.
            vscode.postMessage(setting === 'mode'
              ? { type: 'setDefaultMode', mode: val }
              : { type: 'setDefaultPosture', posture: val });
          } else if (setting === 'mode') {
            vscode.postMessage({ type: 'slashCommand', command: '/mode', args: val });
          } else if (setting === 'posture') {
            vscode.postMessage({ type: 'setPosture', posture: val });
          } else if (setting === 'model') {
            vscode.postMessage({ type: 'slashCommand', command: '/model', args: val });
          } else if (setting === 'reasoning') {
            vscode.postMessage({ type: 'slashCommand', command: '/reasoning', args: val });
          } else if (setting === 'provider') {
            // Switching provider triggers a runtime reload. The model list
            // will be re-rendered when the backend pushes providerModels.
            // A named custom route is named by its exact configured id; the
            // generic kind alone would be ambiguous between two of them.
            vscode.postMessage({
              type: 'switchProvider',
              provider: val,
              providerId: exactVal || undefined,
            });
          }
        }
      }
    }

    for (var k = 0; k < settingBars.length; k++) {
      settingBars[k].addEventListener('click', onClick);
    }
  })();

  // Close dropdowns when clicking elsewhere
  document.addEventListener('click', function() {
    var containers = ['settings-bar', 'toolbar'];
    for (var c = 0; c < containers.length; c++) {
      var bar = document.getElementById(containers[c]);
      if (!bar) continue;
      var menus = bar.querySelectorAll('.dropdown-menu');
      for (var i = 0; i < menus.length; i++) { menus[i].classList.remove('open'); }
    }
  });

  // ── Keyboard shortcuts for global navigation ──
  document.addEventListener('keydown', function(e) {
    // Ctrl+Up / Ctrl+Down: jump between user messages
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') {
      e.preventDefault();
      if (window.__wvMessages && window.__wvMessages.jumpToUserMessage) {
        window.__wvMessages.jumpToUserMessage('prev');
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown') {
      e.preventDefault();
      if (window.__wvMessages && window.__wvMessages.jumpToUserMessage) {
        window.__wvMessages.jumpToUserMessage('next');
      }
    }
  });

  // ── Main message handler ──
  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'ready':
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        if (window.__wvFleet) window.__wvFleet.closeFleetDetail();
        setStreamingState(false, '${tr.ready} (' + (msg.model || 'deepseek-v4-pro') + ')');
        if (msg.mode) applyModeDisplay(msg.mode);
        if (msg.posture) applyPostureDisplay(msg.posture);
        if (msg.model) currentModelEl.textContent = msg.model;
        if (msg.reasoningEffort) currentReasoningEl.textContent = msg.reasoningEffort;
        if (msg.provider) {
          lastProvider = msg.provider;
          lastProviderId = msg.providerId || '';
          applyProviderLabel();
        }
        runtimeVersion = msg.runtimeVersion || runtimeVersion || '';
        renderStatusStats();
        break;

      case 'settingsUpdated':
        if (msg.model) {
          setStreamingState(false, '${tr.ready} (' + msg.model + ')');
        }
        if (msg.mode) applyModeDisplay(msg.mode);
        if (msg.posture) applyPostureDisplay(msg.posture);
        if (msg.model) currentModelEl.textContent = msg.model;
        if (msg.reasoningEffort) currentReasoningEl.textContent = msg.reasoningEffort;
        if (msg.provider) {
          lastProvider = msg.provider;
          lastProviderId = msg.providerId || '';
          applyProviderLabel();
        }
        break;

      case 'scopedDefaults':
        // Startup defaults for new threads — the lower half of the mode and
        // permission dropdowns. The menus close the moment a value is picked,
        // so caching is enough: highlightCurrent re-marks every time one opens.
        scopedDefaults.mode = msg.mode || '';
        scopedDefaults.posture = msg.posture || '';
        break;

      case 'providersUpdated':
        // Backend pushed the full provider list, the picker's active route, and
        // the route the open conversation runs on. Re-render the provider
        // dropdown, then ask for the *conversation's* model list: that is the
        // list whose models the next message can actually use, and offering
        // another route's models here is how deepseek-flash was picked for a
        // thread pinned to the Zhipu route.
        if (Array.isArray(msg.providers) && dropdownProviderEl && currentProviderEl) {
          renderProviderDropdown(
            msg.providers,
            msg.current || '',
            msg.currentProviderId || '',
            msg.viewProvider || '',
            msg.viewProviderId || ''
          );
          var route = modelListRoute();
          if (!route.provider) {
            route = { provider: msg.providers[0] && msg.providers[0].id, providerId: '' };
          }
          if (route.provider) {
            vscode.postMessage({
              type: 'requestProviderModels',
              provider: route.provider,
              providerId: route.providerId || undefined,
            });
          }
        }
        break;

      case 'providerModels':
        // Backend pushed the model catalog for a provider. Re-render the
        // model dropdown. For pass-through providers (Ollama, Custom) with
        // no built-in catalog, show a placeholder item so the dropdown
        // isn't empty — the user can still set a model via /model.
        if (dropdownModelEl) {
          var activeProviderId = currentProviderEl
            ? (currentProviderEl.getAttribute('data-provider-id') || '').trim()
            : '';
          var activeExactId = currentProviderEl
            ? (currentProviderEl.getAttribute('data-model-provider-id') || '').trim()
            : '';
          var responseProviderId = (msg.provider || '').trim();
          var responseExactId = (msg.providerId || '').trim();
          // Both halves must match, or a slower answer for a sibling custom
          // route would repaint the model list of the one just selected.
          if (
            (activeProviderId && responseProviderId && activeProviderId !== responseProviderId) ||
            activeExactId !== responseExactId
          ) {
            break;
          }
          var models = Array.isArray(msg.models) ? msg.models : [];
          var selectedModel = (msg.currentModel || '').trim();
          if (!selectedModel && currentModelEl) {
            selectedModel = currentModelEl.textContent.trim();
          }
          if (selectedModel && currentModelEl) {
            currentModelEl.textContent = selectedModel;
            setStreamingState(false, '${tr.ready} (' + selectedModel + ')');
          }
          if (models.length === 0 && !msg.hasCatalog) {
            // No-catalog provider: show a single placeholder hint.
            dropdownModelEl.innerHTML = '';
            var hint = document.createElement('div');
            hint.className = 'dropdown-item';
            hint.setAttribute('data-value', '');
            hint.textContent = '(enter model id with /model)';
            hint.style.opacity = '0.6';
            hint.style.pointerEvents = 'none';
            dropdownModelEl.appendChild(hint);
          } else {
            renderModelDropdown(models, selectedModel);
          }
        }
        break;

      case 'sessionList':
        window.__wvSidebar.setSessions(msg.sessions || []);
        window.__wvSidebar.setShowAllWorkspaces(!!msg.showAllWorkspaces);
        window.__wvSidebar.renderSessions();
        break;

      case 'threadList':
        window.__wvSidebar.setThreads(msg.threads || []);
        window.__wvSidebar.setShowAllWorkspaces(!!msg.showAllWorkspaces);
        window.__wvSidebar.renderThreads();
        // The toolbar Agent chip (label, tooltip, click target) is refreshed by
        // renderThreads: it reads this same list, so the count it shows and the
        // request it offers to answer cannot disagree.
        break;

      case 'threadListLoading':
        // The summary fetch is the slow part of the rail (seconds, not
        // milliseconds), so the rail shows what it is doing instead of an
        // empty list that reads as "no threads".
        if (window.__wvSidebar && window.__wvSidebar.renderThreadListStatus) {
          window.__wvSidebar.renderThreadListStatus(
            msg.failed ? 'failed' : (msg.loading ? 'loading' : null),
          );
        }
        break;

      case 'threadAttention':
        if (window.__wvSidebar && window.__wvSidebar.showThreadAttention) {
          window.__wvSidebar.showThreadAttention(msg);
        }
        break;

      case 'sessionLoaded':
        window.__wvSidebar.setActiveSessionId(msg.sessionId || null);
        window.__wvSidebar.renderSessions();
        // A saved session is viewed without a thread, so no thread is the one
        // on screen any more. Both the rail's "needs you" grouping and the
        // toolbar chip hide the thread they think the view holds — leave the
        // last one named here and a session view silently hides its requests
        // from both.
        window.__wvSidebar.setActiveThreadId(null);
        window.__wvSidebar.renderThreads();
        // A saved session is viewed without a thread, so the goal slot belongs
        // to no thread at all: drop the previous one's card, its background
        // list and any open editor before the extension pushes the session's
        // own state (the goal control plane is thread-scoped).
        if (window.__wvGoal) window.__wvGoal.reset();
        break;

      case 'threadLoaded':
        window.__wvSidebar.setActiveThreadId(msg.threadId || msg.thread?.id || null);
        window.__wvSidebar.renderThreads();
        // Close any open detail overlay from the previous thread
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        if (window.__wvFleet) window.__wvFleet.closeFleetDetail();
        // Clear stale work/changes state from previous thread
        window.__wvSidebar.setWorkState({ checklist: [], checklistCompletionPct: 0, strategy: [] });
        window.__wvSidebar.setChangesState([]);
        window.__wvSidebar.renderWork();
        window.__wvSidebar.renderChanges();
        // Clear stale task/agent data from previous thread
        window.__wvSidebar.renderTasks([]);
        window.__wvSidebar.setAgentRuns([]);
        window.__wvSidebar.renderAgents([]);
        // The goal slot is thread-scoped too. Switching threads is a real view
        // change, not one of the pushes applyState is built to survive: an
        // editor left open here would keep the draft written for the thread we
        // just left and save it against this one. The extension pushes this
        // thread's goal (goalState) right after this message, which is what
        // draws the new card.
        if (window.__wvGoal) window.__wvGoal.reset();
        break;

      case 'taskList':
        window.__wvSidebar.renderTasks(msg.tasks || []);
        break;

      case 'agentRunList':
        window.__wvSidebar.setAgentRuns(msg.runs || []);
        window.__wvSidebar.renderAgents(msg.runs || []);
        break;

      case 'fleetRunList':
        if (window.__wvFleet) {
          window.__wvFleet.setFleetRuns(msg.runs || []);
          window.__wvFleet.setFleetStatus(msg.status || null);
          window.__wvFleet.renderFleet();
        }
        break;

      case 'fleetProfiles':
        if (window.__wvFleet) {
          window.__wvFleet.setFleetProfiles(msg.profiles || []);
        }
        break;

      case 'fleetRunDetail':
        if (window.__wvFleet) {
          window.__wvSidebar.closeTaskDetail();
          window.__wvSidebar.closeAgentDetail();
          window.__wvFleet.showFleetDetail(msg);
        }
        break;

      case 'fleetEvent':
        if (window.__wvFleet) {
          window.__wvFleet.handleFleetEvent(msg.event);
        }
        break;

      case 'fleetSessionReply':
        if (window.__wvFleet) {
          window.__wvFleet.showFleetReply(msg.sessionId, msg.reply);
        }
        break;

      case 'goalState':
        if (window.__wvGoal) {
          // applyState, not a setGoal/setEditing pair: it keeps an editor the
          // user has open (these pushes are usually unrelated: sidebar refresh,
          // thread switch, turn end) and skips the redraw when the rendered
          // state is unchanged. Rebuilding the slot swaps the button node out
          // from under the cursor — a click spanning the rebuild lands on the
          // common ancestor and never reaches the button, which read as "＋ Set
          // goal does nothing" — and it threw away the draft.
          window.__wvGoal.applyState(msg.goal || null, msg.backgroundGoals || []);
        }
        break;

      case 'workState':
        window.__wvSidebar.setWorkState({
          checklist: msg.checklist || [],
          checklistCompletionPct: msg.checklistCompletionPct || 0,
          strategy: msg.strategy || [],
        });
        window.__wvSidebar.renderWork();
        break;

      case 'changesState':
        window.__wvSidebar.setChangesState(msg.changes || [], msg.turns || []);
        window.__wvSidebar.renderChanges();
        break;

      case 'apiCapabilities':
        apiCapabilities = Object.assign({}, apiCapabilities, msg.capabilities || {});
        window.__wvApiCapabilities = apiCapabilities;
        window.__wvInput.applyApiCapabilities();
        window.__wvSidebar.renderWork();
        break;

      case 'taskDetail':
        window.__wvSidebar.closeAgentDetail();
        window.__wvSidebar.showTaskDetail(msg.task);
        break;

      case 'agentDetail':
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.showAgentDetail(msg.run);
        break;

      case 'loadHistory':
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        if (window.__wvFleet) window.__wvFleet.closeFleetDetail();
        // Clear shared diff store when switching sessions so stale entries
        // from the previous session don't leak into the new one.
        _diffStore.clear();
        _diffIdCounter.value = 0;
        // A history load replaces the whole conversation (thread/session
        // switch, or a webview reload), so end any running-turn display here.
        // This used to happen as a side effect of the trailing status
        // message, which no longer touches the streaming state.
        window.__wvMessages.setStreaming(false);
        var loadHistoryTimeout = window.__wvMessages.getStreamingTimeout();
        if (loadHistoryTimeout) {
          clearTimeout(loadHistoryTimeout);
          window.__wvMessages.setStreamingTimeout(null);
        }
        setStreamingState(false, __i18n.ready);
        messagesEl.innerHTML = '';
        hideApprovalFloat();
        for (var i = 0; i < msg.messages.length; i++) {
          var m = msg.messages[i];
          var showRole = !msg.compactMode || !!m._realContent;
          window.__wvMessages.addMessage(m, showRole);
        }
        // A rebuilt plan-mode conversation keeps the approve action it had
        // live: the backend names the message that should carry it.
        if (msg.planApprovalFor && window.__wvMessages.renderPlanApproveButton) {
          window.__wvMessages.renderPlanApproveButton(msg.planApprovalFor);
        }
        // A transcript that ends on a streaming assistant bubble is a turn the
        // engine is still running: adopting one while switching back, opening
        // a thread that has a turn in flight, or resuming a session into an
        // already-busy thread. The reset above cannot stay the last word on
        // the streaming state — the host posts that turn's 'turnStarted' and
        // its streaming placeholder *before* this draw, and a rebuild only
        // arms the state through 'addMessage' for a streaming message, which
        // the reset has already wiped. Left un-armed, the composer offers Send
        // for a live turn: plain text starts a new turn (the engine refuses a
        // busy thread), and once a delta arrives the Stop button is labelled
        // from the status bar while the click still reads this flag, so it
        // sends instead of stopping. The trailing bubble is the invariant —
        // a finished turn finalizes it to complete/error first.
        var lastLoaded = msg.messages[msg.messages.length - 1];
        if (lastLoaded && lastLoaded.role === 'assistant' && lastLoaded.status === 'streaming') {
          window.__wvMessages.setStreaming(true);
          armStallTimeout();
          showThinkingActivity(lastLoaded.id, __i18n.thinking);
          setStreamingState(true, __i18n.thinking);
        }
        // Nav dots are rebuilt by addMessage() via scheduleNavUpdate(); no
        // explicit call needed here.
        break;

      case 'addMessage':
        window.__wvMessages.addMessage(msg.message);
        if (msg.message.status === 'streaming') {
          window.__wvMessages.setStreaming(true);
          armStallTimeout();
          showThinkingActivity(msg.message.id, __i18n.thinking);
          setStreamingState(true, __i18n.thinking);
        }
        break;

      case 'removeMessage':
        window.__wvMessages.removeMessage(msg.messageId);
        break;

      case 'updateMessage': {
        var blockIdx = msg.blockIdx !== undefined ? msg.blockIdx : 0;
        var contentEl = document.getElementById('content-' + msg.messageId + '-' + blockIdx);
        if (!contentEl) {
          var bodyEl = document.getElementById('body-' + msg.messageId);
          if (bodyEl) {
            contentEl = document.createElement('div');
            contentEl.className = 'content streaming-indicator';
            contentEl.id = 'content-' + msg.messageId + '-' + blockIdx;
            contentEl.setAttribute('data-block-idx', String(blockIdx));
            var insertBefore = bodyEl.querySelector('[data-block-idx="' + (blockIdx + 1) + '"]');
            if (insertBefore) {
              bodyEl.insertBefore(contentEl, insertBefore);
            } else {
              bodyEl.appendChild(contentEl);
            }
          }
        }
        if (contentEl) {
          contentEl.textContent = msg.content || '';
          window.__wvMessages.smartScrollToBottom();
        }
        updateThinkingActivityLabel(msg.messageId, __i18n.streaming);
        setStreamingState(true, __i18n.streaming);
        break;
      }

      case 'updateThinking': {
        var blockIdx = msg.blockIdx !== undefined ? msg.blockIdx : 0;
        var thinkingEl = document.getElementById('thinking-' + msg.messageId + '-' + blockIdx);
        var block = thinkingEl ? thinkingEl.parentElement : null;
        if (!block) {
          var bodyEl = document.getElementById('body-' + msg.messageId);
          if (bodyEl) {
            block = window.__wvMessages.createThinkingBlock(msg.messageId, blockIdx);
            var insertBefore = bodyEl.querySelector('[data-block-idx="' + (blockIdx + 1) + '"]');
            if (insertBefore) {
              bodyEl.insertBefore(block, insertBefore);
            } else {
              bodyEl.appendChild(block);
            }
          }
        }
        if (block) {
          window.__wvMessages.updateThinkingBlock(block, msg.thinking);
          window.__wvMessages.smartScrollToBottom();
        }
        updateThinkingActivityLabel(msg.messageId, __i18n.thinking);
        setStreamingState(true, __i18n.thinking);
        break;
      }

      case 'addTextBlock': {
        var bodyEl = document.getElementById('body-' + msg.messageId);
        if (bodyEl) {
          var blockIdx = msg.blockIdx;
          var contentEl = document.createElement('div');
          contentEl.className = 'content streaming-indicator';
          contentEl.id = 'content-' + msg.messageId + '-' + blockIdx;
          contentEl.setAttribute('data-block-idx', String(blockIdx));
          var insertBefore = bodyEl.querySelector('[data-block-idx="' + (blockIdx + 1) + '"]');
          if (insertBefore) {
            bodyEl.insertBefore(contentEl, insertBefore);
          } else {
            bodyEl.appendChild(contentEl);
          }
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }

      case 'addThinkingBlock': {
        var bodyEl = document.getElementById('body-' + msg.messageId);
        if (bodyEl) {
          var blockIdx = msg.blockIdx;
          var block = window.__wvMessages.createThinkingBlock(msg.messageId, blockIdx);
          var insertBefore = bodyEl.querySelector('[data-block-idx="' + (blockIdx + 1) + '"]');
          if (insertBefore) {
            bodyEl.insertBefore(block, insertBefore);
          } else {
            bodyEl.appendChild(block);
          }
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }

      case 'addToolCall': {
        var bodyEl = document.getElementById('body-' + msg.messageId);
        if (bodyEl) {
          var tcEl = document.createElement('div');
          tcEl.innerHTML = window.__wvMessages.renderToolCall(msg.messageId, msg.toolCall, msg.toolCallIdx);
          var child = tcEl.firstElementChild;
          if (msg.blockIdx !== undefined) {
            child.setAttribute('data-block-idx', String(msg.blockIdx));
            var insertBefore = bodyEl.querySelector('[data-block-idx="' + (msg.blockIdx + 1) + '"]');
            if (insertBefore) {
              bodyEl.insertBefore(child, insertBefore);
            } else {
              bodyEl.appendChild(child);
            }
          } else {
            var contentEl = bodyEl.querySelector('.content');
            if (contentEl) {
              bodyEl.insertBefore(child, contentEl);
            } else {
              bodyEl.appendChild(child);
            }
          }
          // Measured only now that the card is in the document: a detached node
          // has no layout, so measuring it there answered nothing at all.
          if (window.__wvMessages.markClippedBlocks) window.__wvMessages.markClippedBlocks(child);
          window.__wvMessages.smartScrollToBottom();
        }
        if (msg.toolCall && msg.toolCall.displayName) {
          updateThinkingActivityLabel(msg.messageId, msg.toolCall.displayName);
        }
        break;
      }

      case 'updateToolCall': {
        var tcEl = document.getElementById('tc-' + msg.messageId + '-' + msg.toolCallIdx);
        if (tcEl) {
          var statusSpan = tcEl.querySelector('.tool-status');
          if (statusSpan) {
            var statusIcon = '';
            var statusText = msg.status;
            if (msg.status === 'running') { statusIcon = '\\u27F3'; statusText = 'running...'; }
            else if (msg.status === 'complete') { statusIcon = '\\u2713'; statusText = 'completed'; }
            else if (msg.status === 'error') { statusIcon = '\\u2717'; statusText = 'error'; }
            else if (msg.status === 'awaiting_approval') { statusIcon = '\\u26A0'; statusText = __i18n.approvalAwaiting; }
            statusSpan.textContent = statusIcon + ' ' + statusText;
          }
          if (msg.output) {
            var outputEl = tcEl.querySelector('.tool-output');
            if (!outputEl) {
              outputEl = document.createElement('div');
              outputEl.className = 'tool-output';
              outputEl.setAttribute('tabindex', '0');
              tcEl.appendChild(outputEl);
            }
            outputEl.textContent = msg.output;
            if (window.__wvMessages.markClippedBlocks) window.__wvMessages.markClippedBlocks(tcEl);
          }
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }

      case 'fileChangeDetected': {
        var tcEl = document.getElementById('tc-' + msg.messageId + '-' + msg.toolCallIdx);
        if (tcEl && msg.fileChange) {
          var existingOutput = tcEl.querySelector('.tool-output');
          if (existingOutput) existingOutput.remove();
          var existingCard = tcEl.querySelector('.file-change-card');
          if (!existingCard) {
            var card = document.createElement('div');
            card.innerHTML = window.__wvMessages.renderFileChangeCard(msg.fileChange);
            var cardEl = card.firstElementChild;
            var approvalBar = tcEl.querySelector('.approval-bar');
            if (approvalBar) {
              tcEl.insertBefore(cardEl, approvalBar);
            } else {
              tcEl.appendChild(cardEl);
            }
          }
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }

      case 'approvalRequired': {
        var summaryText = __wvEscapeHtml(msg.summary || __i18n.approvalRequired);
        // The card keeps a read-only line naming the request. The allow/deny
        // buttons live in the panel only: one approval, one way to answer it.
        var approvalLine = '<div class="approval-text">\\u26A0 ' + summaryText + '</div>';
        if (msg.toolCallIdx !== undefined) {
          var tcEl = document.getElementById('tc-' + msg.messageId + '-' + msg.toolCallIdx);
          if (tcEl) {
            var nameSpan = tcEl.querySelector('.tool-name');
            if (nameSpan && msg.toolName) nameSpan.textContent = '\\uD83D\\uDD27 ' + msg.toolName;
            var statusSpan = tcEl.querySelector('.tool-status');
            if (statusSpan) statusSpan.textContent = '\\u26A0 ' + __i18n.approvalAwaiting;
            if (!tcEl.querySelector('.approval-bar')) {
              var bar = document.createElement('div');
              bar.className = 'approval-bar';
              bar.setAttribute('data-approval-id', msg.approvalId);
              bar.innerHTML = approvalLine;
              tcEl.appendChild(bar);
              window.__wvMessages.smartScrollToBottom();
            }
          }
        } else {
          var bodyEl = document.getElementById('body-' + msg.messageId);
          if (bodyEl && !bodyEl.querySelector('.approval-bar')) {
            var bar = document.createElement('div');
            bar.className = 'approval-bar';
            bar.setAttribute('data-approval-id', msg.approvalId);
            bar.innerHTML = approvalLine;
            bodyEl.appendChild(bar);
            window.__wvMessages.smartScrollToBottom();
          }
        }
        setStreamingState(true, __i18n.approvalAwaiting);
        showApprovalFloat(msg.approvalId, summaryText, msg.rawToolName, msg.toolInput);
        break;
      }

      case 'approvalResolved': {
        // One answer retires one request. Several approvals can be pending at
        // once, so neither the panel nor the cards' status lines may be cleared
        // wholesale here — that is how the remaining ones lost their only way
        // to be answered.
        var answeredCards = [];
        if (msg.approvalId) {
          document.querySelectorAll('.approval-bar[data-approval-id="' + msg.approvalId + '"]').forEach(function(bar) {
            var card = bar.closest ? bar.closest('.tool-call') : null;
            if (card) answeredCards.push(card);
            bar.remove();
          });
          removeApprovalItem(msg.approvalId);
        } else {
          hideApprovalFloat();
          document.querySelectorAll('.approval-bar').forEach(function(bar) { bar.remove(); });
        }
        // Also retire the inline sidebar card for a background thread's
        // approval (answered without switching) — keyed by approval id.
        if (window.__wvSidebar && window.__wvSidebar.removeThreadAttentionApproval) {
          window.__wvSidebar.removeThreadAttentionApproval(msg.approvalId);
        }
        var resolvedStatus = msg.decision === 'allow' ? '\\u27F3 running...' : (msg.decision === 'deny' ? '\\u2717 denied' : '');
        if (resolvedStatus) {
          if (msg.approvalId) {
            // Only the card that was waiting on this id moves on; every other
            // card still showing "awaiting approval" is still waiting.
            for (var ai = 0; ai < answeredCards.length; ai++) {
              var answeredSpans = answeredCards[ai].querySelectorAll('.tool-status');
              for (var aj = 0; aj < answeredSpans.length; aj++) answeredSpans[aj].textContent = resolvedStatus;
            }
          } else {
            document.querySelectorAll('.tool-status').forEach(function(span) {
              if (span.textContent && span.textContent.includes(__i18n.approvalAwaiting)) {
                span.textContent = resolvedStatus;
              }
            });
          }
        }
        setStreamingState(true, __i18n.streaming);
        break;
      }

      case 'userInputRequired': {
        var inputId = msg.inputId;
        var questions = msg.questions || [];
        var questionsHtml = '';
        for (var qi = 0; qi < questions.length; qi++) {
          var q = questions[qi];
          questionsHtml += '<div class="user-input-question">';
          questionsHtml += '<div class="user-input-header">' + __wvEscapeHtml(q.header) + '</div>';
          questionsHtml += '<div class="user-input-text">' + __wvEscapeHtml(q.question) + '</div>';
          questionsHtml += '<div class="user-input-options">';
          for (var optIdx = 0; optIdx < (q.options || []).length; optIdx++) {
            var opt = q.options[optIdx];
            questionsHtml += '<button class="btn-user-input-option" data-input-id="' + inputId + '" data-question-id="' + q.id + '" data-option-idx="' + optIdx + '" data-option-label="' + __wvEscapeHtml(opt.label) + '">' + __wvEscapeHtml(opt.label) + ': ' + __wvEscapeHtml(opt.description || '') + '</button>';
          }
          questionsHtml += '</div></div>';
        }
        setStreamingState(true, __i18n.userInputAwaiting);
        var bodyEl = document.getElementById('body-' + msg.messageId);
        if (bodyEl) {
          var bar = document.createElement('div');
          bar.className = 'user-input-bar';
          bar.id = 'user-input-' + inputId;
          bar.innerHTML = '<div class="user-input-icon">\\u2753</div><div class="user-input-content">' + questionsHtml + '</div><div class="user-input-buttons"><button class="btn-user-input-cancel" data-input-id="' + inputId + '">' + __i18n.cancel + '</button></div>';
          bodyEl.appendChild(bar);
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }

      case 'userInputResolved':
        document.querySelectorAll('.user-input-bar').forEach(function(bar) { bar.remove(); });
        // Also retire the inline sidebar card for a background thread's
        // input (answered without switching) — keyed by input id.
        if (window.__wvSidebar && window.__wvSidebar.removeThreadAttentionInput) {
          window.__wvSidebar.removeThreadAttentionInput(msg.inputId);
        }
        if (!msg.cancelled) {
          document.querySelectorAll('.tool-status').forEach(function(span) {
            if (span.textContent && span.textContent.includes(__i18n.userInputAwaiting)) {
              span.textContent = '\\u2713 submitted';
            }
          });
        } else {
          document.querySelectorAll('.tool-status').forEach(function(span) {
            if (span.textContent && span.textContent.includes(__i18n.userInputAwaiting)) {
              span.textContent = '\\u2717 cancelled';
            }
          });
        }
        setStreamingState(true, __i18n.streaming);
        break;

      case 'messageComplete': {
        var msgBodyEl = document.getElementById('body-' + msg.messageId);
        if (msgBodyEl) {
          msgBodyEl.querySelectorAll('.content.streaming-indicator').forEach(function(el) { el.classList.remove('streaming-indicator'); });
        }
        if (msg.usage) {
          var msgEl = document.getElementById('msg-' + msg.messageId);
          if (msgEl) {
            var usageEl = document.createElement('div');
            usageEl.className = 'usage-info';
            usageEl.textContent = '\\u2191' + (msg.usage.input_tokens || 0) + ' \\u2193' + (msg.usage.output_tokens || 0);
            msgEl.appendChild(usageEl);
          }
        }
        if (msg.blockHtmls && msgBodyEl) {
          for (var bhi = 0; bhi < msg.blockHtmls.length; bhi++) {
            var bh = msg.blockHtmls[bhi];
            var blockEl = msgBodyEl.querySelector('[data-block-idx="' + bh.blockIdx + '"]');
            if (blockEl) {
              var contentEl = blockEl.classList.contains('content') ? blockEl : blockEl.querySelector('.content');
              var thinkingEl = blockEl.classList.contains('thinking-block') ? blockEl.querySelector('.thinking-content') : null;
              if (contentEl) contentEl.innerHTML = bh.contentHtml;
              if (thinkingEl) thinkingEl.innerHTML = bh.contentHtml;
            }
          }
        } else {
          if (msg.contentHtml && msgBodyEl) {
            msgBodyEl.querySelectorAll('.content').forEach(function(el) { el.innerHTML = msg.contentHtml; });
          }
          if (msg.thinkingHtml && msgBodyEl) {
            msgBodyEl.querySelectorAll('.thinking-content').forEach(function(el) { el.innerHTML = msg.thinkingHtml; });
          }
        }
        if (msg.planApproval && window.__wvMessages.renderPlanApproveButton) {
          window.__wvMessages.renderPlanApproveButton(msg.messageId);
        }
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        hideThinkingActivity(msg.messageId);
        setStreamingState(false, msg.error ? __i18n.error : __i18n.ready);
        break;
      }

      case 'turnStarted':
        // A turn is running the moment the host says so — including one this
        // client never started, which it adopted while loading a thread that
        // had a turn in flight. Arming the flag here is what makes the
        // composer steer (and Stop) that turn instead of offering to start a
        // second one the engine refuses, and the deadline comes with the flag
        // so an adopted turn cannot hold the composer past a silent engine.
        window.__wvMessages.setStreaming(true);
        armStallTimeout();
        setStreamingState(true, __i18n.processing);
        break;

      case 'turnInterrupted':
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        setStreamingState(false, __i18n.ready);
        document.querySelectorAll('.thinking-activity').forEach(function(el) { el.remove(); });
        document.querySelectorAll('.approval-bar').forEach(function(bar) { bar.remove(); });
        document.querySelectorAll('.user-input-bar').forEach(function(bar) { bar.remove(); });
        hideApprovalFloat();
        break;

      case 'sessionStats': {
        sessionStats = {
          cost: msg.cost,
          cacheHitRate: msg.cacheHitRate,
          totalInputTokens: msg.totalInputTokens,
          totalOutputTokens: msg.totalOutputTokens,
          totalTokens: msg.totalTokens,
        };
        renderStatusStats();
        break;
      }

      case 'status':
        setStatusText(msg.text);
        break;

      case 'busy': {
        // A pass that produces no tokens still has to look alive. Context
        // compaction is exactly that — one non-streaming summary call, so no
        // deltas ever arrive and the wait is otherwise silent. This paints the
        // status bar's activity dot and nothing else: not the
        // messages-streaming flag (which would arm the stall deadline and
        // offer a Stop button with nothing to stop) and not the status text
        // (the 'status' message owns that).
        if (statusBarEl) statusBarEl.classList.toggle('is-streaming', !!msg.active);
        break;
      }

      case 'setInputText':
        if (msg.text && inputEl) {
          // Through the input module's own writer: it is the one place that
          // refreshes what depends on the box's text (the steer button sends
          // it), and the restore that matters most is a refused send — the
          // turn is adopted right after, so the guidance the user typed has
          // to be sendable the moment it lands back.
          if (window.__wvInput && window.__wvInput.setComposerText) {
            window.__wvInput.setComposerText(msg.text);
          } else {
            inputEl.value = msg.text;
          }
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
        break;

      case 'attachmentsChanged':
        window.__wvInput.setCurrentAttachments(msg.attachments || []);
        window.__wvInput.renderAttachments();
        if (inputEl) inputEl.focus();
        break;

      // Thumbnails travel separately from the list (and always before it), so
      // a 5 MiB image is not re-sent on every add / remove / send. Cached by
      // the input module; no re-render needed, the list follows.
      case 'attachmentPreview':
        window.__wvInput.setAttachmentPreview(msg.id, msg.previewUrl);
        break;

      case 'clearChat':
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        if (window.__wvFleet) window.__wvFleet.closeFleetDetail();
        // Clear shared diff store when starting a new chat.
        _diffStore.clear();
        _diffIdCounter.value = 0;
        messagesEl.innerHTML = '';
        hideApprovalFloat();
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        setStreamingState(false, __i18n.ready);
        sessionStats = null;
        renderStatusStats();
        window.__wvMessages.renderWelcome();
        // Clear sidebar Work panel state so stale data from the previous
        // session doesn't persist into the new one.
        window.__wvSidebar.setWorkState({ checklist: [], checklistCompletionPct: 0, strategy: [] });
        window.__wvSidebar.setChangesState([]);
        window.__wvSidebar.renderWork();
        window.__wvSidebar.renderChanges();
        // Clear task/agent panels too
        window.__wvSidebar.renderTasks([]);
        window.__wvSidebar.setAgentRuns([]);
        window.__wvSidebar.renderAgents([]);
        // The goal slot lives in the Work panel but is owned by the goal control
        // plane, so it needs its own reset — a stale goal (or a half-written
        // draft) from the previous thread must not survive a cleared view.
        if (window.__wvGoal) {
          window.__wvGoal.reset();
        }
        break;

      case 'openConfigPanel':
        vscode.postMessage({ type: 'openConfigPanel' });
        break;

      case 'error': {
        // Not every error is the turn's. A goal error carries keepStreaming
        // because the turn it did not come from may still be running: stopping
        // the streaming indicator (and clearing its stall timeout) would
        // report that turn as finished and stop watching it for a stall.
        //
        // The streaming flag is cleared before the status line is repainted,
        // not after: the flag is what the send/stop button and the Enter
        // routing read, so a repaint that ran ahead of it would leave the
        // composer offering Stop for a turn this error just ended — and
        // steering, which needs a turn, would be refused by the engine.
        var keepStreaming = msg.keepStreaming === true;
        if (!keepStreaming) {
          window.__wvMessages.setStreaming(false);
          var st = window.__wvMessages.getStreamingTimeout();
          if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
          setStreamingState(false, __i18n.error);
        }
        var errEl = document.createElement('div');
        errEl.className = 'error-banner';
        errEl.innerHTML = '<span class="msg-label error">' + __wvEscapeHtml(__i18n.error) + '</span><span>' + __wvEscapeHtml(msg.message) + '</span>';
        messagesEl.appendChild(errEl);
        window.__wvMessages.setUserScrolledUp(false);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      }

      case 'info': {
        var infoEl = document.createElement('div');
        infoEl.className = 'system-message';
        // A compaction result carries the handoff summary the engine committed;
        // it hangs off the same line, collapsed.
        infoEl.innerHTML = '<span class="msg-label note">' + __wvEscapeHtml(__i18n.note) + '</span><span class="msg-body">' + __wvEscapeHtml(msg.message) + '</span>' +
          (msg.compactionSummary && window.__wvMessages && window.__wvMessages.renderCompactionSummary
            ? window.__wvMessages.renderCompactionSummary(msg.compactionSummary)
            : '');
        messagesEl.appendChild(infoEl);
        window.__wvMessages.smartScrollToBottom();
        break;
      }

      case 'loadLastUserMessage': {
        var userMsgs = messagesEl.querySelectorAll('.message.user .message-body');
        if (userMsgs.length > 0) {
          var lastMsg = userMsgs[userMsgs.length - 1];
          inputEl.value = lastMsg.textContent || '';
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        } else {
          var infoEl = document.createElement('div');
          infoEl.className = 'system-message';
          infoEl.innerHTML = '<span class="msg-label note">' + __wvEscapeHtml(__i18n.note) + '</span><span class="msg-body">' + __wvEscapeHtml(__i18n.noPreviousMessage) + '</span>';
          messagesEl.appendChild(infoEl);
          window.__wvMessages.smartScrollToBottom();
        }
        break;
      }
    }
  });
  })();`;
}
