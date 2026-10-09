/**
 * The extension's telemetry posture, pinned.
 *
 * The extension's whole contribution to usage counting is a setting and a
 * surface name — everything else belongs to the engine. These tests hold that
 * line: they assert the setting reads with the contract's default, that the
 * declared surface is a name the engine actually accepts, and that the
 * extension spawns the engine with exactly the two environment variables the
 * contract defines and nothing else.
 *
 * The last one is the important one. A future change that starts building a
 * payload, opening a buffer, or minting an identity here would have to add an
 * environment variable or a file to do it, and the assertions below fail.
 */

import { describe, expect, it, vi } from "vitest";

const getConfiguration = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (...args: unknown[]) => getConfiguration(...args),
  },
}));

import {
  EMBEDDED_SURFACE,
  TELEMETRY_SETTING,
  telemetryEnabled,
  telemetryEnv,
} from "./telemetry-settings";
import * as fs from "fs";
import * as path from "path";

/**
 * The surface names the engine's published whitelist accepts, as this
 * repository understands them.
 *
 * Restated here rather than imported: this repository does not depend on the
 * engine's source. So this list pins *our* expectation, not the contract — it
 * catches a surface this project invents, not one the engine later drops. The
 * engine's own list remains the authority.
 */
const ENGINE_SURFACES = [
  "tui",
  "exec",
  "cli",
  "app-server",
  "mcp-server",
  "serve",
  "website",
  "web-app",
  "desktop",
  "control-plane",
  "vscode-extension",
];

describe("the declared surface", () => {
  it("is a name the engine's whitelist accepts", () => {
    expect(ENGINE_SURFACES).toContain(EMBEDDED_SURFACE);
  });

  it("never claims the interactive surface", () => {
    // The engine refuses `tui` from an embedder, and it is right to: nothing
    // starts the terminal UI on a user's behalf.
    expect(EMBEDDED_SURFACE).not.toBe("tui");
  });

  it("names a kind of client, not the editor or this product", () => {
    // The contract says the editor's own name and version are not collected,
    // and a surface naming a vendor would narrow the field for every later
    // extension built on the same engine.
    for (const forbidden of ["vscode", "code", "trae", "cursor", "windsurf"]) {
      expect(EMBEDDED_SURFACE).not.toBe(forbidden);
    }
    expect(EMBEDDED_SURFACE).toBe("vscode-extension");
  });
});

describe("the setting", () => {
  it("reads the one documented key", () => {
    getConfiguration.mockReturnValue({ get: (_k: string, d: unknown) => d });
    telemetryEnabled();
    expect(getConfiguration).toHaveBeenCalledWith("brotherwhale");
    expect(TELEMETRY_SETTING).toBe("telemetry");
  });

  it("defaults to on, which is the contract's default for every surface", () => {
    getConfiguration.mockReturnValue({ get: (_k: string, d: unknown) => d });
    expect(telemetryEnabled()).toBe(true);
  });

  it("honours an explicit off", () => {
    getConfiguration.mockReturnValue({ get: () => false });
    expect(telemetryEnabled()).toBe(false);
  });

  it("reads an absent value as the default rather than as a refusal", () => {
    // A mis-typed setting is not a user answer; the contract makes the same
    // distinction between a durable opt-out and a malformed value.
    getConfiguration.mockReturnValue({ get: (_k: string, d: unknown) => d });
    expect(telemetryEnabled()).toBe(true);
  });

  it("is declared application-scoped, so a workspace cannot override it", () => {
    // The privacy half of this. A repository shipping `.vscode/settings.json`
    // must not be able to turn reporting back on for someone who turned it off,
    // which is what a `window` or `resource` scope would allow. `application`
    // means user settings only — the same scope VS Code gives its own telemetry
    // level.
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const declared = pkg.contributes.configuration.properties[
      `brotherwhale.${TELEMETRY_SETTING}`
    ] as { scope?: string; default?: unknown };
    expect(declared).toBeDefined();
    expect(declared.scope).toBe("application");
    expect(declared.default).toBe(true);
  });
});

describe("what the extension tells the engine", () => {
  it("declares the surface and nothing else when reporting is on", () => {
    expect(telemetryEnv(true)).toEqual({
      CODEWHALE_TELEMETRY_SURFACE: "vscode-extension",
    });
  });

  it("adds only a run-scoped kill switch when reporting is off", () => {
    expect(telemetryEnv(false)).toEqual({
      CODEWHALE_TELEMETRY_SURFACE: "vscode-extension",
      CODEWHALE_TELEMETRY: "0",
    });
  });

  it("never grows a third variable", () => {
    // This is the line that keeps the extension a client of the engine's
    // telemetry rather than a second collector. An endpoint, an install id, or
    // a payload would each have to arrive through one of these names, and any
    // such addition fails here first.
    expect(Object.keys(telemetryEnv(true))).toEqual(["CODEWHALE_TELEMETRY_SURFACE"]);
    expect(Object.keys(telemetryEnv(false)).sort()).toEqual([
      "CODEWHALE_TELEMETRY",
      "CODEWHALE_TELEMETRY_SURFACE",
    ]);
  });

  it("never sets an endpoint or an identity", () => {
    for (const enabled of [true, false]) {
      const env = telemetryEnv(enabled);
      for (const forbidden of [
        "CODEWHALE_TELEMETRY_ENDPOINT",
        "CODEWHALE_HOME",
        "CODEWHALE_INSTALL_ID",
        "CODEWHALE_TELEMETRY_FLOOR",
      ]) {
        expect(env).not.toHaveProperty(forbidden);
      }
    }
  });

  it("turns reporting off without touching the shared privacy state", () => {
    // The contract separates a durable opt-out (which wipes the buffer and
    // leaves a tombstone) from a run-scoped kill switch (which touches
    // nothing). The extension may only ask for the latter: it does not own the
    // home, the identity, or the buffer, and clearing them would silently
    // change the user's terminal sessions too.
    expect(telemetryEnv(false).CODEWHALE_TELEMETRY).toBe("0");
  });
});
