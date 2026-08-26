/**
 * Cost display utilities.
 *
 * Cost arithmetic lives in the TUI runtime: `GET /v1/threads/{id}/usage`
 * (with `/v1/usage?group_by=thread` as the older-runtime fallback) returns
 * thread-scoped totals priced at recorded-time provider rates in both
 * published currencies — CNY is the provider-published subtotal (e.g.
 * DeepSeek's native CNY rows), never an FX projection of USD. The GUI only
 * picks a display currency and formats amounts, so provider rate changes
 * (e.g. DeepSeek repricing) are picked up by updating the TUI, not this
 * extension.
 */

export type CostCurrency = "usd" | "cny";

/**
 * Resolve the configured currency into a concrete one.
 *
 * `auto` (the default) follows the interface language: Chinese locales
 * display CNY, everything else USD. Explicit `usd` / `cny` always win.
 * Unknown values fall back to the `auto` behavior so a stale setting
 * never breaks rendering.
 *
 * Note: a resolved `cny` is a *preference* — callers should mirror the
 * TUI's `cost_display_currency` and fall back to USD when no native-CNY
 * spend exists, rather than displaying a fabricated ¥0.
 */
export function resolveCostCurrency(configured: string | undefined, locale: string): CostCurrency {
  if (configured === "usd" || configured === "cny") return configured;
  return locale.toLowerCase().startsWith("zh") ? "cny" : "usd";
}

export function formatCostAmount(cost: number, currency: CostCurrency): string {
  const symbol = currency === "usd" ? "$" : "¥";
  if (cost < 0.0001) return `<${symbol}0.0001`;
  if (cost < 0.01) return `${symbol}${cost.toFixed(4)}`;
  return `${symbol}${cost.toFixed(2)}`;
}
