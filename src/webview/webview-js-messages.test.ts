import { describe, it, expect } from "vitest";
import { getMessagesScript } from "./webview-js-messages";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-messages.ts", () => {
  it("returns a non-empty string", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it("is wrapped in an IIFE", () => {
    const script = getMessagesScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("'use strict'");
  });

  it("references __wvEscapeHtml from utilities", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("window.__wvEscapeHtml");
  });

  it("references __wvI18n from utilities", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("window.__wvI18n");
  });

  it("contains addMessage function", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function addMessage");
  });

  it("renders the per-turn usage chip from persisted messages", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("msg.usage");
    expect(script).toContain("usage-info");
    expect(script).toContain("msg.usage.input_tokens");
    expect(script).toContain("msg.usage.output_tokens");
  });

  it("contains renderToolCall function", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function renderToolCall");
  });

  it("contains tool input rendering", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function renderToolInput");
    expect(script).toContain("tool-input");
    expect(script).toContain("tool-input-command");
    expect(script).toContain("TOOL_INPUT_META_KEYS");
    expect(script).toContain("SHELL_TOOL_NAMES");
    expect(script).toContain("COMMAND_KEYS");
  });

  it("filters runtime metadata keys out of tool input display", () => {
    const script = getMessagesScript(makeTr());
    for (const key of ["tool_use_id", "tool_name", "tool_call_id", "tool_result_for", "input_provenance", "agent_mail_message_id", "response_redacted", "task_updates"]) {
      expect(script).toContain(`${key}: true`);
    }
  });

  it("matches shell tools by whole name segment, not substring", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("(?:^|[_/.-])(shell|bash|sh|exec|cmd)(?:[_/.-]|$)");
  });

  it("contains renderFileChangeCard function", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function renderFileChangeCard");
  });

  it("contains welcome screen rendering", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("welcome-screen");
    expect(script).toContain("welcome-brand");
  });

  it("contains file change card rendering", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("file-change-card");
    expect(script).toContain("fc-view-diff");
    expect(script).toContain("fc-open-file");
    expect(script).toContain("fc-revert");
  });

  it("names the change on the card's Diff and Revert actions", () => {
    const script = getMessagesScript(makeTr());
    // One file can change more than once; each card carries the position of
    // its own change (Diff) and the tool call that produced it (Revert), so an
    // action on one card cannot touch another change to the same file.
    expect(script).toContain("data-change-index=");
    expect(script).toContain("data-call-id=");
    expect(script).toContain("changeIndex: changeIdx !== null");
    expect(script).toContain("callId: callId");
  });

  it("generates a script the webview can parse", () => {
    // The webview scripts are string-built, so nothing else type-checks them.
    expect(() => new Function(getMessagesScript(makeTr()))).not.toThrow();
  });

  it("contains approval bar rendering", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("approval-bar");
  });

  it("draws the pending approval read-only and keyed by id", () => {
    const script = getMessagesScript(makeTr());
    // The card names what is waiting in place; the floating panel owns the
    // allow/deny buttons, so a card must not carry a second set of them.
    expect(script).toContain('class="approval-bar" data-approval-id="');
    expect(script).not.toContain("approval-buttons");
    expect(script).not.toContain('class="approval-remember"');
  });

  it("hands every rendered pending approval back to the panel", () => {
    const script = getMessagesScript(makeTr());
    // State, not a one-shot event: a rebuilt conversation must still offer the
    // buttons it never saw the original event for.
    expect(script).toContain("window.__wvApproval.show(");
    expect(script).toContain("flushPendingApprovals(pendingApprovals)");
  });

  it("only claims a block is clipped once it has been measured", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function markClippedBlocks(root)");
    expect(script).toContain("markClippedBlocks: markClippedBlocks");
    expect(script).toContain("classList.add('is-clipped')");
    // The panel is resizable, and a width change re-wraps the text the answer
    // was measured from, so the measurement is repeated.
    expect(script).toContain("window.addEventListener('resize'");
    expect(script).toContain("markClippedBlocks();");
  });

  it("makes a clipped block scrollable by click and by focus", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function setActiveScrollable(target)");
    expect(script).toContain("messagesEl.addEventListener('focusin'");
    // A focused block gets the same access a clicked one does, so keyboard
    // users are not locked out of output clipped at 200px.
    expect(script).toContain("tabindex=\"0\"");
  });

  it("contains thinking block rendering", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("thinking-block");
    expect(script).toContain("thinking-toggle");
    expect(script).toContain("thinking-content");
  });

  it("handles file change diff store registration", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("__wvDiffStore");
    expect(script).toContain("__wvDiffIdCounter");
  });

  it("contains event delegation for message interactions", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("addEventListener");
    expect(script).toContain("click");
  });

  it("exposes __wvMessages on window for event handler", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("window.__wvMessages = {");
    expect(script).toContain("addMessage: addMessage");
    expect(script).toContain("renderWelcome: renderWelcome");
    expect(script).toContain("renderToolCall: renderToolCall");
    expect(script).toContain("smartScrollToBottom: smartScrollToBottom");
  });

  it("renders the plan-approve button and posts approvePlan with the composer text on click", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function renderPlanApproveButton");
    expect(script).toContain("plan-approve-btn");
    expect(script).toContain("renderPlanApproveButton: renderPlanApproveButton");
    // The instruction typed in the composer before clicking rides along, and
    // the field is cleared so the same text cannot also start its own turn.
    expect(script).toContain("var planPrompt = inputEl ? inputEl.value.trim() : ''");
    expect(script).toContain("vscode.postMessage({ type: 'approvePlan', text: planPrompt })");
    // Clearing the field has to re-run the input listener, or a slash menu a
    // `/…` draft had opened stays open and eats the next Enter.
    expect(script).toContain("inputEl.dispatchEvent(new Event('input'))");
    // The tooltip is not just the label repeated: the click consumes whatever
    // the composer holds, so the hint is what tells the user the input option
    // exists at all. Assert the two are separate keys rather than the same one.
    expect(script).toContain("btn.title = __i18n.planApproveButtonHint");
    expect(script).not.toContain("btn.title = __i18n.planApproveButton;");
  });

  it("contains streaming state management", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("isStreaming");
    expect(script).toContain("streamingTimeout");
    expect(script).toContain("userScrolledUp");
  });

  it("contains smart scroll to bottom logic", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("function smartScrollToBottom");
    expect(script).toContain("function isNearBottom");
  });

  it("calls renderWelcome on init", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("renderWelcome()");
  });

  it("renders a steer badge on steered user messages", () => {
    const script = getMessagesScript(makeTr());
    expect(script).toContain("steer-badge");
    expect(script).toContain("msg.steered");
    // Steered messages get a dedicated class for accent styling.
    expect(script).toContain("' steered'");
    // The badge tooltip uses the dedicated description, not the input
    // placeholder (which is a different concept).
    expect(script).toContain("__i18n.steerBadgeTitle");
    expect(script).not.toContain("__i18n.steerPlaceholder");
  });
});
