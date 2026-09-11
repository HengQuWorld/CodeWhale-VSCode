/**
 * GUI ↔ TUI mode and permission-posture contract.
 *
 * Single source of truth for the mode surface, mirroring the TUI:
 *   - `crates/config/src/app_mode.rs`          (AppMode: Act/Plan/Operate)
 *   - `crates/execpolicy/src/approval_mode.rs` (Ask/Auto-Review/Full Access)
 *   - `crates/tui/src/runtime_policy.rs`       (runtime wire normalization)
 *
 * The TUI treats these as two independent dimensions:
 *   - **mode** (`/mode`, Tab): `agent` (displayed "Act"), `plan`, `operate`
 *   - **permission posture** (Shift+Tab): `ask`, `auto_review`, `full_access`
 *
 * `yolo` is *not* a mode. It is a one-way compatibility alias for
 * Act + Full Access, exactly like `AppMode::parse` folding it to `Agent`
 * with the bypass posture carried separately.
 */

export type TuiMode = "agent" | "plan" | "operate";
export type PermissionPosture = "ask" | "auto_review" | "full_access";

/** Dropdown order: the TUI mode picker roster is Act / Plan / Operate. */
export const MODE_VALUES: readonly TuiMode[] = ["agent", "plan", "operate"];

/** Display names mirror `AppMode::display_name()`. */
export const MODE_LABELS: Record<TuiMode, string> = {
  agent: "Act",
  plan: "Plan",
  operate: "Operate",
};

export const POSTURE_VALUES: readonly PermissionPosture[] = [
  "ask",
  "auto_review",
  "full_access",
];

/** Chip labels mirror `ApprovalMode::permission_chip_label()`. */
export const POSTURE_LABELS: Record<PermissionPosture, string> = {
  ask: "Ask",
  auto_review: "Auto-Review",
  full_access: "Full Access",
};

/** Runtime wire values (ThreadRecord.permission_posture, request bodies). */
export const POSTURE_WIRE: Record<PermissionPosture, string> = {
  ask: "ask",
  auto_review: "auto_review",
  full_access: "full_access",
};

/**
 * TUI config spellings for the `approval_mode` key (and the legacy root
 * `approval_policy` it persists to). Hyphenated, and exactly the three values
 * `APPROVAL_MODE` offers in `settings_schema.rs`. `ApprovalMode::from_config_value`
 * also accepts legacy aliases and `never`, but `never` is a managed-policy
 * value the TUI editor never writes.
 */
export const POSTURE_CONFIG: Record<PermissionPosture, string> = {
  ask: "ask",
  auto_review: "auto-review",
  full_access: "full-access",
};

/**
 * Mode aliases accepted on the wire: `AppMode::parse` plus
 * `runtime_policy::parse_runtime_mode` (`normal`) plus the unreleased
 * Multitask spelling `AppMode::from_setting` folds to Operate.
 */
const MODE_ALIASES: Record<string, TuiMode> = {
  // Act is the product name; `agent` is the persisted setting.
  agent: "agent",
  act: "agent",
  work: "agent",
  auto: "agent",
  normal: "agent",
  "1": "agent",
  plan: "plan",
  "2": "plan",
  operate: "operate",
  operation: "operate",
  ops: "operate",
  multitask: "operate",
  multi: "operate",
  "3": "operate",
  "5": "operate",
};

const POSTURE_ALIASES: Record<string, PermissionPosture> = {
  ask: "ask",
  suggest: "ask",
  suggested: "ask",
  "on-request": "ask",
  untrusted: "ask",
  auto: "auto_review",
  "auto-review": "auto_review",
  auto_review: "auto_review",
  bypass: "full_access",
  yolo: "full_access",
  full: "full_access",
  "full-access": "full_access",
  full_access: "full_access",
  "bypass-permissions": "full_access",
  bypasspermissions: "full_access",
  dontask: "full_access",
  dont_ask: "full_access",
};

/**
 * Legacy YOLO spellings. These are a one-way permission shorthand
 * ("Act + Full Access"), never a visible mode.
 * Mirrors `AppMode::parse` / `runtime_policy::legacy_yolo_alias`.
 */
export function isYoloAlias(raw: string | undefined | null): boolean {
  const key = (raw ?? "").trim().toLowerCase();
  return (
    key === "yolo" ||
    key === "4" ||
    key === "bypass" ||
    key === "bypass-permissions" ||
    key === "bypasspermissions"
  );
}

/**
 * Normalize a mode spelling to the persisted setting. Unknown values fall back
 * to Act, matching `AppMode::from_setting` (Multitask folds to Operate,
 * everything unparseable defaults to Act).
 */
export function normalizeMode(raw: string | undefined | null): TuiMode {
  const key = (raw ?? "").trim().toLowerCase();
  return MODE_ALIASES[key] ?? "agent";
}

/** Friendly mode label ("Act" / "Plan" / "Operate"). */
export function modeLabel(raw: string | undefined | null): string {
  return MODE_LABELS[normalizeMode(raw)];
}

/**
 * Normalize a posture spelling to the runtime wire value. Unknown values fall
 * back to Ask, matching `ApprovalMode::from_config_value` plus the default
 * (`Suggest`) when a value is absent or unparseable.
 */
export function normalizePosture(raw: string | undefined | null): PermissionPosture {
  const key = (raw ?? "").trim().toLowerCase();
  return POSTURE_ALIASES[key] ?? "ask";
}

/** Friendly posture label ("Ask" / "Auto-Review" / "Full Access"). */
export function postureLabel(raw: string | undefined | null): string {
  return POSTURE_LABELS[normalizePosture(raw)];
}

/**
 * Resolve the mode a `/mode <arg>` call should apply.
 *
 * Returns `null` for unrecognized arguments. YOLO spellings resolve to Act
 * here; callers must additionally apply the Full Access posture
 * (`isYoloAlias(arg)`), mirroring `commands::mode`.
 */
export function resolveModeArg(raw: string): TuiMode | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  if (isYoloAlias(key)) return "agent";
  return MODE_ALIASES[key] ?? null;
}

/**
 * Derive the effective posture from a thread record.
 *
 * Mirrors `RuntimePolicyProjection::from_persisted` in the TUI: the canonical
 * `permission_posture` field wins, and legacy records fall back to their mode's
 * YOLO alias or `auto_approve`, so the GUI never shows a posture that
 * disagrees with the engine. `trust_mode` is deliberately *not* consulted —
 * the engine ignores it when deriving policy.
 */
export function postureFromThread(thread: {
  permission_posture?: string | null;
  mode?: string | null;
  auto_approve?: boolean | null;
}): PermissionPosture {
  if (thread.permission_posture) return normalizePosture(thread.permission_posture);
  if (isYoloAlias(thread.mode) || thread.auto_approve) return "full_access";
  return "ask";
}
