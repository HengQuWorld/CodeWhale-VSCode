import { describe, expect, it, vi } from "vitest";
import { CodeWhaleApiClient } from "./api-client";

/** A client whose transport is replaced, so the tests assert the contract the
 *  MCP routes are written against — path, method, conditional header — without
 *  binding a socket. */
function createClient(): { api: CodeWhaleApiClient; calls: any[]; raw: any } {
  const api = new CodeWhaleApiClient("http://127.0.0.1:1", "token");
  const calls: any[] = [];
  const raw = vi.fn(async (method: string, path: string, body: unknown, _t?: number, headers?: Record<string, string>) => {
    calls.push({ method, path, body, headers });
    return { statusCode: 200, data: JSON.stringify({ ok: true }) };
  });
  (api as any).requestRaw = raw;
  return { api, calls, raw };
}

describe("MCP capability detection", () => {
  it("reads the flag the engine advertises rather than probing a route", async () => {
    const api = new CodeWhaleApiClient("http://127.0.0.1:1", "token");
    (api as any).probePath = vi.fn(async () => true);
    (api as any).get = vi.fn(async () => ({
      capabilities: { skill_lifecycle: true, skill_detail: false, mcp_server_management: true },
    }));

    const caps = await api.probeRuntimeCapabilities();

    expect(caps.mcpServerManagement).toBe(true);
    expect(caps.skillLifecycle).toBe(true);
    expect(caps.skillDetail).toBe(false);
  });

  it("defaults the flag off when the engine predates it or the read fails", async () => {
    // Off is the safe direction: an engine that never answers has no routes to
    // promise, and the panel says so instead of offering a 404.
    const api = new CodeWhaleApiClient("http://127.0.0.1:1", "token");
    (api as any).probePath = vi.fn(async () => false);
    (api as any).get = vi.fn(async () => ({ capabilities: { skill_lifecycle: true } }));

    expect((await api.probeRuntimeCapabilities()).mcpServerManagement).toBe(false);

    (api as any).get = vi.fn(async () => {
      throw new Error("API error 404: Not Found");
    });
    expect((await api.probeRuntimeCapabilities()).mcpServerManagement).toBe(false);
  });
});

describe("MCP management requests", () => {
  it("presents the revision on create", async () => {
    const { api, calls } = createClient();
    await api.createMcpServer({ name: "github", url: "https://x/mcp" }, "mcp-v1-abc");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/apps/mcp/servers");
    expect(calls[0].headers).toEqual({ "If-Match": "mcp-v1-abc" });
    expect(calls[0].body).toEqual({ name: "github", url: "https://x/mcp" });
  });

  it("addresses the enable and disable routes by name", async () => {
    const { api, calls } = createClient();
    await api.setMcpServerEnabled("my server", true, "mcp-v1-abc");
    await api.setMcpServerEnabled("my server", false, "mcp-v1-abc");

    expect(calls[0].path).toBe("/v1/apps/mcp/servers/my%20server/enable");
    expect(calls[1].path).toBe("/v1/apps/mcp/servers/my%20server/disable");
    expect(calls[0].headers).toEqual({ "If-Match": "mcp-v1-abc" });
  });

  it("presents the revision on delete too", async () => {
    const { api, calls } = createClient();
    await api.deleteMcpServer("github", "mcp-v1-abc");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].headers).toEqual({ "If-Match": "mcp-v1-abc" });
  });

  it("does not make reconnect conditional: it reads state, it does not write", async () => {
    const { api, calls } = createClient();
    await api.reconnectMcpServer("github");
    expect(calls[0].path).toBe("/v1/apps/mcp/servers/github/reconnect");
    expect(calls[0].headers).toBeUndefined();
  });

  it("asks the tools route to connect only for the named server", async () => {
    const { api, calls } = createClient();
    await api.listMcpTools({ server: "chrome-devtools", connect: true });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/apps/mcp/tools?server=chrome-devtools&connect=true");
  });

  it("keeps the tools route uncached and unconnected when nothing is named", async () => {
    const { api, calls } = createClient();
    await api.listMcpTools();
    expect(calls[0].path).toBe("/v1/apps/mcp/tools");
  });

  it("carries the reviewed hash into the import apply", async () => {
    const { api, calls } = createClient();
    await api.applyMcpImport(
      { id: "abc", content_hash: "deadbeef", decision: "decline" },
      "mcp-v1-abc"
    );
    expect(calls[0].path).toBe("/v1/apps/mcp/imports");
    expect(calls[0].body).toEqual({ id: "abc", content_hash: "deadbeef", decision: "decline" });
    expect(calls[0].headers).toEqual({ "If-Match": "mcp-v1-abc" });
  });

  it("surfaces a stale revision with the engine's sentence", async () => {
    const { api, raw } = createClient();
    raw.mockResolvedValueOnce({
      statusCode: 412,
      data: JSON.stringify({
        error: { message: "MCP configuration changed since it was read", status: 412 },
      }),
    });

    await expect(
      api.setMcpServerEnabled("github", true, "mcp-v1-stale")
    ).rejects.toThrow("MCP configuration changed since it was read");
  });
});
