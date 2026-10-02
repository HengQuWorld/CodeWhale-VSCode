/**
 * The Changes panel's wording, as the webview actually receives it.
 *
 * `i18n.test.ts` checks hand-copied literals, so it cannot notice drift in
 * `i18n.ts`. These tests read the real tables through the seam the extension
 * uses to publish them (`webviewTranslations(t())`, called from
 * `ChatProvider.resolveWebviewView`), which also makes them the guard that a
 * key added to `WebviewTranslations` is actually published: that function
 * returns an unannotated object literal, so a missing entry is not a type error
 * — it is an `undefined` in the panel.
 */
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ language: "en" }));

vi.mock("vscode", () => ({ env }));

import { t, webviewTranslations } from "./i18n";
import { makeTr } from "./webview/webview-test-helpers";

function forLanguage(language: string): Record<string, string> {
  env.language = language;
  return webviewTranslations(t()) as unknown as Record<string, string>;
}

describe("Changes panel wording", () => {
  it("carries none, for a panel that lists every provenance", () => {
    // The panel used to explain itself: which changes it lists, and later what
    // a command's rows are. Every clause of that described a limit the panel
    // outgrew once a command's own writes became rows, so the strings are gone
    // rather than merely unreferenced — a dead translation is an invitation to
    // bring the notice back.
    for (const language of ["en", "zh-cn"]) {
      const published = forLanguage(language) as unknown as Record<string, unknown>;
      expect(published.changePanelHint, language).toBeUndefined();
      expect(published.changeTurnShellNote, language).toBeUndefined();
    }
  });

  it("publishes every key the webview's translation type declares", () => {
    for (const language of ["en", "zh-cn"]) {
      const published = forLanguage(language);
      for (const key of Object.keys(makeTr())) {
        expect(published[key], `${key} is not published to the webview (${language})`).toBeDefined();
      }
    }
  });
});
