import * as vscode from "vscode";

// ── Translation data ──

interface Translations {
  locale: string; // "en" or "zh-cn"
  history: string;
  threads: string;
  sessions: string;
  tasks: string;
  work: string;
  newThread: string;
  compact: string;
  interrupt: string;
  toggleHistory: string;
  send: string;
  inputPlaceholder: string;
  initializing: string;
  ready: string;
  thinking: string;
  streaming: string;
  processing: string;
  error: string;
  approvalAwaiting: string;
  userInputRequired: string;
  userInputAwaiting: string;
  noConversations: string;
  threadAttention: string;
  noTasks: string;
  taskCreate: string;
  taskCreateTitle: string;
  taskCreatePlaceholder: string;
  taskCreateSubmit: string;
  taskRefresh: string;
  taskDetails: string;
  taskOpenThread: string;
  taskAttention: string;
  taskNeedsAttention: string;
  taskPendingApprovals: string;
  taskPendingInputs: string;
  taskContinueInThread: string;
  threadsCount: (n: number) => string;
  modelLabel: string;
  workspaceLabel: string;
  modeLabel: string;
  reasoningEffortLabel: string;
  welcomeTitle: string;
  welcomeSubtitle: string;
  welcomeQuote: string;
  welcomeQuoteAuthor: string;
  welcomeSuggestionTitle: string;
  welcomeSuggestion1: string;
  welcomeSuggestion2: string;
  welcomeSuggestion3: string;
  welcomeSuggestion4: string;
  noActiveWork: string;
  cancel: string;
  goal: string;
  checklist: string;
  strategy: string;
  cycles: string;
  coherenceHealthy: string;
  coherenceGettingCrowded: string;
  coherenceRefreshingContext: string;
  coherenceVerifyingRecentWork: string;
  coherenceResettingPlan: string;
  completionPct: string;
  readyTimedOut: string;
  note: string;
  noPreviousMessage: string;
  justNow: string;
  minutesAgoPattern: string;
  hoursAgoPattern: string;
  daysAgoPattern: string;
  loadedThread: (title: string) => string;
  contextCompacted: string;
  compactFailed: string;
  sendFailed: string;
  initFailed: string;
  eventStreamError: string;
  steerNoActiveTurn: string;
  steerUnsupported: string;
  steerFailed: string;
  steerPlaceholder: string;
  steerBadge: string;
  steerBadgeTitle: string;
  engineRestarted: string;
  engineRestartFailed: string;
  engineNotRunning: string;
  approvalRequired: string;
  allow: string;
  deny: string;
  thinkingToggle: string;
  thinkingOpen: string;
  thinkingClose: string;
  /** "{n} threads" / "{n} 个会话" — webview JS replaces {n} */
  threadsCountPattern: string;
  /** "Loaded: {0}" / "已加载: {0}" */
  loadedThreadPattern: string;
  /** "Show all workspaces" / "显示所有工作区" */
  showAllWorkspaces: string;
  /** "Current workspace only" / "仅当前工作区" */
  filterCurrentWorkspace: string;
  // Slash commands
  commandMode: string;
  commandModel: string;
  commandModels: string;
  commandReasoning: string;
  commandConfig: string;
  commandSettings: string;
  commandClear: string;
  commandInterrupt: string;
  commandHelp: string;
  commandCompact: string;
  commandExit: string;
  commandRename: string;
  commandSave: string;
  commandExport: string;
  commandContext: string;
  commandTokens: string;
  commandCost: string;
  commandStatus: string;
  commandHome: string;
  commandWorkspace: string;
  commandTask: string;
  commandJobs: string;
  commandNote: string;
  commandMemory: string;
  commandTrust: string;
  commandVerbose: string;
  commandTheme: string;
  commandUndo: string;
  commandRetry: string;
  commandShare: string;
  commandGoal: string;
  commandSkills: string;
  commandSkill: string;
  commandMcp: string;
  commandNetwork: string;
  commandProvider: string;
  commandQueue: string;
  commandStash: string;
  commandHooks: string;
  commandSubagents: string;
  commandAgent: string;
  commandLinks: string;
  commandFeedback: string;
  commandAttach: string;
  commandAnchor: string;
  commandSessions: string;
  commandLoad: string;
  commandCycles: string;
  commandCycle: string;
  commandRecall: string;
  commandRelay: string;
  commandInit: string;
  commandLsp: string;
  commandReview: string;
  commandRestore: string;
  commandRlm: string;
  commandChange: string;
  commandCache: string;
  commandProfile: string;
  commandTranslate: string;
  commandSystem: string;
  commandEdit: string;
  commandDiff: string;
  commandStatusline: string;
  commandLogout: string;
  commandNotAvailableInGui: string;
  attachFiles: string;
  removeAttachment: string;
  attachedFileCount: string;
  fileNotSupported: string;
  changes: string;
  noFileChanges: string;
  fileChanges: string;
  viewDiff: string;
  viewDiffTooltip: string;
  openFile: string;
  openFileTooltip: string;
  noChanges: string;
  changesThisTurn: string;
  fileCreated: string;
  fileModified: string;
  fileDeleted: string;
  addedLines: string;
  removedLines: string;
  // Undo / Retry / Revert
  undoLastTurn: string;
  retryLastTurn: string;
  revertFile: string;
  revertFileTooltip: string;
  revertThisFile: string;
  revertConfirmTitle: string;
  revertConfirmMessage: string;
  revertConfirmButton: string;
  revertCancelButton: string;
  revertSuccess: (filePath: string) => string;
  revertFailure: (filePath: string, reason: string) => string;
  revertFileCreated: string;
  revertNotAvailable: string;
  revertNotSupported: string;
  revertUnsupportedTooltip: string;
  undoConfirmTitle: string;
  undoConfirmMessage: string;
  undoConfirmButton: string;
  undoNotSupported: string;
  undoUnsupportedTooltip: string;
  retryConfirmTitle: string;
  retryConfirmMessage: string;
  retryConfirmButton: string;
  undoNoTurns: string;
  undoSuccess: (turnId: string) => string;
  retryNoTurns: string;
  retrySuccess: (turnId: string) => string;
  retryInterrupted: string;
  retryNotSupported: string;
  retryUnsupportedTooltip: string;
  // Last-turn summary
  lastTurnLabel: string;
  lastTurnNoPrevious: string;
  // Revert for newly created files
  revertWillDelete: string;
  // Session search & delete
  searchSessions: string;
  searchPlaceholder: string;
  deleteSession: string;
  deleteSessionConfirmTitle: string;
  deleteSessionConfirmMessage: string;
  deleteSessionConfirmButton: string;
  deleteSessionSuccess: string;
  deleteSessionFailed: string;
  switchSessionActiveTurnTitle: string;
  switchSessionActiveTurnMessage: string;
  switchSessionActiveTurnButton: string;
  noSearchResults: string;
  // Agent panel
  agents: string;
  noAgentRuns: string;
  agentStatusQueued: string;
  agentStatusStarting: string;
  agentStatusRunning: string;
  agentStatusWaitingForUser: string;
  agentStatusModelWait: string;
  agentStatusRunningTool: string;
  agentStatusCompleted: string;
  agentStatusFailed: string;
  agentStatusCancelled: string;
  agentStatusInterrupted: string;
  agentObjective: string;
  agentModel: string;
  agentSteps: string;
  agentResult: string;
  agentError: string;
  agentRole: string;
  agentArtifacts: string;
  agentUsage: string;
  agentSpawned: string;
  agentDelegating: string;
  agentFanout: string;
  // Fleet panel
  fleet: string;
  noFleetRuns: string;
  fleetWorkers: string;
  fleetTasks: string;
  fleetReceipts: string;
  fleetStart: string;
  fleetStop: string;
  fleetRestart: string;
  fleetStatus: string;
  fleetAttempts: string;
  fleetScore: string;
  fleetViewReply: string;
  fleetTaskInstructions: string;
  fleetNewFromRun: string;
  fleetNewFromRunHint: string;
  fleetEvFilterIssues: string;
  fleetEvFilterProgress: string;
  fleetEvFilterAll: string;
  fleetTaskFailure: string;
  fleetEvRunCreated: string;
  fleetEvRunStatus: string;
  fleetEvEnqueued: string;
  fleetEvLeased: string;
  fleetEvTerminal: string;
  fleetEvReceipt: string;
  fleetEvHeartbeat: string;
  fleetEvAlert: string;
  fleetInterrupt: string;
  fleetStEnqueued: string;
  fleetStLeased: string;
  fleetStCompleted: string;
  fleetStFailed: string;
  fleetStCancelled: string;
  fleetStUnknown: string;
  fleetStOnline: string;
  fleetStBusy: string;
  fleetStOffline: string;
  fleetStUnhealthy: string;
  fleetStDraining: string;
  fleetStRetired: string;
  fleetStQueued: string;
  fleetStPending: string;
  fleetStRunning: string;
  fleetStPaused: string;
  fleetStEnqueuedHint: string;
  fleetLatestMessage: string;
  fleetNoWorkers: string;
  fleetNoTasks: string;
  fleetNoReceipts: string;
  fleetRunId: string;
  fleetTaskCount: string;
  fleetWorkerCount: string;
  fleetCreate: string;
  fleetCreateDesc: string;
  fleetCreateName: string;
  fleetCreateWorkflowId: string;
  fleetCreateMaxWorkers: string;
  fleetCreateRoles: string;
  fleetCreateRolesHint: string;
  fleetProfileNone: string;
  fleetCreateStartNow: string;
  fleetCreateBasics: string;
  fleetCreateBasicsDesc: string;
  fleetCreateRolesDesc: string;
  fleetCreateTasksDesc: string;
  fleetCreateTasks: string;
  fleetCreateAddRole: string;
  fleetCreateAddTask: string;
  fleetCreateTaskId: string;
  fleetCreateTaskName: string;
  fleetCreateTaskRole: string;
  fleetCreateTaskObjective: string;
  fleetCreateTaskInstructions: string;
  fleetCreateRemove: string;
  fleetCreateSubmit: string;
  fleetCreateTokenError: string;
  fleetCreateDuplicate: string;
  // Goal control plane
  goalStatus: string;
  goalBudget: string;
  goalTokensUsed: string;
  goalTimeUsed: string;
  goalContinuations: string;
  goalSet: string;
  goalEdit: string;
  goalComplete: string;
  goalBlock: string;
  goalDelete: string;
  goalObjectivePlaceholder: string;
  goalNoGoal: string;
  goalTokenBudgetLabel: string;
  goalCreatedAt: string;
  goalBudgetTooltip: string;
  goalTokensUsedTooltip: string;
  goalTimeUsedTooltip: string;
  goalContinuationsTooltip: string;
  goalBudgetExceeded: string;
}

const en: Translations = {
  locale: "en",
  history: "History", threads: "Threads", sessions: "Sessions", tasks: "Tasks", work: "Work",
  newThread: "+ New", compact: "⬒ Compact", interrupt: "■ Stop",
  toggleHistory: "Click to toggle history", send: "Send",
  inputPlaceholder: "Ask CodeWhale...",
  initializing: "Initializing...", ready: "Ready",
  thinking: "Thinking...", streaming: "Streaming...", processing: "Processing...",
  error: "Error", approvalAwaiting: "⏳ Awaiting approval...",
  userInputRequired: "Input required",
  userInputAwaiting: "⏳ Awaiting your input...",
  noConversations: "No conversations yet", threadAttention: "Waiting for your approval or input — click to open", noTasks: "No tasks",
  taskCreate: "New Task", taskCreateTitle: "Create Task", taskCreatePlaceholder: "Describe the background task…", taskCreateSubmit: "Create", taskRefresh: "Refresh", taskDetails: "Details",
  taskOpenThread: "Open Thread", taskAttention: "Attention", taskNeedsAttention: "Needs attention", taskPendingApprovals: "Pending Approvals", taskPendingInputs: "Pending Inputs", taskContinueInThread: "Continue in thread",
  threadsCount: (n) => `${n} thread${n !== 1 ? "s" : ""}`,
  modelLabel: "Model", workspaceLabel: "Workspace",
  modeLabel: "Mode", reasoningEffortLabel: "Reasoning Effort",
  welcomeTitle: "CodeWhale",
  welcomeSubtitle: "Technology serves the enduring mission of civilization",
  welcomeQuote: "To establish the heart for heaven and earth, to secure life for the people, to continue the lost learning of past sages, and to establish peace for all generations.",
  welcomeQuoteAuthor: "— Zhang Zai",
  welcomeSuggestionTitle: "How can I help you today?",
  welcomeSuggestion1: "Explain a concept or idea",
  welcomeSuggestion2: "Write or refactor code",
  welcomeSuggestion3: "Analyze a problem step by step",
  welcomeSuggestion4: "Explore a topic in depth",
  noActiveWork: "No active work",
  cancel: "Cancel",
  goal: "Goal",
  checklist: "Checklist",
  strategy: "Strategy",
  cycles: "cycles",
  coherenceHealthy: "Healthy",
  coherenceGettingCrowded: "Getting crowded",
  coherenceRefreshingContext: "Refreshing context…",
  coherenceVerifyingRecentWork: "Verifying recent work…",
  coherenceResettingPlan: "Resetting plan…",
  completionPct: "{n}% complete",
  readyTimedOut: "Ready (stream timed out)",
  note: "Note",
  noPreviousMessage: "No previous message to edit",
  justNow: "just now",
  minutesAgoPattern: "{n}m ago",
  hoursAgoPattern: "{n}h ago",
  daysAgoPattern: "{n}d ago",
  loadedThread: (title) => `Loaded: ${title}`,
  contextCompacted: "Context compacted", compactFailed: "Compact failed",
  sendFailed: "Failed to send message", initFailed: "Failed to initialize",
  eventStreamError: "Event stream error",
  steerNoActiveTurn: "No running turn to steer",
  steerUnsupported: "Steering is not supported by this engine version",
  steerFailed: "Failed to steer",
  steerPlaceholder: "Steer the running turn...",
  steerBadge: "steer",
  steerBadgeTitle: "Sent as mid-turn steering",
  engineRestarted: "CodeWhale engine restarted",
  engineRestartFailed: "Failed to restart engine",
  engineNotRunning: "CodeWhale engine is not running",
  approvalRequired: "Approval required", allow: "Allow", deny: "Deny",
  thinkingToggle: "▶ Thinking", thinkingOpen: "▼ Thinking", thinkingClose: "▶ Thinking",
  threadsCountPattern: "{n} threads",
  loadedThreadPattern: "Loaded: {0}",
  showAllWorkspaces: "Show all workspaces",
  filterCurrentWorkspace: "Current workspace only",
  commandMode: "/mode - Switch mode (agent/plan/yolo)",
  commandModel: "/model - Switch model",
  commandModels: "/models - List available models",
  commandReasoning: "/reasoning - Set reasoning effort",
  commandConfig: "/config - Open settings",
  commandSettings: "/settings - Show current settings",
  commandClear: "/clear - Clear chat",
  commandInterrupt: "/interrupt - Interrupt current turn",
  commandHelp: "/help - Show help",
  commandCompact: "/compact - Compact context",
  commandExit: "/exit - Close sidebar",
  commandRename: "/rename - Rename current thread",
  commandSave: "/save - Save conversation",
  commandExport: "/export - Export conversation",
  commandContext: "/context - Show context info",
  commandTokens: "/tokens - Show token usage",
  commandCost: "/cost - Show cost info",
  commandStatus: "/status - Show engine status",
  commandHome: "/home - Show dashboard",
  commandWorkspace: "/workspace - Set workspace",
  commandTask: "/task - Manage tasks",
  commandJobs: "/jobs - Manage background jobs (partial: TUI runtime only)",
  commandNote: "/note <text> | add | list | remove <n> | clear | path - Manage workspace notes",
  commandMemory: "/memory [show|path|clear|edit] - Manage persistent user-memory file",
  commandTrust: "/trust - Manage trust settings",
  commandVerbose: "/verbose - Toggle verbose mode",
  commandTheme: "/theme - Change theme (not available in GUI)",
  commandUndo: "/undo - Shows last turn info (full undo not supported via API)",
  commandRetry: "/retry - Retry last turn",
  commandShare: "/share - Share conversation (not available: requires TUI HTTP server)",
  commandGoal: "/goal <objective> [| budget: <tokens>] | /goal clear - Set or clear session goal",
  commandSkills: "/skills - List skills",
  commandSkill: "/skill - Run a skill",
  commandMcp: "/mcp - Manage MCP servers",
  commandNetwork: "/network - Manage network rules",
  commandProvider: "/provider - Switch API provider",
  commandQueue: "/queue - Manage message queue",
  commandStash: "/stash - Stash/restore messages",
  commandHooks: "/hooks - Manage hooks",
  commandSubagents: "/subagents - List sub-agents",
  commandAgent: "/agent - Spawn a sub-agent",
  commandLinks: "/links - Show CodeWhale links",
  commandFeedback: "/feedback - Send feedback",
  commandAttach: "/attach - Attach a file",
  commandAnchor: "/anchor <text> | list | remove <n> - Manage compaction anchors",
  commandSessions: "/sessions - Manage sessions",
  commandLoad: "/load - Load a session",
  commandCycles: "/cycles - List cycles",
  commandCycle: "/cycle - Show cycle details",
  commandRecall: "/recall - Recall from archive",
  commandRelay: "/relay - Relay to next agent",
  commandInit: "/init - Initialize project config",
  commandLsp: "/lsp - LSP settings",
  commandReview: "/review - Review code",
  commandRestore: "/restore - Restore from snapshot",
  commandRlm: "/rlm - Recursive language model",
  commandChange: "/change - View changelog",
  commandCache: "/cache - Show per-turn prefix-cache telemetry for last 10 turns",
  commandProfile: "/profile <name> - Switch to a named config profile",
  commandTranslate: "/translate - Toggle translation mode on/off",
  commandSystem: "/system - Show the current system prompt",
  commandEdit: "/edit - Load the last user message into the input for editing",
  commandDiff: "/diff - Show git diff output for the workspace",
  commandStatusline: "/statusline - Status line info",
  commandLogout: "/logout - Logout",
  commandNotAvailableInGui: "This command is not available in the VSCode extension. Use the TUI terminal instead.",
  attachFiles: "Attach Files",
  removeAttachment: "Remove",
  attachedFileCount: "{n} file(s) attached",
  fileNotSupported: "File type not supported",
  changes: "Changes",
  noFileChanges: "No file changes in this session",
  fileChanges: "Changes",
  viewDiff: "View Diff",
  viewDiffTooltip: "Open diff view for this file",
  openFile: "Open File",
  openFileTooltip: "Open file in editor",
  noChanges: "No file changes this turn",
  changesThisTurn: "Changes This Turn",
  fileCreated: "created",
  fileModified: "modified",
  fileDeleted: "deleted",
  addedLines: "+{n}",
  removedLines: "-{n}",
  // Undo / Retry / Revert
  undoLastTurn: "Undo last turn",
  retryLastTurn: "Retry last turn",
  revertFile: "Revert",
  revertFileTooltip: "Revert this file to the state before this turn",
  revertThisFile: "Revert this file",
  revertConfirmTitle: "Revert file changes?",
  revertConfirmMessage: 'This will restore "{filePath}" to its pre-turn state. This cannot be undone. Continue?',
  revertConfirmButton: "Revert",
  revertCancelButton: "Cancel",
  revertSuccess: (filePath) => `Reverted ${filePath} to its pre-turn state.`,
  revertFailure: (filePath, reason) => `Failed to revert ${filePath}: ${reason}`,
  revertFileCreated: "This file was created in this turn. Reverting will delete it.",
  revertNotAvailable: "Revert is only available for changes made during this session. Reload the file to discard local edits.",
  revertNotSupported: "Revert is unavailable because the connected TUI runtime does not support snapshot restore yet.",
  revertUnsupportedTooltip: "Revert is unavailable in the connected TUI runtime",
  undoConfirmTitle: "Undo last turn?",
  undoConfirmMessage: "This will remove the last user/assistant exchange from the view. The server-side turn history is preserved, so the AI will still see your previous message in future turns.",
  undoConfirmButton: "Undo",
  undoNotSupported: "Undo is unavailable because the connected TUI runtime does not support patch-undo yet.",
  undoUnsupportedTooltip: "Undo is unavailable in the connected TUI runtime",
  retryConfirmTitle: "Retry last turn?",
  retryConfirmMessage: "This will remove the last exchange and re-send your last message. The original assistant response will be replaced.",
  retryConfirmButton: "Retry",
  undoNoTurns: "No turns to undo. The conversation is empty.",
  undoSuccess: (turnId) => `Undone turn ${turnId}. The exchange is hidden from the view; use /load-session to recover if needed.`,
  retryNoTurns: "No previous user message to retry.",
  retrySuccess: (turnId) => `Retrying with turn ${turnId}…`,
  retryInterrupted: "Retry was interrupted. A turn is already running — use /interrupt first.",
  retryNotSupported: "Retry is unavailable because the connected TUI runtime does not support server-side retry yet.",
  retryUnsupportedTooltip: "Retry is unavailable in the connected TUI runtime",
  // Last-turn summary
  lastTurnLabel: "Last turn",
  lastTurnNoPrevious: "No previous turn found.",
  // Revert for newly created files
  revertWillDelete: "(will be deleted)",
  // Session search & delete
  searchSessions: "Search",
  searchPlaceholder: "Search sessions...",
  deleteSession: "Delete",
  deleteSessionConfirmTitle: "Delete session?",
  deleteSessionConfirmMessage: 'This will permanently delete the session "{title}". This cannot be undone.',
  deleteSessionConfirmButton: "Delete",
  deleteSessionSuccess: "Session deleted",
  deleteSessionFailed: "Failed to delete session",
  switchSessionActiveTurnTitle: "Conversation in progress",
  switchSessionActiveTurnMessage: "The assistant is currently reasoning. Loading a session will stop the current turn. Continue?",
  switchSessionActiveTurnButton: "Stop & Switch",
  noSearchResults: "No matching sessions",
  // Agent panel
  agents: "Agents",
  noAgentRuns: "No agent runs",
  agentStatusQueued: "Queued",
  agentStatusStarting: "Starting",
  agentStatusRunning: "Running",
  agentStatusWaitingForUser: "Waiting for input",
  agentStatusModelWait: "Waiting for model",
  agentStatusRunningTool: "Running tool",
  agentStatusCompleted: "Completed",
  agentStatusFailed: "Failed",
  agentStatusCancelled: "Cancelled",
  agentStatusInterrupted: "Interrupted",
  agentObjective: "Objective",
  agentModel: "Model",
  agentSteps: "Steps",
  agentResult: "Result",
  agentError: "Error",
  agentRole: "Role",
  agentArtifacts: "Artifacts",
  agentUsage: "Token usage",
  agentSpawned: "Spawned",
  agentDelegating: "Delegating",
  agentFanout: "Fan-out",
  // Fleet panel
  fleet: "Fleet",
  noFleetRuns: "No Fleet runs",
  fleetWorkers: "Workers",
  fleetTasks: "Tasks",
  fleetReceipts: "Receipts",
  fleetStart: "Start",
  fleetStop: "Stop",
  fleetRestart: "Restart",
  fleetStatus: "Status",
  fleetAttempts: "Attempts",
  fleetScore: "Score",
  fleetViewReply: "View reply",
  fleetTaskInstructions: "Prompt",
  fleetNewFromRun: "New from this run",
  fleetNewFromRunHint: "Prefill the create dialog with this run's roles and tasks",
  fleetEvFilterIssues: "Issues",
  fleetEvFilterProgress: "Progress",
  fleetEvFilterAll: "All",
  fleetTaskFailure: "Failure",
  fleetEvRunCreated: "Run created",
  fleetEvRunStatus: "Run status",
  fleetEvEnqueued: "Task enqueued",
  fleetEvLeased: "Task leased",
  fleetEvTerminal: "Task ended",
  fleetEvReceipt: "Receipt",
  fleetEvHeartbeat: "Heartbeat",
  fleetEvAlert: "Alert",
  fleetInterrupt: "Interrupt",
  fleetStEnqueued: "Enqueued",
  fleetStLeased: "Leased",
  fleetStCompleted: "Completed",
  fleetStFailed: "Failed",
  fleetStCancelled: "Cancelled",
  fleetStUnknown: "Unknown",
  fleetStOnline: "Online",
  fleetStBusy: "Busy",
  fleetStOffline: "Offline",
  fleetStUnhealthy: "Unhealthy",
  fleetStDraining: "Draining",
  fleetStRetired: "Retired",
  fleetStQueued: "Queued",
  fleetStPending: "Pending",
  fleetStRunning: "Running",
  fleetStPaused: "Paused",
  fleetStEnqueuedHint: "Queued — waiting for a worker to pick it up",
  fleetLatestMessage: "Latest message",
  fleetNoWorkers: "No workers yet",
  fleetNoTasks: "No tasks yet",
  fleetNoReceipts: "No receipts yet",
  fleetRunId: "Run",
  fleetTaskCount: "Tasks",
  fleetWorkerCount: "Workers",
  fleetCreate: "Create Fleet run",
  fleetCreateDesc: "Launch several agents in parallel. Step 1: fill in basics · Step 2: declare roles (who does it) · Step 3: add tasks and pick a role for each (what to do).",
  fleetCreateName: "Name (optional)",
  fleetCreateWorkflowId: "Workflow ID",
  fleetCreateMaxWorkers: "Max workers (optional)",
  fleetCreateRoles: "Roles",
  fleetCreateRolesHint: "Optional: which agent profile this role uses",
  fleetProfileNone: "Default (no profile)",
  fleetCreateStartNow: "Start immediately after creation",
  fleetCreateBasics: "Basics",
  fleetCreateBasicsDesc: "Give this run an optional display name and a unique workflow ID.",
  fleetCreateRolesDesc: "Each role becomes one worker. The optional agent_profile selects which agent configuration backs the role.",
  fleetCreateTasksDesc: "Each task is assigned to one role. Every declared role must be used by at least one task.",
  fleetCreateTasks: "Tasks",
  fleetCreateAddRole: "Add role",
  fleetCreateAddTask: "Add task",
  fleetCreateTaskId: "Task ID",
  fleetCreateTaskName: "Task name",
  fleetCreateTaskRole: "Role",
  fleetCreateTaskObjective: "Objective (optional)",
  fleetCreateTaskInstructions: "Instructions",
  fleetCreateRemove: "Remove",
  fleetCreateSubmit: "Create run",
  fleetCreateTokenError: "must be a simple ASCII token: letters, digits, '-', '_', '.' (max 128 bytes)",
  fleetCreateDuplicate: "is used more than once in this run; ids must be unique within a run",
  // Goal control plane
  goalStatus: "Status",
  goalBudget: "Budget",
  goalTokensUsed: "Tokens used",
  goalTimeUsed: "Time used",
  goalContinuations: "Continuations",
  goalSet: "Set goal",
  goalEdit: "Edit",
  goalComplete: "Complete",
  goalBlock: "Block",
  goalDelete: "Delete",
  goalObjectivePlaceholder: "Describe the objective…",
  goalNoGoal: "No goal set for this thread",
  goalTokenBudgetLabel: "Token budget (optional)",
  goalCreatedAt: "Created",
  goalBudgetTooltip: "Tokens consumed vs. the goal's token budget",
  goalTokensUsedTooltip: "Total tokens consumed while pursuing this goal",
  goalTimeUsedTooltip: "Total active time spent pursuing this goal",
  goalContinuationsTooltip: "How many times this goal has been continued",
  goalBudgetExceeded: "over budget",
};

const zhCn: Translations = {
  locale: "zh-cn",
  history: "历史", threads: "线程", sessions: "会话", tasks: "任务", work: "工作",
  newThread: "+ 新建", compact: "⬒ 压缩", interrupt: "■ 停止",
  toggleHistory: "点击切换历史", send: "发送",
  inputPlaceholder: "向 CodeWhale 提问...",
  initializing: "初始化中...", ready: "就绪",
  thinking: "思考中...", streaming: "输出中...", processing: "处理中...",
  error: "错误", approvalAwaiting: "⏳ 等待审批...",
  userInputRequired: "需要输入",
  userInputAwaiting: "⏳ 等待您的输入...",
  noConversations: "暂无会话", threadAttention: "等待你的审批或输入——点击打开", noTasks: "暂无任务",
  taskCreate: "新建任务", taskCreateTitle: "新建任务", taskCreatePlaceholder: "描述要后台执行的任务…", taskCreateSubmit: "创建", taskRefresh: "刷新", taskDetails: "详情",
  taskOpenThread: "打开线程", taskAttention: "待处理", taskNeedsAttention: "需要处理", taskPendingApprovals: "待授权", taskPendingInputs: "待输入", taskContinueInThread: "在线程中继续",
  threadsCount: (n) => `${n} 个会话`,
  modelLabel: "模型", workspaceLabel: "工作区",
  modeLabel: "模式", reasoningEffortLabel: "思考深度",
  welcomeTitle: "CodeWhale",
  welcomeSubtitle: "科技服务文明传承的长线使命",
  welcomeQuote: "为天地立心，为生民立命，为往圣继绝学，为万世开太平。",
  welcomeQuoteAuthor: "—— 张载",
  welcomeSuggestionTitle: "今天想探索什么？",
  welcomeSuggestion1: "解释一个概念或想法",
  welcomeSuggestion2: "编写或重构代码",
  welcomeSuggestion3: "逐步分析一个问题",
  welcomeSuggestion4: "深入探索某个话题",
  noActiveWork: "暂无进行中的工作",
  cancel: "取消",
  goal: "目标",
  checklist: "检查清单",
  strategy: "策略",
  cycles: "轮次",
  coherenceHealthy: "健康",
  coherenceGettingCrowded: "上下文趋满",
  coherenceRefreshingContext: "正在刷新上下文…",
  coherenceVerifyingRecentWork: "正在验证近期工作…",
  coherenceResettingPlan: "正在重置计划…",
  completionPct: "已完成 {n}%",
  readyTimedOut: "就绪（流超时）",
  note: "提示",
  noPreviousMessage: "没有可编辑的上一条消息",
  justNow: "刚刚",
  minutesAgoPattern: "{n}分钟前",
  hoursAgoPattern: "{n}小时前",
  daysAgoPattern: "{n}天前",
  loadedThread: (title) => `已加载: ${title}`,
  contextCompacted: "上下文已压缩", compactFailed: "压缩失败",
  sendFailed: "发送消息失败", initFailed: "初始化失败",
  eventStreamError: "事件流错误",
  steerNoActiveTurn: "当前没有进行中的回复可引导",
  steerUnsupported: "当前引擎版本不支持引导",
  steerFailed: "引导失败",
  steerPlaceholder: "引导当前回复...",
  steerBadge: "引导",
  steerBadgeTitle: "作为中途引导发送",
  engineRestarted: "CodeWhale 引擎已重启",
  engineRestartFailed: "重启引擎失败",
  engineNotRunning: "CodeWhale 引擎未运行",
  approvalRequired: "需要审批", allow: "允许", deny: "拒绝",
  thinkingToggle: "▶ 思考过程", thinkingOpen: "▼ 思考过程", thinkingClose: "▶ 思考过程",
  threadsCountPattern: "{n} 个会话",
  loadedThreadPattern: "已加载: {0}",
  showAllWorkspaces: "显示所有工作区",
  filterCurrentWorkspace: "仅当前工作区",
  commandMode: "/mode - 切换模式 (agent/plan/yolo)",
  commandModel: "/model - 切换模型",
  commandModels: "/models - 列出可用模型",
  commandReasoning: "/reasoning - 设置思考深度",
  commandConfig: "/config - 打开设置",
  commandSettings: "/settings - 显示当前设置",
  commandClear: "/clear - 清空聊天",
  commandInterrupt: "/interrupt - 中断当前对话",
  commandHelp: "/help - 显示帮助",
  commandCompact: "/compact - 压缩上下文",
  commandExit: "/exit - 关闭侧边栏",
  commandRename: "/rename - 重命名当前会话",
  commandSave: "/save - 保存对话",
  commandExport: "/export - 导出对话",
  commandContext: "/context - 显示上下文信息",
  commandTokens: "/tokens - 显示 Token 用量",
  commandCost: "/cost - 显示费用信息",
  commandStatus: "/status - 显示引擎状态",
  commandHome: "/home - 显示仪表盘",
  commandWorkspace: "/workspace - 设置工作区",
  commandTask: "/task - 管理任务",
  commandJobs: "/jobs - 管理后台任务（部分支持：需TUI运行时）",
  commandNote: "/note <文本> | add | list | remove <n> | clear | path - 管理工作区笔记",
  commandMemory: "/memory [show|path|clear|edit] - 管理持久化用户记忆文件",
  commandTrust: "/trust - 管理信任设置",
  commandVerbose: "/verbose - 切换详细模式",
  commandTheme: "/theme - 更改主题 (GUI中不可用)",
  commandUndo: "/undo - 显示上一轮信息（完整撤销不受API支持）",
  commandRetry: "/retry - 重试上次对话",
  commandShare: "/share - 分享对话（不可用：需TUI HTTP服务器）",
  commandGoal: "/goal <目标> [| budget: <tokens>] | /goal clear - 设定或清除会话目标",
  commandSkills: "/skills - 列出技能",
  commandSkill: "/skill - 运行技能",
  commandMcp: "/mcp - 管理 MCP 服务器",
  commandNetwork: "/network - 管理网络规则",
  commandProvider: "/provider - 切换 API 提供商",
  commandQueue: "/queue - 管理消息队列",
  commandStash: "/stash - 暂存/恢复消息",
  commandHooks: "/hooks - 管理钩子",
  commandSubagents: "/subagents - 列出子代理",
  commandAgent: "/agent - 启动子代理",
  commandLinks: "/links - 显示 CodeWhale 链接",
  commandFeedback: "/feedback - 发送反馈",
  commandAttach: "/attach - 附加文件",
  commandAnchor: "/anchor <文本> | list | remove <n> - 管理压缩锚点",
  commandSessions: "/sessions - 管理会话",
  commandLoad: "/load - 加载会话",
  commandCycles: "/cycles - 列出周期",
  commandCycle: "/cycle - 显示周期详情",
  commandRecall: "/recall - 从归档中恢复",
  commandRelay: "/relay - 传递给下一个代理",
  commandInit: "/init - 初始化项目配置",
  commandLsp: "/lsp - LSP 设置",
  commandReview: "/review - 审查代码",
  commandRestore: "/restore - 从快照恢复",
  commandRlm: "/rlm - 递归语言模型",
  commandChange: "/change - 查看更新日志",
  commandCache: "/cache - 显示最近10轮的前缀缓存遥测数据",
  commandProfile: "/profile <名称> - 切换到指定配置档案",
  commandTranslate: "/translate - 开关翻译模式",
  commandSystem: "/system - 显示当前系统提示词",
  commandEdit: "/edit - 将上一条用户消息加载到输入框进行编辑",
  commandDiff: "/diff - 显示工作区的 git diff 输出",
  commandStatusline: "/statusline - 状态栏信息",
  commandLogout: "/logout - 登出",
  commandNotAvailableInGui: "此命令在 VSCode 扩展中不可用，请使用 TUI 终端。",
  attachFiles: "附加文件",
  removeAttachment: "移除",
  attachedFileCount: "已附加 {n} 个文件",
  fileNotSupported: "不支持的文件类型",
  changes: "变更",
  noFileChanges: "本次会话无文件变更",
  fileChanges: "文件变更",
  viewDiff: "查看差异",
  viewDiffTooltip: "在差异视图中对比文件变更",
  openFile: "打开文件",
  openFileTooltip: "在编辑器中打开文件",
  noChanges: "本轮无文件变更",
  changesThisTurn: "本轮文件变更",
  fileCreated: "新建",
  fileModified: "修改",
  fileDeleted: "删除",
  addedLines: "+{n}",
  removedLines: "-{n}",
  // 撤销 / 重试 / 回滚
  undoLastTurn: "撤销上一轮",
  retryLastTurn: "重试上一轮",
  revertFile: "回滚",
  revertFileTooltip: "将此文件回滚到本轮开始之前的状态",
  revertThisFile: "回滚此文件",
  revertConfirmTitle: "确认回滚文件?",
  revertConfirmMessage: '这将把「{filePath}」恢复到本轮开始之前的状态。该操作不可撤销,是否继续?',
  revertConfirmButton: "回滚",
  revertCancelButton: "取消",
  revertSuccess: (filePath) => `已回滚 ${filePath} 至本轮开始之前的状态。`,
  revertFailure: (filePath, reason) => `回滚 ${filePath} 失败:${reason}`,
  revertFileCreated: "此文件是在本轮中新建的,回滚会删除它。",
  revertNotAvailable: "回滚仅对本会话中产生的更改有效。如需放弃本地编辑,请直接重新加载文件。",
  revertNotSupported: "当前连接的 TUI 运行时尚未提供快照恢复接口,无法执行回滚。",
  revertUnsupportedTooltip: "当前 TUI 运行时不支持回滚",
  undoConfirmTitle: "确认撤销上一轮?",
  undoConfirmMessage: "这会从视图中移除最后一组用户/助手消息。服务器端的轮次历史仍然保留,AI 在后续轮次中仍会看到你之前的内容。",
  undoConfirmButton: "撤销",
  undoNotSupported: "当前连接的 TUI 运行时尚未提供 patch-undo 接口,无法执行撤销。",
  undoUnsupportedTooltip: "当前 TUI 运行时不支持撤销",
  retryConfirmTitle: "确认重试上一轮?",
  retryConfirmMessage: "这会移除最后一组消息,并重新发送你最后一条消息。原助手回复将被覆盖。",
  retryConfirmButton: "重试",
  undoNoTurns: "没有可撤销的轮次,对话为空。",
  undoSuccess: (turnId) => `已撤销轮次 ${turnId}。该组消息已在视图中隐藏;如需恢复,可使用 /load-session。`,
  retryNoTurns: "没有可重试的用户消息。",
  retrySuccess: (turnId) => `正在重试轮次 ${turnId}…`,
  retryInterrupted: "重试被中断:当前已有一个轮次正在运行,请先使用 /interrupt。",
  retryNotSupported: "当前连接的 TUI 运行时尚未提供 retry 接口,无法执行重试。",
  retryUnsupportedTooltip: "当前 TUI 运行时不支持重试",
  // 上一轮信息
  lastTurnLabel: "上一轮",
  lastTurnNoPrevious: "没有可用的上一轮。",
  // 针对新建文件的回滚
  revertWillDelete: "(将删除该文件)",
  // 会话搜索与删除
  searchSessions: "搜索",
  searchPlaceholder: "搜索会话...",
  deleteSession: "删除",
  deleteSessionConfirmTitle: "确认删除会话?",
  deleteSessionConfirmMessage: "将永久删除会话「{title}」，此操作不可撤销。",
  deleteSessionConfirmButton: "删除",
  deleteSessionSuccess: "会话已删除",
  deleteSessionFailed: "删除会话失败",
  switchSessionActiveTurnTitle: "当前对话正在进行中",
  switchSessionActiveTurnMessage: "助手正在推理中，加载会话将中断当前对话。是否继续？",
  switchSessionActiveTurnButton: "中断并切换",
  noSearchResults: "没有匹配的会话",
  // Agent panel
  agents: "子代理",
  noAgentRuns: "暂无子代理运行",
  agentStatusQueued: "排队中",
  agentStatusStarting: "启动中",
  agentStatusRunning: "运行中",
  agentStatusWaitingForUser: "等待输入",
  agentStatusModelWait: "等待模型",
  agentStatusRunningTool: "执行工具中",
  agentStatusCompleted: "已完成",
  agentStatusFailed: "失败",
  agentStatusCancelled: "已取消",
  agentStatusInterrupted: "已中断",
  agentObjective: "目标",
  agentModel: "模型",
  agentSteps: "步骤",
  agentResult: "结果",
  agentError: "错误",
  agentRole: "角色",
  agentArtifacts: "产物",
  agentUsage: "Token 用量",
  agentSpawned: "已启动",
  agentDelegating: "委派中",
  agentFanout: "扇出",
  // Fleet panel
  fleet: "车队",
  noFleetRuns: "暂无车队运行",
  fleetWorkers: "工作者",
  fleetTasks: "任务",
  fleetReceipts: "回执",
  fleetStart: "启动",
  fleetStop: "停止",
  fleetRestart: "重启",
  fleetStatus: "状态",
  fleetAttempts: "尝试",
  fleetScore: "得分",
  fleetViewReply: "查看最后回复",
  fleetTaskInstructions: "提示词",
  fleetNewFromRun: "从此创建新运行",
  fleetNewFromRunHint: "用本运行的角色和任务预填创建对话框",
  fleetEvFilterIssues: "异常",
  fleetEvFilterProgress: "进展",
  fleetEvFilterAll: "全部",
  fleetTaskFailure: "失败原因",
  fleetEvRunCreated: "运行创建",
  fleetEvRunStatus: "状态变更",
  fleetEvEnqueued: "任务入队",
  fleetEvLeased: "任务领取",
  fleetEvTerminal: "任务结束",
  fleetEvReceipt: "任务回执",
  fleetEvHeartbeat: "心跳",
  fleetEvAlert: "告警",
  fleetInterrupt: "中断",
  fleetStEnqueued: "已入队",
  fleetStLeased: "已领取",
  fleetStCompleted: "已完成",
  fleetStFailed: "失败",
  fleetStCancelled: "已取消",
  fleetStUnknown: "未知",
  fleetStOnline: "在线",
  fleetStBusy: "忙碌",
  fleetStOffline: "离线",
  fleetStUnhealthy: "异常",
  fleetStDraining: "退出中",
  fleetStRetired: "已退役",
  fleetStQueued: "排队中",
  fleetStPending: "等待中",
  fleetStRunning: "运行中",
  fleetStPaused: "已暂停",
  fleetStEnqueuedHint: "排队中，等待 worker 领取执行",
  fleetLatestMessage: "最新消息",
  fleetNoWorkers: "暂无工作者",
  fleetNoTasks: "暂无任务",
  fleetNoReceipts: "暂无回执",
  fleetRunId: "运行",
  fleetTaskCount: "任务数",
  fleetWorkerCount: "工作者数",
  fleetCreate: "创建车队运行",
  fleetCreateDesc: "并行启动多个 agent。第 1 步填写基本信息 · 第 2 步声明角色（谁来做）· 第 3 步添加任务并给每个任务指定角色（做什么）。",
  fleetCreateName: "名称（可选）",
  fleetCreateWorkflowId: "工作流 ID",
  fleetCreateMaxWorkers: "最大并发数（可选）",
  fleetCreateRoles: "角色",
  fleetCreateRolesHint: "可选：该角色使用的代理配置",
  fleetProfileNone: "默认（不指定 profile）",
  fleetCreateStartNow: "创建后立即启动",
  fleetCreateBasics: "基本信息",
  fleetCreateBasicsDesc: "为本次运行起一个可选的显示名，并填一个唯一的工作流 ID。",
  fleetCreateRolesDesc: "每个角色对应一类工作者。agent_profile 可选，用于指定该角色使用的代理配置。",
  fleetCreateTasksDesc: "每个任务指定一个角色。所有声明的角色都必须至少被一个任务使用。",
  fleetCreateTasks: "任务",
  fleetCreateAddRole: "添加角色",
  fleetCreateAddTask: "添加任务",
  fleetCreateTaskId: "任务 ID",
  fleetCreateTaskName: "任务名",
  fleetCreateTaskRole: "角色",
  fleetCreateTaskObjective: "目标（可选）",
  fleetCreateTaskInstructions: "指令",
  fleetCreateRemove: "移除",
  fleetCreateSubmit: "创建运行",
  fleetCreateTokenError: "必须是简单的 ASCII 标识：字母、数字、'-'、'_'、'.'（最长 128 字节）",
  fleetCreateDuplicate: "在本运行中重复；ID 在同一运行内必须唯一",
  // Goal control plane
  goalStatus: "状态",
  goalBudget: "预算",
  goalTokensUsed: "已用 Token",
  goalTimeUsed: "已用时长",
  goalContinuations: "续接次数",
  goalSet: "设定目标",
  goalEdit: "编辑",
  goalComplete: "完成",
  goalBlock: "阻塞",
  goalDelete: "删除",
  goalObjectivePlaceholder: "描述目标…",
  goalNoGoal: "该线程尚未设定目标",
  goalTokenBudgetLabel: "Token 预算（可选）",
  goalCreatedAt: "创建于",
  goalBudgetTooltip: "已用 Token 与该目标 Token 预算的对比",
  goalTokensUsedTooltip: "为达成此目标已消耗的 Token 总量",
  goalTimeUsedTooltip: "为达成此目标已花费的有效时长",
  goalContinuationsTooltip: "该目标被续接的次数",
  goalBudgetExceeded: "已超预算",
};

const translations: Record<string, Translations> = {
  en, "en-us": en, "en-gb": en,
  "zh-cn": zhCn, "zh-CN": zhCn, "zh-tw": zhCn, zh: zhCn,
};

// ── Public API ──

/** Full translation table for extension-side messages */
export function t(): Translations {
  const lang = vscode.env.language.toLowerCase();
  return translations[lang] || en;
}

/** Returns "zh-cn" or "en" */
export function currentLocale(): string {
  const lang = vscode.env.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh-cn";
  return "en";
}

/**
 * JSON-serialisable subset for embedding in webview HTML.
 * Functions (threadsCount, loadedThread) are serialised as replaceable strings.
 */
export function webviewTranslations(tr: Translations) {
  return {
    locale: tr.locale || "en",
    history: tr.history,
    threads: tr.threads,
    sessions: tr.sessions,
    tasks: tr.tasks,
    work: tr.work,
    newThread: tr.newThread,
    compact: tr.compact,
    interrupt: tr.interrupt,
    toggleHistory: tr.toggleHistory,
    send: tr.send,
    inputPlaceholder: tr.inputPlaceholder,
    initializing: tr.initializing,
    ready: tr.ready,
    thinking: tr.thinking,
    streaming: tr.streaming,
    processing: tr.processing,
    error: tr.error,
    approvalAwaiting: tr.approvalAwaiting,
    userInputRequired: tr.userInputRequired,
    userInputAwaiting: tr.userInputAwaiting,
    noConversations: tr.noConversations,
    threadAttention: tr.threadAttention,
    noTasks: tr.noTasks,
    taskCreate: tr.taskCreate,
    taskCreateTitle: tr.taskCreateTitle,
    taskCreatePlaceholder: tr.taskCreatePlaceholder,
    taskCreateSubmit: tr.taskCreateSubmit,
    taskRefresh: tr.taskRefresh,
    taskDetails: tr.taskDetails,
    taskOpenThread: tr.taskOpenThread,
    taskAttention: tr.taskAttention,
    taskNeedsAttention: tr.taskNeedsAttention,
    taskPendingApprovals: tr.taskPendingApprovals,
    taskPendingInputs: tr.taskPendingInputs,
    taskContinueInThread: tr.taskContinueInThread,
    threadsCountPattern: tr.threadsCountPattern,
    modelLabel: tr.modelLabel,
    workspaceLabel: tr.workspaceLabel,
    loadedThreadPattern: tr.loadedThreadPattern,
    showAllWorkspaces: tr.showAllWorkspaces,
    filterCurrentWorkspace: tr.filterCurrentWorkspace,
    approvalRequired: tr.approvalRequired,
    allow: tr.allow,
    deny: tr.deny,
    thinkingToggle: tr.thinkingToggle,
    thinkingOpen: tr.thinkingOpen,
    thinkingClose: tr.thinkingClose,
    contextCompacted: tr.contextCompacted,
    compactFailed: tr.compactFailed,
    sendFailed: tr.sendFailed,
    initFailed: tr.initFailed,
    eventStreamError: tr.eventStreamError,
    steerPlaceholder: tr.steerPlaceholder,
    steerBadge: tr.steerBadge,
    steerBadgeTitle: tr.steerBadgeTitle,
    engineRestarted: tr.engineRestarted,
    engineRestartFailed: tr.engineRestartFailed,
    engineNotRunning: tr.engineNotRunning,
    modeLabel: tr.modeLabel,
    reasoningEffortLabel: tr.reasoningEffortLabel,
    welcomeTitle: tr.welcomeTitle,
    welcomeSubtitle: tr.welcomeSubtitle,
    welcomeQuote: tr.welcomeQuote,
    welcomeQuoteAuthor: tr.welcomeQuoteAuthor,
    welcomeSuggestionTitle: tr.welcomeSuggestionTitle,
    welcomeSuggestion1: tr.welcomeSuggestion1,
    welcomeSuggestion2: tr.welcomeSuggestion2,
    welcomeSuggestion3: tr.welcomeSuggestion3,
    welcomeSuggestion4: tr.welcomeSuggestion4,
    noActiveWork: tr.noActiveWork,
    cancel: tr.cancel,
    goal: tr.goal,
    checklist: tr.checklist,
    strategy: tr.strategy,
    cycles: tr.cycles,
    coherenceHealthy: tr.coherenceHealthy,
    coherenceGettingCrowded: tr.coherenceGettingCrowded,
    coherenceRefreshingContext: tr.coherenceRefreshingContext,
    coherenceVerifyingRecentWork: tr.coherenceVerifyingRecentWork,
    coherenceResettingPlan: tr.coherenceResettingPlan,
    completionPct: tr.completionPct,
    readyTimedOut: tr.readyTimedOut,
    note: tr.note,
    noPreviousMessage: tr.noPreviousMessage,
    justNow: tr.justNow,
    minutesAgoPattern: tr.minutesAgoPattern,
    hoursAgoPattern: tr.hoursAgoPattern,
    daysAgoPattern: tr.daysAgoPattern,
    commandMode: tr.commandMode,
    commandModel: tr.commandModel,
    commandModels: tr.commandModels,
    commandReasoning: tr.commandReasoning,
    commandConfig: tr.commandConfig,
    commandSettings: tr.commandSettings,
    commandClear: tr.commandClear,
    commandInterrupt: tr.commandInterrupt,
    commandHelp: tr.commandHelp,
    commandCompact: tr.commandCompact,
    commandExit: tr.commandExit,
    commandRename: tr.commandRename,
    commandSave: tr.commandSave,
    commandExport: tr.commandExport,
    commandContext: tr.commandContext,
    commandTokens: tr.commandTokens,
    commandCost: tr.commandCost,
    commandStatus: tr.commandStatus,
    commandHome: tr.commandHome,
    commandWorkspace: tr.commandWorkspace,
    commandTask: tr.commandTask,
    commandJobs: tr.commandJobs,
    commandNote: tr.commandNote,
    commandMemory: tr.commandMemory,
    commandTrust: tr.commandTrust,
    commandVerbose: tr.commandVerbose,
    commandTheme: tr.commandTheme,
    commandUndo: tr.commandUndo,
    commandRetry: tr.commandRetry,
    commandShare: tr.commandShare,
    commandGoal: tr.commandGoal,
    commandSkills: tr.commandSkills,
    commandSkill: tr.commandSkill,
    commandMcp: tr.commandMcp,
    commandNetwork: tr.commandNetwork,
    commandProvider: tr.commandProvider,
    commandQueue: tr.commandQueue,
    commandStash: tr.commandStash,
    commandHooks: tr.commandHooks,
    commandSubagents: tr.commandSubagents,
    commandAgent: tr.commandAgent,
    commandLinks: tr.commandLinks,
    commandFeedback: tr.commandFeedback,
    commandAttach: tr.commandAttach,
    commandAnchor: tr.commandAnchor,
    commandSessions: tr.commandSessions,
    commandLoad: tr.commandLoad,
    commandCycles: tr.commandCycles,
    commandCycle: tr.commandCycle,
    commandRecall: tr.commandRecall,
    commandRelay: tr.commandRelay,
    commandInit: tr.commandInit,
    commandLsp: tr.commandLsp,
    commandReview: tr.commandReview,
    commandRestore: tr.commandRestore,
    commandRlm: tr.commandRlm,
    commandChange: tr.commandChange,
    commandCache: tr.commandCache,
    commandProfile: tr.commandProfile,
    commandTranslate: tr.commandTranslate,
    commandSystem: tr.commandSystem,
    commandEdit: tr.commandEdit,
    commandDiff: tr.commandDiff,
    commandStatusline: tr.commandStatusline,
    commandLogout: tr.commandLogout,
    commandNotAvailableInGui: tr.commandNotAvailableInGui,
    attachFiles: tr.attachFiles,
    removeAttachment: tr.removeAttachment,
    attachedFileCount: tr.attachedFileCount,
    fileNotSupported: tr.fileNotSupported,
    changes: tr.changes,
    noFileChanges: tr.noFileChanges,
    fileChanges: tr.fileChanges,
    viewDiff: tr.viewDiff,
    viewDiffTooltip: tr.viewDiffTooltip,
    openFile: tr.openFile,
    openFileTooltip: tr.openFileTooltip,
    noChanges: tr.noChanges,
    changesThisTurn: tr.changesThisTurn,
    fileCreated: tr.fileCreated,
    fileModified: tr.fileModified,
    fileDeleted: tr.fileDeleted,
    addedLines: tr.addedLines,
    removedLines: tr.removedLines,
    // Undo / Retry / Revert
    undoLastTurn: tr.undoLastTurn,
    retryLastTurn: tr.retryLastTurn,
    revertFile: tr.revertFile,
    revertFileTooltip: tr.revertFileTooltip,
    revertThisFile: tr.revertThisFile,
    revertConfirmTitle: tr.revertConfirmTitle,
    revertConfirmMessage: tr.revertConfirmMessage,
    revertConfirmButton: tr.revertConfirmButton,
    revertCancelButton: tr.revertCancelButton,
    revertSuccess: tr.revertSuccess,
    revertFailure: tr.revertFailure,
    revertFileCreated: tr.revertFileCreated,
    revertNotAvailable: tr.revertNotAvailable,
    revertNotSupported: tr.revertNotSupported,
    revertUnsupportedTooltip: tr.revertUnsupportedTooltip,
    undoConfirmTitle: tr.undoConfirmTitle,
    undoConfirmMessage: tr.undoConfirmMessage,
    undoConfirmButton: tr.undoConfirmButton,
    undoNotSupported: tr.undoNotSupported,
    undoUnsupportedTooltip: tr.undoUnsupportedTooltip,
    retryConfirmTitle: tr.retryConfirmTitle,
    retryConfirmMessage: tr.retryConfirmMessage,
    retryConfirmButton: tr.retryConfirmButton,
    undoNoTurns: tr.undoNoTurns,
    undoSuccess: tr.undoSuccess,
    retryNoTurns: tr.retryNoTurns,
    retrySuccess: tr.retrySuccess,
    retryInterrupted: tr.retryInterrupted,
    retryNotSupported: tr.retryNotSupported,
    retryUnsupportedTooltip: tr.retryUnsupportedTooltip,
    lastTurnLabel: tr.lastTurnLabel,
    lastTurnNoPrevious: tr.lastTurnNoPrevious,
    revertWillDelete: tr.revertWillDelete,
    // Session search & delete
    searchSessions: tr.searchSessions,
    searchPlaceholder: tr.searchPlaceholder,
    deleteSession: tr.deleteSession,
    deleteSessionConfirmTitle: tr.deleteSessionConfirmTitle,
    deleteSessionConfirmMessage: tr.deleteSessionConfirmMessage,
    deleteSessionConfirmButton: tr.deleteSessionConfirmButton,
    deleteSessionSuccess: tr.deleteSessionSuccess,
    deleteSessionFailed: tr.deleteSessionFailed,
    switchSessionActiveTurnTitle: tr.switchSessionActiveTurnTitle,
    switchSessionActiveTurnMessage: tr.switchSessionActiveTurnMessage,
    switchSessionActiveTurnButton: tr.switchSessionActiveTurnButton,
    noSearchResults: tr.noSearchResults,
    // Agent panel
    agents: tr.agents,
    noAgentRuns: tr.noAgentRuns,
    agentStatusQueued: tr.agentStatusQueued,
    agentStatusStarting: tr.agentStatusStarting,
    agentStatusRunning: tr.agentStatusRunning,
    agentStatusWaitingForUser: tr.agentStatusWaitingForUser,
    agentStatusModelWait: tr.agentStatusModelWait,
    agentStatusRunningTool: tr.agentStatusRunningTool,
    agentStatusCompleted: tr.agentStatusCompleted,
    agentStatusFailed: tr.agentStatusFailed,
    agentStatusCancelled: tr.agentStatusCancelled,
    agentStatusInterrupted: tr.agentStatusInterrupted,
    agentObjective: tr.agentObjective,
    agentModel: tr.agentModel,
    agentSteps: tr.agentSteps,
    agentResult: tr.agentResult,
    agentError: tr.agentError,
    agentRole: tr.agentRole,
    agentArtifacts: tr.agentArtifacts,
    agentUsage: tr.agentUsage,
    agentSpawned: tr.agentSpawned,
    agentDelegating: tr.agentDelegating,
    agentFanout: tr.agentFanout,
    // Fleet panel
    fleet: tr.fleet,
    noFleetRuns: tr.noFleetRuns,
    fleetWorkers: tr.fleetWorkers,
    fleetTasks: tr.fleetTasks,
    fleetReceipts: tr.fleetReceipts,
    fleetStart: tr.fleetStart,
    fleetStop: tr.fleetStop,
    fleetRestart: tr.fleetRestart,
    fleetStatus: tr.fleetStatus,
    fleetAttempts: tr.fleetAttempts,
    fleetScore: tr.fleetScore,
    fleetViewReply: tr.fleetViewReply,
    fleetTaskInstructions: tr.fleetTaskInstructions,
    fleetNewFromRun: tr.fleetNewFromRun,
    fleetNewFromRunHint: tr.fleetNewFromRunHint,
    fleetEvFilterIssues: tr.fleetEvFilterIssues,
    fleetEvFilterProgress: tr.fleetEvFilterProgress,
    fleetEvFilterAll: tr.fleetEvFilterAll,
    fleetTaskFailure: tr.fleetTaskFailure,
    fleetEvRunCreated: tr.fleetEvRunCreated,
    fleetEvRunStatus: tr.fleetEvRunStatus,
    fleetEvEnqueued: tr.fleetEvEnqueued,
    fleetEvLeased: tr.fleetEvLeased,
    fleetEvTerminal: tr.fleetEvTerminal,
    fleetEvReceipt: tr.fleetEvReceipt,
    fleetEvHeartbeat: tr.fleetEvHeartbeat,
    fleetEvAlert: tr.fleetEvAlert,
    fleetInterrupt: tr.fleetInterrupt,
    fleetStEnqueued: tr.fleetStEnqueued,
    fleetStLeased: tr.fleetStLeased,
    fleetStCompleted: tr.fleetStCompleted,
    fleetStFailed: tr.fleetStFailed,
    fleetStCancelled: tr.fleetStCancelled,
    fleetStUnknown: tr.fleetStUnknown,
    fleetStOnline: tr.fleetStOnline,
    fleetStBusy: tr.fleetStBusy,
    fleetStOffline: tr.fleetStOffline,
    fleetStUnhealthy: tr.fleetStUnhealthy,
    fleetStDraining: tr.fleetStDraining,
    fleetStRetired: tr.fleetStRetired,
    fleetStQueued: tr.fleetStQueued,
    fleetStPending: tr.fleetStPending,
    fleetStRunning: tr.fleetStRunning,
    fleetStPaused: tr.fleetStPaused,
    fleetStEnqueuedHint: tr.fleetStEnqueuedHint,
    fleetLatestMessage: tr.fleetLatestMessage,
    fleetNoWorkers: tr.fleetNoWorkers,
    fleetNoTasks: tr.fleetNoTasks,
    fleetNoReceipts: tr.fleetNoReceipts,
    fleetRunId: tr.fleetRunId,
    fleetTaskCount: tr.fleetTaskCount,
    fleetWorkerCount: tr.fleetWorkerCount,
    fleetCreate: tr.fleetCreate,
    fleetCreateDesc: tr.fleetCreateDesc,
    fleetCreateName: tr.fleetCreateName,
    fleetCreateWorkflowId: tr.fleetCreateWorkflowId,
    fleetCreateMaxWorkers: tr.fleetCreateMaxWorkers,
    fleetCreateRoles: tr.fleetCreateRoles,
    fleetCreateRolesHint: tr.fleetCreateRolesHint,
    fleetProfileNone: tr.fleetProfileNone,
    fleetCreateStartNow: tr.fleetCreateStartNow,
    fleetCreateBasics: tr.fleetCreateBasics,
    fleetCreateBasicsDesc: tr.fleetCreateBasicsDesc,
    fleetCreateRolesDesc: tr.fleetCreateRolesDesc,
    fleetCreateTasksDesc: tr.fleetCreateTasksDesc,
    fleetCreateTasks: tr.fleetCreateTasks,
    fleetCreateAddRole: tr.fleetCreateAddRole,
    fleetCreateAddTask: tr.fleetCreateAddTask,
    fleetCreateTaskId: tr.fleetCreateTaskId,
    fleetCreateTaskName: tr.fleetCreateTaskName,
    fleetCreateTaskRole: tr.fleetCreateTaskRole,
    fleetCreateTaskObjective: tr.fleetCreateTaskObjective,
    fleetCreateTaskInstructions: tr.fleetCreateTaskInstructions,
    fleetCreateRemove: tr.fleetCreateRemove,
    fleetCreateSubmit: tr.fleetCreateSubmit,
    fleetCreateTokenError: tr.fleetCreateTokenError,
    fleetCreateDuplicate: tr.fleetCreateDuplicate,
    // Goal control plane
    goalStatus: tr.goalStatus,
    goalBudget: tr.goalBudget,
    goalTokensUsed: tr.goalTokensUsed,
    goalTimeUsed: tr.goalTimeUsed,
    goalContinuations: tr.goalContinuations,
    goalSet: tr.goalSet,
    goalEdit: tr.goalEdit,
    goalComplete: tr.goalComplete,
    goalBlock: tr.goalBlock,
    goalDelete: tr.goalDelete,
    goalObjectivePlaceholder: tr.goalObjectivePlaceholder,
    goalNoGoal: tr.goalNoGoal,
    goalTokenBudgetLabel: tr.goalTokenBudgetLabel,
    goalCreatedAt: tr.goalCreatedAt,
    goalBudgetTooltip: tr.goalBudgetTooltip,
    goalTokensUsedTooltip: tr.goalTokensUsedTooltip,
    goalTimeUsedTooltip: tr.goalTimeUsedTooltip,
    goalContinuationsTooltip: tr.goalContinuationsTooltip,
    goalBudgetExceeded: tr.goalBudgetExceeded,
  };
}
