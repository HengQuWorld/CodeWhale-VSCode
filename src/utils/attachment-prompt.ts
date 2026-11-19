/**
 * The text an attachment becomes on the wire.
 *
 * The engine has no attachment blocks on the turn request: what a model sees
 * about an attached file is a line of the prompt naming it. A file is written
 * as `@/abs/path`, which is the mention the model knows to read; anything else
 * (an image, a screenshot) is written as `[Attached <kind>: /abs/path]`.
 *
 * One rule, in one place: the composer's send path, its steer path, a parked
 * memo dispatched later and a schedule that takes its content from a memo all
 * have to say the same thing, or the same picture arrives described two ways.
 */

/** The part of a stored attachment this rule reads. */
export interface PromptAttachment {
  kind: string;
  path: string;
}

/**
 * One line per attachment, in the order they were attached. Empty input is an
 * empty string rather than a blank line, so callers can append unconditionally.
 */
export function attachmentPromptLines(
  attachments: readonly PromptAttachment[]
): string {
  return attachments
    .filter((attachment) => !!attachment.path)
    .map((attachment) =>
      attachment.kind === "file"
        ? `@${attachment.path}`
        : `[Attached ${attachment.kind}: ${attachment.path}]`
    )
    .join("\n");
}

/**
 * A prompt with its attachments written below it. An attachment-only prompt is
 * those lines and nothing else — no leading newline for text that is not there.
 */
export function promptWithAttachments(
  text: string,
  attachments: readonly PromptAttachment[]
): string {
  const lines = attachmentPromptLines(attachments);
  if (!lines) return text;
  return text.trim() ? text.trimEnd() + "\n" + lines : lines;
}
