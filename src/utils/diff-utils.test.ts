import { describe, it, expect } from "vitest";
import {
  parseDiffStats,
  extractDiffFromOutput,
  extractFilePathFromDiff,
  parseDiffToSides,
  shortPath,
  truncate,
  stripTurnMeta,
  isInternalRuntimeHandoff,
  reconstructOldContent,
  reconstructOriginalContent,
  getDiffStateForIndex,
  mergeFileChanges,
  extractRecordedEdits,
  reverseApplyRecordedEdits,
  formatRecordedEditsAsDiff,
} from "./diff-utils";

describe("parseDiffStats", () => {
  it("counts added and removed lines", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
-removed
+added1
+added2
 context`;
    const stats = parseDiffStats(diff);
    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(1);
  });

  it("returns zeros for empty diff", () => {
    const stats = parseDiffStats("");
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });

  it("ignores file header lines", () => {
    const diff = `--- a/file.ts
+++ b/file.ts`;
    const stats = parseDiffStats(diff);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });
});

describe("extractDiffFromOutput", () => {
  it("extracts git diff from mixed output", () => {
    const output = `Some preamble text
diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;
    const diff = extractDiffFromOutput(output);
    expect(diff).toBeDefined();
    expect(diff!.startsWith("diff --git")).toBe(true);
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  it("extracts unified diff starting with ---", () => {
    const output = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new`;
    const diff = extractDiffFromOutput(output);
    expect(diff).toBeDefined();
  });

  it("extracts diff starting with hunk header", () => {
    const output = `@@ -1 +1 @@
-old
+new`;
    const diff = extractDiffFromOutput(output);
    expect(diff).toBeDefined();
  });

  it("returns undefined when no diff markers found", () => {
    const output = "Just some regular text\nNo diff here";
    expect(extractDiffFromOutput(output)).toBeUndefined();
  });

  it("stops at prose after diff content", () => {
    const output = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new

This is a summary paragraph that should not be included.`;
    const diff = extractDiffFromOutput(output);
    expect(diff).toBeDefined();
    expect(diff).not.toContain("summary paragraph");
  });
});

describe("extractFilePathFromDiff", () => {
  it("extracts file path from +++ line", () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1 +1 @@
-old
+new`;
    expect(extractFilePathFromDiff(diff)).toBe("src/main.ts");
  });

  it("falls back to --- line when +++ is missing", () => {
    const diff = `--- a/src/main.ts
@@ -1 +1 @@
-old`;
    expect(extractFilePathFromDiff(diff)).toBe("src/main.ts");
  });

  it("returns empty string when no path found", () => {
    const diff = `@@ -1 +1 @@
-old
+new`;
    expect(extractFilePathFromDiff(diff)).toBe("");
  });
});

describe("parseDiffToSides", () => {
  it("separates old and new content from a diff", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;
    const result = parseDiffToSides(diff);
    expect(result.oldContent).toContain("old line");
    expect(result.oldContent).toContain("line1");
    expect(result.oldContent).toContain("line3");
    expect(result.newContent).toContain("new line");
    expect(result.newContent).toContain("line1");
    expect(result.newContent).toContain("line3");
  });

  it("returns empty strings for empty diff", () => {
    const result = parseDiffToSides("");
    expect(result.oldContent).toBe("");
    expect(result.newContent).toBe("");
  });

  it("handles diff with only additions", () => {
    const diff = `@@ -0,0 +1,2 @@
+line1
+line2`;
    const result = parseDiffToSides(diff);
    expect(result.newContent).toContain("line1");
    expect(result.newContent).toContain("line2");
  });

  it("handles diff with only deletions", () => {
    const diff = `@@ -1,2 +0,0 @@
-line1
-line2`;
    const result = parseDiffToSides(diff);
    expect(result.oldContent).toContain("line1");
    expect(result.oldContent).toContain("line2");
  });

  it("skips no-newline-at-end marker", () => {
    const diff = `@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`;
    const result = parseDiffToSides(diff);
    expect(result.oldContent).toContain("old");
    expect(result.newContent).toContain("new");
    expect(result.oldContent).not.toContain("No newline");
    expect(result.newContent).not.toContain("No newline");
  });
});

describe("shortPath", () => {
  it("returns short paths unchanged", () => {
    expect(shortPath("src/main.ts")).toBe("src/main.ts");
  });

  it("abbreviates long paths", () => {
    // /very/long/path/to/src/main.ts → 6 parts → last 3 = to/src/main.ts
    expect(shortPath("/very/long/path/to/src/main.ts")).toBe("…to/src/main.ts");
  });

  it("handles Windows-style paths", () => {
    // C:\Users\dev\project\src\main.ts → after replace → C:/Users/dev/project/src/main.ts → 6 parts → last 3
    expect(shortPath("C:\\Users\\dev\\project\\src\\main.ts")).toBe("…project/src/main.ts");
  });

  it("handles exactly 3 parts", () => {
    expect(shortPath("a/b/c")).toBe("a/b/c");
  });

  it("handles 4 parts", () => {
    // a/b/c/d → 4 parts > 3 → last 3 = b/c/d
    expect(shortPath("a/b/c/d")).toBe("…b/c/d");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("handles exact length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("stripTurnMeta", () => {
  it("strips turn_meta tags from the beginning", () => {
    const text = "<turn_meta>some metadata</turn_meta>Actual content here";
    expect(stripTurnMeta(text)).toBe("Actual content here");
  });

  it("returns text unchanged when no turn_meta", () => {
    const text = "Just regular content";
    expect(stripTurnMeta(text)).toBe("Just regular content");
  });

  it("handles leading whitespace before turn_meta", () => {
    const text = "  <turn_meta>meta</turn_meta>Content";
    expect(stripTurnMeta(text)).toBe("Content");
  });

  it("does not strip turn_meta from the middle", () => {
    const text = "Content <turn_meta>meta</turn_meta> more content";
    expect(stripTurnMeta(text)).toBe("Content <turn_meta>meta</turn_meta> more content");
  });

  it("handles unclosed turn_meta tag", () => {
    const text = "<turn_meta>unclosed content";
    expect(stripTurnMeta(text)).toBe("<turn_meta>unclosed content");
  });
});

describe("isInternalRuntimeHandoff", () => {
  const runtimeMeta =
    "<turn_meta>\nInput provenance: runtime (non-authoritative)\n</turn_meta>";

  it("detects the Operate contract runtime message", () => {
    const blocks = [
      '<codewhale:runtime_event kind="operate_contract" visibility="internal">…</codewhale:runtime_event>',
      runtimeMeta,
    ];
    expect(isInternalRuntimeHandoff(blocks)).toBe(true);
  });

  it("detects sub-agent and shell completion handoffs", () => {
    expect(
      isInternalRuntimeHandoff([
        "…",
        "<turn_meta>\nInput provenance: subagent_handoff (non-authoritative)\n</turn_meta>",
      ])
    ).toBe(true);
    expect(
      isInternalRuntimeHandoff([
        "…",
        "<turn_meta>\nInput provenance: shell_completion (non-authoritative)\n</turn_meta>",
      ])
    ).toBe(true);
  });

  it("never hides a real external user turn", () => {
    expect(
      isInternalRuntimeHandoff([
        "hello",
        "<turn_meta>\nInput provenance: external_user\nInput authority: external_current_turn\n</turn_meta>",
      ])
    ).toBe(false);
    expect(isInternalRuntimeHandoff(["<codewhale:runtime_event>", "quoted by a person"])).toBe(
      false
    );
    expect(isInternalRuntimeHandoff([])).toBe(false);
    // A user turn that merely quotes the provenance line without a
    // runtime-owned envelope must not be hidden.
    expect(isInternalRuntimeHandoff(["look at this:", runtimeMeta])).toBe(false);
    expect(
      isInternalRuntimeHandoff([
        "quoted by a person",
        "<turn_meta>\nInput provenance: assistant_generated (non-authoritative)\n</turn_meta>",
      ])
    ).toBe(false);
  });

  it("still hides the agent-topology runtime checkpoint", () => {
    expect(
      isInternalRuntimeHandoff([
        '<codewhale:runtime_state kind="agent_topology" schema="v1" visibility="internal">…</codewhale:runtime_state>',
        runtimeMeta,
      ])
    ).toBe(true);
  });
});

describe("mergeFileChanges", () => {
  it("handles single file change", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 10,
        removedLines: 5,
        diff: "diff content",
        toolName: "edit_file",
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result).toEqual({
      filePath: "src/file.ts",
      changeType: "modified",
      addedLines: 10,
      removedLines: 5,
      diff: "diff content",
      toolName: "edit_file",
    });
  });

  it("sums addedLines and removedLines for multiple changes", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 10,
        removedLines: 5,
        diff: "first diff",
        toolName: "edit_file",
      },
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 8,
        removedLines: 3,
        diff: "second diff",
        toolName: "edit_file",
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result.addedLines).toBe(18);
    expect(result.removedLines).toBe(8);
  });

  it("prioritizes created over deleted and modified", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 5,
        removedLines: 2,
      },
      {
        filePath: "src/file.ts",
        changeType: "deleted" as const,
        addedLines: 0,
        removedLines: 10,
      },
      {
        filePath: "src/file.ts",
        changeType: "created" as const,
        addedLines: 20,
        removedLines: 0,
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result.changeType).toBe("created");
  });

  it("prioritizes deleted over modified", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 5,
        removedLines: 2,
      },
      {
        filePath: "src/file.ts",
        changeType: "deleted" as const,
        addedLines: 0,
        removedLines: 10,
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result.changeType).toBe("deleted");
  });

  it("keeps the latest diff and toolName", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 5,
        removedLines: 2,
        diff: "first diff",
        toolName: "write_file",
      },
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 8,
        removedLines: 3,
        diff: "second diff",
        toolName: "edit_file",
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result.diff).toBe("second diff");
    expect(result.toolName).toBe("edit_file");
  });

  it("handles undefined diff and toolName gracefully", () => {
    const changes = [
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 5,
        removedLines: 2,
      },
      {
        filePath: "src/file.ts",
        changeType: "modified" as const,
        addedLines: 8,
        removedLines: 3,
        diff: "has diff",
        toolName: "edit_file",
      },
    ];
    const result = mergeFileChanges(changes);
    expect(result.diff).toBe("has diff");
    expect(result.toolName).toBe("edit_file");
  });
});

describe("reconstructOldContent", () => {
  it("reconstructs old content from simple diff", () => {
    const currentContent = "line1\nnew line\nline3";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\nold line\nline3");
  });

  it("handles multiple hunks", () => {
    const currentContent = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2_modified
 line3
@@ -8,3 +8,3 @@
 line8
-line9
+line9_modified
 line10`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");
  });

  it("handles additions", () => {
    // Diff adds a line between line1 and line2
    // New side: line1, added_line, line2
    const currentContent = "line1\nadded_line\nline2";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 line1
+added_line
 line2`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\nline2");
  });

  it("handles deletions", () => {
    // Diff removes deleted_line between line1 and line2
    // New side: line1, line2
    const currentContent = "line1\nline2";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,2 @@
 line1
-deleted_line
 line2`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\ndeleted_line\nline2");
  });

  it("preserves lines outside hunk range", () => {
    // File has 5 lines, hunk only modifies lines 2-3
    const currentContent = "line1\nmodified\nline3\nline4\nline5";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -2,2 +2,2 @@
-original
+modified
 line3`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\noriginal\nline3\nline4\nline5");
  });

  it("handles new file diff (old side is empty)", () => {
    // New file with 3 lines
    const currentContent = "line1\nline2\nline3";
    const diff = `diff --git a/newfile.ts b/newfile.ts
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("");
  });

  it("handles deleted file diff (new side is empty)", () => {
    // File was deleted entirely
    const currentContent = "";
    const diff = `diff --git a/oldfile.ts b/oldfile.ts
--- a/oldfile.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\nline2\nline3");
  });

  it("handles diff with no newline at end of file marker", () => {
    const currentContent = "line1\nnew line";
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 line1
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file`;
    const result = reconstructOldContent(currentContent, diff);
    expect(result).toBe("line1\nold line");
  });
});

describe("reconstructOriginalContent", () => {
  it("returns current content when diffs array is empty", () => {
    const current = "line1\nline2\nline3";
    expect(reconstructOriginalContent([], current)).toBe(current);
  });

  it("reconstructs original from a single diff (equivalent to reconstructOldContent)", () => {
    // Original: line1, old, line3 → after diff: line1, new, line3
    const currentContent = "line1\nnew\nline3";
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3`;
    expect(reconstructOriginalContent([diff], currentContent)).toBe("line1\nold\nline3");
  });

  it("reconstructs original by reverse-applying two sequential diffs", () => {
    // State A (original): a, b, c
    // diff1: change b→x  → State B: a, x, c
    // diff2: add line d  → State C (current): a, x, c, d
    // Reconstructing should give: a, b, c
    const currentContent = "a\nx\nc\nd";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 a
-b
+x
 c`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 a
 x
 c
+d`;
    const result = reconstructOriginalContent([diff1, diff2], currentContent);
    expect(result).toBe("a\nb\nc");
  });

  it("reconstructs original by reverse-applying three sequential diffs", () => {
    // State A: 1, 2, 3
    // diff1: add 0 at top   → B: 0, 1, 2, 3
    // diff2: change 2→two   → C: 0, 1, two, 3
    // diff3: remove 1       → D (current): 0, two, 3
    // Reconstruct should give: 1, 2, 3
    const currentContent = "0\ntwo\n3";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
+0
 1
 2
 3`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,4 +1,4 @@
 0
 1
-2
+two
 3`;
    const diff3 = `--- a/f
+++ b/f
@@ -1,4 +1,3 @@
 0
-1
 two
 3`;
    const result = reconstructOriginalContent([diff1, diff2, diff3], currentContent);
    expect(result).toBe("1\n2\n3");
  });
});

describe("getDiffStateForIndex", () => {
  it("returns null for out-of-range index", () => {
    const diffs = [`--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+b`];
    expect(getDiffStateForIndex(diffs, "a\nb", -1)).toBeNull();
    expect(getDiffStateForIndex(diffs, "a\nb", 1)).toBeNull();
    expect(getDiffStateForIndex([], "a", 0)).toBeNull();
  });

  it("single diff (index 0): returns oldContent and newContent as full files", () => {
    // Original: line1, old, line3 → diff changes old→new → Current: line1, new, line3
    const currentContent = "line1\nnew\nline3";
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3`;
    const result = getDiffStateForIndex([diff], currentContent, 0);
    expect(result).not.toBeNull();
    expect(result!.oldContent).toBe("line1\nold\nline3");
    expect(result!.newContent).toBe("line1\nnew\nline3");
    // Verify both are full files, not just hunk lines
    expect(result!.oldContent.split("\n").length).toBe(3);
    expect(result!.newContent.split("\n").length).toBe(3);
  });

  it("last of two diffs: same as reconstructOldContent on current file", () => {
    // D1: change b→x  → State B: a, x, c
    // D2: add d      → State C (current): a, x, c, d
    const currentContent = "a\nx\nc\nd";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 a
-b
+x
 c`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 a
 x
 c
+d`;
    const result = getDiffStateForIndex([diff1, diff2], currentContent, 1);
    expect(result).not.toBeNull();
    // oldContent should be state after D1 only: a, x, c
    expect(result!.oldContent).toBe("a\nx\nc");
    // newContent should be current: a, x, c, d
    expect(result!.newContent).toBe("a\nx\nc\nd");
    // Verify full file: oldContent has 3 lines, newContent has 4 lines
    expect(result!.oldContent.split("\n").length).toBe(3);
    expect(result!.newContent.split("\n").length).toBe(4);
  });

  it("first of two diffs: reverse-applies later diff to get intermediate state", () => {
    // D1: change b→x  → State B: a, x, c
    // D2: add d      → State C (current): a, x, c, d
    const currentContent = "a\nx\nc\nd";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 a
-b
+x
 c`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 a
 x
 c
+d`;
    const result = getDiffStateForIndex([diff1, diff2], currentContent, 0);
    expect(result).not.toBeNull();
    // oldContent should be original: a, b, c
    expect(result!.oldContent).toBe("a\nb\nc");
    // newContent should be state after D1: a, x, c
    expect(result!.newContent).toBe("a\nx\nc");
    // Verify full files
    expect(result!.oldContent.split("\n").length).toBe(3);
    expect(result!.newContent.split("\n").length).toBe(3);
  });

  it("middle of three diffs: correct intermediate state reconstruction", () => {
    // D1: add 0 at top  → B: 0, 1, 2, 3
    // D2: change 2→two  → C: 0, 1, two, 3
    // D3: remove 1      → D (current): 0, two, 3
    const currentContent = "0\ntwo\n3";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
+0
 1
 2
 3`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,4 +1,4 @@
 0
 1
-2
+two
 3`;
    const diff3 = `--- a/f
+++ b/f
@@ -1,4 +1,3 @@
 0
-1
 two
 3`;
    // diffIndex=1 means we want D2:
    // oldContent = state after D1: 0, 1, 2, 3
    // newContent = state after D2: 0, 1, two, 3
    const result = getDiffStateForIndex([diff1, diff2, diff3], currentContent, 1);
    expect(result).not.toBeNull();
    expect(result!.oldContent).toBe("0\n1\n2\n3");
    expect(result!.newContent).toBe("0\n1\ntwo\n3");
    expect(result!.oldContent.split("\n").length).toBe(4);
    expect(result!.newContent.split("\n").length).toBe(4);
  });

  it("first of three diffs: full reconstruction from current", () => {
    // Same as above
    const currentContent = "0\ntwo\n3";
    const diff1 = `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
+0
 1
 2
 3`;
    const diff2 = `--- a/f
+++ b/f
@@ -1,4 +1,4 @@
 0
 1
-2
+two
 3`;
    const diff3 = `--- a/f
+++ b/f
@@ -1,4 +1,3 @@
 0
-1
 two
 3`;
    // diffIndex=0: D1 adds 0 at top of [1,2,3]
    const result = getDiffStateForIndex([diff1, diff2, diff3], currentContent, 0);
    expect(result).not.toBeNull();
    expect(result!.oldContent).toBe("1\n2\n3");
    expect(result!.newContent).toBe("0\n1\n2\n3");
  });

  it("result oldContent and newContent are full files for a large file with small diff", () => {
    // Simulate a 100-line file where line 50 was changed
    const originalLines: string[] = [];
    for (let i = 1; i <= 100; i++) originalLines.push(`line ${i}`);
    const modifiedLines = [...originalLines];
    modifiedLines[49] = "modified line 50"; // line 50 changed
    const currentContent = modifiedLines.join("\n");
    const diff = `--- a/large.ts
+++ b/large.ts
@@ -48,3 +48,3 @@
 line 48
 line 49
-line 50
+modified line 50
 line 51`;
    const result = getDiffStateForIndex([diff], currentContent, 0);
    expect(result).not.toBeNull();
    // Both should have approximately 100 lines (full file, not just hunk)
    const oldLines = result!.oldContent.split("\n").length;
    const newLines = result!.newContent.split("\n").length;
    expect(oldLines).toBeGreaterThanOrEqual(99);
    expect(oldLines).toBeLessThanOrEqual(101);
    expect(newLines).toBeGreaterThanOrEqual(99);
    expect(newLines).toBeLessThanOrEqual(101);
    // oldContent should NOT have the modification
    expect(result!.oldContent).toContain("line 50");
    expect(result!.oldContent).not.toContain("modified line 50");
    // newContent should have the modification
    expect(result!.newContent).toContain("modified line 50");
    // newContent should NOT have the original line 50 as a standalone line
    expect(result!.newContent).not.toMatch(/^line 50$/m);
  });
});

describe("extractRecordedEdits", () => {
  it("reads the contract edit form used by the runtime `edit` tool", () => {
    expect(
      extractRecordedEdits({ path: "a.ts", edits: [{ oldText: "one", newText: "two" }] }),
    ).toEqual([{ oldText: "one", newText: "two" }]);
  });

  it("reads the single search/replace form and its aliases", () => {
    expect(extractRecordedEdits({ path: "a.ts", search: "one", replace: "two" })).toEqual([
      { oldText: "one", newText: "two" },
    ]);
    expect(extractRecordedEdits({ old_string: "one", new_string: "two" })).toEqual([
      { oldText: "one", newText: "two" },
    ]);
  });

  it("returns nothing for inputs that record no exact-text edit", () => {
    expect(extractRecordedEdits({ file_path: "a.ts", content: "whole file" })).toEqual([]);
    expect(extractRecordedEdits({ edits: [{ oldText: "same", newText: "same" }] })).toEqual([]);
    expect(extractRecordedEdits(undefined)).toEqual([]);
  });
});

describe("reverseApplyRecordedEdits", () => {
  it("puts the replaced text back", () => {
    expect(
      reverseApplyRecordedEdits("a\nB\nc\n", [{ oldText: "b", newText: "B" }]),
    ).toBe("a\nb\nc\n");
  });

  it("refuses deletion-style edits whose insertion point is unknowable", () => {
    expect(reverseApplyRecordedEdits("ac\n", [{ oldText: "b", newText: "" }])).toBeNull();
  });

  it("returns null when the replacement text is no longer present", () => {
    expect(reverseApplyRecordedEdits("a\nB\nc\n", [{ oldText: "x", newText: "y" }])).toBeNull();
  });
});

describe("formatRecordedEditsAsDiff", () => {
  // `after` is the file as it looked once the call finished; the diffs are
  // addressed in it precisely because the recorded input only knows the file
  // after the edit.
  const after = ["one", "TWO", "THREE", "four", "five"].join("\n") + "\n";
  const before = ["one", "two", "three", "four", "five"].join("\n") + "\n";

  it("emits a hunk that reconstructs the pre-edit content exactly", () => {
    const edits = [{ oldText: "two\nthree", newText: "TWO\nTHREE" }];
    const diff = formatRecordedEditsAsDiff("src/app.ts", after, edits);
    expect(diff).toBeTruthy();
    expect(diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(reverseApplyRecordedEdits(after, edits)).toBe(before);
    expect(reconstructOldContent(after, diff!)).toBe(before);
    expect(parseDiffStats(diff!)).toEqual({ added: 2, removed: 2 });
  });

  it("handles an edit inside a line and several edits in one call", () => {
    const edited = ["1", "two", "three", "5"].join("\n") + "\n";
    const edits = [
      { oldText: "one", newText: "1" },
      { oldText: "four\nfive", newText: "5" },
    ];
    const diff = formatRecordedEditsAsDiff("src/app.ts", edited, edits);
    expect(diff).toBeTruthy();
    expect(diff!.match(/^@@ /gm)).toHaveLength(2);
    expect(reconstructOldContent(edited, diff!)).toBe(reverseApplyRecordedEdits(edited, edits));
    expect(reconstructOldContent(edited, diff!)).toBe("one\ntwo\nthree\nfour\nfive\n");
  });

  it("refuses to guess when the replacement is ambiguous or absent", () => {
    expect(formatRecordedEditsAsDiff("a.ts", "x\nx\n", [{ oldText: "y", newText: "x" }])).toBeNull();
    expect(formatRecordedEditsAsDiff("a.ts", after, [{ oldText: "y", newText: "zzz" }])).toBeNull();
    expect(formatRecordedEditsAsDiff("a.ts", "ac\n", [{ oldText: "b", newText: "" }])).toBeNull();
    expect(formatRecordedEditsAsDiff("a.ts", after, [])).toBeNull();
  });
});
