import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INPUT_HISTORY_LIMIT,
  loadInputHistory,
  pushInputHistory,
  workspaceHistoryKey,
} from "./input-history";

const realHome = process.env.HOME;

beforeEach(() => {
  // Redirect the store to a throwaway HOME so tests never touch the real
  // ~/.codewhale/input-history the user's panel reads.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "input-history-"));
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
});

describe("input-history store", () => {
  it("keys each workspace to its own file", () => {
    expect(workspaceHistoryKey("/a")).not.toBe(workspaceHistoryKey("/b"));
    expect(workspaceHistoryKey("")).toBe("no-workspace");
    expect(workspaceHistoryKey("/a")).toBe(workspaceHistoryKey("/a"));
  });

  it("is empty before anything was sent", () => {
    expect(loadInputHistory("/ws")).toEqual([]);
  });

  it("stores newest first and reads back across a fresh load", () => {
    pushInputHistory("/ws", "first");
    pushInputHistory("/ws", "second");
    // A "restart" is nothing more than a new load of the same file.
    expect(loadInputHistory("/ws")).toEqual(["second", "first"]);
  });

  it("stores an exact repeat of the head again, mirroring the webview's unshift", () => {
    pushInputHistory("/ws", "same");
    pushInputHistory("/ws", "same");
    expect(loadInputHistory("/ws")).toEqual(["same", "same"]);
  });

  it("ignores blank entries", () => {
    expect(pushInputHistory("/ws", "   ")).toEqual([]);
    expect(loadInputHistory("/ws")).toEqual([]);
  });

  it("keeps workspaces separate", () => {
    pushInputHistory("/ws-a", "from a");
    pushInputHistory("/ws-b", "from b");
    expect(loadInputHistory("/ws-a")).toEqual(["from a"]);
    expect(loadInputHistory("/ws-b")).toEqual(["from b"]);
  });

  it("caps the list at the same limit the webview enforces", () => {
    for (let i = 0; i < INPUT_HISTORY_LIMIT + 25; i++) {
      pushInputHistory("/ws", `entry-${i}`);
    }
    const list = loadInputHistory("/ws");
    expect(list).toHaveLength(INPUT_HISTORY_LIMIT);
    expect(list[0]).toBe(`entry-${INPUT_HISTORY_LIMIT + 24}`);
  });

  it("reads a corrupt file as no history rather than failing", () => {
    const file = path.join(
      process.env.HOME!, ".codewhale", "input-history",
      `${workspaceHistoryKey("/ws")}.json`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(loadInputHistory("/ws")).toEqual([]);
    // And the store recovers on the next write.
    expect(pushInputHistory("/ws", "after corruption")).toEqual(["after corruption"]);
  });

  it("drops non-string junk from a hand-edited file", () => {
    const file = path.join(
      process.env.HOME!, ".codewhale", "input-history",
      `${workspaceHistoryKey("/ws")}.json`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([42, "real", null, ""]));
    expect(loadInputHistory("/ws")).toEqual(["real"]);
  });
});
