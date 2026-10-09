import { describe, expect, it, vi } from "vitest";
import * as path from "path";

// The engine module reaches for the editor API at import time; path resolution
// itself never does, so a standing stub is enough to load it.
vi.mock("vscode", () => ({ workspace: {} }));

import { engineLaunch, resolveEngine } from "./engine";

/** A fake machine: a home directory, an environment, and the set of paths that
 * exist on it. Nothing here touches the host, so the Windows layouts can be
 * exercised from any platform. */
const HOME = "/Users/whale";
const APPDATA = path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = path.join(HOME, "AppData", "Local");

function machine(files: string[], options: { env?: NodeJS.ProcessEnv; dirs?: Record<string, string[]>; platform?: NodeJS.Platform } = {}) {
  const present = new Set(files);
  return {
    platform: options.platform ?? "win32" as NodeJS.Platform,
    env: options.env ?? {},
    home: HOME,
    exists: (candidate: string) => present.has(candidate),
    readdir: (dir: string) => options.dirs?.[dir] ?? [],
  };
}

function npmBinary(prefix: string) {
  return path.join(prefix, "node_modules", "codewhale", "bin", "downloads", "codewhale.exe");
}

describe("resolveEngine", () => {
  it("uses a configured engine path verbatim, and probes nothing", () => {
    const resolution = resolveEngine("/opt/codewhale/codewhale", machine([]));
    expect(resolution.path).toBe("/opt/codewhale/codewhale");
    expect(resolution.searched).toEqual([]);
  });

  it("reports the bare binary and every probed location when nothing is installed", () => {
    const resolution = resolveEngine("codewhale", machine([]));
    expect(resolution.path).toBe("codewhale.exe");
    expect(resolution.searched).toContain(path.join(LOCALAPPDATA, "Programs", "CodeWhale", "bin", "codewhale.exe"));
    expect(resolution.searched.length).toBeGreaterThan(4);
  });

  it("finds the installer's default location", () => {
    const installed = path.join(LOCALAPPDATA, "Programs", "CodeWhale", "bin", "codewhale.exe");
    expect(resolveEngine("codewhale", machine([installed])).path).toBe(installed);
  });

  it("finds a winget, Volta, bun or Scoop executable", () => {
    const winget = path.join(LOCALAPPDATA, "Microsoft", "WinGet", "Links", "codewhale.exe");
    const volta = path.join(LOCALAPPDATA, "Volta", "bin", "codewhale.exe");
    const bun = path.join(HOME, ".bun", "bin", "codewhale.exe");
    const scoop = path.join(HOME, "scoop", "shims", "codewhale.exe");
    for (const file of [winget, volta, bun, scoop]) {
      expect(resolveEngine("codewhale", machine([file])).path).toBe(file);
    }
  });

  it("finds a plain npm global install under APPDATA", () => {
    const installed = npmBinary(path.join(APPDATA, "npm"));
    expect(resolveEngine("codewhale", machine([installed])).path).toBe(installed);
  });

  it("finds nvm-windows' version directories without trusting the host's Node version", () => {
    // The version installed here is deliberately not the extension host's.
    const nvmHome = path.join(APPDATA, "nvm");
    const installed = npmBinary(path.join(nvmHome, "v22.11.0"));
    const resolution = resolveEngine("codewhale", machine([installed], { dirs: { [nvmHome]: ["v20.11.1", "v22.11.0", "settings.txt"] } }));
    expect(resolution.path).toBe(installed);
  });

  it("finds nvm-windows' globals through the environment it exports", () => {
    const symlink = path.join("C:\\Program Files", "nodejs");
    const installed = npmBinary(symlink);
    const resolution = resolveEngine("codewhale", machine([installed], { env: { NVM_SYMLINK: symlink } }));
    expect(resolution.path).toBe(installed);
  });

  it("finds the executable a PATH holds", () => {
    const bin = path.join("C:\\tools", "codewhale");
    const installed = path.join(bin, "codewhale.exe");
    expect(resolveEngine("codewhale", machine([installed], { env: { Path: bin } })).path).toBe(installed);
  });

  it("derives the executable a PATH shim wraps, when the shim is all PATH has", () => {
    // The shim is on PATH and the executable it runs is not, so only following
    // the shim into its package finds one.
    const bin = path.join("C:\\tools", "bin");
    const shim = path.join(bin, "codewhale.cmd");
    const installed = npmBinary(bin);
    expect(resolveEngine("codewhale", machine([shim, installed], { env: { PATH: bin } })).path).toBe(installed);
  });

  it("derives that executable for a shim inside node_modules/.bin", () => {
    const prefix = path.join("C:\\work", "app");
    const bin = path.join(prefix, "node_modules", ".bin");
    const shim = path.join(bin, "codewhale.cmd");
    const installed = npmBinary(prefix);
    expect(resolveEngine("codewhale", machine([shim, installed], { env: { PATH: bin } })).path).toBe(installed);
  });

  it("falls back to a PATH shim when the shim is all there is", () => {
    const prefix = path.join(APPDATA, "npm");
    const shim = path.join(prefix, "codewhale.cmd");
    expect(resolveEngine("codewhale", machine([shim], { env: { PATH: prefix } })).path).toBe(shim);
  });

  it("keeps the POSIX layouts working, PATH last", () => {
    const posix = { platform: "darwin" as NodeJS.Platform };
    const cargo = path.join(HOME, ".cargo", "bin", "codewhale");
    expect(resolveEngine("codewhale", machine([cargo], posix)).path).toBe(cargo);

    const bin = path.join(HOME, ".local", "bin");
    const installed = path.join(bin, "codewhale");
    expect(resolveEngine("codewhale", machine([installed], { ...posix, env: { PATH: bin } })).path).toBe(installed);

    expect(resolveEngine("codewhale", machine([], posix)).path).toBe("codewhale");
  });

  it("leaves PATH to the kernel on POSIX", () => {
    // A POSIX install found only through PATH keeps resolving to the bare name,
    // as it always did: execvp searches PATH and checks the executable bit, and
    // hand-rolling that with an existence probe would be strictly worse.
    const posix = { platform: "darwin" as NodeJS.Platform };
    const bin = path.join(HOME, "elsewhere", "bin");
    const installed = path.join(bin, "codewhale");
    expect(resolveEngine("codewhale", machine([installed], { ...posix, env: { PATH: bin } })).path).toBe("codewhale");
  });

  // This change is about Windows. On macOS and Linux an install that already
  // resolved must keep resolving to the same binary, because resolution is
  // first-hit-wins and these probes were inserted among older ones.
  describe("does not move an existing POSIX install", () => {
    const posix = { platform: "darwin" as NodeJS.Platform };

    it("prefers the long-standing package path over the newer manager bin", () => {
      const npmGlobal = "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale";
      const formulaBin = "/opt/homebrew/bin/codewhale";
      expect(resolveEngine("codewhale", machine([formulaBin, npmGlobal], posix)).path).toBe(npmGlobal);
    });

    it("keeps cargo ahead of every newer probe", () => {
      const cargo = path.join(HOME, ".cargo", "bin", "codewhale");
      const newer = [
        "/opt/homebrew/bin/codewhale",
        "/usr/local/bin/codewhale",
        path.join(HOME, ".local", "bin", "codewhale"),
        path.join(HOME, ".bun", "bin", "codewhale"),
      ];
      expect(resolveEngine("codewhale", machine([...newer, cargo], posix)).path).toBe(cargo);
    });

    it("keeps cargo ahead of an npm prefix", () => {
      const cargo = path.join(HOME, ".cargo", "bin", "codewhale");
      const prefix = path.join(HOME, "npm-prefix");
      const viaPrefix = path.join(prefix, "lib", "node_modules", "codewhale", "bin", "downloads", "codewhale");
      const resolution = resolveEngine("codewhale", machine([cargo, viaPrefix], { ...posix, env: { npm_config_prefix: prefix } }));
      expect(resolution.path).toBe(cargo);
    });

    it("still reaches the newer probes when nothing older exists", () => {
      const installed = path.join(HOME, ".local", "bin", "codewhale");
      expect(resolveEngine("codewhale", machine([installed], posix)).path).toBe(installed);

      const prefix = path.join(HOME, "npm-prefix");
      const viaPrefix = path.join(prefix, "lib", "node_modules", "codewhale", "bin", "downloads", "codewhale");
      expect(resolveEngine("codewhale", machine([viaPrefix], { ...posix, env: { npm_config_prefix: prefix } })).path).toBe(viaPrefix);
    });
  });

  it("prefers a known layout over an unrelated PATH hit", () => {
    const unrelated = path.join("C:\\stale", "codewhale.exe");
    const installed = path.join(LOCALAPPDATA, "Programs", "CodeWhale", "bin", "codewhale.exe");
    expect(resolveEngine("codewhale", machine([unrelated, installed], { env: { PATH: "C:\\stale" } })).path).toBe(installed);
  });
});

describe("engineLaunch", () => {
  it("runs an executable directly, with its arguments untouched", () => {
    const args = ["--workspace", "C:\\work dir", "serve", "--port", "7878"];
    expect(engineLaunch("C:\\bin\\codewhale.exe", args)).toEqual({
      command: "C:\\bin\\codewhale.exe",
      args,
      verbatim: false,
    });
  });

  it("hands a .cmd shim to the command interpreter as one quoted line", () => {
    const shim = path.join(APPDATA, "npm", "codewhale.cmd");
    const launch = engineLaunch(shim, ["--workspace", "C:\\work dir", "serve"], { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
    expect(launch.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(launch.verbatim).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // The whole line is wrapped for `cmd /s`, so a path with a space survives.
    expect(launch.args[3]).toBe(`""${shim}" "--workspace" "C:\\work dir" "serve""`);
  });

  it("does not route a POSIX path through an interpreter", () => {
    const launch = engineLaunch("/usr/local/bin/codewhale", ["serve"]);
    expect(launch.command).toBe("/usr/local/bin/codewhale");
    expect(launch.verbatim).toBe(false);
  });
});
