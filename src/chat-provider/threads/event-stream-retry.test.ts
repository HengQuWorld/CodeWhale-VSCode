/**
 * A dropped event stream is not news.
 *
 * The runtime recycles idle connections, a laptop sleeps, an engine restarts
 * under this window — and every one of those surfaces here as an aborted
 * socket. The conversation is already on screen and its history is on disk, so
 * what the reader needs is the stream reopened, not a red line about a
 * connection they cannot act on.
 *
 * These tests pin both halves: a drop is retried from the cursor it left off
 * at rather than reported, and only an outage long enough to mean "nothing is
 * arriving" is ever said out loud — once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  const opened: Array<{
    threadId: string;
    sinceSeq: number | null;
    onEvent: (event: any) => void;
    onError: (err: Error) => void;
    controller: AbortController;
  }> = [];
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    streamEvents: vi.fn(
      (
        threadId: string,
        sinceSeq: number | null,
        onEvent: (event: any) => void,
        onError: (err: Error) => void,
      ) => {
        const controller = new AbortController();
        opened.push({ threadId, sinceSeq, onEvent, onError, controller });
        return controller;
      },
    ),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).debugLog = vi.fn();
  (provider as any).handleRuntimeEvent = vi.fn();
  provider.currentThread = { id: "thread-1" } as any;
  return { provider, api, opened, posted: provider.postMessage as any };
}

function errors(h: Harness) {
  return h.posted.mock.calls
    .map((call: any[]) => call[0])
    .filter((msg: any) => msg?.type === "error");
}

/** Advance past the retry delay the provider scheduled. */
async function elapse(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("a live event stream that drops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens from the cursor it left off at, without saying anything", async () => {
    const h = createHarness();
    (h.provider as any).lastEventSeq = 41;
    (h.provider as any).subscribeToEvents();

    h.opened[0].onError(new Error("connect ECONNRESET 127.0.0.1:62372"));
    await elapse(300);

    expect(h.opened).toHaveLength(2);
    // The same conversation, resumed where the last event left off: nothing
    // that landed while the socket was down is lost.
    expect(h.opened[1].threadId).toBe("thread-1");
    expect(h.opened[1].sinceSeq).toBe(41);
    expect(errors(h)).toHaveLength(0);
  });

  it("waits longer each time it keeps failing", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    h.opened[0].onError(new Error("connect ECONNRESET"));
    // First retry is nearly immediate.
    await elapse(260);
    expect(h.opened).toHaveLength(2);

    // The next one is not: a runtime that is down is not helped by hammering.
    await elapse(260);
    expect(h.opened).toHaveLength(2);
    h.opened[1].onError(new Error("connect ECONNRESET"));
    await elapse(520);
    expect(h.opened).toHaveLength(3);
  });

  it("says something once the stream has been down long enough to matter", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    for (let attempt = 0; attempt < 5; attempt++) {
      h.opened[h.opened.length - 1].onError(new Error("connect ECONNRESET"));
      await elapse(9000);
    }

    const reported = errors(h);
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("Event stream error");
  });

  it("keeps retrying after it has reported, so the conversation reattaches itself", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    for (let attempt = 0; attempt < 5; attempt++) {
      h.opened[h.opened.length - 1].onError(new Error("connect ECONNRESET"));
      await elapse(9000);
    }
    const openedBefore = h.opened.length;

    h.opened[h.opened.length - 1].onError(new Error("connect ECONNRESET"));
    await elapse(9000);
    expect(h.opened.length).toBeGreaterThan(openedBefore);
    // Still one message: the outage was already named.
    expect(errors(h)).toHaveLength(1);
  });

  it("starts over once events are arriving again", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    // A drop that was carried into a report...
    for (let attempt = 0; attempt < 5; attempt++) {
      h.opened[h.opened.length - 1].onError(new Error("connect ECONNRESET"));
      await elapse(9000);
    }
    expect(errors(h)).toHaveLength(1);

    // ...and delivery, which is the proof that it is over.
    h.opened[h.opened.length - 1].onEvent({ seq: 9, event: "turn.started" });
    (h.provider as any).lastEventSeq = 9;
    expect((h.provider as any).eventStreamFailures).toBe(0);

    // The next outage starts at the first rung again, and is quiet.
    h.opened[h.opened.length - 1].onError(new Error("connect ECONNRESET"));
    await elapse(300);
    expect(errors(h)).toHaveLength(1);
  });

  it("does not reopen a conversation the view has left", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    h.opened[0].onError(new Error("connect ECONNRESET"));
    // The reader switched before the retry fired.
    (h.provider as any).abortEventStream();
    await elapse(30_000);

    expect(h.opened).toHaveLength(1);
  });

  it("ignores a late error from a stream it replaced on purpose", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();
    const first = h.opened[0];

    // A switch opens a new stream; the old socket then reports its reset.
    (h.provider as any).subscribeToEvents();
    expect(h.opened).toHaveLength(2);
    first.onError(new Error("connect ECONNRESET"));

    await elapse(30_000);
    // Nothing was scheduled off the stale error: the live stream is untouched.
    expect(h.opened).toHaveLength(2);
    expect((h.provider as any).eventStreamFailures).toBe(0);
  });

  it("backs off while the engine itself cannot be reached", async () => {
    const h = createHarness();
    h.api.ensureReady.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:62372"));
    (h.provider as any).subscribeToEvents();

    h.opened[0].onError(new Error("connect ECONNRESET"));
    // The retry fires, cannot reach the engine, and schedules another one —
    // on the *next* rung, so a runtime that is down is not polled every 250ms.
    await elapse(300);
    expect(h.api.ensureReady).toHaveBeenCalledTimes(1);
    await elapse(300);
    expect(h.api.ensureReady).toHaveBeenCalledTimes(1);
    await elapse(400);
    expect(h.api.ensureReady.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Nothing was opened and nothing was said: the engine is not up yet.
    expect(h.opened).toHaveLength(1);
    expect(errors(h)).toHaveLength(0);
  });

  it("re-syncs with the engine before reopening, since a restart moves its port", async () => {
    const h = createHarness();
    (h.provider as any).subscribeToEvents();

    h.opened[0].onError(new Error("connect ECONNRESET"));
    await elapse(300);

    expect(h.api.ensureReady).toHaveBeenCalled();
  });
});
