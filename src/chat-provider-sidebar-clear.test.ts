import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    // undefined so loadThread skips the workspace-update branch
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
import type { ThreadRecord } from "./types";

function makeThread(id: string): ThreadRecord {
  return {
    schema_version: 1,
    id,
    created_at: "2026-06-29T00:00:00Z",
    updated_at: "2026-06-29T00:00:00Z",
    model: "deepseek-v4-pro",
    workspace: "/tmp/repo",
    mode: "agent",
    allow_shell: false,
    trust_mode: false,
    auto_approve: false,
    latest_turn_id: null,
    archived: false,
  };
}

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => makeThread(id)),
    getThreadDetail: vi.fn(async () => ({ latest_seq: 0, turns: [], items: [] })),
    listTasks: vi.fn(async () => ({ tasks: [], counts: { active: 0, completed: 0, failed: 0 } })),
    listAgentRuns: vi.fn(async () => ({ runs: [] })),
    streamEvents: vi.fn(() => ({ abort: () => {} })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  // Stub private collaborators so the test focuses on sidebar-clear behavior
  (provider as any).loadHistory = vi.fn(async () => 0);
  (provider as any).subscribeToEvents = vi.fn();

  return { provider, api, postMessage: provider.postMessage as any };
}

/** Collect all postMessage calls by type for easier assertions. */
function callsByType(postMessage: ReturnType<typeof vi.fn>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const call of postMessage.mock.calls) {
    const msg = call[0] as { type: string };
    if (!out[msg.type]) out[msg.type] = [];
    out[msg.type].push(msg);
  }
  return out;
}

describe("Sidebar clearing on thread switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleNewThread()", () => {
    it("posts clearChat followed by empty taskList and agentRunList", async () => {
      const { provider, postMessage } = createProvider();
      await (provider as any).handleNewThread();

      const byType = callsByType(postMessage);
      // Clear chat (which clears work/changes/diff store on the front end)
      expect(byType.clearChat).toBeDefined();
      // Empty sidebar task list
      expect(byType.taskList).toBeDefined();
      expect(byType.taskList).toHaveLength(1);
      expect(byType.taskList[0]).toEqual({ type: "taskList", tasks: [] });
      // Empty sidebar agent runs
      expect(byType.agentRunList).toBeDefined();
      expect(byType.agentRunList).toHaveLength(1);
      expect(byType.agentRunList[0]).toEqual({ type: "agentRunList", runs: [] });
    });

    it("does not carry over tasks or agents from a previous thread", async () => {
      const { provider, postMessage } = createProvider();
      // Simulate the webview already having task/agent data — handleNewThread
      // must still emit empty lists to overwrite it.
      await (provider as any).handleNewThread();

      const taskCall = postMessage.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === "taskList",
      );
      const agentCall = postMessage.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === "agentRunList",
      );
      expect((taskCall![0] as { tasks: unknown[] }).tasks).toEqual([]);
      expect((agentCall![0] as { runs: unknown[] }).runs).toEqual([]);
    });
  });

  describe("loadThread()", () => {
    it("emits threadLoaded then refreshes task and agent lists for the workspace", async () => {
      const { provider, api, postMessage } = createProvider();
      api.listTasks.mockResolvedValue({
        tasks: [
          { id: "t1", status: "running", model: "m", thread_id: "thread-2" },
          { id: "t2", status: "completed", model: "m", thread_id: "thread-9" },
        ],
        counts: { active: 1, completed: 0, failed: 0 },
      } as any);
      api.listAgentRuns.mockResolvedValue({
        runs: [{ run_id: "r1", status: "running", spec: { objective: "do x" } }],
      } as any);

      await (provider as any).loadThread("thread-2");

      // Core thread-load messages
      const byType = callsByType(postMessage);
      expect(byType.threadLoaded).toBeDefined();
      expect((byType.threadLoaded[0] as { thread: { id: string } }).thread.id).toBe("thread-2");
      expect(byType.status).toBeDefined();

      // Sidebar refresh was triggered by loadThread
      expect(api.listTasks).toHaveBeenCalledWith({ limit: 50 });
      expect(api.listAgentRuns).toHaveBeenCalled();

      // All workspace tasks are pushed to the webview (no thread filter)
      expect(byType.taskList).toBeDefined();
      expect((byType.taskList[0] as { tasks: unknown[] }).tasks).toHaveLength(2);
      expect(byType.agentRunList).toBeDefined();
      expect((byType.agentRunList[0] as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it("shows tasks from all threads in the workspace", async () => {
      const { provider, api, postMessage } = createProvider();
      api.listTasks.mockResolvedValue({
        tasks: [
          { id: "t-other", status: "completed", model: "m", thread_id: "thread-old" },
          { id: "t-mine", status: "running", model: "m", thread_id: "thread-new" },
        ],
        counts: { active: 1, completed: 1, failed: 0 },
      } as any);

      await (provider as any).loadThread("thread-new");

      const byType = callsByType(postMessage);
      expect(byType.taskList).toBeDefined();
      const sent = (byType.taskList[0] as { tasks: { id: string; thread_id: string }[] }).tasks;
      expect(sent).toHaveLength(2);
      expect(sent.map(t => t.id).sort()).toEqual(["t-mine", "t-other"]);
    });

    it("refreshes work and changes panels for the new thread", async () => {
      const { provider, postMessage } = createProvider();
      await (provider as any).loadThread("thread-w");

      const byType = callsByType(postMessage);
      // workState must be pushed so the Work panel reflects the new thread
      expect(byType.workState).toBeDefined();
      const work = byType.workState[0] as { checklist: unknown[]; strategy: unknown[]; goal?: unknown };
      expect(work.checklist).toEqual([]);
      expect(work.strategy).toEqual([]);
      // The goal is owned by the goal control plane (goalState) and rendered in
      // the Work panel's dedicated slot — it must not be restated here.
      expect(work.goal).toBeUndefined();
      // changesState must be pushed so the Changes panel reflects the new thread
      expect(byType.changesState).toBeDefined();
      expect((byType.changesState[0] as { changes: unknown[] }).changes).toEqual([]);
    });

    it("posts threadLoaded before the refreshed task/agent lists", async () => {
      const { provider, postMessage } = createProvider();
      await (provider as any).loadThread("thread-3");

      const types = postMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
      const threadLoadedIdx = types.indexOf("threadLoaded");
      const taskListIdx = types.indexOf("taskList");
      const agentRunListIdx = types.indexOf("agentRunList");
      const workStateIdx = types.indexOf("workState");
      const changesStateIdx = types.indexOf("changesState");

      expect(threadLoadedIdx).toBeGreaterThanOrEqual(0);
      // If the refresh returned data, it must come after threadLoaded so the
      // webview has already cleared stale state via the threadLoaded handler.
      if (taskListIdx >= 0) expect(taskListIdx).toBeGreaterThan(threadLoadedIdx);
      if (agentRunListIdx >= 0) expect(agentRunListIdx).toBeGreaterThan(threadLoadedIdx);
      // Work/changes refresh also happens after threadLoaded
      expect(workStateIdx).toBeGreaterThan(threadLoadedIdx);
      expect(changesStateIdx).toBeGreaterThan(threadLoadedIdx);
    });

    it("still posts threadLoaded even when task/agent refresh fails", async () => {
      const { provider, api, postMessage } = createProvider();
      api.listTasks.mockRejectedValue(new Error("network down"));
      api.listAgentRuns.mockRejectedValue(new Error("network down"));

      await (provider as any).loadThread("thread-4");

      const byType = callsByType(postMessage);
      // threadLoaded must still be emitted so the webview updates.
      expect(byType.threadLoaded).toBeDefined();
      expect((byType.threadLoaded[0] as { thread: { id: string } }).thread.id).toBe("thread-4");
      // No taskList/agentRunList messages should have been posted since the
      // refresh calls swallowed the errors.
      expect(byType.taskList).toBeUndefined();
      expect(byType.agentRunList).toBeUndefined();
    });
  });
});
