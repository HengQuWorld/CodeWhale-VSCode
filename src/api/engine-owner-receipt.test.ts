import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("vscode", () => ({ workspace: {} }));

import { engineStartupError, ownerReceiptPath, retireDeadOwnerReceipt, retirementPid } from "./engine";

const HOME = "/Users/whale";
const DEFAULT_RECEIPT = path.join(HOME, ".codewhale", "run", "daemon.owner.json");
const WIN_FALLBACK = "C:\\Users\\fallback";

/** A record as the engine writes it — only `pid` matters here. */
function record(pid: number): string {
  return JSON.stringify({ version: 1, pid, lease_generation: "lease-1", socket_path: "\\\\.\\pipe\\codewhale-owner" });
}

/** A fake disk. `contents === null` stands for a path with no record. */
function makeDisk(contents: string | null) {
  const removed: string[] = [];
  return {
    removed,
    readFile: () => {
      if (contents === null) throw new Error("ENOENT");
      return contents;
    },
    remove: (file: string) => { removed.push(file); },
  };
}

describe("ownerReceiptPath", () => {
  it("is the default CodeWhale home's run directory", () => {
    expect(ownerReceiptPath({}, HOME)).toBe(DEFAULT_RECEIPT);
  });

  it("follows an absolute selected home", () => {
    expect(ownerReceiptPath({ CODEWHALE_HOME: "C:\\state" }, HOME, "win32"))
      .toBe("C:\\state\\run\\daemon.owner.json");
  });

  it("ignores an empty, blank or relative selected home", () => {
    // The engine rejects a relative override rather than resolving it against
    // the working directory — it refuses to start at all, writing no record —
    // and an absolute-only rule is what keeps this from naming a stray file.
    for (const value of ["", "   ", ".", "build", "state/codewhale"]) {
      expect(ownerReceiptPath({ CODEWHALE_HOME: value }, HOME)).toBe(DEFAULT_RECEIPT);
    }
  });

  it("expands a leading tilde the way the engine does", () => {
    expect(ownerReceiptPath({ CODEWHALE_HOME: "~/state" }, HOME, "darwin"))
      .toBe(path.posix.join(HOME, "state", "run", "daemon.owner.json"));
    expect(ownerReceiptPath({ CODEWHALE_HOME: "~" }, HOME, "darwin"))
      .toBe(path.posix.join(HOME, "run", "daemon.owner.json"));
  });

  it("follows the engine's user-home order, not the platform's own answer", () => {
    // HOME outranks USERPROFILE: the engine reads HOME first, and os.homedir()
    // never reads it at all.
    expect(ownerReceiptPath({ HOME: "C:\\Users\\from-home", USERPROFILE: "C:\\Users\\from-profile" }, WIN_FALLBACK, "win32"))
      .toBe("C:\\Users\\from-home\\.codewhale\\run\\daemon.owner.json");
    expect(ownerReceiptPath({ USERPROFILE: "C:\\Users\\from-profile" }, WIN_FALLBACK, "win32"))
      .toBe("C:\\Users\\from-profile\\.codewhale\\run\\daemon.owner.json");
    expect(ownerReceiptPath({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\from-drive" }, WIN_FALLBACK, "win32"))
      .toBe("C:\\Users\\from-drive\\.codewhale\\run\\daemon.owner.json");
    expect(ownerReceiptPath({}, WIN_FALLBACK, "win32"))
      .toBe("C:\\Users\\fallback\\.codewhale\\run\\daemon.owner.json");
  });

  it("lets the environment win over the supplied home, as the engine does", () => {
    expect(ownerReceiptPath({ HOME: "/home/from-env" }, "/home/fallback"))
      .toBe(path.posix.join("/home/from-env", ".codewhale", "run", "daemon.owner.json"));
  });

  it("ignores a POSIX-shaped home on Windows, as the engine does", () => {
    // Git Bash hands the process HOME=/c/Users/ben. Rust does not call that
    // absolute on Windows, so the engine falls through to USERPROFILE — and so
    // must this, or the recovery would name a file the engine never wrote.
    expect(ownerReceiptPath({ HOME: "/c/Users/ben", USERPROFILE: "C:\\Users\\ben" }, WIN_FALLBACK, "win32"))
      .toBe("C:\\Users\\ben\\.codewhale\\run\\daemon.owner.json");
  });

  it("falls through where the engine would give up, and that is inert", () => {
    // A deliberate divergence, documented on `engineUserHome`: a set-but-relative
    // HOME stops the engine cold, so no record exists to find either way.
    expect(ownerReceiptPath({ HOME: "." }, HOME)).toBe(DEFAULT_RECEIPT);
    expect(fs.existsSync(DEFAULT_RECEIPT)).toBe(false);
  });

  it("uses POSIX rules off Windows", () => {
    expect(ownerReceiptPath({ USERPROFILE: "C:\\Users\\ben" }, HOME, "darwin")).toBe(DEFAULT_RECEIPT);
  });
});

describe("retireDeadOwnerReceipt", () => {
  it("leaves nothing behind when there is no record", () => {
    const disk = makeDisk(null);
    const result = retireDeadOwnerReceipt({ env: {}, home: HOME, readFile: disk.readFile, remove: disk.remove });
    expect(result).toEqual({ path: DEFAULT_RECEIPT, retired: false, found: false, reason: "no readable owner record" });
    expect(disk.removed).toEqual([]);
  });

  it("reports a record it found and left alone, and stays quiet about an absent one", () => {
    const found = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      readFile: () => record(4242),
      remove: () => undefined,
      isAlive: () => true,
    });
    expect(found.found).toBe(true);

    const absent = retireDeadOwnerReceipt({ env: {}, home: HOME, readFile: () => { throw new Error("ENOENT"); } });
    expect(absent.found).toBe(false);
  });

  it("removes a record naming a process that is gone", () => {
    const disk = makeDisk(record(4242));
    const result = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      readFile: disk.readFile,
      remove: disk.remove,
      isAlive: () => false,
    });
    expect(result.retired).toBe(true);
    expect(result.reason).toContain("4242");
    expect(disk.removed).toEqual([DEFAULT_RECEIPT]);
  });

  it("never removes a record naming a live process", () => {
    const disk = makeDisk(record(4242));
    const result = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      readFile: disk.readFile,
      remove: disk.remove,
      isAlive: () => true,
    });
    expect(result.retired).toBe(false);
    expect(result.reason).toContain("still running");
    expect(disk.removed).toEqual([]);
  });

  it("never removes another process's record when asked for one child", () => {
    const disk = makeDisk(record(4242));
    const result = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      onlyPid: 1111,
      readFile: disk.readFile,
      remove: disk.remove,
      isAlive: () => false,
    });
    expect(result.retired).toBe(false);
    expect(result.reason).toContain("not this child");
    expect(disk.removed).toEqual([]);
  });

  it("removes its own child's record", () => {
    const disk = makeDisk(record(1111));
    const result = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      onlyPid: 1111,
      readFile: disk.readFile,
      remove: disk.remove,
      isAlive: () => false,
    });
    expect(result.retired).toBe(true);
    expect(disk.removed).toEqual([DEFAULT_RECEIPT]);
  });

  it("leaves a record it cannot understand", () => {
    for (const contents of ["not json", "{}", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: "12" })]) {
      const disk = makeDisk(contents);
      const result = retireDeadOwnerReceipt({
        env: {},
        home: HOME,
        readFile: disk.readFile,
        remove: disk.remove,
        isAlive: () => false,
      });
      expect(result.retired).toBe(false);
      expect(disk.removed).toEqual([]);
    }
  });

  it("reports, rather than throws, when removal fails", () => {
    const result = retireDeadOwnerReceipt({
      env: {},
      home: HOME,
      readFile: () => record(4242),
      remove: () => { throw new Error("EPERM"); },
      isAlive: () => false,
    });
    expect(result.retired).toBe(false);
    expect(result.reason).toContain("EPERM");
  });

  it("honours a selected home, as a caller with CODEWHALE_HOME would", () => {
    const selected = path.join("C:\\", "state");
    const disk = makeDisk(record(4242));
    const result = retireDeadOwnerReceipt({
      env: { CODEWHALE_HOME: selected },
      platform: "win32",
      readFile: disk.readFile,
      remove: disk.remove,
      isAlive: () => false,
    });
    expect(result.path).toBe("C:\\state\\run\\daemon.owner.json");
    expect(disk.removed).toEqual(["C:\\state\\run\\daemon.owner.json"]);
  });
});

/** The tests above inject `isAlive`, so none of them would notice if the real
 * liveness check were inverted — and that check is the only thing standing
 * between a stale record and a live engine's. These two exercise it for real:
 * the default reader, the default removal, and the default `processAlive`. */
describe("the real liveness check", () => {
  function withRecord(pid: number, body: (home: string) => void): void {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cw-owner-"));
    fs.mkdirSync(path.join(home, "run"));
    fs.writeFileSync(path.join(home, "run", "daemon.owner.json"), record(pid));
    try {
      body(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it("leaves the record of this very process alone", () => {
    withRecord(process.pid, home => {
      const result = retireDeadOwnerReceipt({ env: { CODEWHALE_HOME: home }, platform: process.platform });
      expect(result.retired).toBe(false);
      expect(result.reason).toContain("still running");
      expect(fs.existsSync(path.join(home, "run", "daemon.owner.json"))).toBe(true);
    });
  });

  it("removes the record of a process that has already exited", () => {
    const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = dead.pid!;
    // The child has exited by the time spawnSync returns; its pid is now dead.
    withRecord(pid, home => {
      const result = retireDeadOwnerReceipt({ env: { CODEWHALE_HOME: home }, platform: process.platform });
      expect(result.retired).toBe(true);
      expect(fs.existsSync(path.join(home, "run", "daemon.owner.json"))).toBe(false);
    });
  });
});

describe("retirementPid", () => {
  it("constrains retirement to the child's pid when we launched the engine itself", () => {
    expect(retirementPid(false, 1111)).toBe(1111);
  });

  it("drops the constraint when the child is only an interpreter", () => {
    // The record names the engine, never the `cmd.exe` we hold, so a pid guard
    // here would make the cleanup fail on every npm-shim install.
    expect(retirementPid(true, 1111)).toBeUndefined();
  });

  it("keeps an unknown pid unknown", () => {
    expect(retirementPid(false, undefined)).toBeUndefined();
  });
});

describe("engineStartupError", () => {
  it("passes an ordinary refusal through", () => {
    expect(engineStartupError("error: no model configured").message)
      .toBe("Engine exited before becoming ready: error: no model configured");
  });

  it("names the recovery for a stranded owner record", () => {
    const message = engineStartupError("error: opening selected Windows owner; refusing fallback").message;
    expect(message).toContain("opening selected Windows owner");
    expect(message).toContain("daemon.owner.json");
    expect(message).toContain("no CodeWhale is running");
  });

  it("does not offer recovery advice when nothing was stranded", () => {
    expect(engineStartupError("error: no model configured").message)
      .not.toContain("daemon.owner.json");
  });

  it("does not mistake another owner error for a stranded record", () => {
    // The engine has several `selected Windows owner ...` refusals; only the
    // one about opening a pipe is cleared by deleting a record.
    for (const unrelated of [
      "error: selected Windows owner home unavailable",
      "error: selected Windows owner parent changed during publication",
      "error: connected Windows server is not the selected owner",
    ]) {
      expect(engineStartupError(unrelated).message).not.toContain("daemon.owner.json");
    }
  });
});
