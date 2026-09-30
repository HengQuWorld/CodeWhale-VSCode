/**
 * What the transcript says when a turn fails.
 *
 * A turn stopped by the provider — quota exhausted, a rejected key, a dead
 * network — used to end the same way a model with nothing to say did: the
 * answer's bubble closed and the conversation simply stopped, with no line
 * anywhere naming the reason. The runtime records that reason on the turn and
 * as an `error` item, so both halves of the view have to report it: the live
 * one when `turn.completed` arrives, and a reload, which reads the items.
 *
 * What the stop is *not* is tested alongside: a turn the user interrupted, a
 * turn that completed, and a compaction pass (whose own failure the compaction
 * report already carries) must not grow a second banner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: { showInformationMessage: vi.fn(async () => undefined), showErrorMessage: vi.fn() },
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import { ChatProvider } from "./chat-provider";
import { t } from "./i18n";

/** Everything turn.completed does after the banner, so the test watches the
 *  report rather than the bookkeeping around it. */
function createProvider(detail: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => ({ id })),
    getThreadDetail: vi.fn(async () => ({ latest_seq: 0, thread: { id: "thread-1" }, turns: [], items: [], ...detail })),
    getThreadGoal: vi.fn(async () => null),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
  };
  const provider = new ChatProvider({ fsPath: "/ext" } as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).autoSaveSession = vi.fn();
  (provider as any).autoSaveSessionForThread = vi.fn();
  (provider as any).scheduleThreadListRefresh = vi.fn();
  (provider as any).refreshGoal = vi.fn();

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
    { id: "a1", role: "assistant", content: "done", status: "streaming", timestamp: 2, blocks: [] },
  ] as any;

  return { provider, api, postMessage: provider.postMessage as any };
}

function turnCompleted(turnId: string, status: string, turn: Record<string, unknown> = {}) {
  return {
    seq: 9,
    event: "turn.completed",
    turn_id: turnId,
    item_id: null,
    payload: { turn: { id: turnId, mode: "agent", status, ...turn } },
  } as any;
}

/** The banners this turn reported. */
function errorBanners(postMessage: ReturnType<typeof vi.fn>) {
  return postMessage.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg && msg.type === "error");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a failed turn reports why it stopped", () => {
  it("carries the runtime's own reason, not a generic failure", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(
      turnCompleted("turn-1", "failed", {
        error: "You've reached your usage limit for this billing cycle",
      }),
    );

    expect(errorBanners(postMessage)).toEqual([
      { type: "error", message: "You've reached your usage limit for this billing cycle" },
    ]);
  });

  it("says the turn failed even when the runtime reported no reason", () => {
    // Silence is the failure this whole path exists to end: a turn that
    // stopped with no recorded cause still stopped, and the user is the one
    // who has to decide what to do about it.
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted("turn-1", "failed"));

    expect(errorBanners(postMessage)).toEqual([
      { type: "error", message: t().turnFailed },
    ]);
  });

  it("leaves a completed turn with nothing to report", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted("turn-1", "completed"));

    expect(errorBanners(postMessage)).toEqual([]);
  });

  it("does not report a turn the user stopped as a failure", () => {
    // Interrupt is a terminal state, not an error: the user asked for it.
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(
      turnCompleted("turn-1", "interrupted", { error: "Interrupted by user" }),
    );

    expect(errorBanners(postMessage)).toEqual([]);
  });

  it("does not repeat a failed compaction the compaction report already gave", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).compactionTurns.add("turn-compact");

    (provider as any).handleRuntimeEvent(
      turnCompleted("turn-compact", "failed", { error: "compaction failed: busy" }),
    );

    expect(errorBanners(postMessage)).toEqual([]);
  });
});

describe("a reloaded transcript keeps the reason a turn stopped", () => {
  it("replays the runtime's error item where the live banner sat", async () => {
    const detail = {
      latest_seq: 4,
      thread: { id: "thread-1" },
      turns: [
        {
          id: "turn-1",
          input_summary: "count the files",
          status: "failed",
          created_at: "2026-06-18T10:00:00Z",
          ended_at: "2026-06-18T10:00:03Z",
          item_ids: ["u1", "a1", "e1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "count the files", detail: "count the files", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "I'll count them", detail: "I'll count them", status: "completed" },
        { id: "e1", kind: "error", summary: "HTTP 429 from upstream", detail: "HTTP 429 from upstream: quota exhausted", status: "failed" },
      ],
    };
    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.map((m) => m.role)).toEqual(["user", "assistant", "system"]);
    const note = provider.messages[provider.messages.length - 1];
    expect(note.status).toBe("error");
    expect(note.content).toBe("HTTP 429 from upstream: quota exhausted");
  });

  it("does not invent an answer for a turn that never produced one", async () => {
    // The fallback bubble for a turn with no assistant output exists to keep a
    // turn from vanishing; with the reason on screen it would print the user's
    // own question as if it were the answer, under the line explaining why
    // there was none.
    const detail = {
      latest_seq: 2,
      thread: { id: "thread-1" },
      turns: [
        {
          id: "turn-1",
          input_summary: "count the files",
          status: "failed",
          created_at: "2026-06-18T10:00:00Z",
          item_ids: ["u1", "e1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "count the files", detail: "count the files", status: "completed" },
        { id: "e1", kind: "error", summary: "Network error", detail: "Network error: connection reset", status: "failed" },
      ],
    };
    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(provider.messages[1].content).toBe("Network error: connection reset");
  });

  it("leaves a turn that answered normally alone", async () => {
    const detail = {
      latest_seq: 2,
      thread: { id: "thread-1" },
      turns: [
        { id: "turn-1", input_summary: "hi", status: "completed", created_at: "2026-06-18T10:00:00Z", item_ids: ["u1", "a1"] },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "hi", detail: "hi", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "hello", detail: "hello", status: "completed" },
      ],
    };
    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    expect(provider.messages.map((m) => m.status)).toEqual(["complete", "complete"]);
  });
});
