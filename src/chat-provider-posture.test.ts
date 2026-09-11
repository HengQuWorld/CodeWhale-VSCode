import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    ["defaultPermissionPosture", "ask"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
    ["showThreadList", false],
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
    vscodeState.configValues.set("showThreadList", false);
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

    expect(vscodeState.updateMock).toHaveBeenCalledWith(
      "defaultPermissionPosture",
      "full_access",
      "global"
    );
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
});
