/**
 * Read the compaction checkpoint out of a thread's standing system prompt.
 *
 * The engine appends the latest handoff summary to the thread record between
 * explicit markers (`runtime_threads.rs::merge_summary_into_prompt`), keeping
 * exactly one section — a second compaction replaces the first rather than
 * stacking. The same markers are what the engine's own
 * `compaction::extract_compaction_summary` reads, and what this client's
 * `/system` command already surfaces.
 *
 * Returns `null` when the prompt carries no summary — nothing compacted yet, or
 * a carrier this runtime no longer writes. That is a normal state, not an
 * error, and the caller renders the result line without a body.
 */
const SUMMARY_BEGIN = "<!-- compaction-summary:begin -->";
const SUMMARY_END = "<!-- compaction-summary:end -->";

export function extractCompactionSummary(
  systemPrompt: string | null | undefined
): string | null {
  if (!systemPrompt) return null;
  const begin = systemPrompt.indexOf(SUMMARY_BEGIN);
  if (begin < 0) return null;
  const afterBegin = systemPrompt.slice(begin + SUMMARY_BEGIN.length);
  const end = afterBegin.indexOf(SUMMARY_END);
  // A truncated carrier (begin with no end) is not a summary: the engine's own
  // reader refuses it too, rather than showing half a handoff.
  if (end < 0) return null;
  return afterBegin.slice(0, end).trim() || null;
}
