import { describe, it, expect, vi } from "vitest";
import type {
  ThreadRecord,
  TurnRecord,
  TurnItemRecord,
  RuntimeEvent,
  PatchUndoResponse,
  SessionMetadata,
  RuntimeApiCapabilities,
  AutomationRecord,
  AutomationRunRecord,
  UsageAggregation,
  EngineRef,
} from "./types";

// Mock vscode since engine.ts imports it
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
    workspaceFolders: [],
  },
  commands: { executeCommand: vi.fn() },
  window: { showTextDocument: vi.fn() },
  ConfigurationTarget: { Global: "global" },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

// ── types.ts re-export backward compatibility ──
// After extracting types from api-client.ts to types.ts, all existing
// import paths (from "./types" and from "./api/api-client") must still work.

describe("types.ts - Re-export backward compatibility", () => {
  it("re-exports CodeWhaleApiClient from api-client", async () => {
    const { CodeWhaleApiClient } = await import("./types");
    expect(CodeWhaleApiClient).toBeDefined();
    expect(typeof CodeWhaleApiClient).toBe("function");
  });

  it("re-exports CodeWhaleEngine from engine", async () => {
    const { CodeWhaleEngine } = await import("./types");
    expect(CodeWhaleEngine).toBeDefined();
    expect(typeof CodeWhaleEngine).toBe("function");
  });

  it("types module loads cleanly", async () => {
    const typesModule = await import("./types");
    expect(typesModule).toBeDefined();
    expect(typesModule.CodeWhaleApiClient).toBeDefined();
    expect(typesModule.CodeWhaleEngine).toBeDefined();
  });

  it("api-client re-exports types for backward compatibility", async () => {
    const apiModule = await import("./api/api-client");
    expect(apiModule.CodeWhaleApiClient).toBeDefined();
  });
});

// ── Type structural conformance tests ──
// These verify that the interface shapes match what the Runtime API returns.
// We create sample objects that satisfy the interfaces to catch breaking changes.

describe("types.ts - Interface structural conformance", () => {
  it("ThreadRecord accepts full object with optional fields", () => {
    const thread: ThreadRecord = {
      schema_version: 1,
      id: "thread-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      model: "deepseek-v4-pro",
      workspace: "/tmp/test",
      mode: "agent",
      allow_shell: true,
      trust_mode: false,
      auto_approve: false,
      latest_turn_id: "turn-1",
      latest_response_bookmark: null,
      archived: false,
      system_prompt: "You are helpful",
      task_id: null,
      title: "Test Thread",
      coherence_state: "healthy",
    };
    expect(thread.id).toBe("thread-1");
    expect(thread.title).toBe("Test Thread");
    expect(thread.system_prompt).toBe("You are helpful");
  });

  it("ThreadRecord works with only required fields", () => {
    const thread: ThreadRecord = {
      schema_version: 1,
      id: "thread-2",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      model: "deepseek-v4-flash",
      workspace: "/tmp/test",
      mode: "plan",
      allow_shell: false,
      trust_mode: false,
      auto_approve: false,
      latest_turn_id: null,
      archived: false,
      coherence_state: "healthy",
    };
    expect(thread.latest_response_bookmark).toBeUndefined();
    expect(thread.title).toBeUndefined();
  });

  it("TurnRecord status union type covers all states", () => {
    const statuses: TurnRecord["status"][] = [
      "queued", "in_progress", "completed", "failed", "interrupted", "canceled",
    ];
    expect(statuses).toHaveLength(6);
  });

  it("TurnItemRecord kind union type covers all item kinds", () => {
    const kinds: TurnItemRecord["kind"][] = [
      "user_message", "agent_message", "agent_reasoning",
      "tool_call", "file_change", "command_execution",
      "context_compaction", "status", "error",
    ];
    expect(kinds).toHaveLength(9);
  });

  it("RuntimeEvent has required seq and event fields", () => {
    const event: RuntimeEvent = {
      seq: 1,
      timestamp: "2026-01-01T00:00:00Z",
      thread_id: "thread-1",
      turn_id: null,
      item_id: null,
      event: "turn.lifecycle",
      payload: {},
    };
    expect(event.seq).toBe(1);
    expect(event.payload).toEqual({});
  });

  it("PatchUndoResponse contains patch_result and thread", () => {
    const resp: PatchUndoResponse = {
      patch_result: {
        files_restored: true,
        summary: "3 files restored",
        snapshot_label: "pre-turn:5",
      },
      thread: {
        schema_version: 1,
        id: "thread-1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        model: "deepseek-v4-pro",
        workspace: "/tmp",
        mode: "agent",
        allow_shell: false,
        trust_mode: false,
        auto_approve: false,
        latest_turn_id: null,
        archived: false,
        coherence_state: "healthy",
      },
      original_user_text: "Fix the bug",
    };
    expect(resp.patch_result.files_restored).toBe(true);
    expect(resp.original_user_text).toBe("Fix the bug");
  });

  it("SessionMetadata includes cost sub-object", () => {
    const meta: SessionMetadata = {
      id: "sess-1",
      title: "Test Session",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      message_count: 10,
      total_tokens: 5000,
      model: "deepseek-v4-pro",
      workspace: "/tmp",
      cost: {
        session_cost_usd: 0.05,
        session_cost_cny: 0.35,
        subagent_cost_usd: 0.01,
        subagent_cost_cny: 0.07,
      },
    };
    expect(meta.cost?.session_cost_usd).toBe(0.05);
    expect(meta.cost?.subagent_cost_cny).toBe(0.07);
  });

  it("RuntimeApiCapabilities has all capability flags", () => {
    const caps: RuntimeApiCapabilities = {
      saveSession: true,
      threadUndo: true,
      threadPatchUndo: false,
      threadRetry: true,
      turnSteer: true,
      snapshotList: false,
      snapshotRestore: false,
      threadUsage: true,
    };
    expect(caps.saveSession).toBe(true);
    expect(caps.threadPatchUndo).toBe(false);
    expect(caps.turnSteer).toBe(true);
    expect(caps.threadUsage).toBe(true);
  });

  it("AutomationRecord and AutomationRunRecord have required fields", () => {
    const automation: AutomationRecord = {
      schema_version: 1,
      id: "auto-1",
      name: "Daily Cleanup",
      prompt: "Clean up temp files",
      rrule: "FREQ=DAILY",
      cwds: ["/tmp"],
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    expect(automation.status).toBe("active");

    const run: AutomationRunRecord = {
      schema_version: 1,
      id: "run-1",
      automation_id: "auto-1",
      scheduled_for: "2026-01-01T00:00:00Z",
      status: "completed",
      created_at: "2026-01-01T00:00:00Z",
    };
    expect(run.status).toBe("completed");
    expect(run.error).toBeUndefined();
  });

  it("UsageAggregation with totals and buckets", () => {
    const usage: UsageAggregation = {
      since: "2026-01-01",
      until: "2026-06-01",
      group_by: "day",
      totals: {
        input_tokens: 100000,
        output_tokens: 50000,
        cached_tokens: 80000,
        reasoning_tokens: 20000,
        cost_usd: 1.5,
        turns: 42,
      },
      buckets: [
        {
          key: "2026-01-01",
          input_tokens: 1000,
          output_tokens: 500,
          cached_tokens: 800,
          reasoning_tokens: 200,
          cost_usd: 0.015,
          turns: 1,
        },
      ],
    };
    expect(usage.totals.turns).toBe(42);
    expect(usage.buckets[0].key).toBe("2026-01-01");
  });

  it("EngineRef interface shape", () => {
    const engine: EngineRef = {
      async ensureRunning() {},
      baseUrl: "http://127.0.0.1:54321",
      token: "sk-test",
    };
    expect(engine.baseUrl).toBe("http://127.0.0.1:54321");
    expect(typeof engine.ensureRunning).toBe("function");
  });
});
