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

  it("hides the sidebar resize grip while the threads panel is collapsed", () => {
    const css = getWebviewCss();

    // The grip must not exist for dragging when the threads panel is closed.
    const ruleStart = css.indexOf("#sidebar-resize-handle {");
    const ruleEnd = css.indexOf("}", ruleStart);
    const handleRule = css.slice(ruleStart, ruleEnd);

    expect(handleRule).toContain("display: none;");
    expect(css).toContain("#threads-panel.open + #sidebar-resize-handle {");
    expect(css).toContain("display: block;");
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

  it("bounds the tool input command block so long scripts scroll instead of overflowing", () => {
    const css = getWebviewCss();
    const match = css.match(/\.tool-input-command\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("max-height");
    expect(match![1]).toContain("overflow-y: auto");
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
    expect(css).toContain("#input-box");
    expect(css).toContain("#input-toolbar");
  });

  it("lays the composer out as a textarea above a bottom toolbar", () => {
    const css = getWebviewCss();

    // The composer stacks its textarea above the action toolbar.
    expect(css).toContain("#input-box {");
    expect(css).toContain("#input-toolbar {");
    expect(css).toContain("flex-direction: column;");
    // Send is pushed to the far right, so left-side buttons flow from the left.
    expect(css).toContain("margin-left: auto;");
  });

  it("sizes the composer by its content and never lets it be squeezed", () => {
    const css = getWebviewCss();
    const boxRule = css.slice(
      css.indexOf("#input-box {"),
      css.indexOf("}", css.indexOf("#input-box {"))
    );

    // flex-basis: auto keeps the border wrapped around the textarea plus the
    // toolbar, and flex-shrink: 0 means a short input area cannot push the
    // toolbar out of the box.
    expect(boxRule).toContain("flex: 1 0 auto;");
    // A zero basis (or min-height: 0) made the box collapse while the text and
    // the toolbar overflowed outside its border.
    expect(boxRule).not.toContain("min-height: 0;");
  });

  it("gives the textarea a hardcoded two-row floor and scrolls the overflow", () => {
    const css = getWebviewCss();
    const taRule = css.slice(
      css.indexOf("#input-area textarea {"),
      css.indexOf("}", css.indexOf("#input-area textarea {"))
    );

    // Roughly two rows, a little taller than the toolbar: the composer's own
    // floor is this plus the toolbar.
    expect(taRule).toContain("min-height: 52px;");
    // Text past the chosen height scrolls inside the box.
    expect(taRule).toContain("overflow-y: auto;");
    expect(taRule).toContain("scrollbar-width: none;");
  });

  it("shows exactly one send/stop icon at a time", () => {
    const css = getWebviewCss();

    // Both icon rules are scoped to #input-toolbar, so they carry the same
    // specificity as the streaming overrides, which therefore win.
    expect(css).toContain("#input-toolbar .btn-send-stop .btn-icon-send { display: block;");
    expect(css).toContain("#input-toolbar .btn-send-stop .btn-icon-stop { display: none;");
    expect(css).toContain(".btn-send-stop.streaming .btn-icon-send { display: none; }");
    expect(css).toContain(".btn-send-stop.streaming .btn-icon-stop { display: block; }");
    // Regression: a generic `svg` rule carrying two ids outranked the per-icon
    // rules, so send and stop rendered side by side.
    expect(css).not.toContain("svg { display: block; }");
  });

  it("styles the image attachment thumbnail", () => {
    const css = getWebviewCss();
    expect(css).toContain(".attachment-chip.has-thumb");
    expect(css).toContain(".attachment-thumb");
    expect(css).toContain("object-fit: cover");
  });

  it("styles the file-drag highlight", () => {
    const css = getWebviewCss();
    expect(css).toContain("body.drag-over::after");
    expect(css).toContain("pointer-events: none");
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
