import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "plan"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
    executeCommandMock: vi.fn(),
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
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
    get workspaceFolders() {
      return vscodeState.workspaceFolders;
    },
  },
  commands: {
    executeCommand: vscodeState.executeCommandMock,
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
    showTextDocument: vi.fn(),
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

function createProvider() {
  const currentThread = {
    id: "thread-1",
    model: "deepseek-v4-pro",
    mode: "plan",
    workspace: "",
    auto_approve: false,
    trust_mode: false,
  };

  const updateThread = vi.fn(async (_threadId: string, updates: Record<string, unknown>) => ({
    ...currentThread,
    ...updates,
  }));
  const startTurn = vi.fn(async () => ({
    thread: currentThread,
    turn: { id: "turn-1" },
  }));
  const streamEvents = vi.fn(() => ({ abort: vi.fn() }));
  const createThread = vi.fn(async (opts: Record<string, unknown>) => ({
    ...currentThread,
    id: "thread-created",
    ...opts,
  }));
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    updateThread,
    getThread: vi.fn(async () => currentThread),
    startTurn,
    streamEvents,
    createThread,
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  provider.refreshWorkPanel = vi.fn();
  provider.currentThread = currentThread as any;

  return { api, currentThread, provider, postMessage: provider.postMessage as any };
}

describe("ChatProvider mode regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.configValues.clear();
    vscodeState.configValues.set("defaultMode", "plan");
    vscodeState.configValues.set("defaultModel", "deepseek-v4-pro");
    vscodeState.configValues.set("reasoningEffort", "auto");
    vscodeState.configValues.set("autoApprove", false);
    vscodeState.workspaceFolders = undefined;
  });

  it("keeps sending new turns in agent mode after /mode agent updates the active thread", async () => {
    const { api, provider } = createProvider();

    await (provider as any).handleWebviewMessage({
      type: "slashCommand",
      command: "/mode",
      args: "agent",
    });
    await (provider as any).handleWebviewMessage({
      type: "sendMessage",
      text: "use write_file",
    });

    expect(api.updateThread).toHaveBeenCalledWith("thread-1", {
      mode: "agent",
    });
    expect(provider.currentThread?.mode).toBe("agent");
    expect(api.startTurn).toHaveBeenCalledWith("thread-1", "use write_file", {
      mode: "agent",
      model: "deepseek-v4-pro",
      reasoning_effort: "auto",
      permission_posture: "ask",
      auto_approve: false,
      trust_mode: false,
    });
  });

  it("preserves mode and model when workspace sync PATCH returns only partial thread fields", async () => {
    vscodeState.workspaceFolders = [{ uri: { fsPath: "/workspace" } }];
    const { api, provider } = createProvider();
    api.updateThread = vi
      .fn()
      .mockResolvedValueOnce({
        id: "thread-1",
        model: "deepseek-v4-pro",
        mode: "agent",
        workspace: "",
        auto_approve: false,
        trust_mode: false,
      })
      .mockResolvedValueOnce({
        id: "thread-1",
        workspace: "/workspace",
      });

    await (provider as any).handleWebviewMessage({
      type: "slashCommand",
      command: "/mode",
      args: "agent",
    });
    await (provider as any).handleWebviewMessage({
      type: "sendMessage",
      text: "write through tool",
    });

    expect(api.startTurn).toHaveBeenCalledWith("thread-1", "write through tool", {
      mode: "agent",
      model: "deepseek-v4-pro",
      reasoning_effort: "auto",
      permission_posture: "ask",
      auto_approve: false,
      trust_mode: false,
    });
  });

  it("approving a plan executes it in Act mode once the thread switched", async () => {
    const { api, provider } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "approvePlan" });

    expect(provider.currentThread?.mode).toBe("agent");
    expect(api.startTurn).toHaveBeenCalledWith("thread-1", expect.any(String), {
      mode: "agent",
      model: "deepseek-v4-pro",
      reasoning_effort: "auto",
      permission_posture: "ask",
      auto_approve: false,
      trust_mode: false,
    });
  });

  it("carries the composer text typed before clicking approve into the Act turn", async () => {
    const { api, provider } = createProvider();

    await (provider as any).handleWebviewMessage({
      type: "approvePlan",
      text: "  only do steps 1 and 3  ",
    });

    expect(api.startTurn).toHaveBeenCalledWith(
      "thread-1",
      "Plan approved. Mode is now Act. The instruction below takes precedence over the plan above:\n\nonly do steps 1 and 3",
      expect.objectContaining({ mode: "agent" })
    );
  });

  it("falls back to the plain proceed message when the composer was empty", async () => {
    const { api, provider } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "approvePlan", text: "   " });

    expect(api.startTurn).toHaveBeenCalledWith(
      "thread-1",
      "Plan approved. Mode is now Act — proceed with the plan above.",
      expect.objectContaining({ mode: "agent" })
    );
  });

  it("hands the composer text back when the approval could not go through", async () => {
    const { api, provider, postMessage } = createProvider();
    api.updateThread = vi.fn(async () => {
      throw new Error("engine refused the mode patch");
    });

    await (provider as any).handleWebviewMessage({
      type: "approvePlan",
      text: "  only do steps 1 and 3  ",
    });

    expect(api.startTurn).not.toHaveBeenCalled();
    // The webview cleared its input the moment the button was clicked, so a
    // refused approval must not also cost the user their instruction.
    expect(postMessage).toHaveBeenCalledWith({
      type: "setInputText",
      text: "only do steps 1 and 3",
    });
  });

  it("restores nothing when the composer was already empty", async () => {
    const { api, provider, postMessage } = createProvider();
    api.updateThread = vi.fn(async () => {
      throw new Error("engine refused the mode patch");
    });

    await (provider as any).handleWebviewMessage({ type: "approvePlan", text: "   " });

    // Nothing was typed, so nothing may be pushed back (the handler focuses
    // the composer, which would be a stray focus grab on a failed approval).
    expect(
      postMessage.mock.calls.some(([msg]: [any]) => msg?.type === "setInputText")
    ).toBe(false);
  });

  it("does not execute the plan when the thread could not be switched to Act", async () => {
    const { api, provider, postMessage } = createProvider();
    api.updateThread = vi.fn(async () => {
      throw new Error("engine refused the mode patch");
    });

    await (provider as any).handleWebviewMessage({ type: "approvePlan" });

    expect(provider.currentThread?.mode).toBe("plan");
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(postMessage.mock.calls.some(([msg]: [any]) => msg?.type === "error")).toBe(true);
  });

  it("decides the plan approval by the mode the turn ran in, not the thread's mode now", async () => {
    const { provider, postMessage } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "sendMessage", text: "plan it" });
    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "item.delta",
      turn_id: "turn-1",
      item_id: "i1",
      payload: { kind: "agent_message", delta: "1. do the thing" },
    } as any);
    // The user switches the thread to Act while the plan turn is still running.
    provider.currentThread!.mode = "agent";

    (provider as any).handleRuntimeEvent({
      seq: 3,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    } as any);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "messageComplete", planApproval: true }),
    );
  });

  it("takes the mode the runtime reports on the turn over the one it recorded itself", async () => {
    const { provider, postMessage } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "sendMessage", text: "plan it" });
    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "item.delta",
      turn_id: "turn-1",
      item_id: "i1",
      payload: { kind: "agent_message", delta: "an answer" },
    } as any);

    // The runtime says this turn ran in Act, whatever this client recorded.
    (provider as any).handleRuntimeEvent({
      seq: 3,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed", mode: "agent" } },
    } as any);

    const completion = postMessage.mock.calls
      .map(([msg]: [any]) => msg)
      .find((msg: any) => msg?.type === "messageComplete");
    expect(completion?.planApproval).toBe(false);
  });

  it("republishes the startup defaults when 新建会话 clears the active thread", async () => {
    vscodeState.configValues.set("defaultPermissionPosture", "auto_review");
    const { provider, postMessage } = createProvider();

    await (provider as any).handleWebviewMessage({ type: "newThread" });

    expect(provider.currentThread).toBeNull();
    // clearChat resets the conversation and nothing else, so without this the
    // chips keep naming the mode of the thread that was just cleared. With no
    // thread the honest value is the startup default the next one inherits.
    expect(postMessage).toHaveBeenCalledWith({
      type: "settingsUpdated",
      mode: "plan",
      posture: "auto_review",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });
  });

  it("recreates a discarded thread with its own mode and permission, not the startup defaults", async () => {
    const { api, provider } = createProvider();
    // The user's conversation is Act + Full Access; the startup defaults this
    // fixture configures are Plan + Ask. Rebuilding from the defaults here would
    // silently re-mode and re-permission a conversation already configured.
    provider.currentThread = {
      ...provider.currentThread!,
      mode: "agent",
      permission_posture: "full_access",
      auto_approve: true,
      trust_mode: true,
    } as any;
    api.getThread = vi.fn(async () => {
      throw new Error("Thread not found: thread-1");
    });

    await (provider as any).handleWebviewMessage({
      type: "sendMessage",
      text: "carry on",
    });

    expect(api.createThread).toHaveBeenCalledWith({
      model: "deepseek-v4-pro",
      mode: "agent",
      workspace: undefined,
      permission_posture: "full_access",
      auto_approve: true,
      trust_mode: true,
    });
    expect(api.startTurn).toHaveBeenCalledWith(
      "thread-created",
      "carry on",
      expect.objectContaining({
        mode: "agent",
        permission_posture: "full_access",
      }),
    );
  });

  it("publishes the thread it just created when a threadless view sends its first message", async () => {
    const { api, provider, postMessage } = createProvider();
    provider.currentThread = null;

    await (provider as any).handleWebviewMessage({
      type: "sendMessage",
      text: "hello",
    });

    // The webview has never been told about this thread, so the chips would
    // otherwise still describe whatever the view showed before it existed.
    expect(api.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "plan" }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "settingsUpdated", mode: "plan" }),
    );
  });

  it("carries a loaded thread's mode and permission to the chips that replaced the previous one", async () => {
    const { api, provider, postMessage } = createProvider();
    // The thread left behind is Plan + Ask (this fixture); the one being opened
    // is Act + Full Access, and the chips have to follow it.
    api.getThread = vi.fn(async () => ({
      ...(provider.currentThread as any),
      id: "thread-2",
      mode: "agent",
      permission_posture: "full_access",
      auto_approve: true,
      trust_mode: true,
    })) as any;

    await (provider as any).handleWebviewMessage({
      type: "loadThread",
      threadId: "thread-2",
    });

    expect(provider.currentThread?.id).toBe("thread-2");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settingsUpdated",
        mode: "agent",
        posture: "full_access",
      }),
    );
  });
});
