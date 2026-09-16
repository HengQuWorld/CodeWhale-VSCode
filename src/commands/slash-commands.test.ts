import { describe, it, expect } from "vitest";
import {
  SlashCommandRegistry,
  categorizeCommand,
  isCommandAvailableInGui,
  getCommandHelpText,
} from "./slash-commands";

describe("SlashCommandRegistry", () => {
  const registry = new SlashCommandRegistry();

  describe("getAllCommands", () => {
    it("returns all TUI slash commands", () => {
      const commands = registry.getAllCommands();
      expect(commands.length).toBeGreaterThan(30);
    });

    it("includes core commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/mode");
      expect(names).toContain("/model");
      expect(names).toContain("/clear");
      expect(names).toContain("/help");
      expect(names).toContain("/compact");
      expect(names).toContain("/exit");
    });

    it("includes config commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/config");
      expect(names).toContain("/settings");
      expect(names).toContain("/reasoning");
      expect(names).toContain("/trust");
      expect(names).toContain("/verbose");
    });

    it("includes session commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/rename");
      expect(names).toContain("/save");
      expect(names).toContain("/export");
      expect(names).toContain("/sessions");
      expect(names).toContain("/load");
    });

    it("includes debug commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/tokens");
      expect(names).toContain("/cost");
      expect(names).toContain("/context");
      expect(names).toContain("/status");
      expect(names).toContain("/system");
    });

    it("includes skills commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/skills");
      expect(names).toContain("/skill");
      expect(names).toContain("/review");
    });

    it("includes advanced commands", () => {
      const commands = registry.getAllCommands();
      const names = commands.map((c) => c.name);
      expect(names).toContain("/mcp");
      expect(names).toContain("/network");
      expect(names).toContain("/provider");
      expect(names).toContain("/queue");
      expect(names).toContain("/stash");
      expect(names).toContain("/hooks");
      expect(names).toContain("/subagents");
      expect(names).toContain("/agent");
      expect(names).toContain("/rlm");
    });
  });

  describe("filterCommands", () => {
    it("filters by prefix", () => {
      const results = registry.filterCommands("/mo");
      const names = results.map((c) => c.name);
      expect(names).toContain("/mode");
      expect(names).toContain("/model");
      expect(names).toContain("/models");
    });

    it("returns all commands for just /", () => {
      const results = registry.filterCommands("/");
      expect(results.length).toBeGreaterThan(30);
    });

    it("returns empty for non-matching prefix", () => {
      const results = registry.filterCommands("/xyz");
      expect(results).toHaveLength(0);
    });

    it("filters by description keywords", () => {
      const results = registry.filterCommands("/mode");
      const names = results.map((c) => c.name);
      expect(names).toContain("/mode");
    });

    it("matches /re to reasoning, rename, relay, recall, restore, review, rlm", () => {
      const results = registry.filterCommands("/re");
      const names = results.map((c) => c.name);
      expect(names).toContain("/reasoning");
      expect(names).toContain("/rename");
      expect(names).toContain("/relay");
      expect(names).toContain("/recall");
      expect(names).toContain("/restore");
      expect(names).toContain("/review");
    });
  });

  describe("getCommand", () => {
    it("returns command by exact name", () => {
      const cmd = registry.getCommand("/mode");
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("/mode");
    });

    it("returns undefined for unknown command", () => {
      const cmd = registry.getCommand("/unknown");
      expect(cmd).toBeUndefined();
    });
  });
});

describe("categorizeCommand", () => {
  it("categorizes core commands", () => {
    expect(categorizeCommand("/clear")).toBe("core");
    expect(categorizeCommand("/help")).toBe("core");
    expect(categorizeCommand("/exit")).toBe("core");
  });

  it("categorizes config commands", () => {
    expect(categorizeCommand("/mode")).toBe("config");
    expect(categorizeCommand("/model")).toBe("config");
    expect(categorizeCommand("/reasoning")).toBe("config");
    expect(categorizeCommand("/config")).toBe("config");
    expect(categorizeCommand("/settings")).toBe("config");
  });

  it("categorizes session commands", () => {
    expect(categorizeCommand("/compact")).toBe("session");
    expect(categorizeCommand("/rename")).toBe("session");
    expect(categorizeCommand("/save")).toBe("session");
    expect(categorizeCommand("/export")).toBe("session");
  });

  it("categorizes debug commands", () => {
    expect(categorizeCommand("/tokens")).toBe("debug");
    expect(categorizeCommand("/cost")).toBe("debug");
    expect(categorizeCommand("/context")).toBe("debug");
    expect(categorizeCommand("/status")).toBe("debug");
  });

  it("categorizes skills commands", () => {
    expect(categorizeCommand("/skills")).toBe("skills");
    expect(categorizeCommand("/skill")).toBe("skills");
    expect(categorizeCommand("/review")).toBe("skills");
  });
});

describe("isCommandAvailableInGui", () => {
  it("marks fully supported commands as available", () => {
    expect(isCommandAvailableInGui("/mode")).toBe("full");
    expect(isCommandAvailableInGui("/model")).toBe("full");
    expect(isCommandAvailableInGui("/reasoning")).toBe("full");
    expect(isCommandAvailableInGui("/config")).toBe("full");
    expect(isCommandAvailableInGui("/settings")).toBe("full");
    expect(isCommandAvailableInGui("/clear")).toBe("full");
    expect(isCommandAvailableInGui("/compact")).toBe("full");
    expect(isCommandAvailableInGui("/help")).toBe("full");
    expect(isCommandAvailableInGui("/exit")).toBe("full");
    expect(isCommandAvailableInGui("/rename")).toBe("full");
    expect(isCommandAvailableInGui("/save")).toBe("full");
    expect(isCommandAvailableInGui("/export")).toBe("full");
    expect(isCommandAvailableInGui("/context")).toBe("full");
    expect(isCommandAvailableInGui("/status")).toBe("full");
    expect(isCommandAvailableInGui("/links")).toBe("full");
    expect(isCommandAvailableInGui("/feedback")).toBe("full");
  });

  it("marks partially supported commands", () => {
    expect(isCommandAvailableInGui("/undo")).toBe("full");
    expect(isCommandAvailableInGui("/retry")).toBe("full");
    expect(isCommandAvailableInGui("/attach")).toBe("full");
    expect(isCommandAvailableInGui("/sessions")).toBe("full");
    expect(isCommandAvailableInGui("/load")).toBe("full");
    expect(isCommandAvailableInGui("/task")).toBe("full");
    expect(isCommandAvailableInGui("/trust")).toBe("full");
    expect(isCommandAvailableInGui("/logout")).toBe("partial");
    expect(isCommandAvailableInGui("/change")).toBe("partial");
  });

  it("marks unavailable commands", () => {
    expect(isCommandAvailableInGui("/theme")).toBe("unavailable");
    expect(isCommandAvailableInGui("/share")).toBe("unavailable");
    expect(isCommandAvailableInGui("/skills")).toBe("full");
    expect(isCommandAvailableInGui("/skill")).toBe("full");
    expect(isCommandAvailableInGui("/network")).toBe("unavailable");
    expect(isCommandAvailableInGui("/queue")).toBe("unavailable");
    expect(isCommandAvailableInGui("/stash")).toBe("unavailable");
    expect(isCommandAvailableInGui("/hooks")).toBe("unavailable");
    expect(isCommandAvailableInGui("/subagents")).toBe("unavailable");
    expect(isCommandAvailableInGui("/agent")).toBe("unavailable");
    expect(isCommandAvailableInGui("/cycles")).toBe("unavailable");
    expect(isCommandAvailableInGui("/cycle")).toBe("unavailable");
    expect(isCommandAvailableInGui("/recall")).toBe("unavailable");
    expect(isCommandAvailableInGui("/relay")).toBe("unavailable");
    expect(isCommandAvailableInGui("/rlm")).toBe("unavailable");
    expect(isCommandAvailableInGui("/lsp")).toBe("unavailable");
    expect(isCommandAvailableInGui("/statusline")).toBe("unavailable");
    expect(isCommandAvailableInGui("/verbose")).toBe("unavailable");
    expect(isCommandAvailableInGui("/profile")).toBe("unavailable");
    expect(isCommandAvailableInGui("/translate")).toBe("unavailable");
  });

  it("marks now-available commands (previously unavailable)", () => {
    expect(isCommandAvailableInGui("/goal")).toBe("full");
    expect(isCommandAvailableInGui("/anchor")).toBe("full");
    expect(isCommandAvailableInGui("/cache")).toBe("full");
    expect(isCommandAvailableInGui("/system")).toBe("full");
    expect(isCommandAvailableInGui("/edit")).toBe("full");
    expect(isCommandAvailableInGui("/diff")).toBe("full");
    expect(isCommandAvailableInGui("/note")).toBe("full");
    expect(isCommandAvailableInGui("/memory")).toBe("full");
    expect(isCommandAvailableInGui("/restore")).toBe("full");
  });

  it("marks partial commands", () => {
    expect(isCommandAvailableInGui("/jobs")).toBe("full");
  });
});

describe("getCommandHelpText", () => {
  it("returns help text for available commands", () => {
    const help = getCommandHelpText("/mode");
    expect(help).toContain("/mode");
    expect(help).toContain("act");
    expect(help).toContain("plan");
    expect(help).toContain("operate");
    // The legacy alias stays documented, but as a permission shorthand rather
    // than a mode.
    expect(help).toContain("yolo");
  });

  it("returns unavailable message for unsupported commands", () => {
    const help = getCommandHelpText("/theme");
    expect(help).toContain("Not available");
  });

  it("returns full support message for fully supported commands", () => {
    const help = getCommandHelpText("/undo");
    // /undo is now fully supported in GUI: the help text describes the
    // local undo behaviour rather than admitting API limitations.
    expect(help).not.toContain("not supported");
    expect(help).toContain("/undo");
  });

  it("returns unknown command message for unrecognized commands", () => {
    const help = getCommandHelpText("/foobar");
    expect(help).toContain("Unknown command");
  });
});

describe("Unavailable command reasons", () => {
  it("theme: GUI uses VSCode theme, not TUI theme", () => {
    const help = getCommandHelpText("/theme");
    expect(help).toContain("Not available");
  });

  it("share: no sharing service in extension", () => {
    const help = getCommandHelpText("/share");
    expect(help).toContain("Not available");
  });

  it("skills/skill: now available in GUI", () => {
    const help1 = getCommandHelpText("/skills");
    expect(help1).toContain("/skills");
    const help2 = getCommandHelpText("/skill");
    expect(help2).toContain("/skill");
  });

  it("network: network rules managed by VSCode proxy settings", () => {
    const help = getCommandHelpText("/network");
    expect(help).toContain("Not available");
  });

  it("queue/stash: message queue is TUI-specific", () => {
    expect(getCommandHelpText("/queue")).toContain("Not available");
    expect(getCommandHelpText("/stash")).toContain("Not available");
  });

  it("hooks: hooks are TUI-specific", () => {
    expect(getCommandHelpText("/hooks")).toContain("Not available");
  });

  it("subagents/agent: sub-agent management is TUI-specific", () => {
    expect(getCommandHelpText("/subagents")).toContain("Not available");
    expect(getCommandHelpText("/agent")).toContain("Not available");
  });

  it("cycles/cycle: cycle management is TUI-specific", () => {
    expect(getCommandHelpText("/cycles")).toContain("Not available");
    expect(getCommandHelpText("/cycle")).toContain("Not available");
  });

  it("recall: archive recall is TUI-specific", () => {
    expect(getCommandHelpText("/recall")).toContain("Not available");
  });

  it("relay: agent relay is TUI-specific", () => {
    expect(getCommandHelpText("/relay")).toContain("Not available");
  });

  it("rlm: recursive language model is TUI-specific", () => {
    expect(getCommandHelpText("/rlm")).toContain("Not available");
  });

  it("lsp: LSP is managed by VSCode itself", () => {
    expect(getCommandHelpText("/lsp")).toContain("Not available");
  });

  it("restore: snapshot list + trust-gated revert via runtime API", () => {
    const help = getCommandHelpText("/restore");
    expect(help).toContain("/restore");
    expect(help).toContain("trust mode");
  });

  it("statusline: status line is TUI-specific", () => {
    expect(getCommandHelpText("/statusline")).toContain("Not available");
  });
});

describe("Now-available commands (previously unavailable)", () => {
  it("/note: fully available with subcommands", () => {
    const cmd = new SlashCommandRegistry().getCommand("/note")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/note");
  });

  it("/memory: fully available with subcommands", () => {
    const cmd = new SlashCommandRegistry().getCommand("/memory")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/memory");
  });

  it("/goal: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/goal")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/goal");
  });

  it("/anchor: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/anchor")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/anchor");
  });

  it("/system: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/system")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/system");
  });

  it("/edit: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/edit")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/edit");
  });

  it("/diff: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/diff")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/diff");
  });

  it("/cache: fully available", () => {
    const cmd = new SlashCommandRegistry().getCommand("/cache")!;
    expect(cmd.availability).toBe("full");
    expect(cmd.helpText).toContain("/cache");
  });

  it("/profile: unavailable with an explanation", () => {
    const cmd = new SlashCommandRegistry().getCommand("/profile")!;
    expect(cmd.availability).toBe("unavailable");
    expect(cmd.helpText).toContain("Not available");
  });

  it("/translate: unavailable with an explanation", () => {
    const cmd = new SlashCommandRegistry().getCommand("/translate")!;
    expect(cmd.availability).toBe("unavailable");
    expect(cmd.helpText).toContain("Not available");
  });

  it("/verbose: unavailable with an explanation", () => {
    const cmd = new SlashCommandRegistry().getCommand("/verbose")!;
    expect(cmd.availability).toBe("unavailable");
    expect(cmd.helpText).toContain("Not available");
  });
});

describe("Partial support command explanations", () => {
  it("undo: now fully supported, no API limitation text", () => {
    const help = getCommandHelpText("/undo");
    expect(help).toContain("/undo");
    // The old placeholder complained about API limitations; the new
    // implementation actually performs a local undo, so that warning
    // must be gone.
    expect(help).not.toContain("not supported");
    expect(help).not.toContain("/clear");
  });

  it("retry: now fully supported, re-sends last user message", () => {
    const help = getCommandHelpText("/retry");
    expect(help).toContain("/retry");
    // The old placeholder said "not directly supported"; the new
    // implementation actually re-sends the last user message.
    expect(help).not.toContain("not directly supported");
  });

  it("undo availability is now full", () => {
    const cmd = new SlashCommandRegistry().getCommand("/undo")!;
    expect(cmd.availability).toBe("full");
  });

  it("retry availability is now full", () => {
    const cmd = new SlashCommandRegistry().getCommand("/retry")!;
    expect(cmd.availability).toBe("full");
  });

  it("attach: now supports file picker", () => {
    const help = getCommandHelpText("/attach");
    expect(help).toContain("image, video, PDF, or any file");
  });

  it("sessions: fully available with search", () => {
    const help = getCommandHelpText("/sessions");
    expect(help).toContain("/sessions");
    expect(help).toContain("search");
  });

  it("load: fully available for resuming sessions", () => {
    const help = getCommandHelpText("/load");
    expect(help).toContain("/load");
    expect(help).toContain("session");
  });

  it("task: fully available with subcommands", () => {
    const help = getCommandHelpText("/task");
    expect(help).toContain("/task add");
    expect(help).toContain("/task list");
    expect(help).toContain("/task cancel");
  });

  it("jobs: fully available with subcommands", () => {
    const help = getCommandHelpText("/jobs");
    expect(help).toContain("/jobs");
    expect(help).toContain("list");
  });

  it("logout: explains API key change process", () => {
    const help = getCommandHelpText("/logout");
    expect(help).toContain("DEEPSEEK_API_KEY");
  });

  it("change: explains changelog alternative", () => {
    const help = getCommandHelpText("/change");
    expect(help).toContain("CHANGELOG");
  });
});

describe("Command registry completeness", () => {
  const registry = new SlashCommandRegistry();
  const commands = registry.getAllCommands();

  it("every command has a non-empty name starting with /", () => {
    for (const cmd of commands) {
      expect(cmd.name).toMatch(/^\//);
      expect(cmd.name.length).toBeGreaterThan(1);
    }
  });

  it("every command has a non-empty description", () => {
    for (const cmd of commands) {
      expect(cmd.desc.length).toBeGreaterThan(0);
    }
  });

  it("every command has a valid category", () => {
    const validCategories = ["core", "config", "session", "debug", "skills", "unavailable"];
    for (const cmd of commands) {
      expect(validCategories).toContain(cmd.category);
    }
  });

  it("every command has a valid availability", () => {
    const validAvailability = ["full", "partial", "unavailable"];
    for (const cmd of commands) {
      expect(validAvailability).toContain(cmd.availability);
    }
  });

  it("every command has non-empty helpText", () => {
    for (const cmd of commands) {
      expect(cmd.helpText.length).toBeGreaterThan(0);
    }
  });

  it("unavailable category matches unavailable availability", () => {
    for (const cmd of commands) {
      if (cmd.category === "unavailable") {
        expect(cmd.availability).toBe("unavailable");
      }
    }
  });

  it("no duplicate command names", () => {
    const names = commands.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it("all unavailable commands explain why in helpText", () => {
    for (const cmd of commands) {
      if (cmd.availability === "unavailable") {
        expect(cmd.helpText.toLowerCase()).toContain("not available");
      }
    }
  });

  it("all partial commands explain limitation in helpText", () => {
    for (const cmd of commands) {
      if (cmd.availability === "partial") {
        const lower = cmd.helpText.toLowerCase();
        const hasExplanation =
          lower.includes("not directly") ||
          lower.includes("not yet") ||
          lower.includes("not supported") ||
          lower.includes("limited") ||
          lower.includes("sidebar") ||
          lower.includes("environment variable") ||
          lower.includes("changelog") ||
          lower.includes("tui runtime");
        expect(hasExplanation, `Partial command ${cmd.name} should explain its limitation`).toBe(true);
      }
    }
  });
});
