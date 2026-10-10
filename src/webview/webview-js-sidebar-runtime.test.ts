/**
 * Runtime tests for the sidebar module: the thread rail's fetch status, the
 * panel's own open state, and the Activity sections' folds — the layout choices
 * the reader makes and expects to find again.
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
  public title = "";
  public style: Record<string, string> = {};
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  public type = "";
  public checked = false;
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

function createHarness(options?: { storage?: Record<string, string> | null }) {
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
  const documentListeners = new Map<string, (event: unknown) => void>();
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
  // A host that denies the store outright: the access itself throws, the way a
  // blocked-storage profile does. Every reader in the webview is written to
  // survive it, so the stand-in has to be able to be that host.
  if (options && options.storage === null) {
    Object.defineProperty(windowObj, "localStorage", {
      get() {
        throw new Error("storage denied");
      },
    });
  }
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
    // Kept rather than dropped: the panel's Escape shortcut is only reachable
    // through a document listener, and "closing it is remembered" has to be
    // assertable on that path as well as on the ✕ and the 📋 toggle, which
    // register on their own elements.
    addEventListener: (name: string, handler: (event: unknown) => void) => {
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
  vm.runInContext(getSidebarScript(makeTr()), context);

  const rail = getEl("tab-threads-list");
  return {
    rail,
    sessionRail: getEl("tab-sessions"),
    chip: getEl("agent-panel-toggle"),
    panel: getEl("threads-panel"),
    panelCloseBtn: getEl("sidebar-close-btn"),
    panelToggle: getEl("btn-threads"),
    /** A key on the document, the way the panel's Escape shortcut arrives. */
    pressKey: (key: string): void => {
      documentListeners.get("keydown")?.({ key, target: null });
    },
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
      skills: getEl("sidebar-skills"),
    },
    /** The header each of those sections is folded by, as the document's own
     *  ids address it. */
    sectionHeaders: {
      work: getEl("work-section-toggle"),
      changes: getEl("changes-section-toggle"),
      fleet: getEl("fleet-section-toggle"),
      tasks: getEl("tasks-section-toggle"),
      agents: getEl("agents-section-toggle"),
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

/** Every saved-session row in the order the rail paints it, each tagged with
 *  the depth it sits at, so one list asserts nesting and order together:
 *  `["0:parent", "1:child"]` is a branch drawn under its source. */
function sessionRailOrder(rail: FakeElement): string[] {
  const found: string[] = [];
  const walk = (container: FakeElement, depth: number): void => {
    for (const child of container.children) {
      if (child.className.startsWith("thread-item")) {
        found.push(`${depth}:${child.getAttribute("data-session-id")}`);
      } else if (child.className === "session-forks") {
        walk(child, depth + 1);
      }
    }
  };
  walk(rail, 0);
  return found;
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

// ── The sidebar panel's own state ──
//
// Whether the sidebar is open is a layout choice, not something to re-decide
// on every window: reopening with the sidebar flipped — one the reader left
// open coming back shut, every time — made the choice look like it had never
// counted. It is kept in the webview's store beside the width, and every way
// of opening or closing the panel writes it through the one mutator, so what
// is stored cannot drift from what is on screen.

describe("sidebar panel open state", () => {
  it("reopens a sidebar that was left open", () => {
    const { panel } = createHarness({ storage: { "codewhale:sidebarOpen": "true" } });

    expect(panel.classList.contains("open")).toBe(true);
  });

  it("leaves the panel shut when no choice is on record", () => {
    // A first run has nothing stored, so the panel's own default stands.
    const { panel } = createHarness();

    expect(panel.classList.contains("open")).toBe(false);
  });

  it("leaves the panel shut when the last choice was to close it", () => {
    const { panel } = createHarness({ storage: { "codewhale:sidebarOpen": "false" } });

    expect(panel.classList.contains("open")).toBe(false);
  });

  it("reads only the two values it writes as a choice", () => {
    // A hand-edited store, or a shape another build wrote, is not a choice to
    // honour: the default stands instead of the junk reading as "closed".
    const { panel } = createHarness({ storage: { "codewhale:sidebarOpen": "1" } });

    expect(panel.classList.contains("open")).toBe(false);
  });

  it("writes the choice down when the ✕ closes the panel", () => {
    const { panel, panelCloseBtn, storage } = createHarness({
      storage: { "codewhale:sidebarOpen": "true" },
    });

    panelCloseBtn.dispatch("click");

    expect(panel.classList.contains("open")).toBe(false);
    expect(storage.getItem("codewhale:sidebarOpen")).toBe("false");
  });

  it("writes the choice down when the 📋 toggle opens the panel", () => {
    const { panel, panelToggle, storage } = createHarness();

    panelToggle.dispatch("click");

    expect(panel.classList.contains("open")).toBe(true);
    expect(storage.getItem("codewhale:sidebarOpen")).toBe("true");
  });

  it("writes the choice down when Escape closes the panel", () => {
    const { panel, panelToggle, pressKey, storage } = createHarness();

    // Opened here rather than restored from the store, so this test fails only
    // for its own reason: a panel that is not open is not Escape's business.
    panelToggle.dispatch("click");
    expect(panel.classList.contains("open")).toBe(true);

    pressKey("Escape");

    expect(panel.classList.contains("open")).toBe(false);
    expect(storage.getItem("codewhale:sidebarOpen")).toBe("false");
  });

  it("records nothing when Escape reaches a panel that is already shut", () => {
    // Escape is a shortcut for the ✕, not a second way to write "closed": a
    // sidebar the reader has never opened must not end up on record as one
    // they chose to close.
    const { panel, pressKey, storage } = createHarness();

    pressKey("Escape");

    expect(panel.classList.contains("open")).toBe(false);
    expect(storage.getItem("codewhale:sidebarOpen")).toBe(null);
  });

  it("writes the choice down when the chip opens the panel on a waiting thread", () => {
    const { chip, panel, sidebar, storage } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();

    chip.dispatch("click");

    expect(panel.classList.contains("open")).toBe(true);
    expect(storage.getItem("codewhale:sidebarOpen")).toBe("true");
  });

  it("still works, and simply forgets, when the host denies the store", () => {
    // A locked-down host: reading the store throws. The module has to survive
    // it — a throw in this block takes the whole webview down (see AGENTS.md) —
    // so the layout falls back to its defaults for the session, and the two
    // choices still hold for as long as the panel lives.
    const { panel, panelToggle, sidebar } = createHarness({ storage: null });

    expect(panel.classList.contains("open")).toBe(false);

    panelToggle.dispatch("click");
    expect(panel.classList.contains("open")).toBe(true);

    sidebar.setActivitySectionCollapsed("changes", true);
    expect(sidebar.getCollapsedActivitySections()).toEqual(["changes"]);
  });
});

// ── Activity section folding ──
//
// A fold is a layout choice the reader made, and it used to last only until
// the window was reloaded — every section they had folded shut came back open.
// It is kept the same way as the sections they hid, in its own key so the two
// choices cannot overwrite each other.

describe("Activity section folding", () => {
  it("folds the sections that were folded last time", () => {
    const { sections } = createHarness({
      storage: { "codewhale:collapsedSections": '["changes"]' },
    });

    expect(sections.changes.classList.contains("collapsed")).toBe(true);
    expect(sections.work.classList.contains("collapsed")).toBe(false);
  });

  it("leaves every section open when nothing is on record", () => {
    const { sections } = createHarness();

    expect(sections.work.classList.contains("collapsed")).toBe(false);
    expect(sections.agents.classList.contains("collapsed")).toBe(false);
  });

  it("folds a section from its header and writes the key down", () => {
    const { sectionHeaders, sections, storage } = createHarness();

    sectionHeaders.changes.dispatch("click");

    expect(sections.changes.classList.contains("collapsed")).toBe(true);
    expect(storage.getItem("codewhale:collapsedSections")).toBe('["changes"]');
  });

  it("binds a header to every Activity section, not just some of them", () => {
    // The binding walks the roster and skips a header it cannot find, so a
    // section whose header id drifted would fail silently — as a fold that
    // does nothing. Each one is folded from its own header here.
    for (const key of ["work", "changes", "fleet", "tasks", "agents"] as const) {
      const { sectionHeaders, sections, sidebar } = createHarness();

      sectionHeaders[key].dispatch("click");

      expect(sections[key].classList.contains("collapsed")).toBe(true);
      expect(sidebar.getCollapsedActivitySections()).toEqual([key]);
    }
  });

  it("reopens it on the next click and clears the key", () => {
    const { sectionHeaders, sections, storage } = createHarness({
      storage: { "codewhale:collapsedSections": '["changes"]' },
    });

    sectionHeaders.changes.dispatch("click");

    expect(sections.changes.classList.contains("collapsed")).toBe(false);
    expect(storage.getItem("codewhale:collapsedSections")).toBe("[]");
  });

  it("keeps each section's fold to itself", () => {
    const { sectionHeaders, sections, storage } = createHarness();

    sectionHeaders.tasks.dispatch("click");
    sectionHeaders.fleet.dispatch("click");

    expect(sections.tasks.classList.contains("collapsed")).toBe(true);
    expect(sections.fleet.classList.contains("collapsed")).toBe(true);
    expect(sections.work.classList.contains("collapsed")).toBe(false);
    // Which keys are folded is the choice; the order they are written in is
    // the order they were clicked, and a reload normalises it anyway.
    const written = JSON.parse(storage.getItem("codewhale:collapsedSections")!) as string[];
    expect(written.sort()).toEqual(["fleet", "tasks"]);
  });

  it("drops keys this build does not know instead of carrying them", () => {
    // A section another build had, or a hand-edited store: keeping the unknown
    // key would write it back on the next fold and outlive the section itself.
    const { sectionHeaders, sidebar, storage } = createHarness({
      storage: { "codewhale:collapsedSections": '["changes","objectives"]' },
    });

    expect(sidebar.getCollapsedActivitySections()).toEqual(["changes"]);

    sectionHeaders.changes.dispatch("click");

    expect(storage.getItem("codewhale:collapsedSections")).toBe("[]");
  });

  it("ignores a stored value it cannot read", () => {
    // The loader's guard is not decoration: a throw in this script block takes
    // the whole webview down (see AGENTS.md), so an unreadable store has to
    // leave every section as it was.
    const { sections } = createHarness({
      storage: { "codewhale:collapsedSections": "{ not json" },
    });

    expect(sections.changes.classList.contains("collapsed")).toBe(false);
    expect(sections.work.classList.contains("collapsed")).toBe(false);
  });

  it("ignores a stored value of the wrong shape", () => {
    const { sections } = createHarness({
      storage: { "codewhale:collapsedSections": '{"changes":true}' },
    });

    expect(sections.changes.classList.contains("collapsed")).toBe(false);
  });

  it("writes nothing when the fold asked for is the one already in place", () => {
    const { sidebar, storage } = createHarness({
      storage: { "codewhale:collapsedSections": '["changes"]' },
    });
    // The guard is only worth having if it really is no write: count the ones
    // that reach the store rather than trusting the value to look unchanged.
    const writes: string[] = [];
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      writes.push(`${key}=${value}`);
      setItem(key, value);
    };

    sidebar.setActivitySectionCollapsed("changes", true);

    expect(writes).toEqual([]);
    expect(sidebar.getCollapsedActivitySections()).toEqual(["changes"]);
  });

  it("ignores a key that is not an Activity section", () => {
    // The mutator is reachable from the event handler module, so the roster
    // check is what keeps an unknown key out of the store and out of a
    // selector built from it.
    const { sidebar, storage } = createHarness();

    sidebar.setActivitySectionCollapsed("objectives", true);

    expect(sidebar.getCollapsedActivitySections()).toEqual([]);
    expect(storage.getItem("codewhale:collapsedSections")).toBe(null);
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

  it("keeps a ticked remember box across the rebuild that follows it", () => {
    // The rail is rebuilt on every thread-list publish — and while a thread is
    // waiting, the discovery sweep publishes one roughly every 30 seconds. A
    // rebuild replaces the whole card, so a tick the user set before clicking
    // Allow would otherwise be silently cleared, and the grant lost.
    const { postMessages, rail, sidebar } = createHarness();
    sidebar.setThreads([waitingThread("thread-a", "2026-09-17T00:00:00Z")]);
    sidebar.renderThreads();
    sidebar.showThreadAttention({
      threadId: "thread-a",
      approvals: [pendingApproval("approval-1")],
      inputs: [],
    });

    const box = attentionCard(rail, "thread-a")!.querySelector(".remember-check")!;
    box.checked = true;
    box.dispatch("change");

    // A thread list arrives mid-answer, as the sweep sends it.
    sidebar.renderThreads();

    const card = attentionCard(rail, "thread-a")!;
    expect(card.querySelector(".remember-check")!.checked).toBe(true);
    attentionButton(card, "allow").dispatch("click", { stopPropagation: () => undefined });
    expect(postMessages).toContainEqual({
      type: "approvalDecision",
      approvalId: "approval-1",
      decision: "allow",
      remember: true,
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

  it("draws an empty group for a turn whose commands left nothing to list", () => {
    // A command's own changes are rows like any other record, so a turn that
    // lists nothing but ran commands keeps its group and nothing else: no note,
    // no explanation. The header's ordinal is what still ties it to the
    // conversation.
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [recordedChange({ filePath: "src/a.ts", turnIndex: 2, changeIndex: 0 })],
      [
        { index: 1, label: "ran a script", shellCommands: 3 },
        { index: 2, label: "used the file tools" },
      ],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(2);
    expect(groups[0].header.innerHTML).toContain("Turn 1");
    expect(groups[0].items.innerHTML).toBe("");
  });

  it("says nothing about itself, in the header or in a turn's rows", () => {
    // The panel used to carry a paragraph about what it could and could not
    // list. Each clause described a limitation that is gone, so there is no
    // wording left anywhere: the rows are the record.
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [recordedChange({ filePath: "src/a.ts", turnIndex: 3, changeIndex: 0 })],
      [
        { index: 1, label: "ran a script", shellCommands: 2 },
        { index: 2, label: "ran another", shellCommands: 1 },
        { index: 3, label: "used the file tools" },
      ],
    );
    sidebar.renderChanges();

    const panel = changesPanel.innerHTML;
    expect(panel).not.toContain('class="change-panel-hint"');
    expect(panel).not.toContain('class="change-turn-note"');
  });

  it("lists a command's own changes with nothing said beside them", () => {
    // Both provenances draw the same kind of row. A command count next to a
    // complete list was the stand-in for rows that were missing, and it is
    // gone.
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [
        recordedChange({
          filePath: "out/result.json",
          turnIndex: 1,
          changeIndex: 0,
          fromCommand: true,
        }),
      ],
      [{ index: 1, label: "ran a script", shellCommands: 2 }],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.innerHTML).toContain("out/result.json");
    expect(groups[0].items.innerHTML).not.toContain('class="change-turn-note"');
  });

  it("still draws the panel, not the empty state, for a scripted session", () => {
    // No records anywhere, and a turn that ran commands: an empty group is a
    // truer answer about this session than "no file changes".
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [],
      [{ index: 1, label: "edited files with a script", shellCommands: 1 }],
    );
    sidebar.renderChanges();

    expect(changesPanel.innerHTML).not.toContain("work-empty");
    expect(drawnGroups(changesPanel)).toHaveLength(1);
  });

  it("leaves a turn that neither changed nor scripted anything out", () => {
    const { changesPanel, sidebar } = createHarness();
    sidebar.setChangesState(
      [recordedChange({ filePath: "src/a.ts", turnIndex: 2, changeIndex: 0 })],
      [
        { index: 1, label: "nothing here" },
        { index: 2, label: "this one changed a file" },
      ],
    );
    sidebar.renderChanges();

    const groups = drawnGroups(changesPanel);
    expect(groups).toHaveLength(1);
    expect(groups[0].header.innerHTML).toContain("Turn 2");
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
  const ALL = ["work", "changes", "fleet", "tasks", "agents", "skills"] as const;

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

/** One saved session as `GET /v1/sessions` hands it over. */
function savedSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Session ${id}`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    message_count: 4,
    total_tokens: 0,
    model: "deepseek-v4-pro",
    workspace: "/w",
    mode: "agent",
    ...overrides,
  };
}

describe("session rail fork families", () => {
  it("draws a branch under the session it was cut from, not beside it", () => {
    const { sessionRail, sidebar } = createHarness();
    // The engine lists by recency, so a branch arrives ahead of its source:
    // painting that order is what left two identically-titled rows side by
    // side with nothing saying which came from which.
    sidebar.setSessions([
      savedSession("child", {
        parent_session_id: "parent",
        updated_at: "2026-09-18T00:00:00Z",
        forked_from_message_count: 6,
      }),
      savedSession("parent"),
    ]);

    sidebar.renderSessions();

    expect(sessionRailOrder(sessionRail)).toEqual(["0:parent", "1:child"]);
    const child = sessionRail.querySelector('[data-session-id="child"]')!;
    expect(child.className).toContain("session-fork-child");
    // The branch inherits the source's first user message, so the engine
    // derives the same title for both; the chevron is what tells them apart.
    expect(child.children[0].children.map((c) => c.textContent).join("")).toBe("↳Session child");
    const badge = child.querySelector(".session-fork-badge")!;
    expect(badge.textContent).toBe("Fork");
    // The badge names the source and how much of it the branch kept.
    expect(badge.title).toContain("Session parent");
    expect(badge.title).toContain("6");
    // The source carries no badge of its own: it is the row the chevron points
    // away from.
    expect(
      sessionRail.querySelector('[data-session-id="parent"]')!.querySelector(".session-fork-badge"),
    ).toBeNull();
  });

  it("sorts a family where its newest member sorts", () => {
    const { sessionRail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("parent", { updated_at: "2026-09-17T00:00:00Z" }),
      savedSession("other", { updated_at: "2026-09-18T00:00:00Z" }),
      savedSession("child", { parent_session_id: "parent", updated_at: "2026-09-19T00:00:00Z" }),
    ]);

    sidebar.renderSessions();

    // The branch is the newest row in the store, so the family it belongs to
    // is what moves to the top — with the source leading it, not the branch.
    expect(sessionRailOrder(sessionRail)).toEqual(["0:parent", "1:child", "0:other"]);
  });

  it("keeps a branch whose source is not in the list, and says so", () => {
    const { sessionRail, sidebar } = createHarness();
    sidebar.setSessions([savedSession("child", { parent_session_id: "parent-abcdef123" })]);

    sidebar.renderSessions();

    // A search query, the workspace toggle or a deletion can leave the source
    // out of the list; none of them is a reason to drop the row itself.
    expect(sessionRailOrder(sessionRail)).toEqual(["0:child"]);
    const child = sessionRail.querySelector('[data-session-id="child"]')!;
    expect(child.className).not.toContain("session-fork-child");
    expect(child.querySelector(".session-fork-origin")!.textContent).toContain("parent-a");
    expect(child.querySelector(".session-fork-badge")).toBeTruthy();
  });

  it("draws a branch of a branch one level deeper", () => {
    const { sessionRail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("grandchild", { parent_session_id: "child" }),
      savedSession("child", { parent_session_id: "parent" }),
      savedSession("parent"),
    ]);

    sidebar.renderSessions();

    expect(sessionRailOrder(sessionRail)).toEqual(["0:parent", "1:child", "2:grandchild"]);
  });

  it("leaves a session with nothing to nest exactly as it was", () => {
    const { sessionRail, sidebar } = createHarness();
    sidebar.setSessions([savedSession("plain")]);

    sidebar.renderSessions();

    expect(sessionRailOrder(sessionRail)).toEqual(["0:plain"]);
    expect(sessionRail.children).toHaveLength(1);
    expect(sessionRail.querySelector(".session-forks")).toBeNull();
    expect(sessionRail.querySelector(".session-fork-badge")).toBeNull();
    expect(sessionRail.querySelector(".session-fork-origin")).toBeNull();
  });

  it("keeps both rows on the rail when the recorded lineage loops", () => {
    const { sessionRail, sidebar } = createHarness();
    // A corrupted pair naming each other as its source must not attach every
    // row to another one and leave the rail with no root to draw.
    sidebar.setSessions([
      savedSession("a", { parent_session_id: "b" }),
      savedSession("b", { parent_session_id: "a" }),
    ]);

    sidebar.renderSessions();

    const drawn = sessionRailOrder(sessionRail).map((entry) => entry.split(":")[1]);
    expect(drawn.sort()).toEqual(["a", "b"]);
  });

  it("draws ids that collide with Object.prototype instead of swallowing them", () => {
    const { sessionRail, sidebar } = createHarness();
    // Session ids are the engine's, but nothing guarantees they are safe as
    // plain object keys: a map built with `{}` swallows the write for an id of
    // "__proto__" and the row disappears from the rail.
    sidebar.setSessions([
      savedSession("__proto__"),
      savedSession("constructor", { parent_session_id: "__proto__" }),
    ]);

    sidebar.renderSessions();

    expect(sessionRailOrder(sessionRail)).toEqual(["0:__proto__", "1:constructor"]);
  });

  it("re-renders a family without duplicating its rows or its group", () => {
    const { sessionRail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("parent"),
      savedSession("child", { parent_session_id: "parent" }),
      savedSession("other"),
    ]);

    // Every session-list message repaints the rail, so this is the normal path
    // rather than an edge case — and the nested group is new state that has to
    // be cleared with the rows.
    sidebar.renderSessions();
    sidebar.renderSessions();

    expect(sessionRailOrder(sessionRail)).toEqual(["0:parent", "1:child", "0:other"]);
    expect(sessionRail.querySelectorAll(".session-forks")).toHaveLength(1);
  });

  it("still loads and deletes a row drawn as a branch", () => {
    const { sessionRail, sidebar, postMessages } = createHarness();
    sidebar.setSessions([
      savedSession("parent"),
      savedSession("child", { parent_session_id: "parent" }),
    ]);
    sidebar.renderSessions();

    const child = sessionRail.querySelector('[data-session-id="child"]')!;
    child.dispatch("click", { stopPropagation: () => {} });
    expect(postMessages).toContainEqual({ type: "loadSession", sessionId: "child" });

    const del = child.querySelector(".session-delete-btn")!;
    del.dispatch("click", { stopPropagation: () => {} });
    expect(postMessages).toContainEqual({
      type: "deleteSession",
      sessionId: "child",
      sessionTitle: "Session child",
    });
  });
});

/** One thread row, found the way a reader finds it: by the thread it names. */
function threadRow(rail: FakeElement, id: string): FakeElement {
  return rail.querySelector(`.thread-item[data-thread-id="${id}"]`)!;
}

describe("thread rail branch lineage", () => {
  it("says inline which conversation a live thread was branched from", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("sess-source", { title: "Tidy the login flow" }),
      savedSession("sess-branch", {
        title: "Tidy the login flow",
        parent_session_id: "sess-source",
        forked_from_message_count: 6,
      }),
    ]);
    sidebar.setThreads([{ ...threadSummary("thr-branch"), session_id: "sess-branch" }]);

    sidebar.renderThreads();

    const line = threadRow(rail, "thr-branch").querySelector(".thread-fork-origin")!;
    expect(line.textContent).toBe("Branched from “Tidy the login flow”");
    // How much the source held at the cut is the detail, not the headline.
    expect(line.title).toContain("6");
  });

  it("names the source by its live thread when the rail holds it", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("sess-source", { title: "Saved words" }),
      savedSession("sess-branch", { parent_session_id: "sess-source" }),
    ]);
    sidebar.setThreads([
      { ...threadSummary("thr-branch"), session_id: "sess-branch" },
      { ...threadSummary("thr-source"), title: "Live words", session_id: "sess-source" },
    ]);

    sidebar.renderThreads();

    // The row a reader can click is the one that should be named.
    const branch = threadRow(rail, "thr-branch");
    expect(branch.querySelector(".thread-fork-origin")!.textContent).toBe(
      "Branched from “Live words”",
    );
    // The source is a conversation in its own right, not a branch of anything.
    expect(threadRow(rail, "thr-source").querySelector(".thread-fork-origin")).toBeNull();
  });

  it("falls back to the id when the source is in neither listing", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setSessions([
      savedSession("sess-branch", { parent_session_id: "sess-gone-9f8e7d6c" }),
    ]);
    sidebar.setThreads([{ ...threadSummary("thr-branch"), session_id: "sess-branch" }]);

    sidebar.renderThreads();

    const line = threadRow(rail, "thr-branch").querySelector(".thread-fork-origin")!;
    expect(line.textContent).toContain("sess-gon");
    expect(line.textContent).toContain("not in this list");
  });

  it("marks nothing it cannot name", () => {
    const { rail, sidebar } = createHarness();
    sidebar.setSessions([savedSession("sess-plain")]);
    sidebar.setThreads([
      { ...threadSummary("thr-plain"), session_id: "sess-plain" },
      threadSummary("thr-unbound"),
      // An id that names a member of Object.prototype must not be answered by
      // Object's own, which is how a row grows a "Branched from undefined".
      threadSummary("constructor"),
    ]);

    sidebar.renderThreads();

    // A thread that was never branched from anything has no line, and neither
    // has one whose session this client cannot see: a mark that names no
    // source is a claim the rail cannot back.
    expect(threadRow(rail, "thr-plain").querySelector(".thread-fork-origin")).toBeNull();
    expect(threadRow(rail, "thr-unbound").querySelector(".thread-fork-origin")).toBeNull();
    expect(threadRow(rail, "constructor").querySelector(".thread-fork-origin")).toBeNull();
  });

  it("still opens the thread the line is drawn under", () => {
    const { rail, sidebar, postMessages } = createHarness();
    sidebar.setSessions([
      savedSession("sess-source", { title: "Tidy the login flow" }),
      savedSession("sess-branch", { parent_session_id: "sess-source" }),
    ]);
    sidebar.setThreads([{ ...threadSummary("thr-branch"), session_id: "sess-branch" }]);
    sidebar.renderThreads();

    threadRow(rail, "thr-branch").dispatch("click", { stopPropagation: () => {} });

    expect(postMessages).toContainEqual({ type: "loadThread", threadId: "thr-branch" });
  });
});
