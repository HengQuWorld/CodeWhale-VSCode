/**
 * Property checks for the diff helpers the Changes panel leans on.
 *
 * Three invariants matter here, and none of them is obvious from reading the
 * code once:
 *
 *  - A hunk that carries context lines must still rebuild the pre-edit file
 *    exactly. The panel's Diff action reconstructs a change's before/after by
 *    reading hunks back, so a writer that mislabels one line silently shows a
 *    file that never existed.
 *  - The line-level comparison must emit, for each side, exactly the lines that
 *    side had — no line invented, none dropped — since both the counts and the
 *    reconstruction are read off it.
 *  - `parseDiffStats` must keep meaning what it has always meant. It is what
 *    every count in the panel comes from, and the header test it uses is subtle
 *    enough (a removed line beginning with `--` is `---i` on a diff line) that a
 *    later "cleanup" could quietly change the numbers.
 *
 * The inputs are generated from a seeded PRNG, so a failure is reproducible.
 */
import { describe, expect, it } from "vitest";
import {
  diffLineRuns,
  formatRecordedEditsAsDiff,
  parseDiffStats,
  reconstructOldContent,
  reverseApplyRecordedEdits,
  toDiffLines,
} from "./diff-utils";

/** Deterministic PRNG — the same corpus on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** The reading `parseDiffStats` had before the header test was factored out.
 *  Kept here as the definition the current one has to agree with. */
function historicParseDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed };
}

describe("diff helpers, by property", () => {
  it("gives each side back its own lines exactly, and never runs two kinds together", () => {
    const random = seededRandom(20261015);
    const vocabulary = ["a", "b", "c", "", "  ", "---x", "+++y", "@@", "\ttab"];
    const pick = (): string[] => {
      const length = Math.floor(random() * 7);
      const lines: string[] = [];
      for (let i = 0; i < length; i++) {
        lines.push(vocabulary[Math.floor(random() * vocabulary.length)]);
      }
      return lines;
    };

    for (let trial = 0; trial < 4000; trial++) {
      const oldLines = pick();
      // Sometimes the two sides are the same: the pure "no change" shape.
      const newLines = random() < 0.4 ? oldLines.slice() : pick();
      const runs = diffLineRuns(oldLines, newLines);

      // Reading a side means taking everything that side has plus every shared
      // line — in the order they appear.
      expect(runs.filter((run) => run.kind !== "insert").flatMap((run) => run.lines)).toEqual(oldLines);
      expect(runs.filter((run) => run.kind !== "delete").flatMap((run) => run.lines)).toEqual(newLines);

      for (let i = 0; i < runs.length; i++) {
        expect(runs[i].lines.length).toBeGreaterThan(0);
        if (i > 0) expect(runs[i].kind).not.toBe(runs[i - 1].kind);
      }
    }
  });

  it("returns the pre-edit content a diff was built from, for many random edits", () => {
    const random = seededRandom(987654321);
    let checked = 0;

    for (let trial = 0; trial < 600; trial++) {
      // Distinct lines, so a replacement can be located unambiguously.
      const base: string[] = [];
      for (let i = 0; i < 8; i++) base.push(`line${i}`);

      const start = Math.floor(random() * base.length);
      const length = 1 + Math.floor(random() * Math.min(3, base.length - start));
      const oldBlock = base.slice(start, start + length);
      // The new block sometimes keeps some of the quoted lines: the case the
      // context-line writing exists for.
      const newBlock = oldBlock.map((line) => (random() < 0.5 ? `${line}!` : line));
      if (random() < 0.35) newBlock.push(`inserted${trial}`);
      if (oldBlock.join("\n") === newBlock.join("\n")) continue;

      const before = base.join("\n") + "\n";
      const after = base
        .slice(0, start)
        .concat(newBlock, base.slice(start + length))
        .join("\n") + "\n";
      const edits = [{ oldText: oldBlock.join("\n"), newText: newBlock.join("\n") }];

      const diff = formatRecordedEditsAsDiff("f.ts", after, edits);
      if (!diff) continue;

      // Two independent readings of the same edit must agree: walking the
      // recorded input back, and reading the hunk out of the diff.
      expect(reverseApplyRecordedEdits(after, edits)).toBe(before);
      expect(reconstructOldContent(after, diff)).toBe(before);
      // And what the reader is shown adds up: the patch is not empty.
      expect(parseDiffStats(diff).added + parseDiffStats(diff).removed).toBeGreaterThan(0);
      checked++;
    }

    expect(checked).toBeGreaterThan(100);
  });

  it("counts diff lines the way the previous implementation did", () => {
    const lines = [
      "+added", "-removed", "+++ b/f", "--- a/f", "+++", "---", "++x", "--x",
      "--- /dev/null", "+++ /dev/null", "diff --git a/f b/f", "index 1234..5678",
      " context", "", "@@ -1 +1 @@", "\\ No newline at end of file",
      "-", "+", "- ", "+ ", "diff", "index", "+diff x", "-index y", "+--- a/f",
      "---- x", "++++ y",
    ];
    const diffs: string[] = [...lines];
    for (const first of lines) {
      for (const second of lines) diffs.push(`${first}\n${second}`);
    }
    // A header directly above content, which is where the two readings could
    // differ: the header must not swallow the line under it.
    for (const header of ["--- a/f", "+++ b/f", "diff --git a/f b/f", "index 1..2"]) {
      for (const first of lines) {
        for (const second of lines) diffs.push(`${header}\n${first}\n${second}`);
      }
    }

    for (const diff of diffs) {
      expect(parseDiffStats(diff)).toEqual(historicParseDiffStats(diff));
    }
  });

  it("reads a file's own trailing newline the same way in every caller", () => {
    // The writers and the counters both go through `toDiffLines`, so a hunk
    // cannot mean one thing to the writer and another to the reader.
    const random = seededRandom(13579);
    for (let trial = 0; trial < 500; trial++) {
      const count = Math.floor(random() * 5);
      const pieces: string[] = [];
      for (let i = 0; i < count; i++) pieces.push(`p${Math.floor(random() * 3)}`);
      const text = pieces.join("\n") + (random() < 0.5 ? "\n" : "");
      const lines = toDiffLines(text);
      // Re-joining the lines and closing the file reproduces a file whose
      // content is the text itself, with no phantom line.
      const content = lines.length === 0 ? "" : lines.join("\n") + "\n";
      expect(content).toBe(text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`);
    }
  });
});
