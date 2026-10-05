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
  window: {},
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

const SKILL_BODY = "Reproduce the bug before changing anything.";

function createProvider(overrides: Record<string, unknown> = {}) {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async () => ({ id: "thread-1" })),
    getThreadDetail: vi.fn(async () => ({
      thread: { id: "thread-1" },
      turns: [],
      items: [],
      latest_seq: 1,
    })),
    startTurn: vi.fn(async () => ({
      thread: { id: "thread-1" },
      turn: { id: "turn-1", thread_id: "thread-1", status: "in_progress" },
    })),
    interruptTurn: vi.fn(async () => undefined),
    streamEvents: vi.fn(() => new AbortController()),
    getSkillDetail: vi.fn(async (name: string) => ({
      name,
      description: "Debug workflow",
      path: `/home/u/.codewhale/skills/${name}/SKILL.md`,
      enabled: true,
      is_bundled: false,
      source: "native",
      invocation: "model+user",
      aliases: [],
      body: SKILL_BODY,
    })),
    setSkillEnabled: vi.fn(async (name: string, enabled: boolean) => ({ name, enabled })),
    listSkills: vi.fn(async () => ({
      directory: "/home/u/.codewhale/skills",
      directories: ["/home/u/.codewhale/skills"],
      warnings: [],
      skills: [],
    })),
    installSkill: vi.fn(async () => ({
      name: "x",
      outcome: "installed",
      scope: "global",
      safe_target_path: "/home/u/.codewhale/skills/x",
    })),
    updateSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    trustSkill: vi.fn(),
    auditSkill: vi.fn(async (name: string) => ({
      ambiguous: false,
      skills: [
        {
          name,
          safe_display_path: "/home/u/.codewhale/skills/x",
          source_kind: "codewhale_managed",
          scope: "global",
          digest: { state: "known", value: "sha256:abc" },
          trust: "untrusted",
          integrity: "ok",
          available_actions: ["trust"],
          warnings: [],
        },
      ],
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
  (provider as any).apiCapabilities.skillDetail = true;
  (provider as any).apiCapabilities.skillLifecycle = true;
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

describe("ChatProvider skill activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("arms a skill and injects its body into the next turn only", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.activateSkill("debug");
    // Arming alone sends nothing.
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "skillArmed")).toEqual([
      { type: "skillArmed", name: "debug", description: "Debug workflow" },
    ]);

    await provider.sendMessage("the tests are flaky");

    const prompt = (api.startTurn as any).mock.calls[0][1] as string;
    expect(prompt).toContain("# Skill: debug");
    expect(prompt).toContain(SKILL_BODY);
    expect(prompt.endsWith("User request: the tests are flaky")).toBe(true);

    // The bubble shows what the user typed — the instruction rides the wire,
    // not the transcript, exactly as TUI's `/skill` does.
    const userBubble = provider.messages.find((m: any) => m.role === "user");
    expect(userBubble!.content).toBe("the tests are flaky");

    // One-shot: the arming is consumed by the send, and the chip clears.
    expect(messagesOfType(postMessage, "skillArmed")).toEqual([
      { type: "skillArmed", name: "debug", description: "Debug workflow" },
      { type: "skillArmed", name: null },
    ]);
    expect((provider as any).armedSkill).toBeNull();

    // A second message carries no skill.
    (api.startTurn as any).mockClear();
    await provider.sendMessage("carry on");
    expect((api.startTurn as any).mock.calls[0][1]).toBe("carry on");
  });

  it("sends the task immediately when activation carries one", async () => {
    const { provider, api } = createProvider();

    await provider.activateSkill("debug", "why is this failing");

    expect(api.startTurn).toHaveBeenCalledTimes(1);
    const prompt = (api.startTurn as any).mock.calls[0][1] as string;
    expect(prompt).toContain("# Skill: debug");
    expect(prompt.endsWith("User request: why is this failing")).toBe(true);
  });

  it("refuses activation when the engine cannot return a skill body", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).apiCapabilities.skillDetail = false;

    await provider.activateSkill("debug");

    expect(api.getSkillDetail).not.toHaveBeenCalled();
    const errors = messagesOfType(postMessage, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("cannot activate");
    expect((provider as any).armedSkill).toBeNull();
  });

  it("refuses a skill whose invocation policy withholds user invocation", async () => {
    const { provider, postMessage } = createProvider({
      getSkillDetail: vi.fn(async (name: string) => ({
        name,
        description: "Model-only",
        path: null,
        enabled: true,
        is_bundled: false,
        source: "native",
        invocation: "model-only",
        aliases: [],
        body: SKILL_BODY,
      })),
    });

    await provider.activateSkill("debug");

    expect((provider as any).armedSkill).toBeNull();
    expect(messagesOfType(postMessage, "error")[0].message).toContain("does not allow user invocation");
  });

  it("reports a missing skill with the listing hint", async () => {
    const { provider, postMessage } = createProvider({
      getSkillDetail: vi.fn(async () => {
        throw new Error("API error 404: skill 'nope' not found in searched directories");
      }),
    });

    await provider.activateSkill("nope");

    expect(messagesOfType(postMessage, "error")[0].message).toContain("Run /skills to list available skills");
  });

  it("re-announces the armed skill so a reload keeps the chip", async () => {
    const { provider, postMessage } = createProvider();
    await provider.activateSkill("debug");

    (postMessage as any).mockClear();
    provider.postArmedSkill();
    expect(messagesOfType(postMessage, "skillArmed")).toEqual([
      { type: "skillArmed", name: "debug" },
    ]);
  });

  it("refuses an unknown install scope instead of guessing a root", async () => {
    const { provider, api, postMessage } = createProvider();

    await provider.installSkill("github:owner/repo", "workspace");

    expect(api.installSkill).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "error")[0].message).toContain("Invalid scope");
  });
});
