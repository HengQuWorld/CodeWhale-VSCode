import { describe, expect, it } from "vitest";
import {
  PROVIDER_PICKER_JS,
  providerEntryLabel,
  providerEntryRouteKey,
  providerRouteKey,
  providerRouteVisible,
} from "./provider-route";

/** The two routes the Runtime publishes for the DeepSeek API: the vendor route
 *  and the legacy Anthropic dialect route. Both are labelled "DeepSeek", they
 *  answer the same model catalog, and only one of them holds the user's key. */
const deepseek = {
  id: "deepseek",
  model_provider_id: null,
  display_name: "DeepSeek",
  credentialState: "configured" as const,
};
const deepseekAnthropic = {
  id: "deepseek-anthropic",
  model_provider_id: "deepseek-anthropic",
  display_name: "DeepSeek",
  credentialState: "missing" as const,
};
const bigmodel = {
  id: "custom",
  model_provider_id: "bigmodel-cn",
  display_name: "bigmodel-cn (custom)",
  credentialState: "configured" as const,
};
const deepseekOnly = {
  id: "deepseek",
  model_provider_id: null,
  display_name: "DeepSeek",
  credentialState: "configured" as const,
};

const text = { needsLogin: "needs login", noKey: "no key configured" };

/** The injected scripts are generated as a string, so the rules they apply are
 *  mirrored in `PROVIDER_PICKER_JS`. Load that snippet the way a webview would
 *  and expose its functions, so both spellings of every rule are compared on
 *  the same inputs. */
function loadPickerFragment(): {
  __cwProviderLabel: (p: unknown, all: unknown[], text: unknown) => string;
  __cwProviderVisible: (p: unknown, isActive: boolean) => boolean;
} {
  const script = `${PROVIDER_PICKER_JS}
    return { __cwProviderLabel: __cwProviderLabel, __cwProviderVisible: __cwProviderVisible };`;
  return new Function(script)() as ReturnType<typeof loadPickerFragment>;
}

describe("provider route keys", () => {
  it("keys a route by its exact id, falling back to the kind", () => {
    expect(providerRouteKey("custom", "bigmodel-cn")).toBe("bigmodel-cn");
    expect(providerRouteKey("deepseek", null)).toBe("deepseek");
    expect(providerRouteKey(" deepseek-anthropic ", "  ")).toBe("deepseek-anthropic");
    expect(providerRouteKey(undefined, undefined)).toBe("");
  });

  it("gives the two DeepSeek routes separate keys", () => {
    // One shared memory slot for both is what pinned one route's model to the
    // other's provider.
    expect(providerEntryRouteKey(deepseek)).toBe("deepseek");
    expect(providerEntryRouteKey(deepseekAnthropic)).toBe("deepseek-anthropic");
  });
});

describe("provider labels", () => {
  it("names the route when two rows share a display name", () => {
    expect(providerEntryLabel(deepseek, [deepseek, deepseekAnthropic], text)).toBe(
      "DeepSeek (deepseek)"
    );
    expect(providerEntryLabel(deepseekAnthropic, [deepseek, deepseekAnthropic], text)).toBe(
      "DeepSeek (deepseek-anthropic) · no key configured"
    );
  });

  it("leaves an unambiguous route's name alone", () => {
    expect(providerEntryLabel(bigmodel, [bigmodel, deepseekOnly], text)).toBe("bigmodel-cn (custom)");
  });

  it("marks the states a user has to act on", () => {
    const needsLogin = { id: "openai-codex", model_provider_id: null, display_name: "OpenAI Codex", credentialState: "login_required" as const };
    expect(providerEntryLabel(needsLogin, [needsLogin], text)).toBe("OpenAI Codex · needs login");
    const noKey = { id: "openrouter", model_provider_id: null, display_name: "OpenRouter", credentialState: "missing" as const };
    expect(providerEntryLabel(noKey, [noKey], text)).toBe("OpenRouter · no key configured");
  });
});

describe("provider visibility", () => {
  it("offers a route only when it can actually run", () => {
    expect(providerRouteVisible(deepseek, false)).toBe(true);
    expect(providerRouteVisible(deepseekAnthropic, false)).toBe(false);
    const local = { credentialState: "local" as const };
    const noAuth = { credentialState: "no_auth" as const };
    const login = { credentialState: "login_required" as const };
    expect(providerRouteVisible(local, false)).toBe(true);
    expect(providerRouteVisible(noAuth, false)).toBe(true);
    expect(providerRouteVisible(login, false)).toBe(true);
  });

  it("keeps the active route listed whatever its state", () => {
    // Hiding the route the chip names would leave the picker unable to say
    // where the user is.
    expect(providerRouteVisible(deepseekAnthropic, true)).toBe(true);
  });

  it("shows a route whose readiness the runtime did not report", () => {
    expect(providerRouteVisible({ credentialState: undefined }, false)).toBe(true);
  });
});

describe("injected provider picker script", () => {
  it("labels and filters exactly like the typed helpers", () => {
    const js = loadPickerFragment();
    const catalog = [deepseek, deepseekAnthropic, bigmodel];
    for (const entry of catalog) {
      expect(js.__cwProviderLabel(entry, catalog, text)).toBe(
        providerEntryLabel(entry, catalog, text)
      );
      for (const isActive of [true, false]) {
        expect(js.__cwProviderVisible(entry, isActive)).toBe(
          providerRouteVisible(entry, isActive)
        );
      }
    }
  });
});
