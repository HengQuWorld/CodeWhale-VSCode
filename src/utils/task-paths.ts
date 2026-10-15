/**
 * Where the TUI keeps task artifacts — the paths the artifact reader resolves
 * against.
 *
 * Extracted from `chat-provider.ts` for independent testing and reuse.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function getHomeDirectory(): string {
  return os.homedir();
}

/**
 * The task data dir, matching what the TUI uses: an explicit
 * `DEEPSEEK_TASKS_DIR` wins, then the current `~/.codewhale/tasks`, then the
 * legacy `~/.deepseek/tasks` when only that one exists.
 */
export function defaultTasksDir(): string {
  const deepseekTasksDir = process.env.DEEPSEEK_TASKS_DIR;
  if (deepseekTasksDir && deepseekTasksDir.trim()) {
    return deepseekTasksDir;
  }
  const home = getHomeDirectory();
  const primary = path.join(home, ".codewhale", "tasks");
  try {
    if (fs.existsSync(primary) && fs.statSync(primary).isDirectory()) {
      return primary;
    }
  } catch {
    // ignore
  }
  const legacy = path.join(home, ".deepseek", "tasks");
  try {
    if (fs.existsSync(legacy) && fs.statSync(legacy).isDirectory()) {
      return legacy;
    }
  } catch {
    // ignore
  }
  return primary;
}

export function resolveTaskArtifactPath(relativeOrAbsolute: string): string {
  if (path.isAbsolute(relativeOrAbsolute)) {
    return path.normalize(relativeOrAbsolute);
  }
  return path.normalize(path.join(defaultTasksDir(), relativeOrAbsolute));
}
