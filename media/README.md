# Media

Assets shipped with the extension. `icon.png` / `icon.svg` are the activity-bar
and marketplace icon.

## `completion-chime.wav`

The success cue, played when a turn finishes (see
`src/utils/completion-sound.ts`). It is original additive synthesis — no
third-party samples, no recordings.

- 22,050 Hz, 16-bit mono PCM, 0.60 s, 26,504 bytes, peak −6 dBFS (−16384 /
  +16384), first and last sample exactly 0 (a hard stop mid-decay clicks),
  faded over the last 20 ms.
- Two notes a *falling* fifth apart — A5 (880.000 Hz) from 0.00 s, D5
  (587.330 Hz) from 0.12 s — each with a 6 ms attack, an exponential decay
  (τ 85 ms and 150 ms), and two quiet partials (2× at 0.22/0.18, 3× at
  0.06/0.05, decaying faster than the fundamental), normalized to −6 dBFS.
  Pure tones, no detune: the success cue should sound clean.

To regenerate, synthesize those two notes at those frequencies, sum them into
one buffer, apply the fade, and normalize as above. The TUI ships its own cue
(`crates/tui/assets/audio/`, a whale call) for terminals; the chime is the GUI's,
and it is deliberately not that file — its listening approval is still pending.

## `failure-chime.wav`

The cue played when a turn *fails* — a dead network, a refused key, anything
that made the turn end in failure rather than finish (see
`src/utils/completion-sound.ts`, `playFailureSound`). Deliberately the opposite
of the success cue: two urgent blips, each a *minor-second cluster* — two
adjacent semitones sounding together, beating at ≈26 Hz, which reads as rough
and buzzy rather than tonal — with the second blip raised a semitone so the
ending escalates instead of merely ending. Odd partials are emphasized for a
buzzer-like edge:

- 22,050 Hz, 16-bit mono PCM, 0.42 s, 18,566 bytes, peak −6 dBFS (−16384 /
  +16384), first and last sample exactly 0, 20 ms fade at the end.
- Blip 1: A4 (440.000 Hz) + B♭4 (466.164 Hz) from 0.00 s to 0.155 s; blip 2:
  A♯4 (466.164 Hz) + B4 (493.883 Hz) from 0.19 s to 0.40 s. Each blip: 4 ms
  attack, slow exponential decay (τ 250 ms) with its own 8 ms gate-off so the
  cut does not click, and quiet partials on the cluster's geometric mean (2×
  at 0.30, 3× at 0.20, 5× at 0.10, 7× at 0.05), normalized to −6 dBFS.

Regenerate the same way: two rising minor-second clusters, odd partials
included.

Both cues are gated by the one setting (`brotherwhale.completionSound`) and
share the same 1 s floor: two turns ending together are one sound, whichever
cue each would have been.

Both cues are gated by the one setting (`brotherwhale.completionSound`) and
share the same 1 s floor: two turns ending together are one sound, whichever
cue each would have been.
