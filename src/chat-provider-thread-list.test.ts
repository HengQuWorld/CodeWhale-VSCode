/**
 * Thread-list refresh robustness.
 *
 * `GET /v1/threads/summary` builds every row from a full thread-detail read
 * (`get_thread_detail` per thread), so it costs roughly a quarter-second per
 * thread — 25.4s for the 72-thread / 189MB store measured 2026-09-17, which sat
 * just inside the client's 30s default and crossed it as soon as a turn was
 * writing to the store. The old silent catch then dropped the result on the
 * floor: no `threadList` message, no error, no retry, and the rail stayed blank
 * until an unrelated watcher event happened to refresh it.
 *
 * These tests pin the replacement contract: announce the fetch, give the call
 * its own timeout, retry only what is actually transient, never publish a stale
 * list over a newer one, and report a real failure to the rail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  showInformationMessage: vi.fn(async (_message: string, ..._items: string[]): Promise<string | undefined> => undefined),
  showErrorMessage: vi.fn(),
  configGet: vi.fn((_key: string, fallback?: unknown) => fallback),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vscodeMock.configGet,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: vscodeMock.showInformationMessage,
    showErrorMessage: vscodeMock.showErrorMessage,
  },
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "./chat-provider";
import type { ThreadSummary } from "./types";

function makeSummary(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    preview: "",
    model: "deepseek-v4-pro",
    mode: "agent",
    archived: false,
    updated_at: "2026-09-17T00:00:00Z",
    latest_turn_id: null,
    latest_turn_status: null,
    pending_attention_count: 0,
    ...overrides,
  };
}

/** The message `refreshThreadList` posts when it has real rows. */
function threadListMessages(provider: ChatProvider): Array<Record<string, unknown>> {
  return messagesOf(provider, "threadList");
}

function messagesOf(provider: ChatProvider, type: string): Array<Record<string, unknown>> {
  const calls = (provider.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type);
}

/** An errno-style failure, the shape `http.request` produces. */
function socketError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: connect failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** What `requestRaw` rejects with when its own socket timeout fires. */
function timeoutError(): Error {
  return new Error("Request timed out (60s)");
}

const providers: ChatProvider[] = [];

function newProvider() {
  const api = {
    bindEngine: vi.fn(),
    listThreadsSummary: vi.fn(
      async (_opts?: { limit?: number; search?: string; timeoutMs?: number }) =>
        [] as ThreadSummary[],
    ),
    listSessions: vi.fn(async () => ({ sessions: [] })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  // Real logging would append to ~/.codewhale-vscode-logs/debug.log.
  (provider as any).debugLog = vi.fn();
  providers.push(provider);
  return { provider, api };
}

function refresh(provider: ChatProvider): Promise<void> {
  return (provider as any).refreshThreadList();
}

afterEach(() => {
  for (const provider of providers.splice(0)) {
    (provider as any).stopAllBackgroundWatches?.();
  }
});

describe("refreshThreadList()", () => {
  it("announces the fetch before it publishes, so a slow summary is not a blank rail", async () => {
    const { provider, api } = newProvider();
    api.listThreadsSummary.mockResolvedValue([makeSummary("thread-a")]);

    await refresh(provider);

    const loading = messagesOf(provider, "threadListLoading");
    expect(loading).toHaveLength(1);
    expect(loading[0].loading).toBe(true);

    const calls = (provider.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const types = calls.map((call) => (call[0] as Record<string, unknown>).type);
    expect(types.indexOf("threadListLoading")).toBeLessThan(types.indexOf("threadList"));

    const list = threadListMessages(provider);
    expect(list).toHaveLength(1);
    expect((list[0].threads as ThreadSummary[]).map((s) => s.id)).toEqual(["thread-a"]);
  });

  it("gives the summary call its own timeout, above the client default", async () => {
    const { provider, api } = newProvider();

    await refresh(provider);

    const opts = api.listThreadsSummary.mock.calls[0][0] as { limit: number; timeoutMs: number };
    expect(opts.limit).toBe(100);
    // The runtime legitimately takes ~25s here; a 30s default is a cliff, not a
    // guard. Anything at or below it would reinstate the bug this fixes.
    expect(opts.timeoutMs).toBeGreaterThan(30_000);
  });

  it("does not retry a timeout, and tells the rail instead of going silent", async () => {
    const { provider, api } = newProvider();
    api.listThreadsSummary.mockRejectedValue(timeoutError());

    await refresh(provider);

    // A timeout is not transient: the endpoint is simply that slow, so a second
    // attempt would spend the same time again for the same answer.
    expect(api.listThreadsSummary).toHaveBeenCalledTimes(1);
    expect((provider as any).debugLog).toHaveBeenCalled();
    expect(threadListMessages(provider)).toHaveLength(0);

    const loading = messagesOf(provider, "threadListLoading");
    expect(loading).toHaveLength(2);
    expect(loading[1]).toMatchObject({ loading: false, failed: true });
  });

  it("retries once when the engine is not listening, and publishes on the retry", async () => {
    const { provider, api } = newProvider();
    api.listThreadsSummary
      .mockRejectedValueOnce(socketError("ECONNREFUSED"))
      .mockResolvedValueOnce([makeSummary("thread-late")]);

    await refresh(provider);

    // A webview reload relaunches the Runtime on a fresh port; a request issued
    // in that window hits a dead listener and is worth one retry.
    expect(api.listThreadsSummary).toHaveBeenCalledTimes(2);
    const list = threadListMessages(provider);
    expect(list).toHaveLength(1);
    expect((list[0].threads as ThreadSummary[]).map((s) => s.id)).toEqual(["thread-late"]);
    expect(messagesOf(provider, "threadListLoading")).toHaveLength(1);
  });

  it("keeps the newest list when an older refresh finishes last", async () => {
    const { provider, api } = newProvider();
    let resolveSlow: (value: ThreadSummary[]) => void = () => undefined;
    const slow = new Promise<ThreadSummary[]>((resolve) => {
      resolveSlow = resolve;
    });
    api.listThreadsSummary
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce([makeSummary("thread-new")]);

    const stale = refresh(provider);
    await refresh(provider);
    // The first refresh finishes after the second one already published.
    resolveSlow([makeSummary("thread-old")]);
    await stale;

    const list = threadListMessages(provider);
    expect(list).toHaveLength(1);
    expect((list[0].threads as ThreadSummary[]).map((s) => s.id)).toEqual(["thread-new"]);
  });

  it("does not mark the rail failed when the failure is superseded", async () => {
    const { provider, api } = newProvider();
    let rejectSlow: (reason: unknown) => void = () => undefined;
    const slow = new Promise<ThreadSummary[]>((_resolve, reject) => {
      rejectSlow = reject;
    });
    api.listThreadsSummary
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce([makeSummary("thread-new")]);

    const stale = refresh(provider);
    await refresh(provider);
    rejectSlow(timeoutError());
    await stale;

    // A newer refresh owns the rail; the older failure has nothing to say.
    const loading = messagesOf(provider, "threadListLoading");
    expect(loading).toHaveLength(2);
    expect(loading[1]).toEqual({ type: "threadListLoading", loading: true });
    expect(threadListMessages(provider)).toHaveLength(1);
  });

  it("still publishes the list when the watcher reconcile throws", async () => {
    const { provider, api } = newProvider();
    api.listThreadsSummary.mockResolvedValue([makeSummary("thread-a")]);
    (provider as any).syncBackgroundWatchers = vi.fn(() => {
      throw new Error("watcher exploded");
    });

    await refresh(provider);

    // A watcher problem must not cost the user the list itself — which is what
    // the shared silent catch used to do.
    expect(threadListMessages(provider)).toHaveLength(1);
    expect((provider as any).debugLog).toHaveBeenCalled();
  });
});
