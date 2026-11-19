/**
 * The Activity tab's Memos panel: every conversation's parked prompts in one
 * list. The composer's strip answers "what waits in this conversation"; this
 * panel answers "what waits anywhere, and where" — the same set `/queue list`
 * prints. These tests drive the disk module through a real temp HOME, because
 * the fact that the list survives a reload is the feature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ChatProvider } from "../../chat-provider";
import { t } from "../../i18n";
import { DRAFT_QUEUE_KEY, enqueuePrompt } from "../../utils/message-queue";

const realHome = process.env.HOME;
const WS = "/memos-ws";
/** A clock that moves forward on every read, so two memos parked in the same
 *  test have distinct stamps and "newest activity first" is a real claim. */
let clock = 1_000;

function thread(id: string, title: string) {
  return { id, title } as any;
}

function createProvider(threads: any[] = []) {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => threads),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  (provider as any).currentWorkspaceKey = () => WS;
  return { provider, api, postMessage: provider.postMessage as any };
}

function memosStates(postMessage: ReturnType<typeof vi.fn>): any[] {
  return postMessage.mock.calls
    .map((call) => call[0] as any)
    .filter((msg) => msg.type === "memosState");
}

beforeEach(() => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "memos-panel-"));
  clock = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (realHome !== undefined) process.env.HOME = realHome;
});

describe("ChatProvider memos panel", () => {
  it("groups this workspace's memos by conversation, newest activity first", async () => {
    enqueuePrompt(WS, "thread-old", "older work");
    enqueuePrompt(WS, "thread-new", "newer work");
    enqueuePrompt(WS, "thread-new", "and one more");
    const { provider, postMessage } = createProvider([
      thread("thread-old", "Old conversation"),
      thread("thread-new", "New conversation"),
    ]);

    await provider.refreshMemosPanel();

    const state = memosStates(postMessage)[0];
    expect(state.groups.map((g: any) => [g.kind, g.id, g.title, g.count])).toEqual([
      ["thread", "thread-new", "New conversation", 2],
      ["thread", "thread-old", "Old conversation", 1],
    ]);
    // Each row carries what the panel draws: the text, its stamp, and how many
    // attachments ride along (the panel does not re-read the files).
    expect(state.groups[0].items).toEqual([
      expect.objectContaining({ text: "newer work", attachments: 0 }),
      expect.objectContaining({ text: "and one more", attachments: 0 }),
    ]);
    expect(state.groups[0].items[0].ts).toBeGreaterThan(0);
  });

  it("names the pre-thread bucket the way the composer's strip does", async () => {
    enqueuePrompt(WS, DRAFT_QUEUE_KEY, "written before the first send");
    const { provider, postMessage } = createProvider([thread("thread-1", "A thread")]);

    await provider.refreshMemosPanel();

    const group = memosStates(postMessage)[0].groups[0];
    // A draft row opens a new chat in the webview; the kind is what routes it.
    expect(group.kind).toBe("draft");
    expect(group.id).toBe(DRAFT_QUEUE_KEY);
    expect(group.title).toBe(t().queueDraftTitle);
  });

  it("falls back to the thread id when the engine does not list the thread", async () => {
    // A memo can outlive its thread (deleted or archived away). The id is
    // still the honest name for the bucket, and the click still routes it.
    enqueuePrompt(WS, "thread-gone", "a memo left behind");
    const { provider, postMessage } = createProvider([]);

    await provider.refreshMemosPanel();

    expect(memosStates(postMessage)[0].groups[0].title).toBe("thread-gone");
  });

  it("publishes an empty list without asking the engine for titles", async () => {
    const { provider, api, postMessage } = createProvider([thread("thread-1", "A thread")]);

    await provider.refreshMemosPanel();

    expect(api.listThreads).not.toHaveBeenCalled();
    expect(memosStates(postMessage)[0].groups).toEqual([]);
  });

  it("keeps the id when the title lookup fails, rather than dropping the memos", async () => {
    enqueuePrompt(WS, "thread-1", "still here");
    const { provider, api, postMessage } = createProvider();
    api.listThreads.mockRejectedValueOnce(new Error("engine stalled"));

    await provider.refreshMemosPanel();

    const state = memosStates(postMessage)[0];
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toEqual(
      expect.objectContaining({ id: "thread-1", title: "thread-1", count: 1 }),
    );
  });

  it("drops a stale answer when a newer read has already landed", async () => {
    enqueuePrompt(WS, "thread-1", "first");
    const { provider, api, postMessage } = createProvider([thread("thread-1", "First")]);

    let releaseFirst: (value: any[]) => void = () => undefined;
    api.listThreads.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; }),
    );
    const older = provider.refreshMemosPanel();

    enqueuePrompt(WS, "thread-2", "second");
    api.listThreads.mockResolvedValueOnce([
      thread("thread-1", "First"),
      thread("thread-2", "Second"),
    ]);
    await provider.refreshMemosPanel();

    releaseFirst([thread("thread-1", "First")]);
    await older;

    const states = memosStates(postMessage);
    // Only the newer read may paint: the older answer knew about one memo.
    expect(states).toHaveLength(1);
    expect(states[0].groups.map((g: any) => g.id)).toEqual(["thread-2", "thread-1"]);
  });
});
