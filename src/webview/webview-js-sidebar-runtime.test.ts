/**
 * Runtime tests for the thread rail's fetch status.
 *
 * The rail is driven by `GET /v1/threads/summary`, which costs roughly a
 * quarter-second per thread on the runtime, so "still loading" and "you have no
 * threads" used to look identical — an empty rail. These tests drive the real
 * IIFE in a DOM stand-in: an empty rail says it is loading, a failed fetch says
 * so and offers a retry, and a published list replaces both.
 *
 * Executing the whole IIFE is deliberate. A runtime error anywhere in the
 * webview script block stops the entire block (see AGENTS.md), so a passing run
 * here is also the guard that this module still initialises at all.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { getSidebarScript } from "./webview-js-sidebar";
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

/** `.a.b` or a comma-separated list of those; anything else answers nothing. */
function matchesSelector(element: FakeElement, selector?: string): boolean {
  if (!selector) return false;
  return selector.split(",").some((part) => {
    const classes = part.trim().replace(/^\./, "").split(".").filter(Boolean);
    if (classes.length === 0) return false;
    const elementClasses = element.className.split(/\s+/).filter(Boolean);
    return classes.every((name) => elementClasses.includes(name));
  });
}

class FakeElement {
  public className = "";
  public classList = new FakeClassList();
  public textContent = "";
  public style: Record<string, string> = {};
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  public type = "";
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

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, handler);
  }

  dispatch(name: string, event: unknown = {}): void {
    this.listeners.get(name)?.(event);
  }

  appendChild(child: FakeElement): void {
    this.detach(child);
    child.parentElement = this;
    this.children.push(child);
  }

  remove(): void {
    if (this.parentElement) this.parentElement.detach(this);
    this.parentElement = null;
  }

  querySelectorAll(selector?: string): FakeElement[] {
    return this.children.filter((child) => matchesSelector(child, selector));
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

function createHarness() {
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
  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (value: unknown) => String(value ?? ""),
    __wvFormatRelativeTime: () => "now",
    __wvVscode: { postMessage: (msg: Record<string, unknown>) => postMessages.push(msg) },
    addEventListener: () => {},
  };
  const documentObj = {
    getElementById: (id: string) => getEl(id),
    createElement: () => new FakeElement(),
    querySelectorAll: () => [] as FakeElement[],
    addEventListener: () => {},
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  });
  vm.runInContext(getSidebarScript(makeTr()), context);

  const rail = getEl("tab-threads-list");
  return {
    rail,
    postMessages,
    sidebar: windowObj.__wvSidebar as Record<string, any>,
  };
}

/** Rows the rail currently holds, in order. */
function railChildren(rail: FakeElement): FakeElement[] {
  return rail.children;
}

function rowsMatching(rail: FakeElement, prefix: string): FakeElement[] {
  return railChildren(rail).filter((c) => c.className.startsWith(prefix));
}

function threadSummary(id: string) {
  return {
    id,
    title: `Thread ${id}`,
    preview: "",
    model: "deepseek-v4-pro",
    mode: "agent",
    archived: false,
    updated_at: "2026-09-17T00:00:00Z",
    latest_turn_id: null,
    latest_turn_status: null,
    pending_attention_count: 0,
  };
}

describe("thread rail fetch status", () => {
  it("initialises the whole sidebar module and exports the status renderer", () => {
    const { sidebar } = createHarness();
    // A throw anywhere in the IIFE would have left this undefined.
    expect(typeof sidebar.renderThreadListStatus).toBe("function");
    expect(typeof sidebar.renderThreads).toBe("function");
  });

  it("says it is loading instead of presenting an empty rail as the answer", () => {
    const { rail, sidebar } = createHarness();
    // What the rail shows when a previous fetch found nothing.
    const empty = new FakeElement();
    empty.className = "work-empty";
    rail.appendChild(empty);

    sidebar.renderThreadListStatus("loading");

    const rows = rowsMatching(rail, "thread-list-status");
    expect(rows).toHaveLength(1);
    expect(rows[0].className).toContain("loading");
    expect(rows[0].children.map((c) => c.textContent).join(" ")).toContain("Loading threads");
    // "No conversations yet" is a guess while a fetch is in flight.
    expect(railChildren(rail).some((c) => c.className === "work-empty")).toBe(false);
  });

  it("reports a failed fetch and posts a retry when its button is clicked", () => {
    const { rail, postMessages, sidebar } = createHarness();

    sidebar.renderThreadListStatus("loading");
    sidebar.renderThreadListStatus("failed");

    // Only one status row survives.
    const rows = rowsMatching(rail, "thread-list-status");
    expect(rows).toHaveLength(1);
    expect(rows[0].className).toContain("failed");

    const retry = rows[0].children.find((c) => c.className === "thread-list-retry")!;
    expect(retry).toBeTruthy();
    retry.dispatch("click", { stopPropagation: () => undefined });

    expect(postMessages).toContainEqual({ type: "retryThreadList" });
  });

  it("replaces the status row with the published list", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([threadSummary("thread-a")]);

    sidebar.renderThreadListStatus("loading");
    sidebar.renderThreads();

    expect(rowsMatching(rail, "thread-list-status")).toHaveLength(0);
    expect(rowsMatching(rail, "thread-item")).toHaveLength(1);
  });

  it("leaves a populated rail alone while it refreshes", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([threadSummary("thread-a")]);
    sidebar.renderThreads();

    sidebar.renderThreadListStatus("loading");

    // The list is already the answer; a spinner under it on every panel open
    // would be noise rather than information.
    expect(rowsMatching(rail, "thread-list-status")).toHaveLength(0);
    expect(rowsMatching(rail, "thread-item")).toHaveLength(1);
  });

  it("still reports a failure over a populated rail, since that list may be stale", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([threadSummary("thread-a")]);
    sidebar.renderThreads();

    sidebar.renderThreadListStatus("failed");

    expect(rowsMatching(rail, "thread-list-status")).toHaveLength(1);
    expect(rowsMatching(rail, "thread-item")).toHaveLength(1);
  });

  it("clears the status row when the fetch resolved without a failed flag", () => {
    const { rail, sidebar } = createHarness();
    sidebar.renderThreadListStatus("loading");

    sidebar.renderThreadListStatus(null);

    expect(rowsMatching(rail, "thread-list-status")).toHaveLength(0);
  });
});
