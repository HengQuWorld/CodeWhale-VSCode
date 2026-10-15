/**
 * Image format detection for attachments.
 *
 * The provider validates the payload, not the file extension or the label the
 * sender chose, mirroring the TUI's `image_attach.rs` `sniff_media_type`.
 * Extracted from `chat-provider.ts` for independent testing and reuse.
 */

/**
 * Identify an image's format from its magic bytes. Returns null for anything
 * outside the four accepted formats.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  const head = (len: number) => bytes.subarray(0, len).toString("latin1");
  if (bytes.length >= 8 && head(8) === "\x89PNG\r\n\x1a\n") {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const gif = head(6);
    if (gif === "GIF87a" || gif === "GIF89a") {
      return "image/gif";
    }
  }
  if (bytes.length >= 12 && head(4) === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Whether a payload's bytes are the format it is labelled with. */
export function imageBytesMatchMime(bytes: Buffer, mime: string): boolean {
  return sniffImageMime(bytes) === mime;
}
