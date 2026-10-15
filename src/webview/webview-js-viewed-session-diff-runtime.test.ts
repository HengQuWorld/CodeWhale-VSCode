/**
 * A viewed session's Diff action, end to end.
 *
 * Opening a session from the Sessions rail runs one host method
 * (`loadSessionMessages`) whose messages are turned into rows by the sidebar
 * module and into clicks by the event handler. Neither half can see the other,
 * and the webview's shared diff store sits between them: a change row keys its
 * Diff action into that store, and the store is emptied whenever the
 * conversation is rebuilt. Publishing the panel *before* the rebuild therefore
 * left every row holding a key whose entry was already gone, so a Diff click
 * arrived with no diff and the host opened the file instead — the Open action
 * under a Diff label, for every session loaded from the rail.
 *
 * The seam is the test: the host's own message list is replayed, in order,
 * through the real modules, and the click is dispatched on the row the panel
 * actually drew.
 */
import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: { executeCommand: vi.fn() },
  window: {},
  env: { language: "en" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: { Global: "global" },
}));

import * as vscode from "vscode";
import { ChatProvider } from "../chat-provider";
import { getUtilitiesScript } from "./webview-js-utilities";
import { getSidebarScript } from "./webview-js-sidebar";
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
    const next = force === undefined ? !this.values.has(name) : force;
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

/** The selector subset the panel's own markup needs: class names, optionally
 *  narrowed by trailing attribute tests, in a comma-separated list. */
function matchesSelector(element: FakeElement, selector?: string): boolean {
  if (!selector) return false;
  const attributes = /\[([^\]="[\]]+)="([^"]*)"\]/g;
  return selector.split(",").some((raw) => {
    const part = raw.trim();
    const wanted: Array<[string, string]> = [];
    for (const match of part.matchAll(attributes)) wanted.push([match[1], match[2]]);
    const classes = part
      .replace(attributes, "")
      .replace(/^\./, "")
      .split(".")
      .filter(Boolean);
    if (classes.length === 0 && wanted.length === 0) return false;
    const elementClasses = element.className.split(/\s+/).filter(Boolean);
    if (!classes.every((name) => elementClasses.includes(name))) return false;
    return wanted.every(([name, value]) => element.getAttribute(name) === value);
  });
}

class FakeElement {
  public className = "";
  public classList = new FakeClassList();
  public textContent = "";
  public title = "";
  public style: Record<string, string> = {};
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  public type = "";
  public checked = false;
  public value = "";
  public hidden = false;
  public scrollTop = 0;
  public scrollHeight = 0;
  public clientHeight = 0;
  private html = "";
  private listeners = new Map<string, (event: unknown) => void>();
  private attributes = new Map<string, string>();

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.html = value;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  insertBefore(child: FakeElement): void {
    this.children.unshift(child);
    child.parentElement = this;
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, handler);
  }

  public onclick: ((event: unknown) => void) | null = null;
  public onmousedown: ((event: unknown) => void) | null = null;
  public onmouseup: ((event: unknown) => void) | null = null;
  public onkeydown: ((event: unknown) => void) | null = null;

  dispatch(name: string, event: unknown = {}): void {
    this.listeners.get(name)?.(event);
    const property = (this as any)["on" + name];
    if (typeof property === "function") property(event);
  }

  appendChild(child: FakeElement): FakeElement {
    this.detach(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  remove(): void {
    if (this.parentElement) this.parentElement.detach(this);
    this.parentElement = null;
  }

  focus(): void {}
  scrollIntoView(): void {}
  setSelectionRange(): void {}

  querySelectorAll(selector?: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (parent: FakeElement): void => {
      for (const child of parent.children) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector?: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private detach(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
  }
}

/** The modules a message travels through: the utilities, the sidebar (it draws
 *  the changes panel), and the event handler (it routes the messages). The
 *  others own panels this test does not touch and are stubbed. */
function createWebview() {
  const elements = new Map<string, FakeElement>();
  const getEl = (id: string): FakeElement => {
    let element = elements.get(id);
    if (!element) {
      element = new FakeElement();
      elements.set(id, element);
    }
    return element;
  };
  const postMessages: Array<Record<string, unknown>> = [];
  const windowListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const storageValues = new Map<string, string>();
  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (value: unknown) => String(value ?? ""),
    __wvFormatRelativeTime: () => "now",
    __wvFormatLoadedThread: () => "",
    __wvVscode: {
      postMessage: (msg: Record<string, unknown>) => postMessages.push(msg),
    },
    // The diff store the change rows key their Diff action by, shared with the
    // message cards — a real Map, because whether an entry survives the rebuild
    // is the whole question here.
    __wvDiffStore: new Map<string, string>(),
    __wvDiffIdCounter: { value: 0 },
    __wvApiCapabilities: {},
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
      renderPlanApproveButton: () => {},
      clearPendingTurnFork: () => {},
      renderCompactionSummary: () => "",
      clearNavDots: () => {},
    },
    __wvInput: {
      updateSendStopButton: () => {},
      setHostOperation: () => {},
      setComposerText: () => {},
      applyApiCapabilities: () => {},
      setCurrentAttachments: () => {},
      renderAttachments: () => {},
      setAttachmentPreview: () => {},
    },
    __wvGoal: {
      applyState: () => {},
      reset: () => {},
      setGoal: () => {},
      setBackgroundGoals: () => {},
      setEditing: () => {},
      renderGoal: () => {},
    },
    localStorage: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageValues.delete(key);
      },
    },
    addEventListener: (name: string, handler: (event: any) => void) => {
      windowListeners.set(name, handler);
    },
  };
  const documentObj = {
    getElementById: (id: string) => getEl(id),
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => {
      const node = new FakeElement();
      node.textContent = text;
      return node;
    },
    querySelectorAll: () => [] as FakeElement[],
    addEventListener: (name: string, handler: (event: any) => void) => {
      documentListeners.set(name, handler);
    },
  };
  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  });
  // Same order as the template's script block: utilities, sidebar, messages,
  // input, then the handler that routes to all of them. Only the modules this
  // seam needs are run for real.
  vm.runInContext(getUtilitiesScript(makeTr()), context);
  windowObj.__wvEscapeHtml = (value: unknown) => String(value ?? "");
  windowObj.__wvI18n = makeTr();
  windowObj.__wvFormatRelativeTime = () => "now";
  windowObj.__wvFormatLoadedThread = () => "";
  vm.runInContext(getSidebarScript(makeTr()), context);
  vm.runInContext(getEventHandlerScript(makeTr()), context);
  return {
    getEl,
    postMessages,
    dispatchMessage(msg: Record<string, unknown>) {
      const handler = windowListeners.get("message");
      if (!handler) throw new Error("the event handler registered no message listener");
      handler({ data: msg });
    },
  };
}

/** The buttons `renderChanges` actually wrote, class by class, for the same
 *  reason the sidebar's own suite reads them out of the markup: hand-building
 *  one would test the click against a row the panel never draws. */
function buttonsIn(renderedHtml: string, className: string): FakeElement[] {
  const tags = renderedHtml.match(new RegExp(`<button[^>]*${className}[^>]*>`, "g")) ?? [];
  return tags.map((tag) => {
    const button = new FakeElement();
    button.classList.add(className);
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      button.setAttribute(name, value);
    }
    return button;
  });
}

/** One session whose only turn edited a file through the `edit` tool — the
 *  shape a saved session keeps, with no `file.mutation` receipt. */
function viewedSessionWithOneEdit(workspace: string) {
  return {
    metadata: { id: "sess-view", title: "edit replay", total_tokens: 10, workspace },
    messages: [
      { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-edit-1",
            name: "edit",
            input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-edit-1",
            content: "Successfully replaced 1 block(s) in src/app.ts.",
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  };
}

describe("a viewed session's Changes panel", () => {
  it("carries the diff its row was drawn with into the Diff click", async () => {
    const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), "bw-viewed-diff-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const api = {
        bindEngine: vi.fn(),
        getSession: vi.fn(async () => viewedSessionWithOneEdit(dir)),
        getThreadDetail: vi.fn(async () => viewedSessionWithOneEdit(dir)),
        listSnapshots: vi.fn(async () => []),
        ensureReady: vi.fn(async () => undefined),
        listProviderModels: vi.fn(async () => ({ provider: "custom", models: [] })),
      };
      const provider = new ChatProvider({} as never, {} as never, api as never);
      const posted: Record<string, any>[] = [];
      provider.postMessage = (message: unknown) => {
        posted.push(message as Record<string, any>);
      };

      await provider.loadSessionMessages("sess-view");

      // The rebuild clears the webview's diff store, so the panel that keys into
      // it has to be published after it. Named here because the diff assertion
      // below fails far from the cause when this order is the thing that broke.
      const order = posted.map((message) => message.type);
      expect(order.indexOf("loadHistory")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("changesState")).toBeGreaterThan(order.indexOf("loadHistory"));

      const webview = createWebview();
      for (const message of posted) webview.dispatchMessage(message);

      // The panel's second child is the list; one turn group holds one row.
      const panel = webview.getEl("tab-changes");
      const list = panel.children[1] as FakeElement;
      const items = (list.children[0] as FakeElement).children[1] as FakeElement;

      const diffs = buttonsIn(items.innerHTML, "change-view-diff");
      expect(diffs).toHaveLength(1);
      list.dispatch("click", { target: diffs[0] });

      const opened = webview.postMessages.filter((message) => message.type === "openDiff");
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ filePath: "src/app.ts", changeIndex: 0 });
      // The point of the test: a Diff click has to arrive at the host as a diff,
      // not as a bare path the host can only open.
      expect(opened[0].diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(opened[0].diff).toContain("+TWO");

      // Open stays Open: the two actions on the row must not converge.
      const openers = buttonsIn(items.innerHTML, "change-open-file");
      expect(openers).toHaveLength(1);
      list.dispatch("click", { target: openers[0] });
      expect(
        webview.postMessages.filter((message) => message.type === "openFile"),
      ).toEqual([{ type: "openFile", filePath: "src/app.ts" }]);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
