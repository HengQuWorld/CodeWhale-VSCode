/**
 * The audible "a turn finished" cue.
 *
 * The host plays it, not the webview: the point of the cue is to reach a user
 * who has looked away, and a sidebar webview that is not on screen can be
 * suspended — taking anything queued for the speakers with it.
 *
 * Delivery mirrors the TUI's own audio dispatch (`crates/tui/src/notify/audio.rs`):
 * a bundled WAV handed to the platform's player, best-effort and out of band, so
 * a machine with no player costs a silent skip and never the turn that just
 * ended. The cue itself is an original two-note chime — see `media/README.md`.
 *
 * The cue is that bundled file and nothing else: it is played from the
 * extension's own absolute path only while the file is really there, because a
 * path this host cannot vouch for is resolved by the player against whatever
 * directory the process runs in, and a unit test must never be able to make the
 * user's speakers a side effect.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** VS Code setting that gates the cue: `brotherwhale.completionSound`. */
export const COMPLETION_SOUND_SETTING = "completionSound";

/** The bundled cue, relative to the extension root. */
export const COMPLETION_SOUND_FILE = "completion-chime.wav";

/**
 * Two turns finishing together — a parked thread and the one being watched —
 * must not stack into a rattle. The TUI's own event sound policy carries the
 * same floor (`notifications.event_sound.min_interval_ms`).
 */
export const COMPLETION_SOUND_MIN_INTERVAL_MS = 1000;

export interface SoundCommand {
  command: string;
  args: string[];
}

/** When the cue was last started. Module-level so the floor spans every thread. */
let lastPlayedMs = Number.NEGATIVE_INFINITY;

/** Whether the user wants the cue (VS Code setting `brotherwhale.completionSound`). */
export function completionSoundEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("brotherwhale")
    .get<boolean>(COMPLETION_SOUND_SETTING, true);
}

/**
 * The players to try, in order, for `file` on `platform`.
 *
 * Windows goes through PowerShell because Node has no audio API of its own and
 * `SoundPlayer` is the one WAV player present on every Windows install;
 * `PlaySync` blocks, which is what a throwaway child process is for.
 */
export function completionSoundCommands(
  platform: NodeJS.Platform,
  file: string,
): SoundCommand[] {
  switch (platform) {
    case "darwin":
      return [{ command: "/usr/bin/afplay", args: [file] }];
    case "linux":
      return [
        { command: "paplay", args: [file] },
        { command: "aplay", args: ["-q", file] },
      ];
    case "win32":
      return [
        {
          command: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
          ],
        },
      ];
    default:
      return [];
  }
}

/**
 * The first player for `file` that is actually there. `isRunnable` is
 * injectable so the choice can be pinned without the machine's PATH.
 */
export function resolveSoundCommand(
  platform: NodeJS.Platform,
  file: string,
  isRunnable: (command: string) => boolean = commandIsRunnable,
): SoundCommand | undefined {
  return completionSoundCommands(platform, file).find((candidate) =>
    isRunnable(candidate.command),
  );
}

/** Absolute paths are checked in place; bare names are looked up on PATH. */
function commandIsRunnable(command: string): boolean {
  try {
    if (path.isAbsolute(command)) return fs.existsSync(command);
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    return dirs.some((dir) => fs.existsSync(path.join(dir, command)));
  } catch {
    return false;
  }
}

/**
 * The bundled cue's absolute path, or undefined when this host cannot vouch for
 * the file.
 *
 * A cue is *this extension's own* file and nothing else, so two things have to
 * hold before a player is even considered: `extensionPath` is the absolute
 * directory the provider was handed (`extensionUri.fsPath`), and the cue is
 * really there.
 *
 * A relative path fails the first test, and that is not pedantry: the player
 * resolves it against whatever directory the host process happens to run in.
 * That is how `npm test` came to ring the cue out of the repository under test
 * — a provider built without an extension URI passed `""`, the path degraded to
 * `media/completion-chime.wav`, and that file really does sit in the repository
 * the tests run from, so a unit test played the chime for real (five times per
 * full run on the machine of whoever ran it). Silence is the only safe answer
 * for a path we cannot vouch for.
 */
export function bundledCuePath(extensionPath: string): string | undefined {
  if (!extensionPath || !path.isAbsolute(extensionPath)) return undefined;
  const file = path.join(extensionPath, "media", COMPLETION_SOUND_FILE);
  try {
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What this machine says about playing a cue: the clock, the platform and
 * whether a player can be run. All three default to the real host, and all
 * three are injectable so a test pins them instead of inheriting them — the
 * host's own answers are what production uses.
 */
export interface CompletionSoundHost {
  nowMs?: number;
  platform?: NodeJS.Platform;
  isRunnable?: (command: string) => boolean;
}

/**
 * Play the cue for a finished turn. Returns true when a player was started.
 *
 * Silent no-ops: the setting is off, the extension path names no cue we can
 * vouch for (see `bundledCuePath`), the last cue is still within the floor, or
 * this host has no player to run.
 */
export function playCompletionSound(
  extensionPath: string,
  host: CompletionSoundHost = {},
): boolean {
  const { nowMs = Date.now(), platform = process.platform, isRunnable } = host;
  if (!completionSoundEnabled()) return false;
  // Settled before the floor and before any player is looked up: a path this
  // host cannot vouch for is not a cue, so nothing downstream has to reason
  // about it (and no PATH walk is spent on it).
  const file = bundledCuePath(extensionPath);
  if (!file) return false;
  if (nowMs - lastPlayedMs < COMPLETION_SOUND_MIN_INTERVAL_MS) return false;
  const resolved = resolveSoundCommand(platform, file, isRunnable);
  if (!resolved) return false;
  // Take the slot before spawning: a burst of completions is throttled whether
  // or not the player itself turns out to work.
  lastPlayedMs = nowMs;
  try {
    const child = spawn(resolved.command, resolved.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    // A cue that cannot be heard must never disturb the turn that ended: the
    // player is not awaited, and its failure (or absence, asynchronously) is
    // swallowed here rather than surfacing as an unhandled child process.
    child.on("error", () => undefined);
    child.on("exit", () => undefined);
    return true;
  } catch {
    return false;
  }
}
