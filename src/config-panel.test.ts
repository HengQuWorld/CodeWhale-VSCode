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

  it("switching the Provider select applies that provider and re-reads the form", async () => {
    // The endpoint and the model list belong to the route the engine actually
    // runs, so the select switches to it (the same call the toolbar picker
    // makes) and the form is then re-read from the engine. The old path only
    // previewed a base URL the catalog never publishes and left the previous
    // route's endpoint on screen under the new route's name.
    const api = {
      getConfig: vi.fn(async () => ({
        model: "deepseek-v4-pro",
        provider: "deepseek",
      })),
      listProviders: vi.fn(async () => ({
        current: "deepseek",
        current_provider_id: "deepseek",
        providers: [
          {
            id: "deepseek",
            model_provider_id: "deepseek",
            display_name: "DeepSeek",
            default_model: "deepseek-v4-pro",
            has_model_catalog: true,
          },
          {
            id: "custom",
            model_provider_id: "bigmodel-cn",
            display_name: "bigmodel-cn (custom)",
            default_model: "glm-5.3",
            has_model_catalog: true,
          },
        ],
      })),
      listProviderModels: vi.fn(async (providerId: string) => ({
        provider: providerId,
        models: providerId === "custom" ? [{ id: "glm-5.3" }] : [{ id: "deepseek-v4-pro" }],
      })),
      switchProvider: vi.fn(async () => ({
        provider: "bigmodel-cn",
        model: "glm-5.3",
        message: "Provider switched to bigmodel-cn (model: glm-5.3, resolved from config).",
        persisted: true,
      })),
      setConfig: vi.fn(),
      reloadConfig: vi.fn(),
    };

    ConfigPanel.createOrShow({} as any, api as any);
    await Promise.resolve();
    await Promise.resolve();

    const handler = vscodeState.getMessageHandler();
    expect(handler).toBeTruthy();

    await handler?.({ type: "switchProviderNow", provider: "bigmodel-cn" });

    // A named route is switched through the pair the catalog published.
    expect(api.switchProvider).toHaveBeenCalledWith("custom", undefined, "bigmodel-cn");
    // And the form is re-read afterwards, so its endpoint describes the route
    // that is now active instead of the one that used to be.
    expect(api.getConfig.mock.calls.length).toBeGreaterThan(1);
    expect(vscodeState.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "configData" })
    );
  });

  it("renders the canonical mode and permission-posture options", () => {
    const api = {
      getConfig: vi.fn(async () => ({ model: "deepseek-v4-pro", provider: "deepseek" })),
      listProviders: vi.fn(async () => ({ current: "deepseek", providers: [] })),
      listProviderModels: vi.fn(async () => ({ provider: "deepseek", models: [] })),
      setConfig: vi.fn(),
      reloadConfig: vi.fn(),
    };

    ConfigPanel.createOrShow({} as any, api as any);
    const html = vscodeState.panel.webview.html;

    expect(html).toContain('<option value="agent">Act</option>');
    expect(html).toContain('<option value="plan">Plan</option>');
    expect(html).toContain('<option value="operate">Operate</option>');
    expect(html).toContain('<option value="ask">Ask</option>');
    expect(html).toContain('<option value="auto-review">Auto-Review</option>');
    expect(html).toContain('<option value="full-access">Full Access</option>');
    // `use-tui-default` is an approval_policy choice and `never` is a
    // managed-policy value; neither is part of the approval_mode enum.
    expect(html).not.toContain('use-tui-default');
    expect(html).not.toContain('value="never"');
  });

  it("renders inline script that switches the provider and avoids preserving stale models when currentModel is explicit", () => {
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
      switchProvider: vi.fn(),
      setConfig: vi.fn(),
      reloadConfig: vi.fn(),
    };

    ConfigPanel.createOrShow({} as any, api as any);

    const html = vscodeState.panel.webview.html;
    expect(html).toContain("vscode.postMessage({ type: 'switchProviderNow', provider: providerName });");
    // The catalog never publishes endpoints, so a preview fetched from it could
    // only ever be undefined — the field it wrote was never updated.
    expect(html).not.toContain("previewBaseUrl");
    // A named route is offered by the name the `provider` key holds.
    expect(html).toContain("var value = p.model_provider_id || p.id;");
    // ...and its endpoint is not editable through this key, so the form names
    // the table that owns it instead of offering an edit that cannot land.
    expect(html).toContain("baseUrlEl.disabled = !!namedRoute;");
    expect(html).toContain("p.model_provider_id || p.id;");
    expect(html).toContain("if (!hasExplicitCurrentModel && prev && !msg.models.includes(prev))");
  });
});
