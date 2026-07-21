/**
 * Slash command handler with dispatcher pattern.
 *
 * Each command is registered as a named handler function, tied to
 * the SlashCommandRegistry in slash-commands.ts. The giant switch
 * statement is replaced by a Map lookup.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { t } from "../i18n";
import { formatCostAmount } from "../utils/cost-calculator";
import { isCommandAvailableInGui } from "./slash-commands";
import { formatError, getErrorMessage } from "../utils/error-handler";
import type { CodeWhaleApiClient, CodeWhaleEngine, ThreadRecord, TaskSummary, ProviderEntry } from "../types";

// ── Context interface for dependency injection ──

export interface SlashCommandContext {
  readonly api: CodeWhaleApiClient;
  readonly engine: CodeWhaleEngine;
  readonly currentThread: ThreadRecord | null;
  readonly messages: Array<{ role: string; content?: string }>;
  readonly sessionCostUsd: number;
  readonly sessionCostCny: number;
  readonly lastCacheHitTokens: number;
  readonly lastCacheMissTokens: number;
  readonly lastInputTokens: number;
  readonly lastOutputTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;

  postMessage(msg: Record<string, unknown>): void;
  getCurrentModel(): string;
  /** Returns the cached provider list from `GET /v1/providers`, or null if
   * not yet loaded. Slash handlers (`/provider`, `/models`) use this to
   * render dynamic output instead of the hard-coded deepseek-only list. */
  getProvidersCache(): ProviderEntry[] | null;
  /** Returns the active provider id, or null if not yet loaded. */
  getCurrentProvider(): string | null;
  /** Returns the current session ID tracking auto-save continuity, or null if none. */
  getCurrentSessionId(): string | null;
  /** Sets the current session ID for auto-save continuity. Pass null to reset. */
  setCurrentSessionId(id: string | null): void;
  /** Saves (or updates) a session snapshot from the engine's live state for the given thread. */
  saveCurrentSession(threadId: string, sessionId?: string): Promise<{ session_id: string }>;
  refreshSessionList(): void;
  refreshTaskList(): Promise<void>;
  refreshWorkPanel(): void;
  loadSessionMessages(sessionId: string): Promise<void>;
  handleInterrupt(): Promise<void>;
  handleCompact(): Promise<void>;
  handleUndoLastTurn(): Promise<void>;
  handleRetryLastTurn(): Promise<void>;
  handleAttachFile(): Promise<void>;
}

// ── Handler type ──

type CommandHandler = (ctx: SlashCommandContext, args: string) => Promise<void>;

// ── Helper: post "not available" message ──

function notAvailable(ctx: SlashCommandContext): void {
  ctx.postMessage({ type: "info", message: t().commandNotAvailableInGui });
}

// ── Helper: get config shortcut ──

function cfg() {
  return vscode.workspace.getConfiguration("brotherwhale");
}

function mergeThreadUpdate(
  ctx: SlashCommandContext,
  updatedThread: ThreadRecord | undefined,
  fallback: Partial<ThreadRecord>
): void {
  if (!ctx.currentThread) return;
  if (updatedThread) {
    Object.assign(ctx.currentThread, updatedThread);
    return;
  }
  Object.assign(ctx.currentThread, fallback);
}

// ── Individual command handlers ──

async function handleMode(ctx: SlashCommandContext, args: string): Promise<void> {
  const mode = args.trim().toLowerCase();
  if (["agent", "plan", "yolo", "1", "2", "3"].includes(mode)) {
    const modeMap: Record<string, string> = { "1": "agent", "2": "plan", "3": "yolo" };
    const actualMode = modeMap[mode] || mode;
    const isYolo = actualMode === "yolo";
    const defaultModel = cfg().get<string>("defaultModel", "deepseek-v4-pro");
    const reasoningEffort = cfg().get<string>("reasoningEffort", "auto");
    const autoApprove = isYolo || cfg().get<boolean>("autoApprove", false);
    await cfg().update("defaultMode", actualMode, vscode.ConfigurationTarget.Global);
    let modeForUi = actualMode;
    let modelForUi = defaultModel;
    let infoMessage = `Mode changed to ${actualMode}`;
    if (ctx.currentThread) {
      try {
        const updatedThread = await ctx.api.updateThread(ctx.currentThread.id, {
          mode: actualMode,
          trust_mode: isYolo,
          auto_approve: autoApprove,
        });
        mergeThreadUpdate(ctx, updatedThread, {
          mode: actualMode,
          trust_mode: isYolo,
          auto_approve: autoApprove,
        });
        modeForUi = ctx.currentThread.mode;
        modelForUi = ctx.currentThread.model;
      } catch (err) {
        ctx.postMessage({
          type: "error",
          message: `Mode changed in settings but failed to update current thread: ${getErrorMessage(err)}`,
        });
        modeForUi = ctx.currentThread.mode;
        modelForUi = ctx.currentThread.model;
        infoMessage = `Default mode changed to ${actualMode}; current thread remains ${ctx.currentThread.mode}`;
      }
    }
    ctx.postMessage({ type: "settingsUpdated", mode: modeForUi, model: modelForUi, reasoningEffort });
    ctx.postMessage({ type: "info", message: infoMessage });
  } else {
    ctx.postMessage({ type: "info", message: `Current mode: ${cfg().get<string>("defaultMode", "agent")}\nUsage: /mode [agent|plan|yolo|1|2|3]` });
  }
}

async function handleModel(ctx: SlashCommandContext, args: string): Promise<void> {
  const model = args.trim();
  if (model) {
    await cfg().update("defaultModel", model, vscode.ConfigurationTarget.Global);
    const defaultMode = cfg().get<string>("defaultMode", "agent");
    const reasoningEffort = cfg().get<string>("reasoningEffort", "auto");
    let modeForUi = defaultMode;
    let modelForUi = model;
    let infoMessage = `Model changed to ${model}`;
    if (ctx.currentThread) {
      try {
        const updatedThread = await ctx.api.updateThread(ctx.currentThread.id, { model });
        mergeThreadUpdate(ctx, updatedThread, { model });
        modeForUi = ctx.currentThread.mode;
        modelForUi = ctx.currentThread.model;
      } catch (err) {
        ctx.postMessage({
          type: "error",
          message: `Model changed in settings but failed to update current thread: ${getErrorMessage(err)}`,
        });
        modeForUi = ctx.currentThread.mode;
        modelForUi = ctx.currentThread.model;
        infoMessage = `Default model changed to ${model}; current thread remains ${ctx.currentThread.model}`;
      }
    }
    ctx.postMessage({ type: "settingsUpdated", mode: modeForUi, model: modelForUi, reasoningEffort });
    ctx.postMessage({ type: "info", message: infoMessage });
  } else {
    ctx.postMessage({ type: "info", message: `Current model: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}` });
  }
}

async function handleModels(ctx: SlashCommandContext, _args: string): Promise<void> {
  // Prefer the dynamic provider catalog when available. Falls back to the
  // legacy hard-coded list only if the backend hasn't returned a provider
  // list yet (e.g. older TUI runtime without GET /v1/providers).
  const providers = ctx.getProvidersCache();
  const currentProvider = ctx.getCurrentProvider();
  if (providers && providers.length > 0) {
    const target = providers.find(p => p.id === currentProvider) || providers[0];
    const lines: string[] = [`Available models for provider ${target.id} (${target.display_name}):`];
    if (target.has_model_catalog) {
      // Fetch live catalog via the API for accuracy. This is async but
      // handleModels is already async, so we can await it.
      try {
        const resp = await ctx.api.listProviderModels(target.id);
        for (const m of resp.models) {
          lines.push(`- ${m.id}${m.id === ctx.getCurrentModel() ? " (current)" : ""}`);
        }
      } catch (err) {
        lines.push(`(failed to fetch model list: ${getErrorMessage(err)})`);
      }
    } else {
      lines.push("(this provider exposes no built-in model list; pass any model id to /model)");
    }
    lines.push("");
    lines.push(`Tip: switch provider via /provider <id>. Available providers: ${providers.map(p => p.id).join(", ")}`);
    ctx.postMessage({ type: "info", message: lines.join("\n") });
    return;
  }
  ctx.postMessage({ type: "info", message: "Available models:\n- deepseek-v4-pro\n- deepseek-v4-flash\n- deepseek-chat (alias for deepseek-v4-flash)\n- deepseek-reasoner (alias for deepseek-v4-flash)" });
}

async function handleReasoning(ctx: SlashCommandContext, args: string): Promise<void> {
  const effort = args.trim().toLowerCase();
  if (["auto", "off", "low", "medium", "high", "max"].includes(effort)) {
    await cfg().update("reasoningEffort", effort, vscode.ConfigurationTarget.Global);
    ctx.postMessage({ type: "settingsUpdated", mode: cfg().get<string>("defaultMode", "agent"), model: cfg().get<string>("defaultModel", "deepseek-v4-pro"), reasoningEffort: effort });
    ctx.postMessage({ type: "info", message: `Reasoning effort changed to ${effort}` });
  } else {
    ctx.postMessage({ type: "info", message: `Current reasoning effort: ${cfg().get<string>("reasoningEffort", "auto")}\nUsage: /reasoning [auto|off|low|medium|high|max]` });
  }
}

async function handleConfig(ctx: SlashCommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    // No args: open the config panel
    ctx.postMessage({ type: "openConfigPanel" });
    return;
  }

  // Parse "key value" or "key=value"
  const parts = trimmed.split(/[\s=]+/, 2);
  if (parts.length < 2) {
    // Just a key: show current value
    try {
      const config = await ctx.api.getConfig();
      const key = parts[0].toLowerCase();
      const value = (config as unknown as Record<string, unknown>)[key];
      if (value !== undefined) {
        ctx.postMessage({ type: "info", message: `${key} = ${value}` });
      } else {
        ctx.postMessage({ type: "error", message: `Unknown config key '${key}'` });
      }
    } catch (err) {
      ctx.postMessage({ type: "error", message: `Failed to read config: ${getErrorMessage(err)}` });
    }
    return;
  }

  const [key, value] = parts;
  try {
    const result = await ctx.api.setConfig({ key, value, persist: true });
    if (result.requires_reload) {
      await ctx.api.reloadConfig();
      ctx.postMessage({ type: "info", message: `${result.key} = ${result.value} (saved & reloaded)` });
    } else {
      ctx.postMessage({ type: "info", message: `${result.key} = ${result.value} (saved)` });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: `Failed to set config: ${getErrorMessage(err)}` });
  }
}

async function handleSettings(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: `Current settings:\n- Mode: ${cfg().get<string>("defaultMode", "agent")}\n- Model: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}\n- Reasoning Effort: ${cfg().get<string>("reasoningEffort", "auto")}\n- Engine Path: ${cfg().get<string>("enginePath", "codewhale")}\n- Auto Start Engine: ${cfg().get<boolean>("autoStartEngine", true)}` });
}

async function handleInterrupt(ctx: SlashCommandContext, _args: string): Promise<void> {
  await ctx.handleInterrupt();
}

async function handleClear(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "clearChat" });
}

async function handleCompact(ctx: SlashCommandContext, _args: string): Promise<void> {
  await ctx.handleCompact();
}

async function handleExit(_ctx: SlashCommandContext, _args: string): Promise<void> {
  vscode.commands.executeCommand("workbench.action.closeSidebar");
}

async function handleRename(ctx: SlashCommandContext, args: string): Promise<void> {
  const title = args.trim();
  if (title && ctx.currentThread) {
    try {
      await ctx.api.updateThread(ctx.currentThread.id, { title });
      ctx.postMessage({ type: "info", message: `Thread renamed to: ${title}` });
      ctx.refreshSessionList();
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to rename", err) });
    }
  } else if (!ctx.currentThread) {
    ctx.postMessage({ type: "error", message: "No active thread to rename" });
  } else {
    ctx.postMessage({ type: "error", message: "Usage: /rename <new title>" });
  }
}

async function handleSave(ctx: SlashCommandContext, _args: string): Promise<void> {
  if (ctx.currentThread) {
    try {
      const result = await ctx.saveCurrentSession(
        ctx.currentThread.id,
        ctx.getCurrentSessionId() ?? undefined,
      );
      ctx.setCurrentSessionId(result.session_id);
      ctx.refreshSessionList();
      ctx.postMessage({ type: "info", message: `Session saved (${result.session_id.slice(0, 8)})` });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to save", err) });
    }
  } else {
    ctx.postMessage({ type: "error", message: "No active thread to save" });
  }
}

async function handleExport(ctx: SlashCommandContext, _args: string): Promise<void> {
  if (ctx.currentThread) {
    try {
      const detail = await ctx.api.getThreadDetail(ctx.currentThread.id);
      const content = JSON.stringify(detail, null, 2);
      const doc = await vscode.workspace.openTextDocument({ content, language: "json" });
      vscode.window.showTextDocument(doc);
      ctx.postMessage({ type: "info", message: "Conversation exported" });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to export", err) });
    }
  } else {
    ctx.postMessage({ type: "error", message: "No active thread to export" });
  }
}

async function handleContext(ctx: SlashCommandContext, _args: string): Promise<void> {
  if (ctx.currentThread) {
    ctx.postMessage({ type: "info", message: `Thread: ${ctx.currentThread.id.slice(0, 12)}...\nMessages: ${ctx.messages.length}\nMode: ${cfg().get<string>("defaultMode", "agent")}\nModel: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}` });
  } else {
    ctx.postMessage({ type: "info", message: "No active thread" });
  }
}

async function handleTokens(ctx: SlashCommandContext, args: string): Promise<void> {
  const tokenArg = args.trim().toLowerCase();

  if (tokenArg === "history" || tokenArg === "all" || tokenArg === "today" || tokenArg.startsWith("since ")) {
    try {
      await ctx.api.ensureReady();

      let since: string | undefined;
      let until: string | undefined;

      if (tokenArg === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        since = today.toISOString();
      } else if (tokenArg.startsWith("since ")) {
        const dateStr = tokenArg.slice(6).trim();
        try {
          const date = new Date(dateStr);
          since = date.toISOString();
        } catch {
          ctx.postMessage({ type: "error", message: `Invalid date format: ${dateStr}\nUsage: /tokens since YYYY-MM-DD` });
          return;
        }
      }

      const usage = await ctx.api.getUsage({ since, until, group_by: "day" });
      const totals = usage.totals;
      const cacheRate = totals.cached_tokens > 0
        ? ((totals.cached_tokens / (totals.input_tokens + totals.cached_tokens)) * 100).toFixed(1)
        : "0";

      const timeRange = usage.since && usage.until
        ? `${new Date(usage.since).toLocaleDateString()} - ${new Date(usage.until).toLocaleDateString()}`
        : "All time";

      ctx.postMessage({
        type: "info",
        message: `Token Usage (history - ${timeRange}):
  Total input: ${totals.input_tokens.toLocaleString()}
  Total output: ${totals.output_tokens.toLocaleString()}
  Cached tokens: ${totals.cached_tokens.toLocaleString()} (${cacheRate}% cache rate)
  Reasoning tokens: ${totals.reasoning_tokens.toLocaleString()}
  Total turns: ${totals.turns.toLocaleString()}
  Estimated cost: $${totals.cost_usd.toFixed(2)}

Usage: /tokens [history|today|since <date>]`
      });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to get usage history", err) });
    }
  } else {
    const currency = cfg().get<string>("costCurrency", "usd");
    const costStr = currency === "cny"
      ? formatCostAmount(ctx.sessionCostCny, "cny")
      : formatCostAmount(ctx.sessionCostUsd, "usd");
    const cacheTotal = ctx.lastCacheHitTokens + ctx.lastCacheMissTokens;
    const cacheRate = cacheTotal > 0 ? (ctx.lastCacheHitTokens / cacheTotal * 100).toFixed(1) : "N/A";
    ctx.postMessage({ type: "info", message: `Token Usage (session):\n  Total input: ${ctx.totalInputTokens.toLocaleString()}\n  Total output: ${ctx.totalOutputTokens.toLocaleString()}\n  Last turn input: ${ctx.lastInputTokens.toLocaleString()}\n  Last turn output: ${ctx.lastOutputTokens.toLocaleString()}\n  Cache hit rate (last): ${cacheRate}%\n  Cache hit: ${ctx.lastCacheHitTokens.toLocaleString()} | miss: ${ctx.lastCacheMissTokens.toLocaleString()}\n  Estimated cost: ${costStr}\n\nUsage: /tokens [history|today|since <date>] for historical data` });
  }
}

async function handleCost(ctx: SlashCommandContext, args: string): Promise<void> {
  const costArg = args.trim().toLowerCase();

  if (costArg === "history" || costArg === "all" || costArg === "today" || costArg.startsWith("since ")) {
    try {
      await ctx.api.ensureReady();

      let since: string | undefined;
      let until: string | undefined;

      if (costArg === "today") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        since = today.toISOString();
      } else if (costArg.startsWith("since ")) {
        const dateStr = costArg.slice(6).trim();
        try {
          const date = new Date(dateStr);
          since = date.toISOString();
        } catch {
          ctx.postMessage({ type: "error", message: `Invalid date format: ${dateStr}\nUsage: /cost since YYYY-MM-DD` });
          return;
        }
      }

      const usage = await ctx.api.getUsage({ since, until, group_by: "day" });
      const totals = usage.totals;
      const cacheRate = totals.cached_tokens > 0
        ? ((totals.cached_tokens / (totals.input_tokens + totals.cached_tokens)) * 100).toFixed(1)
        : "0";

      const timeRange = usage.since && usage.until
        ? `${new Date(usage.since).toLocaleDateString()} - ${new Date(usage.until).toLocaleDateString()}`
        : "All time";

      const currency = cfg().get<string>("costCurrency", "usd");
      const costDisplay = currency === "cny"
        ? `¥${(totals.cost_usd * 7.2).toFixed(2)} (≈ $${totals.cost_usd.toFixed(2)})`
        : `$${totals.cost_usd.toFixed(2)}`;

      ctx.postMessage({
        type: "info",
        message: `Cost Summary (history - ${timeRange}):
  Total cost: ${costDisplay}
  Tokens: ↥${totals.input_tokens.toLocaleString()} ↧${totals.output_tokens.toLocaleString()}
  Cache hit rate: ${cacheRate}% (${totals.cached_tokens.toLocaleString()} cached)
  Reasoning tokens: ${totals.reasoning_tokens.toLocaleString()}
  Total turns: ${totals.turns.toLocaleString()}

Usage: /cost [history|today|since <date>]`
      });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to get cost history", err) });
    }
  } else {
    const currency = cfg().get<string>("costCurrency", "usd");
    const costStr = currency === "cny"
      ? formatCostAmount(ctx.sessionCostCny, "cny")
      : formatCostAmount(ctx.sessionCostUsd, "usd");
    const cacheTotal = ctx.lastCacheHitTokens + ctx.lastCacheMissTokens;
    const cacheRate = cacheTotal > 0 ? (ctx.lastCacheHitTokens / cacheTotal * 100).toFixed(1) : "N/A";
    ctx.postMessage({ type: "info", message: `Session Cost (approximate):\n  Total: ${costStr}\n  Tokens: ↥${ctx.totalInputTokens.toLocaleString()} ↧${ctx.totalOutputTokens.toLocaleString()}\n  Cache hit rate: ${cacheRate}% (hit: ${ctx.lastCacheHitTokens.toLocaleString()}, miss: ${ctx.lastCacheMissTokens.toLocaleString()})\n  Model: ${ctx.getCurrentModel()}\n\nUsage: /cost [history|today|since <date>] for historical data` });
  }
}

async function handleStatus(ctx: SlashCommandContext, _args: string): Promise<void> {
  try {
    await ctx.api.ensureReady();

    const runtimeInfo = await ctx.api.getRuntimeInfo();
    const running = ctx.engine.isRunning;
    const authInfo = runtimeInfo.auth_required ? "✓ (token required)" : "✗ (no auth)";

    ctx.postMessage({
      type: "info",
      message: `Runtime Status:
  Engine: ${running ? "Running ✓" : "Stopped ✗"}
  Host: ${runtimeInfo.bind_host}:${runtimeInfo.port}
  Version: ${runtimeInfo.version}
  Auth: ${authInfo}
  Thread: ${ctx.currentThread ? ctx.currentThread.id.slice(0, 12) + "..." : "None"}
  Mode: ${cfg().get<string>("defaultMode", "agent")}
  Model: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}`
    });
  } catch (err) {
    const running = ctx.engine.isRunning;
    ctx.postMessage({
      type: "info",
      message: `Engine: ${running ? "Running" : "Stopped"}\nPort: ${ctx.engine.port}\nThread: ${ctx.currentThread ? ctx.currentThread.id.slice(0, 12) + "..." : "None"}\nMode: ${cfg().get<string>("defaultMode", "agent")}\nModel: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}\n(${formatError("Runtime info unavailable", err)})`
    });
  }
}

async function handleHome(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: `Dashboard:\n- Threads: see sidebar\n- Mode: ${cfg().get<string>("defaultMode", "agent")}\n- Model: ${cfg().get<string>("defaultModel", "deepseek-v4-pro")}\n- Reasoning: ${cfg().get<string>("reasoningEffort", "auto")}` });
}

async function handleWorkspace(ctx: SlashCommandContext, _args: string): Promise<void> {
  try {
    await ctx.api.ensureReady();

    const status = await ctx.api.getWorkspaceStatus();
    const wsPath = status.workspace;
    const gitInfo = status.git_repo
      ? `\n  Git repo: ✓\n  Branch: ${status.branch || "N/A"}\n  Staged: ${status.staged} files\n  Unstaged: ${status.unstaged} files\n  Untracked: ${status.untracked} files\n  Ahead/Behind: ${status.ahead ?? 0}/${status.behind ?? 0}`
      : "\n  Git repo: ✗ (not a git repository)";

    ctx.postMessage({
      type: "info",
      message: `Workspace: ${wsPath}${gitInfo}\n\nUsage: /workspace [path] to change workspace (not implemented in GUI)`
    });
  } catch (err) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "N/A";
    ctx.postMessage({ type: "info", message: `Workspace: ${ws}\n(${formatError("Git status unavailable", err)})` });
  }
}

async function handleTask(ctx: SlashCommandContext, args: string): Promise<void> {
  const taskSub = args.trim().split(/\s+/)[0]?.toLowerCase() || "";
  const taskRest = args.trim().slice(taskSub.length).trim();
  try {
    await ctx.api.ensureReady();
    if (taskSub === "add" && taskRest) {
      const taskCfg = vscode.workspace.getConfiguration("brotherwhale");
      const task = await ctx.api.createTask({
        prompt: taskRest,
        model: taskCfg.get<string>("defaultModel", "deepseek-v4-pro"),
        mode: taskCfg.get<string>("defaultMode", "agent"),
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        auto_approve: taskCfg.get<boolean>("autoApprove", false),
      });
      ctx.postMessage({ type: "info", message: `Task created: ${task.id.slice(0, 8)} — "${taskRest.slice(0, 60)}" [${task.status}]` });
      await ctx.refreshTaskList();
    } else if (taskSub === "show" && taskRest) {
      const task = await ctx.api.getTask(taskRest);
      ctx.postMessage({ type: "taskDetail", task });
    } else if (taskSub === "cancel" && taskRest) {
      await ctx.api.cancelTask(taskRest);
      ctx.postMessage({ type: "info", message: `Task ${taskRest.slice(0, 8)} cancelled.` });
      await ctx.refreshTaskList();
    } else {
      const result = await ctx.api.listTasks({ limit: 20 });
      const tasks = result.tasks;
      if (tasks && tasks.length > 0) {
        const lines = tasks.map((t: TaskSummary) => {
          const statusIcon = t.status === "completed" ? "✓" : t.status === "running" ? "⟳" : t.status === "failed" ? "✗" : t.status === "queued" ? "⏳" : "·";
          return `${statusIcon} ${t.id.slice(0, 8)}: ${t.prompt_summary.slice(0, 40)} [${t.status}]`;
        });
        ctx.postMessage({ type: "info", message: `Tasks (${tasks.length}):\n${lines.join("\n")}\n\nUsage: /task add <prompt> | /task show <id> | /task cancel <id>` });
      } else {
        ctx.postMessage({ type: "info", message: "No tasks.\n\nUsage: /task add <prompt> | /task list | /task show <id> | /task cancel <id>" });
      }
    }
  } catch (err) {
    ctx.postMessage({ type: "info", message: `${formatError("Task error", err)}\n\nUsage: /task add <prompt> | /task list | /task show <id> | /task cancel <id>` });
  }
}

async function handleTrust(ctx: SlashCommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();
  if (sub === "on") {
    await cfg().update("autoApprove", true, vscode.ConfigurationTarget.Global);
    if (ctx.currentThread) {
      try {
        await ctx.api.updateThread(ctx.currentThread.id, { auto_approve: true, trust_mode: true });
      } catch { /* non-critical */ }
    }
    ctx.postMessage({ type: "info", message: "Trust mode enabled (auto-approve)" });
  } else if (sub === "off") {
    const isYolo = cfg().get<string>("defaultMode", "agent") === "yolo";
    await cfg().update("autoApprove", false, vscode.ConfigurationTarget.Global);
    if (ctx.currentThread) {
      try {
        await ctx.api.updateThread(ctx.currentThread.id, { auto_approve: isYolo, trust_mode: isYolo });
      } catch { /* non-critical */ }
    }
    ctx.postMessage({ type: "info", message: "Trust mode disabled" });
  } else {
    ctx.postMessage({ type: "info", message: `Usage: /trust [on|off]\nAuto-approve is currently: ${cfg().get<boolean>("autoApprove", false) ? "on" : "off"}` });
  }
}

async function handleVerbose(ctx: SlashCommandContext, args: string): Promise<void> {
  const sub = args.trim().toLowerCase();
  if (sub === "on") {
    await cfg().update("verbose", true, vscode.ConfigurationTarget.Global);
    ctx.postMessage({ type: "info", message: "Verbose mode enabled" });
  } else if (sub === "off") {
    await cfg().update("verbose", false, vscode.ConfigurationTarget.Global);
    ctx.postMessage({ type: "info", message: "Verbose mode disabled" });
  } else {
    ctx.postMessage({ type: "info", message: `Verbose mode: ${cfg().get<boolean>("verbose", false) ? "on" : "off"}\nUsage: /verbose [on|off]` });
  }
}

async function handleInit(ctx: SlashCommandContext, _args: string): Promise<void> {
  vscode.commands.executeCommand("workbench.action.openSettings", "brotherwhale");
  ctx.postMessage({ type: "info", message: "Use the VSCode settings to configure CodeWhale. Open settings with /config." });
}

async function handleMcp(ctx: SlashCommandContext, _args: string): Promise<void> {
  vscode.commands.executeCommand("workbench.action.openSettings", "brotherwhale");
  ctx.postMessage({ type: "info", message: "MCP server configuration is available in VSCode settings." });
}

async function handleProvider(ctx: SlashCommandContext, args: string): Promise<void> {
  const trimmed = args.trim();
  const providers = ctx.getProvidersCache();
  const current = ctx.getCurrentProvider();

  // /provider <id> [model] — switch provider (and optionally model).
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    const providerId = parts[0];
    const model = parts.slice(1).join(" ") || undefined;
    const known = providers?.find(p => p.id === providerId);
    if (providers && !known) {
      ctx.postMessage({
        type: "error",
        message: `Unknown provider '${providerId}'. Available: ${providers.map(p => p.id).join(", ")}`,
      });
      return;
    }
    // Delegate to the chat-provider's switchProvider flow (persist + reload +
    // refresh). Posting a switchProvider message lets the chat-provider own
    // the state machine instead of duplicating it here.
    ctx.postMessage({ type: "switchProviderFromSlash", provider: providerId, model });
    return;
  }

  // /provider — show current provider + available list.
  const lines: string[] = [];
  if (current) {
    lines.push(`Current provider: ${current}`);
  } else {
    lines.push("Current provider: (unknown — backend has not reported yet)");
  }
  if (providers && providers.length > 0) {
    lines.push("");
    lines.push("Available providers (use /provider <id> [model] to switch):");
    for (const p of providers) {
      const marker = p.id === current ? " *" : "";
      lines.push(`- ${p.id}${marker}  (${p.display_name})`);
    }
  } else {
    lines.push("");
    lines.push("Provider catalog not yet loaded. Use /config to set `provider` manually.");
  }
  ctx.postMessage({ type: "info", message: lines.join("\n") });
}

async function handleLinks(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: "DeepSeek Links:\n- API: https://api.deepseek.com\n- Docs: https://api-docs.deepseek.com\n- Status: https://status.deepseek.com" });
}

async function handleFeedback(_ctx: SlashCommandContext, _args: string): Promise<void> {
  vscode.commands.executeCommand("workbench.action.openIssueReporter");
}

async function handleHelp(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: `Available commands:
/mode [agent|plan|yolo|1|2|3] - Switch mode
/model [name] - Switch model
/models - List available models
/reasoning [auto|off|low|medium|high|max] - Set reasoning effort
/config - Open VSCode settings
/settings - Show current settings
/clear - Clear chat
/compact - Compact context
/interrupt - Interrupt current turn (use when stuck)
/rename <title> - Rename thread
/save - Save conversation
/export - Export conversation
/context - Show context info
/status - Show engine status
/workspace [path] - Show/set workspace
/trust [on|off] - Toggle trust mode
/verbose [on|off] - Toggle verbose mode
/skills - List all available skills with status
/skill <name> [on|off] - Enable or disable a skill
/init - Open settings for initialization
/mcp - Open MCP settings
/provider - Show provider info
/links - Show CodeWhale links
/feedback - Send feedback
/exit - Close sidebar

Commands with limited support in GUI:
/task, /jobs, /note, /memory, /undo, /retry, /share,
/goal, /network, /queue, /stash, /hooks, /subagents,
/agent, /attach, /anchor, /sessions, /load, /cycles,
/cycle, /recall, /relay, /lsp, /review, /restore, /rlm,
/change, /cache, /profile, /translate, /system, /edit,
/diff, /logout, /tokens, /cost, /home

Use the TUI for full command support.` });
}

async function handleUndo(ctx: SlashCommandContext, _args: string): Promise<void> {
  await ctx.handleUndoLastTurn();
}

async function handleRetry(ctx: SlashCommandContext, _args: string): Promise<void> {
  await ctx.handleRetryLastTurn();
}

async function handleGoal(ctx: SlashCommandContext, args: string): Promise<void> {
  try {
    const goalArg = args.trim();
    if (goalArg === "clear" || goalArg === "reset" || goalArg === "done") {
      await cfg().update("goalObjective", undefined, vscode.ConfigurationTarget.Global);
      await cfg().update("goalTokenBudget", undefined, vscode.ConfigurationTarget.Global);
      ctx.postMessage({ type: "info", message: "Goal cleared." });
    } else if (goalArg) {
      const pipeIdx = goalArg.indexOf("|");
      let objective = goalArg;
      let budget: number | undefined;
      if (pipeIdx >= 0) {
        objective = goalArg.slice(0, pipeIdx).trim();
        const budgetStr = goalArg.slice(pipeIdx + 1).trim();
        const budgetMatch = budgetStr.match(/budget:\s*(\d+)/i);
        if (budgetMatch) budget = parseInt(budgetMatch[1], 10);
      }
      await cfg().update("goalObjective", objective, vscode.ConfigurationTarget.Global);
      if (budget) await cfg().update("goalTokenBudget", budget, vscode.ConfigurationTarget.Global);
      const budgetStr = budget ? ` (budget: ${budget} tokens)` : "";
      ctx.postMessage({ type: "info", message: `Goal set: "${objective}"${budgetStr} — tracking progress.` });
    } else {
      const currentGoal = cfg().get<string | undefined>("goalObjective");
      if (currentGoal) {
        const currentBudget = cfg().get<number | undefined>("goalTokenBudget");
        const budgetStr = currentBudget ? ` (budget: ${currentBudget} tokens)` : "";
        ctx.postMessage({ type: "info", message: `Current goal: "${currentGoal}"${budgetStr}` });
      } else {
        ctx.postMessage({ type: "info", message: "No goal set.\nUsage: /goal <objective> [| budget: <tokens>]\n/goal clear — clear current goal" });
      }
    }
    ctx.refreshWorkPanel();
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Goal error", err) });
  }
}

async function handleSkills(ctx: SlashCommandContext, _args: string): Promise<void> {
  try {
    await ctx.api.ensureReady();
    const result = await ctx.api.listSkills();
    const skills = result.skills;
    if (skills && skills.length > 0) {
      const userSkills = skills.filter(s => !s.is_bundled);
      const bundledSkills = skills.filter(s => s.is_bundled);

      let output = `Available skills (${skills.length}):\n─────────────────────────────\n`;

      if (userSkills.length > 0) {
        output += `Your skills (${userSkills.length}):\n`;
        for (const s of userSkills) {
          const statusIcon = s.enabled ? "✓" : "○";
          output += `  ${statusIcon} /${s.name} - ${s.description || "(no description)"}\n`;
        }
        if (bundledSkills.length > 0) output += "\n";
      }

      if (bundledSkills.length > 0) {
        output += `Built-in skills (${bundledSkills.length}):\n`;
        if (userSkills.length > 0) {
          const names = bundledSkills.map(s => `/${s.name}`).join(", ");
          output += `  ${names}\n`;
          output += `  (run /skills <name> for details on a built-in)\n`;
        } else {
          for (const s of bundledSkills) {
            const statusIcon = s.enabled ? "✓" : "○";
            output += `  ${statusIcon} /${s.name} - ${s.description || "(no description)"}\n`;
          }
        }
      }

      const warnings = result.warnings && result.warnings.length > 0
        ? `\nWarnings:\n${result.warnings.map(w => `  - ${w}`).join("\n")}\n`
        : "";

      const dirInfo = result.directories && result.directories.length > 1
        ? `Skills directories:\n${result.directories.map(d => `  - ${d}`).join("\n")}`
        : `Skills directory: ${result.directory}`;

      ctx.postMessage({
        type: "info",
        message: `${output}\nUse /skill <name> [on|off] to enable/disable\n${dirInfo}${warnings}`
      });
    } else {
      const dirInfo = result.directories && result.directories.length > 1
        ? `Skills directories:\n${result.directories.map(d => `  - ${d}`).join("\n")}`
        : `Skills directory: ${result.directory}`;
      ctx.postMessage({
        type: "info",
        message: `No skills found.\n${dirInfo}\n\nSkills are auto-triggered when enabled and task matches.\nCreate skills in ~/.codewhale/skills/<name>/SKILL.md`
      });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Failed to list skills", err) });
  }
}

async function handleSkill(ctx: SlashCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const skillName = parts[0];
  const action = parts[1]?.toLowerCase() || "";

  if (!skillName) {
    ctx.postMessage({ type: "error", message: "Usage: /skill <name> [on|off]" });
    return;
  }

  try {
    await ctx.api.ensureReady();

    if (action === "on" || action === "enable" || action === "") {
      const result = await ctx.api.setSkillEnabled(skillName, true);
      ctx.postMessage({ type: "info", message: `Skill '${result.name}' enabled. It will auto-trigger when task matches.` });
    } else if (action === "off" || action === "disable") {
      const result = await ctx.api.setSkillEnabled(skillName, false);
      ctx.postMessage({ type: "info", message: `Skill '${result.name}' disabled.` });
    } else {
      ctx.postMessage({ type: "error", message: `Unknown action: ${action}\nUsage: /skill <name> [on|off]` });
    }
  } catch (err) {
    const errorMsg = formatError("Failed to toggle skill", err);
    if (getErrorMessage(err).includes("not found")) {
      ctx.postMessage({ type: "error", message: `Skill '${skillName}' not found. Use /skills to list available skills.` });
    } else {
      ctx.postMessage({ type: "error", message: errorMsg });
    }
  }
}

async function handleAttach(ctx: SlashCommandContext, _args: string): Promise<void> {
  await ctx.handleAttachFile();
}

async function handleAnchor(ctx: SlashCommandContext, args: string): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    ctx.postMessage({ type: "info", message: "No workspace open. Anchors require an open workspace." });
    return;
  }
  const anchorDir = path.join(ws, ".deepseek");
  const anchorPath = path.join(anchorDir, "anchors.md");
  const anchorArg = args.trim();
  const anchorSub = anchorArg.split(/\s+/)[0]?.toLowerCase();
  const anchorRest = anchorArg.slice(anchorSub.length).trim();

  if (!anchorArg || anchorSub === "help") {
    ctx.postMessage({ type: "info", message: `Usage: /anchor <text> | /anchor list | /anchor remove <n>\nAnchors are auto-injected after compaction.\nAnchors path: ${anchorPath}` });
    return;
  }

  try {
    if (!fs.existsSync(anchorDir)) fs.mkdirSync(anchorDir, { recursive: true });
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Failed to create .deepseek directory", err) });
    return;
  }

  try {
    if (anchorSub === "list") {
      if (!fs.existsSync(anchorPath)) {
        ctx.postMessage({ type: "info", message: "No anchors set." });
      } else {
        const content = fs.readFileSync(anchorPath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        if (lines.length === 0) {
          ctx.postMessage({ type: "info", message: "No anchors set." });
        } else {
          ctx.postMessage({ type: "info", message: `Anchors (${lines.length}):\n${lines.map((l, i) => `${i + 1}. ${l.replace(/^[-*]\s*/, "")}`).join("\n")}` });
        }
      }
    } else if (anchorSub === "remove" || anchorSub === "rm" || anchorSub === "delete") {
      const idx = parseInt(anchorRest, 10);
      if (isNaN(idx) || idx < 1) {
        ctx.postMessage({ type: "error", message: "Usage: /anchor remove <n>" });
        return;
      }
      if (!fs.existsSync(anchorPath)) {
        ctx.postMessage({ type: "error", message: "No anchors file." });
        return;
      }
      const content = fs.readFileSync(anchorPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);
      if (idx > lines.length) {
        ctx.postMessage({ type: "error", message: `Anchor ${idx} not found. Only ${lines.length} anchors.` });
        return;
      }
      lines.splice(idx - 1, 1);
      fs.writeFileSync(anchorPath, lines.join("\n") + "\n");
      ctx.postMessage({ type: "info", message: `Removed anchor ${idx}.` });
    } else {
      const text = anchorArg;
      const entry = `- ${text}\n`;
      fs.appendFileSync(anchorPath, entry);
      ctx.postMessage({ type: "info", message: `Anchor added: ${text}` });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Anchor error", err) });
  }
}

async function handleSessions(ctx: SlashCommandContext, args: string): Promise<void> {
  try {
    await ctx.api.ensureReady();

    const searchArg = args.trim();
    const searchMatch = searchArg.match(/^search\s+(.+)$/i);
    const searchQuery = searchMatch ? searchMatch[1].trim() : undefined;

    const result = await ctx.api.listSessions({ limit: 20, search: searchQuery });
    const sessions = result.sessions;

    if (sessions && sessions.length > 0) {
      const lines = sessions.map((s) => {
        const date = new Date(s.updated_at).toLocaleDateString();
        const tokens = s.total_tokens > 0 ? ` (${s.total_tokens.toLocaleString()} tokens)` : "";
        const mode = s.mode || "agent";
        const costUsd = s.cost?.session_cost_usd ?? 0;
        const cost = costUsd > 0 ? ` $${costUsd.toFixed(2)}` : "";
        const shortId = s.id.slice(0, 8);
        return `${shortId}: "${s.title.slice(0, 40)}" [${mode}] ${date}${tokens}${cost}`;
      });

      const searchHint = searchQuery ? ` matching "${searchQuery}"` : "";
      ctx.postMessage({
        type: "info",
        message: `Saved sessions${searchHint} (${sessions.length}):\n${lines.join("\n")}\n\nUsage: /load <session-id> to resume a session\nYou can use short ID (e.g., /load ${sessions[0]?.id.slice(0, 8)})\n/sessions search <query> to filter`
      });
    } else {
      const searchHint = searchQuery ? ` matching "${searchQuery}"` : "";
      ctx.postMessage({
        type: "info",
        message: `No saved sessions found${searchHint}.\n\nGUI no longer auto-creates session records.\nUsage: /sessions [search <query>]`
      });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Failed to list sessions", err) });
  }
}

async function handleLoad(ctx: SlashCommandContext, args: string): Promise<void> {
  const sessionIdInput = args.trim();

  if (!sessionIdInput) {
    ctx.postMessage({ type: "error", message: "Usage: /load <session-id>\nUse /sessions to find session IDs.\nYou can use short ID (e.g., first 8 characters)." });
    return;
  }

  try {
    await ctx.api.ensureReady();

    let sessionId = sessionIdInput;

    if (sessionIdInput.length < 36) {
      const sessionsResult = await ctx.api.listSessions({ limit: 100 });
      const sessions = sessionsResult.sessions || [];

      const matches = sessions.filter(s => s.id.startsWith(sessionIdInput));

      if (matches.length === 0) {
        ctx.postMessage({
          type: "error",
          message: `No session matches '${sessionIdInput}'.\nUse /sessions to list available sessions.`
        });
        return;
      } else if (matches.length === 1) {
        sessionId = matches[0].id;
      } else {
        const matchLines = matches.map((s, idx) => {
          const date = new Date(s.updated_at).toLocaleDateString();
          return `${idx + 1}. ${s.id}: "${s.title.slice(0, 40)}" (${date})`;
        });

        ctx.postMessage({
          type: "info",
          message: `Multiple sessions match '${sessionIdInput}' (${matches.length}):\n${matchLines.join("\n")}\n\nUse /load <full-id> to select specific session.`
        });
        return;
      }
    }

    await ctx.loadSessionMessages(sessionId);
  } catch (err) {
    if (getErrorMessage(err).includes("not found")) {
      ctx.postMessage({ type: "error", message: `Session '${sessionIdInput}' not found. Use /sessions to list available sessions.` });
    } else {
      ctx.postMessage({ type: "error", message: formatError("Failed to load session", err) });
    }
  }
}

async function handleChange(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: "Changelog: See the extension's CHANGELOG or visit the repository." });
}

async function handleCache(ctx: SlashCommandContext, _args: string): Promise<void> {
  if (ctx.currentThread) {
    try {
      const detail = await ctx.api.getThreadDetail(ctx.currentThread.id);
      const turns = detail.turns || [];
      const recentTurns = turns.slice(-10);
      let cacheInfo = "Cache telemetry (last 10 turns):\n";
      for (const turn of recentTurns) {
        const usage = turn.usage;
        if (usage) {
          const hit = usage.prompt_cache_hit_tokens ?? 0;
          const miss = usage.prompt_cache_miss_tokens ?? 0;
          const total = hit + miss;
          const ratio = total > 0 ? Math.round((hit / total) * 100) : 0;
          cacheInfo += `  Turn ${turn.id.slice(0, 8)}: cache hit ${hit}, miss ${miss} (${ratio}% hit rate)\n`;
        }
      }
      if (cacheInfo.trim().endsWith("turns):")) {
        cacheInfo += "  (no cache data available)";
      }
      ctx.postMessage({ type: "info", message: cacheInfo });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to get cache info", err) });
    }
  } else {
    ctx.postMessage({ type: "info", message: "No active thread for cache info." });
  }
}

async function handleProfile(ctx: SlashCommandContext, args: string): Promise<void> {
  const profileArg = args.trim();
  if (!profileArg) {
    const currentProfile = cfg().get<string | undefined>("configProfile");
    ctx.postMessage({ type: "info", message: `Current profile: ${currentProfile || "(default)"}\nUsage: /profile <name>\nProfiles are defined in ~/.deepseek/config.toml under [profiles] sections.` });
  } else {
    await cfg().update("configProfile", profileArg, vscode.ConfigurationTarget.Global);
    ctx.postMessage({ type: "info", message: `Profile switched to '${profileArg}'. Restart the engine for full effect.` });
  }
}

async function handleTranslate(ctx: SlashCommandContext, _args: string): Promise<void> {
  const current = cfg().get<boolean>("translationEnabled", false);
  await cfg().update("translationEnabled", !current, vscode.ConfigurationTarget.Global);
  ctx.postMessage({ type: "info", message: `Translation ${!current ? "enabled" : "disabled"}` });
}

async function handleSystem(ctx: SlashCommandContext, _args: string): Promise<void> {
  if (ctx.currentThread) {
    try {
      const detail = await ctx.api.getThreadDetail(ctx.currentThread.id);
      const sysPrompt = detail.thread.system_prompt || "(no system prompt)";
      const display = sysPrompt.length > 500
        ? sysPrompt.slice(0, 500) + `...\n\n(truncated, ${sysPrompt.length} chars total)`
        : sysPrompt;
      ctx.postMessage({ type: "info", message: `System Prompt (${cfg().get<string>("defaultMode", "agent")} mode):\n─────────────────────────────\n${display}` });
    } catch (err) {
      ctx.postMessage({ type: "error", message: formatError("Failed to get system prompt", err) });
    }
  } else {
    ctx.postMessage({ type: "info", message: "(no system prompt)" });
  }
}

async function handleEdit(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "loadLastUserMessage" });
}

async function handleDiff(ctx: SlashCommandContext, _args: string): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    ctx.postMessage({ type: "info", message: "No workspace open" });
    return;
  }
  try {
    const execAsync = (cmd: string, opts: { cwd: string; encoding: string }) =>
      new Promise<string>((resolve, reject) => {
        exec(cmd, { ...opts, timeout: 10000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout as string);
        });
      });
    const statOutput = await execAsync("git diff --stat", { cwd: ws, encoding: "utf-8" });
    const nameOutput = await execAsync("git diff --name-only", { cwd: ws, encoding: "utf-8" });
    if (nameOutput.trim().length === 0) {
      ctx.postMessage({ type: "info", message: "No changes since session start" });
    } else {
      const files = nameOutput.trim().split("\n");
      ctx.postMessage({ type: "info", message: `Changed files (${files.length}):\n${files.map((f: string) => `- ${f}`).join("\n")}\n\n${statOutput.trim()}` });
    }
  } catch (err) {
    ctx.postMessage({ type: "info", message: `Git diff unavailable: ${formatError("", err)}` });
  }
}

async function handleJobs(ctx: SlashCommandContext, args: string): Promise<void> {
  const jobsArg = args.trim().toLowerCase();
  const jobsParts = jobsArg.split(/\s+/);
  const jobsSub = jobsParts[0] || "list";
  const jobsId = jobsParts[1] || "";

  try {
    await ctx.api.ensureReady();

    if (jobsSub === "list" || jobsSub === "") {
      const automations = await ctx.api.listAutomations();

      if (automations && automations.length > 0) {
        const lines = automations.map((a) => {
          const statusIcon = a.status === "active" ? "✓" : "○";
          const nextRun = a.next_run_at
            ? `Next: ${new Date(a.next_run_at).toLocaleString()}`
            : "No scheduled run";
          const lastRun = a.last_run_at
            ? `Last: ${new Date(a.last_run_at).toLocaleString()}`
            : "Never run";
          return `${statusIcon} ${a.id.slice(0, 8)}: "${a.name}" [${a.status}] ${nextRun} | ${lastRun}`;
        });

        ctx.postMessage({
          type: "info",
          message: `Automations (${automations.length}):\n${lines.join("\n")}\n\nUsage: /jobs show <id> | /jobs run <id> | /jobs pause <id> | /jobs resume <id> | /jobs history <id>`
        });
      } else {
        ctx.postMessage({
          type: "info",
          message: `No automations found.\n\nAutomations are scheduled tasks that run automatically.\nCreate via TUI or use the automations API.\nUsage: /jobs list`
        });
      }
    } else if (jobsSub === "show" && jobsId) {
      const automation = await ctx.api.getAutomation(jobsId);
      const nextRun = automation.next_run_at
        ? new Date(automation.next_run_at).toLocaleString()
        : "Not scheduled";
      const lastRun = automation.last_run_at
        ? new Date(automation.last_run_at).toLocaleString()
        : "Never";

      ctx.postMessage({
        type: "info",
        message: `Automation: ${automation.name}
  ID: ${automation.id}
  Status: ${automation.status}
  Schedule: ${automation.rrule}
  Next run: ${nextRun}
  Last run: ${lastRun}
  Prompt: ${automation.prompt.slice(0, 200)}${automation.prompt.length > 200 ? "..." : ""}
  Workspaces: ${automation.cwds.length > 0 ? automation.cwds.join(", ") : "N/A"}

Usage: /jobs run ${automation.id.slice(0, 8)} | /jobs pause ${automation.id.slice(0, 8)} | /jobs history ${automation.id.slice(0, 8)}`
      });
    } else if (jobsSub === "run" && jobsId) {
      const automation = await ctx.api.runAutomation(jobsId);
      ctx.postMessage({
        type: "info",
        message: `Automation triggered: ${automation.name} (${automation.id.slice(0, 8)})\nStatus: ${automation.status}\nThe automation will execute according to its schedule.`
      });
    } else if (jobsSub === "pause" && jobsId) {
      const automation = await ctx.api.pauseAutomation(jobsId);
      ctx.postMessage({
        type: "info",
        message: `Automation paused: ${automation.name} (${automation.id.slice(0, 8)})\nStatus: ${automation.status}\nUse /jobs resume ${automation.id.slice(0, 8)} to resume.`
      });
    } else if (jobsSub === "resume" && jobsId) {
      const automation = await ctx.api.resumeAutomation(jobsId);
      ctx.postMessage({
        type: "info",
        message: `Automation resumed: ${automation.name} (${automation.id.slice(0, 8)})\nStatus: ${automation.status}\nNext run: ${automation.next_run_at ? new Date(automation.next_run_at).toLocaleString() : "Not scheduled"}`
      });
    } else if (jobsSub === "history" && jobsId) {
      const runs = await ctx.api.listAutomationRuns(jobsId, { limit: 10 });

      if (runs && runs.length > 0) {
        const lines = runs.map((r) => {
          const statusIcon = r.status === "completed" ? "✓" :
                             r.status === "running" ? "⏳" :
                             r.status === "failed" ? "✗" : "○";
          const scheduled = new Date(r.scheduled_for).toLocaleString();
          const started = r.started_at ? new Date(r.started_at).toLocaleString() : "N/A";
          const ended = r.ended_at ? new Date(r.ended_at).toLocaleString() : "N/A";
          const error = r.error ? ` Error: ${r.error.slice(0, 50)}` : "";
          return `${statusIcon} ${r.id.slice(0, 8)}: ${scheduled} → ${started} → ${ended} [${r.status}]${error}`;
        });

        ctx.postMessage({
          type: "info",
          message: `Automation runs (${runs.length}):\n${lines.join("\n")}\n\nUsage: /jobs history <id>`
        });
      } else {
        ctx.postMessage({
          type: "info",
          message: `No run history found for automation ${jobsId}.\n\nThe automation may not have executed yet.`
        });
      }
    } else {
      ctx.postMessage({ type: "error", message: `Usage: /jobs list | /jobs show <id> | /jobs run <id> | /jobs pause <id> | /jobs resume <id> | /jobs history <id>` });
    }
  } catch (err) {
    if (getErrorMessage(err).includes("not found")) {
      ctx.postMessage({ type: "error", message: `Automation '${jobsId}' not found. Use /jobs list to see available automations.` });
    } else {
      ctx.postMessage({ type: "error", message: formatError("Failed to manage automations", err) });
    }
  }
}

async function handleLogout(ctx: SlashCommandContext, _args: string): Promise<void> {
  ctx.postMessage({ type: "info", message: "To change API key, update the DEEPSEEK_API_KEY environment variable and restart VSCode." });
}

async function handleNote(ctx: SlashCommandContext, args: string): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    ctx.postMessage({ type: "info", message: "No workspace open. Notes require an open workspace." });
    return;
  }
  const notesDir = path.join(ws, ".deepseek");
  const notesPath = path.join(notesDir, "notes.md");
  const noteArg = args.trim();
  const sub = noteArg.split(/\s+/)[0]?.toLowerCase();
  const rest = noteArg.slice(sub.length).trim();

  if (!noteArg || sub === "help") {
    ctx.postMessage({ type: "info", message: `Usage: /note <text> | /note add <text> | /note list | /note show <n> | /note remove <n> | /note clear | /note path\nNotes path: ${notesPath}` });
    return;
  }

  try {
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Failed to create .deepseek directory", err) });
    return;
  }

  try {
    if (sub === "path") {
      ctx.postMessage({ type: "info", message: `Notes path: ${notesPath}` });
    } else if (sub === "show") {
      const idx = parseInt(rest, 10);
      if (isNaN(idx) || idx < 1) {
        ctx.postMessage({ type: "error", message: "Usage: /note show <n>" });
        return;
      }
      if (!fs.existsSync(notesPath)) {
        ctx.postMessage({ type: "error", message: "No notes file." });
        return;
      }
      const content = fs.readFileSync(notesPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);
      if (idx > lines.length) {
        ctx.postMessage({ type: "error", message: `Note ${idx} not found. Only ${lines.length} notes.` });
        return;
      }
      ctx.postMessage({ type: "info", message: `Note ${idx}:\n${lines[idx - 1].replace(/^[-*]\s*/, "")}` });
    } else if (sub === "list") {
      if (!fs.existsSync(notesPath)) {
        ctx.postMessage({ type: "info", message: "No notes yet." });
      } else {
        const content = fs.readFileSync(notesPath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        if (lines.length === 0) {
          ctx.postMessage({ type: "info", message: "No notes yet." });
        } else {
          ctx.postMessage({ type: "info", message: `Notes (${lines.length}):\n${lines.map((l, i) => `${i + 1}. ${l.replace(/^[-*]\s*/, "")}`).join("\n")}` });
        }
      }
    } else if (sub === "clear") {
      if (fs.existsSync(notesPath)) {
        fs.writeFileSync(notesPath, "");
        ctx.postMessage({ type: "info", message: "Notes cleared." });
      } else {
        ctx.postMessage({ type: "info", message: "No notes to clear." });
      }
    } else if (sub === "remove" || sub === "rm" || sub === "delete") {
      const idx = parseInt(rest, 10);
      if (isNaN(idx) || idx < 1) {
        ctx.postMessage({ type: "error", message: "Usage: /note remove <n>" });
        return;
      }
      if (!fs.existsSync(notesPath)) {
        ctx.postMessage({ type: "error", message: "No notes file." });
        return;
      }
      const content = fs.readFileSync(notesPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);
      if (idx > lines.length) {
        ctx.postMessage({ type: "error", message: `Note ${idx} not found. Only ${lines.length} notes.` });
        return;
      }
      lines.splice(idx - 1, 1);
      fs.writeFileSync(notesPath, lines.join("\n") + "\n");
      ctx.postMessage({ type: "info", message: `Removed note ${idx}.` });
    } else {
      const text = sub === "add" ? rest : noteArg;
      if (!text) {
        ctx.postMessage({ type: "error", message: "Note content cannot be empty" });
        return;
      }
      const timestamp = new Date().toISOString().slice(0, 16);
      const entry = `- [${timestamp}] ${text}\n`;
      fs.appendFileSync(notesPath, entry);
      ctx.postMessage({ type: "info", message: `Note added: ${text}` });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Note error", err) });
  }
}

async function handleMemory(ctx: SlashCommandContext, args: string): Promise<void> {
  const memoryDir = path.join(os.homedir(), ".deepseek");
  const memoryPath = path.join(memoryDir, "memory.md");
  const memArg = args.trim().toLowerCase();

  if (memArg === "help") {
    ctx.postMessage({ type: "info", message: `Usage: /memory [show|path|clear|edit]\nCurrent path: ${memoryPath}` });
    return;
  }

  if (memArg === "path") {
    ctx.postMessage({ type: "info", message: `Memory path: ${memoryPath}` });
    return;
  }

  try {
    if (memArg === "clear") {
      if (fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, "(empty)\n");
        ctx.postMessage({ type: "info", message: "Memory cleared." });
      } else {
        ctx.postMessage({ type: "info", message: "No memory file to clear." });
      }
      return;
    }

    if (memArg === "edit") {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(memoryPath));
        vscode.window.showTextDocument(doc);
        ctx.postMessage({ type: "info", message: `Opening memory file: ${memoryPath}` });
      } catch {
        ctx.postMessage({ type: "info", message: `Memory file not found. Create it at: ${memoryPath}` });
      }
      return;
    }

    if (!fs.existsSync(memoryPath)) {
      ctx.postMessage({ type: "info", message: `Memory file not found.\nPath: ${memoryPath}\nCreate it to start using memory, or use /memory edit to open it.` });
    } else {
      const content = fs.readFileSync(memoryPath, "utf-8").trim();
      if (!content || content === "(empty)") {
        ctx.postMessage({ type: "info", message: `Memory path: ${memoryPath}\n(empty — add content to the file or use /memory edit)` });
      } else {
        const display = content.length > 500
          ? content.slice(0, 500) + `...\n(truncated, ${content.length} chars total)`
          : content;
        ctx.postMessage({ type: "info", message: `Memory path: ${memoryPath}\n─────────────────────────────\n${display}` });
      }
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: formatError("Memory error", err) });
  }
}

// ── Command registry (dispatcher map) ──

const HANDLERS: Record<string, CommandHandler> = {
  "/mode": handleMode,
  "/model": handleModel,
  "/models": handleModels,
  "/reasoning": handleReasoning,
  "/config": handleConfig,
  "/settings": handleSettings,
  "/interrupt": handleInterrupt,
  "/clear": handleClear,
  "/compact": handleCompact,
  "/exit": handleExit,
  "/rename": handleRename,
  "/save": handleSave,
  "/export": handleExport,
  "/context": handleContext,
  "/tokens": handleTokens,
  "/cost": handleCost,
  "/status": handleStatus,
  "/home": handleHome,
  "/workspace": handleWorkspace,
  "/task": handleTask,
  "/trust": handleTrust,
  "/verbose": handleVerbose,
  "/init": handleInit,
  "/mcp": handleMcp,
  "/provider": handleProvider,
  "/links": handleLinks,
  "/feedback": handleFeedback,
  "/help": handleHelp,
  "/undo": handleUndo,
  "/retry": handleRetry,
  "/goal": handleGoal,
  "/skills": handleSkills,
  "/skill": handleSkill,
  "/attach": handleAttach,
  "/anchor": handleAnchor,
  "/sessions": handleSessions,
  "/load": handleLoad,
  "/change": handleChange,
  "/cache": handleCache,
  "/profile": handleProfile,
  "/translate": handleTranslate,
  "/system": handleSystem,
  "/edit": handleEdit,
  "/diff": handleDiff,
  "/jobs": handleJobs,
  "/logout": handleLogout,
  "/note": handleNote,
  "/memory": handleMemory,
};

// ── Handler class ──

export class SlashCommandHandler {
  constructor(private ctx: SlashCommandContext) {}

  async handle(command: string, args: string): Promise<void> {
    const handler = HANDLERS[command];

    if (handler) {
      // Check availability from the slash-commands registry
      const availability = isCommandAvailableInGui(command);
      if (availability === "unavailable") {
        notAvailable(this.ctx);
        return;
      }
      await handler(this.ctx, args);
    } else {
      this.ctx.postMessage({ type: "error", message: `Unknown command: ${command}. Type /help for available commands.` });
    }
  }
}

/** Expose the handler map for testing */
export { HANDLERS, type CommandHandler };
