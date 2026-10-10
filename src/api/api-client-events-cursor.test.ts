/**
 * The cursor a thread-event stream is opened with.
 *
 * `GET /v1/threads/{id}/events` delivers `seq > since_seq`, and the cursor the
 * stream opens with is the *same* one the live pump continues from
 * (`stream_thread_events` hands `replay.base_seq` to `replay_live_thread_events`;
 * `publish_full_event_replay` sets it to `since_seq` when nothing precedes it).
 * A cursor above the thread's own last sequence therefore cannot be exceeded by
 * anything: the request succeeds, the connection opens and keeps alive, and not
 * one frame ever arrives. There is no error to notice.
 *
 * `replay_limit=0` is the runtime's other form of the same query — "send no
 * tail, but position the cursor at the end" (`publish_tail_event_replay` walks
 * the journal, assigns `base_seq` from the last event and batches nothing) —
 * which is how a caller asks to watch from now on without abandoning the live
 * edge.
 *
 * Driven through a real socket against a stub that implements exactly that
 * rule. A mocked `streamEvents` is precisely what cannot show this: the client
 * used to pass `Number.MAX_SAFE_INTEGER` as a way of saying "skip the replay",
 * and every test that asserted the call still passed while the watch it opened
 * was permanently silent.
 */
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { CodeWhaleApiClient } from "./api-client";
import type { RuntimeEvent } from "../types";

type Subscriber = {
  /** The sequence this stream will deliver from, already resolved the way the
   *  runtime resolves it: `replay_limit=0` repositions `since_seq` to the
   *  thread's own last event. */
  liveFrom: number;
  sinceSeq: string | null;
  replayLimit: string | null;
  res: http.ServerResponse;
};

/**
 * A stub thread-event endpoint: it owns one thread whose journal ends at
 * `historyEndsAt`, and it serves the runtime's delivery rule verbatim.
 */
async function eventsEndpoint(historyEndsAt: number) {
  const subscribers: Subscriber[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sinceSeq = url.searchParams.get("since_seq");
    const replayLimit = url.searchParams.get("replay_limit");
    const asked = Number(sinceSeq ?? 0);
    // The runtime's cursor resolution, then its delivery rule.
    const liveFrom = replayLimit === "0" ? historyEndsAt : asked;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": keepalive\n\n");
    subscribers.push({ liveFrom, sinceSeq, replayLimit, res });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    subscribers,
    /** Publish one event on the thread. Only streams whose resolved cursor is
     *  below `seq` receive it — the rule the client's fix depends on. */
    publish(seq: number, event: Omit<RuntimeEvent, "seq">) {
      const frame = `event: ${event.event}\ndata: ${JSON.stringify({ ...event, seq })}\n\n`;
      for (const sub of subscribers) {
        if (seq > sub.liveFrom) sub.res.write(frame);
      }
    },
    close: () =>
      new Promise<void>((done) => {
        for (const sub of subscribers) sub.res.end();
        server.close(() => done());
      }),
  };
}

function liveEvent(_seq: number): Omit<RuntimeEvent, "seq"> {
  return {
    timestamp: "2026-09-17T00:00:00Z",
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: null,
    event: "approval.required",
    payload: { approval_id: "approval-1", tool_name: "bash" },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

describe("thread-event stream cursor", () => {
  it("asks for the live edge, and hears what happens next", async () => {
    const endpoint = await eventsEndpoint(40);
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${endpoint.port}`);
      const seen: RuntimeEvent[] = [];

      // The request a background watch makes for a thread it has never
      // watched: no replay, positioned at the thread's live edge.
      client.streamEvents("thread-1", 0, (e) => seen.push(e), () => {}, 0);
      await settle();

      expect(endpoint.subscribers).toHaveLength(1);
      expect(endpoint.subscribers[0].sinceSeq).toBe("0");
      expect(endpoint.subscribers[0].replayLimit).toBe("0");

      // An approval raised after the watch opened is delivered.
      endpoint.publish(41, liveEvent(41));
      await settle();

      expect(seen.map((e) => e.seq)).toEqual([41]);
      expect(seen[0].event).toBe("approval.required");
    } finally {
      await endpoint.close();
    }
  });

  it("delivers nothing, ever, from a cursor above the thread's sequence", async () => {
    // The regression, at the transport. `Number.MAX_SAFE_INTEGER` was the
    // cursor a background watch used to open with, as a way of asking for
    // "live events only". The connection succeeds and stays up, so the client
    // holds a watch it believes is live; the runtime drops every frame because
    // no sequence can exceed the cursor. A thread waiting on an approval then
    // raises no notification and no badge, and the request is only ever seen
    // by opening the thread by hand.
    const endpoint = await eventsEndpoint(40);
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${endpoint.port}`);
      const seen: RuntimeEvent[] = [];

      client.streamEvents("thread-1", Number.MAX_SAFE_INTEGER, (e) => seen.push(e));
      await settle();
      endpoint.publish(41, liveEvent(41));
      await settle();

      expect(endpoint.subscribers).toHaveLength(1);
      expect(seen).toEqual([]);
    } finally {
      await endpoint.close();
    }
  });

  it("keeps replaying from since_seq when no tail bound is asked for", async () => {
    // The foreground stream's contract, unchanged: no `replay_limit` means
    // "resume from this cursor", so the cursor itself is the delivery floor.
    const endpoint = await eventsEndpoint(40);
    try {
      const client = new CodeWhaleApiClient(`http://127.0.0.1:${endpoint.port}`);
      const seen: RuntimeEvent[] = [];

      client.streamEvents("thread-1", 40, (e) => seen.push(e));
      await settle();

      expect(endpoint.subscribers[0].replayLimit).toBeNull();
      expect(endpoint.subscribers[0].liveFrom).toBe(40);

      endpoint.publish(41, liveEvent(41));
      await settle();
      expect(seen.map((e) => e.seq)).toEqual([41]);
    } finally {
      await endpoint.close();
    }
  });
});
