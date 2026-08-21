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
    modeLabel: "Mode",
    reasoningEffortLabel: "Reasoning",
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
    cycles: "Cycles",
    coherenceHealthy: "Healthy",
    coherenceGettingCrowded: "Getting crowded",
    coherenceRefreshingContext: "Refreshing context",
    coherenceVerifyingRecentWork: "Verifying recent work",
    coherenceResettingPlan: "Resetting plan",
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

  it("contains input area with all controls", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="input"');
    expect(html).toContain('id="btn-send-stop"');
    expect(html).toContain('id="btn-attach"');
    expect(html).toContain('id="slash-menu"');
    expect(html).toContain('id="attachments-area"');
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

  it("includes all module scripts (shared state + 9 modules = 10)", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    const scriptCount = (html.match(/<script nonce=/g) || []).length;
    expect(scriptCount).toBe(10);
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

  it("contains status bar with status text and stats", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="status-text"');
    expect(html).toContain('id="status-stats"');
  });

  it("contains thread count element", () => {
    const html = getWebviewHtml(makeMockWebview(), makeMockExtensionUri(), makeTr());
    expect(html).toContain('id="thread-count"');
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
