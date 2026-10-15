import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace-trust banner's host half.
 *
 * The contract this file exists to protect: the GUI never edits the engine's
 * `config.toml`. It cannot — that file is the user's, and the gate that reads
 * it lives in the engine — so a click travels as one API call and nothing else.
 * A future refactor that "helps" by writing the setting locally would make two
 * sources of truth for a security decision, and these tests are what catch it.
 */

const vscodeState = vi.hoisted(() => ({
  updateMock: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  executeCommand: vi.fn(async () => undefined),
  writeText: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vscodeState.updateMock,
    })),
  },
  window: {
    showInformationMessage: vscodeState.showInformationMessage,
    showWarningMessage: vscodeState.showWarningMessage,
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
  },
  commands: { executeCommand: vscodeState.executeCommand },
  env: { language: "en", clipboard: { writeText: vscodeState.writeText } },
  ConfigurationTarget: { Global: "global" },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
}));

import { ChatProvider } from "../../chat-provider";

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    bindEngine: vi.fn(),
    getWorkspaceStatus: vi.fn(async () => ({
      workspace: "/tmp/repo",
      git_repo: true,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      workspace_trusted: false,
    })),
    setWorkspaceTrust: vi.fn(async () => ({
      workspace: "/tmp/repo",
      workspace_trusted: true,
      config_path: "/home/u/.codewhale/config.toml",
      message: "Workspace trust saved",
    })),
    listSkills: vi.fn(async () => ({
      skills: [],
      directory: "/home/u/.codewhale/skills",
      directories: [],
      warnings: [],
    })),
    ...overrides,
  };
}

function makeProvider(api: ReturnType<typeof makeApi>) {
  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();
  return provider;
}

function messagesOf(provider: ChatProvider): Array<Record<string, any>> {
  return (provider.postMessage as any).mock.calls.map((call: any[]) => call[0]);
}

describe("ChatProvider workspace trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the engine's verdict instead of going looking for one", async () => {
    const api = makeApi();
    const provider = makeProvider(api);

    await provider.refreshWorkspaceTrust();

    // The engine answered; the panel asked and echoed.
    expect(api.getWorkspaceStatus).toHaveBeenCalledTimes(1);
    expect(messagesOf(provider)).toContainEqual({
      type: "workspaceTrust",
      supported: true,
      trusted: false,
      workspace: "/tmp/repo",
    });
  });

  it("stays silent on an engine that cannot report or record the verdict", async () => {
    // `workspace_trusted` absent is an older engine. A banner there would offer
    // a button whose route does not exist, so the panel says nothing.
    const api = makeApi({
      getWorkspaceStatus: vi.fn(async () => ({
        workspace: "/tmp/repo",
        git_repo: true,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      })),
    });
    const provider = makeProvider(api);

    await provider.refreshWorkspaceTrust();

    expect(messagesOf(provider)).toContainEqual({
      type: "workspaceTrust",
      supported: false,
      trusted: false,
      workspace: "/tmp/repo",
    });
  });

  it("trusts through the engine's route and touches no local setting", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    // The panel reads the verdict at init; the banner click it enables only
    // ever follows that read.
    await provider.refreshWorkspaceTrust();

    await (provider as any).handleWebviewMessage({ type: "trustWorkspace" });

    expect(api.setWorkspaceTrust).toHaveBeenCalledWith(true);
    // The whole point: one API call, and not a line written to any local
    // configuration the engine would then have to be kept in sync with.
    expect(vscodeState.updateMock).not.toHaveBeenCalled();
    expect(messagesOf(provider)).toContainEqual({
      type: "workspaceTrust",
      supported: true,
      trusted: true,
      workspace: "/tmp/repo",
    });
    // The panel's skill list was built while the workspace was untrusted, so
    // the project rows are missing from it until this runs.
    expect(api.listSkills).toHaveBeenCalled();
  });

  it("does not claim success when the engine read back no record", async () => {
    // The engine writes through the gate and reads the verdict back through it,
    // so a `true` request answered with `false` means the record did not land
    // where the gate looks. The banner stays and the user is told, rather than
    // being congratulated on a decision nothing is honouring.
    const api = makeApi({
      setWorkspaceTrust: vi.fn(async () => ({
        workspace: "/tmp/repo",
        workspace_trusted: false,
        config_path: "/home/u/.codewhale/config.toml",
        message: "Workspace trust is not recorded in user config; project-scoped content is skipped.",
      })),
    });
    const provider = makeProvider(api);
    await provider.refreshWorkspaceTrust();

    await (provider as any).handleWebviewMessage({ type: "trustWorkspace" });

    const messages = messagesOf(provider);
    expect(messages.find((m) => m.type === "error")?.message).toContain(
      "not recorded in user config",
    );
    expect(messages.filter((m) => m.type === "workspaceTrust")).toContainEqual({
      type: "workspaceTrust",
      supported: true,
      trusted: false,
      workspace: "/tmp/repo",
    });
    // The success path's follow-up never runs.
    expect(api.listSkills).not.toHaveBeenCalled();
  });

  it("puts the button back when the engine refuses the write", async () => {
    const api = makeApi({
      setWorkspaceTrust: vi.fn(async () => {
        throw new Error("API error 500: could not write config");
      }),
    });
    const provider = makeProvider(api);
    await provider.refreshWorkspaceTrust();

    await (provider as any).handleWebviewMessage({ type: "trustWorkspace" });

    const messages = messagesOf(provider);
    const failure = messages.find((m) => m.type === "error");
    expect(failure?.message).toContain("could not write config");
    // Re-announced so the webview re-enables the button it disabled on click;
    // otherwise a refusal leaves the user staring at a dead control.
    expect(messages.filter((m) => m.type === "workspaceTrust")).toContainEqual({
      type: "workspaceTrust",
      supported: true,
      trusted: false,
      workspace: "/tmp/repo",
    });
  });

  it("hands over the TUI command when the user prefers the terminal", async () => {
    const api = makeApi();
    const provider = makeProvider(api);
    (provider as any).tuiWorkspace = "/tmp/repo";

    await (provider as any).handleWebviewMessage({ type: "showWorkspaceTrustHelp" });

    const [text, action] = vscodeState.showInformationMessage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(text).toContain('codewhale --workspace "/tmp/repo"');
    expect(text).toContain("/trust on --save");
    expect(action).toBe("Copy command");
  });
});
