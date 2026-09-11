import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { getEventHandlerScript } from "./webview-js-event-handler";
import { makeTr } from "./webview-test-helpers";

class FakeClassList {
  private values = new Set<string>();

  add(name: string): void {
    this.values.add(name);
  }

  remove(name: string): void {
    this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.values.has(name)) {
        this.values.delete(name);
        return false;
      }
      this.values.add(name);
      return true;
    }
    if (force) {
      this.values.add(name);
      return true;
    }
    this.values.delete(name);
    return false;
  }
}

class FakeElement {
  public textContent = "";
  public innerHTML = "";
  public value = "";
  public scrollTop = 0;
  public scrollHeight = 0;
  public classList = new FakeClassList();
  public parentElement: FakeElement | null = null;
  private listeners = new Map<string, (event: unknown) => void>();
  private attributes = new Map<string, string>();

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, handler);
  }

  dispatch(name: string, event: unknown): void {
    const handler = this.listeners.get(name);
    if (handler) handler(event);
  }

  querySelector(): FakeElement | null {
    return null;
  }

  closest(): FakeElement | null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  appendChild(_child: unknown): void {}

  insertBefore(_child: unknown, _before: unknown): void {}

  remove(): void {}

  focus(): void {}

  setSelectionRange(_start: number, _end: number): void {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function createRuntimeHarness() {
  const elements = new Map<string, FakeElement>();
  const getEl = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new FakeElement();
      elements.set(id, element);
    }
    return element;
  };

  const postMessages: Array<Record<string, unknown>> = [];
  const sendStopCalls: boolean[] = [];
  const windowListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const taskDetailCalls: unknown[] = [];
  const agentDetailCalls: unknown[] = [];

  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (value: unknown) => String(value ?? ""),
    __wvFormatLoadedThread: () => "",
    __wvVscode: {
      postMessage: (msg: Record<string, unknown>) => {
        postMessages.push(msg);
      },
    },
    __wvDiffStore: {
      clear: () => {},
    },
    __wvDiffIdCounter: {
      value: 0,
    },
    __wvApiCapabilities: {},
    __wvSidebar: {
      closeTaskDetail: () => {},
      applyShowThreadList: () => {},
      setSessions: () => {},
      setShowAllWorkspaces: () => {},
      renderSessions: () => {},
      setThreads: () => {},
      renderThreads: () => {},
      renderTasks: () => {},
      setAgentRuns: () => {},
      renderAgents: () => {},
      setWorkState: () => {},
      renderWork: () => {},
      setChangesState: () => {},
      renderChanges: () => {},
      setActiveSessionId: () => {},
      setActiveThreadId: () => {},
      showTaskDetail: (task: unknown) => {
        taskDetailCalls.push(task);
      },
      closeAgentDetail: () => {},
      showAgentDetail: (run: unknown) => {
        agentDetailCalls.push(run);
      },
    },
    __wvMessages: {
      addMessage: () => {},
      setStreaming: () => {},
      getStreamingTimeout: () => null,
      setStreamingTimeout: () => {},
      isStreaming: () => false,
      smartScrollToBottom: () => {},
      renderWelcome: () => {},
    },
    __wvInput: {
      updateSendStopButton: (streaming: boolean) => {
        sendStopCalls.push(streaming);
      },
      applyApiCapabilities: () => {},
      setCurrentAttachments: () => {},
      renderAttachments: () => {},
    },
    addEventListener: (name: string, handler: (event: any) => void) => {
      windowListeners.set(name, handler);
    },
  };

  const documentObj = {
    getElementById: (id: string) => getEl(id),
    querySelectorAll: () => [] as FakeElement[],
    addEventListener: (name: string, handler: (event: any) => void) => {
      documentListeners.set(name, handler);
    },
    createElement: () => new FakeElement(),
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  });

  vm.runInContext(getEventHandlerScript(makeTr()), context);

  return {
    dispatchMessage(msg: Record<string, unknown>) {
      const handler = windowListeners.get("message");
      if (!handler) throw new Error("message handler not registered");
      handler({ data: msg });
    },
    getElement: getEl,
    postMessages,
    sendStopCalls,
    documentListeners,
    taskDetailCalls,
    agentDetailCalls,
  };
}

describe("webview-js-event-handler runtime", () => {
  it("updates the visible settings labels and ready status text for ready/settingsUpdated messages", () => {
    const harness = createRuntimeHarness();

    expect(harness.postMessages).toEqual([{ type: "webviewReady" }]);

    harness.dispatchMessage({
      type: "ready",
      mode: "plan",
      posture: "ask",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
      runtimeVersion: "0.9.0",
      showThreadList: false,
    });

    expect(harness.getElement("current-mode").textContent).toBe("Plan");
    expect(harness.getElement("current-mode").getAttribute("data-value")).toBe("plan");
    expect(harness.getElement("current-posture").textContent).toBe("Ask");
    expect(harness.getElement("current-model").textContent).toBe("deepseek-v4-pro");
    expect(harness.getElement("current-reasoning").textContent).toBe("auto");

    harness.dispatchMessage({
      type: "settingsUpdated",
      mode: "operate",
      posture: "full_access",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    });

    expect(harness.getElement("current-mode").textContent).toBe("Operate");
    expect(harness.getElement("current-posture").textContent).toBe("Full Access");
    expect(harness.getElement("current-model").textContent).toBe("deepseek-v4-pro");
    expect(harness.getElement("current-reasoning").textContent).toBe("high");
    expect(harness.getElement("status-text").textContent).toBe("Ready (deepseek-v4-pro)");
    expect(harness.postMessages).toEqual([{ type: "webviewReady" }]);
  });

  it("updates the visible model label and ready status text from providerModels currentModel", () => {
    const harness = createRuntimeHarness();

    harness.getElement("current-model").textContent = "deepseek-v4-pro";

    harness.dispatchMessage({
      type: "providerModels",
      provider: "openai",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      currentModel: "gpt-4.1",
      hasCatalog: true,
    });

    expect(harness.getElement("current-model").textContent).toBe("gpt-4.1");
    expect(harness.getElement("status-text").textContent).toBe("Ready (gpt-4.1)");
  });

  it("ignores stale providerModels responses for a provider that is no longer active", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "volcengine",
      providers: [
        { id: "deepseek", display_name: "DeepSeek" },
        { id: "volcengine", display_name: "Volcengine Ark" },
      ],
    });
    harness.getElement("current-model").textContent = "DeepSeek-V4-Pro";

    harness.dispatchMessage({
      type: "providerModels",
      provider: "deepseek",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      currentModel: "deepseek-v4-pro",
      hasCatalog: true,
    });

    expect(harness.getElement("current-model").textContent).toBe("DeepSeek-V4-Pro");

    harness.dispatchMessage({
      type: "providerModels",
      provider: "volcengine",
      models: ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash"],
      currentModel: "DeepSeek-V4-Flash",
      hasCatalog: true,
    });

    expect(harness.getElement("current-model").textContent).toBe("DeepSeek-V4-Flash");
    expect(harness.getElement("status-text").textContent).toBe("Ready (DeepSeek-V4-Flash)");
  });

  it("keeps the send/stop button in the streaming state across informational status messages", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-1" });
    expect(harness.sendStopCalls).toEqual([true]);
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(true);

    // A reasoning turn restarts its reasoning item several times, and every
    // item start emits a status message. Those must not flip the button back
    // to "send" while the turn is still running.
    harness.dispatchMessage({ type: "status", text: "agent_reasoning started" });
    harness.dispatchMessage({ type: "status", text: "Turn: in_progress" });

    expect(harness.getElement("status-text").textContent).toBe("Turn: in_progress");
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(true);
    expect(harness.sendStopCalls).toEqual([true]);

    // A real turn end still flips it back.
    harness.dispatchMessage({ type: "turnInterrupted" });

    expect(harness.sendStopCalls).toEqual([true, false]);
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(false);
  });

  it("never returns the button to send while reasoning deltas and item-start statuses interleave", () => {
    const harness = createRuntimeHarness();

    // Mirrors one recorded turn's ordering: turn.lifecycle -> item.started
    // (agent_reasoning, restarted once per reasoning round) -> thinking
    // deltas -> item.started (tool_call) -> more reasoning, repeated.
    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-1" });
    for (let round = 0; round < 3; round++) {
      harness.dispatchMessage({ type: "status", text: "Turn: in_progress" });
      harness.dispatchMessage({ type: "status", text: "agent_reasoning started" });
      harness.dispatchMessage({ type: "updateThinking", messageId: "msg-1", blockIdx: 0, thinking: "..." });
      harness.dispatchMessage({ type: "status", text: "tool_call started" });
      harness.dispatchMessage({ type: "updateMessage", messageId: "msg-1", blockIdx: 0, content: "hi" });
    }

    expect(harness.sendStopCalls.every(Boolean)).toBe(true);

    harness.dispatchMessage({ type: "messageComplete", messageId: "msg-1" });

    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(false);
  });

  it("clears the running-turn button state when a history load replaces the conversation", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-1" });
    expect(harness.sendStopCalls).toEqual([true]);

    harness.dispatchMessage({ type: "loadHistory", messages: [] });

    expect(harness.sendStopCalls).toEqual([true, false]);
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(false);
  });

  it("routes taskDetail and agentDetail messages to the sidebar detail views", () => {
    const harness = createRuntimeHarness();

    const task = { id: "task-1", status: "completed" };
    const run = { spec: { run_id: "run-1" }, status: "completed" };

    harness.dispatchMessage({ type: "taskDetail", task });
    harness.dispatchMessage({ type: "agentDetail", run });

    expect(harness.taskDetailCalls).toEqual([task]);
    expect(harness.agentDetailCalls).toEqual([run]);
  });

  it("posts setPosture when the permission dropdown selects a posture", () => {
    const harness = createRuntimeHarness();
    const settingsBar = harness.getElement("settings-bar");

    const item = new FakeElement();
    item.classList.add("dropdown-item");
    item.setAttribute("data-value", "full_access");
    const menu = new FakeElement();
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "posture");
    menu.parentElement = wrapper;
    item.parentElement = menu;

    settingsBar.dispatch("click", { target: item, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({
      type: "setPosture",
      posture: "full_access",
    });
  });

  it("routes mode dropdown selections through /mode with the canonical value", () => {
    const harness = createRuntimeHarness();
    const settingsBar = harness.getElement("settings-bar");

    const item = new FakeElement();
    item.classList.add("dropdown-item");
    item.setAttribute("data-value", "operate");
    const menu = new FakeElement();
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "mode");
    menu.parentElement = wrapper;
    item.parentElement = menu;

    settingsBar.dispatch("click", { target: item, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({
      type: "slashCommand",
      command: "/mode",
      args: "operate",
    });
  });
});
