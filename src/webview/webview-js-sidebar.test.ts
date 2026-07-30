import { describe, it, expect } from "vitest";
import { getSidebarScript } from "./webview-js-sidebar";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-sidebar.ts", () => {
  it("returns a non-empty string", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it("is wrapped in an IIFE", () => {
    const script = getSidebarScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("'use strict'");
  });

  it("references __wvEscapeHtml from utilities", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("window.__wvEscapeHtml");
  });

  it("references __wvI18n from utilities", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("window.__wvI18n");
  });

  it("contains renderSessions function", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function renderSessions");
  });

  it("contains renderThreads function", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function renderThreads");
  });

  it("contains renderTasks function", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function renderTasks");
  });

  it("adds task card action buttons for details and result access", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("detailsBtn.title = __i18n.taskDetails || 'Details'");
    expect(script).toContain("resultBtn.title = __i18n.agentResult || 'Result'");
  });

  it("renders task toolbar icon controls and create dialog", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function openTaskCreateDialog");
    expect(script).toContain("task-create-overlay");
    expect(script).toContain("task-icon-btn primary");
    expect(script).toContain("task-create-textarea");
    expect(script).toContain("type: 'createTask'");
    expect(script).toContain("type: 'refreshTaskList'");
  });

  it("renders compact icon buttons for task card actions", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("detailsBtn.className = 'task-action-btn'");
    expect(script).toContain("resultBtn.className = 'task-action-btn'");
    expect(script).toContain("cancelBtn.className = 'task-action-btn danger'");
  });

  it("renders attention badges for tasks waiting on approvals or input", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("Array.isArray(t.pending_approvals)");
    expect(script).toContain("Array.isArray(t.pending_user_inputs)");
    expect(script).toContain("task-attention-badge");
    expect(script).toContain("task-attention-meta");
  });

  it("routes sidebar task cancel actions through direct task messages", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("type: 'cancelTask'");
    expect(script).toContain("detail-task-cancel");
    expect(script).toContain("detail-task-refresh");
  });

  it("contains renderWork function", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function renderWork");
  });

  it("contains sidebar tab switching logic", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function switchSidebarTab");
  });

  it("contains task detail rendering", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function showTaskDetail");
    expect(script).toContain("function closeTaskDetail");
    expect(script).toContain("type: 'closeTaskDetail'");
  });

  it("renders richer task process sections and overlay actions", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("Full Result");
    expect(script).toContain("Verification Gates");
    expect(script).toContain("renderOpenFileButton");
    expect(script).toContain("detail-open-external");
  });

  it("contains agent detail rendering", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function showAgentDetail");
    expect(script).toContain("function closeAgentDetail");
  });

  it("contains threads panel toggle", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function toggleThreadsPanel");
  });

  it("handles workspace filter toggle", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("workspace-filter-toggle");
    expect(script).toContain("toggleAllWorkspaces");
  });

  it("contains section collapse/expand via sidebar-section-header", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("sidebar-section-header");
    expect(script).toContain("collapsed");
  });

  it("wires render functions to window.__wvSidebar", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("window.__wvSidebar = {");
    expect(script).toContain("renderSessions: renderSessions");
    expect(script).toContain("renderThreads: renderThreads");
    expect(script).toContain("renderTasks: renderTasks");
    expect(script).toContain("renderWork: renderWork");
    expect(script).toContain("switchSidebarTab: switchSidebarTab");
  });

  it("exposes getter/setter for sessions, threads, workState", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("setSessions:");
    expect(script).toContain("setActiveSessionId:");
    expect(script).toContain("setThreads:");
    expect(script).toContain("setActiveThreadId:");
    expect(script).toContain("setShowAllWorkspaces:");
    expect(script).toContain("setWorkState:");
  });

  it("uses __wvFormatRelativeTime for time display", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("window.__wvFormatRelativeTime");
  });

  it("uses __wvFormatThreadsCount for thread count display", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("window.__wvFormatThreadsCount");
  });

  it("does not render file changes in work panel (TUI design: file changes are shown inline, not in Work sidebar)", () => {
    const script = getSidebarScript(makeTr());
    expect(script).not.toContain("workState.fileChanges");
  });

  it("contains renderChanges function for the Changes panel", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("function renderChanges");
  });

  it("wires renderChanges to window.__wvSidebar", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("renderChanges: renderChanges");
  });

  it("exposes setChangesState getter/setter", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("setChangesState:");
    expect(script).toContain("getChangesState:");
  });

  it("renders file changes in the Changes panel, not the Work panel", () => {
    const script = getSidebarScript(makeTr());
    expect(script).toContain("changesState");
    expect(script).toContain("tab-changes");
    expect(script).not.toContain("workState.fileChanges");
  });
});
