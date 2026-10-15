import { beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { ChatProvider } from "../../chat-provider";
import { reconstructOldContent, reconstructOriginalContent } from "../../utils/diff-utils";

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

describe("ChatProvider rebuilds a replay's diffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds a replay's missing diff from the recorded edit inputs", async () => {
    // A saved session keeps no `file.mutation` receipt: the runtime stores the
    // authoritative diff on turn items, and the contract `edit` tool answers
    // with a one-line summary. Replaying such a session used to drop the diff,
    // which left the Changes panel without its Diff action.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: { id: "sess-edit", title: "edit replay", total_tokens: 10 },
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

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-edit");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState).toBeDefined();
      expect(changesState.changes[0]).toMatchObject({
        filePath: "src/app.ts",
        changeType: "modified",
      });
      expect(changesState.changes[0].diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      // One record per change, and the panel reads the diff from it.
      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(1);
      expect(records[0].diff).toBe(changesState.changes[0].diff);
      expect(records[0].changeIndex).toBe(0);
      // The reconstructed diff recovers exactly the pre-edit content.
      expect(reconstructOldContent("one\nTWO\nthree\n", changesState.changes[0].diff)).toBe(
        "one\ntwo\nthree\n",
      );

      // The card in the message stream carries the same diff, indexed so its
      // own Diff action can pick the right step of the chain.
      const card = provider.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((toolCall) => toolCall.name === "edit");
      expect(card?.fileChange?.diff).toBe(changesState.changes[0].diff);
      expect(card?.fileChange?.changeIndex).toBe(0);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the diff absent when the file no longer matches the recorded edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // The recorded replacement is not in this file: a rebuilt diff would be
      // fiction, so the card must stay without one instead.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "something else\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: { id: "sess-edit-2", title: "stale edit", total_tokens: 10 },
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
              { type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-edit-2");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].diff).toBeUndefined();
      const records = (provider as any).turnFileChanges as Array<{ diff?: string }>;
      expect(records).toHaveLength(1);
      expect(records[0].diff).toBeUndefined();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a viewed session's paths against that session's own workspace", async () => {
    // A session recorded elsewhere keeps workspace-relative paths; they must
    // resolve against the workspace it was recorded in, not the one that
    // happens to be open now.
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-ws-"));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-open-ws-"));
    try {
      fs.mkdirSync(path.join(sessionDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "src", "app.ts"), "one\nTWO\nthree\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: otherDir } },
      ];

      const session = {
        metadata: {
          id: "sess-other-ws",
          title: "recorded elsewhere",
          total_tokens: 10,
          workspace: sessionDir,
        },
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
              { type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-other-ws");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].filePath).toBe("src/app.ts");
      expect(changesState.changes[0].diff).toContain("diff --git a/src/app.ts");
      expect(reconstructOldContent("one\nTWO\nthree\n", changesState.changes[0].diff)).toBe(
        "one\ntwo\nthree\n",
      );
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("does not report a file change for a file tool that failed", async () => {
    // The runtime reports an unsuccessful tool as `item.failed`, which never
    // produces a change card live; a replay has to agree, or the Changes panel
    // lists files that were never touched.
    const session = {
      metadata: { id: "sess-failed", title: "failed edit", total_tokens: 10 },
      messages: [
        { role: "user", content: [{ type: "text", text: "edit src/app.ts" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-edit-1",
              name: "edit_file",
              input: { path: "src/app.ts", search: "a", replace: "b" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              is_error: true,
              content: "Error: Invalid input for tool 'edit_file': search and replace are identical",
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "failed" }] },
      ],
    };

    const { provider, postMessage } = createProvider(session);
    await provider.loadSessionMessages("sess-failed");

    const changesState = postMessage.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, any>)
      .find((message: Record<string, any>) => message.type === "changesState");
    expect(changesState.changes).toEqual([]);
    const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(cards[0].fileChange).toBeUndefined();
    expect(cards[0].status).toBe("error");
  });

  it("does not keep a provisional file card for a failed thread-history tool call", async () => {
    const detail = {
      latest_seq: 12,
      thread: { id: "thread-1", model: "deepseek-v4-pro" },
      turns: [
        {
          id: "turn-1",
          input_summary: "edit src/app.ts",
          created_at: "2026-09-12T10:00:00Z",
          ended_at: "2026-09-12T10:00:02Z",
          status: "completed",
          item_ids: ["u1", "tool-call-1", "tool-result-1", "a1"],
        },
      ],
      items: [
        { id: "u1", kind: "user_message", summary: "edit src/app.ts", detail: "edit src/app.ts", status: "completed" },
        {
          id: "tool-call-1",
          kind: "tool_call",
          summary: "edit({\"path\":\"src/app.ts\"})",
          detail: JSON.stringify({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] }),
          status: "completed",
          metadata: {
            tool_name: "edit",
            tool_use_id: "tool-1",
          },
        },
        {
          id: "tool-result-1",
          kind: "tool_call",
          summary: "tool failed",
          detail: "tool failed",
          status: "completed",
          metadata: {
            tool_result_for: "tool-1",
            is_error: true,
          },
        },
        { id: "a1", kind: "agent_message", summary: "failed", detail: "failed", status: "completed" },
      ],
    };

    const { provider } = createProvider(detail);

    await (provider as any).loadHistory("thread-1");

    const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
    expect(cards[0].status).toBe("error");
    expect(cards[0].fileChange).toBeUndefined();
    expect((provider as any).turnFileChanges).toEqual([]);
  });

  it("rebuilds missing edit diffs even when the same file already has another diff", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-mixed-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\nTWO\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-mixed",
          title: "write then edit",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "write then edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-write-1",
                name: "write",
                input: { path: "src/app.ts", content: "one\ntwo\n" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-write-1", content: "wrote file" }],
          },
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
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider } = createProvider(session);
      await provider.loadSessionMessages("sess-mixed");

      const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
      const writeCall = cards.find((toolCall) => toolCall.name === "write");
      const editCall = cards.find((toolCall) => toolCall.name === "edit");

      expect(writeCall?.fileChange?.diff).toContain("+++ b/src/app.ts");
      expect(writeCall?.fileChange?.changeIndex).toBe(0);
      expect(editCall?.fileChange?.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(editCall?.fileChange?.changeIndex).toBe(1);

      // Two changes to one file are two records: reverting either leaves the
      // other reviewable.
      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      expect(records[0].changeIndex).toBe(0);
      expect(records[1].changeIndex).toBe(1);
      expect(records[1].diff).toBe(editCall?.fileChange?.diff);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds a chain of multiple recorded edits in chronological order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-edit-chain-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "ONE\nTWO\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-edit-chain",
          title: "two edits",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "edit src/app.ts twice" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-1",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "one", newText: "ONE" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-edit-2",
                name: "edit",
                input: { path: "src/app.ts", edits: [{ oldText: "two", newText: "TWO" }] },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-edit-2", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider } = createProvider(session);
      await provider.loadSessionMessages("sess-edit-chain");

      const cards = provider.messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter((toolCall) => toolCall.name === "edit");
      expect(cards).toHaveLength(2);
      expect(cards[0].fileChange?.changeIndex).toBe(0);
      expect(cards[1].fileChange?.changeIndex).toBe(1);

      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      const secondDiff = records[1].diff;
      expect(secondDiff).toBeDefined();
      expect(reconstructOldContent("ONE\nTWO\n", secondDiff!)).toBe("ONE\ntwo\n");
      const chainedDiffs = records.map((record) => record.diff!);
      expect(reconstructOriginalContent(chainedDiffs, "ONE\nTWO\n")).toBe("one\ntwo\n");
      expect(records[0].diff).toBe(cards[0].fileChange?.diff);
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps each change's own diff when a later edit no longer matches the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-session-stale-mixed-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      // Final file has moved on since the recorded edit, so only the earlier
      // write diff remains individually trustworthy.
      fs.writeFileSync(path.join(dir, "src", "app.ts"), "something else\n");
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: dir } },
      ];

      const session = {
        metadata: {
          id: "sess-stale-mixed",
          title: "write then stale edit",
          total_tokens: 10,
          workspace: dir,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "write then edit src/app.ts" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-write-1",
                name: "write",
                input: { path: "src/app.ts", content: "one\ntwo\n" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-write-1", content: "wrote file" }],
          },
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
            content: [{ type: "tool_result", tool_use_id: "tool-edit-1", content: "replaced 1 block" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      };

      const { provider, postMessage } = createProvider(session);
      await provider.loadSessionMessages("sess-stale-mixed");

      const changesState = postMessage.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, any>)
        .find((message: Record<string, any>) => message.type === "changesState");
      expect(changesState.changes[0].diff).toContain("+++ b/src/app.ts");
      expect(changesState.changes[1].diff).toBeUndefined();

      const records = (provider as any).turnFileChanges as Array<{
        diff?: string;
        changeIndex?: number;
      }>;
      expect(records).toHaveLength(2);
      expect(records[0].diff).toContain("+++ b/src/app.ts");
      expect(records[0].changeIndex).toBe(0);
      expect(records[1].diff).toBeUndefined();
      // A change with no diff does not consume an index: reconstruction
      // counts the diffs that exist.
      expect(records[1].changeIndex).toBeUndefined();

      const cards = provider.messages.flatMap((message) => message.toolCalls ?? []);
      const writeCall = cards.find((toolCall) => toolCall.name === "write");
      const editCall = cards.find((toolCall) => toolCall.name === "edit");
      expect(writeCall?.fileChange?.diff).toContain("+++ b/src/app.ts");
      expect(editCall?.fileChange?.diff).toBeUndefined();
    } finally {
      (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
