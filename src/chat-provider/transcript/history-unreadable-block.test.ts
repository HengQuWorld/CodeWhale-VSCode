import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

function createProvider(detail: Record<string, unknown>) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
    // The model menu asks the runtime for the route's catalog; a test that
    // exercises the chip's model needs the answer to come from a route.
    listProviderModels: vi.fn(async () => ({
      provider: "custom",
      models: [{ id: "glm-5.3" }, { id: "glm-5.4" }],
    })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();

  return { provider, api, postMessage: provider.postMessage as any };
}

describe("a session document with a block nothing can read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The shape the runtime persists for an expanded `[Attached image: …]`
   *  attachment: the wrapper text it wrote, and `null` where the image block
   *  itself should be. */
  function sessionWithUnreadableBlock() {
    return {
      metadata: { id: "thr-null", title: "picture turn", total_tokens: 10 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is wrong with this screen?" },
            { type: "text", text: '<image path="/tmp/shot.png">' },
            null,
            { type: "text", text: "</image>" },
            { type: "text", text: "please look" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Looking at it now." }] },
        { role: "user", content: [{ type: "text", text: "and the changes?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-edit-1",
              name: "edit",
              input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-edit-1",
              content: "Successfully replaced 1 block(s) in src/app.ts.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };
  }

  it("opens the session instead of failing on the unreadable entry", async () => {
    // Reading a block's `type` off a null entry threw out of the whole replay,
    // so the conversation would not open at all — the error the reader saw was
    // "Failed to load session: Cannot read properties of null", with the view
    // cleared, while the same conversation's thread opened fine (it is built
    // from turn items, not this document).
    const { provider, postMessage } = createProvider(sessionWithUnreadableBlock());

    await provider.loadSessionMessages("thr-null");

    const posted = postMessage.mock.calls.map(
      (call: unknown[]) => call[0] as Record<string, any>,
    );
    expect(posted.filter((message: Record<string, any>) => message.type === "error")).toEqual([]);
    expect(posted.filter((message: Record<string, any>) => message.type === "clearChat")).toEqual([]);

    const history = posted.filter((message: Record<string, any>) => message.type === "loadHistory").pop();
    expect(history).toBeDefined();
    // Everything the document did say still reaches the reader, including the
    // text the runtime wrapped the attachment in.
    const flat = JSON.stringify(history.messages);
    expect(flat).toContain("what is wrong with this screen?");
    expect(flat).toContain("image path=");
    expect(flat).toContain("/tmp/shot.png");
    expect(flat).toContain("Looking at it now.");
    // And the turn after it still replays: dropping one block must not cost the
    // rest of the transcript.
    expect(provider.messages.length).toBeGreaterThanOrEqual(4);
    const calls = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.name)).toEqual(["edit"]);
  });

  it("keeps the change that followed the unreadable block", async () => {
    const { provider, postMessage } = createProvider(sessionWithUnreadableBlock());

    await provider.loadSessionMessages("thr-null");

    const changesState = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .filter((message: Record<string, any>) => message.type === "changesState")
      .pop();
    expect(changesState).toBeDefined();
    expect(changesState.changes).toHaveLength(1);
    expect(changesState.changes[0].filePath).toBe("src/app.ts");
  });
});
