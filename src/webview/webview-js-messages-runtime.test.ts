/**
 * Runtime test for the Changes panel's Locate action.
 *
 * The sidebar lists one row per recorded change and can scroll the stream back
 * to the card that change came from. Both sides name the change the same way
 * (the engine's call id, or the file path plus the change's index in that
 * file's history), and the lookup is a DOM walk — which a string assertion on
 * the generated script cannot check. This drives the real IIFE in a DOM
 * stand-in, the same way the sidebar and event-handler suites do.
 *
 * Executing the whole IIFE is deliberate: a runtime error anywhere in the
 * webview script block stops the entire block (see AGENTS.md), so a passing run
 * here is also the guard that this module still initialises at all.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { getMessagesScript } from "./webview-js-messages";
import { makeTr } from "./webview-test-helpers";

/** `className` is the source of truth, as it is in a browser: the scripts
 *  under test set one and query the other, so a set that drifted from the
 *  string would hide exactly the wiring these tests exist to check. */
class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  private values(): string[] {
    return this.owner.className.split(/\s+/).filter(Boolean);
  }

  private write(values: string[]): void {
    this.owner.className = values.join(" ");
  }

  contains(name: string): boolean {
    return this.values().includes(name);
  }

  add(name: string): void {
    if (!this.contains(name)) this.write([...this.values(), name]);
  }

  remove(name: string): void {
    this.write(this.values().filter((value) => value !== name));
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force === undefined ? !this.contains(name) : force;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

/** `.a.b`, optionally followed by one `[attr="value"]` pair; anything else
 *  answers nothing. That covers every selector the messages module asks for on
 *  the conversation element. */
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
  public id = "";
  public classList = new FakeClassList(this);
  public textContent = "";
  public value = "";
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public scrollTop = 0;
  public scrollHeight = 0;
  public clientHeight = 0;
  public offsetWidth = 0;
  public offsetHeight = 0;
  public offsetTop = 0;
  /** Viewport top the scroll maths reads; 0 for the container itself. */
  public rectTop = 0;
  public parentElement: FakeElement | null = null;
  public children: FakeElement[] = [];
  public scrollCalls: Array<Record<string, unknown>> = [];
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
    // `addMessage` builds a bubble as an HTML string and then looks pieces of
    // it up by class (`el.querySelector('.message-body')`). Hand the string a
    // flat stand-in per `class`/`id` attribute so those lookups resolve;
    // nested markup is flattened, which is all the elements this module
    // queries by class need.
    for (const match of value.matchAll(/class="([^"]+)"|id="([^"]+)"/g)) {
      const element = new FakeElement();
      if (match[1]) element.className = match[1];
      if (match[2]) element.id = match[2];
      element.parentElement = this;
      this.children.push(element);
    }
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    this.listeners.set(name, handler);
  }

  dispatch(name: string, event: unknown = {}): void {
    this.listeners.get(name)?.(event);
  }

  appendChild(child: FakeElement): FakeElement {
    this.detach(child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parentElement) this.parentElement.detach(this);
    this.parentElement = null;
  }

  closest(selector?: string): FakeElement | null {
    let node: FakeElement | null = this.parentElement;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  getBoundingClientRect(): { top: number; height: number } {
    return { top: this.rectTop, height: this.offsetHeight };
  }

  scrollTo(options: Record<string, unknown>): void {
    this.scrollCalls.push(options);
    this.scrollTop = Number(options.top ?? this.scrollTop);
  }

  focus(): void {}

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

  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (value: unknown) => String(value ?? ""),
    __wvVscode: { postMessage: () => {} },
    __wvDiffStore: new Map<string, string>(),
    __wvDiffIdCounter: { value: 0 },
    __wvApiCapabilities: {},
    addEventListener: () => {},
  };

  // Every element the script creates, so a lookup by id (`msg-<id>` for a
  // message it drew, the way `renderPlanApproveButton` and
  // `renderTurnForkAction` find their host) resolves to the element that is
  // actually in the tree instead of a fresh detached one.
  const created: FakeElement[] = [];
  const documentObj = {
    getElementById: (id: string) => created.find((el) => el.id === id) ?? getEl(id),
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    },
    querySelectorAll: () => [] as FakeElement[],
    addEventListener: () => {},
  };

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    setTimeout: () => 0,
    clearTimeout: () => {},
    // `addMessage` schedules its nav-dot refresh on a frame; the stand-in only
    // has to exist, since nothing in these tests waits for a frame.
    requestAnimationFrame: () => 0,
    console,
  });
  vm.runInContext(getMessagesScript(makeTr()), context);

  const messagesEl = getEl("messages");
  const messages = windowObj.__wvMessages as Record<string, any>;

  /** A change card as `renderFileChangeCard` tags one. */
  const addCard = (attrs: { path: string; index?: number | string; callId?: string }): FakeElement => {
    const card = new FakeElement();
    card.className = "file-change-card";
    card.setAttribute("data-fc-path", attrs.path);
    card.setAttribute("data-fc-index", attrs.index === undefined ? "" : String(attrs.index));
    card.setAttribute("data-fc-call-id", attrs.callId ?? "");
    messagesEl.appendChild(card);
    return card;
  };

  return { messages, messagesEl, addCard, window: windowObj };
}

describe("revealFileChangeCard", () => {
  it("initialises the module and exposes the reveal action", () => {
    const { messages } = createHarness();
    // A throw anywhere in the IIFE would have left this undefined.
    expect(typeof messages.revealFileChangeCard).toBe("function");
    expect(typeof messages.renderFileChangeCard).toBe("function");
  });

  it("returns markup the sidebar's Locate action can resolve", () => {
    const { messages } = createHarness();
    // The half the DOM stand-in cannot check: the card this module actually
    // renders has to carry the attributes revealFileChangeCard matches on.
    const html = messages.renderFileChangeCard({
      filePath: "src/a.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      diff: "--- a\n+++ b\n",
      changeIndex: 2,
      callId: "call-7",
      toolName: "edit",
    });

    expect(html).toContain('class="file-change-card" data-fc-path="src/a.ts"');
    expect(html).toContain('data-fc-index="2"');
    expect(html).toContain('data-fc-call-id="call-7"');
  });

  it("leaves the identity empty on a recording that carries neither", () => {
    const { messages } = createHarness();
    // An older recording: no call id, no index. The card must still tag the
    // path, which is the fallback the lookup falls back to.
    const html = messages.renderFileChangeCard({
      filePath: "old.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      diff: "--- a\n+++ b\n",
      toolName: "edit",
    });

    expect(html).toContain('data-fc-path="old.ts"');
    expect(html).toContain('data-fc-index=""');
    expect(html).toContain('data-fc-call-id=""');
  });

  it("lands on the change whose call id the row carries", () => {
    const { messages, addCard } = createHarness();
    const first = addCard({ path: "src/a.ts", index: 0, callId: "call-1" });
    const second = addCard({ path: "src/a.ts", index: 1, callId: "call-2" });
    const other = addCard({ path: "src/b.ts", index: 0, callId: "call-3" });

    const found = messages.revealFileChangeCard({
      filePath: "src/a.ts",
      callId: "call-2",
      changeIndex: 1,
    });

    expect(found).toBe(true);
    // One file changing twice must not send the reader to the wrong card.
    expect(second.classList.contains("jump-flash")).toBe(true);
    expect(first.classList.contains("jump-flash")).toBe(false);
    expect(other.classList.contains("jump-flash")).toBe(false);
  });

  it("scrolls the conversation to the card it found", () => {
    const { messages, messagesEl, addCard } = createHarness();
    const card = addCard({ path: "src/a.ts", index: 0, callId: "call-1" });
    card.rectTop = 240;

    messages.revealFileChangeCard({ filePath: "src/a.ts", callId: "call-1", changeIndex: 0 });

    expect(messagesEl.scrollCalls).toHaveLength(1);
    expect(messagesEl.scrollCalls[0].behavior).toBe("smooth");
    expect(messagesEl.scrollTop).toBeGreaterThan(0);
  });

  it("falls back to the path and index when the recording has no call id", () => {
    const { messages, addCard } = createHarness();
    const first = addCard({ path: "src/a.ts", index: 0 });
    const second = addCard({ path: "src/a.ts", index: 1 });

    const found = messages.revealFileChangeCard({ filePath: "src/a.ts", changeIndex: 1 });

    expect(found).toBe(true);
    expect(second.classList.contains("jump-flash")).toBe(true);
    expect(first.classList.contains("jump-flash")).toBe(false);
  });

  it("prefers the later card when two turns share a path and index", () => {
    const { messages, addCard } = createHarness();
    // A recording old enough to carry no call id: an earlier turn left a card
    // with the same path and index, and the panel lists the current turn's
    // change. The stream is in chronological order, so the current turn's card
    // is the one appended last.
    const older = addCard({ path: "src/a.ts", index: 0 });
    const current = addCard({ path: "src/a.ts", index: 0 });

    expect(messages.revealFileChangeCard({ filePath: "src/a.ts", changeIndex: 0 })).toBe(true);
    expect(current.classList.contains("jump-flash")).toBe(true);
    expect(older.classList.contains("jump-flash")).toBe(false);
  });

  it("falls back to the file when neither identity is known", () => {
    const { messages, addCard } = createHarness();
    const first = addCard({ path: "src/a.ts", index: 0 });
    addCard({ path: "src/b.ts", index: 0 });

    // A row with no index at all: landing on the file beats landing nowhere.
    expect(messages.revealFileChangeCard({ filePath: "src/a.ts" })).toBe(true);
    expect(first.classList.contains("jump-flash")).toBe(true);
  });

  it("reports a miss instead of scrolling to an unrelated card", () => {
    const { messages, messagesEl, addCard } = createHarness();
    const card = addCard({ path: "src/a.ts", index: 0, callId: "call-1" });

    expect(messages.revealFileChangeCard({ filePath: "src/gone.ts", callId: "call-9" })).toBe(false);
    expect(messages.revealFileChangeCard(null)).toBe(false);
    expect(card.classList.contains("jump-flash")).toBe(false);
    expect(messagesEl.scrollCalls).toHaveLength(0);
  });
});

describe("addMessage system notes", () => {
  it("draws a system message as a note, not a chat turn", () => {
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "note-turn_compact",
      role: "system",
      content: "Compaction complete: 12 → 5 messages",
      status: "complete",
      timestamp: 1,
    });

    // The same markup the live 'info' message produces, so a reloaded
    // transcript shows the line the user already saw.
    const note = messagesEl.children[messagesEl.children.length - 1];
    expect(note.className).toBe("system-message");
    expect(note.innerHTML).toContain('class="msg-label note"');
    expect(note.innerHTML).toContain("Compaction complete: 12 → 5 messages");
    // A chat turn is tagged `message <role>`; a note must not be, or the
    // transcript would show a "system" speaker bubble instead of a note.
    expect(note.className.startsWith("message ")).toBe(false);
  });

  it("hangs a compaction summary off its note, collapsed", () => {
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "note-turn_c",
      role: "system",
      content: "Compaction complete: 96 → 9 messages",
      status: "complete",
      timestamp: 1,
      compactionSummary: "The user asked for X.",
    });

    // A details element, so the expand costs no script and no state to keep in
    // sync; the body is the model's own handoff record and can be very long.
    const note = messagesEl.children[messagesEl.children.length - 1];
    expect(note.innerHTML).toContain('<details class="compaction-summary">');
    expect(note.innerHTML).toContain("Compaction summary");
    expect(note.innerHTML).toContain("The user asked for X.");
  });

  it("renders no summary block when the note carries none", () => {
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "note-plain",
      role: "system",
      content: "Compaction complete: 96 → 9 messages",
      status: "complete",
      timestamp: 1,
    });

    const note = messagesEl.children[messagesEl.children.length - 1];
    expect(note.innerHTML).not.toContain("details");
  });
});

describe("branch from a turn", () => {
  /** The message that closes a turn, as `loadHistory` builds one. */
  const answerBubble = (overrides: Record<string, unknown> = {}) => ({
    id: "assistant-turn_1",
    role: "assistant",
    content: "the answer",
    status: "complete",
    timestamp: 2,
    branchTurnId: "turn_1",
    ...overrides,
  });

  /** A transcript holding one turn, drawn from history. */
  const drawTurn = (
    harness: ReturnType<typeof createHarness>,
    overrides: Record<string, unknown> = {},
  ) => {
    harness.messages.addMessage(
      { id: "user-turn_1", role: "user", content: "the question", status: "complete", timestamp: 1 },
      true,
    );
    harness.messages.addMessage(answerBubble(overrides), true);
  };

  it("offers the action under the answer that closes a turn, and posts the turn id", () => {
    const harness = createHarness();
    const { messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;
    const posted: Array<Record<string, unknown>> = [];
    window.__wvVscode.postMessage = (msg: Record<string, unknown>) => posted.push(msg);

    drawTurn(harness);

    const buttons = messagesEl.querySelectorAll(".turn-fork-btn");
    expect(buttons).toHaveLength(1);
    // The anchor is the engine's own turn id: nothing here counts turns or
    // positions, because the rendered transcript is not the turn list the
    // engine cuts.
    expect(buttons[0].getAttribute("data-turn-id")).toBe("turn_1");
    // The row belongs to the answer, not the question above it.
    expect(buttons[0].closest(".message")?.className).toContain("assistant");

    messagesEl.dispatch("click", { target: buttons[0] });
    expect(posted).toEqual([{ type: "forkFromTurn", turnId: "turn_1" }]);
  });

  it("keeps the action off the question and off a turn that has no anchor", () => {
    const harness = createHarness();
    const { messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;

    drawTurn(harness, { branchTurnId: undefined });

    // A viewed saved session is drawn from stored messages, not from turns, so
    // it carries no anchor to send; the question never carries one either.
    expect(messagesEl.querySelectorAll(".turn-fork-btn")).toHaveLength(0);
  });

  it("renders no dead control on an engine without the route", () => {
    const harness = createHarness();
    const { messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = false;

    // The older engines fork the last turn only, so the button's promise
    // ("continue from here") cannot be kept: it is not drawn at all rather than
    // disabled on every message.
    drawTurn(harness);

    expect(messagesEl.querySelectorAll(".turn-fork-btn")).toHaveLength(0);
  });

  it("gives a turn that just finished the row a reloaded one would carry", () => {
    const harness = createHarness();
    const { messages, messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;

    messages.addMessage(
      {
        id: "assistant-live",
        role: "assistant",
        content: "an answer sent in this session",
        status: "complete",
        timestamp: 3,
      },
      true,
    );
    // The turn id only exists once the turn is over, so the row arrives with
    // the finalize message rather than with the bubble.
    expect(messagesEl.querySelectorAll(".turn-fork-btn")).toHaveLength(0);

    messages.renderTurnForkAction("assistant-live", "turn_live");

    const buttons = messagesEl.querySelectorAll(".turn-fork-btn");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("data-turn-id")).toBe("turn_live");
  });

  it("marks the row that was clicked while the fork is being created", () => {
    const harness = createHarness();
    const { messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;
    const tr = makeTr();
    const posted: Array<Record<string, unknown>> = [];
    window.__wvVscode.postMessage = (msg: Record<string, unknown>) => posted.push(msg);

    drawTurn(harness);
    const btn = messagesEl.querySelectorAll(".turn-fork-btn")[0];
    messagesEl.dispatch("click", { target: btn });

    // The wait has nothing else to show where the click happened, so the row
    // says it is working and cannot be clicked a second time.
    expect(btn.classList.contains("is-pending")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe(tr.forkRunning);
    expect(posted).toHaveLength(1);

    messagesEl.dispatch("click", { target: btn });
    expect(posted).toHaveLength(1);
  });

  it("releases every pending row when the fork settles", () => {
    const harness = createHarness();
    const { messages, messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;
    const tr = makeTr();

    drawTurn(harness);
    const btn = messagesEl.querySelectorAll(".turn-fork-btn")[0];
    messagesEl.dispatch("click", { target: btn });

    messages.clearPendingTurnFork();

    // A failed fork leaves the transcript exactly as it was: the row is a
    // branch point again, with nothing claiming a wait that ended.
    expect(btn.classList.contains("is-pending")).toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBe("false");
    expect(btn.getAttribute("title")).toBe(tr.forkFromTurnTooltip);

    const posted: Array<Record<string, unknown>> = [];
    window.__wvVscode.postMessage = (msg: Record<string, unknown>) => posted.push(msg);
    messagesEl.dispatch("click", { target: btn });
    expect(posted).toEqual([{ type: "forkFromTurn", turnId: "turn_1" }]);
  });

  it("does not stack a second row on a bubble that already has one", () => {
    const harness = createHarness();
    const { messages, messagesEl, window } = harness;
    window.__wvApiCapabilities.forkFromTurn = true;

    drawTurn(harness);
    messages.renderTurnForkAction("assistant-turn_1", "turn_1");

    // A reload plus a late finalize must not offer the same branch point twice.
    expect(messagesEl.querySelectorAll(".turn-fork-btn")).toHaveLength(1);
  });
});
