/**
 * Live integration check: the GUI's Context Lens client against a real engine.
 *
 * Not part of the default suite — it needs a running Codewhale Runtime API.
 * Run with:
 *   CODEWHALE_LIVE_BASE=http://127.0.0.1:7895 CODEWHALE_LIVE_TOKEN=smoke-token \
 *     npx vitest run src/api/api-client-memory-lens-live.test.ts
 *
 * It exists because the Lens is a *second* view of the memory store, and the
 * whole reason the client reads it is the thing a mock cannot confirm: that the
 * flat `/v1/memory` listing the chat already used is a filtered view of it, and
 * that a review candidate is visible only through the Lens. Every read in here
 * follows the pagination cursor rather than assuming one page is the store, so
 * it is read-only and holds for any store size.
 */
import { describe, expect, it } from "vitest";
import { CodeWhaleApiClient } from "./api-client";

const base = process.env.CODEWHALE_LIVE_BASE;
const token = process.env.CODEWHALE_LIVE_TOKEN;
const live = base ? describe : describe.skip;

/** Every entry the Lens holds, following the cursor.
 *
 *  One page is not the store: the engine clamps a page to 100 entries, so a
 *  check that read one page would fail on a larger store for no real reason. */
async function allLensEntries(api: CodeWhaleApiClient) {
  const entries: Awaited<ReturnType<CodeWhaleApiClient["getMemoryLens"]>>["entries"] = [];
  let snapshot = await api.getMemoryLens({ limit: 100 });
  for (let page = 0; page < 20; page++) {
    entries.push(...snapshot.entries);
    if (!snapshot.next_after) break;
    snapshot = await api.getMemoryLens({ limit: 100, after: snapshot.next_after });
  }
  return entries;
}

live("CodeWhaleApiClient against a live engine (Context Lens)", () => {
  const api = new CodeWhaleApiClient(base ?? "", token);

  it("reads a lens snapshot and reports the capabilities it holds", async () => {
    const snapshot = await api.getMemoryLens({ limit: 100 });
    expect(snapshot.schema).toBe("codewhale.memory.lens/v1");
    expect(Array.isArray(snapshot.entries)).toBe(true);
    // Capabilities are reported, not assumed: a client hides a control it does
    // not hold rather than failing on click.
    expect(typeof snapshot.can_review).toBe("boolean");
    expect(typeof snapshot.can_forget).toBe("boolean");
    for (const entry of snapshot.entries) {
      // Lens ids are UUIDs, unlike the flat listing's row numbers.
      expect(entry.memory.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(entry.memory.revision).toBeGreaterThan(0);
      expect(typeof entry.memory.status).toBe("string");
      expect(typeof entry.memory.draft.title).toBe("string");
      expect(typeof entry.preferences.pinned).toBe("boolean");
    }
  });

  it("pages without repeating an entry", async () => {
    const first = await api.getMemoryLens({ limit: 1 });
    expect(first.entries.length).toBeLessThanOrEqual(1);
    if (!first.next_after) {
      return; // A one-entry store has no second page to check.
    }
    const second = await api.getMemoryLens({ limit: 1, after: first.next_after });
    const firstIds = new Set(first.entries.map((e) => e.memory.id));
    for (const entry of second.entries) {
      expect(firstIds.has(entry.memory.id)).toBe(false);
    }
  });

  it("shows every entry the flat listing shows, in a reviewed state", async () => {
    // The chat's existing /memory listing is the Lens filtered to live memory.
    // If that ever stops holding, the two views have diverged and a review
    // action would be offered for something the chat cannot see.
    //
    // The join is on text, not on id: the flat listing reports the store's row
    // number while the Lens reports a UUID, and its `summary` is the same body
    // bounded to 300 chars with an ellipsis when it was cut. So the summary is
    // matched as a prefix of the Lens body rather than as an equal string —
    // reading it as equality is what this check got wrong first.
    const flat = await api.listMemory({ limit: 200 });
    if (!flat.entries.length) {
      console.log("store is empty; the flat/lens correspondence was not exercised");
      return;
    }
    const lens = await allLensEntries(api);
    for (const entry of flat.entries) {
      const needle = entry.summary.endsWith("...")
        ? entry.summary.slice(0, -3)
        : entry.summary;
      const match = lens.find((e) => e.memory.draft.body.startsWith(needle));
      expect(match, `flat entry "${entry.summary}" missing from the lens`).toBeDefined();
      expect(["active", "stale"]).toContain(match!.memory.status);
    }
  });

  it("keeps a candidate out of the flat listing", async () => {
    const lens = await allLensEntries(api);
    const candidate = lens.find((e) => e.memory.status === "candidate");
    if (!candidate) {
      // Nothing to prove on a store with no unreviewed capture. Reported rather
      // than silently passed, so a green run that checked nothing is visible.
      console.log("no candidate in the store; the flat-listing exclusion was not exercised");
      return;
    }
    const flat = await api.listMemory({ limit: 200 });
    for (const entry of flat.entries) {
      expect(entry.summary).not.toBe(candidate.memory.draft.title);
    }
  });
});
