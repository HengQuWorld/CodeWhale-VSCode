import { describe, expect, it } from "vitest";
import { imageBytesMatchMime, sniffImageMime } from "./image-bytes";

const bytes = (...parts: Array<string | number[]>): Buffer => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...Buffer.from(part, "latin1"));
    else out.push(...part);
  }
  return Buffer.from(out);
};

describe("sniffImageMime", () => {
  it("reads a PNG signature", () => {
    expect(sniffImageMime(bytes("\x89PNG\r\n\x1a\n", "rest"))).toBe("image/png");
  });

  it("reads a JPEG start-of-image marker", () => {
    expect(sniffImageMime(bytes([0xff, 0xd8, 0xff], "rest"))).toBe("image/jpeg");
  });

  it.each(["GIF87a", "GIF89a"])("reads the %s GIF header", (header) => {
    expect(sniffImageMime(bytes(header, "rest"))).toBe("image/gif");
  });

  it("reads a WEBP RIFF container", () => {
    expect(sniffImageMime(bytes("RIFF", [0, 0, 0, 0], "WEBP", "rest"))).toBe("image/webp");
  });

  it("refuses a RIFF container that is not WEBP", () => {
    expect(sniffImageMime(bytes("RIFF", [0, 0, 0, 0], "WAVE", "rest"))).toBeNull();
  });

  it("refuses a truncated signature rather than guessing", () => {
    // A PNG needs all eight signature bytes; seven of them name no format.
    expect(sniffImageMime(bytes("\x89PNG\r\n\x1a"))).toBeNull();
    expect(sniffImageMime(bytes([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(bytes("GIF8"))).toBeNull();
    expect(sniffImageMime(bytes())).toBeNull();
  });

  it("refuses a format it does not accept, whatever the label said", () => {
    expect(sniffImageMime(bytes("BM", [0, 0, 0, 0]))).toBeNull();
    expect(sniffImageMime(bytes("not an image at all"))).toBeNull();
  });
});

describe("imageBytesMatchMime", () => {
  it("confirms a payload that really is the claimed format", () => {
    expect(imageBytesMatchMime(bytes("\x89PNG\r\n\x1a\n", "rest"), "image/png")).toBe(true);
  });

  it("rejects a payload labelled with a format it is not", () => {
    // The payload, not the extension or the sender's label, is what counts.
    expect(imageBytesMatchMime(bytes("\x89PNG\r\n\x1a\n", "rest"), "image/jpeg")).toBe(false);
    expect(imageBytesMatchMime(bytes("plain text"), "image/png")).toBe(false);
  });
});
