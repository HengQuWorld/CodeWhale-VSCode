/**
 * The provider's queue behaviours: parking a prompt, the run decision (idle →
 * send, busy+steer → steer, busy without steer → stay parked), edit/drop/
 * clear feedback, and the draft bucket that follows the conversation its
 * first send creates. The disk module has its own suite; these cover the
 * provider's decisions and the messages the webview repaints from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ChatProvider } from "../../chat-provider";
import { loadMessageQueue, enqueuePrompt, DRAFT_QUEUE_KEY } from "../../utils/message-queue";
import { vscodeState } from "../vscode-double";

const realHome = process.env.HOME;
const WS = "/queue-ws";

beforeEach(() => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "queue-provider-"));
  vscodeState.workspaceFolders = [{ uri: { fsPath: WS } }];
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
});

function createProvider() {
  const api = { bindEngine: vi.fn() };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return { provider, postMessage: provider.postMessage as any };
}

function messagesOfType(postMessage: ReturnType<typeof vi.fn>, type: string): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === type);
}

function lastQueue(postMessage: ReturnType<typeof vi.fn>): any[] | undefined {
  const lists = messagesOfType(postMessage, "messageQueue");
  return lists[lists.length - 1]?.items;
}

describe("queue as memo (provider)", () => {
  it("parks the composer's text, posts the info and repaints the strip", () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("run the tests after the refactor lands");

    // The info says the parking happened (with the queue's length); the
    // prompt text itself travels on the strip's messageQueue message.
    expect(messagesOfType(postMessage, "info")).toHaveLength(1);
    const items = lastQueue(postMessage);
    expect(items).toHaveLength(1);
    expect(items![0].text).toBe("run the tests after the refactor lands");
    // And it is on disk under the draft bucket — no thread exists yet.
    expect(loadMessageQueue(WS)[DRAFT_QUEUE_KEY]).toHaveLength(1);
  });

  it("ignores parking nothing", () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("   ");
    expect(postMessage).not.toHaveBeenCalled();
    expect(loadMessageQueue(WS)).toEqual({});
  });

  it("running an idle memo dispatches a normal send and takes it off the queue", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("memo one");
    const id = lastQueue(postMessage)![0].id;

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(id);

    expect(send).toHaveBeenCalledWith("memo one", { queued: true, attachments: [], skill: null });
    expect(lastQueue(postMessage)).toHaveLength(0);
    expect(loadMessageQueue(WS)[DRAFT_QUEUE_KEY]).toBeUndefined();
  });

  it("a refused dispatch re-parks the memo", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("memo that fails");
    const id = lastQueue(postMessage)![0].id;

    (provider as any).handleSendMessage = vi.fn(async () => false);
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(id);

    // Back in the strip and on disk — a refused run loses nothing.
    expect(lastQueue(postMessage)).toHaveLength(1);
    expect(loadMessageQueue(WS)[DRAFT_QUEUE_KEY]).toHaveLength(1);
  });

  it("busy without steer support keeps the memo parked", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("wait for me");
    const id = lastQueue(postMessage)![0].id;
    (provider as any).currentTurnId = "turn-1";
    (provider as any).apiCapabilities.turnSteer = false;

    const send = vi.fn(async () => true);
    const steer = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;
    (provider as any).handleSteer = steer;
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(id);

    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(messagesOfType(postMessage, "info").some((m) =>
      typeof m.message === "string" && m.message.length > 0
    )).toBe(true);
    // Nothing changed, so the strip is not repainted — but the memo is
    // still parked on disk.
    expect(messagesOfType(postMessage, "messageQueue")).toHaveLength(0);
    expect(loadMessageQueue(WS)[DRAFT_QUEUE_KEY]).toHaveLength(1);
  });

  it("busy with steer support steers the memo into the running turn", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("guide the turn");
    const id = lastQueue(postMessage)![0].id;
    (provider as any).currentTurnId = "turn-1";
    (provider as any).apiCapabilities.turnSteer = true;

    const steer = vi.fn(async () => true);
    (provider as any).handleSteer = steer;
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(id);

    // Explicit [] attachments and an explicit null skill: the memo is its own
    // text and its own skill, never the composer's current arming.
    expect(steer).toHaveBeenCalledWith("guide the turn", [], null);
    expect(lastQueue(postMessage)).toHaveLength(0);
  });

  it("parks the armed skill into the memo and consumes the arming", () => {
    const { provider, postMessage } = createProvider();
    provider.armSkill({ name: "frontend-design", body: "Read DESIGN.md first." });

    provider.handleQueuePrompt("build the page");

    const items = lastQueue(postMessage)!;
    expect(items[0].skill).toEqual({
      name: "frontend-design",
      body: "Read DESIGN.md first.",
    });
    // One-shot: the arming is the memo's now, not the composer's. Leaving it
    // live would silently attach it to whatever the next message was.
    expect((provider as any).armedSkill).toBeNull();
    expect(messagesOfType(postMessage, "skillArmed").pop()).toEqual({
      type: "skillArmed",
      name: null,
    });
  });

  it("dispatches a memo's own skill, not the composer's current arming", async () => {
    const { provider, postMessage } = createProvider();
    provider.armSkill({ name: "debug", body: "Reproduce first." });
    provider.handleQueuePrompt("memo with a skill");
    const id = lastQueue(postMessage)![0].id;

    // Something else armed since — the memo must not pick it up.
    provider.armSkill({ name: "other", body: "Other body." });

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;
    await provider.handleRunQueuedPrompt(id);

    expect(send).toHaveBeenCalledWith("memo with a skill", {
      queued: true,
      attachments: [],
      skill: { name: "debug", body: "Reproduce first." },
    });
    // The composer's arming survives a memo dispatch — it was never its.
    expect((provider as any).armedSkill).toEqual({ name: "other", body: "Other body." });
  });

  it("steers a busy memo with the skill it was parked with", async () => {
    const { provider, postMessage } = createProvider();
    provider.armSkill({ name: "debug", body: "Reproduce first." });
    provider.handleQueuePrompt("guide it");
    const id = lastQueue(postMessage)![0].id;
    (provider as any).currentTurnId = "turn-1";
    (provider as any).apiCapabilities.turnSteer = true;

    const steer = vi.fn(async () => true);
    (provider as any).handleSteer = steer;
    await provider.handleRunQueuedPrompt(id);

    expect(steer).toHaveBeenCalledWith("guide it", [], {
      name: "debug",
      body: "Reproduce first.",
    });
  });

  it("parks an activation that carries a task while a turn runs", async () => {
    const { provider, postMessage } = createProvider();
    provider.armSkill({ name: "debug", body: "Reproduce first." });
    (provider as any).currentTurnId = "turn-1";

    await provider.sendMessage("fix it now");

    // `/skill <name> <task>` while busy parks the task (TUI parity): sending
    // would ask the busy thread for a second turn and the words would be lost.
    const items = lastQueue(postMessage)!;
    expect(items[0].text).toBe("fix it now");
    expect(items[0].skill?.name).toBe("debug");
    expect((provider as any).armedSkill).toBeNull();
  });

  it("edit puts the memo's skill back in the composer", () => {
    const { provider, postMessage } = createProvider();
    provider.armSkill({ name: "debug", body: "Reproduce first." });
    provider.handleQueuePrompt("edit me");
    const id = lastQueue(postMessage)![0].id;
    postMessage.mockClear();

    provider.handleEditQueuedPrompt(id, "edit me");

    // Editing a memo and sending it must mean what running it would have
    // meant, so the skill returns with the text.
    expect((provider as any).armedSkill).toEqual({
      name: "debug",
      body: "Reproduce first.",
    });
    expect(messagesOfType(postMessage, "skillArmed").pop()?.name).toBe("debug");
  });

  it("edit hands the memo back through setInputText and takes it off the queue", () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("edit me later");
    const id = lastQueue(postMessage)![0].id;

    postMessage.mockClear();
    provider.handleEditQueuedPrompt(id, "a draft\n\nedit me later");

    const input = messagesOfType(postMessage, "setInputText");
    expect(input).toHaveLength(1);
    // The webview's merged text wins: the box's own draft survives.
    expect(input[0].text).toBe("a draft\n\nedit me later");
    expect(lastQueue(postMessage)).toHaveLength(0);
  });

  it("drop removes one memo; clear reports how many it dropped", () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("one");
    provider.handleQueuePrompt("two");
    const firstId = lastQueue(postMessage)![0].id;

    postMessage.mockClear();
    provider.handleDropQueuedPrompt(firstId);
    expect(lastQueue(postMessage)).toHaveLength(1);

    provider.handleClearQueuedPrompts();
    const infos = messagesOfType(postMessage, "info").map((m) => m.message);
    expect(infos.some((s) => String(s).includes("1"))).toBe(true);
    expect(lastQueue(postMessage)).toHaveLength(0);

    // Clearing again is a no-op that says so.
    postMessage.mockClear();
    provider.handleClearQueuedPrompts();
    expect(messagesOfType(postMessage, "info")).toHaveLength(1);
    expect(messagesOfType(postMessage, "messageQueue")).toHaveLength(0);
  });

  it("a run or drop naming a stale id reports the miss and changes nothing", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("still here");

    postMessage.mockClear();
    await provider.handleRunQueuedPrompt("q-gone");
    provider.handleDropQueuedPrompt("q-gone");

    expect(messagesOfType(postMessage, "error")).toHaveLength(2);
    // Neither miss touched the queue: the memo is still parked on disk.
    expect(loadMessageQueue(WS)[DRAFT_QUEUE_KEY]).toHaveLength(1);
  });

  it("the draft bucket migrates onto the thread the first send creates", () => {
    const { provider } = createProvider();
    enqueuePrompt(WS, DRAFT_QUEUE_KEY, "parked early");
    enqueuePrompt(WS, DRAFT_QUEUE_KEY, "parked later");

    (provider as any).migrateQueuedPromptsInto("thread-1", null);

    const queue = loadMessageQueue(WS);
    expect(queue[DRAFT_QUEUE_KEY]).toBeUndefined();
    expect(queue["thread-1"].map((p: any) => p.text)).toEqual([
      "parked early",
      "parked later",
    ]);
  });

  it("a recovery that replaces the thread carries its parked memos to the new id", () => {
    const { provider } = createProvider();
    enqueuePrompt(WS, "old-thread", "memo of a lost thread");

    (provider as any).migrateQueuedPromptsInto("new-thread", "old-thread");

    const queue = loadMessageQueue(WS);
    expect(queue["old-thread"]).toBeUndefined();
    expect(queue["new-thread"].map((p: any) => p.text)).toEqual([
      "memo of a lost thread",
    ]);
  });
});

describe("queued memos with attachments (provider)", () => {
  /** A real file, so the rebuild's stat check passes. */
  function tempFile(name: string, bytes = 32): string {
    const file = path.join(process.env.HOME!, name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 0x41));
    return file;
  }

  function parkWithAttachment(provider: any, text: string, filePath: string): any {
    (provider as any).currentAttachments = [
      { id: "att-1", kind: "file", path: filePath, name: path.basename(filePath) },
    ];
    provider.handleQueuePrompt(text);
    return loadMessageQueue(WS)[DRAFT_QUEUE_KEY][0];
  }

  it("parking takes the composer's attachments with the text", () => {
    const { provider, postMessage } = createProvider();
    const file = tempFile("brief.txt");
    const parked = parkWithAttachment(provider as any, "review the brief", file);

    expect(parked.attachments).toHaveLength(1);
    expect(parked.attachments![0].path).toBe(file);
    // The box let go of them, the same optimism a send has.
    const lists = messagesOfType(postMessage, "attachmentsChanged");
    expect(lists[lists.length - 1].attachments).toHaveLength(0);
    expect((provider as any).currentAttachments).toHaveLength(0);
  });

  it("running dispatches the memo with its attachments re-read from disk", async () => {
    const { provider, postMessage } = createProvider();
    const file = tempFile("brief.txt");
    const parked = parkWithAttachment(provider as any, "review the brief", file);

    const send = vi.fn(async (_text: string, _opts?: any) => true);
    (provider as any).handleSendMessage = send;
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(parked.id);

    const opts = send.mock.calls[0]![1] as any;
    expect(opts.queued).toBe(true);
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].path).toBe(file);
    // The composer's (empty) attachment list was never touched by a memo
    // dispatch: no attachmentsChanged was posted for it.
    expect(messagesOfType(postMessage, "attachmentsChanged")).toHaveLength(0);
  });

  it("busy steering carries the memo's attachments, not the box's", async () => {
    const { provider } = createProvider();
    const file = tempFile("shot.png");
    const parked = parkWithAttachment(provider as any, "look at this", file);

    (provider as any).currentTurnId = "turn-1";
    (provider as any).apiCapabilities.turnSteer = true;
    const steer = vi.fn(async (_text: string, _atts?: any) => true);
    (provider as any).handleSteer = steer;
    await provider.handleRunQueuedPrompt(parked.id);

    expect((steer.mock.calls[0]![1] as any[]).map((a: any) => a.path)).toEqual([file]);
  });

  it("a stored file gone missing is named and skipped, memo still runs", async () => {
    const { provider, postMessage } = createProvider();
    const parked = parkWithAttachment(
      provider as any,
      "the file will vanish",
      path.join(process.env.HOME!, "deleted.txt")
    );
    // Nothing to stat: the file never existed.

    const send = vi.fn(async (_text: string, _opts?: any) => true);
    (provider as any).handleSendMessage = send;
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(parked.id);

    expect((send.mock.calls[0]![1] as any).attachments).toHaveLength(0);
    const infos = messagesOfType(postMessage, "info").map((m) => m.message);
    expect(infos.some((s) => String(s).includes("deleted.txt"))).toBe(true);
  });

  it("editing hands the attachments back to the composer with the text", () => {
    const { provider, postMessage } = createProvider();
    const file = tempFile("shot.png");
    const parked = parkWithAttachment(provider as any, "tweak and send", file);
    postMessage.mockClear();

    provider.handleEditQueuedPrompt(parked.id);

    expect((provider as any).currentAttachments.map((a: any) => a.path)).toEqual([file]);
    const lists = messagesOfType(postMessage, "attachmentsChanged");
    expect(lists.length).toBeGreaterThan(0);
  });

  it("a refused dispatch re-parks with the same attachment list", async () => {
    const { provider } = createProvider();
    const file = tempFile("brief.txt");
    const parked = parkWithAttachment(provider as any, "will fail", file);

    (provider as any).handleSendMessage = vi.fn(async () => false);
    await provider.handleRunQueuedPrompt(parked.id);

    const reParked = loadMessageQueue(WS)[DRAFT_QUEUE_KEY][0];
    expect(reParked.text).toBe("will fail");
    expect(reParked.attachments?.map((a) => a.path)).toEqual([file]);
  });
});

describe("queue auto-dispatch (provider)", () => {
  afterEach(() => {
    vscodeState.configValues.delete("queueAutoDispatch");
  });

  it("parks automatic only when the setting says so", () => {
    const { provider, postMessage } = createProvider();

    provider.handleQueuePrompt("waits for me");
    expect(lastQueue(postMessage)![0].auto).toBeUndefined();
    expect(messagesOfType(postMessage, "info").pop()?.message).toContain("nothing runs");

    vscodeState.configValues.set("queueAutoDispatch", true);
    provider.handleQueuePrompt("runs by itself");
    expect(lastQueue(postMessage)![1].auto).toBe(true);
    expect(messagesOfType(postMessage, "info").pop()?.message).toContain("on its own");
  });

  it("lets the caller override the setting either way", () => {
    const { provider, postMessage } = createProvider();
    vscodeState.configValues.set("queueAutoDispatch", true);

    provider.handleQueuePrompt("manual on purpose", false);

    expect(lastQueue(postMessage)![0].auto).toBeUndefined();
  });

  it("runs the head of the queue by itself when the turn above it ends", async () => {
    const { provider } = createProvider();
    // A turn just ended, so a thread exists — that is the state the drain runs
    // in, and the queue lives under that thread's bucket.
    (provider as any).currentThread = { id: "thread-1" };
    provider.handleQueuePrompt("auto memo", true);

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;

    await (provider as any).drainAutoQueuedPrompt();

    expect(send).toHaveBeenCalledWith(
      "auto memo",
      expect.objectContaining({ queued: true, skill: null })
    );
    expect(loadMessageQueue(WS)["thread-1"]).toBeUndefined();
  });

  it("does not pull an automatic memo past a manual one", async () => {
    const { provider } = createProvider();
    (provider as any).currentThread = { id: "thread-1" };
    provider.handleQueuePrompt("manual first");
    provider.handleQueuePrompt("auto second", true);

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;

    await (provider as any).drainAutoQueuedPrompt();

    // The queue is ordered: the auto memo waits behind the memo the user
    // chose to run by hand.
    expect(send).not.toHaveBeenCalled();
    expect(loadMessageQueue(WS)["thread-1"]).toHaveLength(2);
  });

  it("leaves the queue alone while a turn is still running", async () => {
    const { provider } = createProvider();
    (provider as any).currentThread = { id: "thread-1" };
    provider.handleQueuePrompt("auto memo", true);

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;
    (provider as any).currentTurnId = "turn-1";

    await (provider as any).drainAutoQueuedPrompt();

    expect(send).not.toHaveBeenCalled();
  });

  it("leaves a viewed saved session's queue alone", async () => {
    const { provider } = createProvider();
    (provider as any).currentThread = { id: "thread-1" };
    provider.handleQueuePrompt("auto memo", true);

    const send = vi.fn(async () => true);
    (provider as any).handleSendMessage = send;
    (provider as any).viewingSessionId = "session-1";

    await (provider as any).drainAutoQueuedPrompt();

    expect(send).not.toHaveBeenCalled();
  });

  it("does not dispatch twice when the same turn.completed is replayed", async () => {
    const { provider } = createProvider();
    (provider as any).currentThread = { id: "thread-1" };
    provider.handleQueuePrompt("auto memo", true);

    let release: (() => void) | null = null;
    const send = vi.fn(
      () => new Promise<boolean>((resolve) => { release = () => resolve(true); })
    );
    (provider as any).handleSendMessage = send;

    const first = (provider as any).drainAutoQueuedPrompt();
    // A second delivery of the same event arrives while the first dispatch is
    // still in flight: it must not run the memo again.
    await (provider as any).drainAutoQueuedPrompt();
    release!();
    await first;

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("flips one memo's automatic flag from the panel row", () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("memo");
    const id = lastQueue(postMessage)![0].id;

    provider.handleToggleQueuedAuto(id, true);
    expect(lastQueue(postMessage)![0].auto).toBe(true);
    expect(messagesOfType(postMessage, "info").pop()?.message).toContain("run when");

    provider.handleToggleQueuedAuto(id, false);
    expect(lastQueue(postMessage)![0].auto).toBeUndefined();
    expect(messagesOfType(postMessage, "info").pop()?.message).toContain("waits for you");
  });

  it("re-parks a refused automatic dispatch with its flag intact", async () => {
    const { provider, postMessage } = createProvider();
    provider.handleQueuePrompt("auto memo", true);
    const id = lastQueue(postMessage)![0].id;

    (provider as any).handleSendMessage = vi.fn(async () => false);
    postMessage.mockClear();
    await provider.handleRunQueuedPrompt(id);

    const items = lastQueue(postMessage)!;
    expect(items).toHaveLength(1);
    expect(items[0].auto).toBe(true);
  });
});
