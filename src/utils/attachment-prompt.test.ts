import { describe, it, expect } from "vitest";

import { attachmentPromptLines, promptWithAttachments } from "./attachment-prompt";

describe("attachment prompt lines", () => {
  it("writes a file as the mention the model reads it by", () => {
    expect(attachmentPromptLines([{ kind: "file", path: "/w/src/a.ts" }])).toBe(
      "@/w/src/a.ts",
    );
  });

  it("writes anything else as an attachment line naming its path", () => {
    expect(attachmentPromptLines([{ kind: "image", path: "/w/shot.png" }])).toBe(
      "[Attached image: /w/shot.png]",
    );
  });

  it("keeps the order they were attached in, one line each", () => {
    expect(
      attachmentPromptLines([
        { kind: "file", path: "/w/a.ts" },
        { kind: "image", path: "/w/b.png" },
      ]),
    ).toBe("@/w/a.ts\n[Attached image: /w/b.png]");
  });

  it("says nothing when there is nothing attached", () => {
    // An empty string, not a blank line: every caller appends this to a prompt
    // and a stray newline would show up in the transcript.
    expect(attachmentPromptLines([])).toBe("");
  });

  it("skips a record with no path rather than writing an empty mention", () => {
    expect(attachmentPromptLines([{ kind: "file", path: "" }])).toBe("");
  });
});

describe("prompt with attachments", () => {
  it("appends the lines under the text, trimmed at the seam", () => {
    expect(
      promptWithAttachments("look at this  \n", [{ kind: "image", path: "/w/s.png" }]),
    ).toBe("look at this\n[Attached image: /w/s.png]");
  });

  it("is the attachment lines alone when the text is empty", () => {
    expect(promptWithAttachments("   ", [{ kind: "file", path: "/w/a.ts" }])).toBe(
      "@/w/a.ts",
    );
  });

  it("leaves a prompt with no attachments exactly as it was", () => {
    // Not trimmed: the caller's text is the caller's business.
    expect(promptWithAttachments("keep  my  spacing", [])).toBe("keep  my  spacing");
  });
});
