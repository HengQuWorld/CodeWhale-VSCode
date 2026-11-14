import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

/** One Lens entry, shaped the way the engine serialises `LensEntry`. */
function lensEntry(overrides: Record<string, any> = {}) {
  return {
    memory: {
      id: "3f2a1b9c-0000-4000-8000-000000000000",
      revision: 2,
      status: "candidate",
      draft: {
        scope: { tenant: "tenant", user: "user", workspace: "ws-1" },
        kind: "fact",
        title: "Prefers pnpm",
        body: "The user wants pnpm, not npm.",
        key: null,
        tags: [],
        confidence: 0.5,
        importance: 0.5,
        evidence: [],
        repository_revision: null,
        dependencies: {},
        expires_at: null,
        valid_from: null,
        valid_until: null,
        parent_ids: [],
      },
      created_at: 100,
      updated_at: 100,
      content_hash: "sha256:abc",
    },
    freshness: "current",
    preferences: { revision: 1, pinned: false, suppressed: false },
    in_contexts: [],
    ...overrides,
  };
}

function lensSnapshot(entries: any[], overrides: Record<string, unknown> = {}) {
  return {
    schema: "codewhale.memory.lens/v1",
    entries,
    next_after: null,
    contexts: [],
    as_of: 1000,
    can_review: true,
    can_forget: true,
    can_dispatch: true,
    ...overrides,
  };
}

function createProvider(overrides: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getMemoryLens: vi.fn(async () => lensSnapshot([lensEntry()])),
    memoryLensAction: vi.fn(async () => ({
      ok: true,
      refresh_required: true,
      already_sent_context_cannot_be_retracted: true,
    })),
    createMemoryEntry: vi.fn(async (text: string, scope: string) => ({
      entry: { id: 4, scope, summary: text, stale: false },
    })),
    ...overrides,
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  provider.refreshGoal = vi.fn(async () => undefined);
  (provider as any).startPeriodicTaskRefresh = vi.fn();
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).apiCapabilities.memory = true;
  provider.currentThread = { id: "thread-1" } as any;
  provider.messages = [] as any;
  (provider as any).eventController = new AbortController();

  return { provider, api, postMessage: provider.postMessage as any };
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

describe("ChatProvider memory panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the Lens for this conversation and publishes it row by row", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.refreshMemoryPanel();

    // The thread id widens the read to the conversation's own session scope;
    // without it a session note would be invisible in the thread it applies to.
    expect(api.getMemoryLens).toHaveBeenCalledWith({ threadId: "thread-1", limit: 100 });
    const state = messagesOfType(postMessage, "memoryState")[0];
    expect(state.canReview).toBe(true);
    expect(state.canForget).toBe(true);
    expect(state.problem).toBeNull();
    expect(state.entries).toEqual([
      expect.objectContaining({
        id: "3f2a1b9c-0000-4000-8000-000000000000",
        shortId: "3f2a1b9c",
        revision: 2,
        // Pin and exclude write against this counter, not the entry's.
        preferencesRevision: 1,
        status: "candidate",
        title: "Prefers pnpm",
        scope: "workspace",
        freshness: "current",
        pinned: false,
        suppressed: false,
      }),
    ]);
  });

  it("names a session scope as the conversation's own", async () => {
    const { provider, postMessage } = createProvider({
      getMemoryLens: vi.fn(async () =>
        lensSnapshot([
          lensEntry({
            memory: {
              ...lensEntry().memory,
              draft: {
                ...lensEntry().memory.draft,
                scope: { tenant: "t", user: "u", workspace: "ws-1", session: "thread-1" },
              },
            },
          }),
        ])
      ),
    });

    await provider.refreshMemoryPanel();

    expect(messagesOfType(postMessage, "memoryState")[0].entries[0].scope).toBe("session");
  });

  it("offers nothing when the engine does not advertise memory at all", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.memory = false;

    await provider.refreshMemoryPanel();

    expect(api.getMemoryLens).not.toHaveBeenCalled();
    const state = messagesOfType(postMessage, "memoryState")[0];
    expect(state.entries).toEqual([]);
    expect(state.problem.kind).toBe("unsupported");
    expect(state.canReview).toBe(false);
    expect(state.canForget).toBe(false);
  });

  it("separates a store that is turned off from one that does not exist", async () => {
    const { provider, postMessage } = createProvider({
      getMemoryLens: vi.fn(async () => {
        throw new Error('API error 503: {"error":"disabled"}');
      }),
    });

    await provider.refreshMemoryPanel();

    // 503 is a configuration answer; saying "this engine is too old" would send
    // the reader to the wrong fix.
    expect(messagesOfType(postMessage, "memoryState")[0].problem.kind).toBe("disabled");
  });

  it("calls a missing route unsupported, and does not mistake an id for a status", async () => {
    const { provider, postMessage } = createProvider({
      getMemoryLens: vi.fn(async () => {
        throw new Error("API error 404: no memory 4043f2a in this scope");
      }),
    });

    await provider.refreshMemoryPanel();

    expect(messagesOfType(postMessage, "memoryState")[0].problem.kind).toBe("unsupported");
  });

  it("keeps the rows it had when a later read fails", async () => {
    const getMemoryLens = vi
      .fn()
      .mockResolvedValueOnce(lensSnapshot([lensEntry()]))
      .mockRejectedValueOnce(new Error("socket closed"));
    const { provider, postMessage } = createProvider({ getMemoryLens });

    await provider.refreshMemoryPanel();
    await provider.refreshMemoryPanel();

    const state = messagesOfType(postMessage, "memoryState")[1];
    expect(state.problem.kind).toBe("failed");
    expect(state.entries).toHaveLength(1);
    expect(state.canReview).toBe(true);
  });

  it("sends the revision the panel displayed and re-reads after the decision", async () => {
    const { provider, api, postMessage } = createProvider();
    await provider.refreshMemoryPanel();
    (api.getMemoryLens as any).mockClear();

    await provider.memoryLensAction("approve", "3f2a1b9c-0000-4000-8000-000000000000", 2);

    expect(api.memoryLensAction).toHaveBeenCalledWith({
      action: "approve",
      id: "3f2a1b9c-0000-4000-8000-000000000000",
      revision: 2,
    });
    // The engine's caveat travels with the receipt: a decision changes what
    // later turns are given, never what a model already received.
    expect(messagesOfType(postMessage, "info")[0].message).toContain(
      "Text already sent to the model cannot be retracted.",
    );
    expect(api.getMemoryLens).toHaveBeenCalledTimes(1);
  });

  it("sends both preference flags as one command", async () => {
    const { provider, api } = createProvider();

    await provider.memoryLensAction("preferences", "id-1", 3, { pinned: true, suppressed: false });

    expect(api.memoryLensAction).toHaveBeenCalledWith({
      action: "preferences",
      id: "id-1",
      revision: 3,
      pinned: true,
      suppressed: false,
    });
  });

  it("explains a lost revision race and refreshes instead of guessing", async () => {
    const memoryLensAction = vi.fn(async () => {
      throw new Error('API error 409: {"error":"revision_conflict"}');
    });
    const { provider, api, postMessage } = createProvider({ memoryLensAction });
    await provider.refreshMemoryPanel();
    (api.getMemoryLens as any).mockClear();

    await provider.memoryLensAction("reject", "id-1", 1);

    expect(messagesOfType(postMessage, "error")[0].message).toContain("refreshed");
    expect(api.getMemoryLens).toHaveBeenCalledTimes(1);
  });

  it("refuses an action it does not know rather than inventing one", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.memoryLensAction("rewrite", "id-1", 1);

    expect(api.memoryLensAction).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "error")[0].message).toContain("Usage: /memory");
  });

  it("remembers a note with the scope the reader chose, then re-reads", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.rememberMemory("  Prefers pnpm  ", "workspace");

    expect(api.createMemoryEntry).toHaveBeenCalledWith("Prefers pnpm", "workspace");
    expect(messagesOfType(postMessage, "info")[0].message).toContain("Remembered #4 (workspace)");
    expect(api.getMemoryLens).toHaveBeenCalledTimes(1);
  });

  it("does not silently downgrade an unknown scope to global", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.rememberMemory("a note", "session");

    expect(api.createMemoryEntry).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "error")[0].message).toContain("Invalid memory scope");
  });

  it("routes the panel's messages through the provider", async () => {
    const { provider, api } = createProvider();

    await (provider as any).handleWebviewMessage({
      type: "memoryLensAction",
      action: "forget",
      id: "id-9",
      revision: 5,
    });

    expect(api.memoryLensAction).toHaveBeenCalledWith({
      action: "forget",
      id: "id-9",
      revision: 5,
    });
  });
});
