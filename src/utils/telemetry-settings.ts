/**
 * The extension's whole contribution to usage counting.
 *
 * All collection, buffering, identity, and delivery belong to the engine. It
 * holds the payload builder and the transport, and the schema they implement is
 * published in `docs/TELEMETRY.md` (`crates/telemetry` and `telemetry-ingest`
 * in the CodeWhale repository). This module decides exactly two things:
 *
 * 1. whether the user wants reporting at all, and
 * 2. which client the engine should say its sessions belong to.
 *
 * Keeping it to those two is the point, and the reason is not modesty about
 * code volume. A second client here would need its own buffer and its own
 * install id — and the id is what matters: installs are counted by a rotating
 * anonymous id kept in the CodeWhale home, so a client minting its own would
 * make one installation look like two and inflate the only product metric the
 * contract publishes.
 *
 * So there is no payload builder here, no buffer, no endpoint, and no identity.
 * There is a setting and an environment variable.
 */

import * as vscode from "vscode";

/** The extension's settings namespace, matching `package.json`. */
const NAMESPACE = "brotherwhale";

/** The setting the user sees: `brotherwhale.telemetry`. */
export const TELEMETRY_SETTING = "telemetry";

/**
 * The surface name the engine reports for a server this extension started.
 *
 * Passed to the engine as `CODEWHALE_TELEMETRY_SURFACE`. The engine honours it
 * only for the `serve` it is being asked to run, only for a name in its
 * published surface whitelist, and never for `tui`; anything else is dropped
 * and the server reports itself as an anonymous `serve`. See
 * `docs/TELEMETRY.md`, "An embedder declares the server it started".
 *
 * The name is deliberately generic rather than this product's own: the field
 * says which *kind* of client produced a batch, and the engine's editor host is
 * not collected.
 */
export const EMBEDDED_SURFACE = "vscode-extension";

/**
 * Whether the user has left usage reporting on.
 *
 * Defaults to on, which is the contract's default for every surface. An absent
 * or malformed value is read as the default rather than as a refusal: a
 * mis-typed setting is not a user answer.
 */
export function telemetryEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(NAMESPACE)
    .get<boolean>(TELEMETRY_SETTING, true);
}

/**
 * The telemetry environment the extension hands the engine it starts.
 *
 * This function is the whole of the extension's telemetry surface area, and it
 * returns **two variables at most, neither of which carries data**:
 *
 * - `CODEWHALE_TELEMETRY_SURFACE` — which client the server is serving. Read
 *   by the engine only for the `serve` it has been asked to run.
 * - `CODEWHALE_TELEMETRY` — `"0"` when the user wants reporting off. A
 *   **run-scoped kill switch**: the engine stops reporting for this process and
 *   deliberately leaves the shared buffer and identity alone, because they
 *   belong to every surface on the machine and not to one window.
 *
 * There is no endpoint here, no install id, and no payload. Adding one would
 * mean inventing something the extension has no business owning — the contract
 * has exactly one identity per installation, and it lives in the CodeWhale home.
 */
export function telemetryEnv(enabled: boolean): Record<string, string> {
  const env: Record<string, string> = {
    CODEWHALE_TELEMETRY_SURFACE: EMBEDDED_SURFACE,
  };
  if (!enabled) env.CODEWHALE_TELEMETRY = "0";
  return env;
}
