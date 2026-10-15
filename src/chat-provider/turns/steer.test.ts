import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => ({ id: "turn-1" })),
  };
  const provider = new ChatProvider({} as any, {} as any, api as any);

  provider.postMessage = vi.fn();
  provider.refreshWorkPanel = vi.fn();
  provider.refreshSessionList = vi.fn(async () => undefined);
  provider.refreshTaskList = vi.fn(async () => undefined);
  (provider as any).stopPeriodicTaskRefresh = vi.fn();
  (provider as any).apiCapabilities.turnSteer = true;

  provider.currentThread = { id: "thread-1" } as any;
  (provider as any).currentTurnId = "turn-1";
  provider.messages = [
    { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 },
    { id: "a1", role: "assistant", content: "partial answer", status: "streaming", timestamp: 2, blocks: [] },
  ] as any;
  (provider as any).currentTextBlockIdx = -1;
  (provider as any).currentThinkingBlockIdx = -1;

  return { provider, api, postMessage: provider.postMessage as any };
}

describe("ChatProvider steer flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("steer interrupts the streaming assistant: finalizes it and starts a new segment", async () => {
    const { provider, api, postMessage } = createProvider();
    const messagesBefore = provider.messages.length;
    const oldAssistant = provider.messages[provider.messages.length - 1];

    await (provider as any).handleSteer("focus on tests");

    // The interrupted segment is finalized, a fresh streaming assistant
    // placeholder follows it, and the steer bubble stays display-only
    // (never enters this.messages — the SSE router keys off messages[last]).
    expect(provider.messages.length).toBe(messagesBefore + 1);
    expect(oldAssistant.status).toBe("complete");
    const newAssistant = provider.messages[provider.messages.length - 1];
    expect(newAssistant.role).toBe("assistant");
    expect(newAssistant.status).toBe("streaming");

    // Webview ordering: the steer bubble is appended before the new
    // assistant placeholder (both via addMessage, which appends DOM nodes),
    // so the visual order is: interrupted segment → steer bubble → new
    // segment. messageComplete only finalizes the old segment in place.
    const calls = postMessage.mock.calls.map((c: any[]) => c[0] as any);
    const steerIdx = calls.findIndex((c: any) => c.type === "addMessage" && c.message.steered);
    const completeIdx = calls.findIndex((c: any) => c.type === "messageComplete" && c.messageId === "a1");
    const newMsgIdx = calls.findIndex((c: any) => c.type === "addMessage" && c.message.id === newAssistant.id);
    expect(steerIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(newMsgIdx).toBeGreaterThan(steerIdx);
    expect(completeIdx).toBeGreaterThan(steerIdx);

    expect(api.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", "focus on tests");
  });

  it("post-steer item.delta appends to the NEW assistant segment, not the old one", async () => {
    const { provider } = createProvider();
    const oldAssistant = provider.messages[provider.messages.length - 1];

    await (provider as any).handleSteer("focus on tests");

    (provider as any).handleRuntimeEvent({
      seq: 2,
      event: "item.delta",
      turn_id: "turn-1",
      item_id: "i1",
      payload: { kind: "agent_message", delta: " more" },
    } as any);

    const newAssistant = provider.messages[provider.messages.length - 1];
    expect(newAssistant).not.toBe(oldAssistant);
    expect(newAssistant.content).toBe(" more");
    // The interrupted segment keeps its pre-steer content untouched.
    expect(oldAssistant.content).toBe("partial answer");
    expect(oldAssistant.status).toBe("complete");
  });

  it("post-steer turn.completed finalizes the new segment (unsticks streaming)", async () => {
    const { provider, postMessage } = createProvider();

    await (provider as any).handleSteer("focus on tests");
    const newAssistant = provider.messages[provider.messages.length - 1];
    // Post-steer output lands on the new segment so it is non-empty when
    // the turn ends (empty placeholders are discarded, see the test below).
    (provider as any).handleRuntimeEvent({
      seq: 4,
      event: "item.delta",
      turn_id: "turn-1",
      item_id: "i2",
      payload: { kind: "agent_message", delta: "steered answer" },
    } as any);
    expect(newAssistant.content).toBe("steered answer");

    (provider as any).handleRuntimeEvent({
      seq: 3,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    } as any);

    expect(newAssistant.status).toBe("complete");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "messageComplete", messageId: newAssistant.id })
    );
  });

  it("turn.completed safety net closes running tools in pre-steer segments too", async () => {
    const { provider, postMessage } = createProvider();
    const oldAssistant = provider.messages[provider.messages.length - 1];
    oldAssistant.toolCalls = [{ name: "bash", input: {}, status: "running", itemId: "tool-1" }];

    await (provider as any).handleSteer("focus on tests");

    (provider as any).handleRuntimeEvent({
      seq: 3,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    } as any);

    expect(oldAssistant.toolCalls![0].status).toBe("complete");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "updateToolCall", messageId: "a1", toolCallIdx: 0 })
    );
  });

  it("steer without an active turn posts an error and skips the API", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentTurnId = null;

    await (provider as any).handleSteer("focus on tests");

    expect(api.steerTurn).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" })
    );
  });

  it("steer API failure leaves the transcript untouched (TUI parity: engine first, visuals on success)", async () => {
    const { provider, api, postMessage } = createProvider();
    api.steerTurn.mockRejectedValueOnce(new Error("turn is stopping"));
    const messagesBefore = provider.messages.length;
    const oldAssistant = provider.messages[provider.messages.length - 1];

    await (provider as any).handleSteer("focus on tests");

    // No steer bubble, no finalize, no new segment — only the error.
    expect(provider.messages.length).toBe(messagesBefore);
    expect(oldAssistant.status).toBe("streaming");
    const types = postMessage.mock.calls.map((c: any[]) => (c[0] as any).type);
    expect(types).not.toContain("addMessage");
    expect(types).not.toContain("messageComplete");
    expect(types).toContain("error");
  });

  it("a refused steer puts the text back in the box", async () => {
    const { provider, api, postMessage } = createProvider();
    api.steerTurn.mockRejectedValueOnce(new Error("Turn turn-1 is stopping and cannot be steered"));

    await (provider as any).handleSteer("focus on tests");

    // The webview cleared the box when the text left it, so the failure has to
    // hand it back — the same recovery a refused send gets, and what the TUI
    // does with a steer the engine never took ("so nothing is lost").
    expect(postMessage).toHaveBeenCalledWith({ type: "setInputText", text: "focus on tests" });
    const types = postMessage.mock.calls.map((c: any[]) => (c[0] as any).type);
    expect(types).toContain("error");
  });

  it("empty streaming placeholder is removed, not finalized (TUI flush_active_cell discards empty cells)", async () => {
    const { provider, postMessage } = createProvider();
    const oldAssistant = provider.messages[provider.messages.length - 1];
    oldAssistant.content = "";
    oldAssistant.status = "streaming";

    await (provider as any).handleSteer("focus on tests");

    // The empty placeholder is popped from state and removed from the DOM;
    // a fresh streaming placeholder takes its place below the steer bubble.
    expect(provider.messages).not.toContain(oldAssistant);
    const calls = postMessage.mock.calls.map((c: any[]) => c[0] as any);
    expect(calls).toContainEqual({ type: "removeMessage", messageId: oldAssistant.id });
    expect(calls.find((c: any) => c.type === "messageComplete")).toBeUndefined();
    const newAssistant = provider.messages[provider.messages.length - 1];
    expect(newAssistant).not.toBe(oldAssistant);
    expect(newAssistant.status).toBe("streaming");
  });

  it("tool item.completed after a steer routes to the pre-steer segment (not messages[last])", async () => {
    const { provider, postMessage } = createProvider();
    const oldAssistant = provider.messages[provider.messages.length - 1];
    // Pre-steer tool: started on the original streaming message.
    oldAssistant.toolCalls = [{ name: "read_file", input: {}, status: "running", itemId: "tool-1" }];
    oldAssistant.blocks = [{ type: "tool_call", toolCallIdx: 0 }];
    (provider as any).activeItems.set("tool-1", {
      kind: "tool_call",
      msgId: oldAssistant.id,
      toolCallName: "read_file",
      toolCallIdx: 0,
      blockIdx: 0,
    });

    await (provider as any).handleSteer("focus on tests");

    // A second tool starts in the NEW post-steer segment (same index 0).
    const newAssistant = provider.messages[provider.messages.length - 1];
    newAssistant.toolCalls = [{ name: "bash", input: {}, status: "running", itemId: "tool-2" }];

    // The PRE-steer tool completes. It must land on the old segment's tool,
    // not on the new segment's bash call at the same index.
    (provider as any).handleRuntimeEvent({
      seq: 5,
      event: "item.completed",
      turn_id: "turn-1",
      item_id: "tool-1",
      payload: { item: { kind: "tool_call", detail: "file contents" } },
    } as any);

    expect(oldAssistant.toolCalls![0].status).toBe("complete");
    expect(oldAssistant.toolCalls![0].output).toBe("file contents");
    expect(newAssistant.toolCalls![0].status).toBe("running");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "updateToolCall", messageId: oldAssistant.id, toolCallIdx: 0 })
    );
  });

  it("turn.completed discards an empty post-steer placeholder instead of finalizing an empty bubble", async () => {
    const { provider, postMessage } = createProvider();

    await (provider as any).handleSteer("focus on tests");
    const placeholder = provider.messages[provider.messages.length - 1];
    expect(placeholder.content).toBe("");

    (provider as any).handleRuntimeEvent({
      seq: 6,
      event: "turn.completed",
      turn_id: "turn-1",
      payload: { turn: { id: "turn-1", status: "completed" } },
    } as any);

    expect(provider.messages).not.toContain(placeholder);
    const calls = postMessage.mock.calls.map((c: any[]) => c[0] as any);
    // messageComplete (the webview's streaming-end signal) precedes
    // removeMessage so the status bar does not stay stuck on streaming.
    const completeIdx = calls.findIndex((c: any) => c.type === "messageComplete" && c.messageId === placeholder.id);
    const removeIdx = calls.findIndex((c: any) => c.type === "removeMessage" && c.messageId === placeholder.id);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(completeIdx);
  });

  it("carries the composer's attachments on the steer prompt", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentAttachments = [
      { id: "att-1", kind: "image", path: "/tmp/shot.png", name: "shot.png" },
      { id: "att-2", kind: "file", path: "/tmp/notes.md", name: "notes.md" },
    ];

    await (provider as any).handleSteer("look at this");

    // The wire prompt is what the engine expands: the image line becomes a
    // real image block on the steer's own user message, the plain file rides
    // the @path mention a send would use. Without this the picture stayed in
    // the composer and the model was told nothing about it.
    expect(api.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      "look at this\n[Attached image: /tmp/shot.png]\n@/tmp/notes.md"
    );

    // The bubble carries the same text the engine stores on the turn, so it
    // reads the same live and after a reload — the shape a send uses.
    const bubble = postMessage.mock.calls
      .map((c: any[]) => c[0] as any)
      .find((c: any) => c.type === "addMessage" && c.message.steered);
    expect(bubble.message.content).toBe(
      "look at this\n[Attached image: /tmp/shot.png]\n@/tmp/notes.md"
    );

    // The composer lets go of them, exactly as a send does: an attachment left
    // behind would ride the next message a second time.
    expect((provider as any).currentAttachments).toEqual([]);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attachmentsChanged", attachments: [] })
    );
  });

  it("guides with an attachment alone, with nothing typed", async () => {
    const { provider, api, postMessage } = createProvider();
    (provider as any).currentAttachments = [
      { id: "att-1", kind: "image", path: "/tmp/shot.png", name: "shot.png" },
    ];

    await (provider as any).handleSteer("");

    expect(api.steerTurn).toHaveBeenCalledWith(
      "thread-1",
      "turn-1",
      "[Attached image: /tmp/shot.png]"
    );
    const bubble = postMessage.mock.calls
      .map((c: any[]) => c[0] as any)
      .find((c: any) => c.type === "addMessage" && c.message.steered);
    expect(bubble.message.content).toBe("[Attached image: /tmp/shot.png]");
  });

  it("a refused steer hands the attachments back with the text", async () => {
    const { provider, api, postMessage } = createProvider();
    const attachments = [
      {
        id: "att-1",
        kind: "image",
        path: "/tmp/shot.png",
        name: "shot.png",
        previewUrl: "data:image/png;base64,SHOT",
      },
    ];
    (provider as any).currentAttachments = [...attachments];
    api.steerTurn.mockRejectedValueOnce(new Error("turn is stopping"));

    await (provider as any).handleSteer("look at this");

    // Nothing is lost (TUI parity): the picture goes back to the composer
    // beside the restored text.
    expect(postMessage).toHaveBeenCalledWith({ type: "setInputText", text: "look at this" });
    expect((provider as any).currentAttachments).toMatchObject([{ id: "att-1" }]);

    const calls = postMessage.mock.calls.map((c: any[]) => c[0] as any);

    // And it is published back, not merely left in the host's own field: the
    // composer's chips are painted from this message, so a restore that never
    // posts would leave the picture invisible in a box that claims to hold it.
    // (Asserting the field alone cannot tell a restore from never having let
    // go — the failure this test exists for.)
    const lists = calls.filter((c: any) => c.type === "attachmentsChanged");
    expect(lists[0].attachments).toEqual([]);
    expect(lists[lists.length - 1].attachments).toMatchObject([{ id: "att-1" }]);

    // The thumbnail comes back too. The list never carries it (it would be
    // megabytes on every republish) and the webview pruned its cached copy the
    // moment the steer emptied the composer, so a restore that published the
    // list alone would bring back an icon where the picture had been.
    expect(calls).toContainEqual({
      type: "attachmentPreview",
      id: "att-1",
      previewUrl: "data:image/png;base64,SHOT",
    });
  });

  it("a refused steer keeps an attachment added while it was in flight", async () => {
    const { provider, api } = createProvider();
    (provider as any).currentAttachments = [
      { id: "att-1", kind: "image", path: "/tmp/shot.png", name: "shot.png" },
    ];
    // The composer stays live during the round trip: the user attaches
    // something else while the guidance is on its way.
    api.steerTurn.mockImplementationOnce(async () => {
      (provider as any).currentAttachments = [
        { id: "att-2", kind: "file", path: "/tmp/notes.md", name: "notes.md" },
      ];
      throw new Error("turn is stopping");
    });

    await (provider as any).handleSteer("look at this");

    // A restore that replaced the list would throw away what the user added
    // after the message left.
    expect((provider as any).currentAttachments).toMatchObject([
      { id: "att-1" },
      { id: "att-2" },
    ]);
  });

  it("an empty steer with no attachments is still dropped", async () => {
    const { provider, api } = createProvider();

    await (provider as any).handleSteer("   ");

    expect(api.steerTurn).not.toHaveBeenCalled();
  });
});
