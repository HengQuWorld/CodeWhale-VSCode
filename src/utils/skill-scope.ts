/**
 * Project/global split for the Skills panel.
 *
 * The engine's `GET /v1/skills` row carries each skill's real `SKILL.md` path
 * but no scope, and the panel has to group by scope. The one fact the client
 * can check for itself is containment: a skill whose `SKILL.md` sits inside the
 * workspace the engine scanned is a project skill; everything else (the global
 * `~/.codewhale/skills`, a configured dir elsewhere, a compatible harness root
 * under HOME) is global. So the split is derived from the path the engine
 * reports, not guessed from a name.
 *
 * Built-in skills are *not* classified here: the engine already marks them
 * (`is_bundled`), and the panel keeps them in their own group so "Global" means
 * "what you installed globally" rather than "everything outside the project".
 */

export type SkillScope = "project" | "global";

/** Compare-ready form: forward slashes, no trailing separator. Case is left
 *  alone — the engine reports both paths from the same machine, and folding
 *  case would merge distinct directories on a case-sensitive filesystem. */
function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Windows drive-path roots compare case-insensitively ('C:\\ws' vs 'c:/ws');
 *  a POSIX root does not. Only applied as a fallback, so an exact match always
 *  wins and a case-sensitive filesystem is never second-guessed. */
function isDriveRoot(root: string): boolean {
  return /^[a-zA-Z]:/.test(root);
}

/** Whether `file` is `root` itself or sits beneath it, on a path boundary. */
function isInside(file: string, root: string): boolean {
  if (!root) return false;
  if (file === root) return true;
  if (file.startsWith(root + "/")) return true;
  if (isDriveRoot(root) && file.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return true;
  }
  return false;
}

/**
 * Which scope a skill's `SKILL.md` belongs to, given the workspace the engine
 * scanned. A missing path (reviewed plugin snapshots carry none) or a missing
 * workspace answers `global`: with nothing to check containment against, the
 * safe grouping is the one that does not claim a project membership.
 */
export function classifySkillScope(
  skillPath: string | null | undefined,
  workspace: string | null | undefined
): SkillScope {
  const file = normalize(skillPath ?? "");
  const root = normalize(workspace ?? "");
  if (!file || !root) return "global";
  return isInside(file, root) ? "project" : "global";
}
