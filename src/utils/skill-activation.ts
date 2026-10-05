import type { SkillMutationReceiptResponse } from "../types";

/**
 * Skill activation prompt composition.
 *
 * A skill is a `SKILL.md` instruction pack; activating one means putting its
 * body in front of the model for the next message. TUI's `/skill <name>` does
 * this by composing an instruction string and attaching it to the queued
 * message, which the send path then renders as
 * `{instruction}\n\n---\n\nUser request: {user}`. The GUI runs the same
 * engine, so it composes the same bytes — one spelling of activation for both
 * surfaces, and no engine-side state to keep in sync.
 */

/** The frontmatter invocation policies that permit an explicit user
 *  activation. `model-only` and `disabled` refuse it; a missing policy means
 *  the historical `model+user` default. */
export function isUserInvocableSkill(invocation: string | undefined | null): boolean {
  if (!invocation) return true;
  return invocation === "model+user" || invocation === "explicit-only";
}

/** The instruction attached to the next message when a skill is activated.
 *  Byte-compatible with TUI's `activate_skill` (`commands/contract.rs`) so a
 *  skill behaves the same whichever surface armed it. */
export function buildSkillActivationInstruction(skill: {
  name: string;
  body: string;
}): string {
  return [
    "You are now using a skill. Follow these instructions:",
    "",
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    "---",
    "",
    "Now respond to the user's request following the above skill instructions.",
  ].join("\n");
}

/** Compose an activated skill's instruction with the user's request, matching
 *  the engine-facing turn text TUI builds in `build_user_request`. */
export function composeSkillTurnPrompt(instruction: string, userRequest: string): string {
  return `${instruction}\n\n---\n\nUser request: ${userRequest}`;
}

/** Narrow a parsed `--project` / `--global` argument (or a panel payload) to
 *  the wire spelling the skill endpoints accept. Returns `undefined` for
 *  "let the engine auto-detect", and `null` for an unrecognized value so the
 *  caller can refuse it instead of silently installing into the wrong root. */
export function parseSkillScope(value: string | undefined | null): "project" | "global" | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "project" || value === "global") return value;
  return null;
}

/** One human line for a skill mutation receipt. `outcome` is the engine's own
 *  verb (`installed`, `updated`, `no_change`, `removed`, `trusted`, …); the
 *  `trusted` case carries the engine's advisory note, which says what the
 *  receipt does and does not authorize. */
export function skillReceiptMessage(receipt: SkillMutationReceiptResponse): string {
  const head = `Skill '${receipt.name}': ${receipt.outcome} (${receipt.scope})\n  ${receipt.safe_target_path}`;
  return receipt.trust_note ? `${head}\n\n${receipt.trust_note}` : head;
}
