/**
 * Pure helper functions for runtime event processing.
 * These are stateless utilities extracted from ChatProvider's event handlers
 * to reduce code duplication and improve testability.
 */

import type { ChatMessage } from "./session-state";
import { renderMarkdown } from "./markdown";

/** Safely render markdown, falling back to raw text on error. */
export function safeRenderMarkdown(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try { return renderMarkdown(text); } catch { return text; }
}

/** Render all text/thinking blocks in a message and return the rendered indices. */
export function renderMessageBlocks(msg: ChatMessage): { blockIdx: number; contentHtml: string }[] {
  const blockHtmls: { blockIdx: number; contentHtml: string }[] = [];
  if (!msg.blocks) return blockHtmls;
  for (let i = 0; i < msg.blocks.length; i++) {
    const b = msg.blocks[i];
    if ((b.type === "text" || b.type === "thinking") && b.content) {
      b.contentHtml = safeRenderMarkdown(b.content);
      blockHtmls.push({ blockIdx: i, contentHtml: b.contentHtml! });
    }
  }
  return blockHtmls;
}

/** The timing half of a runtime turn record — the fields these helpers read,
 *  so a caller can hand over a full `TurnRecord` or a bare stub. */
export interface TurnTimingLike {
  created_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
}

/** An engine timestamp as epoch ms, or undefined when it is absent or
 *  unparseable — never NaN, which would silently poison every arithmetic
 *  below it. */
export function turnInstantMs(value?: string | null): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** How long a finished turn took, in ms.
 *
 *  The engine's own `duration_ms` is the answer when it is there: it is what
 *  the runtime measured, and it survives a client that adopted the turn late.
 *  A record older than the field still carries the two ends of the turn, so
 *  the difference is the same fact derived rather than invented. Undefined
 *  means the record cannot say — a queued turn, or one the runtime recovered
 *  without timing it — and callers draw nothing rather than a zero. */
export function turnDurationMs(turn?: TurnTimingLike | null): number | undefined {
  if (!turn) return undefined;
  if (typeof turn.duration_ms === "number" && Number.isFinite(turn.duration_ms) && turn.duration_ms >= 0) {
    return turn.duration_ms;
  }
  const started = turnInstantMs(turn.started_at);
  const ended = turnInstantMs(turn.ended_at);
  if (started !== undefined && ended !== undefined && ended >= started) return ended - started;
  return undefined;
}

/** When a turn started running, in ms — the anchor for the live clock.
 *
 *  Deliberately not `created_at`: a queued turn has not begun working, and
 *  counting its wait as turn time would describe the queue as the model's
 *  work. Undefined leaves the caller to start the clock when it heard the turn
 *  begin. */
export function turnStartedAtMs(turn?: TurnTimingLike | null): number | undefined {
  return turnInstantMs(turn?.started_at);
}

/** Finalize an assistant message: render HTML and build the messageComplete payload. */
export function finalizeAssistantMessage(
  msg: ChatMessage,
  status: "complete" | "error",
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  msg.status = status;
  const contentHtml = safeRenderMarkdown(msg.content);
  const thinkingHtml = safeRenderMarkdown(msg.thinking);
  const blockHtmls = renderMessageBlocks(msg);

  return {
    type: "messageComplete",
    messageId: msg.id,
    ...(status === "error" ? { error: true } : {}),
    contentHtml,
    thinkingHtml,
    blockHtmls,
    ...extra,
  };
}
