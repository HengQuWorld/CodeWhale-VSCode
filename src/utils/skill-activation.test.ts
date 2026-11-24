import { describe, it, expect } from "vitest";
import {
  buildSkillActivationInstruction,
  buildSkillSteerInstruction,
  composeSkillSteerPrompt,
  composeSkillTurnPrompt,
  isUserInvocableSkill,
  parseSkillScope,
  skillReceiptMessage,
} from "./skill-activation";

describe("skill-activation", () => {
  describe("isUserInvocableSkill", () => {
    it("accepts the two user-invocable policies and a missing one", () => {
      // Missing metadata is the historical `model+user` default, which is
      // exactly the policy an old skill was written under.
      expect(isUserInvocableSkill(undefined)).toBe(true);
      expect(isUserInvocableSkill(null)).toBe(true);
      expect(isUserInvocableSkill("model+user")).toBe(true);
      expect(isUserInvocableSkill("explicit-only")).toBe(true);
    });

    it("refuses the policies that withhold user invocation", () => {
      expect(isUserInvocableSkill("model-only")).toBe(false);
      expect(isUserInvocableSkill("disabled")).toBe(false);
    });
  });

  describe("buildSkillActivationInstruction", () => {
    it("matches the shape TUI's activate_skill composes", () => {
      const instruction = buildSkillActivationInstruction({
        name: "debug",
        body: "Reproduce first.",
      });
      expect(instruction).toBe(
        [
          "You are now using a skill. Follow these instructions:",
          "",
          "# Skill: debug",
          "",
          "Reproduce first.",
          "",
          "---",
          "",
          "Now respond to the user's request following the above skill instructions.",
        ].join("\n")
      );
    });
  });

  describe("composeSkillTurnPrompt", () => {
    it("puts the request after the instruction behind a separator", () => {
      expect(composeSkillTurnPrompt("INSTRUCTION", "fix the bug")).toBe(
        "INSTRUCTION\n\n---\n\nUser request: fix the bug"
      );
    });
  });

  describe("buildSkillSteerInstruction", () => {
    it("keeps the block and addresses guidance instead of \"the user's request\"", () => {
      const instruction = buildSkillSteerInstruction({
        name: "frontend-design",
        body: "Read DESIGN.md first.",
      });

      // The body and heading are the same block a send composes...
      expect(instruction).toContain("You are now using a skill.");
      expect(instruction).toContain("# Skill: frontend-design");
      expect(instruction).toContain("Read DESIGN.md first.");
      // ...but the closing names the guidance a steer carries. The turn's
      // opening request is behind it in the conversation, so "the user's
      // request" would point the model at the wrong thing.
      expect(instruction).not.toContain("Now respond to the user's request");
      expect(instruction).toContain(
        "Apply these instructions to the guidance below, within the turn already in progress."
      );
    });
  });

  describe("composeSkillSteerPrompt", () => {
    it("puts the guidance after the instruction behind a separator", () => {
      expect(composeSkillSteerPrompt("INSTRUCTION", "make it wider")).toBe(
        "INSTRUCTION\n\n---\n\nGuidance for the turn already in progress: make it wider"
      );
    });
  });

  describe("parseSkillScope", () => {
    it("passes the wire spellings through and leaves absent values unset", () => {
      expect(parseSkillScope("project")).toBe("project");
      expect(parseSkillScope("global")).toBe("global");
      expect(parseSkillScope(undefined)).toBeUndefined();
      expect(parseSkillScope("")).toBeUndefined();
    });

    it("reports an unknown scope as null so the caller can refuse it", () => {
      // Distinct from `undefined`: refusing beats installing into whichever
      // root the engine would otherwise guess.
      expect(parseSkillScope("workspace")).toBeNull();
      expect(parseSkillScope("--global")).toBeNull();
    });
  });

  describe("skillReceiptMessage", () => {
    it("names the outcome, scope and target", () => {
      expect(
        skillReceiptMessage({
          name: "pdf",
          outcome: "installed",
          scope: "global",
          safe_target_path: "/home/u/.codewhale/skills/pdf",
        })
      ).toBe("Skill 'pdf': installed (global)\n  /home/u/.codewhale/skills/pdf");
    });

    it("carries the engine's advisory note when the receipt has one", () => {
      const message = skillReceiptMessage({
        name: "pdf",
        outcome: "trusted",
        scope: "global",
        safe_target_path: "/home/u/.codewhale/skills/pdf",
        trust_note: "advisory only",
      });
      expect(message).toContain("advisory only");
    });
  });
});
