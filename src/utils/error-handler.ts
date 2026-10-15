/**
 * Unified error handling utilities.
 *
 * Provides consistent error message extraction and formatting
 * across the extension, replacing scattered `(err as Error).message`
 * patterns with a single source of truth.
 */

/**
 * Extract a human-readable message from an unknown error value.
 *
 * Handles:
 * - Error instances → .message
 * - String values → used directly
 * - Objects with .message → .message
 * - Everything else → String(value)
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Format an error with a context prefix for user-facing messages.
 *
 * Example: `formatError("Failed to save", err)` → "Failed to save: disk full"
 */
export function formatError(prefix: string, err: unknown): string {
  const msg = getErrorMessage(err);
  return msg ? `${prefix}: ${msg}` : prefix;
}

/** Socket-level failures that mean "the engine is not there right now".
 *  A webview reload relaunches the Runtime on a fresh port, so a request
 *  issued in that window hits a dead listener and is worth one retry. */
export const TRANSIENT_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Whether a failed thread-list fetch is worth retrying.
 *
 * A timeout is not transient here: `GET /v1/threads/summary` builds every row
 * from a full thread-detail read, so it legitimately takes seconds-per-thread
 * and a second attempt would just spend the same time again. A refused or
 * reset connection is transient, because the engine is coming back.
 */
export function isTransientFetchError(err: unknown): boolean {
  if (err instanceof Error && err.message.startsWith("Request timed out")) return false;
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_SOCKET_CODES.has(code);
}
