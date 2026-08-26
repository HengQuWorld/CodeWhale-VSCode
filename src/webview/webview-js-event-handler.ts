/**
 * Webview JS event handler module — injected into the webview as an IIFE.
 * Handles the window 'message' event listener with the main switch statement.
 */
import type { WebviewTranslations } from "./webview-html";

export function getEventHandlerScript(tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var __wvFormatLoadedThread = window.__wvFormatLoadedThread;
  var vscode = window.__wvVscode;
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var statusTextEl = document.getElementById('status-text');
  var statusStatsEl = document.getElementById('status-stats');
  var currentModeEl = document.getElementById('current-mode');
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
    // Sync send/stop button state
    if (window.__wvInput && window.__wvInput.updateSendStopButton) {
      window.__wvInput.updateSendStopButton(streaming);
    }
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

  function renderProviderDropdown(providers, currentId) {
    if (!dropdownProviderEl) return;
    dropdownProviderEl.innerHTML = '';
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var item = document.createElement('div');
      item.className = 'dropdown-item';
      item.setAttribute('data-value', p.id);
      // Show display_name (e.g. "OpenAI") when available, falling back to id.
      var label = p.display_name || p.id;
      if (p.id === currentId) label = label + ' \\u2713';
      item.textContent = label;
      dropdownProviderEl.appendChild(item);
    }
    if (currentProviderEl) {
      currentProviderEl.setAttribute('data-provider-id', currentId || '');
      // Show the display_name of the active provider if we can find it;
      // otherwise fall back to the raw id.
      var active = null;
      for (var j = 0; j < providers.length; j++) {
        if (providers[j].id === currentId) { active = providers[j]; break; }
      }
      currentProviderEl.textContent = active ? (active.display_name || active.id) : currentId;
    }
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
    var settingsBar = document.getElementById('settings-bar');
    if (!settingsBar) return;

    function closeAllDropdowns() {
      var menus = settingsBar.querySelectorAll('.dropdown-menu');
      for (var i = 0; i < menus.length; i++) { menus[i].classList.remove('open'); }
    }

    function highlightCurrent(dropdown) {
      var currentVal = dropdown.parentElement.querySelector('.setting-value').textContent.trim();
      var items = dropdown.querySelectorAll('.dropdown-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('selected', items[i].getAttribute('data-value') === currentVal);
      }
    }

    settingsBar.addEventListener('click', function(e) {
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
        var dropdown = target.parentElement;
        var setting = dropdown.parentElement.getAttribute('data-setting');
        closeAllDropdowns();
        if (val && setting) {
          // Map setting to slash command
          if (setting === 'mode') {
            vscode.postMessage({ type: 'slashCommand', command: '/mode', args: val });
          } else if (setting === 'model') {
            vscode.postMessage({ type: 'slashCommand', command: '/model', args: val });
          } else if (setting === 'reasoning') {
            vscode.postMessage({ type: 'slashCommand', command: '/reasoning', args: val });
          } else if (setting === 'provider') {
            // Switching provider triggers a runtime reload. The model list
            // will be re-rendered when the backend pushes providerModels.
            vscode.postMessage({ type: 'switchProvider', provider: val });
          }
        }
      }

      // Config button
      if (target.id === 'btn-config' || target.closest('#btn-config')) {
        vscode.postMessage({ type: 'openConfigPanel' });
        e.stopPropagation();
        return;
      }
    });
  })();

  // Close dropdowns when clicking elsewhere
  document.addEventListener('click', function() {
    var settingsBar = document.getElementById('settings-bar');
    if (!settingsBar) return;
    var menus = settingsBar.querySelectorAll('.dropdown-menu');
    for (var i = 0; i < menus.length; i++) { menus[i].classList.remove('open'); }
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
        setStreamingState(false, '${tr.ready} (' + (msg.model || 'deepseek-v4-pro') + ')');
        if (msg.mode) currentModeEl.textContent = msg.mode;
        if (msg.model) currentModelEl.textContent = msg.model;
        if (msg.reasoningEffort) currentReasoningEl.textContent = msg.reasoningEffort;
        if (msg.provider && currentProviderEl) currentProviderEl.textContent = msg.provider;
        runtimeVersion = msg.runtimeVersion || runtimeVersion || '';
        renderStatusStats();
        window.__wvSidebar.applyShowThreadList(!!msg.showThreadList);
        break;

      case 'settingsUpdated':
        if (msg.model) {
          setStreamingState(false, '${tr.ready} (' + msg.model + ')');
        }
        if (msg.mode) currentModeEl.textContent = msg.mode;
        if (msg.model) currentModelEl.textContent = msg.model;
        if (msg.reasoningEffort) currentReasoningEl.textContent = msg.reasoningEffort;
        if (msg.provider && currentProviderEl) {
          currentProviderEl.textContent = msg.provider;
          currentProviderEl.setAttribute('data-provider-id', msg.provider);
        }
        break;

      case 'providersUpdated':
        // Backend pushed the full provider list + active id. Re-render the
        // provider dropdown and request the model catalog for the active
        // provider so the model dropdown stays in sync.
        if (Array.isArray(msg.providers) && dropdownProviderEl && currentProviderEl) {
          renderProviderDropdown(msg.providers, msg.current || '');
          // After re-rendering, ask the backend for the active provider's
          // model list so the model dropdown reflects the new provider.
          var activeId = msg.current || (msg.providers[0] && msg.providers[0].id);
          if (activeId) {
            vscode.postMessage({ type: 'requestProviderModels', provider: activeId });
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
          var responseProviderId = (msg.provider || '').trim();
          if (activeProviderId && responseProviderId && activeProviderId !== responseProviderId) {
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
        break;

      case 'sessionLoaded':
        window.__wvSidebar.setActiveSessionId(msg.sessionId || null);
        window.__wvSidebar.renderSessions();
        break;

      case 'threadLoaded':
        window.__wvSidebar.setActiveThreadId(msg.threadId || msg.thread?.id || null);
        window.__wvSidebar.renderThreads();
        // Close any open detail overlay from the previous thread
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        // Clear stale work/changes state from previous thread
        window.__wvSidebar.setWorkState({ goal: null, checklist: [], checklistCompletionPct: 0, strategy: [], cycleCount: 0, coherenceState: 'healthy', coherenceLabel: '' });
        window.__wvSidebar.setChangesState([]);
        window.__wvSidebar.renderWork();
        window.__wvSidebar.renderChanges();
        // Clear stale task/agent data from previous thread
        window.__wvSidebar.renderTasks([]);
        window.__wvSidebar.setAgentRuns([]);
        window.__wvSidebar.renderAgents([]);
        break;

      case 'taskList':
        window.__wvSidebar.renderTasks(msg.tasks || []);
        break;

      case 'agentRunList':
        window.__wvSidebar.setAgentRuns(msg.runs || []);
        window.__wvSidebar.renderAgents(msg.runs || []);
        break;

      case 'workState':
        window.__wvSidebar.setWorkState({
          goal: msg.goal || null,
          checklist: msg.checklist || [],
          checklistCompletionPct: msg.checklistCompletionPct || 0,
          strategy: msg.strategy || [],
          cycleCount: msg.cycleCount || 0,
          coherenceState: msg.coherenceState || 'healthy',
          coherenceLabel: msg.coherenceLabel || '',
        });
        window.__wvSidebar.renderWork();
        break;

      case 'changesState':
        window.__wvSidebar.setChangesState(msg.changes || []);
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
        // Clear shared diff store when switching sessions so stale entries
        // from the previous session don't leak into the new one.
        _diffStore.clear();
        _diffIdCounter.value = 0;
        messagesEl.innerHTML = '';
        for (var i = 0; i < msg.messages.length; i++) {
          var m = msg.messages[i];
          var showRole = !msg.compactMode || !!m._realContent;
          window.__wvMessages.addMessage(m, showRole);
        }
        // Nav dots are rebuilt by addMessage() via scheduleNavUpdate(); no
        // explicit call needed here.
        break;

      case 'addMessage':
        window.__wvMessages.addMessage(msg.message);
        if (msg.message.status === 'streaming') {
          window.__wvMessages.setStreaming(true);
          var st = window.__wvMessages.getStreamingTimeout();
          if (st) clearTimeout(st);
          window.__wvMessages.setStreamingTimeout(setTimeout(function() {
            if (window.__wvMessages.isStreaming()) {
              window.__wvMessages.setStreaming(false);
              setStreamingState(false, __i18n.readyTimedOut);
            }
          }, 300000));
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
        if (!thinkingEl) {
          var bodyEl = document.getElementById('body-' + msg.messageId);
          if (bodyEl) {
            var block = document.createElement('div');
            block.className = 'thinking-block';
            block.setAttribute('data-block-idx', String(blockIdx));
            block.innerHTML = '<div class="thinking-toggle">' + __wvEscapeHtml(__i18n.thinkingOpen) + '</div><div class="thinking-content open" id="thinking-' + msg.messageId + '-' + blockIdx + '"></div>';
            var insertBefore = bodyEl.querySelector('[data-block-idx="' + (blockIdx + 1) + '"]');
            if (insertBefore) {
              bodyEl.insertBefore(block, insertBefore);
            } else {
              bodyEl.appendChild(block);
            }
            thinkingEl = block.querySelector('.thinking-content');
          }
        }
        if (thinkingEl) {
          if (!thinkingEl.querySelector('.thinking-stream')) {
            thinkingEl.innerHTML = '<div class="thinking-stream"></div>';
          }
          var streamEl = thinkingEl.querySelector('.thinking-stream');
          if (streamEl) streamEl.textContent = msg.thinking || '';
          thinkingEl.classList.add('open');
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
          var block = document.createElement('div');
          block.className = 'thinking-block';
          block.setAttribute('data-block-idx', String(blockIdx));
          block.innerHTML = '<div class="thinking-toggle">' + __wvEscapeHtml(__i18n.thinkingOpen) + '</div><div class="thinking-content open" id="thinking-' + msg.messageId + '-' + blockIdx + '"></div>';
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
              tcEl.appendChild(outputEl);
            }
            outputEl.textContent = msg.output;
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
        var rememberLabel = '<label class="approval-remember"><input type="checkbox" data-approval-id="' + msg.approvalId + '" class="remember-check" /> Remember for this tool</label>';
        if (msg.toolCallIdx !== undefined) {
          var tcEl = document.getElementById('tc-' + msg.messageId + '-' + msg.toolCallIdx);
          if (tcEl) {
            var nameSpan = tcEl.querySelector('.tool-name');
            if (nameSpan && msg.toolName) nameSpan.textContent = '\\uD83D\\uDD27 ' + msg.toolName;
            var statusSpan = tcEl.querySelector('.tool-status');
            if (statusSpan) statusSpan.textContent = '\\u26A0 ' + __i18n.approvalAwaiting;
            var existing = tcEl.querySelector('.approval-bar');
            if (!existing) {
              var bar = document.createElement('div');
              bar.className = 'approval-bar';
              bar.innerHTML = '<div class="approval-text">\\u26A0 ' + summaryText + '</div>' + rememberLabel + '<div class="approval-buttons"><button class="btn-allow" data-approval-id="' + msg.approvalId + '" data-decision="allow">' + __i18n.allow + '</button><button class="btn-deny" data-approval-id="' + msg.approvalId + '" data-decision="deny">' + __i18n.deny + '</button></div>';
              tcEl.appendChild(bar);
              window.__wvMessages.smartScrollToBottom();
            }
          }
        } else {
          var bodyEl = document.getElementById('body-' + msg.messageId);
          if (bodyEl) {
            var existing = bodyEl.querySelector('.approval-bar');
            if (!existing) {
              var bar = document.createElement('div');
              bar.className = 'approval-bar';
              bar.innerHTML = '<div class="approval-text">\\u26A0 ' + summaryText + '</div>' + rememberLabel + '<div class="approval-buttons"><button class="btn-allow" data-approval-id="' + msg.approvalId + '" data-decision="allow">' + __i18n.allow + '</button><button class="btn-deny" data-approval-id="' + msg.approvalId + '" data-decision="deny">' + __i18n.deny + '</button></div>';
              bodyEl.appendChild(bar);
              window.__wvMessages.smartScrollToBottom();
            }
          }
        }
        setStreamingState(true, __i18n.approvalAwaiting);
        break;
      }

      case 'approvalResolved':
        document.querySelectorAll('.approval-bar').forEach(function(bar) { bar.remove(); });
        if (msg.decision === 'allow') {
          document.querySelectorAll('.tool-status').forEach(function(span) {
            if (span.textContent && span.textContent.includes(__i18n.approvalAwaiting)) {
              span.textContent = '\\u27F3 running...';
            }
          });
        } else if (msg.decision === 'deny') {
          document.querySelectorAll('.tool-status').forEach(function(span) {
            if (span.textContent && span.textContent.includes(__i18n.approvalAwaiting)) {
              span.textContent = '\\u2717 denied';
            }
          });
        }
        setStreamingState(true, __i18n.streaming);
        break;

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
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        hideThinkingActivity(msg.messageId);
        setStreamingState(false, msg.error ? __i18n.error : __i18n.ready);
        break;
      }

      case 'turnStarted':
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
        setStreamingState(false, msg.text);
        break;

      case 'setInputText':
        if (msg.text && inputEl) {
          inputEl.value = msg.text;
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
        break;

      case 'attachmentsChanged':
        window.__wvInput.setCurrentAttachments(msg.attachments || []);
        window.__wvInput.renderAttachments();
        break;

      case 'clearChat':
        window.__wvSidebar.closeTaskDetail();
        window.__wvSidebar.closeAgentDetail();
        // Clear shared diff store when starting a new chat.
        _diffStore.clear();
        _diffIdCounter.value = 0;
        messagesEl.innerHTML = '';
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        setStreamingState(false, __i18n.ready);
        sessionStats = null;
        renderStatusStats();
        window.__wvMessages.renderWelcome();
        // Clear sidebar Work panel state so stale data from the previous
        // session doesn't persist into the new one.
        window.__wvSidebar.setWorkState({ goal: null, checklist: [], checklistCompletionPct: 0, strategy: [], cycleCount: 0, coherenceState: 'healthy', coherenceLabel: '' });
        window.__wvSidebar.setChangesState([]);
        window.__wvSidebar.renderWork();
        window.__wvSidebar.renderChanges();
        // Clear task/agent panels too
        window.__wvSidebar.renderTasks([]);
        window.__wvSidebar.setAgentRuns([]);
        window.__wvSidebar.renderAgents([]);
        break;

      case 'openConfigPanel':
        vscode.postMessage({ type: 'openConfigPanel' });
        break;

      case 'error':
        setStreamingState(false, __i18n.error);
        var errEl = document.createElement('div');
        errEl.className = 'error-banner';
        errEl.innerHTML = '<span class="msg-label error">' + __wvEscapeHtml(__i18n.error) + '</span><span>' + __wvEscapeHtml(msg.message) + '</span>';
        messagesEl.appendChild(errEl);
        window.__wvMessages.setUserScrolledUp(false);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        window.__wvMessages.setStreaming(false);
        var st = window.__wvMessages.getStreamingTimeout();
        if (st) { clearTimeout(st); window.__wvMessages.setStreamingTimeout(null); }
        break;

      case 'info': {
        var infoEl = document.createElement('div');
        infoEl.className = 'system-message';
        infoEl.innerHTML = '<span class="msg-label note">' + __wvEscapeHtml(__i18n.note) + '</span><span class="msg-body">' + __wvEscapeHtml(msg.message) + '</span>';
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
