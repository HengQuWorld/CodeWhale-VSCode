/**
 * Resolution of file paths recorded by the runtime.
 *
 * Two conventions meet here:
 *  - File tools (`edit`, `write`, `apply_patch`, …) record the path the model
 *    requested, which is relative to the thread workspace.
 *  - Task artifacts are recorded relative to the TUI task data dir.
 *
 * A recorded path therefore has to be tried against both, workspace first —
 * resolving it against the task dir alone reports "no longer available" for
 * every ordinary file tool call.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Resolves a recorded path to an absolute path on disk.
 *
 * Absolute paths are returned normalized. Relative paths are resolved against
 * each workspace root in turn; the task data dir is the fallback for genuine
 * artifacts. When nothing exists, the first workspace root (or the task data
 * dir when no workspace is open) is returned so callers can report a path that
 * explains what was missing.
 */
export function resolveRecordedFilePath(
  recorded: string,
  workspaceRoots: readonly string[],
  taskDataDir: string,
): string {
  if (path.isAbsolute(recorded)) return path.normalize(recorded);

  for (const root of workspaceRoots) {
    if (!root) continue;
    const candidate = path.normalize(path.join(root, recorded));
    if (fs.existsSync(candidate)) return candidate;
  }

  const artifact = path.normalize(path.join(taskDataDir, recorded));
  if (fs.existsSync(artifact)) return artifact;

  return workspaceRoots.length > 0 && workspaceRoots[0]
    ? path.normalize(path.join(workspaceRoots[0], recorded))
    : artifact;
}
