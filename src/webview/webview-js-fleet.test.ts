import { describe, it, expect } from "vitest";
import { getFleetScript } from "./webview-js-fleet";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-fleet.ts", () => {
  it("returns a strict-mode IIFE", () => {
    const script = getFleetScript(makeTr());
    expect(script.startsWith("(function()")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
    expect(script).toContain("'use strict'");
  });

  it("joins creation-time task_specs into the detail view", () => {
    const script = getFleetScript(makeTr());
    // The detail payload's run.task_specs carries what the user typed at
    // creation (name / role / objective / instructions); the task rows must
    // consume it instead of showing bare task ids.
    expect(script).toContain("run.task_specs");
    expect(script).toContain("specById[specs[si].id] = specs[si]");
    expect(script).toContain("specById[tasks[ti].task_id]");
    expect(script).toContain("var name = spec.name || taskId");
    expect(script).toContain("spec.worker && spec.worker.role");
    expect(script).toContain("spec.objective");
    expect(script).toContain("spec.instructions");
  });

  it("renders the task prompt in a collapsible details block", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("fleet-task-details");
    expect(script).toContain("__i18n.fleetTaskInstructions");
    expect(script).toContain("fleet-task-instructions");
  });

  it("falls back to spec-only rows when no ledger status rows exist", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("renderTaskRow({ task_id: specs[spi].id }, specs[spi], taskFailures[specs[spi].id])");
  });

  it("labels workers and receipts with task names, not bare ids", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("taskNames[w.task_id] || shortId(w.task_id)");
    expect(script).toContain("taskNames[r.task_id] || shortId(r.task_id)");
  });

  it("surfaces the receipt score notes (deliverable excerpt) on the receipt card", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("fleet-receipt-notes");
    expect(script).toContain("r.score && r.score.notes");
  });

  it("offers a view-reply action for receipts with a saved session id", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("fleet-session-btn");
    expect(script).toContain("data-fleet-session-id");
    expect(script).toContain("fleetOpenSession");
    expect(script).toContain("showFleetReply");
  });

  it("skips no-op refresh re-renders to avoid the flash", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("JSON.stringify(payload)");
    expect(script).toContain("payloadJson === lastDetailJson");
  });

  it("preserves view state and the event timeline across refreshes", () => {
    const script = getFleetScript(makeTr());
    // Timeline only clears when a different run is opened.
    expect(script).toContain("if (previousRunId !== activeRunId) fleetEvents = []");
    // Expanded prompts + scroll restore.
    expect(script).toContain(".fleet-task-details[open]");
    expect(script).toContain("newPanel.scrollTop = scrollTop");
    // Timeline rows rebuild from the surviving fleetEvents array.
    expect(script).toContain("rows += eventRowHtml(fleetEvents[i])");
  });

  it("classifies event severity: failures red, heartbeats dimmed", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("if (st === 'failed' || kind.indexOf('fail') >= 0");
    expect(script).toContain("kind.indexOf('heartbeat') >= 0 || st === 'heartbeat') return 'dim'");
    expect(script).toContain("sev-' + sev");
    expect(script).toContain("fleet-event-chip sev-' + sev");
  });

  it("renders a human message per event payload state, not raw JSON", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("msg = p.reason || ''");
    expect(script).toContain("'exit code ' + p.exit_code");
    expect(script).toContain("p.tool ? '🔧 ' + p.tool");
    // Full payload stays available behind an expandable JSON block.
    expect(script).toContain("fleet-event-detail");
  });

  it("filters the timeline: issues / progress (no heartbeats) / all", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("fleetEventFilter = 'progress'");
    expect(script).toContain("sev === 'error' || sev === 'warn'");
    expect(script).toContain("return sev !== 'dim'");
    expect(script).toContain("fleet-event-issue-count");
  });

  it("shows the failure reason on failed task rows", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("taskFailures[rc.task_id] = rc.failure_class");
    expect(script).toContain("taskFailures[fe.task_id] = fp.reason");
    expect(script).toContain("taskFailures[workers[fk].task_id] = werr");
    expect(script).toContain("__i18n.fleetTaskFailure");
  });

  it("offers new-from-run prefill in the create dialog", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("fleet-run-new");
    expect(script).toContain("__i18n.fleetNewFromRun");
    expect(script).toContain("openFleetCreateDialog(detailRun)");
    // Prefill builds roles from run.roles and tasks from run.task_specs.
    expect(script).toContain("sourceRun.roles || []");
    expect(script).toContain("sourceRun.task_specs || []");
    expect(script).toContain("taskCardHtml(prefillTasks[ti], prefillRoleNames)");
  });

  it("rejects duplicate role names and task ids within one run before submit", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("seenRoles[roles[ri].name]");
    expect(script).toContain("seenTaskIds[tasks[ti].id]");
    expect(script).toContain("__i18n.fleetCreateDuplicate");
  });

  it("mints workflow ids unique within the same minute", () => {
    const script = getFleetScript(makeTr());
    expect(script).toContain("pad2(d.getSeconds())");
    expect(script).toContain("Math.random().toString(36).slice(2, 6)");
  });

  it("executes showFleetDetail without runtime errors (regression: template-literal JS is invisible to tsc)", () => {
    // The fleet script ships as a string inside the webview HTML; a single
    // ReferenceError inside it kills the whole fleet UI (detail never opens)
    // while `npm run compile` stays green. Execute it for real.
    const script = getFleetScript(makeTr());
    const esc = (s: unknown) =>
      String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c as string] as string));
    const el = () => ({
      style: {} as Record<string, string>,
      attrs: {} as Record<string, string>,
      innerHTML: "",
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      querySelector() { return null; },
      querySelectorAll() { return [] as unknown[]; },
      appendChild() {}, insertAdjacentHTML() {}, remove() {}, addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      onclick: null,
    });
    const overlay = el();
    const tr = makeTr();
    const win = {
      __wvI18n: tr,
      __wvEscapeHtml: esc,
      __wvFormatRelativeTime: (t: string) => String(t),
      __wvVscode: { postMessage() {} },
    } as unknown as Record<string, unknown>;
    const doc = {
      getElementById(id: string) { return id === "fleet-detail-overlay" ? overlay : null; },
      createElement: el,
      querySelectorAll() { return []; },
    };
    new Function("document", "window", script)(doc, win);
    const fleet = win.__wvFleet as {
      showFleetDetail(p: unknown): void;
      handleFleetEvent(e: unknown): void;
    };
    const payload = {
      run: {
        id: "fleet-abc12345", name: "test run", lifecycle_status: "completed",
        target: "this_computer", created_at: "2026-09-04T10:00:00Z",
        task_specs: [
          { id: "task-1", name: "T1", instructions: "do it", worker: { role: "coder" } },
          { id: "task-2", name: "T2", worker: { role: "manager" } },
        ],
        tasks: [
          { task_id: "task-1", status: "failed", attempts: 1 },
          { task_id: "task-2", status: "enqueued", attempts: 0 },
        ],
        status: { failed: 1 },
      },
      workers: [{ worker_id: "w1", status: "offline", runtime_state: { latest_message: "boom" } }],
      receipts: [{ task_id: "task-1", result: "fail", failure_class: "Verifier rejected", attempt: 1 }],
    };
    expect(() => fleet.showFleetDetail(payload)).not.toThrow();
    expect(overlay.innerHTML).toContain("fleet-detail-panel");
    expect(overlay.innerHTML).toContain("T1");
    expect(overlay.innerHTML).toContain("Verifier rejected");
    // Status badges are localized, not raw ledger strings.
    expect(overlay.innerHTML).toContain("Failed");
    expect(overlay.innerHTML).toContain("Enqueued");
    // Enqueued rows explain what the user is waiting for.
    expect(overlay.innerHTML).toContain("fleet-task-wait-hint");
    expect(() =>
      fleet.handleFleetEvent({ run_id: "fleet-abc12345", event: "fleet.task.receipt_recorded", task_id: "task-1", worker_id: "w1", timestamp: "2026-09-04T10:01:00Z", payload: { result: "fail", state: "failed", reason: "boom" } })
    ).not.toThrow();
    // SSE-triggered refresh of the same payload must not throw either.
    expect(() => fleet.showFleetDetail(payload)).not.toThrow();
  });
});
