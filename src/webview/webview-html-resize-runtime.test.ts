/**
 * Runtime tests for the sidebar width script — the block `webview-html.ts`
 * carries inline, which the assembler's own tests only match as text.
 *
 * The sheet is what bounds *drawing*: the panel's floor, its ceiling and the
 * column the conversation keeps are asserted in `webview-css.test.ts` and
 * measured in a browser against this same document (see AGENTS.md). What a DOM
 * stand-in can still exercise for real is the script's own half: which stored
 * widths it adopts, what a drag asks for while it runs, and what it writes down
 * when the drag ends — including the case where the sheet never let it reach
 * what it asked for.
 *
 * The stand-in reports a width the way the browser would *after* the sheet has
 * had its say (a floor, a ceiling, zero while the panel is hidden), because that
 * drawn width is the one the script has to reason about.
 */
import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { getWebviewHtml } from "./webview-html";
import { SIDEBAR_PANEL_MAX_WIDTH, SIDEBAR_PANEL_MIN_WIDTH } from "./webview-css";
import { makeTr } from "./webview-test-helpers";

// webview-html.ts reaches for `vscode` on the way in.
vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (...args: string[]) => ({ fsPath: args.join("/") }),
  },
}));

/** The panel's own width in the sheet, before anything writes one. */
const PANEL_DEFAULT_WIDTH = 220;

/** The one inline block that owns the sidebar's width — found by the element it
 *  wires up, so it cannot be confused with the composer's own grip. */
function extractSidebarResizeScript(html: string): string {
  const block = html
    .split("</script>")
    .find((part) => part.includes("getElementById('sidebar-resize-handle')"));
  if (!block) throw new Error("the sidebar resize script is not in the document");
  const open = block.lastIndexOf("<script");
  return block.slice(block.indexOf(">", open) + 1);
}

const STORED_WIDTH_KEY = "codewhale:sidebarWidth";

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
}

/** An element that answers a click with listeners and a box, and whose drawn
 *  width is its written width after the sheet's floor and ceiling. */
class FakeElement {
  public classList = new FakeClassList();
  public style: Record<string, string> = {};
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private hidden = false;

  constructor(
    private readonly baseWidth: number,
    private readonly floor: number,
    private readonly ceiling: number,
  ) {}

  addEventListener(name: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatch(name: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }

  /** Models `display: none` — the panel closed while the grip was held. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  get drawnWidth(): number {
    if (this.hidden) return 0;
    const asked = parseInt(this.style.width ?? "", 10);
    const width = Number.isNaN(asked) ? this.baseWidth : asked;
    return Math.max(this.floor, Math.min(width, this.ceiling));
  }

  getBoundingClientRect(): { width: number } {
    return { width: this.drawnWidth };
  }
}

interface Harness {
  panel: FakeElement;
  handle: FakeElement;
  body: FakeElement;
  store: Map<string, string>;
  pressGrip(): void;
  dragBy(delta: number): void;
  releaseGrip(): void;
  fireWindow(name: string, event: unknown): void;
}

function createHarness(options: { stored?: string; ceiling?: number } = {}): Harness {
  const store = new Map<string, string>();
  if (options.stored !== undefined) store.set(STORED_WIDTH_KEY, options.stored);

  const ceiling = options.ceiling ?? Number.POSITIVE_INFINITY;
  const panel = new FakeElement(PANEL_DEFAULT_WIDTH, SIDEBAR_PANEL_MIN_WIDTH, ceiling);
  const handle = new FakeElement(0, 0, Number.POSITIVE_INFINITY);
  const body = new FakeElement(0, 0, Number.POSITIVE_INFINITY);
  const elements: Record<string, FakeElement> = {
    "threads-panel": panel,
    "sidebar-resize-handle": handle,
  };

  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const frames: Array<() => void> = [];

  const context = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      body,
    },
    window: {
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        const handlers = windowListeners.get(name) ?? [];
        handlers.push(handler);
        windowListeners.set(name, handlers);
      },
      removeEventListener: (name: string, handler: (event: unknown) => void) => {
        const handlers = windowListeners.get(name);
        const at = handlers ? handlers.indexOf(handler) : -1;
        if (handlers && at >= 0) handlers.splice(at, 1);
      },
    },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => frames.splice(0, frames.length),
    parseInt,
    Math,
  };

  // The two arguments the assembler wants but this test never uses: a mock
  // webview whose `asWebviewUri` is the identity, and an extension root that is
  // only ever a prefix for local resource URIs.
  const document = getWebviewHtml(
    { asWebviewUri: (uri: unknown) => uri } as any,
    { fsPath: "/test/extension" } as any,
    makeTr(),
  );
  vm.runInNewContext(extractSidebarResizeScript(document), context);

  const fireWindow = (name: string, event: unknown): void => {
    for (const handler of [...(windowListeners.get(name) ?? [])]) handler(event);
  };

  return {
    panel,
    handle,
    body,
    store,
    pressGrip: () => handle.dispatch("mousedown", { clientX: 100, preventDefault: () => undefined }),
    dragBy: (delta: number) => {
      fireWindow("mousemove", { clientX: 100 + delta });
      // The write is rAF-throttled, so nothing is applied until the frame runs.
      while (frames.length > 0) (frames.shift() as () => void)();
    },
    releaseGrip: () => fireWindow("mouseup", {}),
    fireWindow,
  };
}

describe("the sidebar width script", () => {
  it("adopts the width the sidebar was left at", () => {
    const { panel } = createHarness({ stored: "283" });

    expect(panel.style.width).toBe("283px");
    expect(panel.drawnWidth).toBe(283);
  });

  it("ignores a stored width the sheet's bounds would never have drawn", () => {
    // A hand-edited store, or a shape another build wrote: nothing is adopted,
    // so the panel keeps the width the sheet gives it.
    for (const stored of ["50", "900", "wide", ""]) {
      const { panel } = createHarness({ stored });

      expect(panel.style.width).toBeUndefined();
    }
  });

  it("asks for the width the drag computed, and stops at the panel's own bounds", () => {
    const { panel, pressGrip, dragBy, releaseGrip } = createHarness({ stored: "283" });

    pressGrip();
    dragBy(100);
    releaseGrip();
    expect(panel.style.width).toBe("383px");

    // Held at the floor rather than dragged past it …
    pressGrip();
    dragBy(-1000);
    releaseGrip();
    expect(panel.style.width).toBe(`${SIDEBAR_PANEL_MIN_WIDTH}px`);

    // … and at the ceiling rather than run off the end of the row.
    pressGrip();
    dragBy(1000);
    releaseGrip();
    expect(panel.style.width).toBe(`${SIDEBAR_PANEL_MAX_WIDTH}px`);
  });

  it("stops following the pointer once the grip is let go", () => {
    const { panel, pressGrip, dragBy, releaseGrip } = createHarness({ stored: "283" });

    pressGrip();
    dragBy(100);
    releaseGrip();
    dragBy(100);

    expect(panel.style.width).toBe("383px");
  });

  it("writes down the width that was drawn, not the one the drag asked for", () => {
    // The sheet stops the panel where the conversation's column begins; the
    // drag keeps counting past that. What is remembered has to be what is on
    // screen, or the next window reopens the panel wider than it was left.
    const { panel, store, pressGrip, dragBy, releaseGrip } = createHarness({
      stored: "283",
      ceiling: 300,
    });

    pressGrip();
    dragBy(300);
    expect(panel.style.width).toBe("583px");
    expect(panel.drawnWidth).toBe(300);

    releaseGrip();
    expect(panel.style.width).toBe("300px");
    expect(store.get(STORED_WIDTH_KEY)).toBe("300");
  });

  it("records nothing when the panel was closed mid-drag", () => {
    // Esc during a drag shuts the panel, and a hidden panel has no width to
    // adopt: recording the zero would discard the reader's choice and reopen
    // the panel at the default.
    const { panel, store, pressGrip, dragBy, releaseGrip } = createHarness({ stored: "283" });

    pressGrip();
    dragBy(300);
    panel.setHidden(true);
    releaseGrip();

    expect(store.get(STORED_WIDTH_KEY)).toBe("283");
    expect(panel.style.width).toBe("583px");
  });

  it("marks the drag while it is running, and clears it after", () => {
    const { handle, body, pressGrip, releaseGrip, fireWindow } = createHarness({ stored: "283" });

    pressGrip();
    expect(handle.classList.contains("active")).toBe(true);
    expect(body.classList.contains("is-resizing")).toBe(true);
    expect(body.style.cursor).toBe("col-resize");

    releaseGrip();
    expect(handle.classList.contains("active")).toBe(false);
    expect(body.classList.contains("is-resizing")).toBe(false);
    expect(body.style.cursor).toBe("");

    // A window that loses focus mid-drag ends it too — the grip must not stay
    // lit with a drag that is no longer following the pointer.
    pressGrip();
    fireWindow("blur", {});
    expect(handle.classList.contains("active")).toBe(false);
  });
});
