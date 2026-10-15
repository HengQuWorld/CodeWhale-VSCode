import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultTasksDir, resolveTaskArtifactPath } from "./task-paths";

describe("defaultTasksDir", () => {
  let home: string;
  const realHome = process.env.HOME;
  const realOverride = process.env.DEEPSEEK_TASKS_DIR;

  const makeDir = (rel: string) => {
    const abs = path.join(home, rel);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-taskhome-"));
    process.env.HOME = home;
    delete process.env.DEEPSEEK_TASKS_DIR;
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    if (realOverride !== undefined) process.env.DEEPSEEK_TASKS_DIR = realOverride;
    else delete process.env.DEEPSEEK_TASKS_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("takes an explicit DEEPSEEK_TASKS_DIR over anything on disk", () => {
    makeDir(".codewhale/tasks");
    process.env.DEEPSEEK_TASKS_DIR = "/tmp/somewhere-else";
    expect(defaultTasksDir()).toBe("/tmp/somewhere-else");
  });

  it("ignores a blank DEEPSEEK_TASKS_DIR", () => {
    const primary = makeDir(".codewhale/tasks");
    process.env.DEEPSEEK_TASKS_DIR = "   ";
    expect(defaultTasksDir()).toBe(primary);
  });

  it("uses ~/.codewhale/tasks when it exists", () => {
    const primary = makeDir(".codewhale/tasks");
    expect(defaultTasksDir()).toBe(primary);
  });

  it("falls back to the legacy ~/.deepseek/tasks when only it exists", () => {
    const legacy = makeDir(".deepseek/tasks");
    expect(defaultTasksDir()).toBe(legacy);
  });

  it("prefers the current dir over the legacy one when both exist", () => {
    const primary = makeDir(".codewhale/tasks");
    makeDir(".deepseek/tasks");
    expect(defaultTasksDir()).toBe(primary);
  });

  it("names the current dir when neither exists", () => {
    // Nothing to read yet: the answer is where a task would be written, not
    // the legacy path.
    expect(defaultTasksDir()).toBe(path.join(home, ".codewhale", "tasks"));
  });
});

describe("resolveTaskArtifactPath", () => {
  let home: string;
  const realHome = process.env.HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-taskhome-"));
    process.env.HOME = home;
    process.env.DEEPSEEK_TASKS_DIR = path.join(home, ".codewhale", "tasks");
  });

  afterEach(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    delete process.env.DEEPSEEK_TASKS_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("normalizes an absolute path", () => {
    expect(resolveTaskArtifactPath("/tmp/a/../b/./c")).toBe("/tmp/b/c");
  });

  it("keeps a trailing slash on an absolute path, as path.normalize does", () => {
    // Not this function's business to decide: it collapses `..` and `.` and
    // hands back what the filesystem call will use.
    expect(resolveTaskArtifactPath("/tmp/a/../b/./c/")).toBe("/tmp/b/c/");
  });

  it("resolves a relative path against the task data dir", () => {
    expect(resolveTaskArtifactPath("draft/plan.md")).toBe(
      path.join(home, ".codewhale", "tasks", "draft", "plan.md"),
    );
  });
});
