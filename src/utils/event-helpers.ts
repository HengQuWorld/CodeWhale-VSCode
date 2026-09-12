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
