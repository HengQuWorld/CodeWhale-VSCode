import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../../chat-provider";

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

describe("ChatProvider changes panel turn attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the turn that ran a shell command, and keeps it in the panel payload", async () => {
    // A shell command's file writes are recorded by the engine as a command
    // execution, not as a file change: the panel cannot list them, so it has to
    // say so — and it has to keep the turn in its payload, because the note is
    // the only thing there is to show for a turn like this.
    const detail = {
      latest_seq: 9,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "wrote files with a script",
          created_at: "2026-08-20T10:00:00Z",
          ended_at: "2026-08-20T10:00:10Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
        {
          id: "turn-2",
          input_summary: "edited a file with the tools",
          created_at: "2026-08-20T10:01:00Z",
          ended_at: "2026-08-20T10:01:10Z",
          status: "completed",
          item_ids: ["u2", "t2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "wrote files with a script", detail: "wrote files with a script", status: "completed" },
        // The extension's engine calls its shell tool `bash`; the engine's own
        // TUI tool arrives as `command_execution`.
        { id: "t1", kind: "tool_call", summary: "bash: python3 - <<PY", detail: "wrote 3 files", status: "completed", metadata: {} },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
        { id: "u2", kind: "user_message", summary: "edited a file with the tools", detail: "edited a file with the tools", status: "completed" },
        {
          id: "t2",
          kind: "file_change",
          summary: "edit: Successfully replaced 1 block(s) in src/app.ts",
          detail: "Successfully replaced 1 block(s) in src/app.ts",
          status: "completed",
          metadata: { tool_name: "edit", file_path: "src/app.ts" },
        },
        { id: "a2", kind: "agent_message", summary: "Done", detail: "Done", status: "completed" },
      ],
    };

    const { provider, postMessage } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const changesState = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .filter((message: Record<string, any>) => message.type === "changesState")
      .pop();
    expect(changesState).toBeDefined();
    const shellTurn = changesState.turns.find((turn: Record<string, any>) => turn.index === 1);
    expect(shellTurn?.shellCommands).toBe(1);
    // A turn that changed a file through the tools is listed for its changes,
    // and carries no shell note.
    const toolTurn = changesState.turns.find((turn: Record<string, any>) => turn.index === 2);
    expect(toolTurn?.shellCommands).toBeUndefined();
  });

  it("marks a viewed session's shell turn, not only a live thread's", async () => {
    // A session opened from the Sessions rail rebuilds its own transcript
    // (`loadSessionMessages`) — a third path into the panel besides the live
    // stream and a thread load. Its turns are grouped the same way, so a turn
    // whose edits all came from a script has to carry the same note there.
    const session = {
      metadata: { id: "sess-shell", title: "scripted edits", workspace: "/workspace" },
      messages: [
        { role: "user", content: [{ type: "text", text: "wrote files with a script" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-shell-1",
              name: "exec_shell",
              input: { command: "python3 - <<PY" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-shell-1", content: "wrote 3 files" }],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    };

    const { provider, postMessage } = createProvider(session);

    await provider.loadSessionMessages("sess-shell");

    const changesState = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .filter((message: Record<string, any>) => message.type === "changesState")
      .pop();
    expect(changesState).toBeDefined();
    // Nothing to list, and still worth a group: the note is the whole report.
    expect(changesState.changes).toHaveLength(0);
    const shellTurn = changesState.turns.find((turn: Record<string, any>) => turn.index === 1);
    expect(shellTurn?.shellCommands).toBe(1);
  });

  it("counts a command against its own turn, not the group being filled", async () => {
    // A send the runtime refuses opens a group of its own before the refusal is
    // known, so the group being filled is not always the turn a command came
    // from: counting by that group would charge the running turn's command to a
    // section about to be taken back, and lose it with the section.
    const { provider } = createProvider({});
    (provider as any).beginChangeTurn("the running turn", 1, "turn-a");
    (provider as any).beginChangeTurn("a send the runtime refused");

    (provider as any).noteShellCommandInChangeTurn("turn-a");

    const turns = (provider as any).changeTurns as Array<{
      index: number;
      shellCommands?: number;
    }>;
    expect(turns[0].shellCommands).toBe(1);
    expect(turns[1].shellCommands).toBeUndefined();

    // A turn whose id this client never recorded still counts against the group
    // being filled: the first events of an accepted turn arrive before its id
    // does.
    (provider as any).noteShellCommandInChangeTurn("turn-never-seen");
    expect(turns[1].shellCommands).toBe(1);
    expect(turns[0].shellCommands).toBe(1);
  });

});

describe("ChatProvider Changes panel spans the session's turns", () => {
  /** Every message the provider pushed to the webview, in order. */
  function postedMessages(postMessage: any): Record<string, any>[] {
    return postMessage.mock.calls.map((call: unknown[]) => call[0] as Record<string, any>);
  }

  /** The last Changes payload the provider published. */
  function lastChangesPayload(postMessage: any): Record<string, any> {
    const payloads = postedMessages(postMessage).filter((m) => m.type === "changesState");
    expect(payloads.length).toBeGreaterThan(0);
    return payloads[payloads.length - 1];
  }

  /** A provider whose Work panel is the real one.
   *
   *  `createProvider` stubs `refreshWorkPanel`, which is also what publishes the
   *  Changes panel — a stub there would make every assertion below vacuous. */
  function createProviderWithLiveWorkPanel(detail: Record<string, unknown>) {
    const api = {
      bindEngine: vi.fn(),
      getThreadDetail: vi.fn(async () => detail),
      getSession: vi.fn(async () => detail),
      listSnapshots: vi.fn(async () => []),
    };
    const provider = new ChatProvider({} as any, {} as any, api as any);
    provider.postMessage = vi.fn();
    return { provider, api, postMessage: provider.postMessage as any };
  }

  /** One mutation tool call in the shape the current TUI write tools persist. */
  function mutationCall(itemId: string, toolUseId: string, path: string) {
    return {
      id: itemId,
      kind: "tool_call",
      summary: `write: Successfully wrote 2 bytes to ${path}`,
      detail: `Successfully wrote 2 bytes to ${path}`,
      status: "completed",
      metadata: {
        tool_use_id: toolUseId,
        tool_name: "write",
        event: "file.mutation",
        mutation: {
          diff: [
            `diff --git a/${path} b/${path}`,
            "--- /dev/null",
            `+++ b/${path}`,
            "@@ -0,0 +1 @@",
            "+hello",
          ].join("\n"),
          files: [{ path, outcome: "created" }],
          renames: [],
        },
      },
    };
  }

  /** Two turns, each creating one file — the case the panel used to lose. */
  function twoTurnDetail() {
    return {
      latest_seq: 9,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "create the first file",
          created_at: "2026-09-18T10:00:00Z",
          ended_at: "2026-09-18T10:00:02Z",
          status: "completed",
          item_ids: ["u1", "t1", "a1"],
        },
        {
          id: "turn-2",
          input_summary: "now the second one",
          created_at: "2026-09-18T10:05:00Z",
          ended_at: "2026-09-18T10:05:02Z",
          status: "completed",
          item_ids: ["u2", "t2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "create the first file", detail: "create the first file", status: "completed" },
        mutationCall("t1", "tool-1", "src/first.ts"),
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
        { id: "u2", kind: "user_message", summary: "now the second one", detail: "now the second one", status: "completed" },
        mutationCall("t2", "tool-2", "src/second.ts"),
        { id: "a2", kind: "agent_message", summary: "Done again", detail: "Done again", status: "completed", metadata: null },
      ],
    };
  }

  it("lists every turn's changes, each under the turn that produced it", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());

    await (provider as any).loadHistory("thread-1");

    const payload = lastChangesPayload(postMessage);
    expect(payload.changes.map((c: any) => c.filePath)).toEqual(["src/first.ts", "src/second.ts"]);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2]);
    // The groups identify the turns by their own words, so a reader can tell
    // which turn a section belongs to without reading the transcript.
    expect(payload.turns.map((t: any) => t.index)).toEqual([1, 2]);
    expect(payload.turns[0].label).toBe("create the first file");
    expect(payload.turns[1].label).toBe("now the second one");
  });

  it("numbers each user bubble the way the panel numbers its turns", async () => {
    // The rail names a turn in a dot's tooltip and the panel names one in a
    // section header, and a reader carries one number over to the other. So
    // both have to come from the same counter: counting user bubbles instead
    // would drift, because a steer is a second bubble inside its turn (the
    // first turn below has one) while the panel opens a group per turn.
    const detail = {
      latest_seq: 40,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-A",
          input_summary: "create the first file",
          created_at: "2026-09-18T10:00:00Z",
          ended_at: "2026-09-18T10:00:02Z",
          status: "completed",
          item_ids: ["u1", "t1", "u2", "a1"],
        },
        {
          id: "turn-B",
          input_summary: "now the second one",
          created_at: "2026-09-18T10:05:00Z",
          ended_at: "2026-09-18T10:05:02Z",
          status: "completed",
          item_ids: ["u3", "t2", "a2"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "create the first file", detail: "create the first file", status: "completed" },
        mutationCall("t1", "tool-1", "src/first.ts"),
        { id: "u2", kind: "user_message", summary: "focus on the header", detail: "focus on the header", status: "completed" },
        { id: "a1", kind: "agent_message", summary: "Done", detail: "Done", status: "completed", metadata: null },
        { id: "u3", kind: "user_message", summary: "now the second one", detail: "now the second one", status: "completed" },
        mutationCall("t2", "tool-2", "src/second.ts"),
        { id: "a2", kind: "agent_message", summary: "Done again", detail: "Done again", status: "completed", metadata: null },
      ],
    };

    const { provider, postMessage } = createProviderWithLiveWorkPanel(detail);

    await (provider as any).loadHistory("thread-1");

    const userBubbles = provider.messages.filter((m) => m.role === "user");
    expect(userBubbles.map((m) => m.id)).toEqual(["user-turn-A", "user-steer-u2", "user-turn-B"]);
    // The steer wears the number of the turn it was sent into, not the next
    // turn's — the rail has a dot for it, the panel has no section for it.
    expect(userBubbles.map((m) => m.turnIndex)).toEqual([1, 1, 2]);

    // The panel's own numbering, from the payload the sidebar renders.
    const payload = lastChangesPayload(postMessage);
    expect(payload.turns.map((t: any) => t.index)).toEqual([1, 2]);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2]);
  });

  it("opens a new group for the next turn instead of restarting the panel", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());
    await (provider as any).loadHistory("thread-1");

    // A new turn begins (what sendMessage does before it asks for a turn).
    (provider as any).beginChangeTurn("and a third", Date.now());
    (provider as any).appendFileChange({
      filePath: "src/third.ts",
      changeType: "created",
      addedLines: 1,
      removedLines: 0,
      diff: "diff --git a/src/third.ts b/src/third.ts",
    });
    // What the live path does after each detected change.
    (provider as any).refreshWorkPanel();

    const payload = lastChangesPayload(postMessage);
    expect(payload.changes).toHaveLength(3);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2, 3]);
    expect(payload.turns.map((t: any) => t.label)).toEqual([
      "create the first file",
      "now the second one",
      "and a third",
    ]);
  });

  it("rebuilds the groups rather than appending to them when the thread reloads", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());

    await (provider as any).loadHistory("thread-1");
    await (provider as any).loadHistory("thread-1");

    // Two changes, not four: a reload replaces the list, it does not extend it.
    const payload = lastChangesPayload(postMessage);
    expect(payload.changes).toHaveLength(2);
    expect(payload.turns.map((t: any) => t.index)).toEqual([1, 2]);
  });

  it("drops the group a refused send opened", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());
    await (provider as any).loadHistory("thread-1");

    // sendMessage opens the group before the runtime can refuse the turn; the
    // refused prompt must not stand as a section header over the running turn.
    (provider as any).beginChangeTurn("text the user had to retract");
    (provider as any).retractRefusedChangeTurn();
    (provider as any).refreshChangesPanel();

    const payload = lastChangesPayload(postMessage);
    expect(payload.turns.map((t: any) => t.label)).toEqual([
      "create the first file",
      "now the second one",
    ]);
  });

  it("keeps a refused send's group when the running turn already filled it", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());
    await (provider as any).loadHistory("thread-1");

    (provider as any).beginChangeTurn("text the user had to retract");
    (provider as any).appendFileChange({
      filePath: "src/running.ts",
      changeType: "modified",
      addedLines: 1,
      removedLines: 1,
      diff: "diff --git a/src/running.ts b/src/running.ts",
    });
    (provider as any).retractRefusedChangeTurn();
    (provider as any).refreshChangesPanel();

    const payload = lastChangesPayload(postMessage);
    // The turn keeps its place in the order; only the misleading label goes.
    expect(payload.turns.map((t: any) => t.index)).toEqual([1, 2, 3]);
    expect(payload.turns[2].label).toBe("");
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2, 3]);
  });

  it("keeps one group for a turn that was still running when the thread was reopened", async () => {
    // Reopening a thread mid-turn rebuilds the running turn's group from
    // history, then resumes observing it. The live stream must land in that
    // group: a second section for the same turn would show one turn twice.
    const detail = twoTurnDetail();
    detail.turns[1].status = "in_progress";
    const { provider, postMessage } = createProviderWithLiveWorkPanel(detail);

    await (provider as any).loadHistory("thread-1");
    // What the thread-load path does for a turn the runtime kept running.
    (provider as any).currentTurnId = "turn-2";
    (provider as any).ensureAssistantPlaceholderForExternalTurn("turn-2");
    (provider as any).appendFileChange({
      filePath: "src/healed.ts",
      changeType: "modified",
      addedLines: 2,
      removedLines: 0,
      diff: "diff --git a/src/healed.ts b/src/healed.ts",
    });
    (provider as any).refreshChangesPanel();

    const payload = lastChangesPayload(postMessage);
    expect(payload.turns.map((t: any) => t.index)).toEqual([1, 2]);
    // The change the resumed turn made after the reload sits in turn 2, beside
    // the one history restored for it.
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2, 2]);
  });

  it("groups a viewed session's changes by the turn that made them", async () => {
    // A saved session is rebuilt from its own message log rather than from
    // turns, so it reaches the panel by a different route than loadHistory.
    const edit = (toolUseId: string, path: string) => [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "write_file", input: { file_path: path } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [
              `Updated ${path}`,
              `diff --git a/${path} b/${path}`,
              `--- a/${path}`,
              `+++ b/${path}`,
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const session = {
      metadata: { id: "sess-1", title: "Two edits", total_tokens: 12 },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit a" }] },
        ...edit("tool-1", "src/a.ts"),
        { role: "user", content: [{ type: "text", text: "edit b" }] },
        ...edit("tool-2", "src/b.ts"),
      ],
    };
    const { provider, postMessage } = createProviderWithLiveWorkPanel(session);

    await provider.loadSessionMessages("sess-1");

    const payload = lastChangesPayload(postMessage);
    expect(payload.changes.map((c: any) => c.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.changes.map((c: any) => c.turnIndex)).toEqual([1, 2]);
    expect(payload.turns.map((t: any) => t.label)).toEqual(["edit a", "edit b"]);
  });

  it("drops a group whose only change was reverted", async () => {
    const { provider, postMessage } = createProviderWithLiveWorkPanel(twoTurnDetail());
    await (provider as any).loadHistory("thread-1");

    // Reverting the second turn's only change leaves its group with no rows.
    const reverted = (provider as any).turnFileChanges.find(
      (c: any) => c.filePath === "src/second.ts",
    );
    (provider as any).turnFileChanges = (provider as any).turnFileChanges.filter(
      (c: any) => c !== reverted,
    );
    (provider as any).refreshChangesPanel();

    const payload = lastChangesPayload(postMessage);
    expect(payload.changes).toHaveLength(1);
    expect(payload.turns.map((t: any) => t.index)).toEqual([1]);
  });
});
