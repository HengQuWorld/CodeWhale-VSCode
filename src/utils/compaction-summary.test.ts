import { describe, expect, it } from "vitest";
import {
  extractCompactionSummary,
  isCompactionCheckpoint,
  compactionCheckpointBody,
  isCompactionCheckpointText,
  compactionCheckpointTextBody,
} from "./compaction-summary";

const BEGIN = "<!-- compaction-summary:begin -->";
const END = "<!-- compaction-summary:end -->";

describe("extractCompactionSummary", () => {
  it("reads the section the engine appends between its markers", () => {
    const prompt = `You are helpful.\n\n${BEGIN}\n${"Another language model started to solve this problem"}\nThe user asked for X.\n${END}`;

    expect(extractCompactionSummary(prompt)).toBe(
      "Another language model started to solve this problem\nThe user asked for X."
    );
  });

  it("keeps a later section that follows the summary", () => {
    // merge_summary_into_prompt replaces the section in place, so anything the
    // operator appended after it must not leak into the summary body.
    const prompt = `Base.\n\n${BEGIN}\nhandoff\n${END}\n\nTrailing rules.`;

    expect(extractCompactionSummary(prompt)).toBe("handoff");
  });

  it("returns null for a prompt with no summary", () => {
    expect(extractCompactionSummary("You are helpful.")).toBeNull();
  });

  it("returns null for a missing prompt", () => {
    expect(extractCompactionSummary(null)).toBeNull();
    expect(extractCompactionSummary(undefined)).toBeNull();
    expect(extractCompactionSummary("")).toBeNull();
  });

  it("returns null for an empty or truncated section", () => {
    // The engine's own reader refuses a begin with no end rather than showing
    // half a handoff; matching it keeps the two views of the same record
    // agreeing.
    expect(extractCompactionSummary(`${BEGIN}\n\n${END}`)).toBeNull();
    expect(extractCompactionSummary(`${BEGIN}\nhandoff without an end`)).toBeNull();
  });
});

describe("isCompactionCheckpoint", () => {
  const provenance = "<!-- codewhale.compaction-checkpoint.v1 -->";

  it("recognises the engine's checkpoint by both blocks", () => {
    expect(
      isCompactionCheckpoint(["Codewhale handoff note. Earlier turns…\n\n## Progress\n- x", provenance])
    ).toBe(true);
  });

  it("keeps a person's message that only quotes the opening phrase", () => {
    // The phrase is a sentence anyone may type; the provenance block is what
    // the engine writes and a person does not.
    expect(isCompactionCheckpoint(["Codewhale handoff note. Why is this here?"])).toBe(false);
    expect(
      isCompactionCheckpoint(["Codewhale handoff note. Why?", "and then some more text"])
    ).toBe(false);
    expect(isCompactionCheckpoint([provenance])).toBe(false);
    expect(isCompactionCheckpoint([])).toBe(false);
  });

  it("does not match a checkpoint that carries extra blocks", () => {
    expect(
      isCompactionCheckpoint(["Codewhale handoff note. x", provenance, "trailing"])
    ).toBe(false);
  });
});

describe("compactionCheckpointBody", () => {
  it("returns the handoff note without the provenance marker", () => {
    const body = compactionCheckpointBody([
      "Codewhale handoff note. Earlier turns…\n\n## Progress\n- built the timeline",
      "<!-- codewhale.compaction-checkpoint.v1 -->",
    ]);
    expect(body).toContain("built the timeline");
    expect(body).not.toContain("compaction-checkpoint.v1");
  });
});

describe("compactionCheckpointTextBody", () => {
  const marker = "<!-- codewhale.compaction-checkpoint.v1 -->";

  it("reads the note from the joined string a thread item stores", () => {
    const raw = `Codewhale handoff note. Earlier turns…\n\n## Progress\n- cut v2\n${marker}\n<turn_meta>\nCurrent local date: 2026-10-25\n</turn_meta>`;
    expect(isCompactionCheckpointText(raw)).toBe(true);
    const body = compactionCheckpointTextBody(raw);
    expect(body).toContain("cut v2");
    expect(body).not.toContain("compaction-checkpoint.v1");
    expect(body).not.toContain("<turn_meta>");
  });

  it("leaves a person's message that ends with the marker text alone", () => {
    const raw = `why does this show up?\n${marker}`;
    expect(isCompactionCheckpointText(raw)).toBe(false);
    expect(compactionCheckpointTextBody(raw)).toBeNull();
  });

  it("leaves a checkpoint whose note was rewritten alone", () => {
    expect(
      isCompactionCheckpointText(`some other text\n${marker}`)
    ).toBe(false);
  });
});
