import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRecordedFilePath } from "./file-paths";

describe("resolveRecordedFilePath", () => {
  let workspace: string;
  let tasksDir: string;

  const write = (root: string, rel: string, content = "x\n") => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bw-ws-"));
    tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-tasks-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  it("passes absolute paths through", () => {
    const abs = write(workspace, "src/app.ts");
    expect(resolveRecordedFilePath(abs, [workspace], tasksDir)).toBe(abs);
  });

  it("resolves a workspace-relative path against the workspace", () => {
    // What a file tool records: the path the model requested. Resolving it
    // against the task dir alone is what reported edits as unavailable.
    const abs = write(workspace, "DeepSeek-GUI/src/app.ts");
    expect(resolveRecordedFilePath("DeepSeek-GUI/src/app.ts", [workspace], tasksDir)).toBe(abs);
  });

  it("keeps the task data dir as the fallback for real artifacts", () => {
    const abs = write(tasksDir, "task_1/result.txt");
    expect(resolveRecordedFilePath("task_1/result.txt", [workspace], tasksDir)).toBe(abs);
  });

  it("prefers the workspace when both roots hold the same relative path", () => {
    const workspaceFile = write(workspace, "result.txt");
    write(tasksDir, "result.txt");
    expect(resolveRecordedFilePath("result.txt", [workspace], tasksDir)).toBe(workspaceFile);
  });

  it("searches every workspace root", () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "bw-ws2-"));
    try {
      const abs = write(second, "pkg/app.ts");
      expect(resolveRecordedFilePath("pkg/app.ts", [workspace, second], tasksDir)).toBe(abs);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it("names a workspace candidate when the file is gone", () => {
    // The warning has to point somewhere a person can check, so an unknown
    // relative path still resolves into the workspace before the task dir.
    expect(resolveRecordedFilePath("gone/app.ts", [workspace], tasksDir)).toBe(
      path.join(workspace, "gone/app.ts"),
    );
  });

  it("falls back to the task data dir when no workspace is open", () => {
    expect(resolveRecordedFilePath("gone.txt", [], tasksDir)).toBe(path.join(tasksDir, "gone.txt"));
  });
});
