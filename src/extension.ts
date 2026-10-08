import * as vscode from "vscode";
import { CodeWhaleEngine } from "./api/engine";
import { CodeWhaleApiClient } from "./api/api-client";
import { ChatProvider } from "./chat-provider";
import { ConfigPanel } from "./config-panel";
import { t } from "./i18n";
import { disableTelemetry, telemetryEnabled } from "./utils/telemetry-settings";

let engine: CodeWhaleEngine;
let api: CodeWhaleApiClient;
let chatProvider: ChatProvider;

/**
 * Where the fact that the default-on notice has been presented is kept.
 *
 * Deliberately the extension's own Memento rather than anything the engine
 * runs: this is a UI fact about a notification, not a record about the user's
 * work, and it must not be stored anywhere the telemetry contract governs. The
 * engine keeps its own per-revision disclosure marker for the line it prints;
 * the two are independent on purpose.
 */
const NOTICE_SHOWN_KEY = "brotherwhale.telemetryNoticeShown";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("CodeWhale");
  context.subscriptions.push(outputChannel);

  engine = new CodeWhaleEngine(outputChannel, context);
  api = new CodeWhaleApiClient(engine.baseUrl, engine.token ?? undefined);

  context.subscriptions.push(engine);

  chatProvider = new ChatProvider(context.extensionUri, engine, api);
  context.subscriptions.push(chatProvider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatProvider.viewType,
      chatProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.openConfig", () => {
      ConfigPanel.createOrShow(context.extensionUri, api);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.brotherwhale");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.newThread", () => {
      chatProvider.handleNewThreadCommand();
    })
  );

  // The two startup defaults this panel's dropdowns write can also be changed
  // from the VS Code settings editor, another window, or the config panel.
  // Those changes arrive here and nowhere else, so the chips and the "New
  // threads" group are re-announced from this one place.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("brotherwhale")) {
        chatProvider.handleConfigurationChanged();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.compactContext", () => {
      chatProvider.handleCompactCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.restartEngine", async () => {
      try {
        await engine.restart();
        api.setBaseUrl(engine.baseUrl);
        api.setToken(engine.token);
        vscode.window.showInformationMessage(t().engineRestarted);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to restart engine: ${(err as Error).message}`
        );
      }
    })
  );

  outputChannel.appendLine("CodeWhale extension activated");
  if (!telemetryEnabled()) {
    outputChannel.appendLine(
      "[telemetry] collection is off by setting; nothing will be reported by this window"
    );
  }

  void presentTelemetryNoticeOnce(context, outputChannel);
}

export async function deactivate(): Promise<void> {
  await engine?.stop();
}

/**
 * Present the default-on usage-counting disclosure, once per installation.
 *
 * Why the extension shows this at all, when the engine already prints its own
 * disclosure to stderr: that line lands in this extension's output channel,
 * which is not somewhere a user looks unprompted. The setting this notice
 * offers is the one the extension owns, so the disclosure for it belongs
 * somewhere the user will actually see it.
 *
 * It records that the notice was **shown**, never that it was accepted. The
 * product defaults usage counting on, and the honest artifact of that is a
 * disclosure the user can act on — not a fabricated consent record.
 *
 * The marker is written *after* the message is raised, matching the engine's own
 * disclosure: a reload between the two costs the user a repeated notice, which
 * is the harmless direction, while marking first would silently skip a
 * disclosure that never reached anyone.
 */
async function presentTelemetryNoticeOnce(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  if (context.globalState.get<boolean>(NOTICE_SHOWN_KEY)) return;
  // Nothing to disclose about a machine where reporting is already off.
  if (!telemetryEnabled()) return;

  const texts = t();
  const choice = await vscode.window.showInformationMessage(
    texts.telemetryNotice,
    texts.telemetryNoticeLearnMore,
    texts.telemetryNoticeDisable
  );
  await context.globalState.update(NOTICE_SHOWN_KEY, true);

  if (choice === texts.telemetryNoticeLearnMore) {
    void vscode.env.openExternal(
      vscode.Uri.parse(
        "https://github.com/HengQuWorld/CodeWhale-VSCode#privacy--data"
      )
    );
    return;
  }
  if (choice !== texts.telemetryNoticeDisable) return;

  await disableTelemetry();
  outputChannel.appendLine("[telemetry] disabled by the user from the notice");
  // The engine reads the setting when it starts, so a running one keeps
  // reporting until it is replaced. Saying so is the difference between a
  // setting that works and one the user believes works.
  const applied = engine?.isRunning
    ? ` ${texts.telemetryTakesEffectOnRestart}`
    : "";
  void vscode.window.showInformationMessage(
    `${texts.telemetryDisabled}${applied}`
  );
}
