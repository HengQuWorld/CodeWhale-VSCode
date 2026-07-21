import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
    ["showThreadList", false],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback?: unknown) =>
        vscodeState.configValues.has(key)
          ? vscodeState.configValues.get(key)
          : fallback,
      update: vscodeState.updateMock,
    })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
  env: {
    language: "en",
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}));

import { ChatProvider } from "./chat-provider";

describe("ChatProvider provider switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.configValues.clear();
    vscodeState.configValues.set("defaultMode", "agent");
    vscodeState.configValues.set("defaultModel", "deepseek-v4-pro");
    vscodeState.configValues.set("reasoningEffort", "auto");
    vscodeState.configValues.set("autoApprove", false);
    vscodeState.configValues.set("showThreadList", false);
  });

  it("pushes the backend-resolved model with providerModels after switching provider", async () => {
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => ({
        provider: "openai",
        model: "gpt-4.1",
        message: "Provider switched to openai (model: gpt-4.1, resolved from config).",
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "openai",
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
      listProviderModels: vi.fn(async () => ({
        provider: "openai",
        models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    await (provider as any).handleSwitchProvider("openai");

    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providerModels",
      provider: "openai",
      // Must use the backend-resolved model from the switchProvider response,
      // not ProviderEntry.default_model.
      currentModel: "gpt-4.1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    }));
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "settingsUpdated",
      model: "gpt-4.1",
      provider: "openai",
    }));
  });

  it("does NOT pass a model arg to switchProvider when the user clicked the picker without choosing a model", async () => {
    // Regression: clicking volcengine in the picker used to fall back to the
    // cached provider.default_model ("deepseek-v4-pro") and persist it via
    // setConfig({ key: "model" }), clobbering the user's
    // `[providers.volcengine].model = "glm-2"`. The TUI's `/provider`
    // command passes model: None when no model arg is given; the GUI must
    // mirror that by NOT passing `model` to switchProvider, so the backend
    // decides whether to persist (it won't — preserving the user's config).
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async (_id: string, _model?: string) => ({
        // Backend resolves the user's per-provider `model = "glm-2"` and
        // returns it without persisting a `model` key.
        provider: "volcengine",
        model: "glm-2",
        message: "Provider switched to volcengine (model: glm-2, resolved from config).",
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "volcengine",
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
            id: "volcengine",
            display_name: "Volcengine Ark",
            default_base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
            // Catalog default — what the old buggy code would force-write.
            default_model: "deepseek-v4-pro",
            has_model_catalog: true,
            env_vars: ["VOLCENGINE_API_KEY"],
          },
        ],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "volcengine",
        models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    // No model arg — simulates a webview picker click.
    await (provider as any).handleSwitchProvider("volcengine");

    // switchProvider must be called with `model: undefined` so the backend
    // treats it as "no override" and does not persist a `model` key.
    expect(api.switchProvider).toHaveBeenCalledWith("volcengine", undefined);

    // The backend-resolved model (the user's `glm-2`) must be displayed,
    // NOT the catalog default `deepseek-v4-pro`.
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "settingsUpdated",
      model: "glm-2",
      provider: "volcengine",
    }));
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providerModels",
      provider: "volcengine",
      currentModel: "glm-2",
    }));

    // The VSCode `defaultModel` config must NOT have been overwritten when
    // the user did not explicitly choose a model — the resolved `glm-2` is
    // the user's per-provider value, not a global default.
    expect(vscodeState.updateMock).not.toHaveBeenCalledWith(
      "defaultModel", expect.anything(), expect.anything()
    );
  });

  it("passes the explicit model to switchProvider and persists it to VSCode config when the user chose one", async () => {
    // Mirrors the TUI's `/provider volcengine glm-2` flow: the model arg is
    // forwarded to the backend, which persists `[providers.volcengine].model`
    // and returns the same model in the response.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async (_id: string, model?: string) => ({
        provider: "volcengine",
        model: model || "",
        message: `Provider switched to volcengine (model: ${model}).`,
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "volcengine",
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
            id: "volcengine",
            display_name: "Volcengine Ark",
            default_base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
            default_model: "deepseek-v4-pro",
            has_model_catalog: true,
            env_vars: ["VOLCENGINE_API_KEY"],
          },
        ],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "volcengine",
        models: [{ id: "glm-2" }, { id: "deepseek-v4-pro" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    await (provider as any).handleSwitchProvider("volcengine", "glm-2");

    expect(api.switchProvider).toHaveBeenCalledWith("volcengine", "glm-2");
    expect(vscodeState.updateMock).toHaveBeenCalledWith(
      "defaultModel", "glm-2", "global"
    );
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "settingsUpdated",
      model: "glm-2",
      provider: "volcengine",
    }));
  });

  it("calls switchProvider before refreshing providers so stale provider state does not overwrite the UI", async () => {
    // The backend reloads config as part of switchProvider; only after it
    // returns should we re-fetch providers, so the webview sees the new
    // active provider instead of the stale one.
    let switched = false;
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => {
        switched = true;
        return {
          provider: "openai",
          model: "gpt-4.1",
          message: "ok",
          persisted: true,
        };
      }),
      listProviders: vi.fn(async () => ({
        current: switched ? "openai" : "deepseek",
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
      listProviderModels: vi.fn(async () => ({
        provider: "openai",
        models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    await (provider as any).handleSwitchProvider("openai");

    expect(api.switchProvider.mock.invocationCallOrder[0]).toBeLessThan(
      api.listProviders.mock.invocationCallOrder[0]
    );
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providersUpdated",
      current: "openai",
    }));
  });

  it("surfaces a backend error and does not update UI state when switchProvider fails", async () => {
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => {
        throw new Error("Unknown provider id 'nope'");
      }),
      listProviders: vi.fn(async () => ({ current: "deepseek", providers: [] })),
      listProviderModels: vi.fn(async () => ({ provider: "nope", models: [] })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    await (provider as any).handleSwitchProvider("nope");

    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Unknown provider id"),
    }));
    // Must NOT push a settingsUpdated or providerModels message when the
    // switch failed — the runtime state is unchanged.
    const calls = (provider.postMessage as any).mock.calls.map((c: any[]) => c[0]?.type);
    expect(calls).not.toContain("settingsUpdated");
    expect(calls).not.toContain("providerModels");
  });
});
