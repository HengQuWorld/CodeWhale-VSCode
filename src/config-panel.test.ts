import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  let messageHandler: ((msg: Record<string, unknown>) => Promise<void> | void) | null = null;
  const postMessage = vi.fn();
  const panel = {
    webview: {
      html: "",
      postMessage,
      onDidReceiveMessage: vi.fn((cb: (msg: Record<string, unknown>) => Promise<void> | void) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    panel,
    postMessage,
    getMessageHandler: () => messageHandler,
  };
});

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: undefined,
    createWebviewPanel: vi.fn(() => vscodeState.panel),
  },
  ViewColumn: {
    One: 1,
  },
}));

import { ConfigPanel } from "./config-panel";

describe("ConfigPanel provider preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ConfigPanel.currentPanel = undefined;
  });

  it("switches the previewed model to the provider default when provider changes", async () => {
    const api = {
      getConfig: vi.fn(async () => ({
        model: "deepseek-v4-pro",
        provider: "deepseek",
      })),
      listProviders: vi.fn(async () => ({
        current: "deepseek",
        providers: [
          {
            id: "deepseek",
            display_name: "DeepSeek",
            default_base_url: "https://api.deepseek.com",
            default_model: "deepseek-v4-pro",
            has_model_catalog: true,
            env_vars: ["DEEPSEEK_API_KEY"],
          },
          {
            id: "openai",
            display_name: "OpenAI",
            default_base_url: "https://api.openai.com/v1",
            default_model: "gpt-4.1",
            has_model_catalog: true,
            env_vars: ["OPENAI_API_KEY"],
          },
        ],
      })),
      listProviderModels: vi.fn(async (providerId: string) => ({
        provider: providerId,
        models: providerId === "openai" ? [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] : [{ id: "deepseek-v4-pro" }],
      })),
      setConfig: vi.fn(),
      reloadConfig: vi.fn(),
    };

    ConfigPanel.createOrShow({} as any, api as any);
    await Promise.resolve();
    await Promise.resolve();

    const handler = vscodeState.getMessageHandler();
    expect(handler).toBeTruthy();

    await handler?.({ type: "providerChanged", provider: "openai" });

    expect(vscodeState.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providerModels",
      provider: "openai",
      currentModel: "gpt-4.1",
      previewBaseUrl: "https://api.openai.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    }));
  });

  it("renders inline script that updates preview base URL and avoids preserving stale models when currentModel is explicit", () => {
    const api = {
      getConfig: vi.fn(async () => ({
        model: "deepseek-v4-pro",
        provider: "deepseek",
      })),
      listProviders: vi.fn(async () => ({
        current: "deepseek",
        providers: [],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "deepseek",
        models: [{ id: "deepseek-v4-pro" }],
      })),
      setConfig: vi.fn(),
      reloadConfig: vi.fn(),
    };

    ConfigPanel.createOrShow({} as any, api as any);

    const html = vscodeState.panel.webview.html;
    expect(html).toContain("setFieldValue('cfg-base_url', msg.previewBaseUrl);");
    expect(html).toContain("if (!hasExplicitCurrentModel && prev && !msg.models.includes(prev))");
  });
});
