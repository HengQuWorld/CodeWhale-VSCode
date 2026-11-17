/**
 * A conversation takes seconds to arrive, and the view has to say so.
 *
 * Opening a thread or a saved session is a read the runtime has to replay: the
 * store is read, every turn and item decoded, and only then can the first row
 * be drawn. On a large conversation that is seconds of a webview showing
 * whatever it had before — the welcome page at startup, the previous
 * conversation on a rail click — which reads as if the click missed.
 *
 * These tests pin the host's half of the fix: the announcement goes out before
 * the read (not after it, when there is nothing left to wait for), and a load
 * that fails takes it back down so its error is what the reader sees.
 */
import { describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";
import type { ThreadRecord } from "../../types";

function makeThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
    model: "deepseek-v4-pro",
    workspace: "/tmp/repo",
    mode: "agent",
    allow_shell: false,
    trust_mode: false,
    auto_approve: false,
    latest_turn_id: null,
    archived: false,
    ...overrides,
  };
}

function posted(provider: ChatProvider): Array<Record<string, unknown>> {
  const calls = (provider.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((call) => call[0] as Record<string, unknown>);
}

function indexOfType(messages: Array<Record<string, unknown>>, type: string): number {
  return messages.findIndex((msg) => msg.type === type);
}

function createHarness() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getWorkspaceStatus: vi.fn(async () => ({ workspace: "/tmp/repo" })),
    getThread: vi.fn(async (id: string) => makeThread(id)),
    getThreadDetail: vi.fn(async (id: string) => ({
      thread: makeThread(id),
      latest_seq: 0,
      turns: [],
      items: [],
    })),
    getThreadGoal: vi.fn(async () => null),
    listThreads: vi.fn(async () => [] as ThreadRecord[]),
    listThreadsSummary: vi.fn(async () => []),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    listProviders: vi.fn(async () => ({ providers: [], current: null })),
    getSession: vi.fn(async (id: string) => ({
      metadata: {
        id,
        title: "A very long conversation",
        total_tokens: 12000,
        workspace: "/tmp/repo",
        model: "deepseek-v4-pro",
        model_provider: "deepseek",
        model_provider_id: "deepseek",
        mode: "agent",
      },
      messages: [],
    })),
    streamEvents: vi.fn(() => ({ abort: () => undefined })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).loadHistory = vi.fn(async () => 0);
  (provider as any).subscribeToEvents = vi.fn();
  (provider as any).refreshWorkPanel = vi.fn();
  (provider as any).refreshTaskList = vi.fn(async () => undefined);
  (provider as any).refreshAgentRuns = vi.fn(async () => undefined);
  (provider as any).refreshGoal = vi.fn(async () => undefined);
  (provider as any).refreshRuntimeVersion = vi.fn(async () => undefined);
  (provider as any).refreshApiCapabilities = vi.fn(async () => undefined);
  (provider as any).refreshWorkspaceTrust = vi.fn(async () => undefined);
  (provider as any).refreshSessionList = vi.fn(async () => undefined);
  (provider as any).postProviders = vi.fn();
  (provider as any).publishContextUsage = vi.fn();
  (provider as any).fillSessionDiffsFromEngine = vi.fn(async () => undefined);
  (provider as any).backfillSessionFileDiffs = vi.fn();
  (provider as any).sendSessionStats = vi.fn();
  (provider as any).debugLog = vi.fn();
  return { provider, api };
}

describe("the wait before a conversation is on screen", () => {
  it("announces the load before reading the thread, not after it", async () => {
    const { provider } = createHarness();

    await (provider as any).handleWebviewMessage({ type: "loadThread", threadId: "thread-2" });

    const messages = posted(provider);
    const announce = indexOfType(messages, "conversationLoading");
    const loaded = indexOfType(messages, "threadLoaded");
    // An announcement posted after the read would be a report of a wait that
    // is already over — the seconds it exists to explain would still be a
    // motionless previous conversation.
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(messages[announce].loading).toBe(true);
    expect(announce).toBeLessThan(loaded);
  });

  it("announces the load for a saved session the same way", async () => {
    const { provider } = createHarness();

    await (provider as any).loadSessionMessages("sess-1");

    const messages = posted(provider);
    const announce = indexOfType(messages, "conversationLoading");
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(messages[announce].loading).toBe(true);
    expect(announce).toBeLessThan(indexOfType(messages, "sessionLoaded"));
  });

  it("announces the startup restore, which reaches the thread without loadThread", async () => {
    const { provider, api } = createHarness();
    api.listThreads.mockResolvedValue([
      makeThread("thread-restored", { latest_turn_id: "turn-1" }),
    ]);

    await (provider as any).initializeThread();

    // A window reopening on its last conversation runs the read before the
    // webview is listening, so the handshake re-announces it; this path still
    // states the wait, because it is the read the reader is waiting on.
    expect(posted(provider).some((msg) => msg.type === "conversationLoading" && msg.loading === true))
      .toBe(true);
  });

  it("takes the announcement down when the thread cannot be read", async () => {
    const { provider, api } = createHarness();
    api.getThread.mockRejectedValue(new Error("Thread not found: thread-gone"));

    await (provider as any).handleWebviewMessage({ type: "loadThread", threadId: "thread-gone" });

    const messages = posted(provider);
    // The error is the answer; a spinner left above it would keep promising a
    // conversation that is not coming.
    expect(messages).toContainEqual({ type: "conversationLoading", loading: false });
    expect(messages.some((msg) => msg.type === "error")).toBe(true);
  });

  it("leaves no announcement behind after a successful load", async () => {
    const { provider } = createHarness();

    await (provider as any).handleWebviewMessage({ type: "loadThread", threadId: "thread-2" });

    // The transcript itself is what retires the wait on this path; the host
    // posts no trailing clear, and a `loading:false` here would be a second
    // answer to a question the drawn conversation already answered.
    const messages = posted(provider);
    expect(messages.filter((msg) => msg.type === "conversationLoading" && msg.loading === false))
      .toHaveLength(0);
    expect(indexOfType(messages, "threadLoaded")).toBeGreaterThanOrEqual(0);
  });
});
