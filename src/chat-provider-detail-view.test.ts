import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const {
  openTextDocumentMock,
  showTextDocumentMock,
  showWarningMessageMock,
} = vi.hoisted(() => ({
  openTextDocumentMock: vi.fn(async (input?: unknown) => ({ input })),
  showTextDocumentMock: vi.fn(async () => undefined),
  showWarningMessageMock: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
    openTextDocument: openTextDocumentMock,
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showErrorMessage: vi.fn(),
    showTextDocument: showTextDocumentMock,
    showWarningMessage: showWarningMessageMock,
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

describe("ChatProvider detail view routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts taskDetail into the main webview for task sidebar clicks", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-task-"));
    const detailPath = path.join(tempDir, "result.md");
    fs.writeFileSync(detailPath, "## WhaleFlow 开发状态\n\n完整结果正文");

    const api = {
      bindEngine: vi.fn(),
      getTask: vi.fn(async () => ({
        id: "task-1",
        status: "completed",
        prompt: "run it",
        result_detail_path: detailPath,
        tool_calls: [],
        timeline: [],
        checklist: {
          items: [{ id: 1, content: "检查状态", status: "completed" }],
          completion_pct: 100,
        },
        gates: [{ id: "g1", gate: "tests", command: "npm test", cwd: tempDir, status: "passed", classification: "verification", duration_ms: 1000, summary: "tests passed", recorded_at: "2026-07-01T00:00:00Z" }],
        attempts: [],
        artifacts: [],
        github_events: [],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await (provider as any).handleShowTaskDetail("task-1");

    expect(api.getTask).toHaveBeenCalledWith("task-1");
    expect(provider.postMessage).toHaveBeenCalledWith({
      type: "taskDetail",
      task: expect.objectContaining({
        id: "task-1",
        status: "completed",
        prompt: "run it",
        result_detail_path: detailPath,
        result_detail_content: "## WhaleFlow 开发状态\n\n完整结果正文",
        result_detail_truncated: false,
        checklist: {
          items: [{ id: 1, content: "检查状态", status: "completed" }],
          completion_pct: 100,
        },
        gates: [
          expect.objectContaining({
            id: "g1",
            log_path: null,
          }),
        ],
      }),
    });

    (provider as any).handleCloseTaskDetail();
  });

  it("hydrates task detail attention state from the linked thread snapshot", async () => {
    const api = {
      bindEngine: vi.fn(),
      getTask: vi.fn(async () => ({
        id: "task-approval",
        status: "running",
        prompt: "run guarded tool",
        thread_id: "thread-approval",
        tool_calls: [],
        timeline: [],
      })),
      getThreadDetail: vi.fn(async () => ({
        pending_approvals: [
          {
            id: "approval-1",
            tool_name: "shell",
            description: "Run a guarded command",
          },
        ],
        pending_user_inputs: [
          {
            id: "input-1",
            request: {
              questions: [
                {
                  id: "q-1",
                  header: "Confirm",
                  question: "Continue?",
                  options: [{ label: "Yes", description: "Proceed" }],
                },
              ],
            },
          },
        ],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await (provider as any).handleShowTaskDetail("task-approval");

    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-approval");
    expect(provider.postMessage).toHaveBeenCalledWith({
      type: "taskDetail",
      task: expect.objectContaining({
        id: "task-approval",
        pending_approvals: [
          expect.objectContaining({
            id: "approval-1",
            tool_name: "shell",
          }),
        ],
        pending_user_inputs: [
          expect.objectContaining({
            id: "input-1",
          }),
        ],
      }),
    });

    (provider as any).handleCloseTaskDetail();
  });

  it("does not reopen task detail on task list refresh after the detail was closed", async () => {
    const api = {
      bindEngine: vi.fn(),
      listTasks: vi.fn(async () => ({
        tasks: [{ id: "task-1", status: "running" }],
      })),
      getTask: vi.fn(async () => ({
        id: "task-1",
        status: "running",
        prompt: "run it",
        tool_calls: [],
        timeline: [],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await (provider as any).handleShowTaskDetail("task-1");
    (provider as any).handleCloseTaskDetail();
    vi.mocked(provider.postMessage).mockClear();

    await provider.refreshTaskList();

    expect(provider.postMessage).toHaveBeenCalledWith({
      type: "taskList",
      tasks: [{ id: "task-1", status: "running" }],
    });
    expect(provider.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "taskDetail" }),
    );
  });

  it("adds attention data to running tasks in the sidebar list", async () => {
    const api = {
      bindEngine: vi.fn(),
      listTasks: vi.fn(async () => ({
        tasks: [
          {
            id: "task-1",
            status: "running",
            prompt_summary: "Needs approval",
            model: "m",
            mode: "agent",
            created_at: "2026-07-01T00:00:00Z",
            started_at: null,
            ended_at: null,
            duration_ms: null,
            error: null,
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
          {
            id: "task-2",
            status: "completed",
            prompt_summary: "Done",
            model: "m",
            mode: "agent",
            created_at: "2026-07-01T00:00:00Z",
            started_at: null,
            ended_at: null,
            duration_ms: null,
            error: null,
            thread_id: "thread-2",
            turn_id: "turn-2",
          },
        ],
      })),
      getThreadDetail: vi.fn(async (threadId: string) => ({
        pending_approvals: threadId === "thread-1" ? [{ id: "approval-1", tool_name: "shell", description: "Run guarded command" }] : [],
        pending_user_inputs: [],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await provider.refreshTaskList();

    expect(api.getThreadDetail).toHaveBeenCalledTimes(1);
    expect(api.getThreadDetail).toHaveBeenCalledWith("thread-1");
    expect(provider.postMessage).toHaveBeenCalledWith({
      type: "taskList",
      tasks: [
        expect.objectContaining({
          id: "task-1",
          pending_approvals: [expect.objectContaining({ id: "approval-1" })],
        }),
        expect.objectContaining({
          id: "task-2",
        }),
      ],
    });
  });

  it("posts agentDetail into the main webview for agent sidebar clicks", async () => {
    const api = {
      bindEngine: vi.fn(),
      getAgentRun: vi.fn(async () => ({ spec: { run_id: "run-1" }, status: "completed" })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await (provider as any).handleShowAgentSessions("run-1");

    expect(api.getAgentRun).toHaveBeenCalledWith("run-1");
    expect(provider.postMessage).toHaveBeenCalledWith({
      type: "agentDetail",
      run: { spec: { run_id: "run-1" }, status: "completed" },
    });
  });

  it("opens cached task preview when the artifact file no longer exists", async () => {
    const api = {
      bindEngine: vi.fn(),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    (provider as any).cacheTextArtifactPreview(
      "/missing/artifacts/result.txt",
      "preview body",
      "markdown",
    );

    await (provider as any).handleOpenFile("/missing/artifacts/result.txt");

    expect(openTextDocumentMock).toHaveBeenCalledWith({
      content: "preview body",
      language: "markdown",
    });
    expect(showTextDocumentMock).toHaveBeenCalled();
    expect(showWarningMessageMock).not.toHaveBeenCalled();
  });

  it("shows a warning instead of throwing when an artifact file is missing", async () => {
    const api = {
      bindEngine: vi.fn(),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    await (provider as any).handleOpenFile("/missing/artifacts/detail.txt");

    expect(showWarningMessageMock).toHaveBeenCalledWith(
      "Artifact file is no longer available: /missing/artifacts/detail.txt",
    );
    expect(provider.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("reads relative task artifact paths from the TUI task data dir", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-home-"));
    const tasksDir = path.join(homeDir, ".codewhale", "tasks");
    const taskArtifactDir = path.join(tasksDir, "artifacts", "task_7ff25f93");
    fs.mkdirSync(taskArtifactDir, { recursive: true });
    const artifactPath = path.join(taskArtifactDir, "20260630T232719.955Z_result.txt");
    fs.writeFileSync(artifactPath, "完整 task result");

    const previousTasksDir = process.env.DEEPSEEK_TASKS_DIR;
    process.env.DEEPSEEK_TASKS_DIR = tasksDir;
    const api = {
      bindEngine: vi.fn(),
      getTask: vi.fn(async () => ({
        id: "task_7ff25f93",
        status: "completed",
        prompt: "run it",
        result_detail_path: "artifacts/task_7ff25f93/20260630T232719.955Z_result.txt",
        tool_calls: [],
        timeline: [],
      })),
    };

    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();

    try {
      await (provider as any).handleShowTaskDetail("task_7ff25f93");

      expect(provider.postMessage).toHaveBeenCalledWith({
        type: "taskDetail",
        task: expect.objectContaining({
          result_detail_content: "完整 task result",
        }),
      });
    } finally {
      if (previousTasksDir === undefined) {
        delete process.env.DEEPSEEK_TASKS_DIR;
      } else {
        process.env.DEEPSEEK_TASKS_DIR = previousTasksDir;
      }
    }
  });
});
