import { describe, it, expect } from "vitest";
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
    expect(script).toContain("steerPlaceholder: 'Steer the running turn...'");
    expect(script).toContain("steerBadge: 'steer'");
    expect(script).toContain("steerBadgeTitle: 'Sent as mid-turn steering'");
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
