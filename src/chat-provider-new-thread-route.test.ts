import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    // The poisoned value this test is about: one global default model, left
    // behind by whichever provider was touched last.
    ["defaultModel", "deepseek-flash"],
    ["modelByProvider", {} as Record<string, string>],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
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
    get workspaceFolders() {
      return vscodeState.workspaceFolders;
    },
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
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

/** The catalog the Runtime publishes for this machine: the DeepSeek vendor
 *  route, the legacy Anthropic dialect route (no key), and the user's Zhipu
 *  route. Only the active entry carries `model_provider_id` for a built-in. */
const CATALOG = [
  {
    id: "deepseek",
    model_provider_id: null,
    display_name: "DeepSeek",
    default_model: "deepseek-flash",
    has_model_catalog: true,
    credentialState: "configured",
  },
  {
    id: "deepseek-anthropic",
    model_provider_id: "deepseek-anthropic",
    display_name: "DeepSeek",
    default_model: "deepseek-flash",
    has_model_catalog: true,
    credentialState: "missing",
  },
  {
    id: "custom",
    model_provider_id: "bigmodel-cn",
    display_name: "bigmodel-cn (custom)",
    default_model: "glm-5.3",
    has_model_catalog: true,
    credentialState: "configured",
  },
];

function createHarness(opts: {
  current?: string | null;
  currentId?: string | null;
  providers?: unknown[];
}) {
  const createThread = vi.fn(async (request: Record<string, unknown>) => ({
    id: "thread-created",
    model: request.model,
    model_provider: request.model_provider,
    model_provider_id: request.model_provider_id,
    mode: request.mode,
    workspace: request.workspace ?? "",
    auto_approve: false,
    trust_mode: false,
  }));
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    createThread,
    getThread: vi.fn(async () => ({ id: "thread-created", model: "glm-5.3" })),
    updateThread: vi.fn(async (_id: string, updates: Record<string, unknown>) => updates),
    startTurn: vi.fn(async () => ({ turn: { id: "turn-1" } })),
    streamEvents: vi.fn(() => ({ abort: vi.fn() })),
    startTurnStream: vi.fn(),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).refreshSessionList = vi.fn(async () => undefined);
  (provider as any).refreshThreadList = vi.fn();
  (provider as any).refreshWorkPanel = vi.fn();
  (provider as any).providersCache = opts.providers ?? CATALOG;
  (provider as any).currentProvider = opts.current ?? null;
  (provider as any).currentProviderId = opts.currentId ?? null;

  return { api, provider, createThread };
}

async function sendFirstMessage(provider: ChatProvider) {
  await (provider as any).handleWebviewMessage({ type: "sendMessage", text: "hello" });
}

describe("new thread route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeState.configValues.set("defaultModel", "deepseek-flash");
    vscodeState.configValues.set("modelByProvider", {});
    vscodeState.configValues.set("defaultMode", "agent");
    vscodeState.configValues.set("reasoningEffort", "auto");
    vscodeState.configValues.set("autoApprove", false);
    vscodeState.workspaceFolders = undefined;
  });

  it("pins the new thread to the active route and that route's model", async () => {
    // The regression: the thread was created with the global `defaultModel`
    // (`deepseek-flash`) while the runtime paired it with whichever provider
    // was active. Under the Zhipu route that is `400 模型不存在`.
    const { provider, createThread } = createHarness({
      current: "custom",
      currentId: "bigmodel-cn",
    });

    await sendFirstMessage(provider);

    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "glm-5.3",
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    }));
  });

  it("prefers the model remembered for that route over the runtime's own default", async () => {
    vscodeState.configValues.set("modelByProvider", { "bigmodel-cn": "glm-4.6" });
    const { provider, createThread } = createHarness({
      current: "custom",
      currentId: "bigmodel-cn",
    });

    await sendFirstMessage(provider);

    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "glm-4.6",
      model_provider: "custom",
      model_provider_id: "bigmodel-cn",
    }));
  });

  it("keeps one route's remembered model out of another route's new thread", async () => {
    vscodeState.configValues.set("modelByProvider", { "bigmodel-cn": "glm-4.6" });
    const { provider, createThread } = createHarness({
      current: "deepseek",
      currentId: "deepseek",
      providers: [
        { ...CATALOG[0], model_provider_id: "deepseek" },
        ...CATALOG.slice(1),
      ],
    });

    await sendFirstMessage(provider);

    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek-flash",
      model_provider: "deepseek",
      model_provider_id: "deepseek",
    }));
  });

  it("falls back to the global default when the runtime publishes no active route", async () => {
    // A runtime older than the provider catalog: nothing is claimed about the
    // route, so the pre-existing behaviour stands rather than guessing one.
    const { provider, createThread } = createHarness({ current: null, currentId: null });

    await sendFirstMessage(provider);

    const request = createThread.mock.calls[0][0];
    expect(request.model).toBe("deepseek-flash");
    expect(request.model_provider).toBeUndefined();
    expect(request.model_provider_id).toBeUndefined();
  });

  it("sends neither half of the route for a legacy record that names only the literal custom kind", async () => {
    // `custom` without an exact id is the legacy root-level route, and the
    // runtime refuses that kind outright once the live config selects a named
    // route ("… will not guess or fall back"). Sending it would turn a rebuild
    // into a 400; omitting it leaves the record on the runtime's own active
    // route, which is what this client did before it sent routes at all.
    const { provider, createThread, api } = createHarness({
      current: "deepseek",
      currentId: "deepseek",
    });
    (api.getThread as any).mockRejectedValueOnce(new Error("thread not found"));
    (provider as any).currentThread = {
      id: "thread-legacy",
      model: "glm-5.3",
      model_provider: "custom",
      model_provider_id: null,
      mode: "agent",
      workspace: "/tmp",
      auto_approve: false,
      trust_mode: false,
      allow_shell: true,
    };

    await sendFirstMessage(provider);

    const request = createThread.mock.calls[0][0];
    expect(request.model).toBe("glm-5.3");
    expect(request.model_provider).toBeUndefined();
    expect(request.model_provider_id).toBeUndefined();
  });

  it("keeps a legacy record's built-in provider when the exact id is missing", async () => {
    // A built-in kind stands on its own: the runtime resolves `deepseek` back
    // to that route and fills the exact id itself (verified against an engine:
    // `POST /v1/threads` with the kind alone answers 201 and stores both).
    const { provider, createThread, api } = createHarness({
      current: "deepseek",
      currentId: "deepseek",
    });
    (api.getThread as any).mockRejectedValueOnce(new Error("thread not found"));
    (provider as any).currentThread = {
      id: "thread-legacy-2",
      model: "deepseek-flash",
      model_provider: "deepseek",
      model_provider_id: null,
      mode: "agent",
      workspace: "/tmp",
      auto_approve: false,
      trust_mode: false,
      allow_shell: true,
    };

    await sendFirstMessage(provider);

    expect(createThread.mock.calls[0][0]).toMatchObject({
      model: "deepseek-flash",
      model_provider: "deepseek",
    });
  });

  it("publishes the route once, and again after the catalog itself is refreshed", async () => {
    // `postCurrentSettings()` runs on every chip-affecting action and each
    // publish makes the webview re-request the route's model list, so an
    // unchanged answer is not republished; a refreshed catalog is, because its
    // contents are what changed.
    const { provider } = createHarness({ current: "custom", currentId: "bigmodel-cn" });
    const publishedCount = () =>
      (provider.postMessage as any).mock.calls
        .map((c: any[]) => c[0])
        .filter((m: any) => m?.type === "providersUpdated").length;

    (provider as any).postCurrentSettings();
    (provider as any).postCurrentSettings();
    expect(publishedCount()).toBe(1);

    (provider as any).postProviders(true);
    expect(publishedCount()).toBe(2);
  });

  it("does not offer a placeholder model for a pass-through route", async () => {
    // `custom` publishes `custom-model` with no catalog; a new thread under a
    // runtime that reports no exact id keeps the global default instead.
    const { provider, createThread } = createHarness({
      current: "custom",
      currentId: null,
      providers: [
        {
          id: "custom",
          model_provider_id: null,
          display_name: "Custom (OpenAI-compatible)",
          default_model: "custom-model",
          has_model_catalog: false,
          credentialState: "missing",
        },
      ],
    });

    await sendFirstMessage(provider);

    const request = createThread.mock.calls[0][0];
    expect(request.model).toBe("deepseek-flash");
    expect(request.model_provider).toBeUndefined();
  });
});
