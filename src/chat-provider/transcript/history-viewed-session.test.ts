import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// What a diff view reads off disk when it reconstructs a change's before/after.
const diskState = vi.hoisted(() => ({ fileText: "" }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: vi.fn(async () => undefined),
    })),
    workspaceFolders: undefined,
    openTextDocument: vi.fn(async () => ({ getText: () => diskState.fileText })),
    registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  window: {
    showTextDocument: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
  },
  env: {
    language: "en",
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    parse: (value: string) => ({ toString: () => value }),
  },
  ConfigurationTarget: {
    Global: "global",
  },
}));

import { ChatProvider } from "../../chat-provider";
import { t } from "../../i18n";

function createProvider(detail: Record<string, unknown>) {
  const api = {
    bindEngine: vi.fn(),
    getThreadDetail: vi.fn(async () => detail),
    getSession: vi.fn(async () => detail),
    // The model menu asks the runtime for the route's catalog; a test that
    // exercises the chip's model needs the answer to come from a route.
    listProviderModels: vi.fn(async () => ({
      provider: "custom",
      models: [{ id: "glm-5.3" }, { id: "glm-5.4" }],
    })),
    decideApproval: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
  };

  const provider = new ChatProvider({} as any, {} as any, api as any);
  provider.postMessage = vi.fn();

  return { provider, api, postMessage: provider.postMessage as any };
}

describe("a viewed session's Diff action", () => {
  /** A saved session whose one turn edited `src/app.ts` through `edit`, with the
   *  file's post-edit bytes on disk — the shape a replayed session has. */
  function editedSession(workspace: string) {
    return {
      metadata: { id: "sess-edit", title: "edit replay", total_tokens: 10, workspace },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "edit",
              input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              content: "Successfully replaced 1 block(s) in src/app.ts.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };
  }

  /** The workspace, its file on disk, and the provider that viewed the session. */
  async function viewed(workspace: string) {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "app.ts"), "one\nTWO\nthree\n");
    diskState.fileText = "one\nTWO\nthree\n";
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: workspace } },
    ];
    const { provider, postMessage } = createProvider(editedSession(workspace));
    await provider.loadSessionMessages("sess-edit");
    return { provider, postMessage };
  }

  it("opens a diff from the change's own record when the click arrives without one", async () => {
    // The webview keys its Diff action into a store that the conversation
    // rebuild empties, so a click can reach the host with the diff missing even
    // though this extension still holds the change it published. Opening the
    // file in that case is what made Diff behave as Open.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-viewed-diff-"));
    try {
      const { provider } = await viewed(dir);
      vi.mocked(vscode.commands.executeCommand).mockClear();

      await (provider as any).handleOpenDiff("src/app.ts", undefined, 0);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.diff",
        expect.anything(),
        expect.anything(),
        expect.stringContaining("app.ts"),
      );
      expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says there is nothing to compare rather than opening the file", async () => {
    // The record is gone by the time the click lands — an undo, a revert, a
    // session whose edit chain no longer lines up. A Diff action that quietly
    // becomes Open is the failure this whole path is about, so it reports.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-viewed-diff-"));
    try {
      const { provider, postMessage } = await viewed(dir);
      (provider as any).turnFileChanges = [];
      vi.mocked(vscode.commands.executeCommand).mockClear();
      vi.mocked(vscode.workspace.openTextDocument).mockClear();

      await (provider as any).handleOpenDiff("src/app.ts", undefined, 0);

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "info",
          message: t().diffUnavailable,
        }),
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a viewed session's change counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the same +/- for an edit as the engine's own diff does", async () => {
    // A model anchors its edit by quoting untouched lines around the change.
    // The panel used to count every quoted line as both removed and added, so
    // the same edit read as +3 -3 in a session opened from the rail and +1 -1
    // in the thread it came from — one change, two numbers, depending on how
    // the view was opened. The counts are the lines that actually differ now.
    const session = {
      metadata: { id: "sess-count", title: "one-line edit", total_tokens: 10 },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-count-1",
              name: "edit",
              input: {
                path: "src/app.ts",
                edits: [{ oldText: "two\nthree\nfour", newText: "two\nTHREE\nfour" }],
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-count-1",
              content: "Successfully replaced 1 block(s) in src/app.ts.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };

    const { provider, postMessage } = createProvider(session);
    await provider.loadSessionMessages("sess-count");

    const payload = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .filter((message: Record<string, any>) => message.type === "changesState")
      .pop();
    expect(payload).toBeDefined();
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0]).toMatchObject({
      filePath: "src/app.ts",
      addedLines: 1,
      removedLines: 1,
    });
  });
});

describe("a viewed session whose file moved on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A session that edited one file three times, oldest first. */
  function threeEdits(workspace: string) {
    const edit = (id: string, oldText: string, newText: string) => [
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use", id, name: "edit", input: { path: "src/app.ts", edits: [{ oldText, newText }] } },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: "Successfully replaced 1 block(s) in src/app.ts.",
          },
        ],
      },
    ];
    return {
      metadata: { id: "sess-drift", title: "three edits", total_tokens: 10, workspace },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit a" }] },
        ...edit("call-1", "B", "B1\nB2"),
        { role: "user", content: [{ type: "text", text: "edit c" }] },
        ...edit("call-2", "C", "C2"),
        { role: "user", content: [{ type: "text", text: "edit a again" }] },
        ...edit("call-3", "A", "A2"),
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };
  }

  function changesRecords(provider: ChatProvider) {
    return ((provider as any).turnFileChanges as Array<{
      filePath: string;
      diff?: string;
      addedLines: number;
      removedLines: number;
      changeIndex?: number;
    }>);
  }

  it("keeps the diffs that verified when an older edit's text no longer matches", async () => {
    // The recorded edits have to be walked back from the file as it is now. A
    // later tweak can strand the oldest edit — its recorded text is no longer
    // there to place — and that used to discard every diff for the file,
    // including the two that verified exactly. What verified describes the file
    // the reader is looking at, so it stays.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-drift-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // All three edits applied, then `B1` drifted to `B1x` — a later command's
      // own edit, which the replay knows nothing about.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "A2\nB1x\nB2\nC2\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const { provider } = createProvider(threeEdits(dir));
      await provider.loadSessionMessages("sess-drift");

      const records = changesRecords(provider);
      expect(records).toHaveLength(3);
      // The two newest calls verified and keep their patches — numbered for the
      // viewer, which walks the file's diffs back from what is on disk.
      expect(records[1].diff).toBeTruthy();
      expect(records[2].diff).toBeTruthy();
      expect(records[1].changeIndex).toBe(0);
      expect(records[2].changeIndex).toBe(1);
      // The stranded one reports its size and admits it has no patch.
      expect(records[0].diff).toBeUndefined();
      expect(records[0].addedLines).toBe(2);
      expect(records[0].removedLines).toBe(1);
      expect(records[0].changeIndex).toBeUndefined();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives every edit its diff when the file still lines up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-intact-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "A2\nB1\nB2\nC2\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const { provider } = createProvider(threeEdits(dir));
      await provider.loadSessionMessages("sess-drift");

      const records = changesRecords(provider);
      expect(records).toHaveLength(3);
      for (const record of records) expect(record.diff).toBeTruthy();
      expect(records.map((record) => record.changeIndex)).toEqual([0, 1, 2]);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a viewed session the engine still holds as a thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One edit call, and the session's document has no diff for it. */
  function editSession(workspace: string) {
    return {
      metadata: { id: "thr-fill", title: "engine receipts", total_tokens: 10, workspace },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-edit-1",
              name: "edit",
              input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-edit-1",
              content: "Successfully replaced 1 block(s) in src/app.ts.",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };
  }

  /** The engine's own receipt for that call, as thread detail carries it. */
  function engineThreadWithReceipt() {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n");
    return {
      latest_seq: 3,
      thread: { id: "thr-fill" },
      turns: [{ id: "turn-1", input_summary: "edit", status: "completed", item_ids: ["i1"] }],
      items: [
        {
          id: "i1",
          kind: "tool_call",
          summary: "edit: Successfully replaced 1 block(s)",
          detail: "Successfully replaced 1 block(s) in src/app.ts.",
          status: "completed",
          metadata: {
            tool_use_id: "call-edit-1",
            tool_name: "edit",
            tool_input: JSON.stringify({ path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] }),
            event: "file.mutation",
            mutation: {
              diff,
              files: [{ path: "src/app.ts", outcome: "modified" }],
              renames: [],
            },
          },
        },
      ],
    };
  }

  function records(provider: ChatProvider) {
    return (provider as any).turnFileChanges as Array<Record<string, any>>;
  }

  it("takes the engine's diff for a call whose own text the file no longer holds", async () => {
    // The recorded edit cannot be placed — the file moved on since — so the
    // reconstruction has nothing. The engine's receipt for that same call is
    // what the thread view draws, and it is available for a session the engine
    // still holds.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-engine-fill-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // The replacement the call recorded is not in the file, so no walk back
      // from it can succeed.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO!edited\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const api = {
        bindEngine: vi.fn(),
        getSession: vi.fn(async () => editSession(dir)),
        getThreadDetail: vi.fn(async () => engineThreadWithReceipt()),
        listSnapshots: vi.fn(async () => []),
      };
      const provider = new ChatProvider({} as any, {} as any, api as any);
      provider.postMessage = vi.fn();

      await provider.loadSessionMessages("thr-fill");

      const filled = records(provider);
      expect(filled).toHaveLength(1);
      expect(filled[0].diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      // Counts come with the patch, from the same source the thread view reads.
      expect(filled[0].addedLines).toBe(1);
      expect(filled[0].removedLines).toBe(1);
      // And the patch is numbered, so the row's Diff action can open it.
      expect(filled[0].changeIndex).toBe(0);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the engine's receipt to a reconstruction that would also verify", async () => {
    // Both sources can answer here: the file still lines up, so a patch could
    // be derived from the recorded input, and the engine also holds the call's
    // own receipt. The runtime's answer wins — it is what the thread view
    // draws, and a derived patch that happens to verify is still a derivation.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-engine-first-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const engineDetail = engineThreadWithReceipt();
      // The receipt names two added lines where the derived patch would say
      // one, so the counts tell which source the row ended up reading.
      engineDetail.items[0].metadata.mutation.diff = [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        "+TWO again",
        " three",
      ].join("\n");

      const api = {
        bindEngine: vi.fn(),
        getSession: vi.fn(async () => editSession(dir)),
        getThreadDetail: vi.fn(async () => engineDetail),
        listSnapshots: vi.fn(async () => []),
      };
      const provider = new ChatProvider({} as any, {} as any, api as any);
      provider.postMessage = vi.fn();

      await provider.loadSessionMessages("thr-fill");

      const filled = records(provider);
      expect(filled).toHaveLength(1);
      expect(filled[0].diff).toContain("+TWO again");
      expect(filled[0].addedLines).toBe(2);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pairs the receipt with its row even when the two documents spell the path differently", async () => {
    // A file tool records the path the model asked for; the engine records the
    // one it resolved. Pairing on the recorded text alone would miss every call
    // whose two documents disagree about the spelling.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-engine-spelling-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO!edited\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = editSession(dir);
      // The transcript kept a relative path; the engine's receipt names the file
      // it resolved that to.
      (session.messages[1].content[0] as { input: Record<string, unknown> }).input = {
        path: "src/app.ts",
        edits: [{ oldText: "two", newText: "TWO" }],
      };
      const engineDetail = engineThreadWithReceipt();
      engineDetail.items[0].metadata.mutation.files = [
        { path: `${dir}/src/app.ts`, outcome: "modified" },
      ];

      const api = {
        bindEngine: vi.fn(),
        getSession: vi.fn(async () => session),
        getThreadDetail: vi.fn(async () => engineDetail),
        listSnapshots: vi.fn(async () => []),
      };
      const provider = new ChatProvider({} as any, {} as any, api as any);
      provider.postMessage = vi.fn();

      await provider.loadSessionMessages("thr-fill");

      const filled = records(provider);
      expect(filled).toHaveLength(1);
      expect(filled[0].diff).toContain("+TWO");
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to reconstruction when the engine does not know the session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-engine-404-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const api = {
        bindEngine: vi.fn(),
        getSession: vi.fn(async () => editSession(dir)),
        // A TUI session, another workspace's conversation, a pruned thread: the
        // route answers nothing, and the document is all there is.
        getThreadDetail: vi.fn(async () => {
          throw new Error("404 Not Found");
        }),
        listSnapshots: vi.fn(async () => []),
      };
      const provider = new ChatProvider({} as any, {} as any, api as any);
      provider.postMessage = vi.fn();

      await provider.loadSessionMessages("thr-fill");

      const filled = records(provider);
      expect(filled).toHaveLength(1);
      expect(filled[0].diff).toContain("+TWO");
      expect(filled[0].changeIndex).toBe(0);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
