import { describe, it, expect } from "vitest";
import { getEventHandlerScript } from "./webview-js-event-handler";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-event-handler.ts", () => {
  it("returns a non-empty string", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it("is wrapped in an IIFE", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("'use strict'");
  });

  it("references __wvEscapeHtml from utilities", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("window.__wvEscapeHtml");
  });

  it("listens for window messages", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("window.addEventListener('message'");
  });

  it("handles 'ready' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'ready'");
  });

  it("handles 'addMessage' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'addMessage'");
  });

  it("handles 'updateToolCall' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'updateToolCall'");
  });

  it("handles 'status' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'status'");
  });

  it("handles 'sessionList' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'sessionList'");
  });

  it("handles 'threadList' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'threadList'");
  });

  it("handles 'taskList' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'taskList'");
  });

  it("handles 'agentDetail' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'agentDetail'");
  });

  it("handles 'workState' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'workState'");
  });

  it("handles 'apiCapabilities' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'apiCapabilities'");
  });

  it("handles 'error' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'error'");
  });

  it("handles 'info' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'info'");
  });

  it("handles 'settingsUpdated' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'settingsUpdated'");
  });

  it("handles 'sessionLoaded' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'sessionLoaded'");
  });

  it("handles 'threadLoaded' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'threadLoaded'");
  });

  it("clears stale task/agent panels on threadLoaded", () => {
    const script = getEventHandlerScript(makeTr());
    // The threadLoaded case must reset task and agent panels so data from
    // the previous thread doesn't linger before the refresh arrives.
    const threadLoadedIdx = script.indexOf("case 'threadLoaded'");
    const taskListIdx = script.indexOf("case 'taskList'");
    // The clearing renderTasks([]) call must appear between threadLoaded and
    // the next case (taskList).
    expect(threadLoadedIdx).toBeGreaterThan(-1);
    expect(taskListIdx).toBeGreaterThan(threadLoadedIdx);
    const slice = script.slice(threadLoadedIdx, taskListIdx);
    expect(slice).toContain("renderTasks([])");
    expect(slice).toContain("setAgentRuns([])");
    expect(slice).toContain("renderAgents([])");
  });

  it("closes detail overlays and clears work/changes on threadLoaded", () => {
    const script = getEventHandlerScript(makeTr());
    const threadLoadedIdx = script.indexOf("case 'threadLoaded'");
    const taskListIdx = script.indexOf("case 'taskList'");
    const slice = script.slice(threadLoadedIdx, taskListIdx);
    // Both detail overlays from the previous thread must be closed
    expect(slice).toContain("closeTaskDetail()");
    expect(slice).toContain("closeAgentDetail()");
    // Work panel state must be reset to empty
    expect(slice).toContain("setWorkState(");
    expect(slice).toContain("coherenceState: 'healthy'");
    // Changes panel must be cleared
    expect(slice).toContain("setChangesState([])");
    expect(slice).toContain("renderWork()");
    expect(slice).toContain("renderChanges()");
  });

  it("handles 'clearChat' message type", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'clearChat'");
  });

  it("closes both task and agent detail overlays on clearChat", () => {
    const script = getEventHandlerScript(makeTr());
    const clearChatIdx = script.indexOf("case 'clearChat'");
    const errorIdx = script.indexOf("case 'error'", clearChatIdx);
    const slice = script.slice(clearChatIdx, errorIdx);
    // Both overlays must be closed
    expect(slice).toContain("closeTaskDetail()");
    expect(slice).toContain("closeAgentDetail()");
  });

  it("clears task/agent panels on clearChat", () => {
    const script = getEventHandlerScript(makeTr());
    const clearChatIdx = script.indexOf("case 'clearChat'");
    const errorIdx = script.indexOf("case 'error'", clearChatIdx);
    const slice = script.slice(clearChatIdx, errorIdx);
    expect(slice).toContain("renderTasks([])");
    expect(slice).toContain("setAgentRuns([])");
    expect(slice).toContain("renderAgents([])");
  });

  it("clears work and changes panels on clearChat", () => {
    const script = getEventHandlerScript(makeTr());
    const clearChatIdx = script.indexOf("case 'clearChat'");
    const errorIdx = script.indexOf("case 'error'", clearChatIdx);
    const slice = script.slice(clearChatIdx, errorIdx);
    // Work state must be reset
    expect(slice).toContain("setWorkState(");
    expect(slice).toContain("coherenceState: 'healthy'");
    // Changes state must be cleared
    expect(slice).toContain("setChangesState([])");
    expect(slice).toContain("renderWork()");
    expect(slice).toContain("renderChanges()");
  });

  it("uses __wvSidebar for sidebar state updates", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("__wvSidebar");
  });

  it("uses __wvMessages for adding messages", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("__wvMessages");
  });

  it("uses __wvVscode for postMessage", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("__wvVscode");
  });

  it("renders status stats with session info", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("function renderStatusStats");
    expect(script).toContain("sessionStats");
  });

  it("handles approval messages", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'approvalRequired'");
    expect(script).toContain("case 'approvalResolved'");
  });

  it("handles user input messages", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'userInputRequired'");
    expect(script).toContain("case 'userInputResolved'");
  });

  it("handles thinking block updates", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'updateThinking'");
    expect(script).toContain("case 'addThinkingBlock'");
  });

  it("handles turn lifecycle events", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'turnStarted'");
    expect(script).toContain("case 'turnInterrupted'");
  });

  it("handles file change events", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'fileChangeDetected'");
  });

  it("handles message complete event", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'messageComplete'");
  });

  it("handles session stats event", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("case 'sessionStats'");
  });

  it("renders a token-sum chip when no input/output split is available", () => {
    // Session view mode: only a grand token total is recorded, so the
    // stats bar shows a Σ chip instead of hiding token information.
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("sessionStats.totalTokens");
    expect(script).toContain("\\u03a3");
  });

  it("omits the cache chip when no cache sample exists", () => {
    // The backend omits cacheHitRate in view mode; the webview must
    // check for it rather than render a misleading 0.0%.
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("sessionStats.cacheHitRate !== undefined");
  });

  it("sends webviewReady message on init", () => {
    const script = getEventHandlerScript(makeTr());
    expect(script).toContain("type: 'webviewReady'");
  });
});
