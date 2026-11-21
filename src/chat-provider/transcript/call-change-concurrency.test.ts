/**
 * A rebuilt transcript asks the engine about every command it ran.
 *
 * That demand arrives in one burst — one read per shell call, all at the same
 * instant — and a session with a few dozen commands put a few dozen sockets in
 * front of an engine that may have only just come back. The reads are queued
 * instead: a few in flight, the rest waiting, and each call still asked about
 * exactly once.
 *
 * The queue also widens a window that was already open: a read answered after
 * the transcript was replaced used to write its records into the conversation
 * that replaced it. Bumping a generation when the records are dropped is what
 * closes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";
import type { ThreadRecord } from "../../types";

function makeThread(id: string): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-06-29T00:00:00Z",
    updated_at: "2026-06-29T00:00:00Z",
    model: "deepseek-v4-pro",
    workspace: "/tmp/repo",
    mode: "agent",
    allow_shell: false,
    trust_mode: false,
    auto_approve: false,
    latest_turn_id: null,
    archived: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function capturedAnswer(callId: string, path = "src/a.ts") {
  return {
    thread_id: "thr_1",
    turn_id: "turn_1",
    tool_call_id: callId,
    tool_name: "exec_shell",
    state: "captured" as const,
    reason: null,
    files: [{ path, change: "modified" as const, added: 3, removed: 1, diff: "@@", revision: "abc" }],
    truncated: false,
  };
}

/** Flush the promise continuations the queue schedules on completion. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function createHarness() {
  const api: Record<string, any> = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => ({ abort: () => undefined })),
    getCallChanges: vi.fn(),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).debugLog = vi.fn();
  (provider as any).apiCapabilities = { callChanges: true };
  provider.currentThread = makeThread("thr_1");

  const queue = (callId: string) => {
    (provider as any).shellCallRefs.set(callId, { threadId: "thr_1", turnId: "turn_1" });
    (provider as any).enrichCallChanges(callId);
  };
  return { provider, api, queue, posted: provider.postMessage as any };
}

describe("reading a call's changes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a burst of reads to a few at a time", async () => {
    const h = createHarness();
    let outstanding = 0;
    let peak = 0;
    h.api.getCallChanges.mockImplementation(async (t: string, u: string, callId: string) => {
      outstanding += 1;
      peak = Math.max(peak, outstanding);
      await new Promise((r) => setTimeout(r, 5));
      outstanding -= 1;
      return capturedAnswer(callId);
    });

    for (let i = 0; i < 20; i++) h.queue(`call_${i}`);
    // Every read is asked for — just not all at once.
    await vi.waitFor(() => expect(h.api.getCallChanges).toHaveBeenCalledTimes(20));

    // A literal, not the constant: reading the limit out of the code under
    // test would let the limit change — or disappear — without this failing.
    expect(peak).toBeLessThanOrEqual(4);
    // ...and more than one, so the queue is not simply serialising the reads.
    expect(peak).toBeGreaterThan(1);
  });

  it("asks about one call once, however many receipts name it", async () => {
    const h = createHarness();
    const answer = deferred<ReturnType<typeof capturedAnswer>>();
    h.api.getCallChanges.mockReturnValue(answer.promise);

    h.queue("call_shell");
    h.queue("call_shell");
    h.queue("call_shell");

    expect(h.api.getCallChanges).toHaveBeenCalledTimes(1);
    answer.resolve(capturedAnswer("call_shell"));
    await settle();
    // Answered, so a later receipt is not a reason to ask again either.
    h.queue("call_shell");
    expect(h.api.getCallChanges).toHaveBeenCalledTimes(1);
  });

  it("drains the whole queue, not just the first batch", async () => {
    const h = createHarness();
    h.api.getCallChanges.mockImplementation(async (t: string, u: string, callId: string) =>
      capturedAnswer(callId),
    );

    for (let i = 0; i < 12; i++) h.queue(`call_${i}`);
    await vi.waitFor(() => expect(h.api.getCallChanges).toHaveBeenCalledTimes(12));

    const asked = h.api.getCallChanges.mock.calls.map((call: any[]) => call[2]);
    expect(new Set(asked).size).toBe(12);
  });

  it("throws away an answer that arrives after the transcript was replaced", async () => {
    const h = createHarness();
    const answer = deferred<ReturnType<typeof capturedAnswer>>();
    h.api.getCallChanges.mockReturnValue(answer.promise);

    h.queue("call_shell");
    // The reader switched conversations while this read was in flight.
    (h.provider as any).resetChangeGroups();
    answer.resolve(capturedAnswer("call_shell", "src/from-the-old-thread.ts"));
    await settle();

    // Nothing from the old conversation is written into this one's records.
    expect((h.provider as any).turnFileChanges).toHaveLength(0);
    expect((h.provider as any).shellCallsEnriched.has("call_shell")).toBe(false);
  });

  it("forgets what it had queued when the transcript is replaced", async () => {
    const h = createHarness();
    // Two reads hold the slots, so the rest stay in the queue.
    h.api.getCallChanges.mockImplementation(() => new Promise(() => undefined));
    for (let i = 0; i < 8; i++) h.queue(`call_${i}`);
    // Eight asked for, four of them holding the slots: the rest are waiting.
    expect((h.provider as any).shellCallQueue).toHaveLength(4);

    (h.provider as any).resetChangeGroups();

    expect((h.provider as any).shellCallQueue).toHaveLength(0);
    // And a call in the new conversation that happens to carry the same id is
    // not mistaken for one already being read.
    expect((h.provider as any).shellCallsInFlight.size).toBe(0);
  });
});
