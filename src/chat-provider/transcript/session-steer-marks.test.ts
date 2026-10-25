import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

const SESSION = {
  metadata: {
    id: "sess-1",
    title: "a conversation",
    workspace: "/workspace",
    total_tokens: 0,
  },
  messages: [
    { role: "user", content: [{ type: "text", text: "first ask" }] },
    { role: "assistant", content: [{ type: "text", text: "answer one" }] },
    { role: "user", content: [{ type: "text", text: "focus on the audio" }] },
    { role: "assistant", content: [{ type: "text", text: "answer two" }] },
    { role: "user", content: [{ type: "text", text: "second ask" }] },
    { role: "assistant", content: [{ type: "text", text: "answer three" }] },
  ],
};

/** The thread the runtime still holds for that document, with the steer the
 *  document itself cannot describe. */
const BOUND_THREAD = {
  latest_seq: 10,
  thread: { id: "thread-1", model: "deepseek-v4-pro", session_id: "sess-1" },
  turns: [
    {
      id: "turn-1",
      input_summary: "first ask",
      created_at: "2026-10-24T10:00:00Z",
      ended_at: "2026-10-24T10:00:10Z",
      status: "completed",
      item_ids: ["u1", "a1", "u2", "a2"],
    },
    {
      id: "turn-2",
      input_summary: "second ask",
      created_at: "2026-10-24T10:05:00Z",
      ended_at: "2026-10-24T10:05:10Z",
      status: "completed",
      item_ids: ["u3", "a3"],
    },
  ],
  items: [
    { id: "u1", kind: "user_message", summary: "first ask", detail: "first ask", status: "completed" },
    { id: "a1", kind: "agent_message", summary: "answer one", detail: "answer one", status: "completed" },
    { id: "u2", kind: "user_message", summary: "focus on the audio", detail: "focus on the audio", status: "completed" },
    { id: "a2", kind: "agent_message", summary: "answer two", detail: "answer two", status: "completed" },
    { id: "u3", kind: "user_message", summary: "second ask", detail: "second ask", status: "completed" },
    { id: "a3", kind: "agent_message", summary: "answer three", detail: "answer three", status: "completed" },
  ],
};

function createProvider(opts: {
  session?: Record<string, unknown>;
  threads?: Array<Record<string, unknown>>;
  threadDetail?: Record<string, unknown>;
}) {
  const detail = opts.threadDetail ?? BOUND_THREAD;
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => opts.session ?? SESSION),
    listThreads: vi.fn(async () => opts.threads ?? [BOUND_THREAD.thread]),
    listProviderModels: vi.fn(async () => ({ provider: "custom", models: [] })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();

  return { provider, api };
}

const bubbles = (provider: ChatProvider) =>
  provider.messages.filter((message) => message.role === "user");

describe("ChatProvider steer provenance for a viewed session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the prompts the Runtime's turn items call steering", async () => {
    // A saved document stores a steer and a fresh turn identically, so the
    // badge cannot come from counting positions in it. The turn items can say:
    // the second `user_message` of a turn is guidance sent into it.
    const { provider } = createProvider({});

    await provider.loadSessionMessages("sess-1");

    expect(bubbles(provider).map((m) => `${m.steered ? "steer" : "turn"}:${m.content}`)).toEqual([
      "turn:first ask",
      "steer:focus on the audio",
      "turn:second ask",
    ]);
    // The steer shares the number of the turn it was sent into; the next turn's
    // own prompt opens the next group.
    expect(bubbles(provider).map((m) => m.turnIndex)).toEqual([1, 1, 2]);
  });

  it("marks a dropped steer as not delivered", async () => {
    const { provider } = createProvider({
      threadDetail: {
        ...BOUND_THREAD,
        items: BOUND_THREAD.items.map((item) =>
          item.id === "u2" ? { ...item, status: "canceled" } : item
        ),
      },
    });

    await provider.loadSessionMessages("sess-1");

    const steers = bubbles(provider).filter((m) => m.steered);
    expect(steers.map((m) => ({ content: m.content, undelivered: m.undelivered }))).toEqual([
      { content: "focus on the audio", undelivered: true },
    ]);
  });

  it("claims nothing when no thread owns the document", async () => {
    // A session with no live thread has no authority for steering at all. It
    // must not fall back to guessing from adjacency: that is what badged
    // eighteen real turns in a compacted transcript.
    const { provider } = createProvider({ threads: [] });

    await provider.loadSessionMessages("sess-1");

    expect(bubbles(provider).some((m) => m.steered)).toBe(false);
    expect(bubbles(provider).some((m) => m.undelivered)).toBe(false);
  });

  it("claims nothing when the Runtime cannot answer", async () => {
    const { provider, api } = createProvider({});
    (api.listThreads as any).mockRejectedValueOnce(new Error("runtime gone"));

    await provider.loadSessionMessages("sess-1");

    expect(bubbles(provider).some((m) => m.steered)).toBe(false);
  });

  it("ignores a thread that belongs to a different session", async () => {
    const { provider } = createProvider({
      threads: [{ ...BOUND_THREAD.thread, session_id: "sess-other" }],
    });

    await provider.loadSessionMessages("sess-1");

    expect(bubbles(provider).some((m) => m.steered)).toBe(false);
  });

  it("keeps the document's own words when it has drifted from the thread", async () => {
    // Matching is by prompt text, so a transcript that no longer agrees with
    // its thread gets plain bubbles rather than inherited badges on the wrong
    // rows.
    const { provider } = createProvider({
      session: {
        metadata: { ...SESSION.metadata },
        messages: [
          { role: "user", content: [{ type: "text", text: "rewritten question" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
      },
    });

    await provider.loadSessionMessages("sess-1");

    expect(bubbles(provider).map((m) => `${m.content}:${m.steered ? "steer" : "turn"}`)).toEqual([
      "rewritten question:turn",
    ]);
  });
});
