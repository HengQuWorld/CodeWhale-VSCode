// The `vscode` module the chat-provider suites run against.
//
// `vi.mock` factories are hoisted above imports and so cannot live in a shared
// module: each suite carried its own copy of the double — 18 near variants of
// the same 17–33 lines, differing only in which members that suite needed.
// Instead, `vscode` resolves here through the alias in `vitest.config.ts`, and
// no suite mocks it at all.
//
// The members are named exports rather than a default object because the
// imported side is `import * as vscode from "vscode"` — that binds the module
// namespace, so `vscode.workspace` has to be a top-level export.
//
// This is the union of what the suites need. A suite that needs a member only
// because another suite does gets a harmless default; a suite that relied on a
// *different* default (an answer to a dialog, a file's bytes, a workspace) sets
// it on `vscodeState` in its own setup, where it is visible beside the tests it
// affects.
import { vi } from "vitest";

/** The mutable half: what the doubles report, and what suites read back. */
export const vscodeState = {
  /** Values `workspace.getConfiguration().get()` answers with, by key. */
  configValues: new Map<string, unknown>(),
  /** What `workspace.workspaceFolders` reports.
   *
   * `undefined` by default on purpose: a window with no folder open must make
   * the thread path skip its workspace-update branch, and a suite that is about
   * something else should not be exercising that branch by accident. */
  workspaceFolders: undefined as unknown,
  /** What a document opened through `workspace.openTextDocument` contains. */
  diskFileText: "",

  configGet: vi.fn((key: string, fallback?: unknown) =>
    vscodeState.configValues.has(key) ? vscodeState.configValues.get(key) : fallback),
  // Writes through, the way the real `update` does: a suite that changes a
  // setting and then reads it back (a provider switch re-reads the per-provider
  // model map) sees what it wrote.
  updateMock: vi.fn(async (key: string, value: unknown) => {
    vscodeState.configValues.set(key, value);
  }),
  executeCommand: vi.fn(),
  openTextDocument: vi.fn(async (input?: unknown) => ({
    input,
    getText: () => vscodeState.diskFileText,
  })),
  showTextDocument: vi.fn(async () => undefined),
  // Prompts answer with the button the user picked (or nothing), so a suite can
  // hand one back with `mockResolvedValue`.
  showInformationMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showWarningMessage: vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined),
  showErrorMessage: vi.fn(),
  setStatusBarMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  writeText: vi.fn(),
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vscodeState.configGet,
    update: vscodeState.updateMock,
  })),
  // An accessor pair, not a field: a suite may assign it (a rebuild clears it
  // back to `undefined`) and the provider must read what was assigned. A
  // data property would be captured by the value read at call time only.
  get workspaceFolders(): unknown {
    return vscodeState.workspaceFolders;
  },
  set workspaceFolders(value: unknown) {
    vscodeState.workspaceFolders = value;
  },
  openTextDocument: vscodeState.openTextDocument,
  registerTextDocumentContentProvider: vscodeState.registerTextDocumentContentProvider,
};

export const commands = {
  executeCommand: vscodeState.executeCommand,
};

export const window = {
  showInformationMessage: vscodeState.showInformationMessage,
  showWarningMessage: vscodeState.showWarningMessage,
  showErrorMessage: vscodeState.showErrorMessage,
  setStatusBarMessage: vscodeState.setStatusBarMessage,
  showTextDocument: vscodeState.showTextDocument,
  showOpenDialog: vscodeState.showOpenDialog,
};

export const env = {
  language: "en",
  clipboard: { writeText: vscodeState.writeText },
};

export const Uri = {
  file: (fsPath: string) => ({ fsPath }),
  parse: (value: string) => ({
    toString: () => value,
    fsPath: value.replace(/^file:\/\//, ""),
  }),
};

export const ConfigurationTarget = {
  Global: "global",
};
