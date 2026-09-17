/**
 * Webview JS debug/diagnostic module — injected into the webview as an IIFE.
 * Provides _dbg, postUiProbe, postUiDebug, and related diagnostic utilities.
 */
import type { WebviewTranslations } from "./webview-html";

export function getDebugScript(_tr: WebviewTranslations): string {
  return `(function(){
  'use strict';
  // ── Debug / Diagnostic ──
  var _debugMode = false;
  var _debugMessageBudget = 40;
  var _debugEventBudget = 12;

  window.__wvDbg = function(msg) {
    if (!_debugMode) return;
    var panel = document.getElementById('debug-panel');
    if (panel) {
      panel.style.display = 'block';
      var line = document.createElement('div');
      line.textContent = new Date().toLocaleTimeString() + ' ' + msg;
      panel.appendChild(line);
      if (panel.children.length > 50) panel.removeChild(panel.firstChild);
      panel.scrollTop = panel.scrollHeight;
    }
  };

  window.__wvDescribeElement = function(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : String(el.className || ''),
      pointerEvents: cs.pointerEvents,
      position: cs.position,
      display: cs.display,
      visibility: cs.visibility,
      zIndex: cs.zIndex,
    };
  };

  window.__wvProbeHitTarget = function(name, el) {
    if (!el) return { name: name, missing: true };
    var rect = el.getBoundingClientRect();
    var x = Math.round(rect.left + rect.width / 2);
    var y = Math.round(rect.top + rect.height / 2);
    var topEl = document.elementFromPoint(x, y);
    return {
      name: name,
      target: __wvDescribeElement(el),
      center: { x: x, y: y },
      topElement: __wvDescribeElement(topEl),
      containsTopElement: !!(topEl && el.contains(topEl)),
    };
  };

  window.__wvPostUiProbe = function(reason) {
    try {
      var vscode = window.__wvVscode;
      if (!vscode) return;
      vscode.postMessage({
        type: 'debugUiProbe',
        payload: {
          reason: reason,
          activeElement: __wvDescribeElement(document.activeElement),
          visibilityState: document.visibilityState,
          probes: [
            __wvProbeHitTarget('messages', document.getElementById('messages')),
            __wvProbeHitTarget('toolbar', document.getElementById('toolbar')),
            __wvProbeHitTarget('inputArea', document.getElementById('input-area')),
            __wvProbeHitTarget('input', document.getElementById('input')),
            __wvProbeHitTarget('sendStopBtn', document.getElementById('btn-send-stop')),
            __wvProbeHitTarget('threadsBtn', document.getElementById('btn-threads')),
            __wvProbeHitTarget('agentPanelToggle', document.getElementById('agent-panel-toggle')),
            __wvProbeHitTarget('status', document.getElementById('status')),
            __wvProbeHitTarget('taskDetailOverlay', document.getElementById('task-detail-overlay')),
            __wvProbeHitTarget('debugPanel', document.getElementById('debug-panel')),
            __wvProbeHitTarget('slashMenu', document.getElementById('slash-menu')),
          ],
        }
      });
    } catch (e) {
      __wvDbg('postUiProbe failed: ' + (e && e.message ? e.message : e));
    }
  };

  window.__wvPostUiDebug = function(reason, payload) {
    try {
      var vscode = window.__wvVscode;
      if (!vscode) return;
      vscode.postMessage({
        type: 'debugUiProbe',
        payload: Object.assign({ reason: reason }, payload || {})
      });
    } catch (e) {
      __wvDbg('postUiDebug failed: ' + (e && e.message ? e.message : e));
    }
  };

  // ── Global error handlers ──
  window.onerror = function(msg, url, line, col, err) {
    document.title = 'JS_ERROR:' + msg;
    __wvDbg('JS ERROR: ' + msg + ' at line ' + line);
    return false;
  };
  window.addEventListener('unhandledrejection', function(e) {
    document.title = 'PROMISE_ERROR:' + (e.reason && e.reason.message ? e.reason.message : e.reason);
    __wvDbg('PROMISE ERROR: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });

  // ── Debug event listeners (budget-limited) ──
  document.addEventListener('click', function(e) {
    if (_debugEventBudget <= 0) return;
    _debugEventBudget--;
    __wvPostUiDebug('user-click', {
      target: __wvDescribeElement(e.target),
      activeElement: __wvDescribeElement(document.activeElement),
    });
  }, true);

  document.addEventListener('keydown', function(e) {
    if (_debugEventBudget <= 0) return;
    _debugEventBudget--;
    __wvPostUiDebug('user-keydown', {
      key: e.key,
      target: __wvDescribeElement(e.target),
      activeElement: __wvDescribeElement(document.activeElement),
    });
  }, true);

  document.addEventListener('visibilitychange', function() {
    __wvPostUiDebug('visibilitychange', {
      visibilityState: document.visibilityState,
      activeElement: __wvDescribeElement(document.activeElement),
    });
  });

  if (_debugMode) {
    setTimeout(function() {
      __wvDbg('=== DOM DIAGNOSTIC ===');
      __wvPostUiProbe('initial-timeout');
    }, 500);
  }
  })();`;
}
