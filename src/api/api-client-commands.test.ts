import { describe, expect, it, vi } from "vitest";
import { CodeWhaleApiClient } from "./api-client";

/** A client whose transport is replaced, so the tests assert the contract the
 *  command-catalog routes are written against — path, query, and the
 *  snake_case Runtime command body — without binding a socket. */
function createClient(respond?: (method: string, path: string, body: unknown) => unknown): {
  api: CodeWhaleApiClient;
  calls: any[];
} {
  const api = new CodeWhaleApiClient("http://127.0.0.1:1", "token");
  const calls: any[] = [];
  const raw = vi.fn(async (method: string, path: string, body: unknown) => {
    calls.push({ method, path, body });
    const data = respond ? respond(method, path, body) : { commands: [] };
    return { statusCode: 200, data: JSON.stringify(data) };
  });
  (api as any).requestRaw = raw;
  return { api, calls };
}

describe("Engine command catalog requests", () => {
  it("lists the catalog without a thread qualifier when none is open", async () => {
    const { api, calls } = createClient();
    await api.listCommands();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/commands");
  });

  it("qualifies the catalog with the thread id when one is open", async () => {
    const { api, calls } = createClient();
    await api.listCommands("thread-1");
    expect(calls[0].path).toBe("/v1/commands?thread_id=thread-1");
  });

  it("returns the catalog rows, tolerating a missing array on old engines", async () => {
    const { api } = createClient(() => ({}));
    expect(await api.listCommands()).toEqual([]);
  });

  it("posts the Runtime command body in the engine's snake_case shape", async () => {
    const { api, calls } = createClient();
    await api.runThreadCommand("thread-1", {
      name: "demo-plugin-cmd",
      args: "arg text",
      registrationId: "abc123",
      expectedWorkspace: "/workspace",
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/threads/thread-1/commands");
    expect(calls[0].body).toMatchObject({
      name: "demo-plugin-cmd",
      args: "arg text",
      registration_id: "abc123",
      expected_workspace: "/workspace",
    });
    // A fresh idempotency token per call: the engine replays the recorded
    // result for a repeated key and refuses a repeated key with a changed
    // request, so the client must never send a constant here.
    expect(String(calls[0].body.operation_key)).toMatch(/^gui-\d+-[a-z0-9]+$/);
  });

  it("returns the executed command's result", async () => {
    const { api } = createClient(() => ({
      operation_key: "op",
      name: "demo-plugin-cmd",
      origin: "plugin:demo",
      status: "completed",
      text: "done",
      extension: {},
      idempotent_replay: false,
    }));
    const result = await api.runThreadCommand("thread-1", {
      name: "demo-plugin-cmd",
      args: "",
      registrationId: "abc123",
      expectedWorkspace: "/workspace",
    });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("done");
  });
});
