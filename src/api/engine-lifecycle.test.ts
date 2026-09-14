import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { ChildProcess } from "child_process";

const state = vi.hoisted(() => ({ fixture: "", storage: "", workspace: "", trusted: true, mode: "normal", launches: [] as any[], children: [] as any[], competing: [] as any[], competingRequests: 0 }));
vi.mock("vscode", () => ({ workspace: {
  get isTrusted() { return state.trusted; },
  get workspaceFolders() { return [{ uri: { fsPath: state.workspace } }]; },
  getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "enginePath" ? "fixture-engine" : fallback }),
} }));
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  const network = await import("node:http");
  return { ...real, spawn: (command: string, args: string[], options: any) => {
    if (command !== "fixture-engine") return real.spawn(command, args, options);
    state.launches.push({ command, args, options });
    if (state.mode === "occupied") {
      // Occupy the selected port before the owned child can bind it.
      const competing = network.createServer((req, res) => {
        state.competingRequests++;
        res.writeHead(req.headers.authorization ? 200 : 401);
        res.end(req.headers.authorization ? "[]" : "{}");
      });
      competing.listen(Number(args.at(-1)), "127.0.0.1");
      state.competing.push(competing);
    }
    const child = real.spawn(process.execPath, [state.fixture, ...args], { ...options, env: { ...options.env, FIXTURE_MODE: state.mode, FIXTURE_STORAGE: state.storage } });
    state.children.push(child);
    return child;
  } };
});
import { CodeWhaleEngine } from "./engine";

let root: string;
let engines: CodeWhaleEngine[];
function engine() {
  const logs: string[] = [];
  const item = new CodeWhaleEngine({ appendLine: (line: string) => logs.push(line) } as any, { globalStorageUri: { fsPath: state.storage } } as any);
  engines.push(item);
  return { item, logs };
}
function getStatus(port: number, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/v1/threads?limit=1`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => { res.resume(); resolve(res.statusCode!); }).on("error", reject);
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "community-engine-test-"));
  state.storage = path.join(root, "storage");
  state.workspace = path.join(root, "workspace");
  fs.mkdirSync(state.storage); fs.mkdirSync(state.workspace);
  state.fixture = path.join(root, "engine.cjs");
  fs.writeFileSync(state.fixture, `
const http = require('http');
const fs = require('fs');
const path = require('path');
const storage = process.env.FIXTURE_STORAGE;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (process.env.FIXTURE_MODE === 'exit') process.exit(1);
if (process.env.FIXTURE_MODE === 'owner-conflict') {
  console.error('error: This runtime is already active in another process. Close the other Codewhale session and try again, or set CODEWHALE_RUNTIME_DIR to a different directory.');
  process.exit(1);
}
if (process.env.FIXTURE_MODE === 'hang') setInterval(() => {}, 1000);
else {
 const token = process.env.CODEWHALE_RUNTIME_TOKEN;
 const server = http.createServer((req, res) => {
   if (process.env.FIXTURE_MODE === 'delayed') fs.appendFileSync(path.join(storage, 'requests'), 'request\\n');
   if (process.env.FIXTURE_MODE !== 'insecure' && req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end('{}'); return; }
   res.writeHead(200, {'Content-Type': 'application/json'}); res.end('[]');
 });
 server.listen(port, '127.0.0.1', () => {
   const announce = () => {
     process.stdout.write('Runtime API listening on http://127.0.0.1:');
     setTimeout(() => console.log(server.address().port), 5);
     setTimeout(() => {
       process.stdout.write(token.slice(0, 32));
       setTimeout(() => console.log(token.slice(32)), 5);
     }, 10);
   };
   if (process.env.FIXTURE_MODE === 'delayed') {
     fs.writeFileSync(path.join(storage, 'bound'), String(server.address().port));
     const timer = setInterval(() => {
       if (fs.existsSync(path.join(storage, 'announce'))) { clearInterval(timer); announce(); }
     }, 5);
   } else announce();
 });
}
`);
  state.trusted = true; state.mode = "normal"; state.launches = []; state.children = []; state.competing = []; state.competingRequests = 0; engines = [];
});
afterEach(async () => {
  await Promise.all(engines.map(item => item.stop()));
  for (const child of state.children as ChildProcess[]) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(state.competing.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("owned Runtime lifecycle", () => {
  it("starts one authenticated child for concurrent callers without leaking its token", async () => {
    const { item, logs } = engine();
    await Promise.all([item.ensureRunning(), item.ensureRunning(), item.ensureRunning()]);
    expect(state.launches).toHaveLength(1);
    expect(item.token).toMatch(/^[0-9a-f]{64}$/);
    expect(state.launches[0].args).not.toContain("--insecure");
    expect(Number(state.launches[0].args.at(-1))).toBeGreaterThan(0);
    expect(state.launches[0].args.join(" ")).not.toContain(item.token);
    expect(await getStatus(item.port)).toBe(401);
    expect(await getStatus(item.port, item.token!)).toBe(200);
    expect(logs.join("\n")).not.toContain(item.token);
    expect(logs.join("\n")).not.toContain(item.token!.slice(0, 32));
    expect(logs.join("\n")).not.toContain(item.token!.slice(32));
    expect(fs.readFileSync(path.join(state.storage, "engine.log"), "utf8")).not.toContain(item.token);
  });

  it("waits for its child to report the bound address before sending any request", async () => {
    state.mode = "delayed";
    const { item } = engine();
    const starting = item.ensureRunning();
    // The fixture is already listening, but the Engine has no owned-address receipt yet.
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(state.storage, "bound"))) {
      if (Date.now() > deadline) throw new Error("fixture did not bind");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(item.port).toBe(0);
    expect(item.isRunning).toBe(false);
    expect(fs.existsSync(path.join(state.storage, "requests"))).toBe(false);
    fs.writeFileSync(path.join(state.storage, "announce"), "ready");
    await starting;
    expect(item.port).toBe(Number(fs.readFileSync(path.join(state.storage, "bound"), "utf8")));
    expect(item.isRunning).toBe(true);
    expect(fs.readFileSync(path.join(state.storage, "requests"), "utf8")).toContain("request");
  });

  it("ignores stale and legacy port files without contacting their listener", async () => {
    let requests = 0;
    const unrelated = http.createServer((_req, res) => { requests++; res.end('{"status":"ok"}'); });
    await new Promise<void>(resolve => unrelated.listen(0, "127.0.0.1", resolve));
    const port = (unrelated.address() as any).port;
    const key = `ws_${state.workspace.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32)}`;
    for (const name of ["serve.port", `serve.${key}.port`]) fs.writeFileSync(path.join(state.storage, name), String(port));
    try {
      const { item } = engine(); await item.ensureRunning();
      expect(item.port).not.toBe(port);
      expect(requests).toBe(0);
      expect(unrelated.listening).toBe(true);
      await item.stop();
      expect(unrelated.listening).toBe(true);
    } finally { await new Promise<void>(resolve => unrelated.close(() => resolve())); }
  });

  it("never contacts another listener that wins the selected port", async () => {
    state.mode = "occupied";
    const { item } = engine();
    await expect(item.ensureRunning()).rejects.toThrow("exited");
    expect(state.competingRequests).toBe(0);
    expect(item.isRunning).toBe(false);
    expect(item.token).toBeNull();
    expect(state.competing[0].listening).toBe(true);
  });

  it("rejects a runtime that ignores authentication and cleans up that child", async () => {
    state.mode = "insecure";
    const { item } = engine();
    await expect(item.ensureRunning()).rejects.toThrow("authentication");
    expect(item.isRunning).toBe(false); expect(item.token).toBeNull();
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
  });

  it("cleans up early exit and allows a later startup", async () => {
    state.mode = "exit"; const { item } = engine();
    await expect(item.ensureRunning()).rejects.toThrow("exited");
    state.mode = "normal"; await item.ensureRunning(); expect(item.isRunning).toBe(true);
  });

  it("gives every workspace its own store and comes back to it on restart", async () => {
    const { item } = engine();
    await item.ensureRunning();
    const store = state.launches.at(-1)!.options.env.CODEWHALE_RUNTIME_DIR as string;
    // Never the Runtime default: another window may already own that one.
    expect(store.startsWith(path.join(state.storage, "runtime"))).toBe(true);
    expect(fs.existsSync(store)).toBe(true);
    // Isolation moves the Runtime store only; tasks stay where the GUI reads them.
    expect(state.launches.at(-1)!.options.env.DEEPSEEK_TASKS_DIR).toBe(path.join(state.storage, "tasks"));
    // A reload of the same workspace finds the store it already has.
    await item.restart();
    expect(state.launches.at(-1)!.options.env.CODEWHALE_RUNTIME_DIR).toBe(store);
    // A different workspace never reuses that store.
    state.workspace = path.join(root, "other-workspace");
    fs.mkdirSync(state.workspace);
    await item.ensureRunning();
    const other = state.launches.at(-1)!.options.env.CODEWHALE_RUNTIME_DIR as string;
    expect(other).not.toBe(store);
    expect(other.startsWith(path.join(state.storage, "runtime"))).toBe(true);
  });

  it("shows the Runtime's own refusal instead of a generic exit message", async () => {
    state.mode = "owner-conflict"; const { item } = engine();
    await expect(item.ensureRunning()).rejects.toThrow("already active in another process");
    expect(state.launches).toHaveLength(1);
    expect(item.isRunning).toBe(false); expect(item.token).toBeNull();
  });

  it.each(["ensureRunning", "restart"] as const)("cancels a same-tick %s before it can launch", async (method) => {
    const { item } = engine();
    const starting = item[method]();
    const failure = expect(starting).rejects.toThrow("cancelled");
    await item.stop();
    await failure;
    expect(state.launches).toHaveLength(0);
    expect(item.isRunning).toBe(false);
    expect(item.token).toBeNull();
    await item.ensureRunning();
    expect(item.isRunning).toBe(true);
  });

  it("cancels startup on disposal and never reactivates the disposed engine", async () => {
    state.mode = "hang"; const { item } = engine();
    const starting = item.ensureRunning();
    const failure = expect(starting).rejects.toThrow("cancelled");
    while (!state.children.length) await new Promise(resolve => setTimeout(resolve, 5));
    item.dispose(); await item.stop(); await failure;
    expect(item.isRunning).toBe(false); expect(item.token).toBeNull();
    await expect(item.ensureRunning()).rejects.toThrow("disposed");
  });

  it("rotates credentials on restart and ignores late events from its former child", async () => {
    const { item } = engine(); await item.ensureRunning();
    const first = state.children[0]; const oldToken = item.token;
    await item.restart();
    const newToken = item.token; expect(newToken).not.toBe(oldToken);
    first.emit("exit", 0, null);
    expect(item.isRunning).toBe(true); expect(item.token).toBe(newToken);
    expect(await getStatus(item.port, newToken!)).toBe(200);
  });

  it("does not execute workspace configuration in restricted mode", async () => {
    state.trusted = false; const { item } = engine();
    await expect(item.ensureRunning()).rejects.toThrow("Trust this workspace");
    expect(state.launches).toHaveLength(0);
  });
});
