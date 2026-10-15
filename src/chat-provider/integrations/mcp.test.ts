import { beforeEach, describe, expect, it, vi } from "vitest";

const warningMessage = vi.fn(async () => "Remove");

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {
    showWarningMessage: (...args: unknown[]) => warningMessage(...(args as [])),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "../../chat-provider";

const SERVER = {
  name: "github",
  origin: "global",
  writable: true,
  auth_required: false,
  enabled: true,
  required: false,
  command: null,
  url: "https://api.githubcopilot.com/mcp/",
  connected: false,
  enabled_tools: [],
  disabled_tools: [],
};

function createProvider(overrides: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => new AbortController()),
    listMcpServers: vi.fn(async () => ({ revision: "mcp-v1-abc", servers: [SERVER] })),
    listMcpTools: vi.fn(async () => ({
      tools: [
        {
          server: "github",
          name: "search_code",
          prefixed_name: "mcp__github__search_code",
          description: "Search code",
          input_schema: {},
        },
        {
          server: "playwright",
          name: "navigate",
          prefixed_name: "mcp__playwright__navigate",
          description: "Go somewhere",
          input_schema: {},
        },
      ],
      connections: [{ server: "github", connected: true, auth_required: false }],
    })),
    setMcpServerEnabled: vi.fn(async (name: string, enabled: boolean) => ({
      name,
      action: enabled ? "enabled" : "disabled",
      ok: true,
    })),
    reconnectMcpServer: vi.fn(async (name: string) => ({
      name,
      action: "reconnected",
      ok: true,
      connection: { server: name, connected: true, auth_required: false },
    })),
    deleteMcpServer: vi.fn(async (name: string) => ({ name, action: "deleted", ok: true })),
    createMcpServer: vi.fn(async (request: Record<string, unknown>) => ({
      ...SERVER,
      ...request,
      name: request.name,
    })),
    previewMcpImports: vi.fn(async () => ({
      revision: "mcp-v1-import",
      candidates: [],
      problems: [],
    })),
    applyMcpImport: vi.fn(async (request: Record<string, unknown>) => ({
      name: "local-tools",
      decision: request.decision,
      imported: request.decision === "approve",
      enabled: false,
      revision: "mcp-v1-import",
      consent_recorded: true,
      warning: null,
    })),
    ...overrides,
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  (provider as any).startPeriodicTaskRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).eventController = new AbortController();
  return { provider, api, postMessage: provider.postMessage as any };
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

describe("ChatProvider MCP management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says the engine cannot do it rather than going quiet", async () => {
    // Silence would leave the panel showing whatever it painted last, and the
    // reader with no way to tell "no servers" from "no routes".
    const { provider, api, postMessage } = createProvider();
    await provider.refreshMcpServers();

    expect(api.listMcpServers).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "mcpServerList")).toEqual([
      { type: "mcpServerList", servers: [], revision: "", supported: false },
    ]);
  });

  it("publishes the engines's list together with its revision", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.refreshMcpServers();

    expect(messagesOfType(postMessage, "mcpServerList")).toEqual([
      { type: "mcpServerList", servers: [SERVER], revision: "mcp-v1-abc", supported: true },
    ]);
  });

  it("keeps the panel's list when a refresh fails", async () => {
    const { provider, postMessage } = createProvider({
      listMcpServers: vi.fn(async () => {
        throw new Error("API error 500: boom");
      }),
    });
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.refreshMcpServers();

    expect(messagesOfType(postMessage, "mcpServerList")).toEqual([]);
  });

  it("presents the listing's revision on every mutation", async () => {
    // The engine is the only writer of the MCP config; without the revision it
    // answers 428, and a mutation from a second window would clobber the first.
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;
    await provider.refreshMcpServers();

    await provider.setMcpServerEnabled("github", false);

    expect(api.setMcpServerEnabled).toHaveBeenCalledWith("github", false, "mcp-v1-abc");
  });

  it("reads the revision first when a mutation arrives before any listing", async () => {
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.setMcpServerEnabled("github", false);

    expect(api.listMcpServers).toHaveBeenCalled();
    expect(api.setMcpServerEnabled).toHaveBeenCalledWith("github", false, "mcp-v1-abc");
  });

  it("reports a refused mutation in the engine's own words", async () => {
    const { provider, postMessage } = createProvider({
      setMcpServerEnabled: vi.fn(async () => {
        throw new Error("API error 412: MCP configuration changed since it was read");
      }),
    });
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.setMcpServerEnabled("github", false);

    const errors = messagesOfType(postMessage, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("412");
    expect(errors[0].message).toContain("configuration changed");
  });

  it("refuses every action on an engine without the management routes", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.setMcpServerEnabled("github", false);
    await provider.reconnectMcpServer("github");
    await provider.removeMcpServer("github");
    await provider.addMcpServer({ name: "x", command: "npx" });
    await provider.showMcpServerTools("github");
    await provider.refreshMcpImports();
    await provider.decideMcpImport("id", "hash", "approve");

    expect(api.setMcpServerEnabled).not.toHaveBeenCalled();
    expect(api.reconnectMcpServer).not.toHaveBeenCalled();
    expect(api.deleteMcpServer).not.toHaveBeenCalled();
    expect(api.createMcpServer).not.toHaveBeenCalled();
    expect(api.listMcpTools).not.toHaveBeenCalled();
    expect(api.previewMcpImports).not.toHaveBeenCalled();
    expect(api.applyMcpImport).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "error")).toHaveLength(7);
    expect(messagesOfType(postMessage, "error")[0].message).toContain("Update the CodeWhale engine");
  });

  it("reports a reconnect's real outcome instead of assuming success", async () => {
    const { provider, postMessage } = createProvider({
      reconnectMcpServer: vi.fn(async (name: string) => ({
        name,
        action: "reconnect_failed",
        ok: false,
        connection: {
          server: name,
          connected: false,
          auth_required: true,
          error: "401 Unauthorized",
        },
      })),
    });
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.reconnectMcpServer("github");

    const errors = messagesOfType(postMessage, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("needs authentication");
    expect(errors[0].message).toContain("codewhale mcp login github");
  });

  it("labels a live tool call the way the reloaded row will be labelled", async () => {
    // A call row is drawn from `displayName`, and history has always set it
    // (friendlyToolName). The live path did not, so every call read one way
    // while it ran and another way after a reload. `name` must stay the
    // engine's own string: the shell and file-change checks key on it, so only
    // `displayName` may be the friendly form.
    const { provider, postMessage } = createProvider();
    provider.messages = [{ id: "assistant-1", role: "assistant", content: "", blocks: [], toolCalls: [] }] as any;

    const start = (name: string, id: string) =>
      (provider as any).handleItemEvent({
        event: "item.started",
        item_id: `item-${id}`,
        turn_id: "turn-1",
        payload: {
          item: { kind: "tool_call", id: `item-${id}`, summary: "working" },
          tool: { id, name, input: {} },
        },
      });

    await start("mcp__github__search_code", "call-1");
    await start("exec_shell", "call-2");

    const rows = (provider.messages[0] as any).toolCalls;
    expect(rows[0].name).toBe("mcp__github__search_code");
    expect(rows[0].displayName).toBe("github / search code");
    expect(rows[1].name).toBe("exec_shell");
    expect(rows[1].displayName).toBe("Run command");

    const posted = messagesOfType(postMessage, "addToolCall");
    expect(posted.map((msg) => msg.toolCall.displayName)).toEqual([
      "github / search code",
      "Run command",
    ]);
  });

  it("asks before removing a server from the config file", async () => {
    // This rewrites the user's global config and there is no undo for it.
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;
    await provider.refreshMcpServers();

    await provider.removeMcpServer("github");

    expect(warningMessage).toHaveBeenCalled();
    // The modal's copy travels through the translation table, like the session
    // delete confirmation it is modelled on — and it names the server being
    // removed, so a mis-click cannot be mistaken for a different one.
    const [title, options, message, button] = warningMessage.mock.calls[0] as unknown as [
      string,
      { modal?: boolean },
      string,
      string,
    ];
    expect(title).toBe("Remove MCP server?");
    expect(options.modal).toBe(true);
    expect(message).toContain("github");
    expect(button).toBe("Remove");
    expect(api.deleteMcpServer).toHaveBeenCalledWith("github", "mcp-v1-abc");
  });

  it("does nothing when the removal is dismissed", async () => {
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;
    await provider.refreshMcpServers();
    warningMessage.mockResolvedValueOnce(undefined as any);

    await provider.removeMcpServer("github");

    expect(api.deleteMcpServer).not.toHaveBeenCalled();
  });

  it("refuses a half-filled add without troubling the engine", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.addMcpServer({ name: "  ", command: "npx" });
    await provider.addMcpServer({ name: "no-target" });

    expect(api.createMcpServer).not.toHaveBeenCalled();
    const errors = messagesOfType(postMessage, "error");
    expect(errors[0].message).toContain("name is required");
    expect(errors[1].message).toContain("command (stdio) or a URL");
  });

  it("sends a stdio server with its arguments and a remote one with its URL", async () => {
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;
    await provider.refreshMcpServers();

    await provider.addMcpServer({
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.79"],
    });
    // No transport on the wire: the engine reads a stdio server off the
    // command, and its transport field accepts `sse` alone.
    expect(api.createMcpServer).toHaveBeenCalledWith(
      { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@0.0.79"] },
      "mcp-v1-abc"
    );

    (api.createMcpServer as any).mockClear();
    await provider.addMcpServer({ name: "github", transport: "http", url: "https://x/mcp" });
    expect(api.createMcpServer).toHaveBeenCalledWith(
      { name: "github", url: "https://x/mcp" },
      "mcp-v1-abc"
    );

    // SSE is the one transport the engine will not infer.
    (api.createMcpServer as any).mockClear();
    await provider.addMcpServer({ name: "legacy", transport: "sse", url: "https://y/sse" });
    expect(api.createMcpServer).toHaveBeenCalledWith(
      { name: "legacy", url: "https://y/sse", transport: "sse" },
      "mcp-v1-abc"
    );
  });

  it("refuses a transport the engine would reject, rather than passing it on", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;
    await provider.refreshMcpServers();

    await provider.addMcpServer({ name: "weird", transport: "websocket", url: "wss://x" });

    expect(api.createMcpServer).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "error")[0].message).toContain(
      "Unsupported MCP transport 'websocket'"
    );
  });

  it("shows only the tools belonging to the server that was asked about", async () => {
    // The route answers for every connected server; a row's panel that listed
    // its siblings' tools would misattribute them.
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.showMcpServerTools("github");

    expect(api.listMcpTools).toHaveBeenCalledWith({ server: "github", connect: true });
    const published = messagesOfType(postMessage, "mcpTools")[0];
    expect(published.server).toBe("github");
    expect(published.tools.map((tool: any) => tool.name)).toEqual(["search_code"]);
    expect(published.connections[0].connected).toBe(true);
  });

  it("stops an expanded row saying 'reading' when the read itself fails", async () => {
    // The panel opened that row and is showing a spinner. An error toast alone
    // would leave it spinning forever, so the failure is published as a
    // connection outcome too.
    const { provider, api, postMessage } = createProvider({
      listMcpTools: vi.fn(async () => {
        throw new Error("API error 500: pool unavailable");
      }),
    });
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.showMcpServerTools("github");

    expect(api.listMcpTools).toHaveBeenCalledWith({ server: "github", connect: true });
    const published = messagesOfType(postMessage, "mcpTools")[0];
    expect(published.server).toBe("github");
    expect(published.tools).toEqual([]);
    expect(published.connections[0].connected).toBe(false);
    expect(published.connections[0].error).toContain("pool unavailable");
    expect(messagesOfType(postMessage, "error")[0].message).toContain("Could not read MCP tools");
  });

  it("binds an import approval to what the preview read", async () => {
    const { provider, api } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.refreshMcpImports();
    await provider.decideMcpImport("abc", "deadbeef", "approve");

    // The hash is what makes the approval an approval *of something*: a source
    // rewritten between the scan and the click is refused, not imported unseen.
    expect(api.applyMcpImport).toHaveBeenCalledWith(
      { id: "abc", content_hash: "deadbeef", decision: "approve" },
      "mcp-v1-import"
    );
  });

  it("reports an import as added-disabled, which is what the engine does", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.refreshMcpImports();
    await provider.decideMcpImport("abc", "deadbeef", "approve");

    const info = messagesOfType(postMessage, "info");
    expect(info.some((msg) => msg.message.includes("(added disabled)"))).toBe(true);
  });

  it("says a decline is remembered, since it is", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).apiCapabilities.mcpServerManagement = true;

    await provider.refreshMcpImports();
    await provider.decideMcpImport("abc", "deadbeef", "decline");

    const info = messagesOfType(postMessage, "info");
    expect(info.some((msg) => msg.message.includes("Declined 'local-tools'"))).toBe(true);
  });
});
