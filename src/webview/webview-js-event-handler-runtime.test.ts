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

/**
 * The selector subset the approval panel needs: class names, optionally
 * narrowed by one trailing class[attr="value"] pair. Anything else answers
 * nothing, the way this stand-in always did.
 */
function matchesSelector(element: FakeElement | null, selector?: string): boolean {
  if (!element || !selector) return false;
  const attrMatch = selector.match(/\[([\w-]+)="([^"]*)"\]/);
  const classPart = attrMatch ? selector.slice(0, attrMatch.index) : selector;
  const classes = classPart.split(".").filter((part) => part.length > 0);
  if (classes.length === 0) return false;
  const elementClasses = element.className.split(/\s+/).filter(Boolean);
  if (!classes.every((name) => elementClasses.includes(name))) return false;
  if (attrMatch && element.getAttribute(attrMatch[1]) !== attrMatch[2]) return false;
  return true;
}

class FakeElement {
  public textContent = "";
  public value = "";
  public scrollTop = 0;
  public scrollHeight = 0;
  public clientHeight = 0;
  public focusCount = 0;
  public className = "";
  public classList = new FakeClassList();
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  private html = "";
  private listeners = new Map<string, (event: unknown) => void>();
  private attributes = new Map<string, string>();

  /** Assigning innerHTML drops the children, the way the DOM does. */
  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.html = value;
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, handler);
  }

  dispatch(name: string, event: unknown): void {
    const handler = this.listeners.get(name);
    if (handler) handler(event);
  }

  querySelector(selector?: string): FakeElement | null {
    const matches = this.querySelectorAll(selector);
    return matches.length > 0 ? matches[0] : null;
  }

  closest(selector?: string): FakeElement | null {
    let node: FakeElement | null = this.parentElement;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Just enough selector support for the approval panel: class selectors and a
   * trailing class[attr="value"] pair, over direct children. Anything else
   * answers nothing, as this stand-in always did.
   */
  querySelectorAll(selector?: string): FakeElement[] {
    return this.children.filter((child) => matchesSelector(child, selector));
  }

  appendChild(child: FakeElement): void {
    this.detach(child);
    child.parentElement = this;
    this.children.push(child);
  }

  insertBefore(child: FakeElement, before: FakeElement | null): void {
    this.detach(child);
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
  }

  remove(): void {
    if (this.parentElement) this.parentElement.detach(this);
    this.parentElement = null;
  }

  private detach(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
  }

  focus(): void {
    this.focusCount += 1;
  }

  setSelectionRange(_start: number, _end: number): void {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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
  const attachmentPreviewCalls: Array<{ id: string; previewUrl: string }> = [];
  const goalCalls: Array<{ method: string; args: unknown[] }> = [];
  const planApproveCalls: string[] = [];

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
    __wvGoal: {
      applyState: (...args: unknown[]) => {
        goalCalls.push({ method: "applyState", args });
      },
      reset: (...args: unknown[]) => {
        goalCalls.push({ method: "reset", args });
      },
      setGoal: (...args: unknown[]) => {
        goalCalls.push({ method: "setGoal", args });
      },
      setBackgroundGoals: (...args: unknown[]) => {
        goalCalls.push({ method: "setBackgroundGoals", args });
      },
      setEditing: (...args: unknown[]) => {
        goalCalls.push({ method: "setEditing", args });
      },
      renderGoal: (...args: unknown[]) => {
        goalCalls.push({ method: "renderGoal", args });
      },
    },
    __wvDiffIdCounter: {
      value: 0,
    },
    __wvApiCapabilities: {},
    __wvSidebar: {
      closeTaskDetail: () => {},
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
      setUserScrolledUp: () => {},
      smartScrollToBottom: () => {},
      renderWelcome: () => {},
      createThinkingBlock: () => new FakeElement(),
      updateThinkingBlock: () => {},
      renderPlanApproveButton: (messageId: string) => {
        planApproveCalls.push(messageId);
      },
    },
    __wvInput: {
      updateSendStopButton: (streaming: boolean) => {
        sendStopCalls.push(streaming);
      },
      applyApiCapabilities: () => {},
      setCurrentAttachments: () => {},
      renderAttachments: () => {},
      setAttachmentPreview: (id: string, previewUrl: string) => {
        attachmentPreviewCalls.push({ id, previewUrl });
      },
    },
    addEventListener: (name: string, handler: (event: any) => void) => {
      windowListeners.set(name, handler);
    },
  };

  const documentObj = {
    getElementById: (id: string) => getEl(id),
    // The webview asks the document for cards by selector (e.g. the approval
    // bar that carries one id), so the stand-in searches the elements it hands
    // out — including their children — instead of always answering nothing.
    querySelectorAll: (selector?: string) => {
      const found: FakeElement[] = [];
      for (const element of elements.values()) {
        if (matchesSelector(element, selector)) found.push(element);
        for (const child of element.querySelectorAll(selector)) found.push(child);
      }
      return found;
    },
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
    /** Ids of the approvals the floating panel is currently offering. */
    approvalItemIds(): string[] {
      return getEl("approval-float").children
        .filter((child) => child.className.split(/\s+/).includes("approval-item"))
        .map((child) => child.getAttribute("data-approval-id") || "");
    },
    /** A global the script published for the other scripts (window.__wv...). */
    windowApi(name: string): any {
      return windowObj[name];
    },
    getElement: getEl,
    postMessages,
    sendStopCalls,
    documentListeners,
    taskDetailCalls,
    agentDetailCalls,
    attachmentPreviewCalls,
    goalCalls,
    planApproveCalls,
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

  it("returns focus to the input after attachments change", () => {
    const harness = createRuntimeHarness();
    const inputEl = harness.getElement("input");

    harness.dispatchMessage({
      type: "attachmentsChanged",
      attachments: [{ kind: "file", path: "/tmp/readme.md", name: "readme.md" }],
    });

    expect(inputEl.focusCount).toBe(1);
  });

  it("hands attachment thumbnails to the input module without re-rendering", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "attachmentPreview",
      id: "att-1",
      previewUrl: "data:image/png;base64,AAA",
    });

    expect(harness.attachmentPreviewCalls).toEqual([
      { id: "att-1", previewUrl: "data:image/png;base64,AAA" },
    ]);
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

  it("renders the plan-approve action only when messageComplete carries planApproval", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "messageComplete", messageId: "msg-1" });
    expect(harness.planApproveCalls).toEqual([]);

    harness.dispatchMessage({ type: "messageComplete", messageId: "msg-2", planApproval: true });
    expect(harness.planApproveCalls).toEqual(["msg-2"]);
  });

  it("puts the plan-approve action back when a rebuilt history names its message", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "loadHistory", messages: [] });
    expect(harness.planApproveCalls).toEqual([]);

    harness.dispatchMessage({ type: "loadHistory", messages: [], planApprovalFor: "msg-9" });
    expect(harness.planApproveCalls).toEqual(["msg-9"]);
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
    const toolbar = harness.getElement("toolbar");

    const item = new FakeElement();
    item.classList.add("dropdown-item");
    item.setAttribute("data-value", "full_access");
    const menu = new FakeElement();
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "posture");
    menu.parentElement = wrapper;
    item.parentElement = menu;

    toolbar.dispatch("click", { target: item, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({
      type: "setPosture",
      posture: "full_access",
    });
  });

  it("still acts on the dropdowns that stayed in the settings bar", () => {
    const harness = createRuntimeHarness();
    const settingsBar = harness.getElement("settings-bar");

    const item = new FakeElement();
    item.classList.add("dropdown-item");
    item.setAttribute("data-value", "high");
    const menu = new FakeElement();
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "reasoning");
    menu.parentElement = wrapper;
    item.parentElement = menu;

    settingsBar.dispatch("click", { target: item, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({
      type: "slashCommand",
      command: "/reasoning",
      args: "high",
    });
  });

  it("adopts goalState without disturbing an editor the user may have open", () => {
    const harness = createRuntimeHarness();
    const goal = { thread_id: "t1", objective: "ship it", status: "active" };

    harness.dispatchMessage({
      type: "goalState",
      goal,
      backgroundGoals: [{ thread_id: "t2", objective: "other", status: "active" }],
    });

    // applyState keeps an open editor alive and decides whether a redraw is
    // needed; the setGoal/setEditing pair it replaces redrew unconditionally.
    expect(harness.goalCalls).toEqual([
      {
        method: "applyState",
        args: [goal, [{ thread_id: "t2", objective: "other", status: "active" }]],
      },
    ]);
  });

  it("clears the whole goal control plane when the view is cleared", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "clearChat" });

    expect(harness.goalCalls).toEqual([{ method: "reset", args: [] }]);
  });

  it("clears the goal control plane when the viewed thread changes", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "threadLoaded", thread: { id: "t2" } });

    // A thread switch is a real view change, not one of the pushes applyState
    // exists to survive: an editor left open here would keep the draft written
    // for the thread we just left and save it against this one.
    expect(harness.goalCalls).toEqual([{ method: "reset", args: [] }]);
  });

  it("clears the goal control plane when a saved session is opened", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "sessionLoaded", sessionId: "s1" });

    // A viewed session has no thread yet, so it has no goal of its own.
    expect(harness.goalCalls).toEqual([{ method: "reset", args: [] }]);
  });

  it("keeps a running turn's streaming state when a goal error arrives", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-1" });
    expect(harness.sendStopCalls).toEqual([true]);

    harness.dispatchMessage({
      type: "error",
      message: "Failed to set goal: engine down",
      keepStreaming: true,
    });

    // The banner is the whole answer: the turn this error did not come from is
    // still running, so the button, the status bar and the stall timeout stay
    // where they were.
    expect(harness.sendStopCalls).toEqual([true]);
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(true);
    expect(harness.getElement("status-text").textContent).not.toBe("Error");
  });

  it("still stops the streaming state for an error that is the turn's", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-1" });
    harness.dispatchMessage({ type: "error", message: "Failed to load thread" });

    expect(harness.sendStopCalls).toEqual([true, false]);
    expect(harness.getElement("status-text").textContent).toBe("Error");
  });

  it("keeps the other pending approvals when one of them is answered", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a1", messageId: "m1", summary: "run the tests" });
    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a2", messageId: "m1", summary: "push the branch" });

    expect(harness.approvalItemIds()).toEqual(["a1", "a2"]);

    // Answering one approval is not an answer to the others: the provider keeps
    // them in its pending map, so the panel has to keep offering them.
    harness.dispatchMessage({ type: "approvalResolved", approvalId: "a1", decision: "allow" });

    expect(harness.approvalItemIds()).toEqual(["a2"]);
    expect(harness.getElement("approval-float").getAttribute("hidden")).toBeNull();

    harness.dispatchMessage({ type: "approvalResolved", approvalId: "a2", decision: "deny" });

    expect(harness.approvalItemIds()).toEqual([]);
    expect(harness.getElement("approval-float").getAttribute("hidden")).toBe("");
  });

  it("moves only the answered card's status, not every card that was waiting", () => {
    const harness = createRuntimeHarness();
    // Two tool calls waiting on two different approvals: answering one must not
    // repaint the other, which is still waiting (or it looks decided and the
    // user stops looking for the button that is still there).
    const statuses = ["tc-m1-0", "tc-m1-1"].map((id) => {
      const card = harness.getElement(id);
      card.className = "tool-call";
      const status = new FakeElement();
      status.className = "tool-status";
      card.appendChild(status);
      return status;
    });

    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a1", messageId: "m1", toolCallIdx: 0, summary: "run the tests" });
    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a2", messageId: "m1", toolCallIdx: 1, summary: "push the branch" });

    expect(statuses[0].textContent).toContain("Approval Required");
    expect(statuses[1].textContent).toContain("Approval Required");

    harness.dispatchMessage({ type: "approvalResolved", approvalId: "a1", decision: "allow" });

    expect(statuses[0].textContent).toContain("running");
    expect(statuses[1].textContent).toContain("Approval Required");
  });

  it("does not offer the same approval twice when it is announced again", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a1", messageId: "m1", summary: "run the tests" });
    harness.dispatchMessage({ type: "approvalRequired", approvalId: "a1", messageId: "m1", summary: "run the tests" });

    expect(harness.approvalItemIds()).toEqual(["a1"]);
  });

  it("keeps the panel reachable for a session that will never see the original event", () => {
    const harness = createRuntimeHarness();

    // The message renderer asks for the panel by state (window.__wvApproval) so
    // a rebuilt conversation offers the same buttons the event originally did.
    expect(harness.windowApi("__wvApproval" ).show).toBeTypeOf("function");
    expect(harness.windowApi("__wvApproval").remove).toBeTypeOf("function");
  });

  it("routes mode dropdown selections through /mode with the canonical value", () => {
    const harness = createRuntimeHarness();
    const toolbar = harness.getElement("toolbar");

    const item = new FakeElement();
    item.classList.add("dropdown-item");
    item.setAttribute("data-value", "operate");
    const menu = new FakeElement();
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "mode");
    menu.parentElement = wrapper;
    item.parentElement = menu;

    toolbar.dispatch("click", { target: item, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({
      type: "slashCommand",
      command: "/mode",
      args: "operate",
    });
  });
});
