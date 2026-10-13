import { describe, expect, it } from "vitest";
import {
  mcpConnectionMessage,
  mcpTransportOverride,
  recommendedMcpServers,
} from "./mcp-utils";

describe("mcpTransportOverride", () => {
  it("sends nothing for the two transports the engine infers", () => {
    // A stdio server is a command and a streamable HTTP one is a URL; naming
    // either is a 400 for repeating what the body already says.
    expect(mcpTransportOverride("stdio")).toBeUndefined();
    expect(mcpTransportOverride("http")).toBeUndefined();
    expect(mcpTransportOverride("streamable_http")).toBeUndefined();
    expect(mcpTransportOverride("")).toBeUndefined();
  });

  it("passes the one transport the engine will not infer", () => {
    expect(mcpTransportOverride("sse")).toBe("sse");
  });

  it("refuses anything else instead of sending it", () => {
    expect(mcpTransportOverride("websocket")).toBeNull();
    expect(mcpTransportOverride("SSE")).toBeNull();
  });
});

describe("recommendedMcpServers", () => {
  it("carries the same roster the TUI's /mcp recommendations prints", () => {
    // One list, two front ends: these ids and the pinned versions are what the
    // TUI would write, so a suggestion added there and not here would be a
    // second, quieter opinion about what is worth connecting.
    const ids = recommendedMcpServers("darwin").map((entry) => entry.id);
    expect(ids).toEqual([
      "hugging-face",
      "github",
      "chrome-devtools",
      "playwright",
      "container-use",
    ]);
  });

  it("pins the npm packages instead of fetching whatever is latest", () => {
    const roster = recommendedMcpServers("linux");
    const chrome = roster.find((entry) => entry.id === "chrome-devtools")!;
    const playwright = roster.find((entry) => entry.id === "playwright")!;
    expect(chrome.args).toEqual(["-y", "chrome-devtools-mcp@1.7.0"]);
    expect(playwright.args).toEqual(["-y", "@playwright/mcp@0.0.79", "--isolated"]);
  });

  it("spells the launcher the way the host needs it", () => {
    // The command is spawned by the engine, which runs on the same machine as
    // the window, so the platform's own spelling is the one that works.
    const unix = recommendedMcpServers("darwin").find((entry) => entry.id === "playwright")!;
    const windows = recommendedMcpServers("win32").find((entry) => entry.id === "playwright")!;
    expect(unix.command).toBe("npx");
    expect(windows.command).toBe("npx.cmd");
  });

  it("uses endpoints for the hosted servers and a command for the local ones", () => {
    const roster = recommendedMcpServers("darwin");
    const github = roster.find((entry) => entry.id === "github")!;
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(github.command).toBeUndefined();
    // container-use needs a binary Codewhale never downloads, so it is a
    // command with an argument and no URL.
    const container = roster.find((entry) => entry.id === "container-use")!;
    expect(container.command).toBe("container-use");
    expect(container.args).toEqual(["stdio"]);
    expect(container.url).toBeUndefined();
  });
});

describe("mcpConnectionMessage", () => {
  it("reports a connected server", () => {
    expect(
      mcpConnectionMessage("github", { server: "github", connected: true, auth_required: false }, "reconnected")
    ).toBe("MCP server 'github' connected.");
  });

  it("keeps the engine's own sentence when one came with the success", () => {
    expect(
      mcpConnectionMessage(
        "github",
        { server: "github", connected: true, auth_required: false, error: "3 of 12 tools hidden" },
        "reconnected"
      )
    ).toBe("MCP server 'github' connected — 3 of 12 tools hidden");
  });

  it("names the way out for a server that needs authentication", () => {
    // The GUI has no login route: OAuth is the CLI's `codewhale mcp login`, so
    // a bare "did not connect" would leave the reader with nothing to try.
    const message = mcpConnectionMessage(
      "github",
      { server: "github", connected: false, auth_required: true },
      "reconnect_failed"
    );
    expect(message).toContain("needs authentication");
    expect(message).toContain("codewhale mcp login github");
  });

  it("passes along the engine's failure reason", () => {
    expect(
      mcpConnectionMessage(
        "local",
        { server: "local", connected: false, auth_required: false, error: "spawn ENOENT" },
        "reconnect_failed"
      )
    ).toBe("MCP server 'local' did not connect: spawn ENOENT");
  });

  it("falls back to the action verb when there is no outcome at all", () => {
    expect(mcpConnectionMessage("local", undefined, "enabled")).toBe(
      "MCP server 'local': enabled."
    );
  });
});
