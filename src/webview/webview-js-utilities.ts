/**
 * Webview JS utilities module — shared helper functions injected into the webview.
 * Returns an IIFE-wrapped script string that defines utility functions on the
 * webview's global scope so other modules can use them.
 */
import type { WebviewTranslations } from "./webview-html";

export function getUtilitiesScript(tr: WebviewTranslations): string {
  // Inject the full translation table as JSON so every key added to
  // WebviewTranslations is automatically available to webview modules.
  // `<` is escaped to keep the inline <script> block safe.
  const i18nJson = JSON.stringify(tr).replace(/</g, "\\u003c");
  return `(function(){
  'use strict';
  // ── Locale & i18n ──
  var __locale = '${tr.locale || "en"}';
  var __i18n = ${i18nJson};

  // ── Utility functions ──

  window.__wvFormatLoadedThread = function(title) {
    return __locale === 'zh-cn' ? '\\u5DF2\\u52A0\\u8F7D: ' + title : 'Loaded: ' + title;
  };

  window.__wvEscapeHtml = function(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  window.__wvFormatRelativeTime = function(dateStr) {
    try {
      var d = new Date(dateStr);
      var now = new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return __i18n.justNow;
      if (diffMin < 60) return __i18n.minutesAgoPattern.replace('{n}', String(diffMin));
      var diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return __i18n.hoursAgoPattern.replace('{n}', String(diffHr));
      var diffDay = Math.floor(diffMin / 1440);
      if (diffDay < 30) return __i18n.daysAgoPattern.replace('{n}', String(diffDay));
      return d.toLocaleDateString();
    } catch(e) { return ''; }
  };

  window.__wvI18n = __i18n;
  window.__wvLocale = __locale;

  function __wvPad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Compact elapsed time — 12s, 3m07s, 2h14m — for a running turn and for a
   *  finished one. One formatter serves both so the status bar's clock and the
   *  duration under an answer cannot describe the same length two ways. An
   *  absent or nonsensical value formats to '' and the caller draws nothing. */
  window.__wvFormatElapsed = function(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    var total = Math.floor(ms / 1000);
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    if (hours > 0) return hours + 'h' + __wvPad2(minutes) + 'm';
    if (minutes > 0) return minutes + 'm' + __wvPad2(seconds) + 's';
    return seconds + 's';
  };

  // ── Backdrop dismissal for the modal overlays ──
  // Every overlay here closes when the dimmed area behind its panel is clicked.
  // The click's own target cannot tell such a click from a press that merely
  // *ended* on the backdrop: a click is dispatched on the nearest common
  // ancestor of where the press began and where it was released, so a press
  // inside a panel that leaves the panel before coming up — a drag that slipped
  // past the edge, a text selection pulled past the field, a release outside the
  // window, which resolves to that same in-document ancestor — reports the
  // overlay as its target. Read as "clicked the backdrop", that shuts the dialog
  // on a slipped hand, discarding whatever was typed into it.
  //
  // So the press has to have landed on the backdrop as well, and only the press
  // is consulted: Chromium retargets the release of a drag to whatever the press
  // landed on, so a release that leaves the window is not evidence either way,
  // while the press is exactly the fact that decides it.
  //
  // The guard arms the overlay and returns the question to ask at click time.
  // Arming assigns the property rather than adding a listener, so arming a
  // dialog again on each open replaces the recorder instead of stacking another
  // one on an overlay that outlives every open.
  window.__wvBackdropClickGuard = function(overlay) {
    if (!overlay) return function() { return false; };
    var pressedOnBackdrop = false;
    overlay.onmousedown = function(event) {
      pressedOnBackdrop = !!event && event.target === overlay;
    };
    return function(event) {
      return !!event && event.target === overlay && pressedOnBackdrop;
    };
  };
  })();`;
}
