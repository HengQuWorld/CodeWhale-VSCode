/**
 * The message queue ("queue as memo, run when the user decides") must survive
 * a restart: parking a prompt writes it under the thread it belongs to, and a
 * reloaded window reads the same prompts back. These tests exercise the disk
 * module with a real temp HOME — the persistence contract is the point.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { workspaceHistoryKey } from "../../utils/input-history";
import {
  DRAFT_QUEUE_KEY,
  MESSAGE_QUEUE_LIMIT,
  clearThreadQueue,
  dequeuePrompt,
  enqueuePrompt,
  loadMessageQueue,
  migrateThreadQueue,
} from "../../utils/message-queue";
import {
  loadLastThreadId,
  saveLastThreadId,
} from "../../utils/last-thread";

const realHome = process.env.HOME;
const WS = "/queue-ws";

/** The exact file the module files this workspace's queues under. */
function queueFilePath(): string {
  return path.join(
    process.env.HOME!,
    ".codewhale",
    "message-queue",
    `${workspaceHistoryKey(WS)}.json`
  );
}

beforeEach(() => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "msg-queue-"));
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
});

describe("message queue persistence", () => {
  it("enqueues oldest-first and reads back by thread", () => {
    enqueuePrompt(WS, "thread-a", "first instruction");
    enqueuePrompt(WS, "thread-a", "second instruction");
    enqueuePrompt(WS, "thread-b", "other thread");

    const queue = loadMessageQueue(WS);
    expect(queue["thread-a"].map((p) => p.text)).toEqual([
      "first instruction",
      "second instruction",
    ]);
    expect(queue["thread-b"].map((p) => p.text)).toEqual(["other thread"]);
    expect(queue["thread-a"][0].id).not.toEqual(queue["thread-a"][1].id);
    expect(queue["thread-a"][0].ts).toBeGreaterThan(0);
  });

  it("drops empty and whitespace-only prompts", () => {
    enqueuePrompt(WS, "thread-a", "   ");
    enqueuePrompt(WS, "thread-a", "\n");
    expect(loadMessageQueue(WS)["thread-a"]).toBeUndefined();
  });

  it("dequeues by id and reports a miss", () => {
    enqueuePrompt(WS, "thread-a", "keep me");
    const parked = loadMessageQueue(WS)["thread-a"][0];

    expect(dequeuePrompt(WS, "thread-a", "no-such-id")).toBeNull();
    const after = dequeuePrompt(WS, "thread-a", parked.id);
    expect(after).toEqual([]);
    expect(loadMessageQueue(WS)["thread-a"]).toBeUndefined();
  });

  it("clear reports how many prompts it dropped", () => {
    enqueuePrompt(WS, "thread-a", "one");
    enqueuePrompt(WS, "thread-a", "two");
    expect(clearThreadQueue(WS, "thread-a")).toBe(2);
    expect(clearThreadQueue(WS, "thread-a")).toBe(0);
    expect(loadMessageQueue(WS)["thread-a"]).toBeUndefined();
  });

  it("caps a thread's queue and prunes the oldest at push time", () => {
    for (let i = 0; i < MESSAGE_QUEUE_LIMIT + 5; i++) {
      enqueuePrompt(WS, "thread-a", `prompt ${i}`);
    }
    const entries = loadMessageQueue(WS)["thread-a"];
    expect(entries).toHaveLength(MESSAGE_QUEUE_LIMIT);
    expect(entries[0].text).toBe("prompt 5");
    expect(entries[entries.length - 1].text).toBe(`prompt ${MESSAGE_QUEUE_LIMIT + 4}`);
  });

  it("migrates the draft bucket onto the created thread without duplication", () => {
    enqueuePrompt(WS, DRAFT_QUEUE_KEY, "parked first");
    enqueuePrompt(WS, DRAFT_QUEUE_KEY, "parked second");

    const migrated = migrateThreadQueue(WS, DRAFT_QUEUE_KEY, "thread-1");
    expect(migrated.map((p) => p.text)).toEqual([
      "parked first",
      "parked second",
    ]);
    const queue = loadMessageQueue(WS);
    expect(queue[DRAFT_QUEUE_KEY]).toBeUndefined();
    // A second migration is a no-op: the source key is gone.
    expect(migrateThreadQueue(WS, DRAFT_QUEUE_KEY, "thread-1")).toHaveLength(2);
  });

  it("keeps other threads' queues when one thread clears", () => {
    enqueuePrompt(WS, "thread-a", "a1");
    enqueuePrompt(WS, "thread-b", "b1");
    clearThreadQueue(WS, "thread-a");
    expect(loadMessageQueue(WS)["thread-b"].map((p) => p.text)).toEqual(["b1"]);
  });

  it("reads a corrupt file as an empty queue", () => {
    fs.mkdirSync(path.dirname(queueFilePath()), { recursive: true });
    fs.writeFileSync(queueFilePath(), "{not json");
    expect(loadMessageQueue(WS)).toEqual({});
    // And the next enqueue repairs the file in place.
    enqueuePrompt(WS, "thread-a", "after corruption");
    expect(loadMessageQueue(WS)["thread-a"].map((p) => p.text)).toEqual([
      "after corruption",
    ]);
  });

  it("self-heals malformed entries instead of poisoning the queue", () => {
    fs.mkdirSync(path.dirname(queueFilePath()), { recursive: true });
    fs.writeFileSync(
      queueFilePath(),
      JSON.stringify({
        "thread-a": [
          { id: "q-1", text: "good one", ts: 1 },
          { text: "" },
          "not an object",
          { text: "   " },
          { text: "rescued without id" },
        ],
      })
    );
    const entries = loadMessageQueue(WS)["thread-a"];
    expect(entries.map((p) => p.text)).toEqual(["good one", "rescued without id"]);
    expect(entries[1].id).not.toBe("");
  });
});

describe("queued attachments on disk", () => {
  it("carries attachments through a save/load round trip", () => {
    enqueuePrompt(WS, "thread-a", "attach this", [
      { path: "/tmp/report.pdf", name: "report.pdf", kind: "file" },
      { path: "/tmp/shot.png", name: "shot.png", kind: "image" },
    ]);
    const parked = loadMessageQueue(WS)["thread-a"][0];
    expect(parked.attachments).toHaveLength(2);
    expect(parked.attachments![0]).toEqual({
      path: "/tmp/report.pdf",
      name: "report.pdf",
      kind: "file",
    });
  });

  it("reads legacy records without attachments as attachment-free", () => {
    fs.mkdirSync(path.dirname(queueFilePath()), { recursive: true });
    fs.writeFileSync(
      queueFilePath(),
      JSON.stringify({ "thread-a": [{ id: "q-old", text: "from before attachments", ts: 1 }] })
    );
    const parked = loadMessageQueue(WS)["thread-a"][0];
    expect(parked.attachments).toBeUndefined();
  });

  it("drops unusable attachment rows but keeps the memo", () => {
    fs.mkdirSync(path.dirname(queueFilePath()), { recursive: true });
    fs.writeFileSync(
      queueFilePath(),
      JSON.stringify({
        "thread-a": [
          {
            id: "q-1",
            text: "memo",
            ts: 1,
            attachments: [{ path: "/tmp/ok.txt" }, { name: "no path" }, "junk"],
          },
        ],
      })
    );
    const parked = loadMessageQueue(WS)["thread-a"][0];
    expect(parked.attachments).toHaveLength(1);
    expect(parked.attachments![0].path).toBe("/tmp/ok.txt");
    // An all-unusable list reads as no attachments.
    fs.writeFileSync(
      queueFilePath(),
      JSON.stringify({ "thread-a": [{ id: "q-2", text: "memo", attachments: ["junk"] }] })
    );
    expect(loadMessageQueue(WS)["thread-a"][0].attachments).toBeUndefined();
  });

  it("a plain enqueue stays attachment-free", () => {
    enqueuePrompt(WS, "thread-a", "no files here");
    expect(loadMessageQueue(WS)["thread-a"][0].attachments).toBeUndefined();
  });
});

describe("last-thread record", () => {
  it("records and reads back the thread a workspace had open", () => {
    expect(loadLastThreadId(WS)).toBeNull();
    saveLastThreadId(WS, "thr_abc");
    expect(loadLastThreadId(WS)).toBe("thr_abc");
    // A different workspace does not inherit it.
    expect(loadLastThreadId("/other-ws")).toBeNull();
  });

  it("a null save clears the record — reopening comes back to the view on screen", () => {
    saveLastThreadId(WS, "thr_abc");
    saveLastThreadId(WS, null);
    expect(loadLastThreadId(WS)).toBeNull();
  });

  it("reads a corrupt record as no thread", () => {
    fs.mkdirSync(path.join(process.env.HOME!, ".codewhale", "last-thread"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        process.env.HOME!,
        ".codewhale",
        "last-thread",
        `${workspaceHistoryKey(WS)}.json`
      ),
      "{broken"
    );
    expect(loadLastThreadId(WS)).toBeNull();
  });

  it("clearing a workspace with no record is a no-op", () => {
    saveLastThreadId(WS, null);
    expect(loadLastThreadId(WS)).toBeNull();
  });
});
