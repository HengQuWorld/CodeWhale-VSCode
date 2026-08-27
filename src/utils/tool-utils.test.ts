import { describe, expect, it } from "vitest";
import { detectFileChange } from "./tool-utils";
import {
  extractDiffForTool,
  extractMutationFromMetadata,
  formatWriteInputAsDiff,
  parseDiffStats,
} from "./diff-utils";

const UPDATED_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old line",
  "+new line",
].join("\n");

function mutationMetadata(overrides?: {
  diff?: string;
  files?: Array<{ path: string; outcome?: string }>;
  renames?: Array<{ from: string; to: string }>;
  event?: string;
}) {
  return {
    event: overrides?.event ?? "file.mutation",
    mutation: {
      diff: overrides?.diff ?? UPDATED_DIFF,
      files: overrides?.files ?? [{ path: "src/app.ts", outcome: "updated" }],
      renames: overrides?.renames ?? [],
    },
  };
}

describe("extractMutationFromMetadata", () => {
  it("extracts the mutation payload from file.mutation metadata", () => {
    const mutation = extractMutationFromMetadata(mutationMetadata());
    expect(mutation).toBeDefined();
    expect(mutation?.diff).toBe(UPDATED_DIFF);
    expect(mutation?.files).toEqual([{ path: "src/app.ts", outcome: "updated" }]);
    expect(mutation?.renames).toEqual([]);
  });

  it("accepts apply_patch.preflight events", () => {
    const mutation = extractMutationFromMetadata(
      mutationMetadata({ event: "apply_patch.preflight", files: [{ path: "a.txt", outcome: "created" }] }),
    );
    expect(mutation?.files[0]?.outcome).toBe("created");
  });

  it("returns undefined for unrelated or missing metadata", () => {
    expect(extractMutationFromMetadata(undefined)).toBeUndefined();
    expect(extractMutationFromMetadata({ event: "tool.started" })).toBeUndefined();
    expect(extractMutationFromMetadata({ event: "file.mutation", mutation: {} })).toBeUndefined();
  });
});

describe("detectFileChange", () => {
  it("builds a card from metadata.mutation regardless of tool name", () => {
    // New TUI contract tool `write`: the output has no diff — the diff and
    // outcome only exist in the mutation metadata.
    const fc = detectFileChange({
      toolName: "write",
      input: { path: "src/app.ts", content: "new" },
      output: "Successfully wrote 3 bytes to src/app.ts",
      metadata: mutationMetadata(),
    });
    expect(fc).toMatchObject({
      filePath: "src/app.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      toolName: "write",
    });
    expect(fc?.diff).toBe(UPDATED_DIFF);
  });

  it("covers the unified File action tool via mutation metadata only", () => {
    // `File` is not in FILE_CHANGE_TOOLS — only the metadata signal finds it.
    const fc = detectFileChange({
      toolName: "File",
      input: { action: "write", path: "docs/x.md", content: "# x" },
      output: "Successfully wrote 3 bytes to docs/x.md",
      metadata: mutationMetadata({ files: [{ path: "docs/x.md", outcome: "created" }] }),
    });
    expect(fc?.filePath).toBe("docs/x.md");
    expect(fc?.changeType).toBe("created");
  });

  it("maps created/deleted outcomes and prefers them over name heuristics", () => {
    expect(
      detectFileChange({
        toolName: "write",
        input: {},
        metadata: mutationMetadata({ files: [{ path: "a.ts", outcome: "deleted" }] }),
      })?.changeType,
    ).toBe("deleted");
  });

  it("resolves the rename destination as the card path", () => {
    const fc = detectFileChange({
      toolName: "apply_patch",
      input: {},
      metadata: mutationMetadata({
        files: [],
        renames: [{ from: "old_name.rs", to: "new_name.rs" }],
      }),
    });
    expect(fc?.filePath).toBe("new_name.rs");
  });

  it("falls back to the legacy output-embedded diff for write_file", () => {
    const fc = detectFileChange({
      toolName: "write_file",
      input: { path: "src/app.ts" },
      output: `Wrote 10 bytes to src/app.ts\n${UPDATED_DIFF}`,
    });
    expect(fc?.diff).toBe(UPDATED_DIFF);
    expect(fc?.changeType).toBe("modified");
    expect(fc?.addedLines).toBe(1);
  });

  it("synthesizes a creation diff for write inputs without an output diff", () => {
    const fc = detectFileChange({
      toolName: "write",
      input: { path: "src/new.ts", content: "hello\nworld" },
      output: "Successfully wrote 12 bytes to src/new.ts",
    });
    expect(fc?.diff).toContain("--- /dev/null");
    expect(fc?.diff).toContain("+hello");
    expect(fc?.addedLines).toBe(2);
    expect(fc?.changeType).toBe("created");
  });

  it("counts edit stats from the edits array when no diff is available", () => {
    const fc = detectFileChange({
      toolName: "edit",
      input: { path: "src/app.ts", edits: [{ oldText: "a\nb", newText: "x\ny\nz" }] },
      output: "Successfully replaced 1 block(s) in src/app.ts.",
    });
    expect(fc?.diff).toBeUndefined();
    expect(fc?.addedLines).toBe(3);
    expect(fc?.removedLines).toBe(2);
    expect(fc?.changeType).toBe("modified");
  });

  it("returns undefined for non-file tools without mutation metadata", () => {
    expect(
      detectFileChange({ toolName: "read", input: { path: "a.txt" }, output: "contents" }),
    ).toBeUndefined();
  });

  it("honors the legacy flat change_type metadata on file_change items", () => {
    const fc = detectFileChange({
      toolName: "edit_file",
      input: { file_path: "src/app.ts" },
      output: "",
      metadata: { file_path: "src/app.ts", change_type: "deleted" },
    });
    expect(fc?.changeType).toBe("deleted");
  });
});

describe("apply_patch input aliases", () => {
  it("reads the replace array like the deprecated changes alias", () => {
    const fromReplace = extractDiffForTool(
      "apply_patch",
      { replace: [{ path: "a.txt", content: "hi" }] },
      "applied",
    );
    const fromChanges = extractDiffForTool(
      "apply_patch",
      { changes: [{ path: "a.txt", content: "hi" }] },
      "applied",
    );
    expect(fromReplace).toBe(fromChanges);
    expect(fromReplace).toContain("a.txt");
  });
});

describe("parseDiffStats", () => {
  it("counts removed and added lines in a replacement diff", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("counts a pure deletion without any added lines", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,3 @@",
      " a",
      "-b",
      " c",
      " d",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual({ added: 0, removed: 1 });
  });

  it("does not miscount code lines starting with -- or ++ as file headers", () => {
    const diff = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "---i",
      "++i",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("counts a synthesized /dev/null creation diff as added only", () => {
    const diff = [
      "diff --git a/y.ts b/y.ts",
      "--- /dev/null",
      "+++ b/y.ts",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");
    expect(parseDiffStats(diff)).toEqual({ added: 1, removed: 0 });
  });
});

describe("formatWriteInputAsDiff", () => {
  it("renders a creation-style diff with the full content", () => {
    const diff = formatWriteInputAsDiff("src/new.ts", "a\nb\nc\n");
    expect(diff).toBe(
      [
        "diff --git a/src/new.ts b/src/new.ts",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,3 @@",
        "+a",
        "+b",
        "+c",
        "",
      ].join("\n"),
    );
  });
});
