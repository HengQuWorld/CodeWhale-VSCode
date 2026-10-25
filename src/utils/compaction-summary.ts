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

/**
 * The engine's compaction checkpoint, recognised on the wire.
 *
 * A compaction replaces the turns it summarized with one handoff note, and the
 * note is persisted as a *user-role* message because strict chat templates
 * accept no other role mid-conversation. Its position is historical — the
 * engine restores it at the boundary it was written at (`compaction::
 * restore_compaction_checkpoint`) — so a saved session reads as a run of
 * retained user prompts, then this note, then the current round.
 *
 * Recognition is structural and mirrors the engine's own
 * `compaction::is_wire_compaction_checkpoint_message`: the note's opening
 * phrase in the first block and the provenance marker as the second block. A
 * person quoting the phrase stays a user turn, because both parts must agree.
 */
const COMPACTION_CHECKPOINT_PROVENANCE = "<!-- codewhale.compaction-checkpoint.v1 -->";
const COMPACTION_HANDOFF_MARKER = "Codewhale handoff note";

/** True when a user-role message's text blocks are the engine's checkpoint. */
export function isCompactionCheckpoint(blockTexts: string[]): boolean {
  if (blockTexts.length !== 2) return false;
  const [note, provenance] = blockTexts;
  return (
    note.trimStart().startsWith(COMPACTION_HANDOFF_MARKER) &&
    provenance.trim() === COMPACTION_CHECKPOINT_PROVENANCE
  );
}

/**
 * The note body a checkpoint carries, with the provenance marker removed.
 *
 * This is the handoff summary — everything the engine condensed, in its own
 * words — so the view keeps it whole and collapsed rather than dropping the one
 * record of the turns it replaced.
 */
export function compactionCheckpointBody(blockTexts: string[]): string {
  return (blockTexts[0] || "").trim();
}

/**
 * The same checkpoint test for one joined string — `item.detail` on a thread,
 * where the engine's seed path wrote the note and the provenance marker as one
 * text field (`note + "\n" + marker`, plus the turn's own metadata block).
 *
 * A checkpoint that arrives this way is still a note about turns that were
 * condensed, not a prompt: a resumed compacted session would otherwise open with
 * a wall of handoff text attributed to the person.
 */
export function isCompactionCheckpointText(text: string): boolean {
  const note = compactionCheckpointTextBody(text);
  return note !== null;
}

/** The note body of a checkpoint written as one string, or `null`. */
export function compactionCheckpointTextBody(text: string): string | null {
  const metaStart = text.lastIndexOf("<turn_meta>");
  const body = (metaStart === -1 ? text : text.slice(0, metaStart)).trimEnd();
  if (!body.endsWith(COMPACTION_CHECKPOINT_PROVENANCE)) return null;
  const note = body.slice(0, body.length - COMPACTION_CHECKPOINT_PROVENANCE.length).trimEnd();
  return note.trimStart().startsWith(COMPACTION_HANDOFF_MARKER) ? note : null;
}
