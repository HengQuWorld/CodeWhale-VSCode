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

describe("Changes panel shell wording", () => {
  it("states one turn's shell count, and nothing more", () => {
    // The panel's rule is said once for the whole panel (`changePanelHint`),
    // so a turn's note is the count: the explanation was repeated in every
    // group when it lived here.
    expect(forLanguage("zh-cn").changeTurnShellNote).toBe("本轮执行了 {n} 条 shell 命令。");
    expect(forLanguage("en").changeTurnShellNote).toBe("{n} shell command(s) ran in this turn.");
  });

  it("says what the panel lists, once, in the panel hint", () => {
    expect(forLanguage("zh-cn").changePanelHint).toBe(
      "只列文件工具（编辑 / 写入 / 打补丁）产生的改动，shell命令如果造成文件改动不会出现在这里。",
    );
    expect(forLanguage("en").changePanelHint).toBe(
      "Lists only the changes made by the file tools (edit / write / patch). File changes made by shell commands are not shown here.",
    );
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
