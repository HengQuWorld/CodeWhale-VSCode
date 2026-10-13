import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { getUtilitiesScript } from "./webview-js-utilities";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-utilities.ts", () => {
  it("returns a non-empty string", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it("is wrapped in an IIFE", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script).toContain("'use strict'");
  });

  it("defines __wvEscapeHtml on window", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script).toContain("window.__wvEscapeHtml");
  });

  it("defines __wvFormatRelativeTime on window", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script).toContain("window.__wvFormatRelativeTime");
  });

  it("injects locale from translations", () => {
    const scriptEn = getUtilitiesScript(makeTr({ locale: "en" }));
    expect(scriptEn).toContain("var __locale = 'en'");

    const scriptZh = getUtilitiesScript(makeTr({ locale: "zh-cn" }));
    expect(scriptZh).toContain("var __locale = 'zh-cn'");
  });

  it("injects i18n translations", () => {
    const tr = makeTr({ error: "CustomError", note: "CustomNote" });
    const script = getUtilitiesScript(tr);
    expect(script).toContain("CustomError");
    expect(script).toContain("CustomNote");
  });

  it("injects steer translations into __wvI18n (input placeholder relies on them)", () => {
    const tr = makeTr({ steerPlaceholder: "Steer the running turn...", steerBadge: "steer", steerBadgeTitle: "Sent as mid-turn steering" });
    const script = getUtilitiesScript(tr);
    expect(script).toContain("Steer the running turn...");
    expect(script).toContain("steerPlaceholder");
    expect(script).toContain("Sent as mid-turn steering");
  });

  it("injects the full translation table as JSON (new keys stay in sync automatically)", () => {
    const tr = makeTr({ fleetCreate: "Create Fleet run", goalNoGoal: "No goal yet" });
    const script = getUtilitiesScript(tr);
    expect(script).toContain('"fleetCreate":"Create Fleet run"');
    expect(script).toContain('"goalNoGoal":"No goal yet"');
  });

  it("escapes < in the injected JSON so the inline script block stays valid", () => {
    const tr = makeTr({ note: "a<b" });
    const script = getUtilitiesScript(tr);
    expect(script).toContain("\\u003cb");
  });

  it("escapeHtml function handles special characters", () => {
    const script = getUtilitiesScript(makeTr());
    // The function should handle &, <, >, ", '
    expect(script).toContain("&amp;");
    expect(script).toContain("&lt;");
    expect(script).toContain("&gt;");
  });

  it("formatRelativeTime handles all time patterns", () => {
    const tr = makeTr({
      justNow: "just now",
      minutesAgoPattern: "{n} min ago",
      hoursAgoPattern: "{n}h ago",
      daysAgoPattern: "{n}d ago",
    });
    const script = getUtilitiesScript(tr);
    expect(script).toContain("just now");
    expect(script).toContain("{n} min ago");
    expect(script).toContain("{n}h ago");
    expect(script).toContain("{n}d ago");
  });

  it("contains error boundary try/catch", () => {
    const script = getUtilitiesScript(makeTr());
    expect(script).toContain("try");
    expect(script).toContain("catch");
  });

  it("does not contain unescaped template literal syntax", () => {
    const script = getUtilitiesScript(makeTr());
    // Should not have raw ${...} that would break in the IIFE string
    // The IIFE is returned as a string, so ${...} inside it would be interpreted
    // by the outer template literal in getUtilitiesScript
    expect(script).not.toContain("window.__wvEscapeHtml = ${");
  });
});

describe("__wvBackdropClickGuard", () => {
  /** Run the utilities IIFE and hand back its window, the way the webview does. */
  function runUtilities(): any {
    const windowObj: Record<string, any> = {};
    vm.runInContext(getUtilitiesScript(makeTr()), vm.createContext({ window: windowObj }));
    return windowObj;
  }

  /** A stand-in for the overlay element: only the identity comparison the guard
   *  performs matters, so a bare object is enough. */
  function overlay(): any {
    return {};
  }

  it("dismisses a click that begins and ends on the backdrop", () => {
    const windowObj = runUtilities();
    const element = overlay();
    const isBackdropClick = windowObj.__wvBackdropClickGuard(element);

    element.onmousedown({ target: element });

    expect(isBackdropClick({ target: element })).toBe(true);
  });

  it("does not dismiss when the press started inside the panel", () => {
    // The reported bug: a press held down inside the dialog and released after
    // the pointer left it reports the overlay as the click's target — it is the
    // nearest common ancestor of the two ends — so the target alone cannot
    // decide. The press can, and it landed on the panel.
    const windowObj = runUtilities();
    const element = overlay();
    const panel = {};
    const isBackdropClick = windowObj.__wvBackdropClickGuard(element);

    element.onmousedown({ target: panel });

    expect(isBackdropClick({ target: element })).toBe(false);
  });

  it("does not dismiss on a click that ends inside the panel", () => {
    const windowObj = runUtilities();
    const element = overlay();
    const panel = {};
    const isBackdropClick = windowObj.__wvBackdropClickGuard(element);

    element.onmousedown({ target: element });

    expect(isBackdropClick({ target: panel })).toBe(false);
  });

  it("forgets the previous gesture, so one backdrop click cannot arm the next", () => {
    const windowObj = runUtilities();
    const element = overlay();
    const panel = {};
    const isBackdropClick = windowObj.__wvBackdropClickGuard(element);

    element.onmousedown({ target: element });
    element.onmousedown({ target: panel });

    expect(isBackdropClick({ target: element })).toBe(false);
  });

  it("arms again for a reopened dialog instead of stacking recorders", () => {
    // The overlays outlive every open, so a guard that added a listener would
    // pile one up per open. Arming assigns the recorder, so the newest wins.
    const windowObj = runUtilities();
    const element = overlay();
    const first = windowObj.__wvBackdropClickGuard(element);
    const second = windowObj.__wvBackdropClickGuard(element);

    element.onmousedown({ target: element });

    expect(second({ target: element })).toBe(true);
    // The earlier guard keeps its own state, but nothing reads it any more.
    expect(typeof first).toBe("function");
  });

  it("answers false for a missing overlay rather than throwing", () => {
    const windowObj = runUtilities();
    const isBackdropClick = windowObj.__wvBackdropClickGuard(null);
    expect(isBackdropClick({ target: {} })).toBe(false);
    expect(isBackdropClick(undefined)).toBe(false);
  });
});
