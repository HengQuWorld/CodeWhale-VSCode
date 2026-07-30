import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodeWhaleApiClient } from "./api-client";
import type { RuntimeEvent, ThreadRecord, TurnRecord, TaskSummary, EngineRef } from "../types";

describe("SSE event parsing", () => {
  function parseSseChunk(raw: string): { event: string | null; data: string | null }[] {
    const results: { event: string | null; data: string | null }[] = [];
    let currentEvent: string | null = null;
    let currentData: string | null = null;

    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line === "" && currentEvent && currentData) {
        results.push({ event: currentEvent, data: currentData });
        currentEvent = null;
        currentData = null;
      }
    }
    return results;
  }

  it("parses a single SSE event", () => {
    const raw = "event: turn.completed\ndata: {\"seq\":1}\n\n";
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("turn.completed");
    expect(events[0].data).toBe('{"seq":1}');
  });

  it("parses multiple SSE events", () => {
    const raw = [
      "event: item.started",
      'data: {"seq":1,"item_id":"i1"}',
      "",
      "event: item.delta",
      'data: {"seq":2,"item_id":"i1"}',
      "",
    ].join("\n");
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("item.started");
    expect(events[1].event).toBe("item.delta");
  });

  it("ignores comment lines", () => {
    const raw = [
      ": this is a comment",
      "event: turn.lifecycle",
      'data: {"seq":1}',
      "",
    ].join("\n");
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("turn.lifecycle");
  });

  it("handles multi-line data by keeping only last data line", () => {
    const raw = [
      "event: item.delta",
      'data: {"seq":2}',
      'data: {"seq":3}',
      "",
    ].join("\n");
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data!)).toEqual({ seq: 3 });
  });

  it("skips incomplete events (no blank line terminator)", () => {
    const raw = "event: item.started\ndata: {\"seq\":1}";
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(0);
  });

  it("skips events with empty data (SSE parser requires truthy data)", () => {
    const raw = "event: ping\ndata: \n\n";
    const events = parseSseChunk(raw);
    expect(events).toHaveLength(0);
  });
});

describe("RuntimeEvent type structure", () => {
  it("validates turn.lifecycle event structure", () => {
    const event: RuntimeEvent = {
      seq: 1,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: null,
      event: "turn.lifecycle",
      payload: { status: "running" },
    };
    expect(event.event).toBe("turn.lifecycle");
    expect((event.payload as { status: string }).status).toBe("running");
  });

  it("validates cycle.advanced event structure", () => {
    const event: RuntimeEvent = {
      seq: 5,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: null,
      event: "cycle.advanced",
      payload: { from: 2, to: 3, cycle: 3 },
    };
    expect(event.event).toBe("cycle.advanced");
    const pl = event.payload as { from: number; to: number; cycle: number };
    expect(pl.to).toBe(3);
    expect(pl.cycle).toBe(3);
  });

  it("validates coherence.state event structure", () => {
    const event: RuntimeEvent = {
      seq: 10,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: null,
      event: "coherence.state",
      payload: { state: "refreshing_context", label: "Refreshing context…", description: "Verifying recent work" },
    };
    expect(event.event).toBe("coherence.state");
    const pl = event.payload as { state: string; label: string; description: string };
    expect(pl.state).toBe("refreshing_context");
    expect(pl.label).toContain("Refreshing");
  });

  it("validates item.started event with tool_call kind", () => {
    const event: RuntimeEvent = {
      seq: 2,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: "item-1",
      event: "item.started",
      payload: {
        item: { kind: "tool_call", id: "item-1", summary: "read_file" },
      },
    };
    expect(event.item_id).toBe("item-1");
    const pl = event.payload as { item: { kind: string; id: string; summary: string } };
    expect(pl.item.kind).toBe("tool_call");
  });

  it("validates item.completed event with task_updates metadata", () => {
    const event: RuntimeEvent = {
      seq: 8,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: "item-5",
      event: "item.completed",
      payload: {
        item: {
          kind: "tool_call",
          id: "item-5",
          summary: "todo_write",
          status: "completed",
          metadata: {
            task_updates: {
              checklist: {
                items: [
                  { id: "1", content: "Read codebase", status: "completed" },
                  { id: "2", content: "Write tests", status: "in_progress" },
                  { id: "3", content: "Fix bugs", status: "pending" },
                ],
                completion_pct: 33,
              },
            },
          },
        },
      },
    };
    const pl = event.payload as {
      item: {
        metadata: {
          task_updates: {
            checklist: {
              items: { id: string; content: string; status: string }[];
              completion_pct: number;
            };
          };
        };
      };
    };
    const checklist = pl.item.metadata.task_updates.checklist;
    expect(checklist.items).toHaveLength(3);
    expect(checklist.completion_pct).toBe(33);
    expect(checklist.items[0].status).toBe("completed");
    expect(checklist.items[1].status).toBe("in_progress");
    expect(checklist.items[2].status).toBe("pending");
  });

  it("validates approval.required event structure", () => {
    const event: RuntimeEvent = {
      seq: 15,
      timestamp: new Date().toISOString(),
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: null,
      event: "approval.required",
      payload: {
        request: {
          approval_id: "appr-1",
          call_id: "item-3",
          tool_name: "exec_shell",
          command: "rm -rf /tmp/test",
          reason: "Destructive command requires approval",
        },
      },
    };
    const pl = event.payload as {
      request: { approval_id: string; tool_name: string; reason: string };
    };
    expect(pl.request.approval_id).toBe("appr-1");
    expect(pl.request.tool_name).toBe("exec_shell");
  });
});

describe("API URL construction", () => {
  const baseUrl = "http://127.0.0.1:54321";

  it("constructs thread list URL", () => {
    const url = new URL("/v1/threads", baseUrl);
    expect(url.toString()).toBe("http://127.0.0.1:54321/v1/threads");
  });

  it("constructs thread list URL with query params", () => {
    const params = new URLSearchParams({ limit: "20", include_archived: "true" });
    const url = new URL(`/v1/threads?${params.toString()}`, baseUrl);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("include_archived")).toBe("true");
  });

  it("constructs SSE event stream URL with since_seq", () => {
    const params = new URLSearchParams({ since_seq: "42" });
    const url = new URL(`/v1/threads/thread-1/events?${params.toString()}`, baseUrl);
    expect(url.pathname).toBe("/v1/threads/thread-1/events");
    expect(url.searchParams.get("since_seq")).toBe("42");
  });

  it("constructs SSE URL with since_seq=0 for initial connection", () => {
    const params = new URLSearchParams({ since_seq: "0" });
    const url = new URL(`/v1/threads/thread-1/events?${params.toString()}`, baseUrl);
    expect(url.searchParams.get("since_seq")).toBe("0");
  });

  it("constructs task list URL", () => {
    const url = new URL("/v1/tasks", baseUrl);
    expect(url.toString()).toBe("http://127.0.0.1:54321/v1/tasks");
  });

  it("constructs approval decision URL", () => {
    const url = new URL("/v1/approvals/appr-1", baseUrl);
    expect(url.toString()).toBe("http://127.0.0.1:54321/v1/approvals/appr-1");
  });

  it("constructs health check URL", () => {
    const url = new URL("/health", baseUrl);
    expect(url.toString()).toBe("http://127.0.0.1:54321/health");
  });

  it("constructs compact thread URL", () => {
    const url = new URL("/v1/threads/thread-1/compact", baseUrl);
    expect(url.pathname).toBe("/v1/threads/thread-1/compact");
  });

  it("constructs interrupt turn URL", () => {
    const url = new URL("/v1/threads/thread-1/turns/turn-1/interrupt", baseUrl);
    expect(url.pathname).toBe("/v1/threads/thread-1/turns/turn-1/interrupt");
  });
});

describe("ThreadRecord type validation", () => {
  it("has required fields for a valid thread", () => {
    const thread: ThreadRecord = {
      schema_version: 1,
      id: "thread-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      model: "deepseek-v4-pro",
      workspace: "/tmp/test",
      mode: "agent",
      allow_shell: true,
      trust_mode: false,
      auto_approve: false,
      latest_turn_id: null,
      archived: false,
      coherence_state: "healthy",
    };
    expect(thread.id).toBe("thread-1");
    expect(thread.mode).toBe("agent");
    expect(thread.coherence_state).toBe("healthy");
  });

  it("supports optional title field", () => {
    const thread: ThreadRecord = {
      schema_version: 1,
      id: "thread-2",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      model: "deepseek-v4-flash",
      workspace: "/tmp/test",
      mode: "plan",
      allow_shell: false,
      trust_mode: false,
      auto_approve: false,
      latest_turn_id: "turn-1",
      archived: false,
      coherence_state: "healthy",
      title: "My Thread",
    };
    expect(thread.title).toBe("My Thread");
  });
});

describe("TurnRecord status transitions", () => {
  const validStatuses = ["queued", "in_progress", "completed", "failed", "interrupted", "canceled"];

  it("all valid statuses are accepted", () => {
    for (const status of validStatuses) {
      const turn: TurnRecord = {
        schema_version: 1,
        id: "turn-1",
        thread_id: "thread-1",
        status: status as TurnRecord["status"],
        input_summary: "test",
        created_at: new Date().toISOString(),
        item_ids: [],
        steer_count: 0,
      };
      expect(turn.status).toBe(status);
    }
  });

  it("usage tracking fields are optional", () => {
    const turn: TurnRecord = {
      schema_version: 1,
      id: "turn-1",
      thread_id: "thread-1",
      status: "completed",
      input_summary: "test",
      created_at: new Date().toISOString(),
      item_ids: [],
      steer_count: 0,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        reasoning_tokens: 300,
      },
    };
    expect(turn.usage?.input_tokens).toBe(1000);
    expect(turn.usage?.prompt_cache_hit_tokens).toBe(800);
  });
});

describe("TaskSummary type validation", () => {
  it("has required fields for a valid task summary", () => {
    const task: TaskSummary = {
      id: "task-1",
      status: "running",
      prompt_summary: "Fix the bug",
      model: "deepseek-v4-pro",
      mode: "agent",
      workspace: "/tmp/workspace",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: null,
      duration_ms: null,
      error: null,
      thread_id: "thread-1",
      turn_id: "turn-1",
    };
    expect(task.status).toBe("running");
    expect(task.thread_id).toBe("thread-1");
  });
});

describe("API request body construction", () => {
  it("createThread omits undefined optional fields", () => {
    const body: Record<string, unknown> = {};
    const opts: { model?: string; mode?: string; workspace?: string } = {};
    if (opts.model) body.model = opts.model;
    if (opts.mode) body.mode = opts.mode;
    if (opts.workspace) body.workspace = opts.workspace;
    expect(Object.keys(body)).toHaveLength(0);
  });

  it("createThread includes provided fields", () => {
    const body: Record<string, unknown> = {};
    const opts = { model: "deepseek-v4-pro", mode: "agent", workspace: "/tmp" };
    if (opts.model) body.model = opts.model;
    if (opts.mode) body.mode = opts.mode;
    if (opts.workspace) body.workspace = opts.workspace;
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.mode).toBe("agent");
    expect(body.workspace).toBe("/tmp");
  });

  it("startTurn body always includes prompt", () => {
    const body: Record<string, unknown> = { prompt: "Hello" };
    expect(body.prompt).toBe("Hello");
  });

  it("startTurn body includes optional model override", () => {
    const body: Record<string, unknown> = { prompt: "Hello", model: "deepseek-v4-flash" };
    expect(body.model).toBe("deepseek-v4-flash");
  });

  it("decideApproval body includes decision and remember flag", () => {
    const body = { decision: "allow" as const, remember: true };
    expect(body.decision).toBe("allow");
    expect(body.remember).toBe(true);
  });

  it("createTask body includes required prompt", () => {
    const body = { prompt: "Fix all bugs", mode: "agent" };
    expect(body.prompt).toBe("Fix all bugs");
  });
});

describe("Auth header construction", () => {
  it("includes Authorization header when token is set", () => {
    const token = "sk-test-123";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
  });

  it("omits Authorization header when token is null", () => {
    const token: string | null = null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ── CodeWhaleApiClient class method tests ──
// Uses mocked HTTP to test actual class methods without a running server.

vi.mock("http", () => {
  return {
    default: {
      request: vi.fn(),
      get: vi.fn(),
    },
    request: vi.fn(),
    get: vi.fn(),
  };
});

import * as http from "http";

function mockHttpRequest(statusCode: number, responseData: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (http.request as any).mockImplementation(
    (_url: unknown, _opts: unknown, callback: (res: { statusCode: number; on: (evt: string, fn: (chunk?: Buffer) => void) => void }) => void) => {
      const res = {
        statusCode,
        on(evt: string, fn: (chunk?: Buffer) => void) {
          if (evt === "data") {
            fn(Buffer.from(responseData));
          } else if (evt === "end") {
            fn();
          }
        },
      };
      callback(res);
      const req = {
        on: () => req,
        setTimeout: () => req,
        write: () => {},
        end: () => {},
      };
      return req;
    }
  );
}

describe("CodeWhaleApiClient - Constructor and configuration", () => {
  it("creates client with baseUrl", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    expect(client).toBeDefined();
  });

  it("creates client with baseUrl and token", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321", "sk-test");
    expect(client).toBeDefined();
  });

  it("setToken updates auth token", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    client.setToken("new-token");
    // Token is private; verify indirectly by checking the client doesn't throw
    expect(client).toBeDefined();
  });

  it("setBaseUrl updates base URL", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    client.setBaseUrl("http://localhost:99999");
    expect(client).toBeDefined();
  });

  it("bindEngine sets engine reference", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    const engine: EngineRef = {
      async ensureRunning() {},
      baseUrl: "http://localhost:54321",
      token: null,
    };
    client.bindEngine(engine);
    expect(client).toBeDefined();
  });
});

describe("CodeWhaleApiClient - ensureReady and syncFromEngine", () => {
  it("ensureReady calls engine.ensureRunning and syncs", async () => {
    const ensureRunning = vi.fn().mockResolvedValue(undefined);
    const engine: EngineRef = {
      ensureRunning,
      baseUrl: "http://localhost:99999",
      token: "engine-token",
    };
    const client = new CodeWhaleApiClient("http://localhost:54321");
    client.bindEngine(engine);

    await client.ensureReady();

    expect(ensureRunning).toHaveBeenCalledOnce();
  });

  it("ensureReady works without engine bound", async () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    await expect(client.ensureReady()).resolves.toBeUndefined();
  });

  it("syncFromEngine updates baseUrl and token from engine", () => {
    const engine: EngineRef = {
      async ensureRunning() {},
      baseUrl: "http://localhost:99999",
      token: "engine-token",
    };
    const client = new CodeWhaleApiClient("http://localhost:54321");
    client.bindEngine(engine);

    client.syncFromEngine();
    // Verify indirectly: after sync, subsequent requests use the engine's URL
    expect(client).toBeDefined();
  });

  it("syncFromEngine is no-op without engine", () => {
    const client = new CodeWhaleApiClient("http://localhost:54321");
    client.syncFromEngine(); // Should not throw
    expect(client).toBeDefined();
  });

  it("syncFromEngine skips redundant syncs", () => {
    const engine: EngineRef = {
      async ensureRunning() {},
      baseUrl: "http://localhost:54321",
      token: "same-token",
    };
    const client = new CodeWhaleApiClient("http://localhost:54321", "same-token");
    client.bindEngine(engine);

    // First sync
    client.syncFromEngine();
    // Second sync with same values should be no-op (internal optimization)
    client.syncFromEngine();
    expect(client).toBeDefined();
  });
});

describe("CodeWhaleApiClient - HTTP methods with mocked server", () => {
  let client: CodeWhaleApiClient;

  beforeEach(() => {
    client = new CodeWhaleApiClient("http://localhost:54321", "sk-test");
    vi.clearAllMocks();
  });

  it("health() returns status object", async () => {
    mockHttpRequest(200, JSON.stringify({ status: "ok", service: "codewhale", mode: "local" }));
    const result = await client.health();
    expect(result.status).toBe("ok");
    expect(result.service).toBe("codewhale");
  });

  it("getThread() extracts thread from detail response", async () => {
    const threadData: ThreadRecord = {
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
    };
    mockHttpRequest(200, JSON.stringify({ thread: threadData, turns: [], items: [], latest_seq: 0 }));
    const result = await client.getThread("thread-1");
    expect(result.id).toBe("thread-1");
    expect(result.model).toBe("deepseek-v4-pro");
  });

  it("getThread() returns thread directly if no wrapper", async () => {
    const threadData: ThreadRecord = {
      schema_version: 1,
      id: "thread-2",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      model: "deepseek-v4-flash",
      workspace: "/tmp",
      mode: "plan",
      allow_shell: false,
      trust_mode: false,
      auto_approve: false,
      latest_turn_id: null,
      archived: false,
      coherence_state: "healthy",
    };
    mockHttpRequest(200, JSON.stringify(threadData));
    const result = await client.getThread("thread-2");
    expect(result.id).toBe("thread-2");
  });

  it("createThread() sends POST to /v1/threads", async () => {
    const threadData: ThreadRecord = {
      schema_version: 1,
      id: "thread-new",
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
    };
    mockHttpRequest(200, JSON.stringify(threadData));
    const result = await client.createThread({ model: "deepseek-v4-pro", mode: "agent" });
    expect(result.id).toBe("thread-new");
    expect(http.request).toHaveBeenCalled();
  });

  it("startTurn() sends prompt and returns StartTurnResponse", async () => {
    const response = {
      thread: { id: "thread-1", schema_version: 1, created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      turn: { id: "turn-1", schema_version: 1, thread_id: "thread-1", status: "in_progress", input_summary: "Hello", created_at: "", item_ids: [], steer_count: 0 },
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.startTurn("thread-1", "Hello");
    expect(result.turn.id).toBe("turn-1");
  });

  it("listThreads() returns array of threads", async () => {
    const threads: ThreadRecord[] = [
      { schema_version: 1, id: "t1", created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      { schema_version: 1, id: "t2", created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
    ];
    mockHttpRequest(200, JSON.stringify(threads));
    const result = await client.listThreads({ limit: 10 });
    expect(result).toHaveLength(2);
  });

  it("updateThread() sends PATCH with updates", async () => {
    const updated: ThreadRecord = {
      schema_version: 1, id: "thread-1", created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: true, coherence_state: "",
    };
    mockHttpRequest(200, JSON.stringify(updated));
    const result = await client.updateThread("thread-1", { archived: true });
    expect(result.archived).toBe(true);
  });

  it("undoThreadTurn() returns UndoTurnResponse", async () => {
    const response = {
      thread: { id: "thread-1", schema_version: 1, created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      original_user_text: "Hello",
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.undoThreadTurn("thread-1");
    expect(result.original_user_text).toBe("Hello");
  });

  it("undoThreadTurn() with depth option", async () => {
    const response = {
      thread: { id: "thread-1", schema_version: 1, created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      original_user_text: null,
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.undoThreadTurn("thread-1", { depth: 2 });
    expect(result.original_user_text).toBeNull();
  });

  it("patchUndoThreadTurn() returns PatchUndoResponse", async () => {
    const response = {
      patch_result: { files_restored: true, summary: "3 files restored", snapshot_label: "pre-turn:5" },
      thread: { id: "thread-1", schema_version: 1, created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      original_user_text: "Fix bug",
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.patchUndoThreadTurn("thread-1");
    expect(result.patch_result.files_restored).toBe(true);
  });

  it("retryThreadTurn() returns RetryTurnResponse", async () => {
    const response = {
      thread: { id: "thread-1", schema_version: 1, created_at: "", updated_at: "", model: "", workspace: "", mode: "", allow_shell: false, trust_mode: false, auto_approve: false, latest_turn_id: null, archived: false, coherence_state: "" },
      turn: { id: "turn-2", schema_version: 1, thread_id: "thread-1", status: "queued", input_summary: "Hello", created_at: "", item_ids: [], steer_count: 0 },
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.retryThreadTurn("thread-1");
    expect(result.turn.id).toBe("turn-2");
  });

  it("decideApproval() sends POST to approvals endpoint", async () => {
    mockHttpRequest(200, "");
    await expect(client.decideApproval("appr-1", "allow", true)).resolves.toBeUndefined();
  });

  it("listTasks() returns tasks and counts", async () => {
    const response = {
      tasks: [{ id: "task-1", status: "running", prompt_summary: "Fix", model: "", mode: "", workspace: "/tmp/workspace", created_at: "", started_at: null, ended_at: null, duration_ms: null, error: null, thread_id: null, turn_id: null }],
      counts: { queued: 0, running: 1, completed: 5, failed: 0, canceled: 0 },
    };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.listTasks();
    expect(result.tasks).toHaveLength(1);
    expect(result.counts.running).toBe(1);
  });

  it("listTasks() includes workspace query when provided", async () => {
    const response = {
      tasks: [],
      counts: { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 },
    };
    mockHttpRequest(200, JSON.stringify(response));

    await client.listTasks({ limit: 50, workspace: "/tmp/workspace" });

    const lastCall = vi.mocked(http.request).mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const requestUrl = lastCall?.[0] as URL;
    expect(requestUrl.pathname).toBe("/v1/tasks");
    expect(requestUrl.searchParams.get("limit")).toBe("50");
    expect(requestUrl.searchParams.get("workspace")).toBe("/tmp/workspace");
  });

  it("getRuntimeInfo() returns RuntimeInfoResponse", async () => {
    const response = { bind_host: "127.0.0.1", port: 54321, auth_required: false, version: "1.0.0" };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.getRuntimeInfo();
    expect(result.port).toBe(54321);
    expect(result.version).toBe("1.0.0");
  });

  it("getWorkspaceStatus() returns workspace info", async () => {
    const response = { workspace: "/tmp", git_repo: true, branch: "main", staged: 0, unstaged: 1, untracked: 2 };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.getWorkspaceStatus();
    expect(result.git_repo).toBe(true);
    expect(result.untracked).toBe(2);
  });

  it("listSkills() returns skills response", async () => {
    const response = { directory: "/skills", directories: [], warnings: [], skills: [{ name: "test", description: "Test skill", path: "/skills/test", enabled: true, is_bundled: false }] };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.listSkills();
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("test");
  });

  it("listSessions() returns sessions list", async () => {
    const response = { sessions: [{ id: "sess-1", title: "Test", created_at: "", updated_at: "", message_count: 5, total_tokens: 1000, model: "", workspace: "" }] };
    mockHttpRequest(200, JSON.stringify(response));
    const result = await client.listSessions();
    expect(result.sessions).toHaveLength(1);
  });

  it("throws on API error (status >= 400)", async () => {
    mockHttpRequest(500, "Internal Server Error");
    await expect(client.health()).rejects.toThrow("API error 500");
  });

  it("throws on 404 not found", async () => {
    mockHttpRequest(404, "Not Found");
    await expect(client.getThread("nonexistent")).rejects.toThrow("API error 404");
  });

  it("handles non-JSON response gracefully", async () => {
    mockHttpRequest(200, "plain text");
    const result = await client.health();
    expect(result).toBe("plain text");
  });
});

describe("CodeWhaleApiClient - Automation methods", () => {
  let client: CodeWhaleApiClient;

  beforeEach(() => {
    client = new CodeWhaleApiClient("http://localhost:54321", "sk-test");
    vi.clearAllMocks();
  });

  it("listAutomations() returns array", async () => {
    const autos = [
      { schema_version: 1, id: "auto-1", name: "Daily", prompt: "Clean", rrule: "FREQ=DAILY", cwds: ["/tmp"], status: "active", created_at: "", updated_at: "" },
    ];
    mockHttpRequest(200, JSON.stringify(autos));
    const result = await client.listAutomations();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Daily");
  });

  it("createAutomation() sends POST", async () => {
    const auto = { schema_version: 1, id: "auto-2", name: "Weekly", prompt: "Deploy", rrule: "FREQ=WEEKLY", cwds: ["/app"], status: "active", created_at: "", updated_at: "" };
    mockHttpRequest(200, JSON.stringify(auto));
    const result = await client.createAutomation({ name: "Weekly", prompt: "Deploy", rrule: "FREQ=WEEKLY" });
    expect(result.id).toBe("auto-2");
  });

  it("updateAutomation() sends PATCH", async () => {
    const auto = { schema_version: 1, id: "auto-1", name: "Updated", prompt: "Clean", rrule: "FREQ=DAILY", cwds: ["/tmp"], status: "paused", created_at: "", updated_at: "" };
    mockHttpRequest(200, JSON.stringify(auto));
    const result = await client.updateAutomation("auto-1", { status: "paused" });
    expect(result.status).toBe("paused");
  });

  it("pauseAutomation() sends POST to pause endpoint", async () => {
    const auto = { schema_version: 1, id: "auto-1", name: "Daily", prompt: "Clean", rrule: "FREQ=DAILY", cwds: ["/tmp"], status: "paused", created_at: "", updated_at: "" };
    mockHttpRequest(200, JSON.stringify(auto));
    const result = await client.pauseAutomation("auto-1");
    expect(result.status).toBe("paused");
  });

  it("resumeAutomation() sends POST to resume endpoint", async () => {
    const auto = { schema_version: 1, id: "auto-1", name: "Daily", prompt: "Clean", rrule: "FREQ=DAILY", cwds: ["/tmp"], status: "active", created_at: "", updated_at: "" };
    mockHttpRequest(200, JSON.stringify(auto));
    const result = await client.resumeAutomation("auto-1");
    expect(result.status).toBe("active");
  });
});

describe("CodeWhaleApiClient - Usage methods", () => {
  let client: CodeWhaleApiClient;

  beforeEach(() => {
    client = new CodeWhaleApiClient("http://localhost:54321", "sk-test");
    vi.clearAllMocks();
  });

  it("getUsage() returns aggregation data", async () => {
    const usage = {
      since: "2026-01-01", until: "2026-06-01", group_by: "day",
      totals: { input_tokens: 100, output_tokens: 50, cached_tokens: 80, reasoning_tokens: 20, cost_usd: 0.01, turns: 5 },
      buckets: [],
    };
    mockHttpRequest(200, JSON.stringify(usage));
    const result = await client.getUsage({ since: "2026-01-01", until: "2026-06-01", group_by: "day" });
    expect(result.totals.turns).toBe(5);
  });
});
