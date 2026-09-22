/**
 * Config Panel - A standalone WebView panel for editing CodeWhale configuration.
 * Similar to TUI's ConfigUI, provides a form-based interface for viewing and
 * modifying runtime config keys.
 */

import * as vscode from "vscode";
import type { CodeWhaleApiClient, ProviderEntry } from "./types";
import { getErrorMessage } from "./utils/error-handler";
import {
  MODE_LABELS,
  MODE_VALUES,
  POSTURE_CONFIG,
  POSTURE_LABELS,
  POSTURE_VALUES,
} from "./utils/modes";

/** Options generated from the single source of truth in `utils/modes.ts`.
 *  `cfg-default_mode` stores canonical mode settings; `cfg-approval_mode`
 *  stores the engine's hyphenated config spellings. */
const MODE_OPTIONS = MODE_VALUES.map(
  (value) => `<option value="${value}">${MODE_LABELS[value]}</option>`,
).join("\n            ");
const POSTURE_OPTIONS = POSTURE_VALUES.map(
  (value) => `<option value="${POSTURE_CONFIG[value]}">${POSTURE_LABELS[value]}</option>`,
).join("\n            ");

export class ConfigPanel {
  public static currentPanel: ConfigPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly api: CodeWhaleApiClient;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private providersCache: ProviderEntry[] | null = null;
  /** A provider whose model catalog was asked for before the provider catalog
   *  arrived, with the model to preview. A named `[providers.<name>]` route is
   *  not addressable without the exact id that catalog publishes, so the ask is
   *  remembered and resolved when it lands instead of firing a request that
   *  must fail. */
  private pendingProviderModels: { name: string; currentModel?: string } | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    api: CodeWhaleApiClient
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.api = api;

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        await this.handleMessage(msg);
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Load initial config
    this.loadConfig();
    // Load provider catalog so the provider/model selects are populated
    // dynamically instead of being limited to the hard-coded deepseek-only
    // options baked into the HTML.
    this.loadProviders();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    api: CodeWhaleApiClient
  ): ConfigPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ConfigPanel.currentPanel) {
      ConfigPanel.currentPanel.panel.reveal(column);
      ConfigPanel.currentPanel.loadConfig();
      return ConfigPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "codewhaleConfig",
      "CodeWhale Config",
      column || vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );

    ConfigPanel.currentPanel = new ConfigPanel(panel, extensionUri, api);
    return ConfigPanel.currentPanel;
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.api.getConfig();
      this.panel.webview.postMessage({ type: "configData", config });
      // After loading config, refresh the model list for the active provider
      // so the model <select> reflects the provider's catalog rather than
      // the hard-coded deepseek-only list.
      if (config.provider) {
        this.loadProviderModels(config.provider, config.model);
      }    } catch (err) {
      this.panel.webview.postMessage({
        type: "error",
        message: `Failed to load config: ${getErrorMessage(err)}`,
      });
    }
  }

  /**
   * Fetch the provider catalog from `GET /v1/providers` and push it to the
   * webview so the provider <select> can be re-rendered dynamically. Falls
   * back silently on error — the hard-coded deepseek option remains.
   */
  private async loadProviders(): Promise<void> {
    try {
      const resp = await this.api.listProviders();
      this.providersCache = resp.providers;
      this.panel.webview.postMessage({
        type: "providersData",
        providers: resp.providers,
        current: resp.current,
        currentProviderId: resp.current_provider_id || "",
      });
      const pending = this.pendingProviderModels;
      this.pendingProviderModels = null;
      if (pending) {
        await this.loadProviderModels(pending.name, pending.currentModel);
      }
    } catch (err) {
      // Non-fatal: the static deepseek-only <option> stays in place.
      this.panel.webview.postMessage({
        type: "error",
        message: `Failed to load providers: ${getErrorMessage(err)}`,
      });
    }
  }

  /**
   * Fetch the model catalog for a provider and push it to the webview so
   * the model <select> can be re-rendered.
   *
   * The caller passes the provider *name* — the value the `provider` config key
   * holds, which for a named custom route is the route's own name. The kind and
   * exact id are read from the catalog: those are what the model endpoint
   * takes, and the exact id is the only thing telling two named routes apart.
   */
  private async loadProviderModels(
    providerName: string,
    currentModel?: string,
  ): Promise<void> {
    const entry = this.providersCache?.find(
      p => (p.model_provider_id || p.id) === providerName
    );
    if (!entry && !this.providersCache) {
      this.pendingProviderModels = { name: providerName, currentModel };
      return;
    }
    const providerId = entry?.id ?? providerName;
    const modelProviderId = entry?.model_provider_id || undefined;
    try {
      const resp = await this.api.listProviderModels(providerId, modelProviderId);
      this.panel.webview.postMessage({
        type: "providerModels",
        provider: providerId,
        providerId: modelProviderId || "",
        models: resp.models.map(m => m.id),
        currentModel: currentModel || "",
        hasCatalog: entry ? entry.has_model_catalog : (resp.models.length > 0),
      });
    } catch (err) {
      this.panel.webview.postMessage({
        type: "error",
        message: `Failed to load models for ${providerName}: ${getErrorMessage(err)}`,
      });
    }
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type as string) {
      case "refresh":
        await this.loadConfig();
        break;
      case "setConfig": {
        const key = msg.key as string;
        const value = msg.value as string;
        try {
          const result = await this.api.setConfig({ key, value, persist: true });
          // Always reload after persisting — the reload endpoint now syncs
          // the new config to RuntimeThreadManager AND all active engines.
          await this.api.reloadConfig();
          this.panel.webview.postMessage({
            type: "setConfigResult",
            key: result.key,
            value: result.value,
            success: true,
          });
          // Refresh to show updated values
          await this.loadConfig();
        } catch (err) {
          this.panel.webview.postMessage({
            type: "setConfigResult",
            key,
            value,
            success: false,
            error: getErrorMessage(err),
          });
        }
        break;
      }
      case "setConfigBatch": {
        const changes = msg.changes as Record<string, string>;
        const keys = Object.keys(changes);
        let savedCount = 0;
        let lastError = "";
        for (const key of keys) {
          try {
            await this.api.setConfig({ key, value: changes[key], persist: true });
            savedCount++;
          } catch (err) {
            lastError = getErrorMessage(err);
          }
        }
        // Single reload after all keys are persisted
        try {
          await this.api.reloadConfig();
        } catch (err) {
          lastError = getErrorMessage(err);
        }
        this.panel.webview.postMessage({
          type: "setConfigBatchResult",
          saved: savedCount,
          total: keys.length,
          success: lastError === "",
          error: lastError,
        });
        // Refresh to show updated values
        await this.loadConfig();
        break;
      }
      case "reloadConfig":
        try {
          await this.api.reloadConfig();
          await this.loadConfig();
          this.panel.webview.postMessage({
            type: "reloadResult",
            success: true,
          });
        } catch (err) {
          this.panel.webview.postMessage({
            type: "reloadResult",
            success: false,
            error: getErrorMessage(err),
          });
        }
        break;
      case "switchProviderNow": {
        // The Provider select is a switch, not a form field. The endpoint and
        // the model list belong to the route the engine has actually selected —
        // nothing here can describe a route that is only pending, and the
        // `base_url` this form edits is that route's own endpoint. So the
        // selection is applied the way the toolbar picker applies one, and the
        // form is then re-read from the engine instead of being patched from
        // whatever the previous route's values happened to be.
        const providerName = (msg.provider ?? msg.value) as string;
        if (providerName) {
          const entry = this.providersCache?.find(
            p => (p.model_provider_id || p.id) === providerName
          );
          try {
            await this.api.switchProvider(
              entry?.id ?? providerName,
              undefined,
              entry?.model_provider_id || undefined
            );
            this.panel.webview.postMessage({
              type: "info",
              message: `Switched to ${providerName}. The form now describes that route.`,
            });
          } catch (err) {
            this.panel.webview.postMessage({
              type: "error",
              message: `Failed to switch provider: ${getErrorMessage(err)}`,
            });
          }
          // Re-read the engine either way: after a switch the form must show
          // the route that is now active, and after a refusal it must not keep
          // showing a provider that was never applied.
          await this.loadProviders();
          await this.loadConfig();
        }
        break;
      }
    }
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeWhale Config</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --border: var(--vscode-panel-border);
      --section-bg: var(--vscode-sideBar-background);
      --muted: var(--vscode-descriptionForeground);
      --focus: var(--vscode-focusBorder);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--fg);
      background: var(--bg);
      padding: 16px 24px;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .subtitle {
      color: var(--muted);
      margin-bottom: 20px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 6px 14px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--input-border);
    }
    button.secondary:hover { background: var(--input-bg); }
    .section {
      background: var(--section-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 18px;
      margin-bottom: 14px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border);
    }
    .field {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      gap: 12px;
    }
    .field:last-child { margin-bottom: 0; }
    .field-label {
      min-width: 160px;
      font-weight: 500;
      color: var(--muted);
    }
    .field-value {
      flex: 1;
    }
    select, input[type="text"] {
      width: 100%;
      padding: 4px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 3px;
      font-size: 13px;
      font-family: inherit;
    }
    select:focus, input[type="text"]:focus {
      outline: 1px solid var(--focus);
    }
    .status {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: 3px;
      font-size: 12px;
    }
    .status.success { background: #2ea04325; color: #2ea043; }
    .status.error { background: #f8514925; color: #f85149; }
    .status.info { background: #388bfd25; color: #388bfd; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>CodeWhale Configuration</h1>
  <p class="subtitle">Edit runtime configuration. Changes are persisted to config.toml and settings.json.</p>

  <div class="toolbar">
    <button id="btn-reload">Fetch from Backend</button>
    <button id="btn-save" class="secondary">Apply to Backend</button>
  </div>

  <div id="status" class="status info hidden"></div>

  <div id="config-form">
    <!-- Runtime Section -->
    <div class="section">
      <div class="section-title">Runtime</div>
      <div class="field">
        <span class="field-label">Model</span>
        <div class="field-value">
          <select id="cfg-model">
            <option value="deepseek-v4-pro">deepseek-v4-pro</option>
            <option value="deepseek-v4-flash">deepseek-v4-flash</option>
            <option value="auto">auto</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Default Mode</span>
        <div class="field-value">
          <select id="cfg-default_mode">
            ${MODE_OPTIONS}
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Reasoning Effort</span>
        <div class="field-value">
          <select id="cfg-reasoning_effort">
            <option value="auto">auto</option>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Permission Posture</span>
        <div class="field-value">
          <select id="cfg-approval_mode">
            ${POSTURE_OPTIONS}
          </select>
        </div>
      </div>
    </div>

    <!-- API Section -->
    <div class="section">
      <div class="section-title">API</div>
      <div class="field">
        <span class="field-label">Provider</span>
        <div class="field-value">
          <select id="cfg-provider">
            <option value="deepseek">deepseek</option>
            <!-- Dynamically populated from GET /v1/providers -->
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Base URL</span>
        <div class="field-value">
          <input type="text" id="cfg-base_url" placeholder="https://api.deepseek.com">
        </div>
      </div>
    </div>

    <!-- Behavior Section -->
    <div class="section">
      <div class="section-title">Behavior</div>
      <div class="field">
        <span class="field-label">Auto Compact</span>
        <div class="field-value">
          <select id="cfg-auto_compact">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Allow Shell</span>
        <div class="field-value">
          <select id="cfg-allow_shell">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Cost Currency</span>
        <div class="field-value">
          <select id="cfg-cost_currency">
            <option value="usd">usd</option>
            <option value="cny">cny</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Calm Mode</span>
        <div class="field-value">
          <select id="cfg-calm_mode">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Max History</span>
        <div class="field-value">
          <input type="text" id="cfg-max_history" placeholder="100">
        </div>
      </div>
      <div class="field">
        <span class="field-label">Prefer External pdftotext</span>
        <div class="field-value">
          <select id="cfg-prefer_external_pdftotext">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Follow Symlinks</span>
        <div class="field-value">
          <select id="cfg-workspace_follow_symlinks">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Display Section -->
    <div class="section">
      <div class="section-title">Display</div>
      <div class="field">
        <span class="field-label">Show Thinking</span>
        <div class="field-value">
          <select id="cfg-show_thinking">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Show Tool Details</span>
        <div class="field-value">
          <select id="cfg-show_tool_details">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Locale</span>
        <div class="field-value">
          <select id="cfg-locale">
            <option value="auto">auto</option>
            <option value="en">en</option>
            <option value="zh-Hans">zh-Hans</option>
            <option value="ja">ja</option>
            <option value="pt-BR">pt-BR</option>
            <option value="es-419">es-419</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Subagents Section -->
    <div class="section">
      <div class="section-title">Subagents</div>
      <div class="field">
        <span class="field-label">Enabled</span>
        <div class="field-value">
          <select id="cfg-subagents_enabled">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Max Depth</span>
        <div class="field-value">
          <input type="text" id="cfg-subagents_max_depth" placeholder="3">
        </div>
      </div>
    </div>

    <!-- MCP Section -->
    <div class="section">
      <div class="section-title">MCP</div>
      <div class="field">
        <span class="field-label">Config Path</span>
        <div class="field-value">
          <input type="text" id="cfg-mcp_config_path" placeholder="~/.deepseek/mcp.json">
        </div>
      </div>
    </div>

    <!-- Security & Tools Section -->
    <div class="section">
      <div class="section-title">Security &amp; Tools</div>
      <div class="field">
        <span class="field-label">Sandbox Mode</span>
        <div class="field-value">
          <select id="cfg-sandbox_mode">
            <option value="workspace-write">workspace-write</option>
            <option value="read-only">read-only</option>
            <option value="danger-full-access">danger-full-access</option>
            <option value="none">none</option>
            <option value="opensandbox">opensandbox</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Strict Tool Mode</span>
        <div class="field-value">
          <select id="cfg-strict_tool_mode">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Memory</span>
        <div class="field-value">
          <select id="cfg-memory_enabled">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Search Provider</span>
        <div class="field-value">
          <select id="cfg-search_provider">
            <option value="duckduckgo">duckduckgo</option>
            <option value="bing">bing</option>
            <option value="tavily">tavily</option>
            <option value="bocha">bocha</option>
            <option value="metaso">metaso</option>
            <option value="searxng">searxng</option>
            <option value="baidu">baidu</option>
            <option value="volcengine">volcengine</option>
            <option value="sofya">sofya</option>
          </select>
        </div>
      </div>
      <div class="field">
        <span class="field-label">Prompt Suggestion</span>
        <div class="field-value">
          <select id="cfg-prompt_suggestion">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentConfig = null;
    let pendingChanges = {};

    // ── Helpers ──

    function $(id) { return document.getElementById(id); }

    function showStatus(text, type) {
      const el = $('status');
      el.textContent = text;
      el.className = 'status ' + type;
      el.classList.remove('hidden');
      if (type !== 'error') {
        setTimeout(function() { el.classList.add('hidden'); }, 3000);
      }
    }

    function setFieldValue(id, value) {
      const el = $(id);
      if (!el) return;
      if (el.tagName === 'SELECT') {
        // Add option if not exists
        var found = false;
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].value === String(value)) { found = true; break; }
        }
        if (!found) {
          var opt = document.createElement('option');
          opt.value = String(value);
          opt.textContent = String(value);
          el.appendChild(opt);
        }
        el.value = String(value);
      } else {
        el.value = String(value);
      }
    }

    function getChangedFields() {
      var changes = {};
      var keys = ['model', 'default_mode', 'reasoning_effort', 'approval_mode',
                   'provider', 'base_url', 'auto_compact', 'allow_shell',
                   'cost_currency', 'calm_mode', 'max_history',
                   'prefer_external_pdftotext', 'workspace_follow_symlinks',
                   'show_thinking', 'show_tool_details', 'locale',
                   'subagents_enabled', 'subagents_max_depth',
                   'mcp_config_path',
                   'sandbox_mode', 'strict_tool_mode', 'memory_enabled',
                   'search_provider', 'prompt_suggestion'];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var el = $('cfg-' + key);
        if (!el) continue;
        var currentVal = currentConfig ? String(currentConfig[key]) : '';
        var newVal = el.value;
        if (newVal !== currentVal) {
          changes[key] = newVal;
        }
      }
      return changes;
    }

    // ── Populate from config data ──

    function populateForm(config) {
      currentConfig = config;
      var keys = Object.keys(config);
      for (var i = 0; i < keys.length; i++) {
        setFieldValue('cfg-' + keys[i], config[keys[i]]);
      }
    }

    // ── Event listeners ──

    $('btn-reload').addEventListener('click', function() {
      vscode.postMessage({ type: 'reloadConfig' });
      showStatus('Fetching from backend...', 'info');
    });

    $('btn-save').addEventListener('click', async function() {
      var changes = getChangedFields();
      var keys = Object.keys(changes);
      if (keys.length === 0) {
        showStatus('No changes to apply', 'info');
        return;
      }
      showStatus('Applying ' + keys.length + ' change(s)...', 'info');
      // Send all changes at once; the backend will persist each and
      // trigger a single reload after the batch completes.
      vscode.postMessage({ type: 'setConfigBatch', changes: changes });
    });

    // Changing the Provider select switches the engine's active route — it is
    // not a pending form edit. The endpoint and the model list of the selected
    // route can only be read from the route the engine actually runs, so this
    // applies the switch (the same call the toolbar picker makes) and the
    // backend then re-pushes both the config and the catalog.
    $('cfg-provider').addEventListener('change', function() {
      var providerName = this.value;
      if (providerName) {
        vscode.postMessage({ type: 'switchProviderNow', provider: providerName });
      }
    });

    // ── Message handling ──

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'configData') {
        populateForm(msg.config);
        showStatus('Config loaded', 'info');
      } else if (msg.type === 'providersData') {
        // Backend pushed the provider catalog — rebuild the provider <select>.
        var sel = $('cfg-provider');
        if (sel && Array.isArray(msg.providers)) {
          var activeExact = msg.currentProviderId || '';
          var exactKnown = !!activeExact;
          sel.innerHTML = '';
          var seen = {};
          for (var i = 0; i < msg.providers.length; i++) {
            var p = msg.providers[i];
            // A named [providers.<name>] route is stored in the "provider"
            // key under its own name; a built-in stores its id. Two named
            // routes share the generic id, so the exact id is the value.
            var value = p.model_provider_id || p.id;
            // The endpoint reports one entry per route, but never let a
            // duplicate value reach the form: a <select> cannot express it
            // and the user could not tell the two apart.
            if (seen[value]) continue;
            seen[value] = true;
            var opt = document.createElement('option');
            opt.value = value;
            opt.textContent = p.display_name || value;
            if (p.id === msg.current && (!exactKnown || (p.model_provider_id || '') === activeExact)) {
              opt.selected = true;
            }
            sel.appendChild(opt);
          }
        }
        // The Base URL this form edits is the active route's own endpoint, and
        // the engine writes it where that route reads it — except for a
        // user-defined [providers.<name>] route, whose endpoint lives in the
        // table it is named by and is not reachable through this key. Offer no
        // edit that cannot land: name the table it belongs to instead.
        var baseUrlEl = $('cfg-base_url');
        if (baseUrlEl) {
          var namedRoute = msg.current === 'custom' ? (msg.currentProviderId || '') : '';
          baseUrlEl.disabled = !!namedRoute;
          baseUrlEl.placeholder = namedRoute
            ? '[providers.' + namedRoute + '].base_url'
            : 'https://api.deepseek.com';
          baseUrlEl.title = namedRoute
            ? 'This route keeps its endpoint in [providers.' + namedRoute + '].base_url in config.toml'
            : '';
        }
      } else if (msg.type === 'providerModels') {
        // Backend pushed the model catalog for a provider — rebuild the
        // model <select>.
        var modelSel = $('cfg-model');
        if (modelSel && Array.isArray(msg.models)) {
          var explicitCurrentModel = typeof msg.currentModel === 'string'
            ? msg.currentModel.trim()
            : '';
          var hasExplicitCurrentModel = explicitCurrentModel.length > 0;
          var prev = hasExplicitCurrentModel ? explicitCurrentModel : modelSel.value;
          modelSel.innerHTML = '';
          if (msg.models.length === 0) {
            // Pass-through provider — add an "auto" placeholder.
            var autoOpt = document.createElement('option');
            autoOpt.value = 'auto';
            autoOpt.textContent = 'auto (enter model id manually)';
            modelSel.appendChild(autoOpt);
          }
          for (var j = 0; j < msg.models.length; j++) {
            var mOpt = document.createElement('option');
            mOpt.value = msg.models[j];
            mOpt.textContent = msg.models[j];
            if (msg.models[j] === prev) mOpt.selected = true;
            modelSel.appendChild(mOpt);
          }
          // If the previous value wasn't in the new list, add it as a
          // custom option so the user doesn't lose their choice. Skip this
          // when the backend has already told us the target provider's
          // explicit current model for the preview.
          if (!hasExplicitCurrentModel && prev && !msg.models.includes(prev)) {
            var customOpt = document.createElement('option');
            customOpt.value = prev;
            customOpt.textContent = prev + ' (custom)';
            customOpt.selected = true;
            modelSel.appendChild(customOpt);
          }
        }
      } else if (msg.type === 'setConfigResult') {        if (msg.success) {
          showStatus(msg.key + ' = ' + msg.value + ' applied', 'success');
        } else {
          showStatus('Failed to apply ' + msg.key + ': ' + msg.error, 'error');
        }
      } else if (msg.type === 'setConfigBatchResult') {
        if (msg.success) {
          showStatus(msg.saved + '/' + msg.total + ' config(s) applied and refreshed', 'success');
        } else {
          showStatus('Batch apply: ' + msg.saved + '/' + msg.total + ' applied. Error: ' + msg.error, 'error');
        }
      } else if (msg.type === 'info') {
        showStatus(msg.message, 'info');
      } else if (msg.type === 'reloadResult') {
        if (msg.success) {
          showStatus('Config fetched from backend', 'success');
        } else {
          showStatus('Fetch failed: ' + msg.error, 'error');
        }
      } else if (msg.type === 'error') {
        showStatus(msg.message, 'error');
      }
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    ConfigPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
