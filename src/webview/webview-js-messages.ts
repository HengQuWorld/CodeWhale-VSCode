/**
 * Webview JS messages module — injected into the webview as an IIFE.
 * Handles message rendering: addMessage, renderToolCall, renderFileChangeCard,
 * thinking toggle, approval decisions, welcome screen.
 */
import type { WebviewTranslations } from "./webview-html";

export function getMessagesScript(tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var vscode = window.__wvVscode;
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var _diffStore = window.__wvDiffStore;
  var _diffIdCounter = window.__wvDiffIdCounter;

  // ── Streaming state ──
  var isStreaming = false;
  var streamingTimeout = null;
  var userScrolledUp = false;
  var SCROLL_BOTTOM_THRESHOLD = 80;

  function smartScrollToBottom() {
    if (userScrolledUp) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < SCROLL_BOTTOM_THRESHOLD;
  }

  messagesEl.addEventListener('scroll', function() {
    if (isNearBottom()) {
      userScrolledUp = false;
    } else {
      userScrolledUp = true;
    }
  });

  // ── Welcome Screen ──
  function renderWelcome() {
    var existing = messagesEl.querySelector('.welcome-screen');
    if (existing) return;
    var welcome = document.createElement('div');
    welcome.className = 'welcome-screen';
    var suggestions = [
      { text: __i18n.welcomeSuggestion1, prompt: __i18n.welcomeSuggestion1 },
      { text: __i18n.welcomeSuggestion2, prompt: __i18n.welcomeSuggestion2 },
      { text: __i18n.welcomeSuggestion3, prompt: __i18n.welcomeSuggestion3 },
      { text: __i18n.welcomeSuggestion4, prompt: __i18n.welcomeSuggestion4 },
    ];
    welcome.innerHTML =
      '<div class="welcome-brand">' + __wvEscapeHtml(__i18n.welcomeTitle) + '</div>' +
      '<div class="welcome-subtitle">' + __wvEscapeHtml(__i18n.welcomeSubtitle) + '</div>' +
      '<div class="welcome-quote-block">' +
        '<div class="welcome-quote-text">' + __wvEscapeHtml(__i18n.welcomeQuote) + '</div>' +
        '<div class="welcome-quote-author">' + __wvEscapeHtml(__i18n.welcomeQuoteAuthor) + '</div>' +
      '</div>' +
      '<div class="welcome-suggestions-title">' + __wvEscapeHtml(__i18n.welcomeSuggestionTitle) + '</div>' +
      '<div class="welcome-suggestions">' +
        suggestions.map(function(s) {
          return '<button class="welcome-suggestion" data-prompt="' + __wvEscapeHtml(s.prompt) + '">' + __wvEscapeHtml(s.text) + '</button>';
        }).join('') +
      '</div>';
    messagesEl.appendChild(welcome);
    welcome.addEventListener('click', function(e) {
      var btn = e.target.closest('.welcome-suggestion');
      if (btn && btn.dataset.prompt) {
        inputEl.value = btn.dataset.prompt;
        inputEl.focus();
      }
    });
  }

  // ── Render Delegate Card (for agent_open / agent_spawn / agent_close / agent_cancel) ──
  function renderDelegateCard(msgId, tc, tcIdx) {
    var toolName = tc.name || '';
    var isSpawn = (toolName === 'agent_open' || toolName === 'agent_spawn');
    var isClose = (toolName === 'agent_close');
    var isCancel = (toolName === 'agent_cancel');
    var statusIcon = '';
    var statusText = '';
    var cardClass = 'delegate-card';

    if (tc.status === 'running') {
      statusIcon = '\\u27F3';
      statusText = isSpawn ? __i18n.agentDelegating : 'running...';
      cardClass += ' delegate-running';
    } else if (tc.status === 'complete') {
      statusIcon = '\\u2713';
      statusText = __i18n.agentStatusCompleted;
      cardClass += ' delegate-completed';
    } else if (tc.status === 'error') {
      statusIcon = '\\u2717';
      statusText = __i18n.agentStatusFailed;
      cardClass += ' delegate-failed';
    } else {
      statusIcon = '\\u25EF';
      statusText = tc.status || '';
    }

    // Parse input for objective, role, model
    var objective = '';
    var role = '';
    var model = '';
    var inputStr = '';
    if (typeof tc.input === 'string') {
      inputStr = tc.input;
    } else if (tc.input && typeof tc.input === 'object') {
      try { inputStr = JSON.stringify(tc.input); } catch(e) { inputStr = ''; }
    }
    if (inputStr) {
      try {
        var parsed = JSON.parse(inputStr);
        objective = parsed.objective || parsed.prompt || '';
        role = parsed.role || '';
        model = parsed.model || '';
      } catch(e) {
        objective = inputStr.slice(0, 80);
      }
    }

    // Parse output for result summary
    var resultSummary = '';
    var outputStr = '';
    if (typeof tc.output === 'string') {
      outputStr = tc.output;
    }
    if (outputStr && isClose && tc.status === 'complete') {
      resultSummary = outputStr.slice(0, 150);
    }

    var html = '<div class="' + cardClass + '" id="tc-' + msgId + '-' + tcIdx + '">';
    // Header
    html += '<div class="delegate-header">';
    if (isSpawn) {
      html += '<span class="delegate-icon">\\uD83E\\uDDE0</span>';
      html += '<span class="delegate-title">' + __wvEscapeHtml(__i18n.agentSpawned) + '</span>';
    } else if (isCancel) {
      html += '<span class="delegate-icon">\\u2298</span>';
      html += '<span class="delegate-title">' + __wvEscapeHtml(__i18n.agentStatusCancelled) + '</span>';
    } else if (isClose) {
      html += '<span class="delegate-icon">\\u2713</span>';
      html += '<span class="delegate-title">' + __wvEscapeHtml(__i18n.agentStatusCompleted) + '</span>';
    } else {
      html += '<span class="delegate-icon">\\uD83E\\uDDE0</span>';
      html += '<span class="delegate-title">' + __wvEscapeHtml(toolName) + '</span>';
    }
    html += ' <span class="delegate-status status-muted">' + statusIcon + ' ' + statusText + '</span>';
    html += '</div>';

    // Objective
    if (objective) {
      html += '<div class="delegate-objective">' + __wvEscapeHtml(objective.slice(0, 120)) + '</div>';
    }

    // Meta: role + model
    if (role || model) {
      html += '<div class="delegate-meta">';
      if (role) html += '<span class="delegate-role-badge">' + __wvEscapeHtml(role) + '</span>';
      if (model) html += '<span class="delegate-model-badge">' + __wvEscapeHtml(model) + '</span>';
      html += '</div>';
    }

    // Result summary
    if (resultSummary) {
      html += '<div class="delegate-result">' + __wvEscapeHtml(resultSummary) + '</div>';
    }

    // Error output
    if (tc.status === 'error' && outputStr) {
      html += '<div class="delegate-error-text">' + __wvEscapeHtml(outputStr.slice(0, 150)) + '</div>';
    }

    html += '</div>';
    return html;
  }

  // ── Render Tool Call ──
  function renderToolCall(msgId, tc, tcIdx) {
    // Delegate card for agent tools
    var toolName = tc.name || '';
    if (toolName === 'agent_open' || toolName === 'agent_spawn' || toolName === 'agent_close' || toolName === 'agent_cancel') {
      return renderDelegateCard(msgId, tc, tcIdx);
    }

    var statusIcon = '';
    var statusText = tc.status;

    if (tc.status === 'running') {
      statusIcon = '\\u27F3';
      statusText = 'running...';
    } else if (tc.status === 'complete') {
      statusIcon = '\\u2713';
      statusText = 'completed';
    } else if (tc.status === 'error') {
      statusIcon = '\\u2717';
      statusText = 'error';
    } else if (tc.status === 'awaiting_approval') {
      statusIcon = '\\u26A0';
      statusText = __i18n.approvalAwaiting;
    } else if (tc.status === 'pending') {
      statusIcon = '\\u25EF';
      statusText = 'pending';
    }

    var html = '<div class="tool-call" id="tc-' + msgId + '-' + tcIdx + '">';
    html += '<span class="tool-name">\\uD83D\\uDD27 ' + __wvEscapeHtml(tc.displayName || tc.name) + '</span>';
    html += ' <span class="tool-status status-muted">' + statusIcon + ' ' + statusText + '</span>';
    if (tc.fileChange) {
      html += renderFileChangeCard(tc.fileChange);
    } else if (tc.output) {
      html += '<div class="tool-output">' + __wvEscapeHtml(tc.output) + '</div>';
    }
    if (tc.status === 'awaiting_approval' && tc.approvalId) {
      html += '<div class="approval-bar">';
      html += '<div class="approval-text">\\u26A0 ' + __wvEscapeHtml(tc.approvalSummary || __i18n.approvalRequired) + '</div>';
      html += '<label class="approval-remember"><input type="checkbox" data-approval-id="' + tc.approvalId + '" class="remember-check" /> Remember for this tool</label>';
      html += '<div class="approval-buttons">';
      html += '<button class="btn-allow" data-approval-id="' + tc.approvalId + '" data-decision="allow">' + __i18n.allow + '</button>';
      html += '<button class="btn-deny" data-approval-id="' + tc.approvalId + '" data-decision="deny">' + __i18n.deny + '</button>';
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }

  // ── Render File Change Card ──
  function renderFileChangeCard(fc) {
    var changeTypeLabel = fc.changeType === 'created' ? __i18n.fileCreated : fc.changeType === 'deleted' ? __i18n.fileDeleted : __i18n.fileModified;
    var shortP = fc.filePath.replace(/\\\\\\\\/g, '/').split('/').slice(-3).join('/');
    var displayPath = fc.filePath.replace(/\\\\\\\\/g, '/').split('/').length > 3 ? '\\u2026/' + shortP : fc.filePath;
    var diffKey = fc.filePath + '@' + (++_diffIdCounter.value);
    if (fc.diff) _diffStore.set(diffKey, fc.diff);
    var html = '<div class="file-change-card">';
    html += '<div class="fc-header">';
    html += '<span class="fc-path" title="' + __wvEscapeHtml(fc.filePath) + '">\\uD83D\\uDCDD ' + __wvEscapeHtml(displayPath) + '</span>';
    html += '<span class="fc-badge ' + fc.changeType + '">' + __wvEscapeHtml(changeTypeLabel) + '</span>';
    if (fc.addedLines > 0 || fc.removedLines > 0) {
      html += '<span class="fc-stats">';
      if (fc.addedLines > 0) html += '<span class="added">+' + fc.addedLines + '</span> ';
      if (fc.removedLines > 0) html += '<span class="removed">-' + fc.removedLines + '</span>';
      html += '</span>';
    }
    html += '</div>';
    if (fc.toolName) {
      var friendlyName = fc.toolName.replace(/_/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
      html += '<div class="fc-tool-info fc-tool-info-muted">\\uD83D\\uDD27 ' + __wvEscapeHtml(friendlyName) + '</div>';
    }
    html += '<div class="fc-actions">';
    if (fc.diff) {
      html += '<button class="fc-view-diff" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" data-diff-key="' + diffKey + '" data-diff-index="' + (fc.diffIndex !== undefined ? fc.diffIndex : '') + '" title="' + __wvEscapeHtml(__i18n.viewDiffTooltip) + '">\\uD83D\\uDD0D ' + __wvEscapeHtml(__i18n.viewDiff) + '</button>';
    }
    if (fc.changeType !== 'deleted') {
      html += '<button class="fc-open-file" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" title="' + __wvEscapeHtml(__i18n.openFileTooltip) + '">\\uD83D\\uDCC4 ' + __wvEscapeHtml(__i18n.openFile) + '</button>';
    }
    var apiCapabilities = window.__wvApiCapabilities || {};
    if (apiCapabilities.revertFileChange) {
      html += '<button class="fc-revert" data-file-path="' + __wvEscapeHtml(fc.filePath) + '" data-change-type="' + __wvEscapeHtml(fc.changeType) + '" data-diff-key="' + (fc.diff ? diffKey : '') + '" title="' + __wvEscapeHtml(__i18n.revertFileTooltip) + '">\\u21A9 ' + __wvEscapeHtml(__i18n.revertFile) + '</button>';
    } else {
      html += '<button class="fc-revert is-unavailable" aria-disabled="true" data-disabled="true" data-tooltip="' + __wvEscapeHtml(__i18n.revertUnsupportedTooltip) + '">\\u21A9 ' + __wvEscapeHtml(__i18n.revertFile) + '</button>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  // ── Add Message ──
  function addMessage(msg, showRole) {
    var welcomeEl = messagesEl.querySelector('.welcome-screen');
    if (welcomeEl) welcomeEl.remove();

    var el = document.createElement('div');
    el.className = 'message ' + msg.role;
    el.id = 'msg-' + msg.id;

    var html = '';
    if (showRole !== false) {
      html += '<div class="role">' + __wvEscapeHtml(msg.role) + '</div>';
    }
    html += '<div class="message-body" id="body-' + msg.id + '"></div>';

    el.innerHTML = html;
    messagesEl.appendChild(el);
    smartScrollToBottom();

    var bodyEl = el.querySelector('.message-body');

    if (msg.blocks && msg.blocks.length > 0) {
      for (var bi = 0; bi < msg.blocks.length; bi++) {
        var b = msg.blocks[bi];
        if (b.type === 'thinking') {
          var th = b.contentHtml !== undefined ? b.contentHtml : __wvEscapeHtml(b.content || '');
          var block = document.createElement('div');
          block.className = 'thinking-block';
          block.setAttribute('data-block-idx', String(bi));
          var isOpen = 'open';
          var toggleLabel = __i18n.thinkingOpen;
          block.innerHTML = '<div class="thinking-toggle">' + __wvEscapeHtml(toggleLabel) + '</div><div class="thinking-content ' + isOpen + '" id="thinking-' + msg.id + '-' + bi + '">' + th + '</div>';
          bodyEl.appendChild(block);
        } else if (b.type === 'tool_call') {
          var tcIdx = b.toolCallIdx;
          var tc = msg.toolCalls && msg.toolCalls[tcIdx];
          if (tc) {
            var tcEl = document.createElement('div');
            tcEl.innerHTML = renderToolCall(msg.id, tc, tcIdx);
            var child = tcEl.firstElementChild;
            child.setAttribute('data-block-idx', String(bi));
            bodyEl.appendChild(child);
          }
        } else if (b.type === 'text') {
          var content = b.contentHtml !== undefined ? b.contentHtml : __wvEscapeHtml(b.content || '');
          var contentEl = document.createElement('div');
          contentEl.className = 'content' + (msg.status === 'streaming' ? ' streaming-indicator' : '');
          contentEl.id = 'content-' + msg.id + '-' + bi;
          contentEl.setAttribute('data-block-idx', String(bi));
          contentEl.innerHTML = content;
          bodyEl.appendChild(contentEl);
        }
      }
    } else {
      if (msg.thinkingHtml !== undefined || msg.thinking !== undefined) {
        var th = msg.thinkingHtml !== undefined ? msg.thinkingHtml : __wvEscapeHtml(msg.thinking || '');
        var block = document.createElement('div');
        block.className = 'thinking-block';
        var isOpen = 'open';
        var toggleLabel = __i18n.thinkingOpen;
        block.innerHTML = '<div class="thinking-toggle">' + __wvEscapeHtml(toggleLabel) + '</div><div class="thinking-content ' + isOpen + '" id="thinking-' + msg.id + '-0">' + th + '</div>';
        bodyEl.appendChild(block);
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (var i = 0; i < msg.toolCalls.length; i++) {
          var tc = msg.toolCalls[i];
          var tcEl = document.createElement('div');
          tcEl.innerHTML = renderToolCall(msg.id, tc, i);
          bodyEl.appendChild(tcEl.firstElementChild);
        }
      }

      var content = msg.contentHtml !== undefined ? msg.contentHtml : (msg.content || '');
      if (content) {
        var contentEl = document.createElement('div');
        contentEl.className = 'content' + (msg.status === 'streaming' ? ' streaming-indicator' : '');
        contentEl.id = 'content-' + msg.id + '-0';
        contentEl.innerHTML = content;
        bodyEl.appendChild(contentEl);
      } else if (msg.status === 'streaming') {
        var contentEl = document.createElement('div');
        contentEl.className = 'content streaming-indicator';
        contentEl.id = 'content-' + msg.id + '-0';
        bodyEl.appendChild(contentEl);
      }
    }

    smartScrollToBottom();
  }

  // ── Thinking Toggle ──
  function toggleThinking(el) {
    var content = el.nextElementSibling;
    if (!content) return;
    var isOpen = content.classList.contains('open');
    if (isOpen) {
      content.classList.remove('open');
      el.textContent = __i18n.thinkingClose;
    } else {
      content.classList.add('open');
      el.textContent = __i18n.thinkingOpen;
    }
  }

  // ── Approval Decision ──
  function decideApproval(approvalId, decision) {
    var checkbox = document.querySelector('.remember-check[data-approval-id="' + approvalId + '"]');
    var remember = checkbox ? checkbox.checked : false;
    vscode.postMessage({ type: 'approvalDecision', approvalId: approvalId, decision: decision, remember: remember });
  }

  // ── Event delegation for message area clicks ──
  messagesEl.addEventListener('click', function(e) {
    var target = e.target;

    if (target.classList.contains('fc-view-diff')) {
      var filePath = target.getAttribute('data-file-path');
      var diffKey = target.getAttribute('data-diff-key');
      var diffIdx = target.getAttribute('data-diff-index');
      if (filePath) {
        vscode.postMessage({ type: 'openDiff', filePath: filePath, diff: (diffKey ? _diffStore.get(diffKey) : undefined) || undefined, diffIndex: diffIdx !== null && diffIdx !== '' ? parseInt(diffIdx) : undefined });
      }
      return;
    }

    if (target.classList.contains('fc-open-file')) {
      var filePath = target.getAttribute('data-file-path');
      if (filePath) {
        vscode.postMessage({ type: 'openFile', filePath: filePath });
      }
      return;
    }

    if (target.classList.contains('fc-revert')) {
      if (target.getAttribute('aria-disabled') === 'true' || target.getAttribute('data-disabled') === 'true') {
        return;
      }
      var filePath = target.getAttribute('data-file-path');
      var changeType = target.getAttribute('data-change-type') || 'modified';
      var diffKey = target.getAttribute('data-diff-key');
      if (filePath) {
        vscode.postMessage({ type: 'revertFileChange', filePath: filePath, changeType: changeType, diff: (diffKey ? _diffStore.get(diffKey) : undefined) || undefined });
      }
      return;
    }

    if (target.classList.contains('work-fc-view-diff')) {
      var filePath = target.getAttribute('data-file-path');
      var diffKey = target.getAttribute('data-diff-key');
      var diffIdx = target.getAttribute('data-diff-index');
      if (filePath) {
        vscode.postMessage({ type: 'openDiff', filePath: filePath, diff: (diffKey ? _diffStore.get(diffKey) : undefined) || undefined, diffIndex: diffIdx !== null && diffIdx !== '' ? parseInt(diffIdx) : undefined });
      }
      return;
    }

    if (target.classList.contains('work-fc-open-file')) {
      var filePath = target.getAttribute('data-file-path');
      if (filePath) {
        vscode.postMessage({ type: 'openFile', filePath: filePath });
      }
      return;
    }

    if (target.classList.contains('thinking-toggle')) {
      toggleThinking(target);
    }

    if (target.classList.contains('btn-allow') || target.classList.contains('btn-deny')) {
      var approvalId = target.getAttribute('data-approval-id');
      var decision = target.getAttribute('data-decision');
      if (approvalId && decision) {
        decideApproval(approvalId, decision);
      }
    }

    if (target.classList.contains('btn-user-input-option')) {
      var inputId = target.getAttribute('data-input-id');
      var questionId = target.getAttribute('data-question-id');
      var optionIdx = target.getAttribute('data-option-idx');
      var optionLabel = target.getAttribute('data-option-label');
      if (inputId && questionId && optionIdx !== null && optionLabel) {
        vscode.postMessage({
          type: 'userInputSelect',
          inputId: inputId,
          questionId: questionId,
          optionIdx: parseInt(optionIdx),
          optionLabel: optionLabel,
        });
      }
    }

    if (target.classList.contains('btn-user-input-cancel')) {
      var inputId = target.getAttribute('data-input-id');
      if (inputId) {
        vscode.postMessage({ type: 'userInputCancel', inputId: inputId });
      }
    }
  });

  // ── Expose for event handler module ──
  window.__wvMessages = {
    addMessage: addMessage,
    renderWelcome: renderWelcome,
    renderToolCall: renderToolCall,
    renderFileChangeCard: renderFileChangeCard,
    smartScrollToBottom: smartScrollToBottom,
    isStreaming: function() { return isStreaming; },
    setStreaming: function(v) { isStreaming = v; },
    getStreamingTimeout: function() { return streamingTimeout; },
    setStreamingTimeout: function(v) { streamingTimeout = v; },
    getUserScrolledUp: function() { return userScrolledUp; },
    setUserScrolledUp: function(v) { userScrolledUp = v; },
  };

  renderWelcome();
  })();`;
}
