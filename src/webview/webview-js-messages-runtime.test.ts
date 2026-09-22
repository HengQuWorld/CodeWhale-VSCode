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
  public classList = new FakeClassList();
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

  return { messages, messagesEl, addCard };
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
