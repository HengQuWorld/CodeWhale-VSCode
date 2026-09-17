/**
 * The goal control plane owns the Work panel's first slot (#work-goal) and the
 * "＋ Set goal" / editor interaction inside it. These tests pin the contract the
 * dead-button reports were about: the extension pushes goalState on every
 * sidebar refresh, thread switch and turn end, and those pushes must not take
 * the slot apart under the user — rebuilding it swaps the button node out from
 * under the cursor (a click whose mousedown/mouseup straddle the rebuild is
 * dispatched on the nearest common ancestor, so the button never fires) and
 * discards a draft being typed.
 */
import { describe, expect, it } from "vitest";
import { getGoalScript } from "./webview-js-goal";
import { makeTr } from "./webview-test-helpers";

describe("webview-js-goal.ts", () => {
  it("is an IIFE in strict mode, borrowing the shared helpers", () => {
    const script = getGoalScript(makeTr());
    expect(script.startsWith("(function(){")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
    expect(script).toContain("'use strict'");
    expect(script).toContain("window.__wvI18n");
    expect(script).toContain("window.__wvEscapeHtml");
    expect(script).toContain("window.__wvVscode");
  });

  it("renders the goal slot on demand, not unconditionally", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain("function renderGoal(force)");
    expect(script).toContain("if (!force && key === renderedKey) return;");
    expect(script).toContain("function renderKey()");
    // The drafts are deliberately not part of the key: keying on the text the
    // user is typing would let the next state push rebuild the editor.
    expect(script).toMatch(/function renderKey\(\) \{[\s\S]*?\bgoal \|\| null,[\s\S]*?\}/);
  });

  it("adopts goalState through applyState and keeps an open editor", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain("applyState: applyState");
    expect(script).toContain("function applyState(nextGoal, nextBackgroundGoals)");
    expect(script).toContain("if (editing) {");
  });

  it("clears the control plane (goal, draft and editor) on reset", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain("reset: reset");
    expect(script).toContain("function reset()");
  });

  it("disables the save button while the objective is empty", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain("var canSave = String(draftObjective || '').trim() !== '';");
    expect(script).toContain("syncSaveEnabled");
    // No CSS entry of its own: the module dims the button inline.
    expect(script).toContain("' disabled style=\"opacity:0.5;cursor:not-allowed;\"'");
  });

  it("closes the editor when a save is sent, so a dropped request cannot look like a dead button", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain("submittedObjective = objective;");
    expect(script).toMatch(/vscode\.postMessage\(\{ type: 'setGoal'[\s\S]*?editing = false;\s*\n\s*renderGoal\(\);/);
  });

  it("sends the objective, budget and background flag the extension expects", () => {
    const script = getGoalScript(makeTr());
    expect(script).toContain(
      "vscode.postMessage({ type: 'setGoal', objective: objective, tokenBudget: tokenBudget, background: !!(bgCheck && bgCheck.checked) });",
    );
  });
});
