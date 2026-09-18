import { describe, it, expect, vi } from "vitest";
import { getWebviewHtml, WebviewTranslations } from "./webview-html";

// Mock vscode since webview-html.ts imports it
vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p }),
    joinPath: (...args: string[]) => ({ fsPath: args.join("/") }),
  },
}));

function makeTr(): WebviewTranslations {
  return {
    locale: "en",
    history: "History",
    threads: "Threads",
    sessions: "Sessions",
    tasks: "Tasks",
    work: "Work",
    activity: "Activity",
    agentStatus: "Agent",
    agentStatusTitle: "Open agent panel",
    closePanel: "Close panel",
    sessionsTabHint: "Saved sessions",
    threadsTabHint: "Active threads",
    activityTabHint: "Agent activity",
    newThread: "New Thread",
    compact: "Compact",
    interrupt: "Interrupt",
    toggleHistory: "Toggle History",
    send: "Send",
    inputPlaceholder: "Type a message...",
    initializing: "Initializing...",
    ready: "Ready",
    thinking: "Thinking...",
    streaming: "Streaming...",
    processing: "Processing...",
    error: "Error",
    approvalAwaiting: "Approval Required",
    noConversations: "No conversations",
    threadAttention: "Waiting for your approval or input — click to open",
    threadsNeedsYou: "Needs you",
    threadsRunning: "Running",
    threadsRecent: "Recent",
    threadsLoading: "Loading threads…",
    threadsLoadFailed: "Couldn't load the thread list",
    threadsRetry: "Retry",
    goalBackgroundRun: "Run on a background thread",
    goalBackgroundHint: "Background goals keep working while you chat here.",
    goalBackgroundSection: "Background goals",
    goalResume: "Resume",
    noTasks: "No tasks",
    taskCreate: "New Task",
    taskCreateTitle: "Create Task",
    taskCreatePlaceholder: "Describe the background task...",
    taskCreateSubmit: "Create",
    taskRefresh: "Refresh",
    taskDetails: "Details",
    taskOpenThread: "Open Thread",
    taskAttention: "Attention",
    taskNeedsAttention: "Needs attention",
    taskPendingApprovals: "Pending Approvals",
    taskPendingInputs: "Pending Inputs",
    taskContinueInThread: "Continue in thread",
    threadsCountPattern: "{n} threads",
    modelLabel: "Model",
    workspaceLabel: "Workspace",
    loadedThreadPattern: "Loaded: {0}",
    showAllWorkspaces: "Show all workspaces",
    filterCurrentWorkspace: "Current workspace",
    approvalRequired: "Approval required",
    allow: "Allow",
    deny: "Deny",
    thinkingToggle: "Thinking",
    thinkingOpen: "▶ Thinking",
    thinkingClose: "▼ Thinking",
    steerPlaceholder: "Steer the running turn...",
    steerBadge: "steer",
    steerBadgeTitle: "Sent as mid-turn steering",
    modeLabel: "Mode",
    permissionLabel: "Permission",
    scopeThreadLabel: "This thread",
    scopeDefaultLabel: "New threads",
    scopeDefaultTitle: "New conversations start here; this one keeps its own setting.",
    reasoningEffortLabel: "Reasoning",
    planApproveButton: "Switch to Act & execute",
    welcomeTitle: "CodeWhale",
    welcomeSubtitle: "Your AI coding partner",
    welcomeQuote: "The best way to predict the future is to invent it.",
    welcomeQuoteAuthor: "Alan Kay",
    welcomeSuggestionTitle: "Try asking",
    welcomeSuggestion1: "Explain this code",
    welcomeSuggestion2: "Write a test",
    welcomeSuggestion3: "Find bugs",
    welcomeSuggestion4: "Refactor this",
    noActiveWork: "No active work",
    cancel: "Cancel",
    goal: "Goal",
    checklist: "Checklist",
    strategy: "Strategy",
    completionPct: "0%",
    readyTimedOut: "Ready timed out",
    note: "Note",
    noPreviousMessage: "No previous message",
    justNow: "just now",
    minutesAgoPattern: "{n} min ago",
    hoursAgoPattern: "{n}h ago",
    daysAgoPattern: "{n}d ago",
    commandMode: "/mode",
    commandModel: "/model",
    commandModels: "/models",
    commandReasoning: "/reasoning",
    commandConfig: "/config",
    commandSettings: "/settings",
    commandClear: "/clear",
    commandInterrupt: "/interrupt",
    commandHelp: "/help",
    commandCompact: "/compact",
    commandExit: "/exit",
    commandRename: "/rename",
    commandSave: "/save",
    commandExport: "/export",
    commandContext: "/context",
    commandTokens: "/tokens",
    commandCost: "/cost",
    commandStatus: "/status",
    commandHome: "/home",
    commandWorkspace: "/workspace",
    commandTask: "/task",
    commandJobs: "/jobs",
    commandNote: "/note",
    commandMemory: "/memory",
    commandTrust: "/trust",
    commandVerbose: "/verbose",
    commandTheme: "/theme",
    commandUndo: "/undo",
    commandRetry: "/retry",
    commandShare: "/share",
    commandGoal: "/goal",
    commandSkills: "/skills",
    commandSkill: "/skill",
    commandMcp: "/mcp",
    commandNetwork: "/network",
    commandProvider: "/provider",
    commandQueue: "/queue",
    commandStash: "/stash",
    commandHooks: "/hooks",
    commandSubagents: "/subagents",
    commandAgent: "/agent",
    commandLinks: "/links",
    commandFeedback: "/feedback",
    commandAttach: "/attach",
    commandAnchor: "/anchor",
    commandSessions: "/sessions",
    commandLoad: "/load",
    commandCycles: "/cycles",
    commandCycle: "/cycle",
    commandRecall: "/recall",
    commandRelay: "/relay",
    commandInit: "/init",
    commandLsp: "/lsp",
    commandReview: "/review",
    commandRestore: "/restore",
    commandRlm: "/rlm",
    commandChange: "/change",
    commandCache: "/cache",
    commandProfile: "/profile",
    commandTranslate: "/translate",
    commandSystem: "/system",
    commandEdit: "/edit",
    commandDiff: "/diff",
    commandStatusline: "/statusline",
    commandLogout: "/logout",
    commandNotAvailableInGui: "Not available in GUI",
    attachFiles: "Attach files",
    removeAttachment: "Remove",
    attachedFileCount: "{n} files attached",
    fileNotSupported: "File type not supported",
    changes: "Changes",
    noFileChanges: "No file changes in this session",
    undoLastTurn: "Undo last turn",
    retryLastTurn: "Retry last turn",
    undoLabel: "Undo",
    retryLabel: "Retry",
    undoUnsupportedTooltip: "Undo not supported",
    retryUnsupportedTooltip: "Retry not supported",
    revertUnsupportedTooltip: "Revert not supported",
    fileCreated: "Created",
    fileDeleted: "Deleted",
    fileModified: "Modified",
    viewDiff: "View Diff",
    viewDiffTooltip: "View file diff",
    openFile: "Open File",
    openFileTooltip: "Open file in editor",
    revertFile: "Revert",
    revertFileTooltip: "Revert file changes",
    fileChanges: "File Changes",
    userInputAwaiting: "Input required",
    searchSessions: "Search",
    searchPlaceholder: "Search sessions...",
    deleteSession: "Delete",
    deleteSessionConfirmTitle: "Delete session?",
    deleteSessionConfirmMessage: 'This will permanently delete the session "{title}". This cannot be undone.',
    deleteSessionConfirmButton: "Delete",
    deleteSessionSuccess: "Session deleted",
    deleteSessionFailed: "Failed to delete session",
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
    fleetCreateTokenError: "must be a simple ASCII token",
    fleetCreateDuplicate: "is used more than once in this run",
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
}

function makeMockWebview() {
  return {
    asWebviewUri: (uri: any) => uri,
  } as any;
}

function makeMockExtensionUri() {
  return { fsPath: "/test/extension" } as any;
}

describe("webview-html.ts assembler", () => {
  it("returns a complete HTML document", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("contains CSP header with nonce", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("style-src 'nonce-");
    expect(html).toContain("script-src 'nonce-");
  });

  it("allows data-url images for attachment previews", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("img-src data:");
  });

  it("contains CSS from webview-css module", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("--bg:");
    expect(html).toContain("--fg:");
    expect(html).toContain("#layout");
    expect(html).toContain("#messages");
  });

  it("contains HTML structure with all key elements", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="layout"');
    expect(html).toContain('id="threads-panel"');
    expect(html).toContain('id="sidebar-resize-handle"');
    expect(html).toContain('id="input-resize-handle"');
    expect(html).toContain('id="chat-area"');
    expect(html).toContain('id="messages"');
    expect(html).toContain('id="input-area"');
    expect(html).toContain('id="toolbar"');
    expect(html).toContain('id="settings-bar"');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="ui-tooltip"');
    expect(html).toContain('id="debug-panel"');
  });

  it("contains sidebar sections", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="sidebar-threads"');
    expect(html).toContain('id="sidebar-work"');
    expect(html).toContain('id="sidebar-tasks"');
    expect(html).toContain('id="sidebar-changes"');
    expect(html).toContain('id="tab-sessions"');
    expect(html).toContain('id="tab-threads-list"');
    expect(html).toContain('id="tab-work"');
    expect(html).toContain('id="tab-tasks"');
    expect(html).toContain('id="tab-changes"');
  });

  it("orders the Activity sections as Work, Changes, Fleet, Tasks, Agents", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    // Changes sits directly under Work: it is the highest-signal section for a
    // running session, so it must not fall below Fleet/Tasks/Agents.
    const ordered = [
      'sidebar-work',
      'sidebar-changes',
      'sidebar-fleet',
      'sidebar-tasks',
      'sidebar-agents',
    ];
    const positions = ordered.map((id) => html.indexOf(`id="${id}"`));
    positions.forEach((pos) => expect(pos).toBeGreaterThan(-1));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps the goal inside the Work panel instead of its own section", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    // The goal used to be a second sidebar section, which duplicated the Work
    // panel's goal row. It is now the Work panel's first slot, and the body
    // below it is the second — so both live under one section.
    expect(html).not.toContain('id="sidebar-goal"');
    expect(html).not.toContain('id="tab-goal"');
    expect(html).toContain('id="work-goal"');
    expect(html).toContain('id="work-body"');
    expect(html).toMatch(/id="tab-work"[\s\S]*id="work-goal"[\s\S]*id="work-body"/);
    // The goal renderer must target that slot, not a container of its own.
    expect(html).toContain("getElementById('work-goal')");
  });

  it("contains input area with all controls", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="input"');
    expect(html).toContain('id="btn-send-stop"');
    expect(html).toContain('id="btn-attach"');
    expect(html).toContain('id="slash-menu"');
    expect(html).toContain('id="attachments-area"');
  });

  it("stacks the composer's textarea above a bottom toolbar", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    const boxStart = html.indexOf('id="input-box"');
    const toolbarStart = html.indexOf('id="input-toolbar"');
    const composer = html.slice(boxStart, toolbarStart);
    const toolbar = html.slice(toolbarStart, html.indexOf('id="status"'));

    // The textarea sits inside the composer, above the toolbar.
    expect(boxStart).toBeGreaterThan(-1);
    expect(composer).toContain('id="input"');
    expect(composer).not.toContain('id="btn-attach"');
    // Attach comes first (left) and send last (far right) in the toolbar.
    expect(toolbar).toContain('id="btn-attach"');
    expect(toolbar).toContain('id="btn-send-stop"');
    expect(toolbar.indexOf('id="btn-attach"')).toBeLessThan(
      toolbar.indexOf('id="btn-send-stop"')
    );
  });

  it("drags the textarea's own height within the CSS bounds", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());

    // The handle sizes the textarea rather than the whole area: the composer
    // follows it, and text past that height scrolls inside the box.
    expect(html).toContain("var MIN_INPUT_HEIGHT = 52;");
    expect(html).toContain("var MAX_INPUT_HEIGHT = 340;");
    expect(html).toContain("inputEl.style.height = newHeight + 'px';");
    expect(html).not.toContain("function minAreaHeight()");
  });

  it("keeps the send control icon-only", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());

    // A plane for send, a square for stop, and no text labels left over.
    expect(html).toContain("btn-icon-send");
    expect(html).toContain("btn-icon-stop");
    expect(html).not.toContain("btn-text-send");
    expect(html).not.toContain("btn-text-stop");
  });

  it("contains toolbar buttons", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="btn-new-thread"');
    expect(html).toContain('id="btn-threads"');
    expect(html).toContain('id="btn-compact"');
    expect(html).toContain('id="btn-undo"');
    expect(html).toContain('id="btn-retry"');
  });

  it("injects translation strings into HTML", () => {
    const tr = makeTr();
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), tr);
    expect(html).toContain(tr.sessions);
    expect(html).toContain(tr.threads);
    expect(html).toContain(tr.send);
    expect(html).toContain(tr.inputPlaceholder);
    expect(html).toContain(tr.initializing);
    expect(html).toContain(tr.newThread);
    expect(html).toContain(tr.compact);
    expect(html).toContain(tr.interrupt);
  });

  it("contains shared state initialization script", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("acquireVsCodeApi");
    expect(html).toContain("window.__wvVscode");
    expect(html).toContain("window.__wvDiffStore");
    expect(html).toContain("window.__wvDiffIdCounter");
    expect(html).toContain("window.__wvApiCapabilities");
    expect(html).toContain("window.__wvSidebar");
  });

  it("includes all module scripts (shared state + modules = 12)", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    const scriptCount = (html.match(/<script nonce=/g) || []).length;
    expect(scriptCount).toBe(12);
  });

  it("drags the sidebar width with hardened listeners and persists it", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());

    // Restored handle wired to the threads panel, sized with rAF-throttled
    // writes, freed on mouseleave/blur, and persisted across sessions.
    expect(html).toContain("getElementById('sidebar-resize-handle')");
    expect(html).toContain("getElementById('threads-panel')");
    expect(html).toContain("window.addEventListener('mousemove', onMouseMove)");
    expect(html).toContain("window.addEventListener('mouseleave', onMouseUp)");
    expect(html).toContain("window.addEventListener('blur', onMouseUp)");
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("cancelAnimationFrame");
    expect(html).toContain("localStorage.getItem('codewhale:sidebarWidth')");
    expect(html).toContain("localStorage.setItem('codewhale:sidebarWidth'");
    expect(html).toContain("panel.style.width = newWidth + 'px';");
  });

  it("contains utilities module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("window.__wvEscapeHtml");
    expect(html).toContain("window.__wvFormatRelativeTime");
    expect(html).toContain("window.__wvI18n");
  });

  it("contains debug module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("window.__wvDbg");
    expect(html).toContain("window.__wvPostUiProbe");
  });

  it("contains tooltip module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("function showTooltipForTarget");
    expect(html).toContain("function hideTooltip");
  });

  it("contains sidebar module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("function renderSessions");
    expect(html).toContain("function renderThreads");
    expect(html).toContain("function renderTasks");
    expect(html).toContain("function renderWork");
    expect(html).toContain("window.__wvSidebar = {");
  });

  it("contains messages module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("function addMessage");
    expect(html).toContain("function renderToolCall");
    expect(html).toContain("window.__wvMessages = {");
  });

  it("contains input module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("function sendMessage");
    expect(html).toContain("slashMenuOpen");
  });

  it("contains event handler module output", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("window.addEventListener('message'");
    expect(html).toContain("case 'ready'");
    expect(html).toContain("case 'addMessage'");
  });

  it("generates unique nonces for each call", () => {
    const html1 = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    const html2 = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    const nonce1 = html1.match(/nonce-([a-zA-Z0-9]{32})/)?.[1];
    const nonce2 = html2.match(/nonce-([a-zA-Z0-9]{32})/)?.[1];
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
  });

  it("handles zh-cn locale", () => {
    const tr = makeTr();
    tr.locale = "zh-cn";
    tr.sessions = "会话";
    tr.threads = "线程";
    tr.send = "发送";
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), tr);
    expect(html).toContain("会话");
    expect(html).toContain("线程");
    expect(html).toContain("发送");
    expect(html).toContain("var __locale = 'zh-cn'");
  });

  it("sidebar state has all required fields", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("sessions: []");
    expect(html).toContain("activeSessionId: null");
    expect(html).toContain("threads: []");
    expect(html).toContain("activeThreadId: null");
    expect(html).toContain("showAllWorkspaces: false");
    expect(html).toContain("sidebarTab: 'sessions'");
    expect(html).toContain("workState:");
    expect(html).toContain("renderSessions:");
    expect(html).toContain("renderThreads:");
    expect(html).toContain("renderTasks:");
    expect(html).toContain("renderWork:");
    expect(html).toContain("switchSidebarTab:");
  });

  it("API capabilities default to all false", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain("saveSession: false");
    expect(html).toContain("undoLastTurn: false");
    expect(html).toContain("retryLastTurn: false");
    expect(html).toContain("revertFileChange: false");
  });

  it("contains task detail overlay element", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="task-detail-overlay"');
  });

  it("contains settings bar with mode, model, reasoning", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="current-mode"');
    expect(html).toContain('id="current-model"');
    expect(html).toContain('id="current-reasoning"');
  });

  it("renders the TUI mode roster (Act / Plan / Operate) and the permission posture", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="dropdown-mode"');
    expect(html).toContain('data-value="agent"');
    expect(html).toContain('data-value="plan"');
    expect(html).toContain('data-value="operate"');
    expect(html).toContain('>Act<');
    expect(html).toContain('>Plan<');
    expect(html).toContain('>Operate<');
    // `yolo` is a compatibility alias, never a visible mode.
    expect(html).not.toContain('data-value="yolo"');

    expect(html).toContain('id="current-posture"');
    expect(html).toContain('id="dropdown-posture"');
    expect(html).toContain('data-value="ask"');
    expect(html).toContain('data-value="auto_review"');
    expect(html).toContain('data-value="full_access"');
    expect(html).toContain('>Auto-Review<');
    expect(html).toContain('>Full Access<');
  });

  it("offers the mode and permission roster under both scopes", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());

    // Each roster appears twice: once for this thread, once as the startup
    // default new threads inherit. The scope is on the item so a click can be
    // addressed to one of them instead of inferred.
    expect(html).toContain("This thread");
    expect(html).toContain("New threads");
    for (const scope of ["thread", "default"]) {
      for (const value of ["agent", "plan", "operate", "ask", "auto_review", "full_access"]) {
        expect(html).toContain(`data-scope="${scope}" data-value="${value}"`);
      }
    }
    // The label alone does not say what the second group changes, so it carries
    // a title.
    expect(html).toContain("New conversations start here");
  });

  it("contains status bar with status text and stats", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="status-text"');
    expect(html).toContain('id="status-stats"');
  });

  it("contains the agent panel toggle", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="agent-panel-toggle"');
  });

  it("contains workspace filter toggle", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="workspace-filter-toggle"');
  });

  it("contains sidebar tab buttons", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="tab-sessions-btn"');
    expect(html).toContain('id="tab-threads-btn"');
  });
});
