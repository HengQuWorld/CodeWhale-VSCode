import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EAGER_HASH_BYTES, sha256OfFile } from "./file-hash";

describe("sha256OfFile", () => {
  let dir: string;

  const write = (name: string, content: string | Buffer) => {
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, content);
    return abs;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-hash-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("digests the file's bytes in the shape the engine accepts", () => {
    const abs = write("a.ts", "export const a = 1;\n");
    const expected = createHash("sha256").update("export const a = 1;\n").digest("hex");

    const hash = sha256OfFile(abs);

    expect(hash).toBe(`sha256:${expected}`);
    // The engine's `expected_hash` grammar: no uppercase, no short digest.
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("reports a missing path as absent, which is the engine's word for a deletion", () => {
    expect(sha256OfFile(path.join(dir, "gone.ts"))).toBe("absent");
  });

  it("changes the digest when the bytes change", () => {
    const abs = write("a.ts", "one\n");
    const first = sha256OfFile(abs);
    fs.writeFileSync(abs, "two\n");

    expect(sha256OfFile(abs)).not.toBe(first);
  });

  it("refuses to describe a path that is not a regular file", () => {
    // The engine rejects directories too; returning a digest here would let
    // the GUI claim it reviewed something it never showed.
    expect(sha256OfFile(dir)).toBeUndefined();
  });

  it("skips files past the eager-hash ceiling instead of blocking on them", () => {
    const abs = write("big.bin", "x".repeat(64));

    expect(sha256OfFile(abs, { maxBytes: 16 })).toBeUndefined();
    expect(sha256OfFile(abs, { maxBytes: MAX_EAGER_HASH_BYTES })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
