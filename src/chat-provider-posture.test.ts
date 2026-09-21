import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    ["defaultPermissionPosture", "ask"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback?: unknown) =>
        vscodeState.configValues.has(key)
          ? vscodeState.configValues.get(key)
          : fallback,
      update: vscodeState.updateMock,
    })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
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

function thread(mode: string) {
  return {
    id: "thread-1",
    mode,
    model: "deepseek-v4-pro",
    trust_mode: false,
    auto_approve: false,
  } as any;
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    bindEngine: vi.fn(),
    updateThread: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
      ...thread("agent"),
      ...updates,
    })),
    decideApproval: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => ({
      tasks: [],
      counts: { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 },
    })),
    getTask: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeProvider(api: ReturnType<typeof makeApi>) {
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return provider;
}

function messagesOf(provider: ChatProvider): Array<Record<string, any>> {
  return (provider.postMessage as any).mock.calls.map((call: any[]) => call[0]);
}

describe("ChatProvider permission posture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.configValues.clear();
    vscodeState.configValues.set("defaultMode", "agent");
    vscodeState.configValues.set("defaultPermissionPosture", "ask");
    vscodeState.configValues.set("defaultModel", "deepseek-v4-pro");
    vscodeState.configValues.set("reasoningEffort", "auto");
    vscodeState.configValues.set("autoApprove", false);
  });

  it("patches only permission_posture and reports the thread's own mode", async () => {
    // The runtime's PATCH response is the authoritative thread record, so it
    // echoes the real mode — not the global default.
    const api = makeApi({
      updateThread: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
        ...thread("plan"),
        ...updates,
      })),
    });
    const provider = makeProvider(api);
    (provider as any).currentThread = thread("plan");

    await (provider as any).handleWebviewMessage({ type: "setPosture", posture: "full_access" });

    // Thread-scoped: the startup default for new threads is its own control
    // (the dropdown's second group), so this must not move it.
    expect(vscodeState.updateMock).not.toHaveBeenCalled();
    // Posture-only patch: sending cached auto_approve/trust_mode would make the
    // runtime re-derive (and possibly downgrade) the thread's posture.
    expect(api.updateThread).toHaveBeenCalledWith("thread-1", {
      permission_posture: "full_access",
    });
    expect(messagesOf(provider)).toContainEqual({
      type: "settingsUpdated",
      mode: "plan",
      posture: "full_access",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });
    expect(messagesOf(provider)).toContainEqual({
      type: "info",
      message: "Permission posture changed to Full Access",
    });
  });

  it("normalizes aliases from the webview before persisting", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    await (provider as any).handleWebviewMessage({ type: "setPosture", posture: "auto-review" });

    expect(vscodeState.updateMock).toHaveBeenCalledWith(
      "defaultPermissionPosture",
      "auto_review",
      "global"
    );
    expect(api.updateThread).not.toHaveBeenCalled();
    expect(messagesOf(provider)).toContainEqual({
      type: "settingsUpdated",
      mode: "agent",
      posture: "auto_review",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });
  });

  it("answers the dropdown's second group with the startup default only", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    (provider as any).currentThread = thread("plan");

    await (provider as any).handleWebviewMessage({ type: "setDefaultMode", mode: "operate" });
    await (provider as any).handleWebviewMessage({
      type: "setDefaultPosture",
      posture: "auto_review",
    });

    expect(vscodeState.updateMock).toHaveBeenCalledWith("defaultMode", "operate", "global");
    expect(vscodeState.updateMock).toHaveBeenCalledWith(
      "defaultPermissionPosture",
      "auto_review",
      "global"
    );
    // Nothing here patches the thread: a default is for the conversations that do
    // not exist yet.
    expect(api.updateThread).not.toHaveBeenCalled();
    expect((provider as any).currentThread.mode).toBe("plan");
    // The webview marks the second group from this message, so it has to carry
    // what the setting now is.
    expect(messagesOf(provider)).toContainEqual({
      type: "scopedDefaults",
      mode: "operate",
      posture: "auto_review",
    });
  });

  it("falls back to the engine's posture when the thread patch fails", async () => {
    const api = makeApi({
      updateThread: vi.fn(async () => {
        throw new Error("runtime offline");
      }),
    });
    const provider = makeProvider(api);
    (provider as any).currentThread = thread("agent");

    await (provider as any).handleWebviewMessage({ type: "setPosture", posture: "full_access" });

    expect(
      messagesOf(provider).some((msg) => msg.type === "error" && /posture/i.test(msg.message))
    ).toBe(true);
    const settings = messagesOf(provider).find((msg) => msg.type === "settingsUpdated");
    expect(settings).toMatchObject({ mode: "agent", posture: "ask" });
  });

  it("mirrors Full Access and keeps the thread mode after an allow-and-remember decision", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    (provider as any).currentThread = thread("plan");

    await (provider as any).handleApprovalDecision("approval-1", "allow", true);

    expect(api.decideApproval).toHaveBeenCalledWith("approval-1", "allow", true);
    expect((provider as any).currentThread.auto_approve).toBe(true);
    expect((provider as any).currentThread.permission_posture).toBe("full_access");
    const settings = messagesOf(provider).find((msg) => msg.type === "settingsUpdated");
    // Regression: this used to report the global defaultMode ("agent") instead
    // of the loaded thread's mode.
    expect(settings).toMatchObject({ mode: "plan", posture: "full_access" });
  });

  it("leaves the thread untouched when remember is set on a deny decision", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    (provider as any).currentThread = thread("plan");

    await (provider as any).handleApprovalDecision("approval-2", "deny", true);

    expect((provider as any).currentThread.auto_approve).toBe(false);
    expect((provider as any).currentThread.permission_posture).toBeUndefined();
    expect(messagesOf(provider).some((msg) => msg.type === "settingsUpdated")).toBe(false);
  });

  it("asks under Ask even when the thread still carries trust_mode from Full Access", async () => {
    // trust_mode governs the sandbox, never the approval decision: the engine
    // resolves that from the posture alone. A thread moved from Full Access to
    // Ask keeps trust_mode = true (a posture patch touches permission_posture
    // only), so gating the dialog on it dropped every request while the engine
    // sat waiting for an answer — the approval then expired as a timeout.
    const api = makeApi();
    const provider = makeProvider(api);
    (provider as any).currentThread = {
      ...thread("agent"),
      permission_posture: "ask",
      trust_mode: true,
      auto_approve: false,
    };

    (provider as any).handleRuntimeEvent({
      seq: 1,
      event: "approval.required",
      turn_id: "turn-1",
      payload: { approval_id: "appr-1", tool_name: "exec_shell", description: "rm -rf build" },
    });

    expect(messagesOf(provider)).toContainEqual(
      expect.objectContaining({ type: "approvalRequired", approvalId: "appr-1" }),
    );
  });

  it("leaves the decision to the engine when the posture is not Ask", async () => {
    // Full Access auto-approves and Auto-Review auto-denies server-side, both
    // emitting the decision alongside the request — there is nothing to answer,
    // so a dialog here would ask for a decision the engine already made.
    for (const posture of ["full_access", "auto_review"]) {
      const api = makeApi();
      const provider = makeProvider(api);
      (provider as any).currentThread = {
        ...thread("agent"),
        permission_posture: posture,
        trust_mode: false,
        auto_approve: false,
      };

      (provider as any).handleRuntimeEvent({
        seq: 1,
        event: "approval.required",
        turn_id: "turn-1",
        payload: { approval_id: "appr-1", tool_name: "exec_shell", description: "rm -rf build" },
      });

      expect(messagesOf(provider).some((msg) => msg.type === "approvalRequired")).toBe(false);
    }
  });

  // ── settings changed outside the panel ──

  it("re-announces both scopes when a setting changes outside the panel", () => {
    const api = makeApi();
    const provider = makeProvider(api);
    // The active thread keeps its own mode and posture: a change made in the
    // VS Code settings editor is a change to what the *next* session starts
    // with, not to this conversation.
    (provider as any).currentThread = thread("plan");

    vscodeState.configValues.set("defaultMode", "operate");
    vscodeState.configValues.set("defaultPermissionPosture", "full_access");
    provider.handleConfigurationChanged();

    expect(messagesOf(provider)).toContainEqual({
      type: "scopedDefaults",
      mode: "operate",
      posture: "full_access",
    });
    expect(messagesOf(provider)).toContainEqual(
      expect.objectContaining({ type: "settingsUpdated", mode: "plan", posture: "ask" })
    );
  });

  it("shows the changed defaults in a view with no thread", () => {
    const api = makeApi();
    const provider = makeProvider(api);

    vscodeState.configValues.set("defaultMode", "plan");
    vscodeState.configValues.set("defaultPermissionPosture", "auto_review");
    provider.handleConfigurationChanged();

    // Nothing else would tell the chips: their next values come from the
    // defaults until a thread exists, and no message was sent since the change.
    expect(messagesOf(provider)).toContainEqual(
      expect.objectContaining({ type: "settingsUpdated", mode: "plan", posture: "auto_review" })
    );
  });

  it("marks the posture a legacy yolo default actually starts, and agrees with the chips", () => {
    const api = makeApi();
    const provider = makeProvider(api);
    // `yolo` is Act + Full Access, and a stale posture setting that predates the
    // alias must not narrow what the next session starts under.
    vscodeState.configValues.set("defaultMode", "yolo");
    vscodeState.configValues.set("defaultPermissionPosture", "ask");

    provider.postScopedDefaults();
    provider.handleConfigurationChanged();

    // The dropdown's default group and the chips name the same value as
    // `getCurrentPosture()` installs on a thread, because they are the same
    // resolution.
    expect(messagesOf(provider)).toContainEqual({
      type: "scopedDefaults",
      mode: "agent",
      posture: "full_access",
    });
    expect(messagesOf(provider)).toContainEqual(
      expect.objectContaining({ type: "settingsUpdated", mode: "agent", posture: "full_access" })
    );
  });

  // ── tasks start on the same defaults as a chat thread ──

  it("creates a task on the new-session defaults, permission included", async () => {
    const createTask = vi.fn(async () => ({ id: "task-1", status: "queued" }));
    const api = makeApi({
      ensureReady: vi.fn(async () => undefined),
      createTask,
    });
    const provider = makeProvider(api);
    (provider as any).refreshTaskList = vi.fn(async () => undefined);
    (provider as any).handleShowTaskDetail = vi.fn(async () => undefined);
    (provider as any).scheduleThreadListRefresh = vi.fn();
    vscodeState.configValues.set("defaultMode", "plan");
    vscodeState.configValues.set("defaultPermissionPosture", "full_access");

    await (provider as any).handleCreateTaskFromSidebar("  do the thing  ");

    // A task runs on a thread of its own, so it starts where a new chat thread
    // would — not on whatever the runtime happens to default to.
    expect(createTask).toHaveBeenCalledWith({
      prompt: "do the thing",
      model: "deepseek-v4-pro",
      mode: "plan",
      workspace: undefined,
      permission_posture: "full_access",
      auto_approve: true,
    });
  });

  it("normalizes a legacy yolo default for the task it starts", async () => {
    const createTask = vi.fn(async () => ({ id: "task-1", status: "queued" }));
    const api = makeApi({
      ensureReady: vi.fn(async () => undefined),
      createTask,
    });
    const provider = makeProvider(api);
    (provider as any).refreshTaskList = vi.fn(async () => undefined);
    (provider as any).handleShowTaskDetail = vi.fn(async () => undefined);
    (provider as any).scheduleThreadListRefresh = vi.fn();
    // `yolo` is Act + Full Access, not a mode the runtime accepts.
    vscodeState.configValues.set("defaultMode", "yolo");

    await (provider as any).handleCreateTaskFromSidebar("do the thing");

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "agent", permission_posture: "full_access" })
    );
  });
});
