import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandHandler, HANDLERS } from "./slash-command-handler";
import type { SlashCommandContext } from "./slash-command-handler";
import * as fs from "fs";

// ── Mock vscode ──

const vscodeState = vi.hoisted(() => {
  const configValues = new Map<string, unknown>([
    ["defaultMode", "agent"],
    ["defaultPermissionPosture", "ask"],
    ["defaultModel", "deepseek-v4-pro"],
    ["reasoningEffort", "auto"],
    ["autoApprove", false],
    ["costCurrency", "usd"],
    ["enginePath", "codewhale"],
  ]);

  return {
    configValues,
    updateMock: vi.fn(async (key: string, value: unknown) => {
      vscodeState.configValues.set(key, value);
    }),
    executeCommandMock: vi.fn(),
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
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
  },
  commands: {
    executeCommand: vscodeState.executeCommandMock,
  },
  window: {
    showTextDocument: vi.fn(),
  },
  ConfigurationTarget: {
    Global: "global",
  },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

// ── Mock fs, path, os, child_process ──

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/home/user"),
}));

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

// ── Mock i18n ──

vi.mock("../i18n", () => ({
  t: vi.fn(() => ({ commandNotAvailableInGui: "This command is not available in GUI mode." })),
  currentLocale: vi.fn(() => "en"),
}));

// ── Mock cost-calculator ──

vi.mock("../utils/cost-calculator", () => ({
  resolveCostCurrency: vi.fn((configured: string | undefined, locale: string) => {
    if (configured === "usd" || configured === "cny") return configured;
    return locale.toLowerCase().startsWith("zh") ? "cny" : "usd";
  }),
  formatCostAmount: vi.fn((amount: number, currency: string) =>
    currency === "cny"
      ? (amount < 0.0001 ? "<¥0.0001" : amount < 0.01 ? `¥${amount.toFixed(4)}` : `¥${amount.toFixed(2)}`)
      : (amount < 0.0001 ? "<$0.0001" : amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`)
  ),
}));

// ── Mock slash-commands ──

const mockCommandRegistry = vi.hoisted(() => [
  { name: "/theme", desc: "Change theme", category: "unavailable", availability: "unavailable", helpText: "Not available: GUI uses VSCode's theme system." },
  { name: "/restore", desc: "Restore from snapshot", category: "session", availability: "full", helpText: "/restore [N|list [N]]" },
  { name: "/verbose", desc: "Toggle verbose mode", category: "unavailable", availability: "unavailable", helpText: "Not available: the GUI has no verbose output mode to toggle." },
  { name: "/profile", desc: "Switch profile", category: "unavailable", availability: "unavailable", helpText: "Not available: switching profiles must be passed to the engine at startup." },
  { name: "/translate", desc: "Toggle translation", category: "unavailable", availability: "unavailable", helpText: "Not available: translation mode is a TUI feature." },
]);

vi.mock("./slash-commands", () => ({
  isCommandAvailableInGui: vi.fn((name: string) => {
    // Default: most commands are available
    const unavailable = ["/theme", "/share", "/network", "/queue", "/stash", "/hooks", "/subagents", "/agent", "/statusline", "/cycles", "/cycle", "/recall", "/relay", "/lsp", "/review", "/rlm", "/verbose", "/profile", "/translate"];
    if (unavailable.includes(name)) return "unavailable";
    return "full";
  }),
  getCommand: vi.fn((name: string) =>
    mockCommandRegistry.find((c) => c.name === name)
  ),
}));

// ── Helper: a thread goal record as the runtime returns it ──

function goalRecord(overrides: Record<string, unknown> = {}) {
  return {
    thread_id: "thread-1",
    goal_id: "goal-1",
    objective: "Ship refactor",
    status: "active",
    token_budget: null as number | null,
    tokens_used: 0,
    time_used_seconds: 0,
    continuation_count: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

// ── Helper: create context ──

function createContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    api: {
      updateThread: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => ({ sessions: [] })),
      getThreadDetail: vi.fn(async () => ({
        thread: { id: "thread-1", system_prompt: "You are helpful." },
        turns: [],
        items: [],
      })),
      getRuntimeInfo: vi.fn(async () => ({
        bind_host: "127.0.0.1",
        port: 54321,
        auth_required: false,
        version: "0.6.0",
      })),
      getWorkspaceStatus: vi.fn(async () => ({
        workspace: "/workspace",
        git_repo: true,
        branch: "main",
        staged: 1,
        unstaged: 2,
        untracked: 3,
        ahead: 0,
        behind: 0,
      })),
      listTasks: vi.fn(async () => ({
        tasks: [],
        counts: { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 },
      })),
      createTask: vi.fn(async () => ({
        id: "task-abc123456789",
        status: "queued",
      })),
      getTask: vi.fn(async () => ({
        id: "task-1",
        status: "completed",
        prompt: "test",
      })),
      cancelTask: vi.fn(async () => undefined),
      getUsage: vi.fn(async () => ({
        since: "2025-01-01",
        until: "2025-12-31",
        group_by: "day",
        totals: {
          input_tokens: 10000,
          output_tokens: 5000,
          cached_tokens: 8000,
          reasoning_tokens: 1000,
          cost_usd: 1.5,
          turns: 20,
        },
        buckets: [],
      })),
      listAutomations: vi.fn(async () => []),
      getAutomation: vi.fn(async () => ({
        id: "auto-1",
        name: "Test Automation",
        status: "active",
        rrule: "FREQ=DAILY",
        next_run_at: null,
        last_run_at: null,
        prompt: "Test prompt",
        cwds: [],
      })),
      runAutomation: vi.fn(async () => ({
        id: "auto-1",
        name: "Test Automation",
        status: "active",
      })),
      pauseAutomation: vi.fn(async () => ({
        id: "auto-1",
        name: "Test Automation",
        status: "paused",
      })),
      resumeAutomation: vi.fn(async () => ({
        id: "auto-1",
        name: "Test Automation",
        status: "active",
        next_run_at: null,
      })),
      listAutomationRuns: vi.fn(async () => []),
      listMemory: vi.fn(async () => ({ entries: [], total: 0 })),
      getMemoryEntry: vi.fn(async () => ({
        entry: { id: 1, scope: "global", workspace_id: null, summary: "alpha note", stale: false, line_start: 1, line_end: 1, status: "active" },
      })),
      createMemoryEntry: vi.fn(async () => ({
        entry: { id: 3, scope: "global", workspace_id: null, summary: "new note", stale: false, line_start: 3, line_end: 3, status: "active" },
      })),
      clearMemory: vi.fn(async () => ({ cleared: true })),
      listSnapshots: vi.fn(async () => []),
      restoreSnapshot: vi.fn(async () => ({ restored: "snap" })),
      getThreadGoal: vi.fn(async () => null),
      upsertThreadGoal: vi.fn(async (_threadId: string, objective: string, tokenBudget?: number) =>
        goalRecord({ objective, token_budget: tokenBudget ?? null })),
      deleteThreadGoal: vi.fn(async () => undefined),
      completeThreadGoal: vi.fn(async () => goalRecord({ status: "complete" })),
      blockThreadGoal: vi.fn(async () => goalRecord({ status: "blocked" })),
    } as any,
    engine: {
      isRunning: true,
      port: 54321,
    } as any,
    currentThread: null,
    messages: [],
    sessionCostUsd: 0.05,
    sessionCostCny: 0.36,
    lastCacheHitTokens: 5000,
    lastCacheMissTokens: 1000,
    lastInputTokens: 6000,
    lastOutputTokens: 2000,
    totalInputTokens: 12000,
    totalOutputTokens: 4000,
    postMessage: vi.fn(),
    postScopedDefaults: vi.fn(),
    getCurrentModel: vi.fn(() => "deepseek-v4-pro"),
    getProvidersCache: vi.fn(() => null),
    getCurrentProvider: vi.fn(() => null),
    getCurrentProviderId: vi.fn(() => null),
    getCurrentSessionId: vi.fn(() => null),
    setCurrentSessionId: vi.fn(),
    saveCurrentSession: vi.fn(async () => ({ session_id: "session-test" })),
    refreshSessionList: vi.fn(),
    refreshTaskList: vi.fn(async () => undefined),
    refreshWorkPanel: vi.fn(),
    refreshGoal: vi.fn(async () => undefined),
    loadSessionMessages: vi.fn(async () => undefined),
    handleInterrupt: vi.fn(async () => undefined),
    handleCompact: vi.fn(async () => undefined),
    handleUndoLastTurn: vi.fn(async () => undefined),
    handleRetryLastTurn: vi.fn(async () => undefined),
    handleAttachFile: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

describe("SlashCommandHandler - Dispatcher Pattern", () => {
  beforeEach(() => {
    vscodeState.configValues.clear();
    vscodeState.configValues.set("defaultMode", "agent");
    vscodeState.configValues.set("defaultModel", "deepseek-v4-pro");
    vscodeState.configValues.set("reasoningEffort", "auto");
    vscodeState.configValues.set("autoApprove", false);
    vscodeState.configValues.set("costCurrency", "usd");
    vscodeState.configValues.set("enginePath", "codewhale");
    vscodeState.updateMock.mockClear();
    vscodeState.executeCommandMock.mockClear();
  });

  // ── Dispatcher routing ──

  describe("Command routing", () => {
    it("routes unknown command to error message", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);
      await handler.handle("/nonexistent", "");
      expect(ctx.postMessage).toHaveBeenCalledWith({
        type: "error",
        message: "Unknown command: /nonexistent. Type /help for available commands.",
      });
    });

    it("blocks unavailable commands that are in HANDLERS map", async () => {
      // /share is unavailable per slash-commands registry but let's test the
      // availability guard by temporarily adding a handler.
      // Since no HANDLERS entry is currently unavailable, we test the guard
      // by mocking isCommandAvailableInGui to return "unavailable" for /clear.
      const { isCommandAvailableInGui } = await import("./slash-commands");
      vi.mocked(isCommandAvailableInGui).mockReturnValueOnce("unavailable");

      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);
      await handler.handle("/clear", "");
      expect(ctx.postMessage).toHaveBeenCalledWith({
        type: "info",
        message: "This command is not available in GUI mode.",
      });
    });

    it("routes known-but-unavailable (not-in-HANDLERS) commands to their helpText", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);
      await handler.handle("/theme", "");
      expect(ctx.postMessage).toHaveBeenCalledWith({
        type: "info",
        message: "/theme: Not available: GUI uses VSCode's theme system.",
      });
    });

    it("HANDLERS map covers all expected commands", () => {
      const expectedCommands = [
        "/mode", "/model", "/models", "/reasoning", "/config", "/settings",
        "/interrupt", "/clear", "/compact", "/exit", "/rename", "/save",
        "/export", "/context", "/tokens", "/cost", "/status", "/home",
        "/workspace", "/task", "/trust", "/undo", "/retry",
        "/attach", "/goal", "/skills", "/skill", "/mcp", "/provider",
        "/links", "/feedback", "/anchor", "/sessions", "/load", "/change",
        "/cache", "/system", "/edit", "/diff",
        "/jobs", "/logout", "/note", "/memory",
      ];
      for (const cmd of expectedCommands) {
        expect(HANDLERS[cmd], `Missing handler for ${cmd}`).toBeDefined();
      }
    });

    it("every handler in HANDLERS is a function", () => {
      for (const [cmd, fn] of Object.entries(HANDLERS)) {
        expect(typeof fn, `Handler for ${cmd} should be a function`).toBe("function");
      }
    });
  });

  // ── /mode ──

  describe("/mode", () => {
    it("applies Act and patches only the mode so the runtime keeps the posture", async () => {
      const currentThread = {
        id: "thread-1",
        mode: "plan",
        model: "deepseek-v4-pro",
        trust_mode: false,
        auto_approve: false,
      } as any;
      const updateThread = vi.fn(async () => ({
        ...currentThread,
        mode: "agent",
      }));
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mode", "agent");

      // Thread-scoped: the startup default for new threads has its own control
      // (the dropdown's second group), so a thread's mode command must not move it.
      expect(vscodeState.updateMock).not.toHaveBeenCalled();
      // Mode-only patch: sending auto_approve would let the runtime re-derive
      // (and possibly downgrade) the thread's permission posture.
      expect(updateThread).toHaveBeenCalledWith("thread-1", { mode: "agent" });
      expect(postMessage).toHaveBeenCalledWith({
        type: "settingsUpdated",
        mode: "agent",
        posture: "ask",
        model: "deepseek-v4-pro",
        reasoningEffort: "auto",
      });
      expect(currentThread.mode).toBe("agent");
    });

    it("keeps the local thread mode in sync even when updateThread returns no body", async () => {
      const currentThread = {
        id: "thread-1",
        mode: "plan",
        model: "deepseek-v4-pro",
        trust_mode: false,
        auto_approve: false,
      } as any;
      const updateThread = vi.fn(async () => undefined);
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mode", "agent");

      expect(updateThread).toHaveBeenCalledWith("thread-1", { mode: "agent" });
      expect(currentThread.mode).toBe("agent");
      expect(postMessage).toHaveBeenCalledWith({
        type: "settingsUpdated",
        mode: "agent",
        posture: "ask",
        model: "deepseek-v4-pro",
        reasoningEffort: "auto",
      });
    });

    it("switches to plan mode", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mode", "plan");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("defaultMode", "plan", "global");
      // The value the "New threads" group is marked against just moved, so it
      // has to be re-announced — the chips alone would leave the group ticking
      // the old mode.
      expect(ctx.postScopedDefaults).toHaveBeenCalled();
    });

    it("maps numeric shortcuts to Act / Plan / Operate", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });

      const handler = new SlashCommandHandler(ctx);
      await handler.handle("/mode", "3");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("defaultMode", "operate", "global");
    });

    it("treats yolo as the Act + Full Access compatibility alias", async () => {
      const currentThread = {
        id: "thread-1",
        mode: "plan",
        model: "deepseek-v4-pro",
        trust_mode: false,
        auto_approve: false,
      } as any;
      const updateThread = vi.fn(async () => ({
        ...currentThread,
        mode: "agent",
        permission_posture: "full_access",
      }));
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mode", "yolo");

      // Thread-scoped, legacy alias included: both halves of "Act + Full Access"
      // land on the thread, and neither touches the startup defaults.
      expect(vscodeState.updateMock).not.toHaveBeenCalled();
      expect(updateThread).toHaveBeenCalledWith("thread-1", {
        mode: "agent",
        permission_posture: "full_access",
      });
      expect(currentThread.permission_posture).toBe("full_access");
      // Nothing in the startup-default scope moved, so nothing re-marks it.
      expect(ctx.postScopedDefaults).not.toHaveBeenCalled();
    });

    it("shows current mode when no valid arg given", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mode", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info" })
      );
      const infoMsg = postMessage.mock.calls.find(
        (c: any) => c[0].type === "info" && c[0].message.includes("Current mode")
      );
      expect(infoMsg).toBeDefined();
    });
  });

  // ── /auto ──

  describe("/auto", () => {
    it("switches the permission posture to Auto-Review without touching the mode", async () => {
      const currentThread = {
        id: "thread-1",
        mode: "plan",
        model: "deepseek-v4-pro",
        auto_approve: false,
      } as any;
      const updateThread = vi.fn(async () => ({
        ...currentThread,
        permission_posture: "auto_review",
      }));
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/auto", "");

      // Thread-scoped: the startup posture for new threads is set from the
      // dropdown's second group, never as a side effect of a thread's posture.
      expect(vscodeState.updateMock).not.toHaveBeenCalled();
      // Posture-only patch: the mode (and therefore the thread's mode) is untouched.
      expect(updateThread).toHaveBeenCalledWith("thread-1", {
        permission_posture: "auto_review",
      });
      expect(vscodeState.updateMock).not.toHaveBeenCalledWith(
        "defaultMode",
        expect.anything(),
        expect.anything()
      );
      expect(currentThread.mode).toBe("plan");
      expect(postMessage).toHaveBeenCalledWith({
        type: "settingsUpdated",
        mode: "plan",
        posture: "auto_review",
        model: "deepseek-v4-pro",
        reasoningEffort: "auto",
      });
      expect(ctx.postScopedDefaults).not.toHaveBeenCalled();
    });

    it("moves the startup posture when there is no thread, and re-marks the group that shows it", async () => {
      const postMessage = vi.fn();
      const postScopedDefaults = vi.fn();
      const ctx = createContext({ postMessage, postScopedDefaults });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/auto", "");

      // No thread to scope it to, so the written default is the whole effect —
      // and the "New threads" group has to hear about it.
      expect(vscodeState.updateMock).toHaveBeenCalledWith(
        "defaultPermissionPosture",
        "auto_review",
        "global"
      );
      expect(postScopedDefaults).toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "settingsUpdated", posture: "auto_review" })
      );
    });

    it("rejects arguments with a usage hint", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/auto", "on");

      expect(vscodeState.updateMock).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ type: "info", message: "Usage: /auto" });
    });
  });

  // ── /model ──

  describe("/model", () => {
    it("switches model, updates the active thread, and posts settings update", async () => {
      const currentThread = {
        id: "thread-1",
        mode: "agent",
        model: "deepseek-v4-pro",
      } as any;
      const updateThread = vi.fn(async () => ({
        ...currentThread,
        model: "deepseek-v4-flash",
      }));
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/model", "deepseek-v4-flash");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("defaultModel", "deepseek-v4-flash", "global");
      expect(updateThread).toHaveBeenCalledWith("thread-1", { model: "deepseek-v4-flash" });
      expect(postMessage).toHaveBeenCalledWith({
        type: "settingsUpdated",
        mode: "agent",
        posture: "ask",
        model: "deepseek-v4-flash",
        reasoningEffort: "auto",
      });
      expect(currentThread.model).toBe("deepseek-v4-flash");
    });

    it("shows current model when no arg given", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/model", "");

      const infoMsg = postMessage.mock.calls.find(
        (c: any) => c[0].type === "info" && c[0].message.includes("Current model")
      );
      expect(infoMsg).toBeDefined();
    });
  });

  // ── /models ──

  describe("/models", () => {
    it("lists available models", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/models", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info" })
      );
      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("deepseek-v4-pro");
      expect(msg).toContain("deepseek-v4-flash");
    });
  });

  // ── /reasoning ──

  describe("/reasoning", () => {
    it("sets reasoning effort", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/reasoning", "high");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("reasoningEffort", "high", "global");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "settingsUpdated", reasoningEffort: "high" })
      );
    });

    it("shows current effort when invalid arg given", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/reasoning", "");

      const infoMsg = postMessage.mock.calls.find(
        (c: any) => c[0].type === "info" && c[0].message.includes("Current reasoning")
      );
      expect(infoMsg).toBeDefined();
    });
  });

  // ── /config ──

  describe("/config", () => {
    it("opens config panel", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/config", "");

      expect(postMessage).toHaveBeenCalledWith({ type: "openConfigPanel" });
    });
  });

  // ── /settings ──

  describe("/settings", () => {
    it("shows current settings", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/settings", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Mode:");
      expect(msg).toContain("Model:");
    });
  });

  // ── /clear ──

  describe("/clear", () => {
    it("posts clearChat message", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/clear", "");

      expect(postMessage).toHaveBeenCalledWith({ type: "clearChat" });
    });
  });

  // ── /compact ──

  describe("/compact", () => {
    it("delegates to handleCompact", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/compact", "");

      expect(ctx.handleCompact).toHaveBeenCalledOnce();
    });
  });

  // ── /interrupt ──

  describe("/interrupt", () => {
    it("delegates to handleInterrupt", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/interrupt", "");

      expect(ctx.handleInterrupt).toHaveBeenCalledOnce();
    });
  });

  // ── /exit ──

  describe("/exit", () => {
    it("closes sidebar", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/exit", "");

      expect(vscodeState.executeCommandMock).toHaveBeenCalledWith(
        "workbench.action.closeSidebar"
      );
    });
  });

  // ── /undo ──

  describe("/undo", () => {
    it("delegates to handleUndoLastTurn", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/undo", "");

      expect(ctx.handleUndoLastTurn).toHaveBeenCalledOnce();
    });
  });

  // ── /retry ──

  describe("/retry", () => {
    it("delegates to handleRetryLastTurn", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/retry", "");

      expect(ctx.handleRetryLastTurn).toHaveBeenCalledOnce();
    });
  });

  // ── /attach ──

  describe("/attach", () => {
    it("delegates to handleAttachFile", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/attach", "");

      expect(ctx.handleAttachFile).toHaveBeenCalledOnce();
    });
  });

  // ── /rename ──

  describe("/rename", () => {
    it("renames thread with title", async () => {
      const updateThread = vi.fn(async () => undefined);
      const postMessage = vi.fn();
      const ctx = createContext({
        api: { ...createContext().api, updateThread } as any,
        currentThread: { id: "thread-1" } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/rename", "New Title");

      expect(updateThread).toHaveBeenCalledWith("thread-1", { title: "New Title" });
      expect(ctx.refreshSessionList).toHaveBeenCalled();
    });

    it("errors when no active thread", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/rename", "Title");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("No active thread") })
      );
    });

    it("errors when no title provided", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        currentThread: { id: "thread-1" } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/rename", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Usage") })
      );
    });
  });

  // ── /save ──

  describe("/save", () => {
    it("errors when no active thread", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/save", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("No active thread") })
      );
    });

    it("saves session and refreshes list", async () => {
      const postMessage = vi.fn();
      const saveCurrentSession = vi.fn(async () => ({ session_id: "sess-abc123" }));
      const setCurrentSessionId = vi.fn();
      const getCurrentSessionId = vi.fn(() => "session-prev");
      const refreshSessionList = vi.fn();
      const ctx = createContext({
        currentThread: { id: "thread-1" } as any,
        postMessage,
        saveCurrentSession,
        setCurrentSessionId,
        getCurrentSessionId,
        refreshSessionList,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/save", "");

      expect(saveCurrentSession).toHaveBeenCalledWith("thread-1", "session-prev");
      expect(setCurrentSessionId).toHaveBeenCalledWith("sess-abc123");
      expect(refreshSessionList).toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({
         type: "info",
         message: "Session saved (sess-abc)",
       });
    });
  });

  // ── /export ──

  describe("/export", () => {
    it("errors when no active thread", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/export", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("No active thread") })
      );
    });
  });

  // ── /context ──

  describe("/context", () => {
    it("shows thread context when active", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        currentThread: { id: "thread-1234567890ab" } as any,
        messages: [{ role: "user" }, { role: "assistant" }],
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/context", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("thread-12345");
      expect(msg).toContain("Messages: 2");
    });

    it("shows no active thread when null", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/context", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("No active thread") })
      );
    });
  });

  // ── /tokens ──

  describe("/tokens", () => {
    it("shows session token usage by default", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/tokens", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("12,000");  // totalInputTokens
      expect(msg).toContain("4,000");   // totalOutputTokens
    });

    it("fetches usage history for 'history' arg", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/tokens", "history");

      expect(ctx.api.getUsage).toHaveBeenCalled();
      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Token Usage");
    });

    it("fetches usage for 'today' arg", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/tokens", "today");

      expect(ctx.api.getUsage).toHaveBeenCalledWith(
        expect.objectContaining({ group_by: "day" })
      );
    });

    it("handles API error for history", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        api: {
          ...createContext().api,
          ensureReady: vi.fn(async () => { throw new Error("Engine not running"); }),
        } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/tokens", "history");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Engine not running") })
      );
    });
  });

  // ── /cost ──

  describe("/cost", () => {
    it("shows session cost by default", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cost", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Session Cost");
    });

    it("fetches cost history for 'history' arg", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cost", "history");

      expect(ctx.api.getUsage).toHaveBeenCalled();
    });

    it("history cost shows the native CNY subtotal when currency is cny", async () => {
      vscodeState.configValues.set("costCurrency", "cny");
      const base = createContext();
      const postMessage = vi.fn();
      const ctx = createContext({
        api: {
          ...base.api,
          getUsage: vi.fn(async () => ({
            since: "2025-01-01",
            until: "2025-12-31",
            group_by: "day",
            totals: {
              input_tokens: 10000,
              output_tokens: 5000,
              cached_tokens: 8000,
              reasoning_tokens: 1000,
              cost_usd: 1.5,
              // Provider-published CNY (DeepSeek native rows), never an FX
              // projection of cost_usd.
              cost_cny: 10.8,
              turns: 20,
            },
            buckets: [],
          })),
        } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cost", "history");

      const msg = postMessage.mock.calls[0][0].message;
      // ¥10.80 comes from the runtime's own CNY aggregate — a different
      // ratio than any FX conversion of $1.50 would produce.
      expect(msg).toContain("¥10.80");
    });

    it("history cost falls back to USD when no native CNY subtotal exists", async () => {
      vscodeState.configValues.set("costCurrency", "cny");
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cost", "history");

      const msg = postMessage.mock.calls[0][0].message;
      // Default mock returns no cost_cny: a CNY preference without native
      // CNY coverage displays USD (mirrors TUI cost_display_currency)
      // instead of a fabricated ¥.
      expect(msg).toContain("$1.50");
    });
  });

  // ── /status ──

  describe("/status", () => {
    it("shows runtime status when engine available", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/status", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Runtime Status");
      expect(msg).toContain("Running");
    });

    it("shows fallback status when runtime info fails", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        api: {
          ...createContext().api,
          getRuntimeInfo: vi.fn(async () => { throw new Error("timeout"); }),
        } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/status", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Engine:");
      expect(msg).toContain("timeout");
    });
  });

  // ── /home ──

  describe("/home", () => {
    it("shows dashboard info", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/home", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Dashboard");
      expect(msg).toContain("Mode:");
    });
  });

  // ── /workspace ──

  describe("/workspace", () => {
    it("shows workspace status", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/workspace", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("/workspace");
      expect(msg).toContain("Git repo: ✓");
    });
  });

  // ── /task ──

  describe("/task", () => {
    it("lists tasks when no subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/task", "");

      expect(ctx.api.listTasks).toHaveBeenCalledWith({ limit: 20 });
    });

    it("creates task with 'add' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/task", "add Fix the bug");

      expect(ctx.api.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Fix the bug" })
      );
      expect(ctx.refreshTaskList).toHaveBeenCalled();
    });

    it("shows task with 'show' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/task", "show task-1");

      expect(ctx.api.getTask).toHaveBeenCalledWith("task-1");
    });

    it("cancels task with 'cancel' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/task", "cancel task-1");

      expect(ctx.api.cancelTask).toHaveBeenCalledWith("task-1");
      expect(ctx.refreshTaskList).toHaveBeenCalled();
    });

    it("handles API error", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        api: {
          ...createContext().api,
          ensureReady: vi.fn(async () => { throw new Error("Engine down"); }),
        } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/task", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("Engine down") })
      );
    });
  });

  // ── /note ──

  describe("/note", () => {
    it("shows a specific note with 'show' subcommand", async () => {
      vi.mocked(fs.existsSync).mockImplementation((target: any) =>
        String(target).endsWith("/.deepseek") || String(target).endsWith("/notes.md")
      );
      vi.mocked(fs.readFileSync).mockReturnValue("- first note\n- second note\n");

      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/note", "show 2");

      expect(postMessage).toHaveBeenCalledWith({
        type: "info",
        message: "Note 2:\nsecond note",
      });
    });

    it("errors when requested note index is missing", async () => {
      vi.mocked(fs.existsSync).mockImplementation((target: any) =>
        String(target).endsWith("/.deepseek") || String(target).endsWith("/notes.md")
      );
      vi.mocked(fs.readFileSync).mockReturnValue("- only note\n");

      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/note", "show 3");

      expect(postMessage).toHaveBeenCalledWith({
        type: "error",
        message: "Note 3 not found. Only 1 notes.",
      });
    });
  });

  // ── /trust ──

  describe("/trust", () => {
    it("enables trust mode with 'on'", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/trust", "on");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("autoApprove", true, "global");
      // `/trust` writes the posture later sessions start on, so the group that
      // shows it is re-marked whether or not there is a thread.
      expect(ctx.postScopedDefaults).toHaveBeenCalled();
    });

    it("disables trust mode with 'off'", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/trust", "off");

      expect(vscodeState.updateMock).toHaveBeenCalledWith("autoApprove", false, "global");
      expect(ctx.postScopedDefaults).toHaveBeenCalled();
    });

    it("shows usage when no arg", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/trust", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Usage:");
    });
  });

  // ── /goal ──

  describe("/goal", () => {
    it("sets the thread goal with objective and budget", async () => {
      const postMessage = vi.fn();
      const refreshGoal = vi.fn(async () => undefined);
      const ctx = createContext({
        postMessage,
        refreshGoal,
        currentThread: { id: "thread-1" } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "Ship refactor | budget: 1234");

      expect(ctx.api.upsertThreadGoal).toHaveBeenCalledWith("thread-1", "Ship refactor", 1234);
      expect(refreshGoal).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({
        type: "info",
        message: expect.stringContaining('Goal set: "Ship refactor"'),
      });
    });

    it("sets the goal without a budget", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: { id: "thread-1" } as any });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "Just do it");

      expect(ctx.api.upsertThreadGoal).toHaveBeenCalledWith("thread-1", "Just do it", undefined);
    });

    it("clears the goal via the API", async () => {
      const postMessage = vi.fn();
      const refreshGoal = vi.fn(async () => undefined);
      const ctx = createContext({
        postMessage,
        refreshGoal,
        currentThread: { id: "thread-1" } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "clear");

      expect(ctx.api.deleteThreadGoal).toHaveBeenCalledWith("thread-1");
      expect(refreshGoal).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({ type: "info", message: "Goal cleared." });
    });

    it("completes the goal with 'done'", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: { id: "thread-1" } as any });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "done");

      expect(ctx.api.completeThreadGoal).toHaveBeenCalledWith("thread-1");
      expect(ctx.api.upsertThreadGoal).not.toHaveBeenCalled();
    });

    it("blocks the goal with 'blocked'", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: { id: "thread-1" } as any });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "blocked");

      expect(ctx.api.blockThreadGoal).toHaveBeenCalledWith("thread-1");
    });

    it("reports the current goal for 'status'", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: { id: "thread-1" } as any });
      (ctx.api.getThreadGoal as any).mockResolvedValue(
        goalRecord({ objective: "Ship refactor", token_budget: 2000, tokens_used: 500 })
      );
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "status");

      const message = postMessage.mock.calls[0][0].message;
      expect(message).toContain("Ship refactor");
      expect(message).toContain("active");
    });

    it("reports when the thread has no goal", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: { id: "thread-1" } as any });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "");

      expect(ctx.api.getThreadGoal).toHaveBeenCalledWith("thread-1");
      expect(postMessage.mock.calls[0][0].message).toContain("No goal set for this thread");
    });

    it("explains that goals are thread-scoped when no thread is open", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage, currentThread: null });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/goal", "Ship refactor");

      expect(ctx.api.upsertThreadGoal).not.toHaveBeenCalled();
      expect(postMessage.mock.calls[0][0].message).toContain("Goals belong to a thread");
    });
  });

  // ── Commands the GUI does not implement ──

  describe("commands without a GUI implementation", () => {
    // These used to write config keys that package.json never declared, so every
    // use raised "no registered configuration" from VSCode — and the values they
    // wrote were never read by anything. They are now registry-only: no handler,
    // unavailable, and the dispatcher surfaces the explanation.
    it.each(["/verbose", "/profile", "/translate"])(
      "%s explains itself instead of writing an undeclared setting",
      async (cmd) => {
        const postMessage = vi.fn();
        const ctx = createContext({ postMessage });
        const handler = new SlashCommandHandler(ctx);

        await handler.handle(cmd, "on");

        expect(vscodeState.updateMock).not.toHaveBeenCalled();
        expect(postMessage.mock.calls[0][0].message).toContain("Not available");
      }
    );
  });

  // ── /edit ──

  describe("/edit", () => {
    it("posts loadLastUserMessage", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/edit", "");

      expect(postMessage).toHaveBeenCalledWith({ type: "loadLastUserMessage" });
    });
  });

  // ── /logout ──

  describe("/logout", () => {
    it("shows API key change instructions", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/logout", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("DEEPSEEK_API_KEY") })
      );
    });
  });

  // ── /change ──

  describe("/change", () => {
    it("shows changelog info", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/change", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("CHANGELOG") })
      );
    });
  });

  // ── /sessions ──

  describe("/sessions", () => {
    it("lists saved sessions", async () => {
      const postMessage = vi.fn();
      const listSessions = vi.fn(async () => ({
        sessions: [
          {
            id: "sess-1234567890abcdef",
            title: "Test Session",
            updated_at: new Date().toISOString(),
            total_tokens: 1000,
            mode: "agent",
            cost: { session_cost_usd: 0.05 },
          },
        ],
      }));
      const ctx = createContext({
        api: { ...createContext().api, listSessions } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/sessions", "");

      expect(listSessions).toHaveBeenCalled();
      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("Test Session");
    });

    it("handles empty sessions list", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/sessions", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("No saved sessions");
    });
  });

  // ── /load ──

  describe("/load", () => {
    it("errors when no session ID provided", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/load", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Usage") })
      );
    });

    it("loads session by ID", async () => {
      const postMessage = vi.fn();
      const loadSessionMessages = vi.fn(async () => undefined);
      const listSessions = vi.fn(async () => ({
        sessions: [{ id: "sess-12345678-1234-1234-1234-1234567890ab", title: "Test" }],
      }));
      const ctx = createContext({
        api: { ...createContext().api, listSessions } as any,
        postMessage,
        loadSessionMessages,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/load", "sess-12345678-1234-1234-1234-1234567890ab");

      expect(loadSessionMessages).toHaveBeenCalledWith("sess-12345678-1234-1234-1234-1234567890ab");
    });
  });

  // ── /jobs ──

  describe("/jobs", () => {
    it("lists automations with 'list' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "list");

      expect(ctx.api.listAutomations).toHaveBeenCalled();
    });

    it("shows automation with 'show' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "show auto-1");

      expect(ctx.api.getAutomation).toHaveBeenCalledWith("auto-1");
    });

    it("runs automation with 'run' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "run auto-1");

      expect(ctx.api.runAutomation).toHaveBeenCalledWith("auto-1");
    });

    it("pauses automation with 'pause' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "pause auto-1");

      expect(ctx.api.pauseAutomation).toHaveBeenCalledWith("auto-1");
    });

    it("resumes automation with 'resume' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "resume auto-1");

      expect(ctx.api.resumeAutomation).toHaveBeenCalledWith("auto-1");
    });

    it("shows history with 'history' subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "history auto-1");

      expect(ctx.api.listAutomationRuns).toHaveBeenCalledWith("auto-1", { limit: 10 });
    });

    it("shows usage error for invalid subcommand", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/jobs", "invalid");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Usage") })
      );
    });
  });

  // ── /system ──

  describe("/system", () => {
    it("shows system prompt when thread is active", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        currentThread: { id: "thread-1" } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/system", "");

      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("System Prompt");
    });

    it("shows no system prompt when no thread", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/system", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("no system prompt") })
      );
    });
  });

  // ── /cache ──

  describe("/cache", () => {
    it("shows cache telemetry when thread is active", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        currentThread: { id: "thread-1" } as any,
        postMessage,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cache", "");

      expect(ctx.api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    });

    it("shows no thread message when no thread", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ currentThread: null, postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/cache", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("No active thread") })
      );
    });
  });

  // ── /provider ──

  describe("/provider", () => {
    it("shows provider info", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/provider", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info" })
      );
    });
  });

  // ── /mcp ──

  describe("/mcp", () => {
    it("opens MCP settings", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/mcp", "");

      expect(vscodeState.executeCommandMock).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "brotherwhale"
      );
    });
  });

  // ── /links ──

  describe("/links", () => {
    it("shows CodeWhale links", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/links", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info" })
      );
    });
  });

  // ── /feedback ──

  describe("/feedback", () => {
    it("opens feedback URL", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/feedback", "");

      expect(vscodeState.executeCommandMock).toHaveBeenCalledWith(
        "workbench.action.openIssueReporter"
      );
    });
  });

  // ── /init ──

  describe("/init", () => {
    it("opens settings for initialization", async () => {
      const ctx = createContext();
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/init", "");

      expect(vscodeState.executeCommandMock).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "brotherwhale"
      );
    });
  });

  // ── /memory (native store via runtime API — never touches local files) ──

  describe("/memory", () => {
    it("lists native memory entries via the API on show", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        api: {
          ...createContext().api,
          listMemory: vi.fn(async () => ({
            entries: [
              { id: 1, scope: "global", workspace_id: null, summary: "alpha note", stale: false, line_start: 1, line_end: 1, status: "active" },
            ],
            total: 1,
          })),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "");

      expect(ctx.api.listMemory).toHaveBeenCalledWith({ limit: 20 });
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("#1 [global] alpha note") })
      );
    });

    it("reports empty memory without touching the filesystem", async () => {
      const postMessage = vi.fn();
      vi.mocked(fs.readFileSync).mockClear();
      vi.mocked(fs.writeFileSync).mockClear();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "show");

      expect(ctx.api.listMemory).toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("Memory is empty") })
      );
    });

    it("search passes the query to the API", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "search alpha");

      expect(ctx.api.listMemory).toHaveBeenCalledWith({ q: "alpha", limit: 20 });
    });

    it("remember posts a new entry through the API", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "remember workspace likes tea");

      expect(ctx.api.createMemoryEntry).toHaveBeenCalledWith("likes tea", "workspace");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("#3") })
      );
    });

    it("clear defaults to the all scope", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "clear");

      expect(ctx.api.clearMemory).toHaveBeenCalledWith("all");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("Memory cleared (all)") })
      );
    });

    it("rejects an unknown subcommand with usage", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/memory", "bogus");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Unknown subcommand 'bogus'") })
      );
    });
  });

  // ── /restore (snapshot list + trust-gated revert, mirrors TUI) ──

  describe("/restore", () => {
    const SNAPSHOTS = [
      { id: "aaaaaaaa11111111", label: "pre-turn:2", timestamp: 1_700_000_000 },
      { id: "bbbbbbbb22222222", label: "pre-turn:1", timestamp: 1_699_000_000 },
    ];

    it("lists snapshots when no arg given", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        api: {
          ...createContext().api,
          listSnapshots: vi.fn(async () => SNAPSHOTS),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "");

      expect(ctx.api.listSnapshots).toHaveBeenCalledWith({ limit: 20 });
      const msg = postMessage.mock.calls[0][0].message;
      expect(msg).toContain("#1");
      expect(msg).toContain("pre-turn:2");
      expect(msg).toContain("aaaaaaaa");
    });

    it("shows the empty message when there are no snapshots", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({ postMessage });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "");

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("No snapshots yet") })
      );
    });

    it("refuses to restore outside trusted mode (mirrors TUI trust gate)", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        currentThread: { id: "thread-1", trust_mode: false, auto_approve: false } as any,
        api: {
          ...createContext().api,
          listSnapshots: vi.fn(async () => SNAPSHOTS),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "2");

      expect(ctx.api.restoreSnapshot).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("Refusing to restore snapshot #2") })
      );
    });

    it("restores the Nth snapshot when the thread is trusted", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        currentThread: { id: "thread-1", trust_mode: true, auto_approve: false } as any,
        api: {
          ...createContext().api,
          listSnapshots: vi.fn(async () => SNAPSHOTS),
          restoreSnapshot: vi.fn(async () => ({ restored: "ok" })),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "2");

      expect(ctx.api.restoreSnapshot).toHaveBeenCalledWith("bbbbbbbb22222222");
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", message: expect.stringContaining("Restored snapshot #2 ('pre-turn:1', bbbbbbbb)") })
      );
    });

    it("errors when the requested index exceeds the available snapshots", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        currentThread: { id: "thread-1", trust_mode: true, auto_approve: true } as any,
        api: {
          ...createContext().api,
          listSnapshots: vi.fn(async () => SNAPSHOTS),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "9");

      expect(ctx.api.restoreSnapshot).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: expect.stringContaining("Only 2 snapshot(s) available") })
      );
    });

    it("list [N] passes the explicit limit", async () => {
      const postMessage = vi.fn();
      const ctx = createContext({
        postMessage,
        api: {
          ...createContext().api,
          listSnapshots: vi.fn(async () => SNAPSHOTS),
        } as any,
      });
      const handler = new SlashCommandHandler(ctx);

      await handler.handle("/restore", "list 50");

      expect(ctx.api.listSnapshots).toHaveBeenCalledWith({ limit: 50 });
    });
  });
});
