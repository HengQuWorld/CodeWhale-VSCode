/**
 * The completion cue's gates and its delivery.
 *
 * What matters here is that the cue is *stoppable and quiet when it should be*:
 * the user's setting wins over everything, a burst of finished turns is one
 * sound rather than a rattle, and a machine without a player costs nothing but
 * a false. Every test gets a fresh module, because the floor between cues is
 * module state and one test's clock must not leak into the next.
 *
 * Which player this machine happens to have is not part of any expectation: the
 * host's clock, platform and PATH check are all injected, so these tests answer
 * the same on macOS and on the Linux machine CI runs them on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const state = vi.hoisted(() => ({
  enabled: true,
  children: [] as Array<{ on: ReturnType<typeof vi.fn> }>,
  spawn: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback?: unknown) =>
        key === "completionSound" ? state.enabled : fallback,
    })),
  },
}));

/** Only `spawn` is faked: the module's own defaults (PATH lookup) still run. */
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: (...args: unknown[]) => state.spawn(...args),
}));

const EXTENSION = "/ext";
const CHIME = "/ext/media/completion-chime.wav";
/** A host that can always play: the player choice is what is under test. */
const HOST = { platform: "darwin" as NodeJS.Platform, isRunnable: () => true };

beforeEach(() => {
  state.enabled = true;
  state.children.length = 0;
  state.spawn.mockReset();
  state.spawn.mockImplementation(() => {
    const child = { on: vi.fn() };
    state.children.push(child);
    return child;
  });
});

/** A module instance whose floor starts fresh. */
async function freshModule() {
  vi.resetModules();
  return await import("./completion-sound");
}

describe("completion sound players", () => {
  it("uses afplay on macOS", async () => {
    const { completionSoundCommands } = await freshModule();
    expect(completionSoundCommands("darwin", CHIME)).toEqual([
      { command: "/usr/bin/afplay", args: [CHIME] },
    ]);
  });

  it("tries paplay before aplay on Linux", async () => {
    const { completionSoundCommands } = await freshModule();
    expect(completionSoundCommands("linux", CHIME)).toEqual([
      { command: "paplay", args: [CHIME] },
      { command: "aplay", args: ["-q", CHIME] },
    ]);
  });

  it("hands Windows a WAV player through PowerShell, escaping the path", async () => {
    const { completionSoundCommands } = await freshModule();
    const [command] = completionSoundCommands("win32", "C:\\Users\\o'brien\\chime.wav");
    expect(command.command).toBe("powershell");
    expect(command.args.at(-1)).toBe(
      "(New-Object Media.SoundPlayer 'C:\\Users\\o''brien\\chime.wav').PlaySync()",
    );
  });

  it("offers nothing on a platform it has no player for", async () => {
    const { completionSoundCommands } = await freshModule();
    expect(completionSoundCommands("sunos", CHIME)).toEqual([]);
  });

  it("resolves to the first player that is actually there", async () => {
    const { resolveSoundCommand } = await freshModule();
    const present = (command: string) => command === "aplay";
    expect(resolveSoundCommand("linux", CHIME, present)).toEqual({
      command: "aplay",
      args: ["-q", CHIME],
    });
  });

  it("resolves to nothing when no candidate is installed", async () => {
    const { resolveSoundCommand } = await freshModule();
    expect(resolveSoundCommand("linux", CHIME, () => false)).toBeUndefined();
  });

  it("looks for a bare player name on PATH, and finds nothing when it is not there", async () => {
    const { resolveSoundCommand } = await freshModule();
    const withPlayer = fs.mkdtempSync(path.join(os.tmpdir(), "completion-cue-path-"));
    const withoutPlayer = fs.mkdtempSync(path.join(os.tmpdir(), "completion-cue-empty-"));
    fs.writeFileSync(path.join(withPlayer, "paplay"), "");
    const previousPath = process.env.PATH;
    try {
      // The default check is the one under test here: a name it can only
      // answer for by walking PATH.
      process.env.PATH = withPlayer;
      expect(resolveSoundCommand("linux", CHIME)).toEqual({ command: "paplay", args: [CHIME] });
      process.env.PATH = withoutPlayer;
      expect(resolveSoundCommand("linux", CHIME)).toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(withPlayer, { recursive: true, force: true });
      fs.rmSync(withoutPlayer, { recursive: true, force: true });
    }
  });
});

describe("playCompletionSound", () => {
  it("starts the platform player on the bundled cue", async () => {
    const { playCompletionSound } = await freshModule();

    expect(playCompletionSound(EXTENSION, { ...HOST, nowMs: 1_000 })).toBe(true);
    expect(state.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/afplay", [CHIME], {
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("falls through to the player this host does have", async () => {
    const { playCompletionSound } = await freshModule();

    expect(
      playCompletionSound(EXTENSION, {
        nowMs: 1_000,
        platform: "linux",
        isRunnable: (command) => command === "aplay",
      }),
    ).toBe(true);
    expect(state.spawn).toHaveBeenCalledExactlyOnceWith("aplay", ["-q", CHIME], {
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("stays silent when the user turned the setting off", async () => {
    const { completionSoundEnabled, playCompletionSound } = await freshModule();
    state.enabled = false;

    expect(completionSoundEnabled()).toBe(false);
    expect(playCompletionSound(EXTENSION, { ...HOST, nowMs: 1_000 })).toBe(false);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("stays silent when this host has no player", async () => {
    const { playCompletionSound } = await freshModule();

    expect(playCompletionSound(EXTENSION, { nowMs: 1_000, isRunnable: () => false })).toBe(false);
    expect(playCompletionSound(EXTENSION, { nowMs: 2_000, platform: "sunos" })).toBe(false);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("sounds once when turns finish together, then again after the floor", async () => {
    const { COMPLETION_SOUND_MIN_INTERVAL_MS, playCompletionSound } = await freshModule();
    const host = { ...HOST, nowMs: 10_000 };

    expect(playCompletionSound(EXTENSION, host)).toBe(true);
    expect(
      playCompletionSound(EXTENSION, { ...host, nowMs: 10_000 + COMPLETION_SOUND_MIN_INTERVAL_MS - 1 }),
    ).toBe(false);
    expect(
      playCompletionSound(EXTENSION, { ...host, nowMs: 10_000 + COMPLETION_SOUND_MIN_INTERVAL_MS }),
    ).toBe(true);
    expect(state.spawn).toHaveBeenCalledTimes(2);
  });

  it("listens for the player failing, so a broken one never reaches the turn", async () => {
    const { playCompletionSound } = await freshModule();

    playCompletionSound(EXTENSION, { ...HOST, nowMs: 1_000 });
    const child = state.children[0];
    // Not awaited and not reported: an 'error' with no listener would take the
    // extension host down with it.
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.on).toHaveBeenCalledWith("exit", expect.any(Function));
  });

  it("survives a spawn that throws", async () => {
    const { playCompletionSound } = await freshModule();
    state.spawn.mockImplementation(() => {
      throw new Error("EMFILE");
    });

    expect(playCompletionSound(EXTENSION, { ...HOST, nowMs: 1_000 })).toBe(false);
  });
});
