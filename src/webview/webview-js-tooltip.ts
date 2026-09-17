/**
 * Webview JS tooltip module — injected into the webview as an IIFE.
 * Provides tooltip positioning, show/hide, and event delegation.
 */
export function getTooltipScript(): string {
  return `(function(){
  'use strict';
  var tooltipEl = document.getElementById('ui-tooltip');
  var activeTooltipTarget = null;

  function getTooltipText(el) {
    if (!el) return '';
    return el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
  }

  function getTooltipTarget(el) {
    return el && el.closest ? el.closest('[data-tooltip], [title]') : null;
  }

  function suppressNativeTitle(el) {
    if (!el) return;
    var currentTitle = el.getAttribute('title');
    if (currentTitle !== null && !el.hasAttribute('data-title-backup')) {
      el.setAttribute('data-title-backup', currentTitle);
      el.removeAttribute('title');
    }
  }

  function restoreNativeTitle(el) {
    if (!el) return;
    var backupTitle = el.getAttribute('data-title-backup');
    if (backupTitle !== null) {
      el.setAttribute('title', backupTitle);
      el.removeAttribute('data-title-backup');
    }
  }

  function positionTooltip(x, y) {
    if (!tooltipEl) return;
    var margin = 10;
    var rect = tooltipEl.getBoundingClientRect();
    var nextX = x + 14;
    var nextY = y + 18;
    if (nextX + rect.width > window.innerWidth - margin) {
      nextX = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (nextY + rect.height > window.innerHeight - margin) {
      nextY = Math.max(margin, y - rect.height - 14);
    }
    tooltipEl.style.left = nextX + 'px';
    tooltipEl.style.top = nextY + 'px';
  }

  function showTooltipForTarget(target, pos) {
    var text = getTooltipText(target);
    if (!tooltipEl || !text) return;
    if (activeTooltipTarget && activeTooltipTarget !== target) {
      restoreNativeTitle(activeTooltipTarget);
    }
    activeTooltipTarget = target;
    suppressNativeTitle(target);
    tooltipEl.textContent = text;
    tooltipEl.classList.add('visible');
    tooltipEl.setAttribute('aria-hidden', 'false');
    positionTooltip(pos.x, pos.y);
  }

  function hideTooltip() {
    if (activeTooltipTarget) {
      restoreNativeTitle(activeTooltipTarget);
    }
    activeTooltipTarget = null;
    if (!tooltipEl) return;
    tooltipEl.classList.remove('visible');
    tooltipEl.setAttribute('aria-hidden', 'true');
  }

  // ── Event delegation for tooltips ──
  document.addEventListener('mouseover', function(e) {
    var target = getTooltipTarget(e.target);
    if (!target) {
      hideTooltip();
      return;
    }
    if (target !== activeTooltipTarget) {
      showTooltipForTarget(target, { x: e.clientX, y: e.clientY });
    }
  });

  document.addEventListener('mousemove', function(e) {
    // Skip while a resize handle is being dragged: repositioning the tooltip
    // on every mousemove forces a synchronous layout read
    // (getBoundingClientRect) that thrashes against the resize handler's
    // width/height writes.
    if (document.body.classList.contains('is-resizing')) return;
    if (activeTooltipTarget) {
      positionTooltip(e.clientX, e.clientY);
    }
  });

  document.addEventListener('mouseout', function(e) {
    if (!activeTooltipTarget) return;
    var relatedTarget = e.relatedTarget;
    if (!relatedTarget || !activeTooltipTarget.contains(relatedTarget)) {
      hideTooltip();
    }
  });

  document.addEventListener('focusin', function(e) {
    var target = getTooltipTarget(e.target);
    if (!target) return;
    var rect = target.getBoundingClientRect();
    showTooltipForTarget(target, {
      x: rect.left + rect.width / 2,
      y: rect.bottom,
    });
  });

  document.addEventListener('focusout', function() {
    hideTooltip();
  });
  })();`;
}
