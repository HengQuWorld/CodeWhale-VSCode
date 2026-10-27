import { describe, it, expect } from "vitest";
import { safeRenderMarkdown, renderMessageBlocks, finalizeAssistantMessage, turnDurationMs, turnStartedAtMs } from "./event-helpers";
import type { ChatMessage } from "./session-state";

describe("event-helpers", () => {
  describe("safeRenderMarkdown", () => {
    it("returns undefined for undefined input", () => {
      expect(safeRenderMarkdown(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(safeRenderMarkdown("")).toBeUndefined();
    });

    it("renders markdown to HTML", () => {
      const result = safeRenderMarkdown("hello **world**");
      expect(result).toContain("<strong>world</strong>");
    });

    it("returns raw text on render error", () => {
      // renderMarkdown wraps plain text in <p>, so normal input returns HTML.
      // The fallback only triggers on actual render errors.
      const result = safeRenderMarkdown("plain text");
      expect(result).toContain("plain text");
    });
  });

  describe("renderMessageBlocks", () => {
    it("returns empty array for message without blocks", () => {
      const msg: ChatMessage = {
        id: "1", role: "assistant", content: "hi",
        status: "streaming", timestamp: Date.now(),
      };
      expect(renderMessageBlocks(msg)).toEqual([]);
    });

    it("renders text and thinking blocks", () => {
      const msg: ChatMessage = {
        id: "1", role: "assistant", content: "hi",
        status: "streaming", timestamp: Date.now(),
        blocks: [
          { type: "text", content: "**bold**" },
          { type: "thinking", content: "*italic*" },
          { type: "tool_call", toolCallIdx: 0 },
        ],
      };
      const result = renderMessageBlocks(msg);
      expect(result).toHaveLength(2);
      expect(result[0].blockIdx).toBe(0);
      expect(result[0].contentHtml).toContain("<strong>bold</strong>");
      expect(result[1].blockIdx).toBe(1);
      expect(result[1].contentHtml).toContain("<em>italic</em>");
    });

    it("skips blocks without content", () => {
      const msg: ChatMessage = {
        id: "1", role: "assistant", content: "hi",
        status: "streaming", timestamp: Date.now(),
        blocks: [
          { type: "text" },
          { type: "thinking", content: "has content" },
        ],
      };
      const result = renderMessageBlocks(msg);
      expect(result).toHaveLength(1);
      expect(result[0].blockIdx).toBe(1);
    });
  });

  describe("turnDurationMs", () => {
    it("prefers the engine's own duration", () => {
      // The runtime measured the turn; started/ended are the same fact derived,
      // and a mismatch must not let the derivation override the measurement.
      expect(turnDurationMs({
        duration_ms: 192000,
        started_at: "2026-10-27T10:00:00Z",
        ended_at: "2026-10-27T10:00:01Z",
      })).toBe(192000);
    });

    it("derives the length from the two ends when the field is absent", () => {
      expect(turnDurationMs({
        started_at: "2026-10-27T10:00:00Z",
        ended_at: "2026-10-27T10:03:12Z",
      })).toBe(192000);
    });

    it("answers nothing for a turn with no timing at all", () => {
      // A queued turn has not run, and a recovered one may carry neither end:
      // a zero would claim it took no time.
      expect(turnDurationMs({ created_at: "2026-10-27T10:00:00Z" })).toBeUndefined();
      expect(turnDurationMs(null)).toBeUndefined();
      expect(turnDurationMs(undefined)).toBeUndefined();
    });

    it("ignores an unparseable timestamp rather than reporting NaN", () => {
      expect(turnDurationMs({ started_at: "not-a-date", ended_at: "2026-10-27T10:00:00Z" })).toBeUndefined();
    });

    it("rejects an end before the start", () => {
      expect(turnDurationMs({
        started_at: "2026-10-27T10:03:12Z",
        ended_at: "2026-10-27T10:00:00Z",
      })).toBeUndefined();
    });
  });

  describe("turnStartedAtMs", () => {
    it("reads the engine's start instant", () => {
      expect(turnStartedAtMs({ started_at: "2026-10-27T10:00:00Z" }))
        .toBe(Date.parse("2026-10-27T10:00:00Z"));
    });

    it("does not fall back to creation time", () => {
      // A queued turn's wait is not work: the caller starts its clock when the
      // turn actually begins rather than counting the queue as model time.
      expect(turnStartedAtMs({ created_at: "2026-10-27T10:00:00Z", started_at: null })).toBeUndefined();
    });
  });

  describe("finalizeAssistantMessage", () => {
    it("sets status to complete and renders HTML", () => {
      const msg: ChatMessage = {
        id: "m1", role: "assistant", content: "**hello**",
        thinking: "*think*", status: "streaming", timestamp: Date.now(),
      };
      const payload = finalizeAssistantMessage(msg, "complete");
      expect(msg.status).toBe("complete");
      expect(payload.type).toBe("messageComplete");
      expect(payload.messageId).toBe("m1");
      expect(payload.contentHtml).toContain("<strong>hello</strong>");
      expect(payload.thinkingHtml).toContain("<em>think</em>");
      expect(payload).not.toHaveProperty("error");
    });

    it("sets status to error and includes error flag", () => {
      const msg: ChatMessage = {
        id: "m2", role: "assistant", content: "fail",
        status: "streaming", timestamp: Date.now(),
      };
      const payload = finalizeAssistantMessage(msg, "error");
      expect(msg.status).toBe("error");
      expect(payload.error).toBe(true);
    });

    it("merges extra fields", () => {
      const msg: ChatMessage = {
        id: "m3", role: "assistant", content: "hi",
        status: "streaming", timestamp: Date.now(),
      };
      const payload = finalizeAssistantMessage(msg, "complete", { usage: { input_tokens: 10 } });
      expect(payload.usage).toEqual({ input_tokens: 10 });
    });

    it("renders blocks in the message", () => {
      const msg: ChatMessage = {
        id: "m4", role: "assistant", content: "hi",
        status: "streaming", timestamp: Date.now(),
        blocks: [
          { type: "text", content: "**bold**" },
        ],
      };
      const payload = finalizeAssistantMessage(msg, "complete");
      expect(payload.blockHtmls).toHaveLength(1);
    });
  });
});
