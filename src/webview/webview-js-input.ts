/**
 * Webview JS input module — injected into the webview as an IIFE.
 * Handles input field, send button, slash menu, attachments, keyboard shortcuts.
 */
import type { WebviewTranslations } from "./webview-html";

export function getInputScript(tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  var __i18n = window.__wvI18n;
  var __wvEscapeHtml = window.__wvEscapeHtml;
  var vscode = window.__wvVscode;
  var inputEl = document.getElementById('input');
  var sendStopBtn = document.getElementById('btn-send-stop');
  var attachBtn = document.getElementById('btn-attach');
  var attachmentsArea = document.getElementById('attachments-area');
  var slashMenuEl = document.getElementById('slash-menu');
  var newThreadBtn = document.getElementById('btn-new-thread');
  var compactBtn = document.getElementById('btn-compact');
  var undoBtn = document.getElementById('btn-undo');
  var retryBtn = document.getElementById('btn-retry');
  var undoDefaultTitle = undoBtn ? (undoBtn.getAttribute('title') || '') : '';
  var retryDefaultTitle = retryBtn ? (retryBtn.getAttribute('title') || '') : '';

  // ── Attachments ──
  var currentAttachments = [];

  function renderAttachments() {
    attachmentsArea.innerHTML = '';
    currentAttachments.forEach(function(att, idx) {
      var chip = document.createElement('span');
      chip.className = 'attachment-chip';
      var icon = att.kind === 'video' ? '\\uD83C\\uDFAC' : att.kind === 'file' ? '\\uD83D\\uDCC4' : '\\uD83D\\uDDBC';
      chip.innerHTML = '<span>' + icon + '</span><span class="attachment-name" title="' + __wvEscapeHtml(att.path) + '">' + __wvEscapeHtml(att.name) + '</span><span class="attachment-remove" data-idx="' + idx + '">\\u2715</span>';
      attachmentsArea.appendChild(chip);
    });
    attachmentsArea.querySelectorAll('.attachment-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        vscode.postMessage({ type: 'removeAttachment', index: idx });
      });
    });
  }

  // ── Slash Menu ──
  var slashMenuOpen = false;
  var slashMenuSelected = 0;
  var slashMenuCommands = [];

  var slashCommands = [
    { name: '/mode', desc: '${tr.commandMode}', category: 'config' },
    { name: '/model', desc: '${tr.commandModel}', category: 'config' },
    { name: '/models', desc: '${tr.commandModels}', category: 'config' },
    { name: '/reasoning', desc: '${tr.commandReasoning}', category: 'config' },
    { name: '/config', desc: '${tr.commandConfig}', category: 'config' },
    { name: '/settings', desc: '${tr.commandSettings}', category: 'config' },
    { name: '/clear', desc: '${tr.commandClear}', category: 'core' },
    { name: '/interrupt', desc: '${tr.commandInterrupt}', category: 'core' },
    { name: '/help', desc: '${tr.commandHelp}', category: 'core' },
    { name: '/compact', desc: '${tr.commandCompact}', category: 'session' },
    { name: '/exit', desc: '${tr.commandExit}', category: 'core' },
    { name: '/rename', desc: '${tr.commandRename}', category: 'session' },
    { name: '/save', desc: '${tr.commandSave}', category: 'session' },
    { name: '/export', desc: '${tr.commandExport}', category: 'session' },
    { name: '/context', desc: '${tr.commandContext}', category: 'debug' },
    { name: '/tokens', desc: '${tr.commandTokens}', category: 'debug' },
    { name: '/cost', desc: '${tr.commandCost}', category: 'debug' },
    { name: '/status', desc: '${tr.commandStatus}', category: 'debug' },
    { name: '/home', desc: '${tr.commandHome}', category: 'core' },
    { name: '/workspace', desc: '${tr.commandWorkspace}', category: 'config' },
    { name: '/task', desc: '${tr.commandTask}', category: 'core' },
    { name: '/jobs', desc: '${tr.commandJobs}', category: 'core' },
    { name: '/note', desc: '${tr.commandNote}', category: 'core' },
    { name: '/memory', desc: '${tr.commandMemory}', category: 'core' },
    { name: '/trust', desc: '${tr.commandTrust}', category: 'config' },
    { name: '/verbose', desc: '${tr.commandVerbose}', category: 'config' },
    { name: '/theme', desc: '${tr.commandTheme}', category: 'unavailable' },
    { name: '/undo', desc: '${tr.commandUndo}', category: 'session' },
    { name: '/retry', desc: '${tr.commandRetry}', category: 'session' },
    { name: '/share', desc: '${tr.commandShare}', category: 'session' },
    { name: '/goal', desc: '${tr.commandGoal}', category: 'core' },
    { name: '/skills', desc: '${tr.commandSkills}', category: 'skills' },
    { name: '/skill', desc: '${tr.commandSkill}', category: 'skills' },
    { name: '/mcp', desc: '${tr.commandMcp}', category: 'config' },
    { name: '/network', desc: '${tr.commandNetwork}', category: 'config' },
    { name: '/provider', desc: '${tr.commandProvider}', category: 'config' },
    { name: '/queue', desc: '${tr.commandQueue}', category: 'core' },
    { name: '/stash', desc: '${tr.commandStash}', category: 'core' },
    { name: '/hooks', desc: '${tr.commandHooks}', category: 'core' },
    { name: '/subagents', desc: '${tr.commandSubagents}', category: 'core' },
    { name: '/agent', desc: '${tr.commandAgent}', category: 'core' },
    { name: '/links', desc: '${tr.commandLinks}', category: 'core' },
    { name: '/feedback', desc: '${tr.commandFeedback}', category: 'core' },
    { name: '/attach', desc: '${tr.commandAttach}', category: 'core' },
    { name: '/anchor', desc: '${tr.commandAnchor}', category: 'core' },
    { name: '/sessions', desc: '${tr.commandSessions}', category: 'session' },
    { name: '/load', desc: '${tr.commandLoad}', category: 'session' },
    { name: '/cycles', desc: '${tr.commandCycles}', category: 'session' },
    { name: '/cycle', desc: '${tr.commandCycle}', category: 'session' },
    { name: '/recall', desc: '${tr.commandRecall}', category: 'session' },
    { name: '/relay', desc: '${tr.commandRelay}', category: 'core' },
    { name: '/init', desc: '${tr.commandInit}', category: 'config' },
    { name: '/lsp', desc: '${tr.commandLsp}', category: 'config' },
    { name: '/review', desc: '${tr.commandReview}', category: 'skills' },
    { name: '/restore', desc: '${tr.commandRestore}', category: 'session' },
    { name: '/rlm', desc: '${tr.commandRlm}', category: 'core' },
    { name: '/change', desc: '${tr.commandChange}', category: 'core' },
    { name: '/cache', desc: '${tr.commandCache}', category: 'debug' },
    { name: '/profile', desc: '${tr.commandProfile}', category: 'config' },
    { name: '/translate', desc: '${tr.commandTranslate}', category: 'debug' },
    { name: '/system', desc: '${tr.commandSystem}', category: 'debug' },
    { name: '/edit', desc: '${tr.commandEdit}', category: 'session' },
    { name: '/diff', desc: '${tr.commandDiff}', category: 'debug' },
    { name: '/statusline', desc: '${tr.commandStatusline}', category: 'debug' },
    { name: '/logout', desc: '${tr.commandLogout}', category: 'config' },
  ];

  function updateSlashMenu(input) {
    if (!input.startsWith('/')) {
      slashMenuEl.classList.remove('open');
      slashMenuOpen = false;
      return;
    }

    var query = input.toLowerCase();
    slashMenuCommands = slashCommands.filter(function(cmd) {
      return cmd.name.toLowerCase().startsWith(query) || cmd.desc.toLowerCase().includes(query.slice(1));
    });

    if (slashMenuCommands.length === 0) {
      slashMenuEl.classList.remove('open');
      slashMenuOpen = false;
      return;
    }

    var menuHtml = slashMenuCommands.map(function(cmd, i) {
      return '<div class="slash-menu-item' + (i === slashMenuSelected ? ' selected' : '') + '" data-index="' + i + '">' +
        '<span class="command-name">' + __wvEscapeHtml(cmd.name) + '</span>' +
        '<span class="command-desc">' + __wvEscapeHtml(cmd.desc) + '</span>' +
        '</div>';
    }).join('');

    slashMenuEl.innerHTML = menuHtml;

    var rect = inputEl.getBoundingClientRect();
    slashMenuEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    slashMenuEl.style.left = rect.left + 'px';
    slashMenuEl.style.width = rect.width + 'px';

    slashMenuEl.classList.add('open');
    slashMenuOpen = true;
  }

  function applySlashCommand(index) {
    if (index >= 0 && index < slashMenuCommands.length) {
      var cmd = slashMenuCommands[index];
      inputEl.value = cmd.name + ' ';
      inputEl.focus();
      slashMenuEl.classList.remove('open');
      slashMenuOpen = false;
    }
  }

  slashMenuEl.addEventListener('click', function(e) {
    var item = e.target.closest('.slash-menu-item');
    if (item) {
      var index = parseInt(item.getAttribute('data-index'));
      applySlashCommand(index);
    }
  });

  // ── Send Message ──
  function steerCapable() {
    var caps = window.__wvApiCapabilities || {};
    return !!caps.turnSteer;
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    var isStreaming = window.__wvMessages.isStreaming();
    if (!text && currentAttachments.length === 0) return;
    var isSlash = text.startsWith('/');
    var slashAllowedWhileStreaming = text.startsWith('/interrupt') || text.startsWith('/clear');
    var canSteer = isStreaming && steerCapable();
    if (isStreaming && isSlash && !slashAllowedWhileStreaming) return;
    if (isStreaming && !isSlash && !canSteer) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    window.__wvMessages.setUserScrolledUp(false);
    messageHistory.unshift(text);
    if (messageHistory.length > 200) messageHistory.length = 200;
    historyIndex = -1;
    draftBeforeHistory = '';

    if (isSlash) {
      var parts = text.split(' ');
      var command = parts[0].toLowerCase();
      var args = parts.slice(1).join(' ');
      vscode.postMessage({ type: 'slashCommand', command: command, args: args });
    } else if (canSteer) {
      // Mid-turn steering: plain text during a running turn guides the
      // active turn instead of starting a new one (TUI steer parity).
      vscode.postMessage({ type: 'steer', text: text });
    } else {
      vscode.postMessage({ type: 'sendMessage', text: text });
    }
  }

  // ── Button capability state ──
  function setButtonCapabilityState(btn, enabled, enabledTitle, disabledTitle) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.toggle('is-unavailable', !enabled);
    btn.setAttribute('data-tooltip', enabled ? enabledTitle : disabledTitle);
    btn.setAttribute('data-disabled', enabled ? 'false' : 'true');
    btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function applyApiCapabilities() {
    var apiCapabilities = window.__wvApiCapabilities || {};
    setButtonCapabilityState(undoBtn, !!apiCapabilities.undoLastTurn, undoDefaultTitle, __i18n.undoUnsupportedTooltip);
    setButtonCapabilityState(retryBtn, !!apiCapabilities.retryLastTurn, retryDefaultTitle, __i18n.retryUnsupportedTooltip);
    updateInputPlaceholder();
  }

  // ── Input placeholder: steer hint while a turn is running ──
  var inputDefaultPlaceholder = inputEl.getAttribute('placeholder') || '';

  function updateInputPlaceholder() {
    var isStreaming = !!(window.__wvMessages && window.__wvMessages.isStreaming());
    var steerHint = (__i18n && __i18n.steerPlaceholder) || inputDefaultPlaceholder;
    if (isStreaming && steerCapable()) {
      inputEl.setAttribute('placeholder', steerHint);
    } else {
      inputEl.setAttribute('placeholder', inputDefaultPlaceholder);
    }
  }

  // ── Send/Stop button toggle ──
  function updateSendStopButton(isStreaming) {
    if (!sendStopBtn) return;
    if (isStreaming) {
      sendStopBtn.classList.add('streaming');
    } else {
      sendStopBtn.classList.remove('streaming');
    }
    updateInputPlaceholder();
  }

  // ── Event listeners ──
  sendStopBtn.addEventListener('click', function() {
    if (window.__wvMessages && window.__wvMessages.isStreaming()) {
      vscode.postMessage({ type: 'interrupt' });
    } else {
      sendMessage();
    }
  });
  attachBtn.addEventListener('click', function() { vscode.postMessage({ type: 'attachFile' }); });

  var isComposing = false;
  inputEl.addEventListener('compositionstart', function() { isComposing = true; });
  inputEl.addEventListener('compositionend', function() { isComposing = false; });

  var messageHistory = [];
  var historyIndex = -1;
  var draftBeforeHistory = '';

  inputEl.addEventListener('keydown', function(e) {
    if (isComposing) return;
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuSelected = Math.min(slashMenuSelected + 1, slashMenuCommands.length - 1);
        updateSlashMenu(inputEl.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuSelected = Math.max(slashMenuSelected - 1, 0);
        updateSlashMenu(inputEl.value);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySlashCommand(slashMenuSelected);
      } else if (e.key === 'Escape') {
        slashMenuEl.classList.remove('open');
        slashMenuOpen = false;
      }
      return;
    }

    if (e.key === 'ArrowUp' && messageHistory.length > 0) {
      var pos = inputEl.selectionStart;
      if (pos === 0) {
        e.preventDefault();
        if (historyIndex === -1) {
          draftBeforeHistory = inputEl.value;
        }
        historyIndex = Math.min(historyIndex + 1, messageHistory.length - 1);
        inputEl.value = messageHistory[historyIndex];
        inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        return;
      }
    } else if (e.key === 'ArrowDown' && historyIndex !== -1) {
      var len = inputEl.value.length;
      var pos = inputEl.selectionStart;
      if (pos === len) {
        e.preventDefault();
        historyIndex--;
        if (historyIndex === -1) {
          inputEl.value = draftBeforeHistory;
        } else {
          inputEl.value = messageHistory[historyIndex];
        }
        inputEl.selectionStart = inputEl.selectionEnd = 0;
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    slashMenuSelected = 0;
    updateSlashMenu(inputEl.value);
  });

  newThreadBtn.addEventListener('click', function() { vscode.postMessage({ type: 'newThread' }); });
  compactBtn.addEventListener('click', function() { vscode.postMessage({ type: 'compact' }); });
  undoBtn.addEventListener('click', function() {
    if (undoBtn.getAttribute('aria-disabled') === 'true') return;
    vscode.postMessage({ type: 'undoLastTurn' });
  });
  retryBtn.addEventListener('click', function() {
    if (retryBtn.getAttribute('aria-disabled') === 'true') return;
    vscode.postMessage({ type: 'retryLastTurn' });
  });

  // ── Expose for event handler module ──
  window.__wvInput = {
    applyApiCapabilities: applyApiCapabilities,
    renderAttachments: renderAttachments,
    getCurrentAttachments: function() { return currentAttachments; },
    setCurrentAttachments: function(v) { currentAttachments = v; },
    updateSendStopButton: updateSendStopButton,
  };

  applyApiCapabilities();
  })();`;
}
