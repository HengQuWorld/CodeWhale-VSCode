/**
 * Call-level request timeouts.
 *
 * `GET /v1/threads/summary` is the one endpoint whose server-side cost is
 * seconds-per-thread (the runtime builds every row from a full thread-detail
 * read), so it passes its own `timeoutMs` instead of the 30s default. These
 * tests drive a real socket, because the point is that the override reaches
 * `req.setTimeout` — asserting on a mocked client would not show that.
 *
 * Deliberately in its own file: `api-client.test.ts` mocks the whole `http`
 * module, which is exactly what these must not use.
 */
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { CodeWhaleApiClient } from "./api-client";

function listen(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe("per-call request timeout", () => {
  it("gives up at the call-level timeout when the runtime never answers", async () => {
    const server = await listen(() => {
      /* accepted, deliberately never answered */
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      const started = Date.now();
      await expect(
        client.listThreadsSummary({ limit: 100, timeoutMs: 200 }),
      ).rejects.toThrow("Request timed out (200ms)");
      // It gave up on its own clock, not on the (much longer) default.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await server.close();
    }
  });

  it("leaves a call that does not ask for an override on the default", async () => {
    const server = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }, 400);
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      // Answers at 400ms: past the 200ms override above, well inside the
      // default this call still uses.
      await expect(client.listThreadsSummary()).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("lets a slow summary finish when the caller allows the time", async () => {
    const server = await listen((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }, 150);
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      await expect(
        client.listThreadsSummary({ limit: 100, timeoutMs: 2_000 }),
      ).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });
});
