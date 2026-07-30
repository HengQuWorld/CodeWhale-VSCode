import { describe, it, expect } from "vitest";
import { getWebviewCss } from "./webview-css";

describe("webview-css.ts", () => {
  it("returns a non-empty string", () => {
    const css = getWebviewCss();
    expect(css).toBeTruthy();
    expect(css.length).toBeGreaterThan(100);
  });

  it("contains CSS variable definitions", () => {
    const css = getWebviewCss();
    expect(css).toContain("--bg:");
    expect(css).toContain("--fg:");
    expect(css).toContain("--brand-primary:");
    expect(css).toContain("--brand-primary-light:");
  });

  it("contains dark mode media query", () => {
    const css = getWebviewCss();
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  it("contains VS Code dark theme override", () => {
    const css = getWebviewCss();
    expect(css).toContain('body[data-vscode-theme-kind="vscode-dark"]');
  });

  it("contains key layout selectors", () => {
    const css = getWebviewCss();
    expect(css).toContain("#layout");
    expect(css).toContain("#threads-panel");
    expect(css).toContain("#sidebar-resize-handle");
    expect(css).toContain("#input-resize-handle");
    expect(css).toContain("#chat-area");
    expect(css).toContain("#messages");
    expect(css).toContain("#input-area");
    expect(css).toContain("#toolbar");
    expect(css).toContain("#settings-bar");
    expect(css).toContain("#slash-menu");
    expect(css).toContain("#ui-tooltip");
  });

  it("contains message styling", () => {
    const css = getWebviewCss();
    expect(css).toContain(".message");
    expect(css).toContain(".message.user");
    expect(css).toContain(".message.assistant");
    expect(css).toContain(".thinking-block");
    expect(css).toContain(".tool-call");
    expect(css).toContain(".file-change-card");
    expect(css).toContain(".approval-bar");
  });

  it("contains welcome screen styles", () => {
    const css = getWebviewCss();
    expect(css).toContain(".welcome-screen");
    expect(css).toContain(".welcome-brand");
    expect(css).toContain(".welcome-suggestion");
  });

  it("contains status bar styles", () => {
    const css = getWebviewCss();
    expect(css).toContain(".status-bar");
    expect(css).toContain(".stat-chip");
  });

  it("contains sidebar styles", () => {
    const css = getWebviewCss();
    expect(css).toContain(".sidebar-section");
    expect(css).toContain(".sidebar-tab");
    expect(css).toContain(".thread-item");
    expect(css).toContain(".task-toolbar");
    expect(css).toContain(".task-icon-btn");
    expect(css).toContain(".task-create-panel");
    expect(css).toContain(".task-card");
    expect(css).toContain(".task-attention-badge");
    expect(css).toContain(".work-section");
  });

  it("contains input and attachment styles", () => {
    const css = getWebviewCss();
    expect(css).toContain(".attachment-chip");
    expect(css).toContain("#input-row");
  });

  it("contains unavailable button styles", () => {
    const css = getWebviewCss();
    expect(css).toContain(".is-unavailable");
    expect(css).toContain('[aria-disabled="true"]');
  });

  it("does not contain template literal syntax", () => {
    const css = getWebviewCss();
    expect(css).not.toContain("${");
  });
});
