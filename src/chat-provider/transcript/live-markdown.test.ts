/**
 * Markdown above a prompt that is waiting for the reader.
 *
 * Streamed text arrives as plain text and is only turned into HTML when the
 * turn ends. A turn that stops to ask a question — or to wait on an approval —
 * does not end, so the answer above the prompt used to sit there as markdown
 * source (`**bold**`, fenced code, tables) for as long as the reader took to
 * answer. These tests pin the flush: the blocks the turn has already finished
 * are rendered into the transcript before the prompt lands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

function createProvider() {
  const api = {
    bindEngine: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    decideApproval: vi.fn(async () => undefined),
    submitUserInput: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  provider.currentThread = { id: "thread-1", permission_posture: "ask" } as any;
  provider.messages = [
    { id: "u1", role: "user", content: "look at the repo", status: "complete", timestamp: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "Here is **bold** and `code`.",
      status: "streaming",
      timestamp: 2,
      blocks: [{ type: "text", content: "Here is **bold** and `code`." }],
    },
  ] as any;

  return { provider, postMessage: provider.postMessage as any };
}

function postedMessages(postMessage: any): Record<string, any>[] {
  return postMessage.mock.calls.map((call: unknown[]) => call[0] as Record<string, any>);
}

function questionEvent(inputId: string) {
  return {
    seq: 12,
    event: "user_input.required",
    turn_id: "turn-1",
    item_id: null,
    payload: {
      id: inputId,
      request: {
        questions: [
          { header: "Route", id: "q1", question: "Which route?", options: [{ label: "A", description: "" }] },
        ],
      },
    },
  } as any;
}

function approvalEvent(approvalId: string, callId: string) {
  return {
    seq: 13,
    event: "approval.required",
    turn_id: "turn-1",
    item_id: null,
    payload: {
      id: approvalId,
      request: { approval_id: approvalId, call_id: callId, tool_name: "shell" },
    },
  } as any;
}

function toolStartedEvent(itemId: string, callId: string, name = "shell") {
  return {
    seq: 14,
    event: "item.started",
    turn_id: "turn-1",
    item_id: itemId,
    payload: {
      item: { kind: "tool_call", id: itemId, summary: `${name} started` },
      tool: { id: callId, name, input: { command: "ls" } },
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the markdown a waiting prompt sits under", () => {
  it("is rendered before a question is drawn", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(questionEvent("input-1"));

    const posted = postedMessages(postMessage);
    const rendered = posted.find((message) => message.type === "renderBlocks");
    const asked = posted.find((message) => message.type === "userInputRequired");

    expect(rendered?.messageId).toBe("a1");
    expect(rendered?.blockHtmls).toHaveLength(1);
    expect(rendered?.blockHtmls[0].blockIdx).toBe(0);
    // Markdown, not the raw `**...**` the stream carried.
    expect(rendered?.blockHtmls[0].contentHtml).toContain("<strong>bold</strong>");
    expect(rendered?.blockHtmls[0].contentHtml).toContain("<code>code</code>");
    expect(asked).toBeTruthy();

    // The canvas has to be in that order: a bar drawn first would be a prompt
    // over raw markdown, which is the state this fix removes.
    const renderedAt = posted.findIndex((message) => message.type === "renderBlocks");
    const askedAt = posted.findIndex((message) => message.type === "userInputRequired");
    expect(renderedAt).toBeGreaterThanOrEqual(0);
    expect(renderedAt).toBeLessThan(askedAt);
  });

  it("is rendered before an approval card is drawn", () => {
    const { provider, postMessage } = createProvider();
    ((provider as any).messages[1] as any).toolCalls = [
      { name: "shell", input: { command: "ls" }, status: "running" },
    ];
    (provider as any).activeItems.set("call-1", {
      kind: "tool_call",
      msgId: "a1",
      toolCallIdx: 0,
    });

    (provider as any).handleRuntimeEvent(approvalEvent("approval-1", "call-1"));

    const posted = postedMessages(postMessage);
    const rendered = posted.find((message) => message.type === "renderBlocks");
    const approval = posted.find((message) => message.type === "approvalRequired");

    expect(rendered?.messageId).toBe("a1");
    expect(rendered?.blockHtmls[0].contentHtml).toContain("<strong>bold</strong>");
    expect(approval).toBeTruthy();
    const renderedAt = posted.findIndex((message) => message.type === "renderBlocks");
    const approvalAt = posted.findIndex((message) => message.type === "approvalRequired");
    expect(renderedAt).toBeGreaterThanOrEqual(0);
    expect(renderedAt).toBeLessThan(approvalAt);
  });

  it("is rendered as the next tool call starts", () => {
    const { provider, postMessage } = createProvider();

    // The model wrote a paragraph, then asked for a tool. The paragraph is
    // finished there, and its card lands under it: prose, not `**markdown**`.
    (provider as any).handleRuntimeEvent(toolStartedEvent("item-1", "call-1"));

    const posted = postedMessages(postMessage);
    const rendered = posted.find((message) => message.type === "renderBlocks");
    expect(rendered?.messageId).toBe("a1");
    expect(rendered?.blockHtmls[0].contentHtml).toContain("<strong>bold</strong>");

    // Drawn before the row it precedes on screen.
    const renderedAt = posted.findIndex((message) => message.type === "renderBlocks");
    const rowAt = posted.findIndex((message) => message.type === "addToolCall");
    expect(renderedAt).toBeGreaterThanOrEqual(0);
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(renderedAt).toBeLessThan(rowAt);
  });

  it("does not re-render a paragraph it has already drawn", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(toolStartedEvent("item-1", "call-1"));
    (provider as any).handleRuntimeEvent(toolStartedEvent("item-2", "call-2"));

    // The second call follows the same, unchanged paragraph: rendering it
    // again would be the same picture and a parse nobody sees.
    const renders = postedMessages(postMessage).filter((message) => message.type === "renderBlocks");
    expect(renders).toHaveLength(1);
  });

  it("renders a paragraph that grew after the last boundary", () => {
    const { provider, postMessage } = createProvider();

    (provider as any).handleRuntimeEvent(toolStartedEvent("item-1", "call-1"));
    // The model carried on in a new block after the tool, then called another.
    (provider as any).messages[1].blocks.push({ type: "text", content: "Then *this* happened." });
    (provider as any).handleRuntimeEvent(toolStartedEvent("item-2", "call-2"));

    const renders = postedMessages(postMessage).filter((message) => message.type === "renderBlocks");
    expect(renders).toHaveLength(2);
    // Only the new block is re-sent; the drawn one is left alone.
    expect(renders[1].blockHtmls).toHaveLength(1);
    expect(renders[1].blockHtmls[0].contentHtml).toContain("<em>this</em>");
  });

  it("says nothing when the turn has written only tool calls so far", () => {
    const { provider, postMessage } = createProvider();
    (provider as any).messages[1].blocks = [];

    (provider as any).handleRuntimeEvent(questionEvent("input-2"));

    const posted = postedMessages(postMessage);
    expect(posted.some((message) => message.type === "renderBlocks")).toBe(false);
    expect(posted.some((message) => message.type === "userInputRequired")).toBe(true);
  });
});
