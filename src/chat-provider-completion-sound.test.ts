/**
 * When the host rings the completion cue.
 *
 * The cue is played by `utils/completion-sound` (which owns the setting, the
 * floor between cues and the platform player); what these tests pin is the
 * *timing*: a finished turn rings, a turn that failed or was interrupted does
 * not, a compaction pass is not a conversation turn and does not ring, and a
 * turn finishing on a thread the view is not on rings too — that last case is
 * what the cue is for.
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

vi.mock("./utils/completion-sound", () => ({
  playCompletionSound: vi.fn(() => true),
}));

import { ChatProvider } from "./chat-provider";
import { playCompletionSound } from "./utils/completion-sound";

const cue = playCompletionSound as unknown as ReturnType<typeof vi.fn>;
const EXTENSION_PATH = "/ext";

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => ({ id })),
    getThreadDetail: vi.fn(async () => ({ latest_seq: 0, thread: { id: "thread-1" }, turns: [], items: [] })),
    getThreadGoal: vi.fn(async () => null),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-1" })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
  };
  const provider = new ChatProvider({ fsPath: EXTENSION_PATH } as any, {} as any, api as any);

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

  return { provider, api };
}

/** The engine's terminal-turn event, for the conversation the view is on. */
function turnCompleted(turnId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    seq: 9,
    event: "turn.completed",
    turn_id: turnId,
    item_id: null,
    payload: { turn: { id: turnId, mode: "agent", status }, ...extra },
  } as any;
}

beforeEach(() => {
  cue.mockClear();
});

describe("the cue for the conversation being watched", () => {
  it("rings when the turn completed", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted("turn-1", "completed"));

    expect(cue).toHaveBeenCalledExactlyOnceWith(EXTENSION_PATH);
  });

  it("stays silent when the turn failed", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted("turn-1", "failed"));

    expect(cue).not.toHaveBeenCalled();
  });

  it("stays silent when the turn was interrupted", () => {
    const { provider } = createProvider();

    (provider as any).handleRuntimeEvent(turnCompleted("turn-1", "interrupted"));

    expect(cue).not.toHaveBeenCalled();
  });

  it("stays silent for a turn whose completion the runtime recovered", () => {
    const { provider } = createProvider();

    // The turn was already terminal on disk when the runtime started again:
    // its ending is history, not something that just happened.
    (provider as any).handleRuntimeEvent(turnCompleted("turn-old", "completed", { recovered: true }));

    expect(cue).not.toHaveBeenCalled();
  });

  it("stays silent for a compaction pass, which is not a conversation turn", async () => {
    const { provider, api } = createProvider();
    (api as any).compactThread = vi.fn(async () => ({ thread: { id: "thread-1" }, turn: { id: "turn_compact" } }));
    await (provider as any).handleCompact();
    cue.mockClear();

    (provider as any).handleRuntimeEvent(turnCompleted("turn_compact", "completed"));

    expect(cue).not.toHaveBeenCalled();
  });
});

describe("the cue for a thread the view is not on", () => {
  function watchBackground(provider: ChatProvider) {
    (provider as any).backgroundThreads.set("thread-b", {
      running: true,
      currentTurnId: "turn-b",
      lastEventSeq: 0,
      attention: 0,
      notifiedAttention: false,
      goalChecked: false,
      goal: null,
    });
  }

  function backgroundEvent(status: string | undefined, extra: Record<string, unknown> = {}) {
    return {
      seq: 4,
      timestamp: "2026-09-17T00:00:00Z",
      thread_id: "thread-b",
      turn_id: "turn-b",
      item_id: null,
      event: "turn.completed",
      payload: status ? { turn: { id: "turn-b", status }, ...extra } : {},
    } as any;
  }

  it("rings when a parked thread finishes", () => {
    const { provider } = createProvider();
    watchBackground(provider);

    (provider as any).handleBackgroundEvent("thread-b", backgroundEvent("completed"));

    expect(cue).toHaveBeenCalledExactlyOnceWith(EXTENSION_PATH);
  });

  it("stays silent when a parked thread's turn failed", () => {
    const { provider } = createProvider();
    watchBackground(provider);

    (provider as any).handleBackgroundEvent("thread-b", backgroundEvent("failed"));

    expect(cue).not.toHaveBeenCalled();
  });

  it("stays silent for a recovered completion on a parked thread", () => {
    const { provider } = createProvider();
    watchBackground(provider);

    (provider as any).handleBackgroundEvent(
      "thread-b",
      backgroundEvent("completed", { recovered: true }),
    );

    expect(cue).not.toHaveBeenCalled();
  });
});
