import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
    showWarningMessage: vi.fn(),
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
    showWarningMessage: vscodeState.showWarningMessage,
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
    expect(api.switchProvider).toHaveBeenCalledWith("volcengine", undefined, undefined);
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

  it("passes the explicit model to switchProvider and remembers it for that route when the user chose one", async () => {
    // Mirrors the TUI's `/provider volcengine glm-2` flow: the model arg is
    // forwarded to the backend, which persists `[providers.volcengine].model`
    // and returns the same model in the response.
    //
    // The client half is remembered per route (`modelByProvider`) and NOT in
    // the single global `defaultModel`: one global value is shared by every
    // provider, which is how a model chosen here ended up pinned to a thread
    // created under a different route.
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

    expect(api.switchProvider).toHaveBeenCalledWith("volcengine", "glm-2", undefined);
    expect(vscodeState.configValues.get("modelByProvider")).toEqual({ volcengine: "glm-2" });
    expect(vscodeState.updateMock).not.toHaveBeenCalledWith(
      "defaultModel", expect.anything(), expect.anything()
    );
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "settingsUpdated",
      model: "glm-2",
      provider: "volcengine",
    }));
  });

  it("remembers the resolved model under the route that was asked for, even if the catalog refresh fails", async () => {
    // `refreshProviders` swallows a failed catalog read. Keying the memory off
    // the post-refresh active route would then write this route's model onto
    // whatever route was active before — poisoning a route the user did not
    // touch.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => ({
        provider: "volcengine",
        model: "glm-2",
        message: "Provider switched to volcengine.",
        persisted: true,
      })),
      listProviders: vi.fn(async () => {
        throw new Error("engine restarting");
      }),
      listProviderModels: vi.fn(async () => ({ provider: "volcengine", models: [] })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    // Stale state from before the switch: a refresh that fails leaves these
    // pointing at the previous route.
    (provider as any).currentProvider = "deepseek";
    (provider as any).currentProviderId = "deepseek";

    await (provider as any).handleSwitchProvider("volcengine");

    expect(vscodeState.configValues.get("modelByProvider")).toEqual({ volcengine: "glm-2" });
  });

  it("remembers a model for the route on screen, not the picker's", async () => {
    // `/model` with no explicit route reaches this same method. A model chosen
    // for a conversation belongs to that conversation's route — the picker may
    // have moved on, and writing under its key would apply the choice somewhere
    // the user never made it.
    const api = { bindEngine: vi.fn(), ensureReady: vi.fn(async () => undefined) };
    const provider = new ChatProvider({} as any, {} as any, api as any);
    (provider as any).currentProvider = "deepseek";
    (provider as any).currentProviderId = "deepseek";
    (provider as any).currentThread = {
      id: "thread-1",
      model: "glm-5.3",
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    };

    await provider.rememberModelForRoute("glm-5.4");

    expect(vscodeState.configValues.get("modelByProvider")).toEqual({ "bigmodel-cn": "glm-5.4" });
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

  it("carries the exact route id when the picker selects a user-defined [providers.<name>] route", async () => {
    // Such a route reports the generic 'custom' kind plus its own name in
    // model_provider_id. The pair is what names it: switching on the kind
    // alone selects nothing the user configured, and asking for the model
    // list without the exact id answers for the wrong route (or 400s).
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => ({
        provider: "bigmodel-cn",
        model: "glm-5.3",
        message: "Provider switched to bigmodel-cn (model: glm-5.3, resolved from config).",
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "custom",
        current_provider_id: "bigmodel-cn",
        providers: [
          {
            id: "custom",
            model_provider_id: "bigmodel-cn",
            display_name: "bigmodel-cn (custom)",
            default_model: "glm-5.3",
            has_model_catalog: true,
          },
        ],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "custom",
        models: [{ id: "glm-5.3" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    await (provider as any).handleSwitchProvider("custom", undefined, "bigmodel-cn");

    expect(api.switchProvider).toHaveBeenCalledWith("custom", undefined, "bigmodel-cn");
    expect(api.listProviderModels).toHaveBeenCalledWith("custom", "bigmodel-cn");

    // The active exact id reaches the picker, so it marks the route that is
    // actually selected rather than the first entry sharing the kind.
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providersUpdated",
      current: "custom",
      currentProviderId: "bigmodel-cn",
    }));
    expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "providerModels",
      provider: "custom",
      providerId: "bigmodel-cn",
      currentModel: "glm-5.3",
    }));
    expect((provider as any).getCurrentProviderId()).toBe("bigmodel-cn");
  });

  it("names the route it answered for, including a built-in provider's exact id", async () => {
    // The webview drops a model list whose route is not the one on screen, and
    // the chip carries the exact id the catalog reported — which for a built-in
    // provider is its own id. A switch that carried no explicit route (the
    // `/provider volcengine` path) must still answer with that id, or every
    // answer for a built-in provider looks stale and the model list never
    // refreshes.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => ({
        provider: "volcengine",
        model: "glm-2",
        message: "Provider switched to volcengine (model: glm-2, resolved from config).",
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "volcengine",
        current_provider_id: "volcengine",
        providers: [
          {
            id: "volcengine",
            model_provider_id: "volcengine",
            display_name: "Volcengine Ark",
            default_model: "glm-2",
            has_model_catalog: true,
          },
        ],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "volcengine",
        models: [{ id: "glm-2" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    // No exact route: this is `/provider volcengine`, not a picker click.
    await (provider as any).handleSwitchProvider("volcengine");

    // The model list is requested for the route the view is bound to, which
    // after the switch is the route the catalog just reported — exact id
    // included, the way every other request names a route. The answer then
    // carries that same pair, so the chip's guard accepts it as current.
    expect(api.listProviderModels).toHaveBeenCalledWith("volcengine", "volcengine");
    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "providerModels",
        provider: "volcengine",
        providerId: "volcengine",
      })
    );
  });

  it("answers the model list for the open conversation's route, not the picker's", async () => {
    // Once the picker moves on, a conversation keeps the provider it was
    // created on (no endpoint re-routes a thread). Offering the picker's models
    // is how `deepseek-flash` was chosen for a thread pinned to the Zhipu
    // route, and the provider answered `400 模型不存在` for it.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      listProviderModels: vi.fn(async (id: string) => ({
        provider: id,
        models: id === "custom" ? [{ id: "glm-5.3" }] : [{ id: "deepseek-flash" }],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    (provider as any).providersCache = [
      { id: "custom", model_provider_id: "bigmodel-cn", display_name: "bigmodel-cn (custom)", default_model: "glm-5.3", has_model_catalog: true },
      { id: "deepseek", model_provider_id: "deepseek", display_name: "DeepSeek", default_model: "deepseek-flash", has_model_catalog: true },
    ];
    // The picker has moved to DeepSeek; the conversation is still on Zhipu.
    (provider as any).currentProvider = "deepseek";
    (provider as any).currentProviderId = "deepseek";
    (provider as any).currentThread = {
      id: "thread-1",
      model: "glm-5.3",
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    };

    await (provider as any).handleRequestProviderModels("deepseek", undefined, "deepseek");

    expect(api.listProviderModels).toHaveBeenCalledWith("custom", "bigmodel-cn");
    expect(provider.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "providerModels",
        provider: "custom",
        providerId: "bigmodel-cn",
        models: ["glm-5.3"],
        currentModel: "glm-5.3",
      })
    );
  });

  it("tells the user a switch does not move the open conversation, and offers a new one", async () => {
    // A conversation keeps the provider it was created on — a deliberate
    // engine decision (prefix-cache economics): neither `PATCH /v1/threads`
    // nor `POST .../turns` carries a provider, and `resume-thread` says so in
    // as many words. The client must therefore not pretend the switch reached
    // this conversation, and must not try to re-route it: it says where the
    // next message goes and offers the one action that changes that.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      switchProvider: vi.fn(async () => ({
        provider: "deepseek",
        model: "deepseek-flash",
        message: "Provider switched to deepseek (model: deepseek-flash, resolved from config).",
        persisted: true,
      })),
      listProviders: vi.fn(async () => ({
        current: "deepseek",
        current_provider_id: "deepseek",
        providers: [
          {
            id: "deepseek",
            model_provider_id: "deepseek",
            display_name: "DeepSeek",
            default_model: "deepseek-flash",
            has_model_catalog: true,
            credentialState: "configured",
          },
        ],
      })),
      listProviderModels: vi.fn(async () => ({
        provider: "deepseek",
        models: [{ id: "deepseek-flash" }],
      })),
      updateThread: vi.fn(),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    provider.currentThread = {
      id: "thread-1",
      model: "glm-5.3",
      mode: "agent",
      workspace: "",
      auto_approve: false,
      trust_mode: false,
      allow_shell: true,
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    } as any;
    const newThread = vi.fn(async () => undefined);
    (provider as any).handleNewThread = newThread;

    vscodeState.showWarningMessage.mockResolvedValueOnce("New conversation");
    await (provider as any).handleSwitchProvider("deepseek", undefined, "deepseek");

    expect(vscodeState.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("keeps running on bigmodel-cn"),
      "New conversation"
    );
    expect(newThread).toHaveBeenCalled();
    // The conversation is not touched: its route is the engine's to keep.
    expect(api.updateThread).not.toHaveBeenCalled();
    expect(provider.currentThread?.model_provider_id).toBe("bigmodel-cn");
    expect(provider.currentThread?.model).toBe("glm-5.3");
  });

  it("refuses a model that belongs to another route, and passes one the route simply does not list", async () => {
    // Two different answers for two different situations. An id another route
    // is known to use is the pair a provider answers `400 模型不存在` for, so it
    // is refused. An id this route merely does not list is left alone: the
    // engine accepts name-shaped ids for a route whose catalog is not
    // exhaustive, and a client stricter than its engine rejects models that
    // work.
    const api = {
      bindEngine: vi.fn(),
      ensureReady: vi.fn(async () => undefined),
      listProviderModels: vi.fn(),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    (provider as any).providersCache = [
      {
        id: "custom",
        model_provider_id: "bigmodel-cn",
        display_name: "bigmodel-cn (custom)",
        default_model: "glm-5.3",
        has_model_catalog: true,
      },
      {
        id: "deepseek",
        model_provider_id: "deepseek",
        display_name: "DeepSeek",
        default_model: "deepseek-flash",
        has_model_catalog: true,
      },
    ];
    (provider as any).currentProvider = "deepseek";
    (provider as any).currentProviderId = "deepseek";
    (provider as any).currentThread = {
      id: "thread-1",
      model: "glm-5.3",
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    };

    // The conversation's own model, and one nothing else claims.
    expect(provider.modelFitsViewRoute("glm-5.3")).toMatchObject({
      ok: true,
      route: "bigmodel-cn",
    });
    expect(provider.modelFitsViewRoute("glm-5.4")).toMatchObject({
      ok: true,
      route: "bigmodel-cn",
    });
    // The picker's route's own default: refused, and it names where it belongs.
    expect(provider.modelFitsViewRoute("deepseek-flash")).toMatchObject({
      ok: false,
      route: "bigmodel-cn",
      foreign: "deepseek",
    });
    // The route's catalog is not consulted over the wire: this answer has to be
    // available before `/model` writes anything.
    expect(api.listProviderModels).not.toHaveBeenCalled();
  });

  it("counts a model remembered for another route as belonging to it", async () => {
    const api = { bindEngine: vi.fn(), ensureReady: vi.fn(async () => undefined) };
    const provider = new ChatProvider({} as any, {} as any, api as any);
    (provider as any).providersCache = [
      {
        id: "custom",
        model_provider_id: "bigmodel-cn",
        display_name: "bigmodel-cn (custom)",
        default_model: "glm-5.3",
        has_model_catalog: true,
      },
      {
        id: "volcengine",
        model_provider_id: null,
        display_name: "Volcengine Ark",
        default_model: "deepseek-v4-flash",
        has_model_catalog: true,
      },
    ];
    vscodeState.configValues.set("modelByProvider", { volcengine: "glm-2" });
    (provider as any).currentProvider = "custom";
    (provider as any).currentProviderId = "bigmodel-cn";

    expect(provider.modelFitsViewRoute("glm-2")).toMatchObject({
      ok: false,
      route: "bigmodel-cn",
      foreign: "volcengine",
    });
  });
});
