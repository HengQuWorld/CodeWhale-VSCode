import * as vscode from "vscode";
import { CodeWhaleEngine } from "./api/engine";
import { CodeWhaleApiClient } from "./api/api-client";
import { ChatProvider } from "./chat-provider";
import { t } from "./i18n";

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
    vscode.commands.registerCommand("brotherwhale.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.brotherwhale");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brotherwhale.newThread", () => {
      chatProvider.handleNewThreadCommand();
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
}

export async function deactivate(): Promise<void> {
  await engine?.stop();
}
