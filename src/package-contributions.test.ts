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

describe("package.json Explorer context-menu contribution", () => {
  const ATTACH_COMMAND = "brotherwhale.attachToChat";

  it("contributes the attach command with a localised title", () => {
    const command = pkg.contributes.commands.find(
      (c) => c.command === ATTACH_COMMAND
    );

    expect(command?.title).toBe("%commands.attachToChat.title%");
  });

  it("puts it on the file context menu, beside VS Code's own chat entries", () => {
    // `5_chat` is the group the built-in "Add File to Chat" uses; it is
    // ordered @2 so this sits right after it rather than racing it.
    const entry = pkg.contributes.menus["explorer/context"].find(
      (m) => m.command === ATTACH_COMMAND
    );

    expect(entry?.group).toBe("5_chat@2");
    expect(entry?.when).toBe(
      "!explorerResourceIsFolder && (resourceScheme == file || resourceScheme == vscode-remote)"
    );
  });

  it("keeps it out of the command palette, where it would have no file", () => {
    // The palette invokes a command with no arguments, and this one attaches
    // nothing without a URI — an entry there would be a control that does
    // nothing when used.
    const entry = pkg.contributes.menus["commandPalette"].find(
      (m) => m.command === ATTACH_COMMAND
    );

    expect(entry?.when).toBe("false");
  });

  it("names the command in both nls files", () => {
    for (const file of ["package.nls.json", "package.nls.zh-cn.json"]) {
      const nls = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), file), "utf8")
      ) as Record<string, string>;
      expect(nls["commands.attachToChat.title"], file).toBeTruthy();
    }
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