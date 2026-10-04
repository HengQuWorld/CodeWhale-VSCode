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
  /** What a toolbar button carries while the view hides it. */
  public hidden = false;
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
  /** Labels the handler handed the input module's host-operation hold. */
  const hostOperationCalls: string[] = [];
  let clearPendingCalls = 0;
  /** How many times the handler asked the rail to empty itself. */
  let railClearCalls = 0;
  const composerTextCalls: string[] = [];
  // The streaming flag is the webview's one record of "a turn is running":
  // the input routing reads it and the send/stop button follows it. The
  // stand-in keeps it the way the messages module does, so a test can tell a
  // state that was armed from one that was merely announced.
  let streaming = false;
  const streamingCalls: boolean[] = [];
  // The stall deadline is part of arming a turn (the view must not hold the
  // composer forever for a turn that stopped reporting), so the stand-in
  // records what was set and cleared.
  let streamingTimer: unknown = null;
  const streamingTimers: unknown[] = [];
  const windowListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const taskDetailCalls: unknown[] = [];
  const agentDetailCalls: unknown[] = [];
  const attachmentPreviewCalls: Array<{ id: string; previewUrl: string }> = [];
  const goalCalls: Array<{ method: string; args: unknown[] }> = [];
  const planApproveCalls: string[] = [];
  /** Summary bodies the event handler handed to the messages module. */
  const compactionSummaryCalls: string[] = [];
  const activeThreadCalls: Array<string | null> = [];
  // What the Changes panel was handed: the change list, and the turns it is
  // grouped by. Both are needed — the panel is session-wide.
  const changesStateCalls: Array<{ changes: unknown[]; turns: unknown[] }> = [];

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
      setChangesState: (changes: unknown[], turns: unknown[]) => {
        changesStateCalls.push({ changes, turns });
      },
      renderChanges: () => {},
      setActiveSessionId: () => {},
      setActiveThreadId: (id: unknown) => {
        activeThreadCalls.push((id ?? null) as string | null);
      },
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
      setStreaming: (value: boolean) => {
        streaming = !!value;
        streamingCalls.push(!!value);
      },
      getStreamingTimeout: () => streamingTimer,
      setStreamingTimeout: (value: unknown) => {
        streamingTimer = value;
        streamingTimers.push(value);
      },
      isStreaming: () => streaming,
      setUserScrolledUp: () => {},
      smartScrollToBottom: () => {},
      renderWelcome: () => {},
      createThinkingBlock: () => new FakeElement(),
      updateThinkingBlock: () => {},
      renderPlanApproveButton: (messageId: string) => {
        planApproveCalls.push(messageId);
      },
      clearPendingTurnFork: () => {
        clearPendingCalls += 1;
      },
      renderCompactionSummary: (summary: string) => {
        compactionSummaryCalls.push(summary);
        return '<details>' + summary + '</details>';
      },
      clearNavDots: () => {
        railClearCalls += 1;
      },
    },
    __wvInput: {
      updateSendStopButton: (streaming: boolean) => {
        sendStopCalls.push(streaming);
      },
      setHostOperation: (label: string, hint: string) => {
        hostOperationCalls.push(label + '|' + hint);
      },
      setComposerText: (text: string) => {
        composerTextCalls.push(text);
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

  let timerId = 0;
  // A virtual clock. The stall deadline is five minutes of silence, so a test
  // that has to see it fire — or see it *not* fire — needs to move time and
  // run whatever came due. Ids stay truthy, the way the messages module's own
  // `getStreamingTimeout()` tells an armed deadline from a cleared one.
  let now = 0;
  const pendingTimers = new Map<number, { at: number; fn: () => void }>();
  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    setTimeout: (fn: () => void, delay?: number) => {
      timerId += 1;
      pendingTimers.set(timerId, { at: now + (typeof delay === "number" ? delay : 0), fn });
      return timerId;
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === "number") pendingTimers.delete(id);
    },
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
    /** Move the virtual clock forward and run every deadline that came due,
     *  oldest first, so the stall deadline can be watched firing (or not). */
    advance(ms: number) {
      now += ms;
      const due = [...pendingTimers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        pendingTimers.delete(id);
        timer.fn();
      }
    },
    pendingTimers: () => pendingTimers.size,
    postMessages,
    sendStopCalls,
    hostOperationCalls,
    clearPendingCalls: () => clearPendingCalls,
    railClearCalls: () => railClearCalls,
    composerTextCalls,
    streamingCalls,
    streamingTimers,
    /** What the input router would read if the user pressed Enter now. */
    isStreaming: () => streaming,
    documentListeners,
    taskDetailCalls,
    agentDetailCalls,
    attachmentPreviewCalls,
    goalCalls,
    planApproveCalls,
    compactionSummaryCalls,
    /** Every thread the sidebar was told is on screen, in order. */
    activeThreadCalls,
    changesStateCalls,
  };
}

/** A status-bar dropdown as `scopedDropdownItems()` builds it: the value chip
 *  the status messages update, and the same roster listed twice — this thread's
 *  group first, the "New threads" default second. */
function buildScopedMenu(
  harness: ReturnType<typeof createRuntimeHarness>,
  setting: "mode" | "posture",
  chipId: string,
  values: string[],
) {
  const chip = harness.getElement(chipId);
  // The stand-in matches selectors against `className` and click targets
  // against `classList`, so the chip carries both (the real DOM keeps them in
  // sync).
  chip.className = "setting-value";
  chip.classList.add("setting-value");
  const wrapper = new FakeElement();
  wrapper.setAttribute("data-setting", setting);
  const menu = new FakeElement();
  menu.className = "dropdown-menu";
  const items: FakeElement[] = [];
  for (const scope of ["thread", "default"] as const) {
    for (const value of values) {
      const item = new FakeElement();
      item.className = "dropdown-item";
      item.setAttribute("data-scope", scope);
      item.setAttribute("data-value", value);
      menu.appendChild(item);
      items.push(item);
    }
  }
  wrapper.appendChild(chip);
  wrapper.appendChild(menu);
  return {
    /** Open the menu the way a click on the chip does, which is what marks it. */
    open(): void {
      harness.getElement("toolbar").dispatch("click", { target: chip, stopPropagation: () => {} });
    },
    /** Values marked selected in one scope. */
    selected(scope: "thread" | "default"): string[] {
      return items
        .filter(
          (item) =>
            item.getAttribute("data-scope") === scope &&
            item.classList.contains("selected"),
        )
        .map((item) => item.getAttribute("data-value") || "");
    },
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

  it("moves the mode and permission menus onto the defaults when 新建会话 clears the thread", () => {
    // On screen: a conversation running Plan under Ask, with Operate + Full
    // Access configured as the defaults for the next one.
    const active = createRuntimeHarness();
    active.dispatchMessage({
      type: "ready",
      mode: "plan",
      posture: "ask",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });
    active.dispatchMessage({ type: "scopedDefaults", mode: "operate", posture: "full_access" });
    const activeMode = buildScopedMenu(active, "mode", "current-mode", ["agent", "plan", "operate"]);
    const activePosture = buildScopedMenu(active, "posture", "current-posture", [
      "ask",
      "auto_review",
      "full_access",
    ]);

    activeMode.open();
    activePosture.open();
    expect(activeMode.selected("thread")).toEqual(["plan"]);
    expect(activePosture.selected("thread")).toEqual(["ask"]);
    expect(activeMode.selected("default")).toEqual(["operate"]);
    expect(activePosture.selected("default")).toEqual(["full_access"]);

    // 新建会话 clears the view, then republishes what the next session starts
    // with — the defaults, not what the thread that just ended was running.
    const fresh = createRuntimeHarness();
    fresh.dispatchMessage({
      type: "ready",
      mode: "plan",
      posture: "ask",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });
    fresh.dispatchMessage({ type: "scopedDefaults", mode: "operate", posture: "full_access" });
    const freshMode = buildScopedMenu(fresh, "mode", "current-mode", ["agent", "plan", "operate"]);
    const freshPosture = buildScopedMenu(fresh, "posture", "current-posture", [
      "ask",
      "auto_review",
      "full_access",
    ]);
    fresh.dispatchMessage({ type: "clearChat" });
    fresh.dispatchMessage({
      type: "settingsUpdated",
      mode: "operate",
      posture: "full_access",
      model: "deepseek-v4-pro",
      reasoningEffort: "auto",
    });

    // The chips carry the values the new session will run with...
    expect(fresh.getElement("current-mode").textContent).toBe("Operate");
    expect(fresh.getElement("current-mode").getAttribute("data-value")).toBe("operate");
    expect(fresh.getElement("current-posture").textContent).toBe("Full Access");
    expect(fresh.getElement("current-posture").getAttribute("data-value")).toBe("full_access");

    // ...and so do both groups of both menus: with no thread, the value the
    // next session starts on *is* the default.
    freshMode.open();
    freshPosture.open();
    expect(freshMode.selected("thread")).toEqual(["operate"]);
    expect(freshMode.selected("default")).toEqual(["operate"]);
    expect(freshPosture.selected("thread")).toEqual(["full_access"]);
    expect(freshPosture.selected("default")).toEqual(["full_access"]);
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

  it("keeps a sibling custom route's model list out of the selected one", () => {
    // Both routes report the generic 'custom' id, so the generic id alone
    // cannot tell whose answer this is: a slower answer for the route the user
    // just left must not repaint the model list of the one they selected.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "lm-studio",
      providers: [
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
        },
        {
          id: "custom",
          model_provider_id: "lm-studio",
          display_name: "lm-studio (custom)",
        },
      ],
    });
    harness.getElement("current-model").textContent = "local-model";

    harness.dispatchMessage({
      type: "providerModels",
      provider: "custom",
      providerId: "bigmodel-cn",
      models: ["glm-5.3"],
      currentModel: "glm-5.3",
      hasCatalog: true,
    });
    expect(harness.getElement("current-model").textContent).toBe("local-model");

    harness.dispatchMessage({
      type: "providerModels",
      provider: "custom",
      providerId: "lm-studio",
      models: ["local-model-v2"],
      currentModel: "local-model-v2",
      hasCatalog: true,
    });
    expect(harness.getElement("current-model").textContent).toBe("local-model-v2");
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

  it("offers Continue while a saved session is viewed, and not around a thread", () => {
    // Continue is what makes a browsed session branchable at all (a branch
    // names a turn, and turns belong to a live thread), so it has to appear
    // exactly in the view that needs it.
    const harness = createRuntimeHarness();
    const btn = harness.getElement("btn-continue-session");

    harness.dispatchMessage({ type: "sessionLoaded", sessionId: "sess-1" });
    expect(btn.hidden).toBe(false);

    harness.dispatchMessage({ type: "threadLoaded", threadId: "thr_1" });
    expect(btn.hidden).toBe(true);

    harness.dispatchMessage({ type: "sessionLoaded", sessionId: "sess-2" });
    harness.dispatchMessage({ type: "clearChat" });
    expect(btn.hidden).toBe(true);
  });

  it("shows a host operation as activity, and holds the composer for its duration", () => {
    // Forking, undoing and retrying take seconds and stream nothing: the status
    // bar has to look alive and the composer has to know why it is holding.
    const harness = createRuntimeHarness();

    // The host posts the line and then the hold, the way the provider does.
    harness.dispatchMessage({ type: "status", text: "Branching…" });
    harness.dispatchMessage({
      type: "hostOperation",
      active: true,
      label: "Branching…",
      hint: "This is still being created",
    });

    expect(harness.getElement("status-text").textContent).toBe("Branching…");
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(true);
    // Both travel: the label for the box, the hint for the held button's hover.
    expect(harness.hostOperationCalls).toEqual(["Branching…|This is still being created"]);

    harness.dispatchMessage({ type: "hostOperation", active: false });

    expect(harness.hostOperationCalls).toEqual(["Branching…|This is still being created", "|"]);
    expect(harness.getElement("status").classList.contains("is-streaming")).toBe(false);
    // The row that was clicked stops claiming a wait that is over.
    expect(harness.clearPendingCalls()).toBe(1);
    // Nothing else reported, so the line the operation owned goes back to idle
    // instead of claiming work that is over.
    expect(harness.getElement("status-text").textContent).toBe(makeTr().ready);
  });

  it("does not overwrite a result that replaced the operation's own status line", () => {
    // A fork that lands posts the new thread's line before the operation ends;
    // an error posts its own. Either way the wait's line is already gone and
    // the end of the operation must leave what took its place alone.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "hostOperation", active: true, label: "Branching…" });
    harness.dispatchMessage({ type: "status", text: "Thread thr_2: 4 messages" });

    harness.dispatchMessage({ type: "hostOperation", active: false });

    expect(harness.getElement("status-text").textContent).toBe("Thread thr_2: 4 messages");
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

  it("takes the message rail down with the transcript it mirrors", () => {
    // The rail's dots describe the messages in the container, so a replace of
    // the whole conversation has to empty it: only addMessage() used to touch
    // the rail, and a transcript that is cleared and rebuilt with no messages
    // (a new session, a thread with no turns) never reaches addMessage — the
    // new session kept the previous conversation's dots on an empty rail.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "clearChat" });
    expect(harness.railClearCalls()).toBe(1);

    // A rebuild clears first whether or not it ends up drawing anything: a
    // shorter transcript must not leave dots pointing at messages that are
    // gone.
    harness.dispatchMessage({ type: "loadHistory", messages: [] });
    expect(harness.railClearCalls()).toBe(2);

    harness.dispatchMessage({
      type: "loadHistory",
      messages: [{ id: "m1", role: "user", content: "hi", status: "complete", timestamp: 1 }],
    });
    expect(harness.railClearCalls()).toBe(3);
  });

  it("re-arms the running turn a rebuilt conversation still holds", () => {
    const harness = createRuntimeHarness();

    // The order the host posts for a thread whose last turn is in_progress:
    // the streaming placeholder and `turnStarted` first, then the rebuild.
    // The rebuild resets the streaming state (it replaces the whole
    // conversation), so the last word on whether a turn is running has to
    // come from the transcript it just drew — the trailing streaming bubble.
    harness.dispatchMessage({
      type: "addMessage",
      message: { id: "placeholder", role: "assistant", content: "", status: "streaming" },
    });
    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-running" });
    harness.dispatchMessage({
      type: "loadHistory",
      messages: [
        { id: "u1", role: "user", content: "hi", status: "complete" },
        { id: "placeholder", role: "assistant", content: "", status: "streaming" },
      ],
    });

    // Armed: Enter steers the adopted turn rather than starting one the
    // engine refuses for a busy thread, and the button offers Stop.
    expect(harness.isStreaming()).toBe(true);
    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(true);
    // The reset then the re-arm, in that order: the load really did clear the
    // state the rebuild had to restore.
    expect(harness.streamingCalls.slice(-2)).toEqual([false, true]);
    // Armed with the deadline: an armed turn is never left without one.
    expect(harness.streamingTimers[harness.streamingTimers.length - 1]).toBeTruthy();
  });

  it("gives an adopted turn the same deadline the live path sets", () => {
    const harness = createRuntimeHarness();

    // What `adoptActiveTurn` posts after the engine refuses a send because the
    // thread is busy. Nothing else arms this turn — the placeholder it lands in
    // already existed — so `turnStarted` has to arm it, deadline included, or
    // the composer would offer Send for a turn the engine is running (or hold
    // Stop forever for a turn whose engine went silent).
    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-running" });

    expect(harness.isStreaming()).toBe(true);
    expect(harness.sendStopCalls).toEqual([true]);
    expect(harness.streamingTimers[harness.streamingTimers.length - 1]).toBeTruthy();
  });

  it("keeps a long turn's steering state while the turn is still talking", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-long" });
    expect(harness.isStreaming()).toBe(true);

    // Half an hour of a turn that keeps reporting — a delta every thirty
    // seconds, the shape of a long build or a long-running command. The
    // deadline is a bound on silence, so it never comes due: the composer
    // stays on Stop/steer for the whole turn. With the deadline armed once and
    // never renewed, it fired at five minutes and the view went back to Send
    // (steer button gone) with the turn still running — the conversation read
    // as finished until the user typed into it.
    for (let i = 0; i < 60; i++) {
      harness.dispatchMessage({ type: "updateThinking", messageId: "a1", thinking: "working" });
      harness.advance(30000);
    }

    expect(harness.isStreaming()).toBe(true);
    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(true);
    expect(harness.getElement("status-text").textContent).not.toBe("Ready timed out");
  });

  it("asks the engine about a turn that has gone quiet, and holds it while it waits", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-quiet" });
    harness.dispatchMessage({ type: "updateThinking", messageId: "a1", thinking: "working" });

    // Four minutes and 59.999 seconds after the last word from the engine: the
    // turn is still armed, because silence is what the deadline measures.
    harness.advance(299999);
    expect(harness.isStreaming()).toBe(true);
    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn")).toHaveLength(0);

    harness.advance(2);

    // The deadline came due, and the view does not decide by itself: it asks
    // the engine, through the host, and holds the turn it has meanwhile. A
    // turn's silence is not evidence that it ended.
    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn")).toHaveLength(1);
    expect(harness.isStreaming()).toBe(true);
    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(true);
  });

  it("keeps the turn the engine says is still running", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-quiet" });
    harness.advance(300001);

    // The host's answer to the probe, for a turn the engine still holds:
    // `adoptActiveTurn` posts turnStarted. The view re-arms on it, question and
    // all, so the turn is held for another five minutes of silence — and a
    // delta that arrives in the meantime renews it as usual.
    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-quiet" });
    harness.advance(299999);
    expect(harness.isStreaming()).toBe(true);
    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn")).toHaveLength(1);

    harness.advance(2);
    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn")).toHaveLength(2);
    expect(harness.isStreaming()).toBe(true);
  });

  it("releases the turn the engine says is over", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-quiet" });
    harness.advance(300001);
    expect(harness.isStreaming()).toBe(true);

    // The host's answer for a turn the engine no longer holds: the conversation
    // rebuilt from the engine, which is also what hands the composer back — the
    // same reset a finished turn performs.
    harness.dispatchMessage({
      type: "loadHistory",
      messages: [
        { id: "u1", role: "user", content: "hi", status: "complete" },
        { id: "a1", role: "assistant", content: "done", status: "complete" },
      ],
    });

    expect(harness.isStreaming()).toBe(false);
    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(false);
  });

  it("gives the composer back when the answer never comes", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-unreachable" });
    harness.advance(300001);
    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn")).toHaveLength(1);
    expect(harness.isStreaming()).toBe(true);

    // A host that cannot reach the engine answers nothing, and saying nothing
    // must not hold the composer forever: the grace deadline is where the view
    // decides for itself, with the same give-up status it has always used.
    harness.advance(45001);
    expect(harness.isStreaming()).toBe(false);
    expect(harness.sendStopCalls[harness.sendStopCalls.length - 1]).toBe(false);
    expect(harness.getElement("status-text").textContent).toBe("Ready timed out");
  });

  it("does not let the host's own polling pass for the turn's activity", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-silent" });

    // The periodic task and thread refreshes arrive on the host's timer while
    // it believes a turn is running, and the host's belief is not the turn
    // saying anything: they must not renew the deadline, or the question would
    // never be asked.
    for (let i = 0; i < 10; i++) {
      harness.dispatchMessage({ type: "taskList", tasks: [] });
      harness.advance(60000);
    }

    expect(harness.postMessages.filter((m) => m.type === "probeActiveTurn").length).toBeGreaterThan(0);
  });

  it("leaves a rebuilt conversation that finished not streaming", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "loadHistory",
      messages: [
        { id: "u1", role: "user", content: "hi", status: "complete" },
        { id: "a1", role: "assistant", content: "done", status: "complete" },
      ],
    });

    expect(harness.isStreaming()).toBe(false);
    expect(harness.sendStopCalls).toEqual([false]);
  });

  it("keeps the Stop button on a running turn when a status message repaints", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "turnStarted", turnId: "turn-running" });
    // `ready` and `settingsUpdated` arrive right after a load and only say
    // what the status line reads; neither may hand the composer back to Send
    // while the turn they describe is still running.
    harness.dispatchMessage({ type: "ready", model: "deepseek-v4-pro" });
    harness.dispatchMessage({ type: "settingsUpdated", model: "deepseek-v4-pro" });

    expect(harness.isStreaming()).toBe(true);
    // One call per repaint, each asking for the flag's value: Stop, three times.
    expect(harness.sendStopCalls).toEqual([true, true, true]);
  });

  it("routes a restored composer prompt through the input module", () => {
    const harness = createRuntimeHarness();

    // `setInputText` is how a refused send (and a retried turn) hands the text
    // back. The input module's writer is the only place that refreshes what
    // depends on the box's text — the steer button reads it — and the text
    // lands exactly when the turn is adopted, so it has to be sendable.
    harness.dispatchMessage({ type: "setInputText", text: "carry on then" });

    expect(harness.composerTextCalls).toEqual(["carry on then"]);
    expect(harness.getElement("input").focusCount).toBe(1);
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

  it("routes the dropdown's default group to the startup defaults, not the thread", () => {
    const harness = createRuntimeHarness();
    const toolbar = harness.getElement("toolbar");

    const modeItem = new FakeElement();
    modeItem.classList.add("dropdown-item");
    modeItem.setAttribute("data-scope", "default");
    modeItem.setAttribute("data-value", "operate");
    const modeMenu = new FakeElement();
    const modeWrapper = new FakeElement();
    modeWrapper.setAttribute("data-setting", "mode");
    modeMenu.parentElement = modeWrapper;
    modeItem.parentElement = modeMenu;

    const postureItem = new FakeElement();
    postureItem.classList.add("dropdown-item");
    postureItem.setAttribute("data-scope", "default");
    postureItem.setAttribute("data-value", "auto_review");
    const postureMenu = new FakeElement();
    const postureWrapper = new FakeElement();
    postureWrapper.setAttribute("data-setting", "posture");
    postureMenu.parentElement = postureWrapper;
    postureItem.parentElement = postureMenu;

    toolbar.dispatch("click", { target: modeItem, stopPropagation: () => {} });
    toolbar.dispatch("click", { target: postureItem, stopPropagation: () => {} });

    expect(harness.postMessages).toContainEqual({ type: "setDefaultMode", mode: "operate" });
    expect(harness.postMessages).toContainEqual({
      type: "setDefaultPosture",
      posture: "auto_review",
    });
    // The upper group is the one that patches the thread; this click must not
    // reach it, or the two scopes would be the same control again.
    expect(
      harness.postMessages.some(
        (msg: any) => msg.type === "slashCommand" || msg.type === "setPosture",
      ),
    ).toBe(false);
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

  it("stops holding a thread as the one on screen when a saved session is opened", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "sessionLoaded", sessionId: "s1" });

    // Both the rail's "needs you" grouping and the toolbar chip hide the thread
    // they believe is on screen. A viewed session holds no thread, so keeping
    // the last one named silently hides that thread's pending requests from
    // both — the chip would count nothing while a thread waits.
    expect(harness.activeThreadCalls).toEqual([null]);
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

  it("lists a named custom route and marks only the one that is selected", () => {
    // A user-defined [providers.<name>] route reports the generic 'custom' id
    // with its own name in model_provider_id, so the dropdown shows two
    // entries that differ only by that field. Marking by the id alone would
    // tick both of them, and asking for the model list without the exact id
    // would answer for the wrong route.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      providers: [
        {
          id: "deepseek",
          model_provider_id: "deepseek",
          display_name: "DeepSeek",
          default_model: "deepseek-v4-pro",
          has_model_catalog: true,
        },
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
        },
        {
          id: "custom",
          model_provider_id: "lm-studio",
          display_name: "lm-studio (custom)",
          default_model: "local-model",
          has_model_catalog: false,
        },
      ],
    });

    const items = harness.getElement("dropdown-provider").children;
    expect(items.map((item) => item.getAttribute("data-value"))).toEqual([
      "deepseek",
      "custom",
      "custom",
    ]);
    expect(items.map((item) => item.getAttribute("data-model-provider-id"))).toEqual([
      "deepseek",
      "bigmodel-cn",
      "lm-studio",
    ]);
    expect(items.map((item) => item.textContent)).toEqual([
      "DeepSeek",
      "bigmodel-cn (custom) \u2713",
      "lm-studio (custom)",
    ]);

    const chip = harness.getElement("current-provider");
    expect(chip.textContent).toBe("bigmodel-cn (custom)");
    expect(chip.getAttribute("data-provider-id")).toBe("custom");
    expect(chip.getAttribute("data-model-provider-id")).toBe("bigmodel-cn");

    // The catalog request carries the pair the runtime addresses the route by.
    expect(harness.postMessages).toContainEqual({
      type: "requestProviderModels",
      provider: "custom",
      providerId: "bigmodel-cn",
    });
  });

  it("switches to a named custom route with the exact id the backend addresses it by", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "deepseek",
      currentProviderId: "deepseek",
      providers: [
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
        },
      ],
    });

    const item = harness.getElement("dropdown-provider").children[0];
    // The stand-in matches click targets against `classList`, the way it does
    // for the setting chips.
    item.classList.add("dropdown-item");
    const wrapper = new FakeElement();
    wrapper.setAttribute("data-setting", "provider");
    const menu = harness.getElement("dropdown-provider");
    wrapper.appendChild(menu);

    harness.getElement("settings-bar").dispatch("click", {
      target: item,
      stopPropagation: () => {},
    });

    expect(harness.postMessages).toContainEqual({
      type: "switchProvider",
      provider: "custom",
      providerId: "bigmodel-cn",
    });
  });

  it("tells the two DeepSeek routes apart and drops the one with no key", () => {
    // The Runtime publishes both the DeepSeek route and the legacy Anthropic
    // dialect route, both named "DeepSeek", with separate credential slots —
    // and only one of them holds the user's key. Rendering the display name
    // alone made them indistinguishable, so picking "DeepSeek" could land on
    // the route whose credential slot is empty and fail the first message.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      providers: [
        {
          id: "deepseek",
          model_provider_id: null,
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "configured",
        },
        {
          id: "deepseek-anthropic",
          model_provider_id: "deepseek-anthropic",
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "missing",
        },
        {
          id: "openrouter",
          model_provider_id: null,
          display_name: "OpenRouter",
          default_model: "deepseek/deepseek-v4-pro",
          has_model_catalog: true,
          credentialState: "missing",
        },
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
          credentialState: "configured",
        },
      ],
    });

    const items = harness.getElement("dropdown-provider").children;
    expect(items.map((item) => item.getAttribute("data-value"))).toEqual(["deepseek", "custom"]);
    // The route id is spelled out even though this row is not the active one:
    // the name it shares with a hidden row is what makes it ambiguous.
    expect(items.map((item) => item.textContent)).toEqual([
      "DeepSeek (deepseek)",
      "bigmodel-cn (custom) \u2713",
    ]);
  });

  it("keeps the active route listed when it has no key, labelled with its state", () => {
    // Hiding the route the chip names would leave the picker unable to say
    // where the user is — and the label is the one place that says why its
    // next message will fail.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "deepseek-anthropic",
      currentProviderId: "deepseek-anthropic",
      providers: [
        {
          id: "deepseek",
          model_provider_id: null,
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "configured",
        },
        {
          id: "deepseek-anthropic",
          model_provider_id: "deepseek-anthropic",
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "missing",
        },
      ],
    });

    const items = harness.getElement("dropdown-provider").children;
    expect(items.map((item) => item.textContent)).toEqual([
      "DeepSeek (deepseek)",
      "DeepSeek (deepseek-anthropic) · no key configured \u2713",
    ]);

    const chip = harness.getElement("current-provider");
    expect(chip.textContent).toBe("DeepSeek (deepseek-anthropic) · no key configured");
  });

  it("offers a route that only needs a login, since the picker is where it is reached", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "deepseek",
      currentProviderId: "deepseek",
      providers: [
        {
          id: "deepseek",
          model_provider_id: "deepseek",
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "configured",
        },
        {
          id: "openai-codex",
          model_provider_id: null,
          display_name: "OpenAI Codex",
          default_model: "gpt-5-codex",
          has_model_catalog: true,
          credentialState: "login_required",
        },
      ],
    });

    const labels = harness
      .getElement("dropdown-provider")
      .children.map((item) => item.textContent);
    expect(labels).toContain("OpenAI Codex · needs login");
  });

  it("describes the open conversation's route and lists that route's models", () => {
    // A conversation keeps the provider it was created on, so once the picker
    // has moved on, the chip and the model list must describe where the next
    // message actually goes — otherwise the picker's provider's models are the
    // ones offered, and choosing one produces the pair the provider rejects.
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "providersUpdated",
      current: "deepseek",
      currentProviderId: "deepseek",
      viewProvider: "custom",
      viewProviderId: "bigmodel-cn",
      providers: [
        {
          id: "deepseek",
          model_provider_id: "deepseek",
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "configured",
        },
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
          credentialState: "configured",
        },
      ],
    });

    // The list is requested for the conversation's route...
    expect(harness.postMessages).toContainEqual({
      type: "requestProviderModels",
      provider: "custom",
      providerId: "bigmodel-cn",
    });

    // ...the chip names that route and says why it is not the one just picked...
    const chip = harness.getElement("current-provider");
    expect(chip.textContent).toBe("bigmodel-cn (custom) \u00b7 this conversation");
    expect(chip.getAttribute("data-provider-id")).toBe("custom");
    expect(chip.getAttribute("data-model-provider-id")).toBe("bigmodel-cn");

    // ...and the dropdown still marks where new conversations will start.
    const items = harness.getElement("dropdown-provider").children;
    expect(items.map((item) => item.textContent)).toEqual([
      "DeepSeek \u2713",
      "bigmodel-cn (custom)",
    ]);
  });

  it("keeps the marker off while the conversation and the picker are on one route", () => {
    const harness = createRuntimeHarness();
    const providers = [
      {
        id: "custom",
        model_provider_id: "bigmodel-cn",
        display_name: "bigmodel-cn (custom)",
        default_model: "glm-5.3",
        has_model_catalog: true,
        credentialState: "configured",
      },
    ];

    // Same route on both sides: there is nothing to explain...
    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      viewProvider: "custom",
      viewProviderId: "bigmodel-cn",
      providers,
    });
    expect(harness.getElement("current-provider").textContent).toBe("bigmodel-cn (custom)");

    // ...and it stays off once 新建会话 leaves the view with no conversation.
    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      providers,
    });
    expect(harness.getElement("current-provider").textContent).toBe("bigmodel-cn (custom)");
  });

  it("asks about moving the conversation in the panel, naming what it costs", () => {
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      viewProvider: "custom",
      viewProviderId: "bigmodel-cn",
      providers: [
        {
          id: "deepseek",
          model_provider_id: "deepseek",
          display_name: "DeepSeek",
          default_model: "deepseek-flash",
          has_model_catalog: true,
          credentialState: "configured",
        },
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
          credentialState: "configured",
        },
      ],
    });

    harness.dispatchMessage({
      type: "routeMovePrompt",
      provider: "deepseek",
      providerId: "deepseek",
      from: "custom",
      fromProviderId: "bigmodel-cn",
      model: "deepseek-flash",
    });

    expect(harness.getElement("route-move-overlay").classList.contains("open")).toBe(true);
    const body = harness.getElement("route-move-body").textContent;
    // Both routes by the names the picker uses, and the model it lands on.
    expect(body).toContain("bigmodel-cn (custom)");
    expect(body).toContain("DeepSeek");
    expect(body).toContain("deepseek-flash");
    // The price is the sentence that has to be there, not a hint of one.
    expect(body).toContain("cached as a prefix");
    expect(body).toContain("in full");
    // Every token is filled, the repeat of the route at the end of the
    // sentence included: `replace` takes only the first, which is how "{from}"
    // and "{to}" ended up bare on screen.
    expect(body).not.toContain("{");
    expect(body.match(/bigmodel-cn \(custom\)/g)).toHaveLength(2);
    // Nothing is answered until the user does.
    expect(harness.postMessages.filter((m) => m.type === "routeMoveAnswer")).toEqual([]);
  });

  it("answers the route question from either button, and closes behind it", () => {
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "routeMovePrompt",
      provider: "deepseek",
      providerId: "deepseek",
      from: "custom",
      fromProviderId: "bigmodel-cn",
      model: "deepseek-flash",
    });

    harness.getElement("route-move-confirm").dispatch("click", {});
    expect(harness.postMessages).toContainEqual({ type: "routeMoveAnswer", accept: true });
    expect(harness.getElement("route-move-overlay").classList.contains("open")).toBe(false);

    // A question that has been answered is not answered again by the next
    // click — the dialog is gone, and so is what it was asking.
    const answered = harness.postMessages.length;
    harness.getElement("route-move-confirm").dispatch("click", {});
    expect(harness.postMessages.length).toBe(answered);

    harness.dispatchMessage({
      type: "routeMovePrompt",
      provider: "deepseek",
      providerId: "deepseek",
      from: "custom",
      fromProviderId: "bigmodel-cn",
      model: "deepseek-flash",
    });
    harness.getElement("route-move-cancel").dispatch("click", {});
    expect(harness.postMessages).toContainEqual({ type: "routeMoveAnswer", accept: false });
  });

  it("asks the same question, with its own words, for a model switch", () => {
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
      viewProvider: "custom",
      viewProviderId: "bigmodel-cn",
      providers: [
        {
          id: "custom",
          model_provider_id: "bigmodel-cn",
          display_name: "bigmodel-cn (custom)",
          default_model: "glm-5.3",
          has_model_catalog: true,
          credentialState: "configured",
        },
      ],
    });

    harness.dispatchMessage({
      type: "routeMovePrompt",
      kind: "model",
      provider: "custom",
      providerId: "bigmodel-cn",
      fromModel: "glm-5.3",
      model: "glm-5.4",
    });

    expect(harness.getElement("route-move-overlay").classList.contains("open")).toBe(true);
    // The question is about the model, and says so on the button that acts.
    expect(harness.getElement("route-move-title").textContent).toBe(
      "Switch this conversation's model?"
    );
    expect(harness.getElement("route-move-confirm").textContent).toBe("Switch the model");
    const body = harness.getElement("route-move-body").textContent;
    // Both models and the route by the name the picker uses — and no token is
    // left unfilled, {fromModel} included.
    expect(body).toContain("glm-5.3");
    expect(body).toContain("glm-5.4");
    expect(body).toContain("bigmodel-cn (custom)");
    expect(body).not.toContain("{");
    expect(body).toContain("belongs to one model");

    harness.getElement("route-move-confirm").dispatch("click", {});
    expect(harness.postMessages).toContainEqual({ type: "routeMoveAnswer", accept: true });
  });

  it("re-uses one dialog for both questions, so the second wears the second words", () => {
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "routeMovePrompt",
      provider: "deepseek",
      providerId: "deepseek",
      from: "custom",
      fromProviderId: "bigmodel-cn",
      model: "deepseek-flash",
    });
    harness.getElement("route-move-cancel").dispatch("click", {});

    harness.dispatchMessage({
      type: "routeMovePrompt",
      kind: "model",
      provider: "custom",
      providerId: "bigmodel-cn",
      fromModel: "glm-5.3",
      model: "glm-5.4",
    });

    // No stale route text, no stale button label.
    expect(harness.getElement("route-move-title").textContent).toBe(
      "Switch this conversation's model?"
    );
    expect(harness.getElement("route-move-body").textContent).not.toContain("Moving it to");
  });

  it("treats Esc, and a click on the dimmed area, as no", () => {
    const harness = createRuntimeHarness();
    const prompt = {
      type: "routeMovePrompt",
      provider: "deepseek",
      providerId: "deepseek",
      from: "custom",
      fromProviderId: "bigmodel-cn",
      model: "deepseek-flash",
    };

    harness.dispatchMessage(prompt);
    const overlay = harness.getElement("route-move-overlay");
    overlay.dispatch("click", { target: overlay });
    expect(harness.postMessages).toContainEqual({ type: "routeMoveAnswer", accept: false });

    // Esc is the same answer, and the dialog owns it while it is up.
    harness.dispatchMessage(prompt);
    const keydown = harness.documentListeners.get("keydown");
    expect(keydown).toBeTruthy();
    let prevented = false;
    keydown!({ key: "Escape", preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(harness.getElement("route-move-overlay").classList.contains("open")).toBe(false);
    expect(harness.postMessages.filter((m) => m.type === "routeMoveAnswer")).toEqual([
      { type: "routeMoveAnswer", accept: false },
      { type: "routeMoveAnswer", accept: false },
    ]);
  });
});

describe("Changes panel state routing", () => {
  it("hands the panel the turns as well as the changes", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "changesState",
      changes: [{ filePath: "src/a.ts", changeType: "modified", turnIndex: 2 }],
      turns: [{ index: 2, label: "second prompt" }],
    });

    expect(harness.changesStateCalls).toEqual([
      {
        changes: [{ filePath: "src/a.ts", changeType: "modified", turnIndex: 2 }],
        turns: [{ index: 2, label: "second prompt" }],
      },
    ]);
  });

  it("clears the grouping when a host publishes changes without turns", () => {
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "changesState",
      changes: [{ filePath: "src/a.ts", changeType: "modified", turnIndex: 1 }],
      turns: [{ index: 1, label: "first prompt" }],
    });

    // An older host, or a reset: no turns named. The previous session's
    // grouping must not stand over a list that no longer has groups.
    harness.dispatchMessage({
      type: "changesState",
      changes: [{ filePath: "src/a.ts", changeType: "modified" }],
    });

    expect(harness.changesStateCalls[1]).toEqual({
      changes: [{ filePath: "src/a.ts", changeType: "modified" }],
      turns: [],
    });
  });
});

describe("webview-js-event-handler runtime: compaction activity", () => {
  it("lights the status bar's activity dot for a pass that produces no output", () => {
    const harness = createRuntimeHarness();
    const status = harness.getElement("status");

    harness.dispatchMessage({ type: "busy", active: true });

    expect(status.classList.contains("is-streaming")).toBe(true);
    // Deliberately not the messages-streaming flag: that would arm the stall
    // deadline, and the composer would offer a Stop button for a pass it
    // cannot stop.
    expect(harness.isStreaming()).toBe(false);
    expect(harness.streamingCalls).toEqual([]);
    expect(harness.streamingTimers).toEqual([]);
    expect(harness.sendStopCalls.every((value) => value === false)).toBe(true);

    harness.dispatchMessage({ type: "busy", active: false });

    expect(status.classList.contains("is-streaming")).toBe(false);
  });

  it("hangs an info message's compaction summary off the same line", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({
      type: "info",
      message: "Compaction complete: 96 → 9 messages",
      compactionSummary: "The user asked for X.",
    });

    // The result line says what the pass did; the body says what the
    // conversation became. Both land on one note.
    expect(harness.compactionSummaryCalls).toEqual(["The user asked for X."]);
  });

  it("asks for no summary block on an info message that carries none", () => {
    const harness = createRuntimeHarness();

    harness.dispatchMessage({ type: "info", message: "Saved." });

    expect(harness.compactionSummaryCalls).toEqual([]);
  });
});

describe("webview-js-event-handler runtime: a turn's failure", () => {
  it("draws the host's error as a banner and hands the composer back", () => {
    // The host posts this message when a turn ends failed — a provider
    // refusal, a dead network. It is the other half of that report: the host
    // has to post it and the webview has to draw it, and only a run of this
    // script after the message shows the second.
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "addMessage",
      message: { id: "a1", role: "assistant", content: "", status: "streaming" },
    });
    expect(harness.isStreaming()).toBe(true);

    harness.dispatchMessage({
      type: "error",
      message: "You've reached your usage limit for this billing cycle",
    });

    const messages = harness.getElement("messages");
    const banner = messages.children[messages.children.length - 1];
    expect(banner.className).toBe("error-banner");
    expect(banner.innerHTML).toContain("You've reached your usage limit for this billing cycle");
    // The turn is over: the composer cannot be left offering Stop for a turn
    // this message just ended, or the next prompt would steer instead of send.
    expect(harness.isStreaming()).toBe(false);
    expect(harness.streamingTimers).toContain(null);
  });

  it("leaves a running turn running when the error is not the turn's", () => {
    // A goal error says so on its own: the turn it did not come from may still
    // be running, and clearing the flag would report it as finished.
    const harness = createRuntimeHarness();
    harness.dispatchMessage({
      type: "addMessage",
      message: { id: "a1", role: "assistant", content: "", status: "streaming" },
    });

    harness.dispatchMessage({ type: "error", message: "Goal save failed", keepStreaming: true });

    expect(harness.isStreaming()).toBe(true);
  });
});
