/**
 * `POST /v1/sessions/{id}/resume-thread` answers with the same body whether it
 * created a thread (`201`) or handed back the one that already held the session
 * (`200`), so the status line is the only way a caller can tell the two apart —
 * and it has to, because the caller renames what it resumes and a reopened
 * thread already carries a title.
 *
 * Driven through a real socket: `api-client.test.ts` mocks the whole `http`
 * module, which is exactly what would hide whether the status survived
 * `requestRaw` on its way into `created`.
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

const RESUME_BODY = {
  thread_id: "thread-1",
  session_id: "sess-1",
  message_count: 4,
  summary: "Resumed session 'One' (4 messages) into thread thread-1",
};

describe("resume-thread reports which answer it got", () => {
  it("marks a thread the runtime created", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(RESUME_BODY));
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      const result = await client.resumeSessionThread("sess-1");

      expect(result.created).toBe(true);
      expect(result.thread_id).toBe("thread-1");
      expect(result.session_id).toBe("sess-1");
    } finally {
      await server.close();
    }
  });

  it("marks a session that was already open, with an identical body", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(RESUME_BODY));
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      const result = await client.resumeSessionThread("sess-1");

      // Same thread id, same session, same summary — only the status says
      // whether renaming it is this call's business.
      expect(result.created).toBe(false);
      expect(result.thread_id).toBe("thread-1");
    } finally {
      await server.close();
    }
  });

  it("keeps a refusal on the error path", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "session is locked" } }));
    });
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${server.port}`);

      await expect(client.resumeSessionThread("sess-1")).rejects.toThrow(/API error 409/);
    } finally {
      await server.close();
    }
  });
});
