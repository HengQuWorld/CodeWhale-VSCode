/**
 * The skills panel: list, toggle, activate, install, mutate, audit.
 *
 * Extracted from `chat-provider.ts`, which keeps the same methods as thin
 * entry points — the webview's messages and the slash commands route through
 * them — so this is the whole of the behaviour and nothing else.
 *
 * The engine owns skills: it scans the roots, holds the invocation policy and
 * performs every mutation. Almost nothing is decided here — the one thing this
 * side contributes is the *scope* of each row, derived from the path the
 * engine reported (see `utils/skill-scope`), because the engine's listing
 * carries a real path but no scope.
 */

import type { CodeWhaleApiClient } from "../types";
import { formatError, getErrorMessage } from "../utils/error-handler";
import { classifySkillScope } from "../utils/skill-scope";
import {
  buildSkillActivationInstruction,
  isUserInvocableSkill,
  parseSkillScope,
  skillReceiptMessage,
} from "../utils/skill-activation";

/**
 * What the controller needs from the provider it serves.
 *
 * The two capability answers are read live rather than captured: they come
 * from probing the runtime after startup, so a snapshot taken at construction
 * would freeze them at "no".
 */
export interface SkillHost {
  readonly api: CodeWhaleApiClient;
  /** Whether the engine can hand back a skill's body (the `skill_detail` route). */
  hasSkillDetail(): boolean;
  /** The workspace the engine scanned; empty until that status has been read. */
  workspaceRoot(): string;
  postMessage(msg: Record<string, unknown>): void;
  debugLog(msg: string): void;
  /** Arm a skill for the next outgoing message. */
  armSkill(skill: { name: string; description: string; instruction: string }): void;
  /** Send a message now — activation that carries its own task sends it. */
  sendMessage(text: string): Promise<void>;
}

export class SkillController {
  constructor(private readonly host: SkillHost) {}

  /** Push the current skill inventory to the webview's Skills panel.
   *
   *  Each row is annotated with the scope of its `SKILL.md` before it goes
   *  out: the engine's row carries the real path but no scope, and the panel
   *  groups by project/global. */
  public async refreshSkillList(): Promise<void> {
    try {
      const result = await this.host.api.listSkills();
      // The root is the workspace the engine itself scanned: these paths came
      // from it, and `GET /v1/workspace/status` echoes the very field
      // `list_skills` resolves skills against. The window's folder is the
      // fallback for a refresh that lands before that status has been read —
      // the same directory in every ordinary run, since it is what the engine
      // is launched with. Both empty claims nothing as a project skill.
      const workspace = this.host.workspaceRoot();
      this.host.postMessage({
        type: "skillList",
        skills: (result.skills ?? []).map(s => ({
          ...s,
          scope: classifySkillScope(s.path, workspace),
        })),
        directory: result.directory ?? "",
        directories: result.directories ?? [],
        warnings: result.warnings ?? [],
      });
    } catch (err) {
      // The panel keeps whatever it had; a failed refresh is not a reason to
      // blank a list the user was reading.
      this.host.debugLog(`refreshSkillList failed: ${getErrorMessage(err)}`);
    }
  }

  /** Turn a skill on or off. The engine persists this per identity, so the
   *  listing is re-read after the write rather than guessed at. */
  public async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    try {
      const result = await this.host.api.setSkillEnabled(name, enabled);
      this.host.postMessage({
        type: "info",
        message: enabled
          ? `Skill '${result.name}' enabled. It will auto-trigger when the task matches.`
          : `Skill '${result.name}' disabled.`,
      });
      await this.refreshSkillList();
    } catch (err) {
      const message = getErrorMessage(err);
      this.host.postMessage({
        type: "error",
        message: message.includes("not found")
          ? `Skill '${name}' not found. Run /skills to list available skills.`
          : formatError("Failed to toggle skill", err),
      });
    }
  }

  /** Activate a skill for the next message. With `task`, that message is sent
   *  immediately — TUI's `/skill <name> <task>`. The body comes from the
   *  engine, so activation needs the `skill_detail` capability; without it
   *  the request is refused with the reason instead of a bare 404. */
  public async activateSkill(name: string, task?: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!this.host.hasSkillDetail()) {
      this.host.postMessage({
        type: "error",
        message:
          "This engine cannot hand back a skill's body, so the GUI cannot activate it. " +
          "Update the CodeWhale engine, or run the skill from the TUI.",
      });
      return;
    }
    try {
      const detail = await this.host.api.getSkillDetail(trimmed);
      if (!isUserInvocableSkill(detail.invocation)) {
        this.host.postMessage({
          type: "error",
          message: `Skill '${detail.name}' does not allow user invocation (invocation: ${detail.invocation}).`,
        });
        return;
      }
      const instruction = buildSkillActivationInstruction({
        name: detail.name,
        body: detail.body,
      });
      this.host.armSkill({
        name: detail.name,
        description: detail.description,
        instruction,
      });
      // TUI writes an "Activated skill: X" system line into the transcript; the
      // chat-area info card is the GUI's equivalent, and it names the once-only
      // scope so the arming cannot be mistaken for a permanent setting.
      this.host.postMessage({
        type: "info",
        message: `Skill '${detail.name}' activated for your next message.`,
      });
      if (task && task.trim()) {
        await this.host.sendMessage(task.trim());
      }
    } catch (err) {
      const message = getErrorMessage(err);
      this.host.postMessage({
        type: "error",
        message: message.includes("not found")
          ? `Skill '${trimmed}' not found. Run /skills to list available skills.`
          : formatError("Failed to activate skill", err),
      });
    }
  }

  /** Install a skill from a remote spec through the engine's mutation
   *  controller. The engine owns the network policy, path-traversal guard and
   *  atomic write; the GUI only reports the receipt. */
  public async installSkill(source: string, scope?: string): Promise<void> {
    const target = parseSkillScope(scope);
    if (target === null) {
      this.host.postMessage({ type: "error", message: `Invalid scope: ${scope}` });
      return;
    }
    if (!source.trim()) {
      this.host.postMessage({ type: "error", message: "Usage: /skill install <github:owner/repo|url|registry-name>" });
      return;
    }
    try {
      const receipt = await this.host.api.installSkill(source.trim(), target);
      this.host.postMessage({ type: "info", message: skillReceiptMessage(receipt) });
      await this.refreshSkillList();
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Install failed", err) });
    }
  }

  public async mutateSkill(
    kind: "update" | "uninstall" | "trust",
    name: string,
    scope?: string
  ): Promise<void> {
    if (!name.trim()) {
      this.host.postMessage({ type: "error", message: `Usage: /skill ${kind} <name>` });
      return;
    }
    const target = parseSkillScope(scope);
    if (target === null) {
      this.host.postMessage({ type: "error", message: `Invalid scope: ${scope}` });
      return;
    }
    const label = kind === "update" ? "Update" : kind === "uninstall" ? "Uninstall" : "Trust";
    try {
      const receipt =
        kind === "update"
          ? await this.host.api.updateSkill(name.trim(), { scope: target })
          : kind === "uninstall"
            ? await this.host.api.uninstallSkill(name.trim(), { scope: target })
            : await this.host.api.trustSkill(name.trim(), { scope: target });
      this.host.postMessage({ type: "info", message: skillReceiptMessage(receipt) });
      await this.refreshSkillList();
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError(`${label} failed`, err) });
    }
  }

  /** Read-only integrity/trust/provenance receipt for one skill, rendered as
   *  the same field lines the TUI manager's detail pane shows. */
  public async auditSkill(name: string, scope?: string): Promise<void> {
    const target = parseSkillScope(scope);
    if (target === null) {
      this.host.postMessage({ type: "error", message: `Invalid scope: ${scope}` });
      return;
    }
    try {
      const audit = await this.host.api.auditSkill(name.trim(), { scope: target });
      if (!audit.skills || audit.skills.length === 0) {
        this.host.postMessage({ type: "error", message: `Skill '${name}' not found in any audited root.` });
        return;
      }
      const lines: string[] = [];
      if (audit.ambiguous) {
        lines.push(
          `Multiple copies of '${name}' exist; pass --project or --global to pick one.`
        );
      }
      for (const entry of audit.skills) {
        lines.push(`Skill '${entry.name}' (${entry.source_kind}, ${entry.scope})`);
        lines.push(`  path:       ${entry.safe_display_path}`);
        lines.push(`  digest:     ${entry.digest.state}${entry.digest.value ? ` — ${entry.digest.value}` : ""}`);
        lines.push(`  trust:      ${entry.trust}`);
        lines.push(`  integrity:  ${entry.integrity}`);
        if (entry.available_actions.length > 0) {
          lines.push(`  actions:    ${entry.available_actions.join(", ")}`);
        }
        for (const warning of entry.warnings) {
          lines.push(`  warning:    ${warning}`);
        }
      }
      this.host.postMessage({ type: "info", message: lines.join("\n") });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Audit failed", err) });
    }
  }
}
