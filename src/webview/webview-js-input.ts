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

  // Thumbnails arrive once, keyed by attachment id, in their own message: the
  // attachment list itself never carries the base64 payload, because a 5 MiB
  // image is a ~6.7 MiB string and the list is republished on every change.
  // Cached here so re-rendering a chip never needs the bytes again.
  var previewCache = {};

  function setAttachmentPreview(id, previewUrl) {
    if (!id || typeof previewUrl !== 'string') return;
    previewCache[id] = previewUrl;
  }

  function renderAttachments() {
    attachmentsArea.innerHTML = '';
    var liveIds = {};
    currentAttachments.forEach(function(att, idx) {
      var chip = document.createElement('span');
      chip.className = 'attachment-chip';
      if (att.previewUrl && att.id) previewCache[att.id] = att.previewUrl;
      if (att.id) liveIds[att.id] = true;
      var previewUrl = att.previewUrl || (att.id ? previewCache[att.id] : '');
      if (att.kind === 'image' && previewUrl) {
        // Inline data URL: the file lives outside the workspace, so this needs
        // no webview resource permissions (CSP allows img-src data:).
        chip.classList.add('has-thumb');
        chip.innerHTML = '<img class="attachment-thumb" alt="" src="' + __wvEscapeHtml(previewUrl) + '">' +
          '<span class="attachment-name" title="' + __wvEscapeHtml(att.path) + '">' + __wvEscapeHtml(att.name) + '</span>' +
          '<span class="attachment-remove" data-idx="' + idx + '">\\u2715</span>';
      } else {
        var icon = att.kind === 'video' ? '\\uD83C\\uDFAC' : att.kind === 'file' ? '\\uD83D\\uDCC4' : '\\uD83D\\uDDBC';
        chip.innerHTML = '<span>' + icon + '</span><span class="attachment-name" title="' + __wvEscapeHtml(att.path) + '">' + __wvEscapeHtml(att.name) + '</span><span class="attachment-remove" data-idx="' + idx + '">\\u2715</span>';
      }
      attachmentsArea.appendChild(chip);
    });
    attachmentsArea.querySelectorAll('.attachment-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        vscode.postMessage({ type: 'removeAttachment', index: idx });
      });
    });
    // Drop cached thumbnails for attachments that are gone, so a long session
    // that sends and clears cannot accumulate them.
    Object.keys(previewCache).forEach(function(id) {
      if (!liveIds[id]) delete previewCache[id];
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

  // ── Pasted / dropped images (TUI clipboard.rs parity) ──
  // The blob is base64'd here and persisted by the extension host under
  // ~/.codewhale/clipboard-images/, then re-enters through the normal
  // attachment flow as an [Attached image: <path>] placeholder line.
  // Only mimes the engine accepts; the host re-validates bytes and size.
  var IMAGE_MIME_RE = /^image\\/(png|jpeg|gif|webp)$/;

  function sendImageFile(file) {
    var reader = new FileReader();
    reader.onload = function() {
      vscode.postMessage({ type: 'attachImage', mime: file.type, dataUrl: reader.result, name: file.name });
    };
    reader.readAsDataURL(file);
  }

  // OS file drops (Finder / Explorer) carry File blobs, not workspace paths.
  // Non-image bytes are base64'd to the host, persisted under
  // ~/.codewhale/dropped-files/, and re-enter as a normal file attachment —
  // the same @path mention the attach-file button produces. The transport
  // cap keeps oversized drops from serialising through postMessage.
  var MAX_DROP_FILE_BYTES = 50 * 1024 * 1024;

  function sendDroppedFileBlob(file) {
    if (file.size > MAX_DROP_FILE_BYTES) {
      vscode.postMessage({ type: 'dropTooLarge', name: file.name, size: file.size });
      return;
    }
    var reader = new FileReader();
    reader.onload = function() {
      vscode.postMessage({ type: 'attachFileBlob', dataUrl: reader.result, name: file.name });
    };
    reader.readAsDataURL(file);
  }

  inputEl.addEventListener('paste', function(e) {
    try {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file' && IMAGE_MIME_RE.test(item.type)) {
          e.preventDefault();
          var file = item.getAsFile();
          if (file) sendImageFile(file);
        }
      }
    } catch (err) { /* image paste must never break text paste */ }
  });

  // Drag & drop is document-level: the whole webview is a drop target, not
  // just the input. dragover must preventDefault unconditionally or
  // Chromium refuses to fire drop at all — the gate only decides whether
  // the drag is "file-ish" (for the copy cursor and the highlight).
  function dragHasPayload(e) {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    var types = e.dataTransfer.types;
    for (var i = 0; i < types.length; i++) {
      if (
        types[i] === 'Files' ||
        types[i] === 'text/uri-list' ||
        types[i] === 'text/plain' ||
        types[i] === 'text'
      ) return true;
    }
    return false;
  }

  function stopFileDragEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  function getDroppedFiles(dataTransfer) {
    var files = [];
    if (!dataTransfer) return files;
    if (dataTransfer.files && dataTransfer.files.length > 0) {
      for (var i = 0; i < dataTransfer.files.length; i++) files.push(dataTransfer.files[i]);
    }
    // Some VS Code / Chromium drags expose file items without populating the
    // FileList on drop, so scan items too.
    if (dataTransfer.items && dataTransfer.items.length > 0) {
      for (var j = 0; j < dataTransfer.items.length; j++) {
        var item = dataTransfer.items[j];
        if (!item || item.kind !== 'file') continue;
        var file = item.getAsFile && item.getAsFile();
        if (!file) continue;
        var duplicate = false;
        for (var k = 0; k < files.length; k++) {
          if (
            files[k].name === file.name &&
            files[k].size === file.size &&
            files[k].type === file.type &&
            files[k].lastModified === file.lastModified
          ) {
            duplicate = true;
            break;
          }
        }
        if (!duplicate) files.push(file);
      }
    }
    return files;
  }

  // text/uri-list is the file-drag protocol and is trusted outright, comment
  // lines and all. text/plain is not a file protocol: prose and code
  // selections arrive there too, and a snippet whose first line starts with
  // '/' is not a path. Such a drop must keep its default text insert instead
  // of being swallowed as an attach that then fails.
  function looksLikeFilePathText(text) {
    if (!text) return false;
    // Whitespace is the discriminator, not a law about paths: a dropped text
    // selection is usually multi-word prose. The price is that a text-dropped
    // path *containing* spaces stays text — Finder / Explorer drops arrive
    // via uri-list / Files and are unaffected.
    if (/\\s/.test(text)) return false;
    if (text.indexOf('file:') === 0) return true;
    if (!(text.charAt(0) === '/' || text.indexOf('~/') === 0 || /^[a-zA-Z]:[\\\\/]/.test(text))) {
      return false;
    }
    // Require a filename-ish last segment, so '/mode' or '/api/v1' stays text.
    var base = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\\\')) + 1);
    return base.indexOf('.') >= 0;
  }

  function getDroppedPathCandidates(dataTransfer) {
    var candidates = [];
    if (!dataTransfer) return candidates;
    var uriList = dataTransfer.getData('text/uri-list') || '';
    var uriCandidates = uriList.split(/\\r?\\n/).filter(function(line) {
      return line && line.charAt(0) !== '#';
    });
    for (var i = 0; i < uriCandidates.length; i++) {
      if (candidates.indexOf(uriCandidates[i]) < 0) candidates.push(uriCandidates[i]);
    }
    if (candidates.length > 0) return candidates;
    var plain = (
      dataTransfer.getData('text/plain') ||
      dataTransfer.getData('text') ||
      ''
    ).trim();
    if (looksLikeFilePathText(plain)) candidates.push(plain);
    return candidates;
  }

  function handleDropPayload(e) {
    if (!e.dataTransfer) return;

    // Prefer uri-list / text paths from the editor: they preserve the original
    // workspace path and align exactly with the attach-file button behavior.
    var pathCandidates = getDroppedPathCandidates(e.dataTransfer);
    if (pathCandidates.length > 0) {
      stopFileDragEvent(e);
      vscode.postMessage({ type: 'attachPaths', uris: pathCandidates });
      return;
    }

    // 1) OS file drops (Finder / Explorer): File blobs without paths.
    //    Inline-able images attach directly; every other file (PDF, docs,
    //    videos, …) rides the attachFileBlob path so drops match the
    //    attach-file button. Swallow the browser default (navigating the
    //    webview to the file) regardless.
    var files = getDroppedFiles(e.dataTransfer);
    if (files.length > 0) {
      stopFileDragEvent(e);
      for (var i = 0; i < files.length; i++) {
        if (IMAGE_MIME_RE.test(files[i].type)) {
          sendImageFile(files[i]);
        } else {
          sendDroppedFileBlob(files[i]);
        }
      }
      return;
    }
  }

  function handleFileDragEnter(e) {
    if (!dragHasPayload(e)) return;
    stopFileDragEvent(e);
    document.body.classList.add('drag-over');
  }

  function handleFileDragOver(e) {
    if (!dragHasPayload(e)) return;
    stopFileDragEvent(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function handleFileDragLeave(e) {
    if (!dragHasPayload(e)) return;
    if (!e.relatedTarget) document.body.classList.remove('drag-over');
  }

  function handleFileDrop(e) {
    try {
      document.body.classList.remove('drag-over');
      if (!dragHasPayload(e)) return;
      handleDropPayload(e);
    } catch (err) { /* image drop must never break the input */ }
  }

  // Capture phase is important here: VS Code / Chromium may let the textarea
  // or host shell consume the drop first, which leaves us with a focused input
  // but no attachment event.
  window.addEventListener('dragenter', handleFileDragEnter, true);
  window.addEventListener('dragover', handleFileDragOver, true);
  window.addEventListener('dragleave', handleFileDragLeave, true);
  window.addEventListener('drop', handleFileDrop, true);
  document.addEventListener('dragenter', handleFileDragEnter);
  document.addEventListener('dragover', handleFileDragOver);
  document.addEventListener('dragleave', handleFileDragLeave);
  document.addEventListener('drop', handleFileDrop);

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
    setAttachmentPreview: setAttachmentPreview,
    updateSendStopButton: updateSendStopButton,
  };

  applyApiCapabilities();
  })();`;
}
