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
  window.__wvFormatThreadsCount = function(n, type) {
    if (type === 'threads') {
      return __locale === 'zh-cn' ? n + ' \\u4E2A\\u7EBF\\u7A0B' : n + ' thread' + (n !== 1 ? 's' : '');
    }
    return __locale === 'zh-cn' ? n + ' \\u4E2A\\u4F1A\\u8BDD' : n + ' session' + (n !== 1 ? 's' : '');
  };

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
  })();`;
}
