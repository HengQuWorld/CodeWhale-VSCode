import * as vscode from "vscode";
import { CodeWhaleEngine } from "./api/engine";
import { CodeWhaleApiClient } from "./api/api-client";
import { ChatProvider } from "./chat-provider";
import { ConfigPanel } from "./config-panel";
import { t } from "./i18n";
import { telemetryEnabled } from "./utils/telemetry-settings";

let engine: CodeWhaleEngine;
let api: CodeWhaleApiClient;
let chatProvider: ChatProvider;

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

  // The Explorer's context menu. A drag out of the tree never reaches the chat
  // webview — VS Code holds pointer events off it for the whole of a drag that
  // began inside the window — so the selection is handed over as a command
  // instead. The clicked resource and the selection both arrive; the host
  // de-duplicates them.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "brotherwhale.attachToChat",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selection = Array.isArray(uris) && uris.length > 0 ? uris : [uri];
        return chatProvider.handleExplorerAttach(selection);
      }
    )
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
    outputChannel.appendLine("[telemetry] usage reporting is off by setting");
  }
}

export async function deactivate(): Promise<void> {
  await engine?.stop();
}
