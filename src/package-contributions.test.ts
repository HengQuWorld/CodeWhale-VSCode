/**
 * Guards the *shape* of the settings entry point: it must be a small gear
 * action in the sidebar view title bar (`menus["view/title"]`), never a
 * button rendered inside the chat webview.
 *
 * These assertions read `package.json` and the webview sources directly so a
 * regression (e.g. re-adding `#btn-config`) fails the suite instead of only
 * showing up in a packaged VSIX.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

interface CommandContribution {
  command: string;
  title: string;
  icon?: string;
}

interface MenuContribution {
  command: string;
  when?: string;
  group?: string;
}

interface PackageJson {
  contributes: {
    views: Record<string, Array<{ id: string }>>;
    commands: CommandContribution[];
    menus: Record<string, MenuContribution[]>;
  };
}

const OPEN_CONFIG_COMMAND = "brotherwhale.openConfig";
const CHAT_VIEW_ID = "brotherwhale.chat";

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
) as PackageJson;

describe("package.json settings entry contributions", () => {
  it("contributes the open-config command with a codicon gear", () => {
    const command = pkg.contributes.commands.find(
      (c) => c.command === OPEN_CONFIG_COMMAND
    );

    expect(command).toBeDefined();
    expect(command?.icon).toBe("$(gear)");
  });

  it("puts the gear in the chat view title bar as a navigation action", () => {
    const entry = pkg.contributes.menus["view/title"].find(
      (m) => m.command === OPEN_CONFIG_COMMAND
    );

    expect(entry).toEqual({
      command: OPEN_CONFIG_COMMAND,
      when: `view == ${CHAT_VIEW_ID}`,
      group: "navigation",
    });
  });

  it("no longer contributes a separate sidebar settings view", () => {
    const viewIds = pkg.contributes.views.brotherwhale.map((v) => v.id);

    expect(viewIds).toEqual([CHAT_VIEW_ID]);
  });
});

describe("webview stays free of the settings button", () => {
  it("has no #btn-config markup, handler, or styles left behind", () => {
    const files = [
      "src/webview/webview-html.ts",
      "src/webview/webview-css.ts",
      "src/webview/webview-js-event-handler.ts",
    ];

    const offenders = files.filter((file) =>
      fs
        .readFileSync(path.resolve(process.cwd(), file), "utf8")
        .includes("btn-config")
    );

    expect(offenders).toEqual([]);
  });
});