# Media

Assets shipped with the extension. `icon.png` / `icon.svg` are the activity-bar
and marketplace icon.

## `completion-chime.wav`

The cue played when a turn finishes (see `src/utils/completion-sound.ts`). It is
original additive synthesis — no third-party samples, no recordings.

- 22,050 Hz, 16-bit mono PCM, 0.52 s, 22,976 bytes, peak −6 dBFS (−16384 /
  +16384), first and last sample exactly 0 (a hard stop mid-decay clicks).
- Two notes a rising fifth apart — C6 (1046.502 Hz) from 0.00 s, G6
  (1567.982 Hz) from 0.11 s — each with a 6 ms attack, an exponential decay
  (τ 85 ms and 150 ms), and two quiet partials (2× at 0.22/0.18, 3× at
  0.06/0.05, decaying faster than the fundamental), normalized to −6 dBFS and
  faded over the last 20 ms.

To regenerate, synthesize those two notes at those frequencies, sum them into
one buffer, apply the fade, and normalize as above. The TUI ships its own cue
(`crates/tui/assets/audio/`, a whale call) for terminals; the chime is the GUI's,
and it is deliberately not that file — its listening approval is still pending.
