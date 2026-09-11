export interface SlashCommand {
  name: string;
  desc: string;
  category: "core" | "config" | "session" | "debug" | "skills" | "unavailable";
  availability: "full" | "partial" | "unavailable";
  helpText: string;
}

const COMMANDS: SlashCommand[] = [
  { name: "/mode", desc: "Switch mode (act/plan/operate)", category: "config", availability: "full", helpText: "/mode [act|plan|operate|1|2|3] - Switch mode (legacy /mode yolo = Act + Full Access)" },
  { name: "/auto", desc: "Work with Auto-Review", category: "config", availability: "full", helpText: "/auto - Switch the permission posture to Auto-Review so the agent just works" },
  { name: "/model", desc: "Switch model", category: "config", availability: "full", helpText: "/model [name] - Switch model" },
  { name: "/models", desc: "List available models", category: "config", availability: "full", helpText: "/models - List available models" },
  { name: "/reasoning", desc: "Set reasoning effort", category: "config", availability: "full", helpText: "/reasoning [auto|off|low|medium|high|max] - Set reasoning effort" },
  { name: "/config", desc: "Open config panel or set config", category: "config", availability: "full", helpText: "/config [key value] - Open config panel, or set a config key" },
  { name: "/settings", desc: "Show current settings", category: "config", availability: "full", helpText: "/settings - Show current settings" },
  { name: "/clear", desc: "Clear chat", category: "core", availability: "full", helpText: "/clear - Clear chat" },
  { name: "/help", desc: "Show help", category: "core", availability: "full", helpText: "/help - Show help" },
  { name: "/compact", desc: "Compact context", category: "session", availability: "full", helpText: "/compact - Compact context" },
  { name: "/exit", desc: "Close sidebar", category: "core", availability: "full", helpText: "/exit - Close sidebar" },
  { name: "/rename", desc: "Rename current thread", category: "session", availability: "full", helpText: "/rename <title> - Rename thread" },
  { name: "/save", desc: "Save conversation", category: "session", availability: "full", helpText: "/save - Save conversation" },
  { name: "/export", desc: "Export conversation", category: "session", availability: "full", helpText: "/export - Export conversation" },
  { name: "/context", desc: "Show context info", category: "debug", availability: "full", helpText: "/context - Show context info" },
  { name: "/tokens", desc: "Show token usage", category: "debug", availability: "full", helpText: "/tokens - Show token usage" },
  { name: "/cost", desc: "Show cost info", category: "debug", availability: "full", helpText: "/cost - Show cost info" },
  { name: "/status", desc: "Show engine status", category: "debug", availability: "full", helpText: "/status - Show engine status" },
  { name: "/home", desc: "Show dashboard", category: "core", availability: "full", helpText: "/home - Show dashboard" },
  { name: "/workspace", desc: "Set workspace", category: "config", availability: "full", helpText: "/workspace [path] - Show/set workspace" },
  { name: "/task", desc: "Manage tasks", category: "core", availability: "full", helpText: "/task add <prompt> | /task list | /task show <id> | /task cancel <id> — Create and manage background tasks" },
  { name: "/jobs", desc: "Manage automations", category: "core", availability: "full", helpText: "/jobs list | /jobs show <id> | /jobs run <id> | /jobs pause <id> | /jobs resume <id> | /jobs history <id> - Manage scheduled automations" },
  { name: "/note", desc: "Manage notes", category: "core", availability: "full", helpText: "/note <text> | /note add <text> | /note list | /note show <n> | /note remove <n> | /note clear | /note path" },
  { name: "/memory", desc: "Manage memory", category: "core", availability: "full", helpText: "/memory [show|search <query>|get <id>|remember [global|workspace] <note>|clear [all|global|workspace]] - Manage the native memory store via the runtime API" },
  { name: "/trust", desc: "Manage trust settings", category: "config", availability: "full", helpText: "/trust [on|off] - Toggle trust mode" },
  { name: "/verbose", desc: "Toggle verbose mode", category: "config", availability: "full", helpText: "/verbose [on|off] - Toggle verbose mode" },
  { name: "/theme", desc: "Change theme", category: "unavailable", availability: "unavailable", helpText: "Not available: GUI uses VSCode's theme system. Change theme via VSCode settings instead." },
  { name: "/undo", desc: "Undo last turn", category: "session", availability: "full", helpText: "/undo - Remove the last user/assistant exchange from the view (server-side history is preserved). Use /load-session to recover if needed." },
  { name: "/retry", desc: "Retry last turn", category: "session", availability: "full", helpText: "/retry - Drop the last exchange and re-send your last user message. Works only when no turn is currently running." },
  { name: "/share", desc: "Share conversation", category: "session", availability: "unavailable", helpText: "Not available: Sharing service requires TUI's built-in HTTP server. Use /export to save conversation instead." },
  { name: "/goal", desc: "Set a goal", category: "core", availability: "full", helpText: "/goal <objective> [| budget: <tokens>] | /goal clear - Set or clear session goal" },
  { name: "/skills", desc: "List skills", category: "skills", availability: "full", helpText: "/skills - List all available skills with their status (enabled/disabled)" },
  { name: "/skill", desc: "Toggle skill", category: "skills", availability: "full", helpText: "/skill <name> [on|off] - Enable or disable a skill. Skills are auto-triggered when enabled and task matches." },
  { name: "/mcp", desc: "Manage MCP servers", category: "config", availability: "full", helpText: "/mcp - Open MCP settings" },
  { name: "/network", desc: "Manage network rules", category: "config", availability: "unavailable", helpText: "Not available: Network rules are managed by VSCode's proxy settings. Configure via VSCode Settings > Proxy." },
  { name: "/provider", desc: "Switch API provider", category: "config", availability: "full", helpText: "/provider - Show provider info" },
  { name: "/queue", desc: "Manage message queue", category: "core", availability: "unavailable", helpText: "Not available: Message queue is a TUI-specific feature for managing pending drafts." },
  { name: "/stash", desc: "Stash/restore messages", category: "core", availability: "unavailable", helpText: "Not available: Stash is a TUI-specific feature for parking draft messages." },
  { name: "/hooks", desc: "Manage hooks", category: "core", availability: "unavailable", helpText: "Not available: Hooks are TUI-specific lifecycle callbacks. Configure via ~/.deepseek/config.toml." },
  { name: "/subagents", desc: "List sub-agents", category: "core", availability: "unavailable", helpText: "Not available: Sub-agent management requires TUI's runtime environment." },
  { name: "/agent", desc: "Spawn a sub-agent", category: "core", availability: "unavailable", helpText: "Not available: Sub-agent spawning requires TUI's runtime environment." },
  { name: "/links", desc: "Show CodeWhale links", category: "core", availability: "full", helpText: "/links - Show CodeWhale links" },
  { name: "/feedback", desc: "Send feedback", category: "core", availability: "full", helpText: "/feedback - Send feedback" },
  { name: "/attach", desc: "Attach a file", category: "core", availability: "full", helpText: "/attach - Open file picker to attach an image, video, PDF, or any file" },
  { name: "/anchor", desc: "Set anchor points", category: "core", availability: "full", helpText: "/anchor <text> | /anchor list | /anchor remove <n> - Anchors are auto-injected after compaction" },
  { name: "/sessions", desc: "Manage sessions", category: "session", availability: "full", helpText: "/sessions [search <query>] - List saved sessions with metadata. Use /load <id> to resume a session." },
  { name: "/load", desc: "Load a session", category: "session", availability: "full", helpText: "/load <session-id> - Resume a saved session into a new thread. Use /sessions to find session IDs." },
  { name: "/cycles", desc: "List cycles", category: "session", availability: "unavailable", helpText: "Not available: Compaction cycles are TUI-internal state not exposed via the API." },
  { name: "/cycle", desc: "Show cycle details", category: "session", availability: "unavailable", helpText: "Not available: Compaction cycles are TUI-internal state not exposed via the API." },
  { name: "/recall", desc: "Recall from archive", category: "session", availability: "unavailable", helpText: "Not available: Archive recall requires TUI's internal storage system." },
  { name: "/relay", desc: "Relay to next agent", category: "core", availability: "unavailable", helpText: "Not available: Agent relay requires TUI's multi-agent runtime." },
  { name: "/init", desc: "Initialize project config", category: "config", availability: "full", helpText: "/init - Open settings for initialization" },
  { name: "/lsp", desc: "LSP settings", category: "config", availability: "unavailable", helpText: "Not available: LSP is managed by VSCode itself. Configure via VSCode Settings > Language Servers." },
  { name: "/review", desc: "Review code", category: "skills", availability: "unavailable", helpText: "Not available: Code review requires TUI's PR review workflow." },
  { name: "/restore", desc: "Restore from snapshot", category: "session", availability: "full", helpText: "/restore [N|list [N]] - List snapshots or revert workspace files to the Nth-most-recent snapshot (requires trust mode)" },
  { name: "/rlm", desc: "Recursive language model", category: "core", availability: "unavailable", helpText: "Not available: RLM sessions require TUI's Python runtime and bounded analysis environment." },
  { name: "/change", desc: "View changelog", category: "core", availability: "partial", helpText: "Changelog: See the extension's CHANGELOG or visit the repository." },
  { name: "/cache", desc: "Cache telemetry", category: "debug", availability: "full", helpText: "/cache - Show per-turn prefix-cache telemetry for the last 10 turns" },
  { name: "/profile", desc: "Switch profile", category: "config", availability: "full", helpText: "/profile <name> - Switch to a named config profile" },
  { name: "/translate", desc: "Toggle translation", category: "debug", availability: "full", helpText: "/translate - Toggle translation mode on/off" },
  { name: "/system", desc: "Show system prompt", category: "debug", availability: "full", helpText: "/system - Show the current system prompt" },
  { name: "/edit", desc: "Edit last message", category: "session", availability: "full", helpText: "/edit - Load the last user message into the input for editing" },
  { name: "/diff", desc: "Show diff", category: "debug", availability: "full", helpText: "/diff - Show git diff output for the workspace" },
  { name: "/statusline", desc: "Status line info", category: "debug", availability: "unavailable", helpText: "Not available: Status line is a TUI-specific UI element. GUI has its own status bar." },
  { name: "/logout", desc: "Logout", category: "config", availability: "partial", helpText: "To change API key, update the DEEPSEEK_API_KEY environment variable and restart VSCode." },
];

export class SlashCommandRegistry {
  getAllCommands(): SlashCommand[] {
    return COMMANDS;
  }

  getCommand(name: string): SlashCommand | undefined {
    return COMMANDS.find((c) => c.name === name);
  }

  filterCommands(query: string): SlashCommand[] {
    if (!query.startsWith("/")) return [];
    const prefix = query.toLowerCase();
    return COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().startsWith(prefix) ||
        c.desc.toLowerCase().includes(prefix.slice(1))
    );
  }
}

/** Look up a command in the static registry (known-but-unavailable
 *  commands still resolve here; they are not "unknown"). */
export function getCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function categorizeCommand(name: string): string {
  const cmd = COMMANDS.find((c) => c.name === name);
  return cmd?.category ?? "unknown";
}

export function isCommandAvailableInGui(
  name: string
): "full" | "partial" | "unavailable" {
  const cmd = COMMANDS.find((c) => c.name === name);
  return cmd?.availability ?? "unavailable";
}

export function getCommandHelpText(name: string): string {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return `Unknown command: ${name}. Type /help for available commands.`;
  return cmd.helpText;
}
