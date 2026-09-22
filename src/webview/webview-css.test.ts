import { describe, it, expect } from "vitest";
import { getWebviewCss } from "./webview-css";

describe("webview-css.ts", () => {
  it("returns a non-empty string", () => {
    const css = getWebviewCss();
    expect(css).toBeTruthy();
    expect(css.length).toBeGreaterThan(100);
  });

  it("keeps the steer button hidden until a turn can take guidance", () => {
    const css = getWebviewCss();

    // Revealed by the class the input module adds; the box ships it hidden, so
    // an idle composer looks exactly as it did.
    expect(css).toMatch(/#input-toolbar #btn-steer \{[\s\S]*?display: none;/);
    expect(css).toContain("#input-toolbar #btn-steer.is-active { display: flex; }");
    expect(css).toContain("#input-toolbar .btn-steer .btn-icon-steer");
    // Dim, and staying dim under the cursor: the composer's generic hover rule
    // would otherwise light it up and read as a working control.
    expect(css).toMatch(/#input-toolbar #btn-steer\[aria-disabled="true"\]/);
    expect(css).toContain('#input-toolbar #btn-steer[aria-disabled="true"]:hover');
  });

  it("holds the composer's buttons together at the right edge", () => {
    const css = getWebviewCss();

    // The auto margin belongs to the group, never to both buttons: two of them
    // in a flex row split the free space and leave the guide button mid-row
    // while Stop sits at the edge (measured in a browser against this sheet).
    expect(css).toMatch(/#input-toolbar \.input-actions \{[\s\S]*?margin-left: auto;/);
    expect(css).toMatch(/#input-toolbar #btn-send-stop \{[^}]*\}/);
    expect(css).not.toMatch(/#input-toolbar #btn-send-stop \{[^}]*margin-left: auto;/);
    expect(css).not.toMatch(/#input-toolbar #btn-steer \{[^}]*margin-left: auto;/);
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

  it("shares one copy of the setting-dropdown rules and lets each bar pick its opening side", () => {
    const css = getWebviewCss();

    // The two bars are named on the shared declarations instead of each
    // carrying its own copy of them.
    expect(css).toContain("#settings-bar .setting-value,\n    #toolbar .setting-value {");
    expect(css).toContain("#settings-bar .dropdown-item,\n    #toolbar .dropdown-item {");
    // The settings bar sits at the top of the chat area and the toolbar below
    // the messages, so the open direction is the one thing that differs.
    expect(css).toContain("#settings-bar .dropdown-menu { top: 100%; margin-top: 2px; }");
    expect(css).toContain("#toolbar .dropdown-menu { bottom: 100%; margin-bottom: 2px; }");
  });

  it("bounds every dropdown menu and lets it scroll", () => {
    // The provider roster is longer than the panel (a user-defined route is
    // appended after every built-in), and the menu is absolutely positioned
    // inside a bar: with no bound and no scroll the rows at its far end were
    // laid out past the viewport and could not be seen or reached at all.
    const css = getWebviewCss();
    const ruleStart = css.indexOf("#settings-bar .dropdown-menu,\n    #toolbar .dropdown-menu {");
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleEnd = css.indexOf("}", ruleStart);
    const menuRule = css.slice(ruleStart, ruleEnd);

    expect(menuRule).toMatch(/max-height:\s*min\(45vh,\s*420px\);/);
    expect(menuRule).toContain("overflow-y: auto;");
    expect(menuRule).not.toContain("overflow: hidden;");
  });
  it("hides the sidebar resize grip while the threads panel is collapsed", () => {    const css = getWebviewCss();

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

  it("clips the tool input command block by default and only scrolls once focused", () => {
    const css = getWebviewCss();
    const match = css.match(/\.tool-input-command\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("max-height");
    expect(match![1]).toContain("overflow-y: hidden");
    expect(css).toContain(".tool-call .tool-input-command.scrollable { overflow-y: auto; }");
    expect(css).toContain(".tool-call .tool-output.scrollable { overflow-y: auto; }");
  });

  it("draws the clipped-content veil only on a block that measured as clipped", () => {
    const css = getWebviewCss();
    expect(css).toContain(".tool-call .tool-output.is-clipped::after");
    expect(css).toContain(".tool-call .tool-input-command.is-clipped::after");
    // An unconditional veil dimmed one-line outputs that hid nothing.
    expect(css).not.toContain(".tool-call .tool-output::after {");
    expect(css).not.toContain(".tool-call .tool-input-command::after {");
    expect(css).toContain("focus-visible");
  });

  it("bounds the approval panel so stacked approvals stay reachable", () => {
    const css = getWebviewCss();
    const match = css.match(/\.approval-float \{([^}]*)\}/);
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

  it("styles the thread rail's fetch status", () => {
    const css = getWebviewCss();
    expect(css).toContain(".thread-list-status");
    expect(css).toContain(".thread-list-spinner");
    expect(css).toContain(".thread-list-retry");
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

  it("lets a change row wrap its three actions instead of clipping the last one", () => {
    const css = getWebviewCss();
    // The sidebar resizes down to 120px and a row now carries Diff, Open and
    // Locate; without a wrap the row overflows and the last button is lost.
    const item = css.slice(css.indexOf(".change-item {"));
    const block = item.slice(0, item.indexOf("}"));
    expect(block).toContain("flex-wrap: wrap");
  });

  it("does not contain template literal syntax", () => {
    const css = getWebviewCss();
    expect(css).not.toContain("${");
  });
});
