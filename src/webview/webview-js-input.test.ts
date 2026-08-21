import { describe, it, expect } from "vitest";
import { getInputScript } from "./webview-js-input";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-input.ts", () => {
  it("returns a non-empty string", () => {
    const script = getInputScript(makeTr());
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it("is wrapped in an IIFE", () => {
    const script = getInputScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("'use strict'");
  });

  it("references __wvEscapeHtml from utilities", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("window.__wvEscapeHtml");
  });

  it("references __wvI18n from utilities", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("window.__wvI18n");
  });

  it("contains sendMessage function", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("function sendMessage");
  });

  it("contains slash menu logic", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("slash-menu");
    expect(script).toContain("slashMenuOpen");
  });

  it("contains slash commands array with key commands", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("/mode");
    expect(script).toContain("/model");
    expect(script).toContain("/help");
    expect(script).toContain("/undo");
    expect(script).toContain("/retry");
  });

  it("contains attachment handling", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("currentAttachments");
    expect(script).toContain("attachment-chip");
    expect(script).toContain("btn-attach");
  });

  it("contains API capabilities handling", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("__wvApiCapabilities");
    expect(script).toContain("applyApiCapabilities");
  });

  it("contains button capability state management", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("setButtonCapabilityState");
  });

  it("sends messages via postMessage", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("postMessage");
  });

  it("handles keyboard events for sending", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("keydown");
    expect(script).toContain("Enter");
  });

  it("handles undo button click", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("btn-undo");
    expect(script).toContain("undoLastTurn");
  });

  it("handles retry button click", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("btn-retry");
    expect(script).toContain("retryLastTurn");
  });

  it("handles send/stop button click", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("btn-send-stop");
    expect(script).toContain("interrupt");
  });

  it("handles new thread button click", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("btn-new-thread");
    expect(script).toContain("newThread");
  });

  it("handles compact button click", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("btn-compact");
    expect(script).toContain("compact");
  });

  it("injects slash command descriptions from tr", () => {
    const tr = makeTr({ commandMode: "/mode - Custom mode desc" });
    const script = getInputScript(tr);
    expect(script).toContain("/mode - Custom mode desc");
  });

  it("routes plain text during streaming to steer (TUI steer parity)", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("type: 'steer'");
    // Steering is gated on the runtime capability probe.
    expect(script).toContain("turnSteer");
    // Slash commands other than /interrupt and /clear stay blocked while streaming.
    expect(script).toContain("slashAllowedWhileStreaming");
  });

  it("swaps the input placeholder to the steer hint while streaming", () => {
    const script = getInputScript(makeTr());
    expect(script).toContain("updateInputPlaceholder");
    expect(script).toContain("__i18n.steerPlaceholder");
    expect(script).toContain("inputDefaultPlaceholder");
  });
});
