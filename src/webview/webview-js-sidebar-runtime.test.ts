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
import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";

// The extension half of this seam is imported below, and it reaches for
// `vscode` on the way in.
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

/** `.a.b`, optionally followed by an attribute test, or a comma-separated list
 *  of those; anything else answers nothing. The rail turns out to mix the two
 *  ('.thread-item[data-thread-id="x"]'), so a stand-in that only understood
 *  classes would answer null and silently skip the branch under test. */
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

  /** Nearest ancestor matching the selector, self included — the Changes panel
   *  folds a turn by finding the group header a click landed inside. */
  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  remove(): void {
    if (this.parentElement) this.parentElement.detach(this);
    this.parentElement = null;
  }

  querySelectorAll(selector?: string): FakeElement[] {
    // Descendant-scoped, like the real thing: the rail's own row removal looks
    // for a row inside the card inside the item, and a stand-in that only
    // matched children would answer null and leave the row standing.
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

function createHarness(options?: { storage?: Record<string, string> }) {
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
  // The Activity section picker keeps the reader's choice in the webview's own
  // store, so the stand-in has to be there before the IIFE reads it.
  const storageValues = new Map<string, string>(
    Object.entries(options?.storage ?? {}),
  );
  const storage = {
    getItem: (key: string): string | null => storageValues.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storageValues.set(key, String(value));
    },
    removeItem: (key: string): void => {
      storageValues.delete(key);
    },
  };
  // The Changes panel's Locate action scrolls the stream itself rather than
  // calling back into the extension, so it reaches the messages module here.
  const revealCalls: Array<Record<string, unknown>> = [];
  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (value: unknown) => String(value ?? ""),
    __wvFormatRelativeTime: () => "now",
    __wvVscode: { postMessage: (msg: Record<string, unknown>) => postMessages.push(msg) },
    // The diff store the change rows key their Diff action by, shared with the
    // message cards in the real webview.
    __wvDiffStore: new Map<string, string>(),
    __wvDiffIdCounter: { value: 0 },
    __wvMessages: {
      revealFileChangeCard: (ref: Record<string, unknown>) => {
        revealCalls.push(ref);
        return true;
      },
    },
    addEventListener: () => {},
    localStorage: storage,
  };
  const documentObj = {
    getElementById: (id: string) => getEl(id),
    createElement: () => new FakeElement(),
    // The inline attention card labels its remember box with a text node; a
    // bare element carrying the text stands in well enough for a child count
    // and a click to be asserted.
    createTextNode: (text: string) => {
      const node = new FakeElement();
      node.textContent = text;
      return node;
    },
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
    chip: getEl("agent-panel-toggle"),
    panel: getEl("threads-panel"),
    sidebarSection: getEl("sidebar-threads"),
    agentsPanel: getEl("tab-agents"),
    changesPanel: getEl("tab-changes"),
    activityPicker: getEl("activity-sections-picker"),
    activityToggle: getEl("activity-sections-toggle"),
    activityEmpty: getEl("activity-sections-empty"),
    sections: {
      work: getEl("sidebar-work"),
      changes: getEl("sidebar-changes"),
      fleet: getEl("sidebar-fleet"),
      tasks: getEl("sidebar-tasks"),
      agents: getEl("sidebar-agents"),
    },
    storage,
    postMessages,
    revealCalls,
    diffStore: windowObj.__wvDiffStore as Map<string, string>,
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

// ── Agent run time ──

/** Local YYYY-MM-DD HH:MM:SS, the same reading the card renders for an epoch-ms
 *  instant. */
function stampOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function agentRun(overrides: Record<string, unknown> = {}) {
  return {
    spec: { worker_id: "worker-1", run_id: "run-1", objective: "Do the thing", role: "implement", model: "m" },
    status: "running",
    created_at_ms: 0,
    updated_at_ms: 0,
    started_at_ms: null as number | null,
    completed_at_ms: null as number | null,
    latest_message: null,
    result_summary: null,
    error: null,
    steps_taken: 3,
    usage: null,
    artifacts: [],
    events: [],
    ...overrides,
  };
}

/** The rendered HTML of the single card in the agents panel. */
function agentCardHtml(sidebar: Record<string, any>, panel: FakeElement): string {
  sidebar.renderAgents(sidebar.getAgentRuns());
  expect(panel.children).toHaveLength(1);
  return panel.children[0].innerHTML;
}

describe("agent cards show when each agent ran", () => {
  it("shows the start timestamp and elapsed time for a running agent", () => {
    const { sidebar, agentsPanel } = createHarness();
    const startedAt = Date.now() - 125_000;
    sidebar.setAgentRuns([
      agentRun({ status: "running_tool", started_at_ms: startedAt, created_at_ms: startedAt - 10_000 }),
    ]);
    const html = agentCardHtml(sidebar, agentsPanel);

    expect(html).toContain(`Started ${stampOf(startedAt)}`);
    // Elapsed is measured against the render instant, so only its shape is fixed.
    expect(html).toMatch(/Elapsed \d+s|Elapsed \d+m\d+s|Elapsed \d+h\d+m/);
    expect(html).toContain("agent-runtime");
  });

  it("shows the total duration once an agent has settled", () => {
    const { sidebar, agentsPanel } = createHarness();
    const startedAt = Date.now() - 600_000;
    sidebar.setAgentRuns([
      agentRun({ status: "completed", started_at_ms: startedAt, completed_at_ms: startedAt + 192_000 }),
    ]);
    const html = agentCardHtml(sidebar, agentsPanel);

    expect(html).toContain(`Started ${stampOf(startedAt)}`);
    expect(html).toContain("Duration 3m12s");
  });

  it("dates a run that started on an earlier day", () => {
    const { sidebar, agentsPanel } = createHarness();
    // 30h back: a bare clock reading would not say which day the agent ran.
    const startedAt = Date.now() - 30 * 60 * 60 * 1000;
    const startedDay = stampOf(startedAt).split(" ")[0];
    expect(startedDay).not.toBe(stampOf(Date.now()).split(" ")[0]);
    sidebar.setAgentRuns([
      agentRun({ status: "completed", started_at_ms: startedAt, completed_at_ms: startedAt + 60_000 }),
    ]);
    const html = agentCardHtml(sidebar, agentsPanel);

    expect(html).toContain(`Started ${stampOf(startedAt)}`);
    expect(html).toContain(startedDay);
  });

  it("falls back to the creation timestamp for an agent that has not started", () => {
    const { sidebar, agentsPanel } = createHarness();
    const createdAt = Date.now() - 30_000;
    sidebar.setAgentRuns([agentRun({ status: "queued", created_at_ms: createdAt })]);
    const html = agentCardHtml(sidebar, agentsPanel);

    expect(html).toContain(`Created ${stampOf(createdAt)}`);
    expect(html).not.toContain("Started");
  });

  it("omits the run-time line when the record carries no time at all", () => {
    const { sidebar, agentsPanel } = createHarness();
    sidebar.setAgentRuns([agentRun({ status: "queued" })]);
    const html = agentCardHtml(sidebar, agentsPanel);

    expect(html).not.toContain("agent-runtime");
  });
});

// ── Toolbar Agent chip ──
//
// The chip is the one place that says another thread is waiting on the user.
// "Agent · 1" read as an agent count, and its tooltip was a fixed list of the
// panel's three tabs, so a yellow chip never explained itself. These tests pin
// both halves of the fix: the chip says what it counts and names the thread it
// expands, and the click expands it in the panel rather than switching threads
// out from under the conversation the user is in the middle of.

function waitingThread(id: string, updatedAt: string, pending = 1, title?: string) {
  return {
    ...threadSummary(id),
    title: title || `Thread ${id}`,
    updated_at: updatedAt,
    pending_attention_count: pending,
  };
}

function chipHint(chip: FakeElement): string {
  return chip.getAttribute("data-tooltip") || "";
}

describe("toolbar Agent chip", () => {
  it("says what it counts and names the thread the click expands", () => {
    const { chip, sidebar } = createHarness();
    sidebar.setThreads([
      waitingThread("thread-a", "2026-09-17T00:00:00Z", 1, "Fix the login timeout"),
    ]);
    sidebar.renderThreads();

    // The suffix carries its noun: the number is a work queue, not agents.
    expect(chip.textContent).toBe("Agent \u00b7 1 waiting");
    expect(chip.classList.contains("has-attention")).toBe(true);
    expect(chipHint(chip)).toContain("Fix the login timeout");
  });

  it("expands the waiting thread in the panel instead of leaving the conversation", () => {
    const { chip, panel, postMessages, sidebar, sidebarSection } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();

    // The user is already in the panel, on another tab: the click has to bring
    // them to this one rather than toggle the panel shut under them.
    panel.classList.add("open");
    sidebar.switchSidebarTab("sessions");

    chip.dispatch("click");

    // The request is answered where it already has a card — the panel, on the
    // tab that holds it. Going to the thread would take the conversation the
    // user is in the middle of away from them; the card itself still offers it.
    expect(postMessages).toContainEqual({ type: "showThreadAttention", threadId: "thread-a" });
    expect(postMessages.some((m) => m.type === "loadThread")).toBe(false);
    expect(panel.classList.contains("open")).toBe(true);
    expect(sidebarSection.getAttribute("data-active-tab")).toBe("threads");
  });

  it("expands the longest-waiting thread when several wait", () => {
    const { chip, postMessages, sidebar } = createHarness();
    sidebar.setThreads([
      waitingThread("thread-new", "2026-09-18T00:00:00Z"),
      waitingThread("thread-old", "2026-09-16T00:00:00Z"),
    ]);
    sidebar.renderThreads();

    expect(chipHint(chip)).toContain("2");
    expect(chipHint(chip)).toContain("Thread thread-old");

    chip.dispatch("click");

    expect(postMessages).toContainEqual({ type: "showThreadAttention", threadId: "thread-old" });
  });

  it("counts one thread's two pending items as two", () => {
    const { chip, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z", 2)]);
    sidebar.renderThreads();

    // One thread, two things waiting; the chip counts the things, and the
    // tooltip still names the single destination.
    expect(chip.textContent).toBe("Agent \u00b7 2 waiting");
    expect(chipHint(chip)).toContain("Thread thread-a");
  });

  it("drops the thread already on screen from the count", () => {
    const { chip, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.setActiveThreadId("thread-a");
    sidebar.renderThreads();

    // Its cards render inline where the user already is: not "elsewhere".
    expect(chip.textContent).toBe("Agent");
    expect(chip.classList.contains("has-attention")).toBe(false);
    expect(chipHint(chip)).not.toContain("Thread thread-a");
  });

  it("stays the panel's entry point when nothing is waiting", () => {
    const { chip, postMessages, sidebar } = createHarness();
    sidebar.setThreads([threadSummary("thread-a")]);
    sidebar.renderThreads();

    chip.dispatch("click");

    // Nothing to expand: the click opens the panel rather than doing nothing.
    expect(postMessages.some((m) => m.type === "showThreadAttention")).toBe(false);
    expect(postMessages.some((m) => m.type === "refreshSidebar")).toBe(true);
  });

  it("answers Enter the way a pointer click does", () => {
    const { chip, postMessages, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();

    chip.dispatch("keydown", { key: "Enter", preventDefault: () => undefined });

    expect(postMessages).toContainEqual({ type: "showThreadAttention", threadId: "thread-a" });
  });
});

// ── Inline thread attention ──
//
// The card is where a background thread's approval is answered without
// switching, and it is what the chip's click opens. It lives as the payload
// rather than as whatever DOM is on screen: the rail is rebuilt out of every
// thread list, and a card that existed only in the DOM would vanish under the
// pointer of someone about to click Allow.

function railItem(rail: FakeElement, threadId: string): FakeElement | null {
  return rail.querySelector(`.thread-item[data-thread-id="${threadId}"]`);
}

function attentionCard(rail: FakeElement, threadId: string): FakeElement | null {
  return railItem(rail, threadId)?.querySelector(".thread-attention") ?? null;
}

function attentionButton(card: FakeElement, kind: string): FakeElement {
  const row = card.querySelector(".thread-attention-buttons")!;
  return row.children.find((child) => child.className === `thread-attention-btn ${kind}`)!;
}

function pendingApproval(id: string) {
  return { id, tool_name: "shell", description: "run the tests" };
}

describe("inline thread attention", () => {
  it("keeps the expanded card on its row across a rail rebuild", () => {
    const { postMessages, rail, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();

    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-1")],
      inputs: [],
    });
    expect(attentionCard(rail, "thread-a")).toBeTruthy();

    // A thread list arriving mid-answer rebuilds every row, which is exactly
    // when the card used to disappear.
    sidebar.renderThreads();

    const card = attentionCard(rail, "thread-a");
    expect(card).toBeTruthy();
    attentionButton(card!, "allow").dispatch("click", { stopPropagation: () => undefined });
    expect(postMessages).toContainEqual({
      type: "approvalDecision",
      approvalId: "approval-1",
      decision: "allow",
      remember: false,
    });
  });

  it("retires an answered row and does not put it back on the next rebuild", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();
    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-1")],
      inputs: [],
    });

    sidebar.removeThreadAttentionApproval("approval-1");
    expect(attentionCard(rail, "thread-a")).toBeNull();

    sidebar.renderThreads();
    expect(attentionCard(rail, "thread-a")).toBeNull();
  });

  it("leaves the other rows standing when one is answered", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();
    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-1"), pendingApproval("approval-2")],
      inputs: [],
    });

    sidebar.removeThreadAttentionApproval("approval-1");

    const card = attentionCard(rail, "thread-a");
    expect(card).toBeTruthy();
    expect(card!.querySelectorAll(".thread-attention-approval")).toHaveLength(1);
    sidebar.renderThreads();
    expect(attentionCard(rail, "thread-a")!.querySelectorAll(".thread-attention-approval")).toHaveLength(1);
  });

  it("keeps one card expanded at a time", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([
      waitingThread("thread-a", "2026-09-17T00:00:00Z"),
      waitingThread("thread-b", "2026-09-17T00:00:00Z"),
    ]);
    sidebar.renderThreads();

    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-a")],
      inputs: [],
    });
    sidebar.showThreadAttention({
      threadId: "thread-b",
      approvals: [pendingApproval("approval-b")],
      inputs: [],
    });

    // The payload names one card, so the rail shows one: two expanded cards
    // would be a state the next rebuild could not put back.
    expect(attentionCard(rail, "thread-a")).toBeNull();
    expect(attentionCard(rail, "thread-b")).toBeTruthy();
  });

  it("opens the thread when the rail cannot hold the card", () => {
    const { postMessages, sidebar } = createHarness();
    // Another workspace, or past the summary limit: the thread is not in the
    // rail at all, so opening it is the only way left to reach the approval.
    sidebar.setThreads([threadSummary("thread-someone-else")]);
    sidebar.renderThreads();

    sidebar.showThreadAttention({
      threadId: "thread-elsewhere",
      approvals: [pendingApproval("approval-1")],
      inputs: [],
    });

    expect(postMessages).toContainEqual({ type: "loadThread", threadId: "thread-elsewhere" });
  });

  it("stops expanding a thread once it is the one on screen", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();
    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-1")],
      inputs: [],
    });

    // The user took the card's own offer and opened the thread: its request is
    // answered in the conversation now, and one request has one place to answer
    // it — not two.
    sidebar.setActiveThreadId("thread-a");
    sidebar.renderThreads();
    expect(attentionCard(rail, "thread-a")).toBeNull();
  });
});

// ── Changes panel ──

/** One recorded change, shaped as `refreshChangesPanel` publishes it. */
function recordedChange(overrides: Record<string, unknown> = {}) {
  return {
    filePath: "src/a.ts",
    changeType: "modified",
    addedLines: 3,
    removedLines: 1,
    diff: "--- a\n+++ b\n",
    changeIndex: 0,
    callId: "call-1",
    ...overrides,
  };
}

/** The panel's list element — the header section is its first child. */
function changeList(panel: FakeElement): FakeElement {
  return panel.children[1];
}

/** The Locate buttons as `renderChanges` actually wrote them.
 *
 *  Reading them back out of the rendered markup, instead of hand-writing the
 *  attributes, is what lets this test fail: a renderer that stops emitting an
 *  attribute hands the click handler an element without it, and the assertions
 *  below see the same miss the user would. Hand-building the button would test
 *  the handler against a row the panel never produces — and would stay green
 *  while Locate became a silent no-op. */
function locateButtons(renderedListHtml: string): FakeElement[] {
  const tags = renderedListHtml.match(/<button[^>]*change-goto-card[^>]*>/g) ?? [];
  return tags.map((tag) => {
    const button = new FakeElement();
    button.classList.add("change-goto-card");
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      button.setAttribute(name, value);
    }
    return button;
  });
}

/** The Diff buttons as `renderChanges` actually wrote them, for the same
 *  reason `locateButtons` reads them back: hand-building one would test the
 *  handler against a row the panel never draws. */
function diffButtons(renderedListHtml: string): FakeElement[] {
  const tags = renderedListHtml.match(/<button[^>]*change-view-diff[^>]*>/g) ?? [];
  return tags.map((tag) => {
    const button = new FakeElement();
    button.classList.add("change-view-diff");
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      button.setAttribute(name, value);
    }
    return button;
  });
}

describe("Changes panel", () => {
  it("reports the change count and the distinct file count", () => {
    const { changesPanel, sidebar } = createHarness();
    // Three rows over two files: the header must not present the rows as files.
    sidebar.setChangesState([
      recordedChange({ filePath: "src/a.ts", changeIndex: 0 }),
      recordedChange({ filePath: "src/a.ts", changeIndex: 1, callId: "call-2" }),
      recordedChange({ filePath: "src/b.ts", changeType: "created", callId: "call-3" }),
    ]);
    sidebar.renderChanges();

    const header = changesPanel.children[0].innerHTML;
    expect(header).toContain("3 change(s)");
    expect(header).toContain("2 file(s)");
  });

  it("counts one file once, however the runtime spelled its path", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState([
      recordedChange({ filePath: "src/a.ts", changeIndex: 0 }),
      recordedChange({ filePath: "src\\a.ts", changeIndex: 1, callId: "call-2" }),
    ]);
    sidebar.renderChanges();

    const header = changesPanel.children[0].innerHTML;
    expect(header).toContain("2 change(s)");
    expect(header).toContain("1 file(s)");
  });

  it("gives every row a Locate button carrying that row's own change", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState([
      recordedChange({ filePath: "src/a.ts", changeIndex: 0, callId: "call-1" }),
      recordedChange({ filePath: "src/a.ts", changeIndex: 1, callId: "call-2" }),
    ]);
    sidebar.renderChanges();

    const buttons = locateButtons(changeList(changesPanel).innerHTML);
    expect(buttons).toHaveLength(2);
    // The second row must not carry the first row's identity: one file changing
    // twice is the case the whole lookup exists for.
    expect(buttons[0].getAttribute("data-file-path")).toBe("src/a.ts");
    expect(buttons[0].getAttribute("data-change-index")).toBe("0");
    expect(buttons[0].getAttribute("data-call-id")).toBe("call-1");
    expect(buttons[1].getAttribute("data-change-index")).toBe("1");
    expect(buttons[1].getAttribute("data-call-id")).toBe("call-2");
  });

  it("scrolls the stream to that change's card when Locate is clicked", () => {
    const { changesPanel, revealCalls, sidebar } = createHarness();
    sidebar.setChangesState([
      recordedChange({ filePath: "src/a.ts", changeIndex: 0, callId: "call-1" }),
      recordedChange({ filePath: "src/a.ts", changeIndex: 1, callId: "call-2" }),
    ]);
    sidebar.renderChanges();

    const list = changeList(changesPanel);
    list.dispatch("click", { target: locateButtons(list.innerHTML)[1] });

    // The second change, not the file's first card: the row names the change it
    // came from and so must the scroll.
    expect(revealCalls).toEqual([{ filePath: "src/a.ts", callId: "call-2", changeIndex: 1 }]);
  });

  it("sends a row without a call id by path and index instead", () => {
    const { changesPanel, revealCalls, sidebar } = createHarness();
    sidebar.setChangesState([recordedChange({ callId: undefined, changeIndex: undefined })]);
    sidebar.renderChanges();

    const list = changeList(changesPanel);
    list.dispatch("click", { target: locateButtons(list.innerHTML)[0] });

    expect(revealCalls).toEqual([{ filePath: "src/a.ts", callId: undefined, changeIndex: undefined }]);
  });

  it("counts a file whose name collides with an object member", () => {
    const { changesPanel, sidebar } = createHarness();
    // `constructor` and `toString` read as already-seen on a `{}`, which would
    // under-report the count rather than crash.
    sidebar.setChangesState([
      recordedChange({ filePath: "constructor", changeIndex: 0 }),
      recordedChange({ filePath: "toString", changeIndex: 0, callId: "call-2" }),
      recordedChange({ filePath: "__proto__", changeIndex: 0, callId: "call-3" }),
    ]);
    sidebar.renderChanges();

    const header = changesPanel.children[0].innerHTML;
    expect(header).toContain("3 change(s)");
    expect(header).toContain("3 file(s)");
  });
});

// ── Changes panel grouped by turn ──

/** One turn's group as `renderChanges` drew it: header first, rows second. */
interface DrawnGroup {
  group: FakeElement;
  header: FakeElement;
  items: FakeElement;
}

/** The groups the panel currently holds, in order. */
function drawnGroups(panel: FakeElement): DrawnGroup[] {
  const list = panel.children[1];
  return list.children
    .filter((child) => child.className.includes("change-turn-group"))
    .map((group) => ({
      group,
      header: group.children[0],
      items: group.children[1],
    }));
}

describe("Changes panel grouped by turn", () => {
  it("draws one section per turn, in the order the turns ran", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [
        recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0 }),
        recordedChange({ filePath: "src/b.ts", turnIndex: 2, changeIndex: 0, callId: "call-2" }),
        recordedChange({ filePath: "src/c.ts", turnIndex: 2, changeIndex: 0, callId: "call-3" }),
      ],
      [
        { index: 1, label: "first prompt" },
        { index: 2, label: "second prompt" },
      ],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(2);
    expect(groups[0].header.innerHTML).toContain("Turn 1");
    expect(groups[0].header.innerHTML).toContain("first prompt");
    expect(groups[1].header.innerHTML).toContain("Turn 2");
    expect(groups[1].header.innerHTML).toContain("second prompt");
    // Each turn owns its own rows, and the header counts only those.
    expect(groups[0].items.innerHTML).toContain("src/a.ts");
    expect(groups[0].items.innerHTML).not.toContain("src/b.ts");
    expect(groups[1].items.innerHTML).toContain("src/b.ts");
    expect(groups[1].items.innerHTML).toContain("src/c.ts");
    expect(groups[1].header.innerHTML).toContain("2 change(s)");
    // The header still reads the whole session.
    expect(changesPanel.children[0].innerHTML).toContain("3 change(s)");
  });

  it("skips a turn that recorded no changes, keeping the others' numbering", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [recordedChange({ filePath: "src/a.ts", turnIndex: 3, changeIndex: 0 })],
      [
        { index: 1, label: "no files touched" },
        { index: 2, label: "neither did this one" },
        { index: 3, label: "this one did" },
      ],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(1);
    // "Turn 3" still means the third turn of the conversation.
    expect(groups[0].header.innerHTML).toContain("Turn 3");
  });

  it("tells an unlabelled turn apart without inventing words for it", () => {
    const { changesPanel, sidebar } = createHarness();
    // A turn the runtime started on its own: the client never saw the prompt.
    sidebar.setChangesState(
      [recordedChange({ turnIndex: 1, changeIndex: 0 })],
      [{ index: 1, label: "" }],
    );
    sidebar.renderChanges();

    const header = drawnGroups(changesPanel)[0].header;
    expect(header.innerHTML).toContain("Turn 1");
    expect(header.innerHTML).not.toContain('class="change-turn-preview"');
  });

  it("keeps every row's own identity inside its group", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [
        recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0, callId: "call-1" }),
        recordedChange({ filePath: "src/a.ts", turnIndex: 2, changeIndex: 1, callId: "call-2" }),
      ],
      [
        { index: 1, label: "first" },
        { index: 2, label: "second" },
      ],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    const first = locateButtons(groups[0].items.innerHTML);
    const second = locateButtons(groups[1].items.innerHTML);
    expect(first[0].getAttribute("data-call-id")).toBe("call-1");
    expect(first[0].getAttribute("data-change-index")).toBe("0");
    // The earlier turn's row must not adopt the later turn's diff: the whole
    // reason a change carries its own index.
    expect(second[0].getAttribute("data-call-id")).toBe("call-2");
    expect(second[0].getAttribute("data-change-index")).toBe("1");
  });

  it("folds a turn shut, and leaves it shut across a re-render", () => {
    const { changesPanel, sidebar } = createHarness();
    const turns = [
      { index: 1, label: "first" },
      { index: 2, label: "second" },
    ];
    const changes = [
      recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0 }),
      recordedChange({ filePath: "src/b.ts", turnIndex: 2, changeIndex: 0, callId: "call-2" }),
    ];
    sidebar.setChangesState(changes, turns);
    sidebar.renderChanges();

    const first = drawnGroups(changesPanel)[0];
    // Through the list, like a real click: the handler is delegated there.
    changeList(changesPanel).dispatch("click", { target: first.header });
    expect(first.group.classList.contains("collapsed")).toBe(true);

    // The panel re-renders on every detected change; a folded section that
    // sprang back open each time would be unusable while a turn runs.
    sidebar.renderChanges();
    const redrawn = drawnGroups(changesPanel);
    expect(redrawn[0].group.classList.contains("collapsed")).toBe(true);
    expect(redrawn[1].group.classList.contains("collapsed")).toBe(false);

    // And clicking again unfolds it.
    changeList(changesPanel).dispatch("click", { target: redrawn[0].header });
    expect(redrawn[0].group.classList.contains("collapsed")).toBe(false);
  });

  it("forgets a fold whose turn is no longer listed", () => {
    const { changesPanel, sidebar } = createHarness();
    const turns = [
      { index: 1, label: "first" },
      { index: 2, label: "second" },
    ];
    const changes = [
      recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0 }),
      recordedChange({ filePath: "src/b.ts", turnIndex: 2, changeIndex: 0, callId: "call-2" }),
    ];
    sidebar.setChangesState(changes, turns);
    sidebar.renderChanges();
    const second = drawnGroups(changesPanel)[1];
    changeList(changesPanel).dispatch("click", { target: second.header });
    expect(second.group.classList.contains("collapsed")).toBe(true);

    // The turn's only change is reverted, so its section goes away...
    sidebar.setChangesState([changes[0]], [turns[0]]);
    sidebar.renderChanges();
    expect(drawnGroups(changesPanel)).toHaveLength(1);

    // ...and when the turn comes back, it comes back open. A fold belongs to a
    // section on screen, and this one was off screen in between.
    sidebar.setChangesState(changes, turns);
    sidebar.renderChanges();
    expect(drawnGroups(changesPanel)[1].group.classList.contains("collapsed")).toBe(false);
  });

  it("stores one diff per change, however often the panel re-renders", () => {
    const { changesPanel, diffStore, sidebar } = createHarness();
    sidebar.setChangesState(
      [
        recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0, callId: "call-1" }),
        recordedChange({ filePath: "src/b.ts", turnIndex: 1, changeIndex: 0, callId: "call-2" }),
      ],
      [{ index: 1, label: "first" }],
    );

    sidebar.renderChanges();
    sidebar.renderChanges();
    sidebar.renderChanges();

    // The panel now holds every turn of a session, so a key minted per render
    // would leave a full copy of the session's diffs behind on each one.
    expect(diffStore.size).toBe(2);
    expect(changesPanel.children.length).toBe(2);
  });

  it("opens each row's own diff, even when two rows share a call id", () => {
    const { changesPanel, postMessages, sidebar } = createHarness();
    // One call reporting changes to two files, both at index 0 — the payload
    // shape a key built from the call id alone would collapse, handing the
    // first row the second row's patch.
    sidebar.setChangesState(
      [
        recordedChange({
          filePath: "src/a.ts",
          turnIndex: 1,
          changeIndex: 0,
          callId: "call-1",
          diff: "diff --git a/src/a.ts",
        }),
        recordedChange({
          filePath: "src/z.ts",
          turnIndex: 1,
          changeIndex: 0,
          callId: "call-1",
          diff: "diff --git a/src/z.ts",
        }),
      ],
      [{ index: 1, label: "first" }],
    );
    sidebar.renderChanges();

    // Both rows are in the first turn's group; the Diff action is delegated
    // from the list, so the click is dispatched there like a real one.
    const buttons = diffButtons(drawnGroups(changesPanel)[0].items.innerHTML);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      changeList(changesPanel).dispatch("click", { target: button });
    }

    const opened = postMessages.filter((m) => m.type === "openDiff");
    expect(opened.map((m) => m.diff)).toEqual([
      "diff --git a/src/a.ts",
      "diff --git a/src/z.ts",
    ]);
  });

  it("still draws one flat list when no turn grouping is published", () => {
    const { changesPanel, sidebar } = createHarness();
    // An older host, or a caller that only publishes the change list: the
    // rows must still be there, ungrouped.
    sidebar.setChangesState([recordedChange({ filePath: "src/a.ts", changeIndex: 0 })]);
    sidebar.renderChanges();

    const list = changesPanel.children[1];
    expect(list.innerHTML).toContain("src/a.ts");
    expect(drawnGroups(changesPanel)).toHaveLength(0);
  });
});

// ── The seam: the extension's payload, drawn by the panel ──

/** Two turns, each creating one file through the shape current TUI write tools
 *  persist (`metadata.mutation`). */
function twoTurnThreadDetail() {
  const mutation = (itemId: string, toolUseId: string, path: string) => ({
    id: itemId,
    kind: "tool_call",
    summary: `write: Successfully wrote 1 byte to ${path}`,
    detail: `Successfully wrote 1 byte to ${path}`,
    status: "completed",
    metadata: {
      tool_use_id: toolUseId,
      tool_name: "write",
      event: "file.mutation",
      mutation: {
        diff: [
          `diff --git a/${path} b/${path}`,
          "--- /dev/null",
          `+++ b/${path}`,
          "@@ -0,0 +1 @@",
          "+hello",
        ].join("\n"),
        files: [{ path, outcome: "created" }],
        renames: [],
      },
    },
  });
  return {
    latest_seq: 9,
    thread: { id: "thread-1", model: "deepseek-v4-pro" },
    turns: [
      {
        id: "turn-1",
        input_summary: "create the first file",
        created_at: "2026-09-18T10:00:00Z",
        ended_at: "2026-09-18T10:00:02Z",
        status: "completed",
        item_ids: ["u1", "t1", "a1"],
      },
      {
        id: "turn-2",
        input_summary: "now the second one",
        created_at: "2026-09-18T10:05:00Z",
        ended_at: "2026-09-18T10:05:02Z",
        status: "completed",
        item_ids: ["u2", "t2", "a2"],
      },
    ],
    items: [
      { id: "u1", kind: "user_message", summary: "create the first file", detail: "create the first file", status: "completed" },
      mutation("t1", "tool-1", "src/first.ts"),
      { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
      { id: "u2", kind: "user_message", summary: "now the second one", detail: "now the second one", status: "completed" },
      mutation("t2", "tool-2", "src/second.ts"),
      { id: "a2", kind: "agent_message", summary: "Done again", detail: "Done again", status: "completed", metadata: null },
    ],
  };
}

describe("Changes panel drawn from the extension's own payload", () => {
  it("shows a two-turn session as two groups, with each turn's changes under it", async () => {
    // The point of this test is the seam: the field names the provider
    // publishes and the ones the panel reads are separately spelled out, and
    // both halves are string-built code that no type checks across. Only a real
    // payload rendered by the real panel can catch a drift between them.
    const { ChatProvider } = await import("../../src/chat-provider");
    const api = {
      bindEngine: vi.fn(),
      getThreadDetail: vi.fn(async () => twoTurnThreadDetail()),
      listSnapshots: vi.fn(async () => []),
    };
    const provider = new ChatProvider({} as never, {} as never, api as never);
    const posted: Record<string, any>[] = [];
    provider.postMessage = (message: unknown) => {
      posted.push(message as Record<string, any>);
    };

    await (provider as unknown as { loadHistory(id?: string): Promise<number> }).loadHistory("thread-1");

    const payload = posted.filter((m) => m.type === "changesState").pop();
    expect(payload).toBeDefined();
    expect(payload?.changes).toHaveLength(2);

    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(payload?.changes, payload?.turns);
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(2);
    expect(groups[0].header.innerHTML).toContain("create the first file");
    expect(groups[0].items.innerHTML).toContain("src/first.ts");
    expect(groups[1].header.innerHTML).toContain("now the second one");
    expect(groups[1].items.innerHTML).toContain("src/second.ts");
    // Neither turn is hiding behind the other: this is the report that started
    // the change — the panel showed only the most recent turn.
    expect(changesPanel.children[0].innerHTML).toContain("2 change(s)");
    expect(changesPanel.children[0].innerHTML).toContain("2 file(s)");
  });
});

describe("Changes panel keeps every row visible", () => {
  it("falls back to the flat list when a change belongs to no published group", () => {
    const { changesPanel, sidebar } = createHarness();
    // A host that names turns but leaves one change unmarked. Grouping it
    // anyway would drop that row from the panel without saying so.
    sidebar.setChangesState(
      [
        recordedChange({ filePath: "src/a.ts", turnIndex: 1, changeIndex: 0 }),
        recordedChange({ filePath: "src/orphan.ts", changeIndex: 0, callId: "call-2" }),
      ],
      [{ index: 1, label: "first" }],
    );
    sidebar.renderChanges();

    const list = changesPanel.children[1];
    expect(list.innerHTML).toContain("src/a.ts");
    expect(list.innerHTML).toContain("src/orphan.ts");
  });

  it("falls back to the flat list when a change outlives its group", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [recordedChange({ filePath: "src/a.ts", turnIndex: 4, changeIndex: 0 })],
      [{ index: 1, label: "first" }],
    );
    sidebar.renderChanges();

    expect(changesPanel.children[1].innerHTML).toContain("src/a.ts");
  });
});

describe("Activity section visibility", () => {
  const ALL = ["work", "changes", "fleet", "tasks", "agents"] as const;

  it("shows every section until the reader hides one", () => {
    const { sections, activityEmpty } = createHarness();

    for (const key of ALL) {
      expect(sections[key].classList.contains("hidden")).toBe(false);
    }
    // The note that stands in for an empty Activity tab stays out of the way
    // while there is something on it.
    expect(activityEmpty.classList.contains("visible")).toBe(false);
  });

  it("hides a section, and writes the choice down for the next load", () => {
    const { sections, sidebar, storage } = createHarness();

    sidebar.setActivitySectionVisible("fleet", false);

    expect(sections.fleet.classList.contains("hidden")).toBe(true);
    expect(sections.work.classList.contains("hidden")).toBe(false);
    expect(sidebar.getHiddenActivitySections()).toEqual(["fleet"]);
    expect(storage.getItem("codewhale:activitySections")).toBe('["fleet"]');
  });

  it("brings a hidden section back and clears it from the store", () => {
    const { sections, sidebar, storage } = createHarness();

    sidebar.setActivitySectionVisible("fleet", false);
    sidebar.setActivitySectionVisible("fleet", true);

    expect(sections.fleet.classList.contains("hidden")).toBe(false);
    expect(storage.getItem("codewhale:activitySections")).toBe("[]");
  });

  it("paints the reader's earlier choice on the next load", () => {
    const { sections, activityEmpty } = createHarness({
      storage: { "codewhale:activitySections": '["tasks","agents"]' },
    });

    expect(sections.tasks.classList.contains("hidden")).toBe(true);
    expect(sections.agents.classList.contains("hidden")).toBe(true);
    expect(sections.work.classList.contains("hidden")).toBe(false);
    expect(activityEmpty.classList.contains("visible")).toBe(false);
  });

  it("says where the sections went once the last one is hidden", () => {
    const { sections, sidebar, activityEmpty } = createHarness();

    for (const key of ALL) sidebar.setActivitySectionVisible(key, false);

    for (const key of ALL) {
      expect(sections[key].classList.contains("hidden")).toBe(true);
    }
    // The picker is the way back and lives in the hint row, above the sections,
    // so hiding every section must not hide the control that restores them.
    expect(activityEmpty.classList.contains("visible")).toBe(true);
  });

  it("ignores a stored value it cannot read", () => {
    const { sections } = createHarness({
      storage: { "codewhale:activitySections": "{ not json" },
    });

    for (const key of ALL) {
      expect(sections[key].classList.contains("hidden")).toBe(false);
    }
  });

  it("ignores a stored section name this build does not know", () => {
    const { sections } = createHarness({
      storage: { "codewhale:activitySections": '["objectives","fleet"]' },
    });

    // A section shipped later starts visible rather than hidden by a preference
    // written before it existed.
    expect(sections.work.classList.contains("hidden")).toBe(false);
    expect(sections.fleet.classList.contains("hidden")).toBe(true);
  });

  it("opens the picker from the gear and hides from its checkbox", () => {
    const { activityToggle, activityPicker, sections } = createHarness();

    activityToggle.dispatch("click", { stopPropagation: () => {} });
    expect(activityPicker.classList.contains("open")).toBe(true);
    // Every section is listed, the hidden ones included — otherwise a hidden
    // section could never be found again.
    for (const key of ALL) {
      expect(activityPicker.innerHTML).toContain(`data-activity-section="${key}"`);
    }
    // Labelled with the same words as the section headers it governs: the
    // Changes section is "Changes", not the Changes panel's "File Changes".
    expect(activityPicker.innerHTML).toContain(">Changes<");
    expect(activityPicker.innerHTML).not.toContain("File Changes");

    activityPicker.dispatch("change", {
      target: {
        getAttribute: (name: string) =>
          name === "data-activity-section" ? "agents" : null,
        checked: false,
      },
    });

    expect(sections.agents.classList.contains("hidden")).toBe(true);
    // The rows are rebuilt from the store, not from the click that just landed.
    expect(activityPicker.innerHTML).toContain('data-activity-section="work" checked');
    expect(activityPicker.innerHTML).not.toContain('data-activity-section="agents" checked');

    activityToggle.dispatch("click", { stopPropagation: () => {} });
    expect(activityPicker.classList.contains("open")).toBe(false);
  });
});
