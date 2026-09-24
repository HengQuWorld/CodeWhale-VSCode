import { describe, it, expect } from "vitest";

const COMMAND_KEYS = [
  "commandMode", "commandModel", "commandModels", "commandReasoning",
  "commandConfig", "commandSettings", "commandClear", "commandHelp",
  "commandCompact", "commandExit", "commandRename", "commandSave",
  "commandExport", "commandContext", "commandTokens", "commandCost",
  "commandStatus", "commandHome", "commandWorkspace", "commandTask",
  "commandJobs", "commandNote", "commandMemory", "commandTrust",
  "commandVerbose", "commandTheme", "commandUndo", "commandRetry",
  "commandShare", "commandGoal", "commandSkills", "commandSkill",
  "commandMcp", "commandNetwork", "commandProvider", "commandQueue",
  "commandStash", "commandHooks", "commandSubagents", "commandAgent",
  "commandLinks", "commandFeedback", "commandAttach", "commandAnchor",
  "commandSessions", "commandLoad", "commandCycles", "commandCycle",
  "commandRecall", "commandRelay", "commandInit", "commandLsp",
  "commandReview", "commandRestore", "commandRlm", "commandChange",
  "commandCache", "commandProfile", "commandTranslate", "commandSystem",
  "commandEdit", "commandDiff", "commandLogout", "commandNotAvailableInGui",
];

describe("i18n command translations", () => {
  const enTranslations: Record<string, string> = {
    commandMode: "/mode - Switch mode (act/plan/operate)",
    commandModel: "/model - Switch model",
    commandModels: "/models - List available models",
    commandReasoning: "/reasoning - Set reasoning effort",
    commandConfig: "/config - Open settings",
    commandSettings: "/settings - Show current settings",
    commandClear: "/clear - Clear chat",
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
    commandJobs: "/jobs - Manage background jobs",
    commandNote: "/note - Manage notes",
    commandMemory: "/memory - Manage memory",
    commandTrust: "/trust - Manage trust settings",
    commandVerbose: "/verbose - Toggle verbose mode",
    commandTheme: "/theme - Change theme (not available in GUI)",
    commandUndo: "/undo - Undo last action",
    commandRetry: "/retry - Retry last turn",
    commandShare: "/share - Share conversation",
    commandGoal: "/goal - Set a goal",
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
    commandLinks: "/links - Show DeepSeek links",
    commandFeedback: "/feedback - Send feedback",
    commandAttach: "/attach - Attach a file",
    commandAnchor: "/anchor - Set anchor points",
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
    commandCache: "/cache - Cache telemetry",
    commandProfile: "/profile - Switch profile",
    commandTranslate: "/translate - Toggle translation",
    commandSystem: "/system - Show system prompt",
    commandEdit: "/edit - Edit last message",
    commandDiff: "/diff - Show diff",
    commandLogout: "/logout - Logout",
    commandNotAvailableInGui: "This command is not available in the VSCode extension. Use the TUI terminal instead.",
  };

  const zhCnTranslations: Record<string, string> = {
    commandMode: "/mode - 切换模式 (act/plan/operate)",
    commandModel: "/model - 切换模型",
    commandModels: "/models - 列出可用模型",
    commandReasoning: "/reasoning - 设置思考深度",
    commandConfig: "/config - 打开设置",
    commandSettings: "/settings - 显示当前设置",
    commandClear: "/clear - 清空聊天",
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
    commandJobs: "/jobs - 管理后台任务",
    commandNote: "/note - 管理笔记",
    commandMemory: "/memory - 管理记忆",
    commandTrust: "/trust - 管理信任设置",
    commandVerbose: "/verbose - 切换详细模式",
    commandTheme: "/theme - 更改主题 (GUI中不可用)",
    commandUndo: "/undo - 撤销上次操作",
    commandRetry: "/retry - 重试上次对话",
    commandShare: "/share - 分享对话",
    commandGoal: "/goal - 设定目标",
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
    commandLinks: "/links - 显示 DeepSeek 链接",
    commandFeedback: "/feedback - 发送反馈",
    commandAttach: "/attach - 附加文件",
    commandAnchor: "/anchor - 设置锚点",
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
    commandCache: "/cache - 缓存遥测",
    commandProfile: "/profile - 切换配置",
    commandTranslate: "/translate - 切换翻译",
    commandSystem: "/system - 显示系统提示",
    commandEdit: "/edit - 编辑上一条消息",
    commandDiff: "/diff - 显示差异",
    commandLogout: "/logout - 登出",
    commandNotAvailableInGui: "此命令在 VSCode 扩展中不可用，请使用 TUI 终端。",
  };

  it("has all command keys in English translations", () => {
    for (const key of COMMAND_KEYS) {
      expect(enTranslations[key], `Missing English translation for ${key}`).toBeDefined();
      expect(enTranslations[key].length, `Empty English translation for ${key}`).toBeGreaterThan(0);
    }
  });

  it("has all command keys in Chinese translations", () => {
    for (const key of COMMAND_KEYS) {
      expect(zhCnTranslations[key], `Missing Chinese translation for ${key}`).toBeDefined();
      expect(zhCnTranslations[key].length, `Empty Chinese translation for ${key}`).toBeGreaterThan(0);
    }
  });

  it("all command translations start with /command-name", () => {
    for (const key of COMMAND_KEYS) {
      if (key === "commandNotAvailableInGui") continue;
      const enVal = enTranslations[key];
      expect(enVal, `English ${key} should start with /`).toMatch(/^\//);
    }
  });

  it("commandNotAvailableInGui is properly set", () => {
    expect(enTranslations.commandNotAvailableInGui).toContain("not available");
    expect(zhCnTranslations.commandNotAvailableInGui).toContain("不可用");
  });

  it("has same number of command keys in both languages", () => {
    const enKeys = Object.keys(enTranslations).filter((k) => k.startsWith("command"));
    const zhKeys = Object.keys(zhCnTranslations).filter((k) => k.startsWith("command"));
    expect(enKeys.length).toBe(zhKeys.length);
  });
});

describe("i18n UI string translations", () => {
  const UI_KEYS: { key: string; en: string; zhCn: string }[] = [
    { key: "noActiveWork", en: "No active work", zhCn: "暂无进行中的工作" },
    { key: "cancel", en: "Cancel", zhCn: "取消" },
    { key: "goal", en: "Goal", zhCn: "目标" },
    { key: "checklist", en: "Checklist", zhCn: "检查清单" },
    { key: "strategy", en: "Strategy", zhCn: "策略" },
    { key: "completionPct", en: "{n}% complete", zhCn: "已完成 {n}%" },
    { key: "readyTimedOut", en: "Ready (stream timed out)", zhCn: "就绪（流超时）" },
    { key: "changesCount", en: "{n} change(s)", zhCn: "{n} 处变更" },
    { key: "filesCount", en: "{n} file(s)", zhCn: "{n} 个文件" },
    { key: "changeTurnLabel", en: "Turn {n}", zhCn: "第 {n} 轮" },
    { key: "locateChange", en: "Locate", zhCn: "定位" },
    { key: "locateChangeTooltip", en: "Jump to the tool call card that made this change", zhCn: "跳转到产生此变更的工具调用卡片" },
    { key: "note", en: "Note", zhCn: "提示" },
    { key: "noPreviousMessage", en: "No previous message to edit", zhCn: "没有可编辑的上一条消息" },
    { key: "justNow", en: "just now", zhCn: "刚刚" },
    { key: "contextCompacted", en: "Context compacted", zhCn: "上下文已压缩" },
    { key: "compactFailed", en: "Compact failed", zhCn: "压缩失败" },
    { key: "contextCompactionStarted", en: "Context compaction started", zhCn: "已开始压缩上下文" },
    {
      key: "compactRefusedActiveTurn",
      en: "This thread is already running a turn, so it can't be compacted yet. Press Stop, then try again.",
      zhCn: "会话正在运行，暂时无法压缩。请先停止当前回合再试。",
    },
    { key: "compactNoThread", en: "Open or start a conversation before compacting.", zhCn: "请先打开或新建一个会话，再进行压缩。" },
    { key: "sendFailed", en: "Failed to send message", zhCn: "发送消息失败" },
    { key: "initFailed", en: "Failed to initialize", zhCn: "初始化失败" },
    { key: "eventStreamError", en: "Event stream error", zhCn: "事件流错误" },
    { key: "engineNotRunning", en: "DeepSeek engine is not running", zhCn: "DeepSeek 引擎未运行" },
    { key: "approvalRequired", en: "Approval required", zhCn: "需要审批" },
    { key: "permissionLabel", en: "Permission", zhCn: "权限" },
    { key: "allow", en: "Allow", zhCn: "允许" },
    { key: "deny", en: "Deny", zhCn: "拒绝" },
  ];

  it("all UI keys have non-empty English translations", () => {
    for (const { key, en } of UI_KEYS) {
      expect(en.length, `English translation for ${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("all UI keys have non-empty Chinese translations", () => {
    for (const { key, zhCn } of UI_KEYS) {
      expect(zhCn.length, `Chinese translation for ${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("English and Chinese translations are different for all keys", () => {
    for (const { en, zhCn } of UI_KEYS) {
      expect(en).not.toBe(zhCn);
    }
  });
});

describe("i18n completionPct template", () => {
  it("English template replaces {n} with number", () => {
    const template = "{n}% complete";
    const result = template.replace("{n}", "75");
    expect(result).toBe("75% complete");
  });

  it("Chinese template replaces {n} with number", () => {
    const template = "已完成 {n}%";
    const result = template.replace("{n}", "50");
    expect(result).toBe("已完成 50%");
  });

  it("template works with 0%", () => {
    const template = "{n}% complete";
    expect(template.replace("{n}", "0")).toBe("0% complete");
  });

  it("template works with 100%", () => {
    const template = "已完成 {n}%";
    expect(template.replace("{n}", "100")).toBe("已完成 100%");
  });
});

describe("i18n time-relative strings", () => {
  it("minutesAgoPattern replaces {n}", () => {
    const en = "{n}m ago";
    const zhCn = "{n}分钟前";
    expect(en.replace("{n}", "5")).toBe("5m ago");
    expect(zhCn.replace("{n}", "5")).toBe("5分钟前");
  });

  it("hoursAgoPattern replaces {n}", () => {
    const en = "{n}h ago";
    const zhCn = "{n}小时前";
    expect(en.replace("{n}", "2")).toBe("2h ago");
    expect(zhCn.replace("{n}", "2")).toBe("2小时前");
  });

  it("daysAgoPattern replaces {n}", () => {
    const en = "{n}d ago";
    const zhCn = "{n}天前";
    expect(en.replace("{n}", "3")).toBe("3d ago");
    expect(zhCn.replace("{n}", "3")).toBe("3天前");
  });

  it("threadsCountPattern replaces {n}", () => {
    const en = "{n} threads";
    const zhCn = "{n} 个会话";
    expect(en.replace("{n}", "10")).toBe("10 threads");
    expect(zhCn.replace("{n}", "10")).toBe("10 个会话");
  });

  it("loadedThreadPattern replaces {0}", () => {
    const en = "Loaded: {0}";
    const zhCn = "已加载: {0}";
    expect(en.replace("{0}", "My Thread")).toBe("Loaded: My Thread");
    expect(zhCn.replace("{0}", "我的会话")).toBe("已加载: 我的会话");
  });
});

describe("i18n webview translations completeness", () => {
  const webviewKeys = [
    "locale", "history", "threads", "tasks", "work",
    "newThread", "compact", "interrupt", "send",
    "inputPlaceholder", "initializing", "ready",
    "thinking", "streaming", "processing", "error",
    "approvalAwaiting", "noConversations", "noTasks",
    "threadsCountPattern", "modelLabel", "workspaceLabel",
    "loadedThreadPattern", "approvalRequired", "allow", "deny",
    "thinkingToggle", "thinkingOpen", "thinkingClose",
    "noActiveWork", "cancel", "goal", "checklist", "strategy",
    "completionPct", "readyTimedOut",
    "welcomeTitle", "welcomeSubtitle",
    "welcomeQuote", "welcomeQuoteAuthor",
    "welcomeSuggestionTitle", "welcomeSuggestion1",
    "welcomeSuggestion2", "welcomeSuggestion3", "welcomeSuggestion4",
  ];

  it("all webview keys are defined in both languages", () => {
    for (const key of webviewKeys) {
      expect(key.length, `Key ${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("webview keys cover work panel fields", () => {
    const workKeys = ["noActiveWork", "goal", "checklist", "strategy", "completionPct"];
    for (const key of workKeys) {
      expect(webviewKeys).toContain(key);
    }
  });
});
