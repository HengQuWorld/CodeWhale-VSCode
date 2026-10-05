/**
 * Live integration check: the GUI's own API client against a real engine.
 *
 * Not part of the default suite — it needs a running Codewhale Runtime API.
 * Run with:
 *   CODEWHALE_LIVE_BASE=http://127.0.0.1:7895 CODEWHALE_LIVE_TOKEN=smoke-token \
 *     npx vitest run src/api/api-client-skills-live.test.ts
 *
 * It exists because the skill routes' shapes (paths, bodies, query params) are
 * the contract between this client and the engine, and a unit test with a
 * mocked fetch cannot catch a mismatch in either.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import { CodeWhaleApiClient } from "./api-client";

const base = process.env.CODEWHALE_LIVE_BASE;
const token = process.env.CODEWHALE_LIVE_TOKEN;
/** The owned global skills root the engine was started against. */
const skillsDir = process.env.CODEWHALE_LIVE_SKILLS_DIR;
const live = base ? describe : describe.skip;

live("CodeWhaleApiClient against a live engine", () => {
  const api = new CodeWhaleApiClient(base ?? "", token);

  it("lists skills with routing metadata", async () => {
    const result = await api.listSkills();
    expect(Array.isArray(result.skills)).toBe(true);
    const demo = result.skills.find((s) => s.name === "demo");
    expect(demo).toBeDefined();
    expect(demo!.invocation).toBe("model+user");
    expect(demo!.aliases).toContain("demo-alias");
  });

  it("reads a skill's body for client-side activation", async () => {
    const detail = await api.getSkillDetail("demo");
    expect(detail.name).toBe("demo");
    expect(detail.body).toContain("BANANA");
    // The alias path is what `/skill demo-alias` would send.
    const byAlias = await api.getSkillDetail("demo-alias");
    expect(byAlias.name).toBe("demo");
  });

  it("toggles a skill's enabled state", async () => {
    const off = await api.setSkillEnabled("demo", false);
    expect(off).toEqual({ name: "demo", enabled: false });
    const on = await api.setSkillEnabled("demo", true);
    expect(on).toEqual({ name: "demo", enabled: true });
  });

  it("reads an audit receipt", async () => {
    const audit = await api.auditSkill("demo");
    expect(audit.ambiguous).toBe(false);
    expect(audit.skills[0]?.name).toBe("demo");
  });

  it("trusts a managed skill and reports the receipt", async () => {
    // Trust is refused for a skill with no install provenance ("only Codewhale
    // managed skills can be trusted"), so the marker is written first — with
    // the digest the engine itself reported, which is what makes this the
    // engine's own notion of managed rather than a guess at one.
    expect(skillsDir, "CODEWHALE_LIVE_SKILLS_DIR is required for this case").toBeTruthy();
    const audit = await api.auditSkill("demo");
    const digest = audit.skills[0]?.digest.value;
    expect(digest, "the engine must report a digest to mark the skill managed").toBeTruthy();
    writeFileSync(
      join(skillsDir!, "demo", ".installed-from"),
      JSON.stringify({
        schema_version: 2,
        spec: "github:example/demo",
        url: null,
        source_checksum: "sha256:test",
        content_digest: digest,
        installed_name: "demo",
        registry_version: null,
      })
    );

    const receipt = await api.trustSkill("demo");
    expect(receipt.name).toBe("demo");
    expect(receipt.outcome).toBe("trusted");
  });
});
