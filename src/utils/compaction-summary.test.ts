import { describe, expect, it } from "vitest";
import { extractCompactionSummary } from "./compaction-summary";

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
