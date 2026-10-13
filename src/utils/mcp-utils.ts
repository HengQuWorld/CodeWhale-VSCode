import type { McpConnectionOutcome } from "../types";

/**
 * MCP helpers shared by the host and the webview.
 *
 * The roster of suggested servers is deliberately the *same* list the TUI's
 * `/mcp recommendations` prints (`crates/tui/src/commands/groups/utility/mcp.rs`):
 * one Codewhale, two front ends, so a suggestion added there and not here
 * would be a second, quieter opinion about what is worth connecting. Nothing
 * in it installs anything — each entry is a pre-filled add form the reader
 * still has to submit.
 *
 * `platform` is the host the *engine* runs on, because that is where the
 * command is spawned. The GUI talks to a local engine, so the extension host's
 * own platform is the right one; the `npx.cmd` spelling is Windows-only for
 * the same reason the TUI carries it.
 */
export interface McpRecommendation {
  /** Stable id, also the default server name. */
  id: string;
  /** One line saying what the entry is and where it comes from. */
  label: string;
  /** stdio launch, for package-backed servers. */
  command?: string;
  args?: string[];
  /** HTTP endpoint, for hosted servers. */
  url?: string;
}

export function recommendedMcpServers(platform: string = process.platform): McpRecommendation[] {
  const npx = platform === "win32" ? "npx.cmd" : "npx";
  return [
    {
      id: "hugging-face",
      label: "Hugging Face — remote model/dataset search",
      url: "https://huggingface.co/mcp",
    },
    {
      id: "github",
      label: "GitHub — official remote MCP endpoint",
      url: "https://api.githubcopilot.com/mcp/",
    },
    {
      id: "chrome-devtools",
      label: "Chrome DevTools — inspect and control a running Chrome",
      command: npx,
      args: ["-y", "chrome-devtools-mcp@1.7.0"],
    },
    {
      id: "playwright",
      label: "Playwright — browser automation on a fresh profile",
      command: npx,
      args: ["-y", "@playwright/mcp@0.0.79", "--isolated"],
    },
    {
      id: "container-use",
      label: "container-use — Dagger's containerized environments (needs its own binary)",
      command: "container-use",
      args: ["stdio"],
    },
  ];
}

/** The transport override to put on the wire, or `undefined` to say nothing.
 *
 *  The request body's `transport` is an *override*, and the engine validates it
 *  against exactly one value: `sse`. A stdio server and a default streamable
 *  HTTP one are inferred from whether `command` or `url` is set, so naming them
 *  would be answered with a 400 for repeating what the body already says.
 *  Returns `null` for a value the engine would refuse, so the caller can say so
 *  instead of sending it and reporting the engine's complaint as a surprise. */
export function mcpTransportOverride(transport: string): string | undefined | null {
  if (!transport || transport === "stdio" || transport === "http" || transport === "streamable_http") {
    return undefined;
  }
  if (transport === "sse") return "sse";
  return null;
}

/** One human line for a connection outcome — the same three states the TUI's
 *  `/mcp doctor <name>` distinguishes: connected, needs authentication, or
 *  failed with the engine's own sentence. */
export function mcpConnectionMessage(
  name: string,
  connection: McpConnectionOutcome | undefined,
  action: string
): string {
  const head = `MCP server '${name}'`;
  if (!connection) return `${head}: ${action}.`;
  if (connection.connected) {
    return connection.error ? `${head} connected — ${connection.error}` : `${head} connected.`;
  }
  if (connection.auth_required) {
    return (
      `${head} needs authentication. Run \`codewhale mcp login ${name}\` in a terminal, ` +
      `then reconnect.`
    );
  }
  return `${head} did not connect${connection.error ? `: ${connection.error}` : "."}`;
}
