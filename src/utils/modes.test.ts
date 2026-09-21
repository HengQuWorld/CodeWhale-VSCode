import { describe, expect, it } from "vitest";
import {
  MODE_LABELS,
  MODE_VALUES,
  POSTURE_CONFIG,
  POSTURE_LABELS,
  POSTURE_VALUES,
  POSTURE_WIRE,
  isYoloAlias,
  modeLabel,
  normalizeMode,
  normalizePosture,
  postureFromThread,
  postureLabel,
  resolveModeArg,
  startupPosture,
} from "./modes";

describe("TUI mode contract", () => {
  it("mirrors AppMode: Act is the display name for the persisted `agent` setting", () => {
    expect(MODE_VALUES).toEqual(["agent", "plan", "operate"]);
    expect(MODE_LABELS).toEqual({ agent: "Act", plan: "Plan", operate: "Operate" });
    expect(modeLabel("agent")).toBe("Act");
    expect(modeLabel("plan")).toBe("Plan");
    expect(modeLabel("operate")).toBe("Operate");
  });

  it("normalizes every alias the runtime accepts", () => {
    // `AppMode::parse` aliases, plus `normal` from `parse_runtime_mode`.
    for (const alias of ["agent", "act", "work", "auto", "normal", "1"]) {
      expect(normalizeMode(alias)).toBe("agent");
    }
    expect(normalizeMode("2")).toBe("plan");
    expect(normalizeMode("plan")).toBe("plan");
    for (const alias of ["operate", "operation", "ops", "3"]) {
      expect(normalizeMode(alias)).toBe("operate");
    }
    // `AppMode::from_setting` folds the unreleased Multitask spelling to Operate.
    for (const alias of ["multitask", "multi", "5"]) {
      expect(normalizeMode(alias)).toBe("operate");
    }
    // YOLO folds to Act as a mode; the Full Access half travels on the posture.
    expect(normalizeMode("yolo")).toBe("agent");
    expect(normalizeMode("nonsense")).toBe("agent");
    expect(normalizeMode("")).toBe("agent");
  });

  it("keeps numeric shortcuts aligned with AppMode::parse", () => {
    expect(resolveModeArg("1")).toBe("agent");
    expect(resolveModeArg("2")).toBe("plan");
    expect(resolveModeArg("3")).toBe("operate");
    expect(resolveModeArg("5")).toBe("operate");
    expect(resolveModeArg("yolo")).toBe("agent");
    expect(resolveModeArg("nope")).toBeNull();
    expect(resolveModeArg("")).toBeNull();
  });

  it("recognizes exactly the legacy YOLO spellings", () => {
    for (const alias of ["yolo", "4", "bypass", "bypass-permissions", "bypasspermissions", "YOLO"]) {
      expect(isYoloAlias(alias)).toBe(true);
    }
    expect(isYoloAlias("agent")).toBe(false);
    expect(isYoloAlias("3")).toBe(false);
    expect(isYoloAlias("")).toBe(false);
  });
});

describe("TUI permission-posture contract", () => {
  it("mirrors ApprovalMode's Ask / Auto-Review / Full Access roster", () => {
    expect(POSTURE_VALUES).toEqual(["ask", "auto_review", "full_access"]);
    expect(POSTURE_LABELS).toEqual({
      ask: "Ask",
      auto_review: "Auto-Review",
      full_access: "Full Access",
    });
    expect(POSTURE_WIRE).toEqual({
      ask: "ask",
      auto_review: "auto_review",
      full_access: "full_access",
    });
    expect(POSTURE_CONFIG).toEqual({
      ask: "ask",
      auto_review: "auto-review",
      full_access: "full-access",
    });
  });

  it("normalizes the aliases ApprovalMode::from_config_value accepts", () => {
    for (const alias of ["ask", "suggest", "suggested", "on-request", "untrusted"]) {
      expect(normalizePosture(alias)).toBe("ask");
    }
    for (const alias of ["auto", "auto-review", "auto_review"]) {
      expect(normalizePosture(alias)).toBe("auto_review");
    }
    for (const alias of [
      "bypass",
      "yolo",
      "dontask",
      "dont_ask",
      "full",
      "full-access",
      "full_access",
      "bypass-permissions",
      "bypasspermissions",
    ]) {
      expect(normalizePosture(alias)).toBe("full_access");
    }
    expect(normalizePosture("nonsense")).toBe("ask");
    expect(postureLabel("auto_review")).toBe("Auto-Review");
  });

  it("derives a legacy record's posture exactly like the engine's from_persisted", () => {
    expect(postureFromThread({ permission_posture: "auto_review" })).toBe("auto_review");
    // A canonical posture always wins over the legacy booleans.
    expect(
      postureFromThread({ permission_posture: "ask", auto_approve: true, mode: "yolo" })
    ).toBe("ask");
    expect(postureFromThread({ auto_approve: true })).toBe("full_access");
    // Legacy YOLO mode spellings carried Full Access without the boolean.
    expect(postureFromThread({ mode: "yolo" })).toBe("full_access");
    expect(postureFromThread({ mode: "4" })).toBe("full_access");
    expect(postureFromThread({ mode: "operate" })).toBe("ask");
    // The engine's `from_persisted` ignores `trust_mode`; the GUI must too.
    expect(postureFromThread({ trust_mode: true } as never)).toBe("ask");
    expect(postureFromThread({})).toBe("ask");
  });

  it("resolves the startup posture a new session starts under", () => {
    // The configured posture is what a thread created from scratch starts on.
    expect(startupPosture("agent", "auto_review")).toBe("auto_review");
    expect(startupPosture("plan", "full_access")).toBe("full_access");
    // Unset or unparseable falls back to Ask, like the runtime's own default.
    expect(startupPosture("agent", undefined)).toBe("ask");
    expect(startupPosture("agent", "nonsense")).toBe("ask");
    // A legacy `defaultMode: "yolo"` is Act + Full Access and decides the
    // posture itself, so a stale posture setting must not narrow it back.
    expect(startupPosture("yolo", "ask")).toBe("full_access");
    expect(startupPosture("yolo", undefined)).toBe("full_access");
    expect(startupPosture("4", "ask")).toBe("full_access");
  });
});
