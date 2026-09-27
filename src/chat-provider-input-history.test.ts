/**
 * The composer's input history must survive a restart: the webview reports
 * every sent entry to the host, the host persists it per workspace, and a
 * reloaded webview gets the list handed back before the user types anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: [{ uri: { fsPath: "/hist-ws" } }],
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

import { ChatProvider } from "./chat-provider";
import { loadInputHistory } from "./utils/input-history";

const realHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chat-hist-"));
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
});

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    createThread: vi.fn(async () => ({ id: "thread-1", messages: [] })),
    sendMessage: vi.fn(async () => undefined),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return { provider, postMessage: provider.postMessage as any };
}

describe("input history persistence", () => {
  it("records what the webview reports as sent, newest first", async () => {
    const { provider } = createProvider();
    await (provider as any).handleWebviewMessage({ type: "inputHistoryPush", text: "first" });
    await (provider as any).handleWebviewMessage({ type: "inputHistoryPush", text: "second" });
    // The "restart" is just a new read of the same file.
    expect(loadInputHistory("/hist-ws")).toEqual(["second", "first"]);
  });

  it("ignores push messages without text", async () => {
    const { provider } = createProvider();
    await (provider as any).handleWebviewMessage({ type: "inputHistoryPush" });
    expect(loadInputHistory("/hist-ws")).toEqual([]);
  });

  it("hands the stored list back on webviewReady, without waiting on the engine", async () => {
    const { provider, postMessage } = createProvider();
    await (provider as any).handleWebviewMessage({ type: "inputHistoryPush", text: "remembered" });

    // One ordered log of what happened when: the history hand-back must be
    // on it before the engine readiness the rest of the sync waits for.
    const order: string[] = [];
    postMessage.mockImplementation((m: any) => {
      if (m.type === "inputHistory") order.push("inputHistory");
    });
    (provider as any).api.ensureReady = vi.fn(async () => { order.push("ensureReady"); });
    (provider as any).syncWebviewState = vi.fn();
    postMessage.mockClear();

    await (provider as any).handleWebviewMessage({ type: "webviewReady" });

    const msgs = postMessage.mock.calls.map((c: any) => c[0]);
    const histIdx = msgs.findIndex((m: any) => m.type === "inputHistory");
    expect(histIdx).toBeGreaterThanOrEqual(0);
    expect(msgs[histIdx].entries).toEqual(["remembered"]);
    expect(order.indexOf("inputHistory")).toBeLessThan(order.indexOf("ensureReady"));
  });

  it("hands back an empty list when nothing was ever sent", async () => {
    const { provider, postMessage } = createProvider();
    (provider as any).syncWebviewState = vi.fn();
    await (provider as any).handleWebviewMessage({ type: "webviewReady" });
    const msgs = postMessage.mock.calls.map((c: any) => c[0]);
    const hist = msgs.find((m: any) => m.type === "inputHistory");
    expect(hist).toBeDefined();
    expect(hist.entries).toEqual([]);
  });
});
