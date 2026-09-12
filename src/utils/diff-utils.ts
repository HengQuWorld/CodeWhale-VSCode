/**
 * Diff parsing and utility functions.
 *
 * Extracted from chat-provider.ts for independent testing and reuse.
 */

export function parseDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    // File headers are `--- a/...` / `+++ b/...` (git) and `--- /dev/null`
    // (our synthesized creation diffs) — always `--- ` / `+++ ` WITH a
    // trailing space. Matching without the space would miscount code lines
    // whose content begins with `--` / `++` (e.g. `--i`, `++count`).
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed };
}

/**
 * Format `apply_patch` `changes` array into a unified-diff string.
 * Mirrors the TUI's `format_changes_preview` in tool_routing.rs.
 */
export function formatChangesAsDiff(changes: Array<{ path: string; content: string }>): string {
  let out = "";
  for (const change of changes) {
    const path = change.path || "<file>";
    const content = change.content || "";
    out += `diff --git a/${path} b/${path}\n`;
    out += `--- a/${path}\n+++ b/${path}\n`;
    out += "@@ -0,0 +1,1 @@\n";
    let count = 0;
    for (const line of content.split("\n")) {
      out += "+" + line + "\n";
      count++;
      if (count >= 20) {
        out += "+... (truncated)\n";
        break;
      }
    }
    if (content === "") {
      out += "+\n";
    }
  }
  return out;
}

/**
 * Extract a unified diff for a tool call, handling tools where the diff
 * lives in the input rather than the output (e.g. `apply_patch`).
 *
 * @param toolName  - Name of the tool that produced the change
 * @param input     - Tool input parameters (may contain `patch` or `changes`)
 * @param output    - Tool result text
 * @returns Unified diff string, or undefined if none could be extracted
 */
export function extractDiffForTool(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: string,
): string | undefined {
  // Standard path: diff is in the tool output (edit_file, write_file, etc.)
  const diff = extractDiffFromOutput(output);
  if (diff) return diff;

  // apply_patch: diff lives in the input, not the output
  if (toolName === "apply_patch" && input) {
    // `patch` parameter — a raw unified diff string
    const patch = input.patch;
    if (typeof patch === "string" && patch.trim()) {
      return patch;
    }
    // `replace` (current) / `changes` (deprecated alias) — arrays of
    // { path, content } objects
    const changes = input.replace ?? input.changes;
    if (Array.isArray(changes) && changes.length > 0) {
      return formatChangesAsDiff(changes as Array<{ path: string; content: string }>);
    }
  }

  return undefined;
}

// ── TUI mutation metadata (authoritative file-change signal) ──

export interface MutationFileEntry {
  path: string;
  outcome?: string;
}

export interface MutationRenameEntry {
  from: string;
  to: string;
}

export interface ToolMutationInfo {
  diff?: string;
  files: MutationFileEntry[];
  renames: MutationRenameEntry[];
}

/**
 * Extracts the authoritative file-mutation payload from tool-result metadata.
 *
 * Every current TUI file tool tags its successful result with
 * `event: "file.mutation"` (write / edit / write_file / edit_file / File
 * actions) or `event: "apply_patch.preflight"` (apply_patch) and attaches
 * `mutation: { diff, files: [{ path, outcome }], renames: [{ from, to }] }`.
 * The `diff` there is the authoritative unified diff for the change.
 */
export function extractMutationFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ToolMutationInfo | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const event = metadata.event;
  if (event !== "file.mutation" && event !== "apply_patch.preflight") return undefined;
  const raw = metadata.mutation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const mutation = raw as Record<string, unknown>;
  const diff = typeof mutation.diff === "string" && mutation.diff.trim() ? mutation.diff : undefined;
  const files: MutationFileEntry[] = Array.isArray(mutation.files)
    ? mutation.files.filter(
        (f): f is MutationFileEntry =>
          !!f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string",
      )
    : [];
  const renames: MutationRenameEntry[] = Array.isArray(mutation.renames)
    ? mutation.renames.filter(
        (r): r is MutationRenameEntry =>
          !!r && typeof r === "object" &&
          typeof (r as Record<string, unknown>).from === "string" &&
          typeof (r as Record<string, unknown>).to === "string",
      )
    : [];
  if (!diff && files.length === 0 && renames.length === 0) return undefined;
  return { diff, files, renames };
}

/**
 * Maps a TUI mutation outcome ("created" | "updated" | "deleted") to the
 * card change type. Also accepts the legacy `change_type` spellings.
 */
export function outcomeToChangeType(outcome: string | undefined): "created" | "modified" | "deleted" | undefined {
  if (outcome === "created") return "created";
  if (outcome === "deleted") return "deleted";
  if (outcome === "updated" || outcome === "modified") return "modified";
  return undefined;
}

// ── Recorded exact-text edits (replayed sessions) ──

/** One exact-text replacement as recorded in a tool input. */
export interface RecordedEdit {
  oldText: string;
  newText: string;
}

const OLD_TEXT_KEYS = ["oldText", "old_text", "old_string", "old_str", "search"];
const NEW_TEXT_KEYS = ["newText", "new_text", "new_string", "new_str", "replace"];

function firstString(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Extracts the exact-text replacements recorded in an edit-style tool input:
 * the `edits: [{ oldText, newText }]` form used by the runtime's contract
 * `edit` tool, and the single `search`/`replace` form used by `edit_file`.
 *
 * Returns an empty array when the input is not an exact-text edit, so callers
 * can distinguish "no recorded edits" from "an edit we failed to read".
 */
export function extractRecordedEdits(
  input: Record<string, unknown> | null | undefined,
): RecordedEdit[] {
  if (!input || typeof input !== "object") return [];
  const pick = (entry: Record<string, unknown>): RecordedEdit | undefined => {
    const oldText = firstString(entry, OLD_TEXT_KEYS);
    const newText = firstString(entry, NEW_TEXT_KEYS);
    if (oldText === undefined || newText === undefined || oldText === newText) return undefined;
    return { oldText, newText };
  };

  if (Array.isArray(input.edits)) {
    const edits: RecordedEdit[] = [];
    for (const raw of input.edits) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const edit = pick(raw as Record<string, unknown>);
      if (!edit) return [];
      edits.push(edit);
    }
    return edits;
  }

  const single = pick(input);
  return single ? [single] : [];
}

/**
 * Undoes one tool call's recorded replacements: puts `oldText` back where
 * `newText` now sits.
 *
 * Returns null when a replacement text is not present, which means the file
 * no longer matches what that call recorded (later edits, or the file changed
 * outside the session). Callers must not guess in that case.
 */
export function reverseApplyRecordedEdits(
  content: string,
  edits: RecordedEdit[],
): string | null {
  let result = content;
  for (const edit of edits) {
    if (edit.newText === "") return null;
    const idx = result.indexOf(edit.newText);
    if (idx < 0) return null;
    result = result.slice(0, idx) + edit.oldText + result.slice(idx + edit.newText.length);
  }
  return result;
}

/**
 * Builds a unified diff for one recorded tool call from the replacement
 * regions in its input, addressed in `afterContent` (the file as it looked
 * when the call finished).
 *
 * Hunks carry the real line numbers of `afterContent`, so
 * `reconstructOldContent` recovers the pre-call content exactly. No context
 * lines are synthesized: the recorded input does not know them, and a wrong
 * diff is worse than no diff. Returns null when a replacement cannot be
 * located, appears more than once, or overlaps another replacement.
 */
export function formatRecordedEditsAsDiff(
  filePath: string,
  afterContent: string,
  edits: RecordedEdit[],
): string | null {
  if (edits.length === 0) return null;

  const lineStarts: number[] = [0];
  for (let i = 0; i < afterContent.length; i++) {
    if (afterContent[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (charIndex: number): number => {
    let line = 0;
    for (let i = 0; i < lineStarts.length && lineStarts[i] <= charIndex; i++) line += 1;
    return Math.max(0, line - 1);
  };
  const splitBlock = (text: string): string[] => {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const hunks: Array<{ startLine: number; oldLines: string[]; newLines: string[] }> = [];
  for (const edit of edits) {
    if (!edit.newText) return null;
    const idx = afterContent.indexOf(edit.newText);
    if (idx < 0) return null;
    if (afterContent.indexOf(edit.newText, idx + 1) >= 0) return null;

    const startLine = lineOf(idx);
    const endLine = lineOf(idx + edit.newText.length - 1);
    const blockStart = lineStarts[startLine];
    const blockEnd = endLine + 1 < lineStarts.length ? lineStarts[endLine + 1] : afterContent.length;

    const newBlock = afterContent.slice(blockStart, blockEnd);
    const oldBlock =
      afterContent.slice(blockStart, idx) + edit.oldText + afterContent.slice(idx + edit.newText.length, blockEnd);
    if (oldBlock === newBlock) continue;

    for (const hunk of hunks) {
      if (startLine <= hunk.startLine + hunk.newLines.length - 1 && hunk.startLine <= endLine) return null;
    }
    hunks.push({ startLine, oldLines: splitBlock(oldBlock), newLines: splitBlock(newBlock) });
  }
  if (hunks.length === 0) return null;

  hunks.sort((a, b) => a.startLine - b.startLine);
  let out = `diff --git a/${filePath} b/${filePath}\n`;
  out += `--- a/${filePath}\n+++ b/${filePath}\n`;
  for (const hunk of hunks) {
    out += `@@ -${hunk.startLine + 1},${hunk.oldLines.length} +${hunk.startLine + 1},${hunk.newLines.length} @@\n`;
    for (const line of hunk.oldLines) out += `-${line}\n`;
    for (const line of hunk.newLines) out += `+${line}\n`;
  }
  return out;
}

/**
 * Synthesizes a creation-style unified diff from a `write`-style tool input
 * (`{ path, content }`). Used only when no authoritative diff is available,
 * e.g. replaying saved sessions whose tool results do not embed a diff.
 */
export function formatWriteInputAsDiff(filePath: string, content: string): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  let out = `diff --git a/${filePath} b/${filePath}\n`;
  out += `--- /dev/null\n+++ b/${filePath}\n`;
  out += `@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) {
    out += `+${line}\n`;
  }
  return out;
}

export function extractDiffFromOutput(output: string): string | undefined {
  const lines = output.split("\n");
  let diffStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) { diffStart = i; break; }
    if (line.startsWith("--- ") && i + 2 < lines.length && lines[i + 1].startsWith("+++ ")) { diffStart = i; break; }
    if (line.startsWith("@@")) { diffStart = i; break; }
  }
  if (diffStart < 0) return undefined;

  let diffEnd = lines.length;
  for (let i = diffStart + 1; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
    if (
      line.trim() === "" &&
      nextLine.trim() !== "" &&
      !nextLine.startsWith("+") &&
      !nextLine.startsWith("-") &&
      !nextLine.startsWith("@@") &&
      !nextLine.startsWith(" ") &&
      !nextLine.startsWith("diff ") &&
      !nextLine.startsWith("--- ") &&
      !nextLine.startsWith("+++ ") &&
      !nextLine.startsWith("index ") &&
      !nextLine.startsWith("\\")
    ) {
      diffEnd = i + 1;
      break;
    }
  }
  return lines.slice(diffStart, diffEnd).join("\n");
}

export function extractFilePathFromDiff(diff: string): string {
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) return m[1];
  }
  for (const line of diff.split("\n")) {
    const m = line.match(/^--- a\/(.+)$/);
    if (m) return m[1];
  }
  return "";
}

export function parseDiffToSides(diff: string): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (hunkRegex.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line.startsWith("\\")) {
      continue;
    } else {
      oldLines.push(line);
      newLines.push(line);
    }
  }

  if (oldLines.length === 0 && newLines.length === 0) {
    return { oldContent: "", newContent: "" };
  }
  return { oldContent: oldLines.join("\n"), newContent: newLines.join("\n") };
}

export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…" + parts.slice(-3).join("/") : p;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function stripTurnMeta(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<turn_meta>")) {
    const closePos = trimmed.indexOf("</turn_meta>");
    if (closePos !== -1) {
      return trimmed.slice(closePos + "</turn_meta>".length).trimStart();
    }
  }
  return trimmed;
}

/**
 * True when a user-role message is a runtime-owned handoff rather than real
 * user input, so it must not be rendered as a user bubble.
 *
 * Mirrors the TUI's `runtime_handoff::is_internal_runtime_handoff`: the
 * trailing `<turn_meta>` block is engine-owned, and recognition stays
 * structural so a person quoting the envelope cannot hide their own turn.
 *
 * Two families match:
 *   - sub-agent / shell handoffs, whose provenance line is authoritative;
 *   - `runtime` provenance, but *only* when the payload is one of the
 *     runtime-owned envelopes (Operate contract, agent-topology checkpoint),
 *     which is exactly what the TUI recognizes structurally.
 */
export function isInternalRuntimeHandoff(blocks: string[]): boolean {
  if (blocks.length === 0) return false;
  const last = (blocks[blocks.length - 1] || "").trim();
  if (!last.startsWith("<turn_meta>")) return false;
  if (/Input provenance:\s*(subagent_handoff|shell_completion)\b/i.test(last)) return true;
  const first = (blocks[0] || "").trim();
  return (
    /Input provenance:\s*runtime\b/i.test(last) &&
    /^<codewhale:(runtime_event kind="operate_contract"|runtime_state kind="agent_topology")/.test(
      first
    )
  );
}

/**
 * Merges multiple FileChangeInfo entries for the same file into a single summary.
 * - Sums addedLines and removedLines for cumulative stats
 * - Prioritizes changeType: created > deleted > modified
 * - Keeps the latest diff and toolName
 */
export function mergeFileChanges(changes: Array<{
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  addedLines: number;
  removedLines: number;
  diff?: string;
  toolName?: string;
}>): {
  filePath: string;
  changeType: "created" | "modified" | "deleted";
  addedLines: number;
  removedLines: number;
  diff?: string;
  toolName?: string;
} {
  if (changes.length === 0) {
    throw new Error("Cannot merge empty file changes array");
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  let mergedChangeType: "created" | "modified" | "deleted" = "modified";
  let latestDiff: string | undefined;
  let latestToolName: string | undefined;

  for (const change of changes) {
    totalAdded += change.addedLines;
    totalRemoved += change.removedLines;

    // Priority: created > deleted > modified
    if (change.changeType === "created") {
      mergedChangeType = "created";
    } else if (change.changeType === "deleted" && mergedChangeType !== "created") {
      mergedChangeType = "deleted";
    }

    // Keep the latest diff and toolName
    if (change.diff) latestDiff = change.diff;
    if (change.toolName) latestToolName = change.toolName;
  }

  return {
    filePath: changes[0].filePath,
    changeType: mergedChangeType,
    addedLines: totalAdded,
    removedLines: totalRemoved,
    diff: latestDiff,
    toolName: latestToolName,
  };
}

/**
 * Reconstructs the old file content by reverse-applying a unified diff to the current file.
 * This ensures line numbers in the diff view match the actual file.
 *
 * @param currentContent - The current file content (new side)
 * @param diff - The unified diff string
 * @returns The reconstructed old content, or null if reconstruction fails
 */
export function reconstructOldContent(currentContent: string, diff: string): string | null {
  const currentLines = currentContent === "" ? [] : currentContent.split("\n");
  const result = [...currentLines];
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  // Parse all hunks from the diff
  const hunks: Array<{
    newStart: number;
    newCount: number;
    /** Lines in the hunk: each entry is [type, content] where type is ' '/'+ '/'-' */
    lines: Array<{ type: string; content: string }>;
  }> = [];

  let currentHunk: typeof hunks[0] | null = null;
  for (const line of diff.split("\n")) {
    const match = line.match(hunkRegex);
    if (match) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        newStart: parseInt(match[3], 10),
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
        lines: [],
      };
    } else if (currentHunk) {
      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
        continue;
      }
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "+", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "-", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: " ", content: line.slice(1) });
      }
      // Skip "\\" lines (no newline at end of file) and other non-content lines
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  // Apply hunks in reverse order (from bottom to top) to preserve line numbers
  hunks.sort((a, b) => b.newStart - a.newStart);

  for (const hunk of hunks) {
    // In the new file, this hunk occupies lines [newStart-1, newStart-1 + newCount)
    const newStartIdx = hunk.newStart - 1;

    // Build the old version of this hunk: context lines + removed lines (in order)
    const oldHunkLines: string[] = [];
    for (const h of hunk.lines) {
      if (h.type === " " || h.type === "-") {
        oldHunkLines.push(h.content);
      }
      // Skip "+" lines — they don't exist in the old version
    }

    // Replace the new-side lines with old-side lines
    result.splice(newStartIdx, hunk.newCount, ...oldHunkLines);
  }

  return result.join("\n");
}

/**
 * Reconstructs the original file content (before any modifications) by
 * reverse-applying multiple diffs in reverse chronological order.
 *
 * Given diffs [d1, d2, d3] that transform A→B→C→D, and currentContent=D,
 * this reverse-applies d3 (D→C), then d2 (C→B), then d1 (B→A) to recover A.
 *
 * @param diffs - Array of unified diff strings in chronological order
 * @param currentContent - The current file content
 * @returns The original content before all modifications, or null if any reconstruction fails
 */
export function reconstructOriginalContent(diffs: string[], currentContent: string): string | null {
  let content = currentContent;
  // Reverse-apply diffs in reverse chronological order (last diff first)
  for (let i = diffs.length - 1; i >= 0; i--) {
    const reconstructed = reconstructOldContent(content, diffs[i]);
    if (reconstructed === null) return null;
    content = reconstructed;
  }
  return content;
}

/**
 * Reconstructs the old and new content for a specific diff within a series.
 *
 * Given diffs [d1, d2, d3] that transform A→B→C→D, and currentContent=D:
 * - diffIndex=0 (d1): reverse-applies d3,d2 to get B (state after d1),
 *   then d1 to get A → returns { oldContent: A, newContent: B }
 * - diffIndex=2 (d3): returns { oldContent: C, newContent: D }
 *
 * Both oldContent and newContent are FULL file content with correct line numbers.
 *
 * @param diffs - Array of unified diff strings in chronological order
 * @param currentContent - The current file content (after ALL diffs applied)
 * @param diffIndex - Which diff in the array to reconstruct state for
 * @returns Old and new content for that diff, or null if reconstruction fails
 */
export function getDiffStateForIndex(
  diffs: string[],
  currentContent: string,
  diffIndex: number
): { oldContent: string; newContent: string } | null {
  if (diffIndex < 0 || diffIndex >= diffs.length) return null;

  // Reverse-apply diffs from end down to just after diffIndex
  // to reach the state right AFTER diff[diffIndex] was applied
  let stateAfter = currentContent;
  for (let i = diffs.length - 1; i > diffIndex; i--) {
    const reconstructed = reconstructOldContent(stateAfter, diffs[i]);
    if (reconstructed === null) return null;
    stateAfter = reconstructed;
  }

  // Reverse-apply diff[diffIndex] to reach the state BEFORE it
  const stateBefore = reconstructOldContent(stateAfter, diffs[diffIndex]);
  if (stateBefore === null) return null;

  return { oldContent: stateBefore, newContent: stateAfter };
}
