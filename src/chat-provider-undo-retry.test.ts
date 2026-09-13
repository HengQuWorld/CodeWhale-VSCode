import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import type { FileChangeInfo } from "./utils/session-state";

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

  it("rolls files back through patchUndoThreadTurn when the thread is trusted", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentThread = { id: "thread-1", trust_mode: true };
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

  it("surfaces the engine's refusal and changes nothing when the rollback is not permitted", async () => {
    const { provider, api, postMessage } = createProvider();
    // The engine owns the trust decision and answers an untrusted rollback with
    // a 409. The GUI must present that as a deliberate refusal rather than
    // reinterpret it as a reason to pick a different endpoint.
    api.patchUndoThreadTurn.mockRejectedValue(
      new Error(
        "API error 409: Refusing to undo workspace files outside trusted mode. " +
          "Turn on /trust or switch this thread to Full Access, then undo again."
      )
    );
    const changes = structuredClone((provider as any).sessionState.data.turnFileChanges);

    await provider.handleUndoLastTurn();

    expect(api.patchUndoThreadTurn).toHaveBeenCalledWith("thread-1");
    expect(provider.currentThread).toEqual({ id: "thread-1" });
    expect((provider as any).sessionState.data.turnFileChanges).toEqual(changes);
    // The engine's own sentence, presented as guidance rather than a failure.
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("outside trusted mode"),
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("tells the user when the engine restored no files", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentThread = { id: "thread-1", trust_mode: true };
    api.patchUndoThreadTurn.mockResolvedValue({
      patch_result: {
        files_restored: false,
        summary: "No current-session tool or pre-turn snapshots differ from the current workspace.",
      },
      thread: { id: "thread-2" },
      original_user_text: null,
    });

    await provider.handleUndoLastTurn();

    // Silence here is how a user comes to believe the workspace was rolled
    // back when it was not.
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("No current-session tool or pre-turn snapshots differ"),
    });
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

  it("reverts exactly the restore point the change names, and drops it from the record", async () => {
    const { provider, api, postMessage } = createProvider();
    const snapshotId = "3f2a".padEnd(40, "0");
    const expectedHash = "sha256:" + "ab".repeat(32);
    const revertThreadFile = vi.fn(async () => ({
      path: "a.ts",
      action: "modified",
      snapshot_id: snapshotId,
      snapshot_label: "tool:call_abc123",
    }));
    const listSnapshots = vi.fn(async () => [
      { id: "11".padEnd(40, "0"), label: "tool:call_other", timestamp: 1 },
      { id: snapshotId, label: "tool:call_abc123", timestamp: 2 },
    ]);
    (api as any).revertThreadFile = revertThreadFile;
    (api as any).listSnapshots = listSnapshots;
    (provider as any).apiCapabilities.threadFileRevert = true;
    (provider as any).sessionState.data.turnFileChanges = [
      {
        filePath: "a.ts",
        changeType: "modified",
        addedLines: 1,
        removedLines: 0,
        callId: "call_abc123",
        expectedHash,
      },
      { filePath: "b.ts", changeType: "modified", addedLines: 2, removedLines: 1 },
    ];

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(api.ensureReady).toHaveBeenCalledOnce();
    // The engine restores the restore point the client names. Naming it is what
    // keeps this from being "the newest snapshot that differs", which can erase
    // the user's later edits while leaving this change in place.
    expect(listSnapshots).toHaveBeenCalledWith({ limit: 100 });
    expect(revertThreadFile).toHaveBeenCalledWith("thread-1", {
      path: "a.ts",
      snapshotId,
      expectedHash,
    });
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

  it("explains a change whose restore point is gone instead of reverting another one", async () => {
    const { provider, api, postMessage } = createProvider();
    const revertThreadFile = vi.fn();
    (api as any).revertThreadFile = revertThreadFile;
    // The listing is workspace-wide and capped: a pruned snapshot is simply
    // absent, and the client must not substitute a different one.
    (api as any).listSnapshots = vi.fn(async () => [
      { id: "11".padEnd(40, "0"), label: "tool:call_other", timestamp: 1 },
    ]);
    (provider as any).apiCapabilities.threadFileRevert = true;
    (provider as any).sessionState.data.turnFileChanges = [
      {
        filePath: "a.ts",
        changeType: "modified",
        addedLines: 1,
        removedLines: 0,
        callId: "call_abc123",
        expectedHash: "sha256:" + "ab".repeat(32),
      },
    ];

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(revertThreadFile).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("no engine restore point"),
    });
    expect((provider as any).sessionState.data.turnFileChanges).toHaveLength(1);
  });

  it("refuses a record whose runtime published no call id", async () => {
    const { provider, api, postMessage } = createProvider();
    const revertThreadFile = vi.fn();
    const listSnapshots = vi.fn();
    (api as any).revertThreadFile = revertThreadFile;
    (api as any).listSnapshots = listSnapshots;
    (provider as any).apiCapabilities.threadFileRevert = true;

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    // Without the engine's identity for the change there is nothing to name,
    // and guessing would be the workspace-wide rollback this route replaced.
    expect(listSnapshots).not.toHaveBeenCalled();
    expect(revertThreadFile).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "info",
      message: expect.stringContaining("no engine restore point"),
    });
  });

  it("keeps a non-refusal failure an error and never falls back to the whole-workspace restore", async () => {
    const { provider, api, postMessage } = createProvider();
    const restoreSnapshot = vi.fn();
    (api as any).restoreSnapshot = restoreSnapshot;
    (api as any).listSnapshots = vi.fn(async () => [
      { id: "11".padEnd(40, "0"), label: "tool:call_abc123", timestamp: 1 },
    ]);
    (api as any).revertThreadFile = vi.fn(async () => {
      throw new Error("API error 500: File restore failed: git checkout failed");
    });
    (provider as any).apiCapabilities.threadFileRevert = true;
    (provider as any).sessionState.data.turnFileChanges = [
      {
        filePath: "a.ts",
        changeType: "modified",
        addedLines: 1,
        removedLines: 0,
        callId: "call_abc123",
        expectedHash: "sha256:" + "ab".repeat(32),
      },
    ];

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(restoreSnapshot).not.toHaveBeenCalled();
    // A failed revert must not silently drop the file from the record.
    expect((provider as any).sessionState.data.turnFileChanges).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringContaining("git checkout failed"),
    });
  });

  it("re-reads the file and asks for a deliberate retry when it moved under the panel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-revert-"));
    try {
      const abs = path.join(dir, "a.ts");
      fs.writeFileSync(abs, "edited by hand\n");
      const { provider, api, postMessage } = createProvider();
      (api as any).listSnapshots = vi.fn(async () => [
        { id: "11".padEnd(40, "0"), label: "tool:call_abc123", timestamp: 1 },
      ]);
      // The engine's own sentence for a revision that no longer matches.
      (api as any).revertThreadFile = vi.fn(async () => {
        throw new Error(
          "API error 409: The file changed after the selected change record. Refresh and review it before restoring; nothing was changed."
        );
      });
      (provider as any).apiCapabilities.threadFileRevert = true;
      (provider as any).currentThread = { id: "thread-1", workspace: dir };
      const record = {
        filePath: "a.ts",
        changeType: "modified" as const,
        addedLines: 1,
        removedLines: 0,
        callId: "call_abc123",
        expectedHash: "sha256:" + "00".repeat(32),
      };
      (provider as any).sessionState.data.turnFileChanges = [record];

      await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

      // Guidance, not HTTP framing — and the record now carries the revision
      // the user is looking at, so the next click is the re-review the engine asks for.
      expect(postMessage).toHaveBeenCalledWith({
        type: "info",
        message: expect.stringContaining("click Revert again"),
      });
      expect(record.expectedHash).toBe(
        "sha256:" + createHash("sha256").update("edited by hand\n").digest("hex")
      );
      expect((provider as any).sessionState.data.turnFileChanges).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reverts only the change a card names, keeping the file's other changes reviewable", async () => {
    const { provider, api, postMessage } = createProvider();
    const firstSnapshot = "aa".padEnd(40, "0");
    const snapshotId = "bb".padEnd(40, "0");
    const revertThreadFile = vi.fn(async () => ({
      path: "a.ts",
      action: "modified",
      snapshot_id: snapshotId,
      snapshot_label: "tool:call_second",
    }));
    (api as any).revertThreadFile = revertThreadFile;
    (api as any).listSnapshots = vi.fn(async () => [
      { id: firstSnapshot, label: "tool:call_first", timestamp: 1 },
      { id: snapshotId, label: "tool:call_second", timestamp: 2 },
    ]);
    (provider as any).apiCapabilities.threadFileRevert = true;
    const state = (provider as any).sessionState.data;
    const first: FileChangeInfo = {
      filePath: "a.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 0,
      diff: "diff one",
      callId: "call_first",
      expectedHash: "sha256:" + "11".repeat(32),
    };
    const second: FileChangeInfo = {
      filePath: "a.ts",
      changeType: "modified",
      addedLines: 2,
      removedLines: 1,
      diff: "diff two",
      callId: "call_second",
      expectedHash: "sha256:" + "22".repeat(32),
    };
    state.turnFileChanges = [first, second];
    (provider as any).reindexFileChanges();
    expect(first.changeIndex).toBe(0);
    expect(second.changeIndex).toBe(1);

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined, "call_second");

    // The card named the second change, so the first one — still on disk —
    // stays listed, and the surviving change is renumbered in its file.
    expect(revertThreadFile).toHaveBeenCalledWith("thread-1", {
      path: "a.ts",
      snapshotId,
      expectedHash: second.expectedHash,
    });
    expect(state.turnFileChanges).toEqual([first]);
    expect(first.changeIndex).toBe(0);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "changesState",
        changes: [expect.objectContaining({ filePath: "a.ts", diff: "diff one" })],
      })
    );
  });

  it("falls back to the file's most recent change when a message names none", async () => {
    const { provider, api } = createProvider();
    const snapshotId = "bb".padEnd(40, "0");
    const revertThreadFile = vi.fn(async () => ({
      path: "a.ts",
      action: "modified",
      snapshot_id: snapshotId,
      snapshot_label: "tool:call_second",
    }));
    (api as any).revertThreadFile = revertThreadFile;
    (api as any).listSnapshots = vi.fn(async () => [
      { id: snapshotId, label: "tool:call_second", timestamp: 2 },
    ]);
    (provider as any).apiCapabilities.threadFileRevert = true;
    (provider as any).sessionState.data.turnFileChanges = [
      {
        filePath: "a.ts",
        changeType: "modified",
        addedLines: 1,
        removedLines: 0,
        callId: "call_first",
        expectedHash: "sha256:" + "11".repeat(32),
      },
      {
        filePath: "a.ts",
        changeType: "modified",
        addedLines: 2,
        removedLines: 1,
        callId: "call_second",
        expectedHash: "sha256:" + "22".repeat(32),
      },
    ];

    await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

    expect(revertThreadFile).toHaveBeenCalledWith("thread-1", {
      path: "a.ts",
      snapshotId,
      expectedHash: "sha256:" + "22".repeat(32),
    });
  });

  it("presents the engine's refusals as guidance rather than HTTP errors", async () => {
    const refusals = [
      {
        engineMessage:
          "API error 409: Refusing to restore workspace files outside trusted mode. Turn on /trust or switch this thread to Full Access, then retry.",
        expected: "trusted thread",
      },
      {
        engineMessage:
          "API error 409: Thread thread-1 already has an active turn in workspace /w",
        expected: "busy with another turn",
      },
      {
        engineMessage:
          "API error 409: Selected restore point is unavailable or belongs to another session; refresh the change record and select the change again.",
        expected: "Reload the session",
      },
      {
        engineMessage:
          "API error 409: 'a.ts' already matches snapshot 'tool:call_abc123'; nothing to revert.",
        expected: "nothing to revert",
      },
    ];

    for (const { engineMessage, expected } of refusals) {
      const { provider, api, postMessage } = createProvider();
      (api as any).listSnapshots = vi.fn(async () => [
        { id: "11".padEnd(40, "0"), label: "tool:call_abc123", timestamp: 1 },
      ]);
      (api as any).revertThreadFile = vi.fn(async () => {
        throw new Error(engineMessage);
      });
      (provider as any).apiCapabilities.threadFileRevert = true;
      (provider as any).sessionState.data.turnFileChanges = [
        {
          filePath: "a.ts",
          changeType: "modified",
          addedLines: 1,
          removedLines: 0,
          callId: "call_abc123",
          expectedHash: "sha256:" + "ab".repeat(32),
        },
      ];

      await (provider as any).handleRevertFileChange("a.ts", "modified", undefined);

      expect(postMessage, engineMessage).toHaveBeenCalledWith({
        type: "info",
        message: expect.stringContaining(expected),
      });
    }
  });
});
