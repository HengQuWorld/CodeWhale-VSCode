import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import { createInterface } from "readline";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

const HEALTH_TIMEOUT_MS = 3000;
const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_RETRY_INTERVAL_MS = 300;
const isWindows = process.platform === "win32";

function homeDir(): string {
  return os.homedir();
}

function resolveEnginePath(configuredPath: string): string {
  if (configuredPath !== "codewhale") {
    return configuredPath;
  }

  const candidates: string[] = [];

  if (isWindows) {
    const appData = process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
    candidates.push(
      path.join(appData, "npm", "node_modules", "codewhale", "bin", "downloads", "codewhale.exe"),
      path.join(appData, "npm", "node_modules", "codewhale", "bin", "downloads", "codewhale.cmd"),
      path.join(localAppData, "Yarn", "Data", "global", "node_modules", "codewhale", "bin", "downloads", "codewhale.exe"),
      path.join(homeDir(), "AppData", "Roaming", "nvm", "v" + process.version.slice(1), "node_modules", "codewhale", "bin", "downloads", "codewhale.exe"),
    );
  } else {
    candidates.push(
      path.join(homeDir(), ".cargo", "bin", "codewhale"),
      path.join(homeDir(), ".cargo", "bin", "codewhale-tui"),
      "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale",
      "/usr/local/lib/node_modules/codewhale/bin/downloads/codewhale",
      path.join(homeDir(), ".npm-global/lib/node_modules/codewhale/bin/downloads/codewhale"),
      path.join(homeDir(), ".local/share/codewhale/bin/downloads/codewhale"),
      "/home/linuxbrew/.linuxbrew/lib/node_modules/codewhale/bin/downloads/codewhale",
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch { /* skip */ }
  }
  return isWindows ? "codewhale.exe" : "codewhale";
}

// Older Runtimes reject --port 0. Select a candidate here, then require the
// owned child's post-bind receipt before contacting it: availability is not ownership.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = (listener.address() as net.AddressInfo).port;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

// Shared-engine discovery file (globalStorage/serve.json) written by the window
// that launched the engine, so later windows reuse it instead of starting a new one.
interface ServeState {
  port: number;
  token: string;
  pid?: number;
}

export class CodeWhaleEngine {
  private process: ChildProcess | null = null;
  private _port = 7878;
  private readonly _host = "127.0.0.1";
  private _token: string | null = null;
  private _running = false;
  private _starting: Promise<void> | null = null;
  private _stopping: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private attached = false;

  constructor(
    private outputChannel: vscode.OutputChannel,
    private context: vscode.ExtensionContext
  ) {}

  get port(): number { return this._port; }
  get host(): string { return this._host; }
  get baseUrl(): string { return `http://${this._host}:${this._port}`; }
  get token(): string | null { return this._token; }
  get isRunning(): boolean { return this._running; }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("Engine has been disposed");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before starting CodeWhale");
    if (this._running && this.process) return;
    if (this._running && this.attached) {
      if (await this.sharedServeAlive()) return;
      this.attached = false;
      this._running = false;
    }
    if (this._starting) {
      await this._starting;
      return this.ensureRunning();
    }
    const starting = this.launch();
    this._starting = starting;
    try { await starting; }
    finally { if (this._starting === starting) this._starting = null; }
  }

  async start(): Promise<void> { await this.ensureRunning(); }

  private async launch(): Promise<void> {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    this.assertCurrent(generation);
    if (await this.attachSharedServe()) return;
    const requestedPort = await findFreePort();
    this.assertCurrent(generation);
    if (await this.attachSharedServe()) return;
    this.attached = false;
    this._port = 0;
    let port: number | undefined;
    const token = randomBytes(32).toString("hex");
    this._token = token;
    const tasksDir = path.join(this.context.globalStorageUri.fsPath, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const config = vscode.workspace.getConfiguration("brotherwhale");
    const enginePath = resolveEnginePath(config.get<string>("enginePath", "codewhale"));
    // No --workspace: the shared engine is workspace-agnostic. Each thread
    // already carries its own workspace via the API.
    const args = ["serve", "--http", "--host", this._host, "--port", String(requestedPort)];
    const extraPaths = isWindows
      ? [path.join(process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming"), "npm")]
      : ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
    const pathSep = isWindows ? ";" : ":";
    const pathKey = isWindows ? "Path" : "PATH";
    const existingPath = process.env.PATH || process.env.Path || "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEEPSEEK_TASKS_DIR: tasksDir,
      CODEWHALE_RUNTIME_TOKEN: token,
      [pathKey]: [...existingPath.split(pathSep), ...extraPaths.filter(p => !existingPath.split(pathSep).includes(p))].join(pathSep),
    };
    delete env[isWindows ? "PATH" : "Path"];
    // Never inherit an alternate token or pass the generated secret in argv.
    delete env.DEEPSEEK_RUNTIME_TOKEN;
    this.log(`Starting: ${enginePath} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(enginePath, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    } catch (error) {
      this._token = null;
      throw error;
    }
    this.process = child;
    let spawnError: Error | undefined;
    // Another listener can win the port-selection gap. Do not send any request
    // until this child confirms its own bind succeeded.
    const outputLines = child.stdout ? createInterface({ input: child.stdout }) : undefined;
    outputLines?.on("line", (line: string) => {
      this.log(`[stdout] ${line}`, token);
      if (!line.startsWith("Runtime API listening on ")) return;
      const match = /^Runtime API listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(line);
      const announced = match ? Number(match[1]) : 0;
      if (announced !== requestedPort || (port !== undefined && port !== announced)) {
        spawnError = new Error("Runtime announced an invalid local listener");
        return;
      }
      port = announced;
    });
    const clear = () => {
      if (this.process === child) {
        this.process = null;
        this._running = false;
        this._token = null;
      }
    };
    const errorLines = child.stderr ? createInterface({ input: child.stderr }) : undefined;
    errorLines?.on("line", (line: string) => this.log(`[stderr] ${line}`, token));
    child.once("exit", (code, signal) => {
      outputLines?.close();
      errorLines?.close();
      this.log(`Engine exited (code=${code}, signal=${signal})`);
      clear();
    });
    child.once("error", (error) => { outputLines?.close(); errorLines?.close(); spawnError = error; clear(); });
    try {
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (true) {
        this.assertCurrent(generation);
        if (spawnError) throw spawnError;
        if (this.process !== child) throw new Error("Engine exited before becoming ready");
        // Public health is insufficient: the owned child must enforce its token.
        if (port !== undefined) {
          const anonymous = await this.probe(port);
          if (anonymous?.status === 200) throw new Error("Runtime authentication is unavailable; update CodeWhale");
          if (anonymous?.status === 401) {
            const authenticated = await this.probe(port, token);
            if (authenticated?.status === 200 && Array.isArray(authenticated.body)) break;
          }
        }
        if (Date.now() >= deadline) throw new Error("Engine failed to start within timeout");
        await new Promise(resolve => setTimeout(resolve, HEALTH_RETRY_INTERVAL_MS));
      }
      this.assertCurrent(generation);
      if (this.process !== child) throw new Error("Engine exited before becoming ready");
      this._port = port!;
      this._running = true;
      this.writeServeState({ port: port!, token, pid: child.pid });
      this.log(`Engine ready on port ${port}`);
    } catch (error) {
      if (this.process === child) await this.stop();
      throw error;
    }
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) throw new Error("Engine startup cancelled");
  }

  async stop(): Promise<void> {
    this.generation++;
    const child = this.process;
    this.process = null;
    this._running = false;
    this._token = null;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
      await this._stopping;
      return;
    }
    this.log("Stopping the engine started by this window...");
    const stopping = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Only the captured owned child may be terminated. Never discover a
        // process from a port file, which can outlive or refer to another app.
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch { /* already exited */ }
        done();
      }, 3000);
      child.once("exit", done);
      try {
        if (isWindows) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          killer.once("error", () => { try { child.kill(); } catch { /* already exited */ } });
        } else child.kill("SIGTERM");
      } catch { done(); }
    });
    this._stopping = stopping;
    try { await stopping; } finally { if (this._stopping === stopping) this._stopping = null; }
  }

  async restart(): Promise<void> {
    const starting = this._starting;
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (starting) { try { await starting; } catch { /* cancelled start */ } }
    this.assertCurrent(generation);
    this.clearServeState();
    await this.ensureRunning();
  }

  private serveStatePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "serve.json");
  }

  private readServeState(): ServeState | null {
    try {
      return JSON.parse(fs.readFileSync(this.serveStatePath(), "utf8")) as ServeState;
    } catch {
      return null;
    }
  }

  private writeServeState(state: ServeState): void {
    try {
      fs.writeFileSync(this.serveStatePath(), JSON.stringify(state));
    } catch (error) {
      this.log(`Could not persist shared-engine state: ${error instanceof Error ? error.message : error}`);
    }
  }

  private clearServeState(): void {
    try { fs.rmSync(this.serveStatePath(), { force: true }); } catch { /* best effort */ }
  }

  private async attachSharedServe(): Promise<boolean> {
    const state = this.readServeState();
    if (!state || typeof state.port !== "number" || !state.token) return false;
    const anonymous = await this.probe(state.port);
    if (anonymous?.status === 401) {
      const authenticated = await this.probe(state.port, state.token);
      if (authenticated?.status === 200 && Array.isArray(authenticated.body)) {
        this._port = state.port;
        this._token = state.token;
        this._running = true;
        this.attached = true;
        this.log(`Reusing the running engine on port ${state.port}`);
        return true;
      }
    }
    this.clearServeState();
    return false;
  }

  private async sharedServeAlive(): Promise<boolean> {
    const result = await this.probe(this._port, this._token ?? undefined);
    return result?.status === 200 && Array.isArray(result.body);
  }

  private probe(port: number, token?: string): Promise<{ status: number; body: unknown } | null> {
    return new Promise(resolve => {
      const req = http.get(`http://${this._host}:${port}/v1/threads?limit=1`, {
        timeout: HEALTH_TIMEOUT_MS,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, res => {
        let body = "";
        res.on("data", chunk => {
          body += chunk;
          if (body.length > 65536) { req.destroy(); resolve(null); }
        });
        res.on("error", () => resolve(null));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: null }); }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  private log(msg: string, token = this._token): void {
    const safe = token ? msg.split(token).join("[REDACTED]") : msg;
    const line = `[CodeWhale Engine] ${safe}`;
    this.outputChannel.appendLine(line);
    try {
      fs.appendFileSync(path.join(this.context.globalStorageUri.fsPath, "engine.log"), `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging must not block shutdown */ }
  }

  dispose(): void {
    // Keep the shared engine alive so other windows keep reusing it.
    // A new engine is only launched when none is running.
    this.disposed = true;
  }
}
