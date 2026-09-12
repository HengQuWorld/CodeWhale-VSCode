import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {},
  env: {
    language: "en",
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}));

import { ChatProvider } from "./chat-provider";

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    patchUndoThreadTurn: vi.fn(),
    retryThreadTurn: vi.fn(),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  (provider as any).loadThread = vi.fn(async () => undefined);
  (provider as any).apiCapabilities.threadPatchUndo = true;
  (provider as any).apiCapabilities.threadRetry = true;

  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [
    { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
    { id: "a1", role: "assistant", content: "world", status: "complete", timestamp: 2 },
  ] as any;

  const state = (provider as any).sessionState.data;
  state.turnFileChanges = [{ filePath: "a.ts", changeType: "modified", addedLines: 1, removedLines: 0 }];
  state.currentTurnId = "turn-old";
  state.currentTextBlockIdx = 4;
  state.currentThinkingBlockIdx = 3;
  state.lastEventSeq = 99;
  state.activeItems.set("item-1", { kind: "tool_call", msgId: "a1" });

  return { provider, api, postMessage: provider.postMessage as any };
}

describe("ChatProvider undo/retry server flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses patchUndoThreadTurn and resets local state before reloading history", async () => {
    const { provider, api, postMessage } = createProvider();
    api.patchUndoThreadTurn.mockResolvedValue({
      patch_result: {
        files_restored: true,
        summary: "Restored 1 file from snapshot",
      },
      thread: { id: "thread-2" },
      original_user_text: "retry me",
    });

    await provider.handleUndoLastTurn();

    expect(api.ensureReady).toHaveBeenCalledOnce();
    expect(api.patchUndoThreadTurn).toHaveBeenCalledWith("thread-1");
    expect(provider.currentThread).toEqual({ id: "thread-2" });
    expect(provider.messages).toEqual([]);
    expect((provider as any).sessionState.data.turnFileChanges).toEqual([]);
    expect((provider as any).sessionState.data.currentTurnId).toBeNull();
    expect((provider as any).sessionState.data.currentTextBlockIdx).toBe(-1);
    expect((provider as any).sessionState.data.currentThinkingBlockIdx).toBe(-1);
    expect((provider as any).sessionState.data.lastEventSeq).toBe(0);
    expect((provider as any).loadThread).toHaveBeenCalledWith("thread-2");
    expect(postMessage).toHaveBeenCalledWith({ type: "info", message: "Restored 1 file from snapshot" });
    expect(postMessage).toHaveBeenCalledWith({ type: "setInputText", text: "retry me" });
    expect(postMessage).toHaveBeenCalledWith({ type: "historyUpdated" });
  });

  it("uses retryThreadTurn and keeps the new turn id from the server", async () => {
    const { provider, api, postMessage } = createProvider();
    api.retryThreadTurn.mockResolvedValue({
      thread: { id: "thread-3" },
      turn: { id: "turn-new" },
    });

    await provider.handleRetryLastTurn();

    expect(api.ensureReady).toHaveBeenCalledOnce();
    expect(api.retryThreadTurn).toHaveBeenCalledWith("thread-1");
    expect(provider.currentThread).toEqual({ id: "thread-3" });
    expect(provider.messages).toEqual([]);
    expect((provider as any).sessionState.data.turnFileChanges).toEqual([]);
    expect((provider as any).sessionState.data.currentTurnId).toBe("turn-new");
    expect((provider as any).sessionState.data.currentTextBlockIdx).toBe(-1);
    expect((provider as any).sessionState.data.currentThinkingBlockIdx).toBe(-1);
    expect((provider as any).sessionState.data.lastEventSeq).toBe(0);
    expect((provider as any).loadThread).toHaveBeenCalledWith("thread-3");
    expect(postMessage).toHaveBeenCalledWith({ type: "historyUpdated" });
  });
});

describe("single-file revert boundary", () => {
  it("keeps per-file restore unavailable even when whole-workspace snapshots exist", () => {
    const { provider } = createProvider();
    (provider as any).apiCapabilities.snapshotList = true;
    (provider as any).apiCapabilities.snapshotRestore = true;
    const capabilities = (provider as any).getWebviewCapabilities();
    expect(capabilities.revertFileChange).toBe(false);
    expect(capabilities.undoLastTurn).toBe(true);
  });

  it("rejects old webview revert messages without restoring files or changing displayed changes", async () => {
    const { provider, api, postMessage } = createProvider();
    const snapshotApi = api as any;
    snapshotApi.listSnapshots = vi.fn(); snapshotApi.restoreSnapshot = vi.fn();
    (provider as any).apiCapabilities.snapshotList = true;
    (provider as any).apiCapabilities.snapshotRestore = true;
    const changes = structuredClone((provider as any).sessionState.data.turnFileChanges);
    await (provider as any).handleRevertFileChange("a.ts", "modified", "untrusted diff");
    expect(snapshotApi.listSnapshots).not.toHaveBeenCalled();
    expect(snapshotApi.restoreSnapshot).not.toHaveBeenCalled();
    expect((provider as any).sessionState.data.turnFileChanges).toEqual(changes);
    expect(postMessage).toHaveBeenCalledWith({ type: "info", message: expect.stringContaining("Single-file revert is unavailable") });
  });

  it("enables per-file revert only when the engine exposes the file-revert route", () => {
    const { provider } = createProvider();
    (provider as any).apiCapabilities.snapshotList = true;
    (provider as any).apiCapabilities.snapshotRestore = true;
    expect((provider as any).getWebviewCapabilities().revertFileChange).toBe(false);

    (provider as any).apiCapabilities.threadFileRevert = true;
    expect((provider as any).getWebviewCapabilities().revertFileChange).toBe(true);
  });

  it("reverts one file through the file-scoped endpoint and drops it from the change record", async () => {
    const { provider, api, postMessage } = createProvider();
    const revertThreadFile = vi.fn(async () => ({
      path: "a.ts",
      action: "modified",
      snapshot_id: "abc123",
      snapshot_label: "pre-turn:1",
    }));
    (api as any).revertThreadFile = revertThreadFile;
    (provider as any).apiCapabilities.threadFileRevert = true;
    (provider as any).sessionState.data.turnFileChanges = [
      { filePath: "a.ts", changeType: "modified", addedLines: 1, removedLines: 0 },
      { filePath: "b.ts", changeType: "modified", addedLines: 2, removedLines: 1 },
    ];

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(api.ensureReady).toHaveBeenCalledOnce();
    expect(revertThreadFile).toHaveBeenCalledWith("thread-1", "a.ts");
    // The unwound file is gone; the other file's record is untouched.
    expect((provider as any).sessionState.data.turnFileChanges).toEqual([
      { filePath: "b.ts", changeType: "modified", addedLines: 2, removedLines: 1 },
    ]);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "changesState",
        changes: [expect.objectContaining({ filePath: "b.ts" })],
      })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("a.ts"),
    });
  });

  it("never falls back to the whole-workspace snapshot restore", async () => {
    const { provider, api, postMessage } = createProvider();
    const restoreSnapshot = vi.fn();
    const listSnapshots = vi.fn();
    (api as any).restoreSnapshot = restoreSnapshot;
    (api as any).listSnapshots = listSnapshots;
    (api as any).revertThreadFile = vi.fn(async () => {
      throw new Error("409: No snapshot owned by this session differs");
    });
    (provider as any).apiCapabilities.threadFileRevert = true;

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(restoreSnapshot).not.toHaveBeenCalled();
    expect(listSnapshots).not.toHaveBeenCalled();
    // A failed revert must not silently drop the file from the record.
    expect((provider as any).sessionState.data.turnFileChanges).toEqual([
      { filePath: "a.ts", changeType: "modified", addedLines: 1, removedLines: 0 },
    ]);
    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringContaining("No snapshot owned by this session differs"),
    });
  });
});
