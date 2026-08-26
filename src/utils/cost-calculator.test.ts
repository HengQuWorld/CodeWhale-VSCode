import { describe, it, expect } from "vitest";
import { resolveCostCurrency, formatCostAmount } from "./cost-calculator";

// Rate lookup and cost arithmetic live in the TUI runtime; the GUI-side
// utilities tested here only pick a display currency and format amounts.

describe("resolveCostCurrency", () => {
  it("maps Chinese locales to CNY under auto", () => {
    expect(resolveCostCurrency("auto", "zh-cn")).toBe("cny");
    expect(resolveCostCurrency("auto", "zh-CN")).toBe("cny");
    expect(resolveCostCurrency("auto", "zh")).toBe("cny");
    expect(resolveCostCurrency("auto", "zh-tw")).toBe("cny");
  });

  it("maps non-Chinese locales to USD under auto", () => {
    expect(resolveCostCurrency("auto", "en")).toBe("usd");
    expect(resolveCostCurrency("auto", "en-us")).toBe("usd");
    expect(resolveCostCurrency("auto", "ja")).toBe("usd");
    expect(resolveCostCurrency("auto", "fr")).toBe("usd");
  });

  it("defaults to auto behavior when unset or unknown", () => {
    expect(resolveCostCurrency(undefined, "zh-cn")).toBe("cny");
    expect(resolveCostCurrency(undefined, "en")).toBe("usd");
    // A stale/typo setting must never break rendering: fall back to the
    // language-based default rather than throwing.
    expect(resolveCostCurrency("yen", "en")).toBe("usd");
    expect(resolveCostCurrency("yen", "zh-cn")).toBe("cny");
    expect(resolveCostCurrency("", "zh-cn")).toBe("cny");
  });

  it("lets an explicit currency override the locale", () => {
    expect(resolveCostCurrency("cny", "en")).toBe("cny");
    expect(resolveCostCurrency("usd", "zh-cn")).toBe("usd");
  });
});

describe("formatCostAmount", () => {
  it("shows a floor marker for negligible amounts", () => {
    expect(formatCostAmount(0.00001, "usd")).toBe("<$0.0001");
    expect(formatCostAmount(0.00001, "cny")).toBe("<¥0.0001");
  });

  it("uses four decimals below one cent", () => {
    expect(formatCostAmount(0.005, "usd")).toBe("$0.0050");
    expect(formatCostAmount(0.005, "cny")).toBe("¥0.0050");
  });

  it("uses two decimals at and above one cent", () => {
    expect(formatCostAmount(1.5, "usd")).toBe("$1.50");
    expect(formatCostAmount(12.345, "cny")).toBe("¥12.35");
  });

  it("handles zero and large amounts", () => {
    expect(formatCostAmount(0, "usd")).toBe("<$0.0001");
    expect(formatCostAmount(100, "usd")).toBe("$100.00");
    expect(formatCostAmount(999.99, "cny")).toBe("¥999.99");
  });

  it("does not round the boundary down to the floor marker", () => {
    expect(formatCostAmount(0.0001, "usd")).toBe("$0.0001");
    expect(formatCostAmount(0.00009, "usd")).toBe("<$0.0001");
    expect(formatCostAmount(0.01, "usd")).toBe("$0.01");
    expect(formatCostAmount(0.0099, "usd")).toBe("$0.0099");
  });
});
