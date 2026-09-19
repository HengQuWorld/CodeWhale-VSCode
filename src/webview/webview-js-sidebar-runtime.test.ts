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
