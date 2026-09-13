import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showOpenDialog: vi.fn(),
  },
  env: {
    language: "en",
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({
      toString: () => value,
      fsPath: value.replace(/^file:\/\//, ""),
    }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(() => undefined),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => undefined),
    readFileSync: vi.fn(() => Buffer.alloc(0)),
  };
});

import { readFileSync, statSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { window } from "vscode";
import { ChatProvider } from "./chat-provider";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function pngBytes(payloadBytes = 64): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(payloadBytes, 0x41)]);
}

function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function createProvider() {
  const api = { bindEngine: vi.fn() };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return { provider, postMessage: provider.postMessage as any };
}

function errorMessages(postMessage: ReturnType<typeof vi.fn>): string[] {
  return postMessage.mock.calls
    .filter((call) => (call[0] as { type: string }).type === "error")
    .map((call) => (call[0] as { message: string }).message);
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

function lastAttachments(postMessage: ReturnType<typeof vi.fn>): any {
  const lists = messagesOfType(postMessage, "attachmentsChanged");
  return lists[lists.length - 1];
}

describe("inline image attach (paste / drop)", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
  });

  it("persists a pasted PNG and registers it as an image attachment", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline("image/png", dataUrl("image/png", pngBytes()));

    const write = vi.mocked(writeFileSync);
    expect(write).toHaveBeenCalledTimes(1);
    const filePath = write.mock.calls[0][0] as string;
    expect(filePath).toMatch(/\.codewhale[/\\]clipboard-images[/\\]clipboard-\d+-\d+\.png$/);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments).toHaveLength(1);
    expect(change.attachments[0]).toMatchObject({ kind: "image", path: filePath });
  });

  it("keeps the dropped file's display name when provided", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline(
      "image/png",
      dataUrl("image/png", pngBytes()),
      "screens/../shot.png",
    );

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments[0].name).toBe("shot.png");
  });

  it("rejects mimes outside the engine's accepted set", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline("image/tiff", dataUrl("image/tiff", pngBytes()));

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("Only PNG");
  });

  it("rejects a declared mime that does not match the payload bytes", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline("image/png", dataUrl("image/png", JPEG_HEADER));

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("could not be read");
  });

  it("rejects images above the 5 MiB per-image ceiling", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline(
      "image/png",
      dataUrl("image/png", pngBytes(5 * 1024 * 1024)),
    );

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("5 MB");
  });

  it("attaches a file:// drop target by its original path, sniffing the bytes", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 64 } as any)
      .mockReturnValueOnce({ isFile: () => true, size: 64 } as any);
    vi.mocked(readFileSync).mockReturnValueOnce(pngBytes() as any);

    (provider as any).handleAttachPaths(["file:///tmp/shot.png"]);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments).toHaveLength(1);
    expect(change.attachments[0]).toMatchObject({
      kind: "image",
      path: "/tmp/shot.png",
      name: "shot.png",
    });
    // Path attachments carry a data-URL thumbnail, built from the sniffed
    // bytes and delivered in its own message rather than in the list.
    expect(change.attachments[0].previewUrl).toBeUndefined();
    const previews = messagesOfType(postMessage, "attachmentPreview");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      id: change.attachments[0].id,
      previewUrl: `data:image/png;base64,${pngBytes().toString("base64")}`,
    });
    // No copy is made for path-based attachments (TUI /attach parity).
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("attaches a uri-list drop whose target is a regular file", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValueOnce({ isFile: () => true, size: 16 } as any);

    (provider as any).handleAttachPaths(["file:///tmp/notes.txt"]);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments).toHaveLength(1);
    expect(change.attachments[0]).toMatchObject({
      kind: "file",
      path: "/tmp/notes.txt",
      name: "notes.txt",
    });
  });

  it("rejects a uri-list drop whose target does not exist", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValueOnce(undefined as any);

    (provider as any).handleAttachPaths(["file:///tmp/missing.png"]);

    expect(errorMessages(postMessage)[0]).toContain("File type not supported");
  });

  it("expands a home-relative text drop before stat-ing it", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValueOnce({ isFile: () => true, size: 16 } as any);

    (provider as any).handleAttachPaths(["~/.env"]);

    const expanded = path.join(os.homedir(), ".env");
    expect(vi.mocked(statSync).mock.lastCall?.[0]).toBe(expanded);
    expect(lastAttachments(postMessage).attachments[0].path).toBe(expanded);
  });

  it("attaches multiple dropped paths through the shared path handler", () => {
    const { provider, postMessage } = createProvider();
    // readme.md (attach stat), shot.png (attach stat + preview stat).
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any)
      .mockReturnValueOnce({ isFile: () => true, size: 64 } as any)
      .mockReturnValueOnce({ isFile: () => true, size: 64 } as any);
    vi.mocked(readFileSync).mockReturnValueOnce(pngBytes() as any);

    (provider as any).handleAttachPaths([
      "file:///tmp/readme.md",
      "file:///tmp/shot.png",
    ]);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments).toHaveLength(2);
    expect(change.attachments[0]).toMatchObject({ kind: "file", path: "/tmp/readme.md" });
    expect(change.attachments[1]).toMatchObject({ kind: "image", path: "/tmp/shot.png" });
  });
  it("carries the incoming data URL as the pasted image's preview", async () => {
    const { provider, postMessage } = createProvider();
    const url = dataUrl("image/png", pngBytes());
    await (provider as any).handleAttachImageInline("image/png", url);

    const previews = messagesOfType(postMessage, "attachmentPreview");
    expect(previews).toHaveLength(1);
    expect(previews[0].previewUrl).toBe(url);
  });
});

describe("attachment preview transport", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, size: 40 } as any);
    vi.mocked(readFileSync).mockReturnValue(pngBytes() as any);
  });

  it("never puts a preview payload in the attachment list", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleAttachImageInline("image/png", dataUrl("image/png", pngBytes()));

    const list = lastAttachments(postMessage);
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0]).not.toHaveProperty("previewUrl");
    // The list stays small even though the thumbnail is a full data URL.
    expect(JSON.stringify(list).length).toBeLessThan(300);
  });

  it("sends a thumbnail once, not on every list publish", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/a.png", "file:///tmp/b.png"]);
    expect(messagesOfType(postMessage, "attachmentPreview")).toHaveLength(2);

    // Removing one republishes the list; the surviving thumbnail must not be
    // re-sent (that is the whole point of the separate channel).
    (provider as any).handleRemoveAttachment(0);
    expect(messagesOfType(postMessage, "attachmentPreview")).toHaveLength(2);
    expect(lastAttachments(postMessage).attachments).toHaveLength(1);
  });

  it("re-announces live thumbnails to a webview that just reloaded", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/a.png"]);
    const before = messagesOfType(postMessage, "attachmentPreview").length;

    (provider as any).reannounceAttachmentPreviews();
    expect(messagesOfType(postMessage, "attachmentPreview").length).toBe(before + 1);
  });

  it("webviewReady republishes the list too, thumbnails first — a reload must not hide attachments the next send would carry", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/a.png"]);
    (provider as any).api.ensureReady = vi.fn();
    (provider as any).syncWebviewState = vi.fn();
    (provider as any).debugLog = vi.fn();
    postMessage.mockClear();

    await (provider as any).handleWebviewMessage({ type: "webviewReady" });

    const msgs = postMessage.mock.calls.map((call: any) => call[0]);
    const previewIdx = msgs.findIndex((m: any) => m.type === "attachmentPreview");
    const listIdx = msgs.findIndex((m: any) => m.type === "attachmentsChanged");
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(previewIdx);
    expect(msgs[listIdx].attachments).toHaveLength(1);
    expect(msgs[listIdx].attachments[0]).not.toHaveProperty("previewUrl");
  });

  it("prunes nothing when the list is cleared by a send", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/a.png"]);
    await (provider as any).handleSendMessage("hello");

    const list = lastAttachments(postMessage);
    expect(list.attachments).toEqual([]);
  });
});

describe("partial failure keeps host and webview in sync", () => {
  beforeEach(() => {
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue(undefined as any);
  });

  it("publishes what it recorded when a later path throws", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any)
      .mockImplementationOnce(() => {
        const err: any = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      });

    (provider as any).handleAttachPaths(["file:///tmp/ok.md", "file:///tmp/denied.md"]);

    // The recorded attachment must reach the webview, or the next send would
    // carry a file the user was never shown.
    const list = lastAttachments(postMessage);
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0]).toMatchObject({ kind: "file", path: "/tmp/ok.md" });
    expect(errorMessages(postMessage).some((m) => m.includes("permission denied"))).toBe(true);
  });

  it("does not let one bad path cost the rest of the drop", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync)
      .mockImplementationOnce(() => {
        const err: any = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      })
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any);

    (provider as any).handleAttachPaths(["file:///tmp/denied.md", "file:///tmp/ok.md"]);

    expect(lastAttachments(postMessage).attachments).toHaveLength(1);
    expect(lastAttachments(postMessage).attachments[0]).toMatchObject({ path: "/tmp/ok.md" });
  });

  it("still reports a path that simply does not exist", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/gone.md"]);
    expect(errorMessages(postMessage)).toHaveLength(1);
    expect(messagesOfType(postMessage, "attachmentsChanged")).toHaveLength(0);
  });
});

describe("dropped file blobs (Finder / Explorer drops)", () => {
  const PDF_BYTES = Buffer.from("%PDF-1.7 fake pdf payload");

  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue(undefined as any);
  });

  it("persists a dropped PDF and registers it as a file attachment", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, size: PDF_BYTES.length } as any);

    (provider as any).handleAttachFileBlob("report.pdf", dataUrl("application/pdf", PDF_BYTES));

    const write = vi.mocked(writeFileSync);
    expect(write).toHaveBeenCalledTimes(1);
    const filePath = write.mock.calls[0][0] as string;
    expect(filePath).toMatch(/\.codewhale[/\\]dropped-files[/\\]dropped-\d+-\d+-report\.pdf$/);
    expect(write.mock.calls[0][1]).toEqual(PDF_BYTES);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments).toHaveLength(1);
    expect(change.attachments[0]).toMatchObject({ kind: "file", path: filePath, name: "report.pdf" });
  });

  it("sanitizes path fragments out of the stored name but keeps the display name", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, size: PDF_BYTES.length } as any);

    (provider as any).handleAttachFileBlob("../docs/report v2.pdf", dataUrl("application/pdf", PDF_BYTES));

    const filePath = vi.mocked(writeFileSync).mock.calls[0][0] as string;
    expect(filePath).not.toContain("..");
    expect(filePath).toMatch(/report_v2\.pdf$/);

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change.attachments[0].name).toBe("report v2.pdf");
  });

  it("rejects a payload that is not a base64 data URL", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleAttachFileBlob("report.pdf", "not-a-data-url");

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("File type not supported");
  });

  it("rejects dropped files above the 50 MB transport cap", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleAttachFileBlob(
      "big.pdf",
      dataUrl("application/pdf", Buffer.alloc(50 * 1024 * 1024 + 1, 0x61)),
    );

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("50 MB");
  });
});

describe("image-kind path attachment validation (TUI /attach parity)", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue(undefined as any);
    vi.mocked(readFileSync).mockClear();
    vi.mocked(readFileSync).mockReturnValue(Buffer.alloc(0));
  });

  it("rejects an image-kind path whose bytes sniff to no accepted format", () => {
    const { provider, postMessage } = createProvider();
    // Two stats: attachPathAsAttachment then readImagePreviewDataUrl.
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any)
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any);
    vi.mocked(readFileSync).mockReturnValueOnce(Buffer.from("not an image") as any);

    const attached = (provider as any).attachPathAsAttachment("/tmp/fake.png");

    expect(attached).toBe(false);
    expect(errorMessages(postMessage)[0]).toContain("Only PNG");

    const change = postMessage.mock.calls
      .map((call: any) => call[0])
      .find((msg: any) => msg.type === "attachmentsChanged");
    expect(change).toBeUndefined();
  });

  it("rejects a BMP path even though the extension classifies as image", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 32 } as any)
      .mockReturnValueOnce({ isFile: () => true, size: 32 } as any);
    // BMP magic bytes: recognized by TUI but deliberately refused.
    vi.mocked(readFileSync).mockReturnValueOnce(
      Buffer.concat([Buffer.from("BM"), Buffer.alloc(30, 0x00)]) as any,
    );

    const attached = (provider as any).attachPathAsAttachment("/tmp/shot.bmp");

    expect(attached).toBe(false);
    expect(errorMessages(postMessage)[0]).toContain("Only PNG");
  });

  it("rejects an image-kind path above the 5 MiB per-image limit without reading it", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValueOnce({ isFile: () => true, size: 5 * 1024 * 1024 + 1 } as any);

    const attached = (provider as any).attachPathAsAttachment("/tmp/huge.png");

    expect(attached).toBe(false);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)[0]).toContain("5 MB");
  });

  it("reports a missing path itself so callers do not double-report", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValue(undefined as any);

    const attached = (provider as any).attachPathAsAttachment("/tmp/missing.png");

    expect(attached).toBe(false);
    expect(errorMessages(postMessage)).toHaveLength(1);
    expect(errorMessages(postMessage)[0]).toContain("File type not supported");
  });

  it("leaves video and plain-file paths unvalidated (engine reads them via @path)", () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(statSync).mockReturnValueOnce({ isFile: () => true, size: 999999 } as any);

    const attached = (provider as any).attachPathAsAttachment("/tmp/clip.mp4");

    expect(attached).toBe(true);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    expect(errorMessages(postMessage)).toHaveLength(0);
  });
});

describe("attach-file button (dialog path)", () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, size: 16 } as any);
    vi.mocked(readFileSync).mockReturnValue(Buffer.alloc(0));
    vi.mocked(window.showOpenDialog).mockReset();
  });

  it("attaches every selected path and publishes the list once", async () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(window.showOpenDialog).mockResolvedValue([
      { fsPath: "/tmp/a.md" } as any,
      { fsPath: "/tmp/b.txt" } as any,
    ]);

    await (provider as any).handleAttachFile();

    expect(messagesOfType(postMessage, "attachmentsChanged")).toHaveLength(1);
    expect(lastAttachments(postMessage).attachments).toHaveLength(2);
  });

  it("posts nothing when the dialog is cancelled", async () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(window.showOpenDialog).mockResolvedValue(undefined);

    await (provider as any).handleAttachFile();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("refuses an image outside the engine's accepted formats instead of attaching it", async () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(window.showOpenDialog).mockResolvedValue([{ fsPath: "/tmp/old.bmp" } as any]);
    vi.mocked(readFileSync).mockReturnValue(
      Buffer.concat([Buffer.from("BM"), Buffer.alloc(30, 0x00)]),
    );

    await (provider as any).handleAttachFile();

    expect(errorMessages(postMessage)[0]).toContain("Only PNG");
    expect(messagesOfType(postMessage, "attachmentsChanged")).toHaveLength(0);
  });

  it("keeps the readable files when a later selection throws", async () => {
    const { provider, postMessage } = createProvider();
    vi.mocked(window.showOpenDialog).mockResolvedValue([
      { fsPath: "/tmp/ok.md" } as any,
      { fsPath: "/tmp/denied.md" } as any,
    ]);
    vi.mocked(statSync)
      .mockReturnValueOnce({ isFile: () => true, size: 16 } as any)
      .mockImplementationOnce(() => {
        const err: any = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      });

    await (provider as any).handleAttachFile();

    expect(lastAttachments(postMessage).attachments).toHaveLength(1);
    expect(lastAttachments(postMessage).attachments[0]).toMatchObject({ path: "/tmp/ok.md" });
  });
});

describe("removeAttachment", () => {
  beforeEach(() => {
    vi.mocked(statSync).mockReset();
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, size: 16 } as any);
  });

  it("republishes the list without the removed entry", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).handleAttachPaths(["file:///tmp/a.md", "file:///tmp/b.md"]);

    (provider as any).handleRemoveAttachment(0);

    const list = lastAttachments(postMessage);
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0].path).toBe("/tmp/b.md");
  });

  it("ignores an out-of-range index", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRemoveAttachment(3);

    expect(postMessage).not.toHaveBeenCalled();
  });
});
