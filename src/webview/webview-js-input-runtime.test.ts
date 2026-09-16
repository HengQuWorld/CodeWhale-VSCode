/**
 * Runtime tests for the generated input script.
 *
 * webview-js-input.test.ts only asserts that the emitted source *mentions*
 * things, which cannot tell working wiring from a listener with an empty
 * body. These run the real script in a VM against a fake DOM and assert on
 * what it actually does.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { getInputScript } from "./webview-js-input";
import { makeTr } from "./webview-test-helpers";

class FakeClassList {
  private values = new Set<string>();
  add(n: string): void { this.values.add(n); }
  remove(n: string): void { this.values.delete(n); }
  contains(n: string): boolean { return this.values.has(n); }
  toggle(n: string, force?: boolean): boolean {
    if (force === undefined) {
      if (this.values.has(n)) { this.values.delete(n); return false; }
      this.values.add(n); return true;
    }
    if (force) { this.values.add(n); return true; }
    this.values.delete(n); return false;
  }
}

class FakeElement {
  public className = "";
  public value = "";
  public scrollTop = 0;
  public scrollHeight = 0;
  public selectionStart = 0;
  public selectionEnd = 0;
  public style: Record<string, string> = {};
  public classList = new FakeClassList();
  public children: FakeElement[] = [];
  private text = "";
  private listeners = new Map<string, (e: unknown) => void>();
  private attributes = new Map<string, string>();

  get innerHTML(): string { return this.text; }
  set innerHTML(v: string) { this.text = v; this.children = []; }

  addEventListener(name: string, h: (e: unknown) => void): void { this.listeners.set(name, h); }
  dispatch(name: string, event: unknown): void {
    const h = this.listeners.get(name);
    if (h) h(event);
  }
  querySelector() { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  remove(): void {}
  focus(): void {}
  getAttribute(n: string): string | null { return this.attributes.get(n) ?? null; }
  setAttribute(n: string, v: string): void { this.attributes.set(n, v); }
}

function makeFile(name: string, type: string, size: number, lastModified = 1) {
  return { name, type, size, lastModified };
}

function dataTransferOf(opts: {
  types?: string[];
  data?: Record<string, string>;
  files?: any[];
  items?: any[];
}) {
  return {
    types: opts.types ?? [],
    files: opts.files ?? [],
    items: opts.items ?? [],
    dropEffect: "none",
    getData: (t: string) => (opts.data ?? {})[t] ?? "",
  };
}

/** A cancelable event; `__calls` records which suppression was requested. */
function syntheticEvent(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    relatedTarget: null,
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
    stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
    __calls: calls,
    ...extra,
  };
}

function dropOf(dataTransfer: any) {
  return syntheticEvent({ dataTransfer });
}

function createHarness() {
  const elements = new Map<string, FakeElement>();
  const getEl = (id: string) => {
    let el = elements.get(id);
    if (!el) { el = new FakeElement(); elements.set(id, el); }
    return el;
  };

  const postMessages: Array<Record<string, any>> = [];
  const windowListeners = new Map<string, (e: any) => void>();
  const documentListeners = new Map<string, (e: any) => void>();
  const readAsDataUrlCalls: any[] = [];

  const windowObj: Record<string, any> = {
    __wvI18n: makeTr(),
    __wvEscapeHtml: (v: unknown) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    __wvVscode: { postMessage: (m: Record<string, any>) => { postMessages.push(m); } },
    __wvApiCapabilities: {},
    __wvMessages: {
      isStreaming: () => false,
      setUserScrolledUp: () => {},
      setStreaming: () => {},
    },
    addEventListener: (n: string, h: (e: any) => void) => { windowListeners.set(n, h); },
  };

  const bodyEl = new FakeElement();
  const documentObj = {
    getElementById: (id: string) => getEl(id),
    createElement: (_tag: string) => new FakeElement(),
    body: bodyEl,
    addEventListener: (n: string, h: (e: any) => void) => { documentListeners.set(n, h); },
  };

  class FakeFileReader {
    public result: string | null = null;
    public onload: (() => void) | null = null;
    readAsDataURL(file: any): void {
      readAsDataUrlCalls.push(file);
      this.result = `data:${file.type};base64,PROBE`;
      if (this.onload) this.onload();
    }
  }

  const sandbox: Record<string, unknown> = {
    window: windowObj,
    document: documentObj,
    FileReader: FakeFileReader,
    console, Math, Date, RegExp, parseInt, String, Array, Object, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(getInputScript(makeTr()), sandbox);

  const fire = (type: string, event: any) => {
    const h = windowListeners.get(type);
    if (h) h(event);
  };

  /** Mirrors how webview-js-event-handler.ts drives the input module. */
  const receive = (msg: Record<string, any>) => {
    if (msg.type === "attachmentsChanged") {
      windowObj.__wvInput.setCurrentAttachments(msg.attachments || []);
      windowObj.__wvInput.renderAttachments();
    } else if (msg.type === "attachmentPreview") {
      windowObj.__wvInput.setAttachmentPreview(msg.id, msg.previewUrl);
    }
  };

  return {
    windowObj,
    body: bodyEl,
    postMessages,
    fire,
    receive,
    input: getEl("input"),
    attachmentsArea: getEl("attachments-area"),
    readAsDataUrlCalls,
    windowListeners,
    documentListeners,
  };
}

type Harness = ReturnType<typeof createHarness>;

function chipHtml(h: Harness): string[] {
  return h.attachmentsArea.children.map((c) => c.innerHTML);
}

describe("webview-js-input runtime: emitted script", () => {
  it("parses as JavaScript", () => {
    expect(() => new Function(getInputScript(makeTr()))).not.toThrow();
  });

  it("registers the drop listeners on window and document", () => {
    const h = createHarness();
    for (const name of ["dragenter", "dragover", "dragleave", "drop"]) {
      expect(h.windowListeners.has(name)).toBe(true);
      expect(h.documentListeners.has(name)).toBe(true);
    }
  });
});

describe("webview-js-input runtime: drop routing", () => {
  it("sends editor uri-list drops to attachPaths, dropping comment lines", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["text/uri-list"],
      data: { "text/uri-list": "# comment\nfile:///tmp/a.png\nfile:///tmp/b.png\n" },
    })));
    expect(h.postMessages).toEqual([
      { type: "attachPaths", uris: ["file:///tmp/a.png", "file:///tmp/b.png"] },
    ]);
  });

  it("routes an image blob to attachImage", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["Files"],
      files: [makeFile("shot.png", "image/png", 100)],
    })));
    expect(h.postMessages).toHaveLength(1);
    expect(h.postMessages[0]).toMatchObject({ type: "attachImage", mime: "image/png" });
  });

  it("routes a non-image blob to attachFileBlob", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["Files"],
      files: [makeFile("report.pdf", "application/pdf", 100)],
    })));
    expect(h.postMessages).toHaveLength(1);
    expect(h.postMessages[0]).toMatchObject({ type: "attachFileBlob", name: "report.pdf" });
  });

  it("rejects an oversized blob without reading its bytes", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["Files"],
      files: [makeFile("huge.bin", "application/octet-stream", 50 * 1024 * 1024 + 1)],
    })));
    expect(h.postMessages).toEqual([
      { type: "dropTooLarge", name: "huge.bin", size: 50 * 1024 * 1024 + 1 },
    ]);
    expect(h.readAsDataUrlCalls).toHaveLength(0);
  });

  it("does not attach the same file twice when it arrives in files and items", () => {
    const h = createHarness();
    const f = makeFile("shot.png", "image/png", 100);
    h.fire("drop", dropOf(dataTransferOf({
      types: ["Files"],
      files: [f],
      items: [{ kind: "file", getAsFile: () => f }],
    })));
    expect(h.postMessages).toHaveLength(1);
  });

  it("routes each file of a mixed drop independently", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["Files"],
      files: [
        makeFile("a.png", "image/png", 10),
        makeFile("b.pdf", "application/pdf", 10),
        makeFile("c.gif", "image/gif", 10),
      ],
    })));
    expect(h.postMessages.map((m) => m.type)).toEqual([
      "attachImage",
      "attachFileBlob",
      "attachImage",
    ]);
  });

  it("swallows the default on a handled drop so the webview cannot navigate", () => {
    const h = createHarness();
    const ev = dropOf(dataTransferOf({
      types: ["Files"],
      files: [makeFile("a.png", "image/png", 1)],
    }));
    h.fire("drop", ev);
    expect(ev.__calls).toContain("preventDefault");
    expect(ev.__calls).toContain("stopImmediatePropagation");
  });

  it("highlights the webview while a file drag hovers, and clears it on drop", () => {
    const h = createHarness();
    h.fire("dragenter", dropOf(dataTransferOf({ types: ["Files"] })));
    expect(h.body.classList.contains("drag-over")).toBe(true);
    h.fire("drop", dropOf(dataTransferOf({ types: ["Files"] })));
    expect(h.body.classList.contains("drag-over")).toBe(false);
  });

  it("ignores a drag that carries no file payload", () => {
    const h = createHarness();
    const ev = dropOf(dataTransferOf({ types: ["application/x-unknown"] }));
    h.fire("drop", ev);
    expect(h.postMessages).toEqual([]);
    expect(ev.__calls).toEqual([]);
  });
});

describe("webview-js-input runtime: a text drag stays text", () => {
  it("does not hijack prose", () => {
    const h = createHarness();
    const ev = dropOf(dataTransferOf({ types: ["text/plain"], data: { "text/plain": "hello world" } }));
    h.fire("drop", ev);
    expect(h.postMessages).toEqual([]);
    expect(ev.__calls).toEqual([]);
  });

  it("does not hijack a code snippet that merely starts with a slash", () => {
    const h = createHarness();
    const ev = dropOf(dataTransferOf({
      types: ["text/plain"],
      data: { "text/plain": "/api/v1/users - GET" },
    }));
    h.fire("drop", ev);
    expect(h.postMessages).toEqual([]);
    // The default text insert has to survive — that is the point of the fix.
    expect(ev.__calls).toEqual([]);
  });

  it("does not hijack a slash command name", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({ types: ["text/plain"], data: { "text/plain": "/mode" } })));
    expect(h.postMessages).toEqual([]);
  });

  it("does not hijack multi-line text", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["text/plain"],
      data: { "text/plain": "/tmp/a.png\nmore text" },
    })));
    expect(h.postMessages).toEqual([]);
  });

  it("still attaches a dragged path that names a file", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["text/plain"],
      data: { "text/plain": "/tmp/shot.png" },
    })));
    expect(h.postMessages).toEqual([{ type: "attachPaths", uris: ["/tmp/shot.png"] }]);
  });

  it("still attaches a dragged file: URL and a home-relative dotfile", () => {
    const h = createHarness();
    h.fire("drop", dropOf(dataTransferOf({
      types: ["text/plain"],
      data: { "text/plain": "file:///tmp/notes.md" },
    })));
    expect(h.postMessages).toEqual([{ type: "attachPaths", uris: ["file:///tmp/notes.md"] }]);

    const h2 = createHarness();
    h2.fire("drop", dropOf(dataTransferOf({
      types: ["text/plain"],
      data: { "text/plain": "~/.env" },
    })));
    expect(h2.postMessages).toEqual([{ type: "attachPaths", uris: ["~/.env"] }]);
  });
});

describe("webview-js-input runtime: paste", () => {
  it("forwards a pasted image and suppresses the text insert", () => {
    const h = createHarness();
    const ev = syntheticEvent({
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => makeFile("p.png", "image/png", 5) }],
      },
    });
    h.input.dispatch("paste", ev);
    expect(h.postMessages).toHaveLength(1);
    expect(h.postMessages[0].type).toBe("attachImage");
    expect(ev.__calls).toContain("preventDefault");
  });

  it("leaves a text paste alone", () => {
    const h = createHarness();
    const ev = syntheticEvent({
      clipboardData: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      },
    });
    h.input.dispatch("paste", ev);
    expect(h.postMessages).toEqual([]);
    expect(ev.__calls).toEqual([]);
  });
});

describe("webview-js-input runtime: thumbnail cache", () => {
  const preview = (id: string, payload: string) =>
    ({ type: "attachmentPreview", id, previewUrl: `data:image/png;base64,${payload}` });
  const list = (attachments: any[]) => ({ type: "attachmentsChanged", attachments });

  it("renders a thumbnail from a preview that arrived before the list", () => {
    const h = createHarness();
    h.receive(preview("att-1", "AAA"));
    h.receive(list([{ id: "att-1", kind: "image", path: "/tmp/a.png", name: "a.png" }]));
    expect(chipHtml(h)[0]).toContain("attachment-thumb");
    expect(chipHtml(h)[0]).toContain("data:image/png;base64,AAA");
  });

  it("falls back to the plain icon when no preview was delivered", () => {
    const h = createHarness();
    h.receive(list([{ id: "att-1", kind: "image", path: "/tmp/a.png", name: "a.png" }]));
    expect(chipHtml(h)[0]).not.toContain("attachment-thumb");
    expect(chipHtml(h)[0]).toContain("a.png");
  });

  it("keeps a survivor's thumbnail when another attachment is removed", () => {
    const h = createHarness();
    h.receive(preview("att-1", "AAA"));
    h.receive(preview("att-2", "BBB"));
    h.receive(list([
      { id: "att-1", kind: "image", path: "/tmp/a.png", name: "a.png" },
      { id: "att-2", kind: "image", path: "/tmp/b.png", name: "b.png" },
    ]));
    // The list is republished without any preview payload.
    h.receive(list([{ id: "att-2", kind: "image", path: "/tmp/b.png", name: "b.png" }]));
    expect(chipHtml(h)).toHaveLength(1);
    expect(chipHtml(h)[0]).toContain("data:image/png;base64,BBB");
  });

  it("drops the cached thumbnail once its attachment is gone", () => {
    const h = createHarness();
    h.receive(preview("att-1", "AAA"));
    h.receive(list([{ id: "att-1", kind: "image", path: "/tmp/a.png", name: "a.png" }]));
    expect(chipHtml(h)[0]).toContain("attachment-thumb");
    // A send clears the list and prunes the cache.
    h.receive(list([]));
    expect(chipHtml(h)).toHaveLength(0);
    h.receive(list([{ id: "att-1", kind: "image", path: "/tmp/a.png", name: "a.png" }]));
    expect(chipHtml(h)[0]).not.toContain("attachment-thumb");
  });
});
describe("webview-js-input runtime: typing never resizes the textarea", () => {
  it("keeps the chosen height and lets longer text scroll inside", () => {
    const h = createHarness();
    h.input.style.height = "52px";
    h.input.scrollHeight = 500; // far more text than the box can show
    h.input.dispatch("input", syntheticEvent());

    expect(h.input.style.height).toBe("52px");
  });

  it("leaves no measurement override behind on the element", () => {
    const h = createHarness();
    h.input.dispatch("input", syntheticEvent());

    // The removed auto-grow helper wrote both of these while measuring.
    expect(h.input.style.height).toBeUndefined();
    expect(h.input.style.flexGrow).toBeUndefined();
  });

  it("does not resize the box when a send clears the textarea", () => {
    const h = createHarness();
    h.input.style.height = "150px";
    h.input.value = "hello";
    h.input.dispatch("keydown", syntheticEvent({ key: "Enter", shiftKey: false }));

    expect(h.postMessages).toEqual([{ type: "sendMessage", text: "hello" }]);
    expect(h.input.style.height).toBe("150px");
  });
});
