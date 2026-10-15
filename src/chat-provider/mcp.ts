/**
 * The engine's MCP servers, as the chat panel manages them.
 *
 * Extracted from `chat-provider.ts`, which keeps the same methods as thin
 * entry points — the webview's messages and the slash commands route through
 * them — so this is the whole of the behaviour and nothing else.
 *
 * The engine owns the MCP config (global `mcp.json`, a trusted project's
 * `.mcp.json`, reviewed plugin entries) and is its only writer, so the GUI
 * keeps no config state of its own: every mutation is a request, and the panel
 * is repainted from the engine's answer. The `revision` the list carries is
 * presented back in `If-Match` — a stale one is refused rather than clobbering
 * an edit made elsewhere (the TUI, another window).
 */

import * as vscode from "vscode";
import type { CodeWhaleApiClient } from "../types";
import { formatError, getErrorMessage } from "../utils/error-handler";
import { mcpConnectionMessage, mcpTransportOverride } from "../utils/mcp-utils";
import { t } from "../i18n";

/**
 * What the controller needs from the provider it serves.
 *
 * Deliberately four things rather than the provider itself: the capability
 * flag is read live (it is discovered by probing the runtime after startup,
 * so a snapshot taken at construction would be wrong), and the rest is the two
 * ways this code already talks outward.
 */
export interface McpHost {
  readonly api: CodeWhaleApiClient;
  /** Whether the engine exposes the MCP management routes. */
  hasMcpManagement(): boolean;
  postMessage(msg: Record<string, unknown>): void;
  debugLog(msg: string): void;
}

export class McpController {
  /** The MCP config revision the last listing carried — the token every
   *  mutation presents back in `If-Match`, so a concurrent edit is refused
   *  rather than silently overwritten. */
  private revision: string | null = null;

  /** The revision from the last import preview. A preview and the approvals
   *  it authorizes are one read-modify-write, so it is kept apart from the
   *  server list's revision. */
  private importRevision: string | null = null;

  constructor(private readonly host: McpHost) {}

  /** Push the engine's MCP inventory to the panel.
   *
   *  An engine without the management family is answered with an explicit
   *  `supported: false` rather than silence: the panel has to say "this engine
   *  cannot do it" instead of keeping whatever it painted last. */
  public async refreshMcpServers(): Promise<void> {
    if (!this.host.hasMcpManagement()) {
      this.host.postMessage({
        type: "mcpServerList",
        servers: [],
        revision: "",
        supported: false,
      });
      return;
    }
    try {
      const result = await this.host.api.listMcpServers();
      this.revision = result.revision;
      this.host.postMessage({
        type: "mcpServerList",
        servers: result.servers ?? [],
        revision: result.revision,
        supported: true,
      });
    } catch (err) {
      // Keep what the panel had: a failed refresh is not evidence that the
      // configuration is empty.
      this.host.debugLog(`refreshMcpServers failed: ${getErrorMessage(err)}`);
    }
  }

  /** The revision to present in `If-Match`.
   *
   *  Normally the one the last listing carried. A mutation clicked before any
   *  listing landed (or after a failed one) reads it here instead of sending
   *  nothing: the engine answers a missing `If-Match` with `428`, which would
   *  look like a broken button rather than the one extra read it is. */
  private async revisionForMutation(): Promise<string | null> {
    if (this.revision) return this.revision;
    try {
      const result = await this.host.api.listMcpServers();
      this.revision = result.revision;
      return result.revision;
    } catch (err) {
      this.host.postMessage({
        type: "error",
        message: formatError("Could not read the MCP configuration", err),
      });
      return null;
    }
  }

  /** Refuse an MCP action on an engine that has no management routes. */
  private requireMcpManagement(): boolean {
    if (this.host.hasMcpManagement()) return true;
    this.host.postMessage({
      type: "error",
      message:
        "This engine does not expose MCP server management. " +
        "Update the CodeWhale engine, or manage servers from the TUI with /mcp.",
    });
    return false;
  }

  /** Turn one server on or off. The engine persists this, so the listing is
   *  re-read after the write rather than guessed at. */
  public async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.requireMcpManagement()) return;
    const revision = await this.revisionForMutation();
    if (!revision) return;
    try {
      await this.host.api.setMcpServerEnabled(name, enabled, revision);
      this.host.postMessage({
        type: "info",
        message: enabled
          ? `MCP server '${name}' enabled. It connects on the next turn.`
          : `MCP server '${name}' disabled.`,
      });
    } catch (err) {
      this.host.postMessage({
        type: "error",
        message: formatError(enabled ? "Enable failed" : "Disable failed", err),
      });
    }
    await this.refreshMcpServers();
  }

  /** Retry one server's connection, leaving its healthy siblings alone. */
  public async reconnectMcpServer(name: string): Promise<void> {
    if (!this.requireMcpManagement()) return;
    try {
      const receipt = await this.host.api.reconnectMcpServer(name);
      const connection = receipt.connection;
      this.host.postMessage({
        type: receipt.ok ? "info" : "error",
        message: mcpConnectionMessage(name, connection, receipt.action),
      });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Reconnect failed", err) });
    }
    await this.refreshMcpServers();
  }

  /** Remove a server from the global configuration, after a modal confirm:
   *  this rewrites the user's config file and the app has no undo for it. */
  public async removeMcpServer(name: string): Promise<void> {
    if (!this.requireMcpManagement()) return;
    const button = t().mcpRemoveConfirmButton;
    const confirm = await vscode.window.showWarningMessage(
      t().mcpRemoveConfirmTitle,
      { modal: true },
      t().mcpRemoveConfirmMessage.replace("{name}", name),
      button
    );
    if (confirm !== button) return;
    const revision = await this.revisionForMutation();
    if (!revision) return;
    try {
      await this.host.api.deleteMcpServer(name, revision);
      this.host.postMessage({ type: "info", message: `MCP server '${name}' removed.` });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Remove failed", err) });
    }
    await this.refreshMcpServers();
  }

  /** Add a server to the global configuration.
   *
   *  Exactly one of `command` (a stdio child) or `url` (an HTTP/SSE endpoint)
   *  is required — the engine rejects a request with neither, and says so in
   *  its own words, so the validation here only catches what the form cannot
   *  express (an empty name). */
  public async addMcpServer(spec: Record<string, unknown>): Promise<void> {
    if (!this.requireMcpManagement()) return;
    const name = typeof spec?.name === "string" ? spec.name.trim() : "";
    const command = typeof spec?.command === "string" ? spec.command.trim() : "";
    const url = typeof spec?.url === "string" ? spec.url.trim() : "";
    const transport = typeof spec?.transport === "string" ? spec.transport.trim() : "";
    const args = Array.isArray(spec?.args)
      ? (spec.args as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    if (!name) {
      this.host.postMessage({ type: "error", message: "A server name is required." });
      return;
    }
    if (!command && !url) {
      this.host.postMessage({
        type: "error",
        message: `MCP server '${name}' needs a command (stdio) or a URL (http/sse).`,
      });
      return;
    }
    const override = mcpTransportOverride(transport);
    if (override === null) {
      this.host.postMessage({
        type: "error",
        message: `Unsupported MCP transport '${transport}'. The engine accepts only 'sse', and infers stdio or HTTP from the command or URL.`,
      });
      return;
    }
    const revision = await this.revisionForMutation();
    if (!revision) return;
    try {
      const detail = await this.host.api.createMcpServer(
        {
          name,
          ...(command ? { command, args } : {}),
          ...(url ? { url } : {}),
          ...(override ? { transport: override } : {}),
        },
        revision
      );
      this.host.postMessage({
        type: "info",
        message: `MCP server '${detail.name}' added. It connects on the next turn.`,
      });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Add failed", err) });
    }
    await this.refreshMcpServers();
  }

  /** List one server's tools, connecting it first (the same read the TUI's
   *  `/mcp doctor <name>` performs). The tools then appear under its row.
   *
   *  A failed read is published as a connection outcome rather than only as an
   *  error toast: the panel is holding an open row that says "reading", and
   *  without an answer it would say that forever. */
  public async showMcpServerTools(name: string): Promise<void> {
    if (!this.requireMcpManagement()) return;
    try {
      const result = await this.host.api.listMcpTools({ server: name, connect: true });
      this.host.postMessage({
        type: "mcpTools",
        server: name,
        tools: (result.tools ?? []).filter(tool => tool.server === name),
        connections: result.connections ?? [],
      });
    } catch (err) {
      this.host.postMessage({
        type: "mcpTools",
        server: name,
        tools: [],
        connections: [
          { server: name, connected: false, auth_required: false, error: getErrorMessage(err) },
        ],
      });
      this.host.postMessage({
        type: "error",
        message: formatError("Could not read MCP tools", err),
      });
    }
  }

  /** Discover servers other tools left on this machine. Read-only: the engine
   *  never connects or spawns anything here. */
  public async refreshMcpImports(): Promise<void> {
    if (!this.requireMcpManagement()) return;
    try {
      const preview = await this.host.api.previewMcpImports();
      this.importRevision = preview.revision;
      this.host.postMessage({
        type: "mcpImports",
        candidates: preview.candidates ?? [],
        problems: preview.problems ?? [],
        revision: preview.revision,
      });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Import scan failed", err) });
    }
  }

  /** Approve or decline one reviewed candidate.
   *
   *  The approval is bound to the `content_hash` the preview reported, so a
   *  source file rewritten between the scan and the click is refused instead
   *  of importing something the reader never saw. */
  public async decideMcpImport(
    id: string,
    contentHash: string,
    decision: "approve" | "decline"
  ): Promise<void> {
    if (!this.requireMcpManagement()) return;
    const revision = this.importRevision ?? (await this.revisionForMutation());
    if (!revision) return;
    try {
      const receipt = await this.host.api.applyMcpImport(
        { id, content_hash: contentHash, decision },
        revision
      );
      const suffix = receipt.warning ? ` — ${receipt.warning}` : "";
      this.host.postMessage({
        type: "info",
        message: receipt.imported
          ? `Imported MCP server '${receipt.name}'${receipt.enabled ? " (enabled)" : " (added disabled)"}.${suffix}`
          : `Declined '${receipt.name}'. It will not be offered again until the source changes.`,
      });
    } catch (err) {
      this.host.postMessage({ type: "error", message: formatError("Import failed", err) });
    }
    await this.refreshMcpServers();
    await this.refreshMcpImports();
  }
}
