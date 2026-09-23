import type { ProviderEntry } from "../types";

/**
 * Provider *routes* as `GET /v1/providers` publishes them.
 *
 * One entry is a pair: the generic `id` (the provider kind, and what a
 * `[providers.<name>]` route reports as `custom`) plus `model_provider_id`, the
 * exact configured route when it has one. Two entries can share a display name
 * and differ only by that pair — the DeepSeek API is published both as the
 * `deepseek` route and as the legacy `deepseek-anthropic` dialect route, and
 * both are labelled "DeepSeek". Everything that *shows* or *selects* a route
 * therefore has to name it by the pair, never by the kind alone.
 */

/** The key one route's remembered model is stored under.
 *
 *  Mirrors what a picker row carries as `model_provider_id || id`, so a model
 *  remembered for `bigmodel-cn` is never read back for the generic `custom`
 *  route, and the two DeepSeek routes cannot share one memory slot. */
export function providerRouteKey(
  provider?: string | null,
  providerId?: string | null
): string {
  const exact = providerId?.trim();
  if (exact) return exact;
  return provider?.trim() ?? "";
}

export function providerEntryRouteKey(
  entry: Pick<ProviderEntry, "id" | "model_provider_id">
): string {
  return providerRouteKey(entry.id, entry.model_provider_id);
}

/** The text a picker row appends when its route is not ready. */
export interface ProviderPickerText {
  /** Credential state `login_required`: the route exists and needs a login. */
  needsLogin: string;
  /** Credential state `missing`: no key is configured for this route. */
  noKey: string;
}

/** What a picker row shows for one route.
 *
 *  - the runtime's own display name;
 *  - the route id appended when another entry on the list carries the same
 *    display name ("DeepSeek (deepseek-anthropic)"), because the name alone
 *    cannot tell two DeepSeek routes apart — and the model catalog answers the
 *    same models for both;
 *  - the credential state appended when the route is not ready, so an
 *    unconfigured route cannot look like a configured one.
 */
export function providerEntryLabel(
  entry: Pick<ProviderEntry, "id" | "model_provider_id" | "display_name" | "credentialState">,
  all: ReadonlyArray<Pick<ProviderEntry, "id" | "model_provider_id" | "display_name">> = [],
  text: ProviderPickerText
): string {
  let name = entry.display_name || entry.model_provider_id || entry.id || "";
  const route = providerEntryRouteKey(entry);
  const duplicated = all.some(
    other => other !== entry && (other.display_name || other.model_provider_id || other.id || "") === name
  );
  if (duplicated && route && name !== route) name = `${name} (${route})`;
  if (entry.credentialState === "login_required") name = `${name} · ${text.needsLogin}`;
  else if (entry.credentialState === "missing") name = `${name} · ${text.noKey}`;
  return name;
}

/** Whether the picker offers a route at all.
 *
 *  A route with no credential is not a choice — it is a dead end that only
 *  spends the user's first message to explain itself — so `missing` routes are
 *  left out. The exception is the route that is *already* active: hiding the
 *  route the chip names would leave the picker unable to describe where the
 *  user is, so it stays, labelled with its state. `local` and `no_auth` need no
 *  key by design, and `login_required` is one click from working, so both stay.
 *  An absent state (a runtime older than the field) is visible rather than
 *  hidden: the field's absence is not evidence of a missing key. */
export function providerRouteVisible(
  entry: Pick<ProviderEntry, "credentialState">,
  isActive: boolean
): boolean {
  if (isActive) return true;
  const state = entry.credentialState;
  if (!state) return true;
  return state !== "missing" && state !== "legacy";
}

/**
 * The same two rules, as JavaScript for the injected webview/panel scripts.
 *
 * The webview is generated as a string, so it cannot import the functions
 * above. They are mirrored here instead of in two places, and
 * `provider-route.test.ts` runs this snippet and compares it against the typed
 * helpers above so the two cannot drift.
 */
export const PROVIDER_PICKER_JS = `
  function __cwRouteKey(p) {
    if (!p) return '';
    return ((p.model_provider_id || p.id) || '').trim();
  }
  function __cwProviderLabel(p, all, text) {
    var name = (p && (p.display_name || p.model_provider_id || p.id)) || '';
    var route = __cwRouteKey(p);
    var duplicated = false;
    for (var i = 0; i < (all || []).length; i++) {
      var other = all[i];
      if (!other || other === p) continue;
      if (((other.display_name || other.model_provider_id || other.id) || '') === name) {
        duplicated = true;
        break;
      }
    }
    if (duplicated && route && name !== route) name = name + ' (' + route + ')';
    var state = p && p.credentialState;
    if (state === 'login_required') name = name + ' · ' + text.needsLogin;
    else if (state === 'missing') name = name + ' · ' + text.noKey;
    return name;
  }
  function __cwProviderVisible(p, isActive) {
    if (isActive) return true;
    var state = p && p.credentialState;
    if (!state) return true;
    return state !== 'missing' && state !== 'legacy';
  }
`;
