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
import { getUtilitiesScript } from "./webview-js-utilities";
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
  public tagName = "";
  /** How many times the module asked this element to take focus. */
  public focusCalls = 0;
  public classList = new FakeClassList(this);
  public textContent = "";
  public value = "";
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public scrollTop = 0;
  public scrollHeight = 0;
  public clientHeight = 0;
  /** What the browser reflects the `hidden` attribute to; the pinned prompt
   *  bar is shown and hidden through it. */
  public hidden = false;
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

  /** The rail's clearing walks its children one at a time — it cannot assign
   *  innerHTML there, the rail is the element doing the clearing — so the
   *  stand-in has to offer both ends of that walk. */
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  removeChild(child: FakeElement): FakeElement {
    this.detach(child);
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

  focus(): void {
    this.focusCalls++;
  }

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

function createHarness(options: { frames?: Array<() => void> } = {}) {
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
    __wvVscode: { postMessage: (msg: Record<string, unknown>) => postMessages.push(msg) },
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
    // `addMessage` schedules its nav-dot refresh on a frame, and a jump onto a
    // row that was never painted re-anchors on the next one. Tests that wait for
    // a frame collect the callbacks; the rest only need the stand-in to exist.
    requestAnimationFrame: (callback: () => void) => {
      options.frames?.push(callback);
      return 0;
    },
    console,
  });
  // The utilities module runs first, as it does in the template: the messages
  // module formats a turn's length with the shared elapsed formatter, and a
  // stand-in here could drift from the one that ships. The helpers the rest of
  // this file asserts against are then put back as this harness's own stubs.
  vm.runInContext(getUtilitiesScript(makeTr()), context);
  windowObj.__wvEscapeHtml = (value: unknown) => String(value ?? "");
  windowObj.__wvI18n = makeTr();
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

  return { messages, messagesEl, addCard, getEl, window: windowObj, postMessages };
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

  it("marks a change a command made, so the badge cannot read as its edit", () => {
    const { messages } = createHarness();
    // The record is the difference between the restore points around one
    // call, not an edit that call's tool made. The card says so, and carries
    // the class the live redraw replaces it by.
    const html = messages.renderFileChangeCard({
      filePath: "out/result.json",
      changeType: "created",
      addedLines: 3,
      removedLines: 0,
      diff: "--- a\n+++ b\n",
      changeIndex: 0,
      callId: "call_shell",
      toolName: "exec_shell",
      fromCommand: true,
    });

    expect(html).toContain('class="file-change-card is-from-call"');
    expect(html).toContain('class="fc-source"');
    expect(html).toContain('data-fc-call-id="call_shell"');
    // The engine's patch is what puts a Diff button on the card at all: a
    // command's first paint carries paths and no patch, so the button only
    // appears once the call-change route has answered.
    expect(html).toContain('class="fc-view-diff"');
  });

  it("leaves a command's card without a Diff action until a patch exists", () => {
    const { messages } = createHarness();
    const html = messages.renderFileChangeCard({
      filePath: "out/result.json",
      changeType: "modified",
      addedLines: 0,
      removedLines: 0,
      callId: "call_shell",
      toolName: "exec_shell",
      fromCommand: true,
    });

    // Paths only — the first paint. Nothing to open, so no button that would
    // open an empty diff.
    expect(html).toContain('class="file-change-card is-from-call"');
    expect(html).not.toContain('class="fc-view-diff"');
  });

  it("draws one card per path a command changed", () => {
    const { messages } = createHarness();
    // A file tool reports one change, so it gets one card; a command's span
    // can name any number of paths, and a single card could only show one.
    const html = messages.renderToolCall("msg-1", {
      name: "exec_shell",
      input: { command: "python gen.py" },
      status: "complete",
      callId: "call_shell",
      fileChanges: [
        {
          filePath: "out/result.json",
          changeType: "created",
          addedLines: 3,
          removedLines: 0,
          callId: "call_shell",
          fromCommand: true,
        },
        {
          filePath: "build/log.txt",
          changeType: "modified",
          addedLines: 1,
          removedLines: 1,
          callId: "call_shell",
          fromCommand: true,
        },
      ],
    }, 0);

    expect(html.split('class="file-change-card is-from-call"')).toHaveLength(3);
    expect(html).toContain("out/result.json");
    expect(html).toContain("build/log.txt");
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

describe("lazy row layout", () => {
  it("reserves space for a row before the browser has painted it", () => {
    const { messages, messagesEl } = createHarness();
    messages.addMessage({ id: "m1", role: "assistant", content: "a short answer" });
    messages.addMessage({
      id: "m2",
      role: "assistant",
      content: "x".repeat(9000),
    });

    const row = (id: string) => messagesEl.children.find((el) => el.id === id)!;
    const short = String(row("msg-m1").style.containIntrinsicSize);
    const long = String(row("msg-m2").style.containIntrinsicSize);

    // The sheet skips layout for a row outside the viewport, so the row has to
    // name the space it takes until it is painted once.
    expect(short).toMatch(/^auto \d+px$/);
    expect(long).toMatch(/^auto \d+px$/);
    expect(Number(long.replace(/\D+/g, ""))).toBeGreaterThan(
      Number(short.replace(/\D+/g, "")),
    );
  });

  it("reserves space for a compaction note the same way", () => {
    const { messages, messagesEl } = createHarness();
    messages.addMessage({
      id: "n1",
      role: "system",
      content: "a compaction note",
      compactionSummary: "x".repeat(6000),
    });

    // The sheet's rule covers #messages > .system-message too, so a note
    // row has to name its space as well — without this it sits at the
    // sheet's 220px fallback wherever it is never painted.
    const note = String(
      messagesEl.children.find((el) => el.id === "msg-n1")!.style
        .containIntrinsicSize,
    );
    expect(note).toMatch(/^auto \d+px$/);
    expect(Number(note.replace(/\D+/g, ""))).toBeGreaterThan(220);
  });

  it("re-anchors a jump once the row's real height is known", () => {
    const frames: Array<() => void> = [];
    const { messages, messagesEl } = createHarness({ frames });
    messages.addMessage({ id: "m1", role: "user", content: "go" });
    messages.addMessage({ id: "m2", role: "assistant", content: "x".repeat(9000) });
    const row = messagesEl.children.find((el) => el.id === "msg-m2")!;

    // The row is far down the transcript, where it sits at its estimated height.
    row.rectTop = 4000;
    messages.scrollToMessage(row);
    expect(messagesEl.scrollCalls).toHaveLength(1);
    const first = messagesEl.scrollCalls[0].top as number;

    // Painting it reveals a taller row than the estimate, which moved it.
    row.rectTop = 4600;
    frames.splice(0).forEach((callback) => callback());

    expect(messagesEl.scrollCalls).toHaveLength(2);
    expect(messagesEl.scrollCalls[1].top as number).toBeGreaterThan(first);
    expect(messagesEl.scrollCalls[1].behavior).toBe("auto");
  });
});

describe("transcript focus", () => {
  /** A press inside a row: the module walks from the event's target up to
   *  #messages, so the target only has to hang off a real row. */
  const pressIn = (messages: Record<string, any>, messagesEl: FakeElement, target: FakeElement) => {
    messages.addMessage({ id: "m1", role: "assistant", content: "an answer" });
    const row = messagesEl.children.find((el) => el.id === "msg-m1")!;
    target.parentElement = row;
    messagesEl.dispatch("mousedown", { target });
  };

  it("takes focus when a press lands on plain text", () => {
    // The transcript has to hold focus after the press: VS Code 1.143 restores
    // the last focused element (the composer) before replaying a host copy, and
    // that focus move collapses the selection the copy was meant to take.
    const { messages, messagesEl } = createHarness();
    pressIn(messages, messagesEl, new FakeElement());
    expect(messagesEl.focusCalls).toBe(1);
  });

  it("leaves a button to take its own focus", () => {
    const { messages, messagesEl } = createHarness();
    const btn = new FakeElement();
    btn.tagName = "BUTTON";
    pressIn(messages, messagesEl, btn);
    expect(messagesEl.focusCalls).toBe(0);
  });

  it("leaves a focusable tool block to take its own focus", () => {
    // The blocks are `tabindex="0"` so a keyboard reader can scroll them; a
    // press in one must keep landing there, not on the transcript.
    const { messages, messagesEl } = createHarness();
    const block = new FakeElement();
    block.setAttribute("tabindex", "0");
    pressIn(messages, messagesEl, block);
    expect(messagesEl.focusCalls).toBe(0);
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

  it("draws a failed turn's reason as the error banner the live view used", () => {
    // The runtime records why a turn failed as an `error` item, and
    // `loadHistory` rebuilds that record as a system message carrying status
    // 'error'. It is not a note: the live view reported the same text as an
    // error banner when the turn ended, and a reload that softened it into a
    // muted line would lose the report the reload exists to keep.
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "error-item_1",
      role: "system",
      content: "HTTP 429 from upstream: quota exhausted",
      status: "error",
      timestamp: 1,
    });

    const banner = messagesEl.children[messagesEl.children.length - 1];
    expect(banner.className).toBe("error-banner");
    expect(banner.innerHTML).toContain('class="msg-label error"');
    expect(banner.innerHTML).toContain("HTTP 429 from upstream: quota exhausted");
    expect(banner.className.startsWith("message ")).toBe(false);
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

describe("message navigation rail", () => {
  /** Draw a user bubble the way the provider sends one, with its words where
   *  the rail reads them.
   *
   *  The DOM stand-in flattens a bubble's markup and keeps no text of its own,
   *  so the textContent the preview reads has to be placed by hand. */
  const drawUserBubble = (
    harness: ReturnType<typeof createHarness>,
    id: string,
    text: string,
    turnIndex?: number,
  ) => {
    harness.messages.addMessage(
      {
        id,
        role: "user",
        content: text,
        status: "complete",
        timestamp: 1,
        ...(turnIndex === undefined ? {} : { turnIndex }),
      },
      true,
    );
    const bubble = harness.messagesEl
      .querySelectorAll(".message.user")
      .find((el) => el.id === "msg-" + id)!;
    bubble.querySelector(".message-body")!.textContent = text;
  };

  /** The rail the script is drawing into, with a container that reports a
   *  height: the dots are placed proportionally, so a zero height would mean
   *  "layout is not ready" and draw nothing. */
  const railOf = (harness: ReturnType<typeof createHarness>) => {
    harness.messagesEl.scrollHeight = 1000;
    return harness.getEl("message-nav");
  };

  it("names each dot's turn the way the Changes panel numbers turns", () => {
    const harness = createHarness();
    const rail = railOf(harness);

    drawUserBubble(harness, "user-1", "run the tests", 1);
    // A steer is a second bubble inside the turn above it, not a turn of its
    // own, so it wears that turn's number rather than the next one.
    drawUserBubble(harness, "user-2", "focus on vitest", 1);
    drawUserBubble(harness, "user-3", "now the docs", 2);
    harness.messages.updateNavDots();

    expect(rail.children).toHaveLength(3);
    expect(rail.children.map((dot) => dot.getAttribute("data-preview"))).toEqual([
      "Turn 1 \u00B7 run the tests",
      "Turn 1 \u00B7 focus on vitest",
      "Turn 2 \u00B7 now the docs",
    ]);
  });

  it("shows the words alone for a bubble the provider could not place", () => {
    const harness = createHarness();
    const rail = railOf(harness);

    // No turnIndex: an older payload, or a message that belongs to no group.
    // A number counted out of the user messages here would be a different
    // count wearing the panel's label.
    drawUserBubble(harness, "user-1", "no turn recorded");
    harness.messages.updateNavDots();

    expect(rail.children[0].getAttribute("data-preview")).toBe("no turn recorded");
  });

  it("names the turn alone when the bubble carries no words", () => {
    const harness = createHarness();
    const rail = railOf(harness);

    // An attachment-only send has no text to preview, and "Turn 4 · " with
    // nothing after the separator reads as a tooltip that lost its words.
    drawUserBubble(harness, "user-1", "", 4);
    harness.messages.updateNavDots();

    expect(rail.children[0].getAttribute("data-preview")).toBe("Turn 4");
  });

  it("keeps the nearest dot lit across a rebuild", () => {
    const harness = createHarness();
    const rail = railOf(harness);

    drawUserBubble(harness, "user-1", "the first question", 1);
    harness.messages.updateNavDots();
    expect(rail.children[0].classList.contains("active")).toBe(true);

    // Every addMessage() asks for a rail rebuild on the next frame, and this
    // is the frame it asked for (the stand-in's frames do not run on their
    // own). The marker used to be carried over from the draw before, so it
    // matched the dot about to be marked and the highlight was silently
    // dropped — it only came back once a scroll moved the nearest message.
    // The rebuild starts from nothing now.
    drawUserBubble(harness, "user-2", "and the second one", 2);
    harness.messages.updateNavDots();

    expect(rail.children).toHaveLength(2);
    expect(rail.children[0].classList.contains("active")).toBe(true);
  });

  it("empties the rail when the transcript it mirrors is replaced", () => {
    const harness = createHarness();
    const rail = railOf(harness);
    drawUserBubble(harness, "user-1", "the old conversation", 1);
    harness.messages.updateNavDots();
    expect(rail.children).toHaveLength(1);

    // What a new session does: the container is emptied and the fresh one has
    // no messages yet, so the dots have to be taken down with it — the rail's
    // CSS only hides an empty rail, it cannot notice the messages underneath
    // are gone.
    harness.messagesEl.innerHTML = "";
    harness.messages.clearNavDots();

    expect(rail.children).toHaveLength(0);
  });

  it("empties the rail itself when a rebuilt transcript has no user messages", () => {
    const harness = createHarness();
    const rail = railOf(harness);
    drawUserBubble(harness, "user-1", "the old conversation", 1);
    harness.messages.updateNavDots();

    // A rebuild that draws nothing (a load of a thread with no turns) reaches
    // no addMessage, so the rebuild has to clear the rail on its own.
    harness.messagesEl.innerHTML = "";
    harness.messages.updateNavDots();

    expect(rail.children).toHaveLength(0);
  });
});

/**
 * The card actions in the conversation: Diff, Open, Revert.
 *
 * These are the buttons a change card carries in the stream, and they are
 * routed by one delegated click listener on the conversation element. That
 * listener is the only place the routing exists — an earlier panel's own copies
 * of the Diff and Open branches were left behind for months after their
 * renderer was deleted, unreachable and unexercised — so the survivors are
 * pinned here, against buttons read back out of the markup the module actually
 * renders.
 */
describe("change-card actions", () => {
  /** The buttons `renderFileChangeCard` wrote, class by class. Read out of the
   *  markup rather than hand-built: a renderer that stops emitting an attribute
   *  must fail here, because the click handler reads exactly those attributes. */
  function buttonsIn(renderedHtml: string, className: string): FakeElement[] {
    const tags = renderedHtml.match(new RegExp(`<button[^>]*${className}[^>]*>`, "g")) ?? [];
    return tags.map((tag) => {
      const button = new FakeElement();
      button.className = className;
      for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
        button.setAttribute(name, value);
      }
      return button;
    });
  }

  const change = {
    filePath: "src/a.ts",
    changeType: "modified" as const,
    addedLines: 1,
    removedLines: 1,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    changeIndex: 3,
    callId: "call-7",
    toolName: "edit",
  };

  it("opens the diff the card is holding, keyed by the card's own key", () => {
    const harness = createHarness();
    const html = harness.messages.renderFileChangeCard(change);
    const [button] = buttonsIn(html, "fc-view-diff");
    expect(button).toBeTruthy();

    harness.messagesEl.dispatch("click", { target: button });

    const opened = harness.postMessages.filter((message) => message.type === "openDiff");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ filePath: "src/a.ts", changeIndex: 3 });
    // The patch travels from the card's own key in the shared store. A card
    // that minted a key nothing wrote would arrive as a bare path, and the host
    // could only open the file — the failure this routing exists to avoid.
    expect(opened[0].diff).toBe(change.diff);
  });

  it("leaves the diff store holding one entry per card, however often it draws", () => {
    const harness = createHarness();
    const store = harness.window.__wvDiffStore as Map<string, string>;
    harness.messages.renderFileChangeCard(change);
    harness.messages.renderFileChangeCard(change);
    // Keys are minted per draw, so two draws are two entries — the point is
    // that each card reads back its own patch, not that the map is small.
    expect(store.size).toBe(2);
    const second = buttonsIn(harness.messages.renderFileChangeCard(change), "fc-view-diff")[0];
    harness.messagesEl.dispatch("click", { target: second });
    const opened = harness.postMessages.filter((message) => message.type === "openDiff");
    expect(opened[0].diff).toBe(change.diff);
  });

  it("opens the file itself from Open, and asks for no diff", () => {
    const harness = createHarness();
    const [button] = buttonsIn(harness.messages.renderFileChangeCard(change), "fc-open-file");
    expect(button).toBeTruthy();

    harness.messagesEl.dispatch("click", { target: button });

    expect(harness.postMessages.filter((message) => message.type === "openFile")).toEqual([
      { type: "openFile", filePath: "src/a.ts" },
    ]);
    expect(harness.postMessages.filter((message) => message.type === "openDiff")).toEqual([]);
  });

  it("reverts the change the card names, not merely the file", () => {
    const harness = createHarness();
    // Revert is offered only where the engine supports it, so the card draws
    // the live button — which is the one whose routing this asserts.
    harness.window.__wvApiCapabilities.revertFileChange = true;
    const [button] = buttonsIn(harness.messages.renderFileChangeCard(change), "fc-revert");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBeNull();

    harness.messagesEl.dispatch("click", { target: button });

    const reverted = harness.postMessages.filter((message) => message.type === "revertFileChange");
    expect(reverted).toHaveLength(1);
    // One file can change several times: the call id is what keeps a revert on
    // the change the reader is looking at.
    expect(reverted[0]).toMatchObject({
      filePath: "src/a.ts",
      changeType: "modified",
      callId: "call-7",
    });
    expect(reverted[0].diff).toBe(change.diff);
  });

  it("asks for nothing when the engine offers no single-file revert", () => {
    const harness = createHarness();
    // Capability off: the card still shows Revert, marked unavailable, and a
    // press on it must reach no host call at all.
    const [button] = buttonsIn(harness.messages.renderFileChangeCard(change), "fc-revert");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");

    harness.messagesEl.dispatch("click", { target: button });

    expect(harness.postMessages).toEqual([]);
  });

  it("does nothing for a click on a class no card carries", () => {
    // The shape the deleted `work-fc-*` branches used to answer: a click on
    // something that is not a card action must post nothing at all.
    const harness = createHarness();
    const stray = new FakeElement();
    stray.className = "work-fc-view-diff";
    stray.setAttribute("data-file-path", "src/a.ts");

    harness.messagesEl.dispatch("click", { target: stray });

    expect(harness.postMessages).toEqual([]);
  });
});

describe("addMessage steer badges", () => {
  it("labels guidance the runtime dropped as not delivered", () => {
    // A steer the engine discarded before the model read it is still an item
    // in the store. Rendering it with the delivered badge promised something
    // the runtime says did not happen, so the row carries its own label and
    // the bubble steps out of the accent fill.
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "user-steer-dropped",
      role: "user",
      content: "also the docs",
      status: "complete",
      timestamp: 1,
      steered: true,
      undelivered: true,
    });

    const bubble = messagesEl.children[messagesEl.children.length - 1];
    expect(bubble.className).toBe("message user steered undelivered");
    expect(bubble.innerHTML).toContain("steer-badge undelivered");
    expect(bubble.innerHTML).toContain("not delivered");
    expect(bubble.innerHTML).not.toContain('class="steer-badge" title');
    // The bubble is still a real user turn with a body to draw the words into,
    // not a note: the text itself is asserted where the rebuild produces it.
    expect(bubble.querySelector(".message-body")).toBeTruthy();
  });

  it("keeps the delivered badge on guidance the engine accepted", () => {
    const { messages, messagesEl } = createHarness();

    messages.addMessage({
      id: "user-steer-kept",
      role: "user",
      content: "focus on vitest",
      status: "complete",
      timestamp: 1,
      steered: true,
    });

    const bubble = messagesEl.children[messagesEl.children.length - 1];
    expect(bubble.className).toBe("message user steered");
    expect(bubble.innerHTML).toContain('class="steer-badge"');
    expect(bubble.innerHTML).not.toContain("undelivered");
  });
});

describe("renderTurnMeta", () => {
  /** The quiet line under an answer that closes a turn, read off the bubble
   *  the module actually built. */
  function metaFor(msg: Record<string, unknown>): FakeElement | null {
    const { messages, messagesEl } = createHarness();
    messages.addMessage({ role: "assistant", content: "an answer", status: "complete", timestamp: 1, ...msg });
    const bubble = messagesEl.children[messagesEl.children.length - 1];
    return bubble.querySelector(".usage-info");
  }

  it("states the turn's own length beside what it spent", () => {
    const meta = metaFor({
      id: "m1",
      usage: { input_tokens: 1200, output_tokens: 340 },
      durationMs: 192000,
    });

    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain("\u23F1 3m12s");
    expect(meta?.textContent).toContain("\u21911200 \u2193340");
    expect(meta?.getAttribute("title")).toBe("How long this turn took");
  });

  it("keeps the token chip alone when the engine timed no turn", () => {
    // An adopted turn the runtime never measured, or one older than the field.
    const meta = metaFor({ id: "m2", usage: { input_tokens: 10, output_tokens: 2 } });

    expect(meta?.textContent).toBe("\u219110 \u21932");
    expect(meta?.getAttribute("title")).toBeNull();
  });

  it("draws nothing at all when there is neither a length nor usage", () => {
    expect(metaFor({ id: "m3" })).toBeNull();
  });

  it("does not draw a negative or unparseable length", () => {
    expect(metaFor({ id: "m4", durationMs: -5, usage: { input_tokens: 1, output_tokens: 1 } })?.textContent)
      .toBe("\u21911 \u21931");
  });
});

describe("pinned turn prompt", () => {
  /** The bar names the prompt of the turn the reader is inside once that
   *  prompt has scrolled above the transcript's top edge. The harness has no
   *  layout, so a row's vertical extent is set by hand (rectTop/offsetHeight). */
  function staged() {
    const frames: Array<() => void> = [];
    const harness = createHarness({ frames });
    const { messages, messagesEl, getEl } = harness;
    const bar = getEl("turn-context");
    const barText = getEl("turn-context-text");
    const barTurn = getEl("turn-context-turn");

    // The shipped markup carries `hidden`; the stand-in starts from nothing,
    // so say what the template says.
    bar.hidden = true;

    // A laid-out transcript: updateNavDots re-schedules itself for as long as
    // the container still has no scroll height (it is waiting for layout), so
    // leaving this at 0 would turn every frame drain into an endless loop
    // rather than a test result.
    messagesEl.scrollHeight = 4000;
    messagesEl.clientHeight = 600;

    const runFrames = (): void => {
      // Bounded: a frame that schedules another frame is normal, a frame that
      // schedules itself forever is the defect this bound reports.
      for (let i = 0; frames.length > 0; i++) {
        if (i > 50) throw new Error("animation frames never settled");
        frames.shift()!();
      }
    };

    const addUser = (
      id: string,
      top: number,
      height: number,
      opts: { text?: string; turnIndex?: number; steered?: boolean } = {},
    ): FakeElement => {
      messages.addMessage({
        id,
        role: "user",
        content: opts.text ?? "",
        steered: opts.steered,
        turnIndex: opts.turnIndex,
        status: "complete",
        timestamp: 1,
      });
      const el = messagesEl.children[messagesEl.children.length - 1];
      el.rectTop = top;
      el.offsetHeight = height;
      if (opts.text) {
        const body = el.querySelector(".message-body");
        if (body) body.textContent = opts.text;
      }
      return el;
    };

    const scroll = (): void => {
      // Drain whatever the addMessage calls above queued (the nav rail's own
      // refresh) before the scroll under test asks for a pin.
      runFrames();
      messagesEl.dispatch("scroll");
      runFrames();
    };

    return { ...harness, frames, runFrames, bar, barText, barTurn, addUser, scroll };
  }

  it("stays hidden while the prompt it would name is still on screen", () => {
    const h = staged();
    // The bubble's bottom (8 + 40) is below the container's top (0).
    h.addUser("m1", 8, 40, { text: "first question", turnIndex: 1 });

    h.scroll();

    expect(h.bar.hidden).toBe(true);
  });

  it("names the turn whose prompt has scrolled above the top edge", () => {
    const h = staged();
    h.addUser("m1", -100, 40, { text: "Refactor the parser", turnIndex: 3 });

    h.scroll();

    expect(h.bar.hidden).toBe(false);
    expect(h.barText.textContent).toBe("Refactor the parser");
    // The Changes panel numbers turns the same way, so the reader can carry
    // the number across.
    expect(h.barTurn.textContent).toBe("Turn 3");
  });

  it("keeps naming the turn's opening prompt once a steer has passed", () => {
    const h = staged();
    h.addUser("m1", -200, 40, { text: "opening question", turnIndex: 2 });
    h.addUser("m2", -100, 40, { text: "and also check the tests", steered: true, turnIndex: 2 });

    h.scroll();

    // The steer is a second bubble inside the same turn; the turn is still the
    // one the opening prompt began.
    expect(h.barText.textContent).toBe("opening question");
    expect(h.barTurn.textContent).toBe("Turn 2");
  });

  it("leaves the number off when the transcript carries no turn ordinal", () => {
    const h = staged();
    // A viewed saved session is drawn from stored messages, not from turns.
    h.addUser("m1", -100, 40, { text: "no turn number here" });

    h.scroll();

    expect(h.barText.textContent).toBe("no turn number here");
    expect(h.barTurn.textContent).toBe("");
  });

  it("says so when the prompt carried no text at all", () => {
    const h = staged();
    // An attachment-only send: nothing to preview, and a blank bar would look
    // like a rendering fault.
    h.addUser("m1", -100, 40);

    h.scroll();

    expect(h.bar.hidden).toBe(false);
    expect(h.barText.textContent).toBe("This prompt has no text");
  });

  it("jumps back to the prompt it names when clicked", () => {
    const h = staged();
    h.addUser("m1", -100, 40, { text: "where did it go", turnIndex: 1 });
    h.messagesEl.scrollTop = 400;

    h.scroll();
    h.bar.dispatch("click");

    // Same scroll-a-row-to-the-top move the navigation rail makes: the row's
    // viewport offset plus the current scroll, less the 20px reading margin.
    expect(h.messagesEl.scrollCalls[0]).toEqual({ top: 280, behavior: "smooth" });
  });

  it("lands a jump below the bar instead of underneath it", () => {
    const h = staged();
    // The bar floats over the transcript, so a row scrolled to the very top
    // would be covered by it; the jump asks how tall it is and stops short.
    h.bar.offsetHeight = 44;
    h.addUser("m1", -100, 40, { text: "where did it go", turnIndex: 1 });
    h.messagesEl.scrollTop = 400;

    h.scroll();
    h.bar.dispatch("click");

    expect(h.messagesEl.scrollCalls[0]).toEqual({ top: 236, behavior: "smooth" });
  });

  it("drops the pin when the transcript is replaced", () => {
    const h = staged();
    h.addUser("m1", -100, 40, { text: "old question", turnIndex: 1 });
    h.scroll();
    expect(h.bar.hidden).toBe(false);

    h.messages.clearTurnContext();

    expect(h.bar.hidden).toBe(true);
  });

  it("lets go of a prompt that was removed from the transcript", () => {
    const h = staged();
    h.addUser("m1", -100, 40, { text: "withdrawn question", turnIndex: 1 });
    h.scroll();
    expect(h.bar.hidden).toBe(false);

    // The bar names a row that is about to go away; a pin left pointing at it
    // would jump nowhere.
    h.messages.removeMessage("m1");
    h.runFrames();

    expect(h.bar.hidden).toBe(true);
  });

  it("says nothing about a transcript that has not been laid out", () => {
    const h = staged();
    h.addUser("m1", 0, 0, { text: "unmeasured", turnIndex: 1 });
    // A hidden view measures every row at the origin, which would otherwise
    // read as "the first prompt is already above the top".
    h.messagesEl.clientHeight = 0;

    h.scroll();

    expect(h.bar.hidden).toBe(true);
  });
});
