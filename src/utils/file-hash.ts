/**
 * Hashing a file for the engine's file-scoped restore.
 *
 * `POST /v1/threads/{id}/file-revert` will not touch a file until the client
 * proves which revision it reviewed. `expected_hash` is the `sha256:` digest of
 * the bytes the Changes panel showed, or the literal `absent` when the panel
 * saw the file deleted. The engine checks it before its safety backup and again
 * immediately before the mutation, so a file that moved under the client is
 * refused instead of silently overwritten — the check exists to protect the
 * user's own edits, which is why the caller must send the revision it actually
 * displayed rather than a digest taken at request time.
 */

import { createHash } from "crypto";
import * as fs from "fs";

/**
 * Ceiling for a digest taken while merely *recording* a change. Hashing a huge
 * file is never worth stalling the extension host for; the record simply goes
 * without a hash and the click path computes one instead.
 */
export const MAX_EAGER_HASH_BYTES = 8 * 1024 * 1024;

/**
 * `sha256:<64 lowercase hex>` of a file's bytes, `absent` when the path does
 * not exist (the panel saw the file deleted), or `undefined` when the bytes
 * cannot be read at all.
 *
 * `undefined` is not a failure to paper over: a caller that cannot prove the
 * revision must refuse the restore, because any digest it invented would let
 * the engine overwrite whatever is on disk now.
 */
export function sha256OfFile(
  absPath: string,
  options?: { maxBytes?: number }
): string | undefined {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return undefined;
    if (options?.maxBytes !== undefined && stat.size > options.maxBytes) return undefined;
    return `sha256:${createHash("sha256").update(fs.readFileSync(absPath)).digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return "absent";
    return undefined;
  }
}
