import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as http from "http";
import { createInterface } from "readline";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";

import { telemetryEnabled, telemetryEnv } from "../utils/telemetry-settings";
const HEALTH_TIMEOUT_MS = 3000;
const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_RETRY_INTERVAL_MS = 300;
const isWindows = process.platform === "win32";

function homeDir(): string {
  return os.homedir();
}

// The engine's own name, and the only configured value that triggers a search:
// anything else is a path the user chose.
//
// The search exists because `codewhale` is not enough to launch it. On PATH it
// is a real executable image on Unix, but on Windows it is usually an
// npm-family shim — a generated `codewhale.cmd` next to the prefix — which
// CreateProcess cannot start, so a PATH hit there can still be unlaunchable:
// the user's shell resolves it by extension and this process cannot. A window's
// PATH can also predate the install, because VS Code inherits the environment
// it was started with. So the known real layouts are probed first, PATH after
// them, and PATH's shims last.
export const ENGINE_BINARY_NAME = "codewhale";

export interface EngineLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (candidate: string) => boolean;
  readdir?: (dir: string) => string[];
}

export interface EngineResolution {
  path: string;
  /** Every location probed, in order, so a failure can name them. */
  searched: string[];
}

function fileExists(candidate: string): boolean {
  try { return fs.existsSync(candidate); } catch { return false; }
}

function directoryEntries(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** The executable inside an npm-family global prefix. */
function prefixBinary(prefix: string, windows: boolean): string {
  return windows
    ? path.join(prefix, "node_modules", "codewhale", "bin", "downloads", "codewhale.exe")
    : path.join(prefix, "lib", "node_modules", "codewhale", "bin", "downloads", "codewhale");
}

/** The install locations this extension has always probed, in their original
 * order, and then newer probes appended after them.
 *
 * Both halves matter. Resolution is first-hit-wins, so an install a macOS or
 * Linux user already had must keep resolving to the same binary — reordering
 * these would silently switch which engine runs. The appended probes only get
 * consulted when none of the originals exists, which is exactly the stale-PATH
 * case (a window started before the install) they exist for. */
function posixCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const candidates = [
    path.join(home, ".cargo", "bin", "codewhale"),
    path.join(home, ".cargo", "bin", "codewhale-tui"),
    "/opt/homebrew/lib/node_modules/codewhale/bin/downloads/codewhale",
    "/usr/local/lib/node_modules/codewhale/bin/downloads/codewhale",
    path.join(home, ".npm-global", "lib", "node_modules", "codewhale", "bin", "downloads", "codewhale"),
    path.join(home, ".local", "share", "codewhale", "bin", "downloads", "codewhale"),
    "/home/linuxbrew/.linuxbrew/lib/node_modules/codewhale/bin/downloads/codewhale",
  ];
  // Appended: an explicit npm prefix is the one location npm itself names,
  // then the directories a manager installs a real executable into.
  const prefix = env.npm_config_prefix;
  if (prefix) candidates.push(prefixBinary(prefix, false), path.join(prefix, "bin", "codewhale"));
  candidates.push(
    "/opt/homebrew/bin/codewhale",
    "/usr/local/bin/codewhale",
    path.join(home, ".local", "bin", "codewhale"),
    path.join(home, ".bun", "bin", "codewhale"),
  );
  return candidates;
}

function windowsCandidates(env: NodeJS.ProcessEnv, home: string, readdir: (dir: string) => string[]): string[] {
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  const candidates: string[] = [];

  // npm-family global prefixes, in the order npm itself would report them.
  if (env.npm_config_prefix) {
    candidates.push(path.join(env.npm_config_prefix, "codewhale.exe"), prefixBinary(env.npm_config_prefix, true));
  }
  candidates.push(prefixBinary(path.join(appData, "npm"), true));
  candidates.push(prefixBinary(path.join(localAppData, "pnpm"), true));
  candidates.push(prefixBinary(path.join(localAppData, "Yarn", "Data", "global"), true));

  // nvm-windows keeps each Node version's global packages in its own version
  // directory, reached through %NVM_SYMLINK%. The version this extension host
  // was built against says nothing about which one the user installed with, so
  // the directories are listed instead of guessed from process.version.
  const nvmHome = env.NVM_HOME || path.join(appData, "nvm");
  const nvmSymlink = env.NVM_SYMLINK || path.join(programFiles, "nodejs");
  candidates.push(prefixBinary(nvmSymlink, true), prefixBinary(nvmHome, true));
  for (const entry of readdir(nvmHome)) {
    if (/^v?\d/.test(entry)) candidates.push(prefixBinary(path.join(nvmHome, entry), true));
  }

  // Installers and managers that place a real executable on the user PATH.
  candidates.push(
    path.join(localAppData, "Programs", "CodeWhale", "bin", "codewhale.exe"),
    path.join(localAppData, "Microsoft", "WinGet", "Links", "codewhale.exe"),
    path.join(localAppData, "Volta", "bin", "codewhale.exe"),
    path.join(home, ".bun", "bin", "codewhale.exe"),
    path.join(home, "scoop", "shims", "codewhale.exe"),
  );
  return candidates;
}

function pathDirectories(env: NodeJS.ProcessEnv, windows: boolean): string[] {
  const raw = env.PATH || env.Path || env.path || "";
  return raw.split(windows ? ";" : ":").map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/** The executable an npm-family shim runs: a shim sits either in the global
 * prefix itself or in its `node_modules/.bin`, and both name the package
 * directory the same way. */
function shimTarget(shimPath: string): string {
  const dir = path.dirname(shimPath);
  const packageRoot = /[\\/]\.bin$/.test(dir)
    ? path.dirname(dir)
    : path.join(dir, "node_modules");
  return path.join(packageRoot, "codewhale", "bin", "downloads", "codewhale.exe");
}

/** Resolve the configured engine path. A configured value other than the bare
 * default is used verbatim — the user said exactly what to run. */
export function resolveEngine(configuredPath: string, lookup: EngineLookup = {}): EngineResolution {
  const platform = lookup.platform ?? process.platform;
  const windows = platform === "win32";
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? os.homedir();
  const exists = lookup.exists ?? fileExists;
  const readdir = lookup.readdir ?? directoryEntries;
  const searched: string[] = [];

  if (configuredPath !== ENGINE_BINARY_NAME) return { path: configuredPath, searched };

  const binary = windows ? "codewhale.exe" : "codewhale";
  const directories = pathDirectories(env, windows);
  const known = windows
    ? windowsCandidates(env, home, readdir)
    : posixCandidates(env, home);
  const shims = directories.flatMap(dir =>
    windows ? [path.join(dir, "codewhale.cmd"), path.join(dir, "codewhale.bat")] : []);

  // A PATH directory is only probed on Windows. There, Node cannot start a
  // `.cmd` shim and CreateProcess appends only `.exe`, so a real install on a
  // directory PATH happens to hold would be missed. On POSIX the bare name is
  // returned instead and the kernel's own search resolves it — with the
  // executable-bit check this existence probe does not make, and which a hand
  // written scan would only get wrong.
  const pathEntries = windows ? directories.map(dir => path.join(dir, binary)) : [];

  // 1. Executable images: the install layouts, then PATH.
  for (const candidate of [...known, ...pathEntries]) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (exists(candidate)) return { path: candidate, searched };
  }

  // 2. The package a PATH shim wraps — still a real executable image.
  for (const shim of shims) {
    const target = shimTarget(shim);
    if (searched.includes(target)) continue;
    searched.push(target);
    if (exists(target)) return { path: target, searched };
  }

  // 3. The shim itself, launched through the command interpreter.
  for (const shim of shims) {
    searched.push(shim);
    if (exists(shim)) return { path: shim, searched };
  }

  return { path: binary, searched };
}

/** A `.cmd`/`.bat` shim is not an executable image: Windows will not start one
 * without an interpreter, so it is handed to the command processor as a single
 * pre-quoted command line. Every argument here is a local path or a fixed flag,
 * and the engine path has already been probed as a real file, so quoting is
 * complete: the whole line is wrapped once more for `cmd /s`. */
export interface EngineLaunch {
  command: string;
  args: string[];
  verbatim: boolean;
}

export function engineLaunch(enginePath: string, args: string[], lookup: EngineLookup = {}): EngineLaunch {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(enginePath)) {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", `""${enginePath}" ${args.map(arg => `"${arg}"`).join(" ")}"`],
      verbatim: true,
    };
  }
  return { command: enginePath, args, verbatim: false };
}

/** The pid guard to use when retiring a record after stopping the engine.
 *
 * A direct launch hands us the engine's own pid, so retirement can require the
 * record to name it. Through an interpreter (an npm-family `.cmd` shim on
 * Windows) the pid we hold is the interpreter's, while the record names the
 * engine — so requiring them to match would make the cleanup fail precisely on
 * the installs it exists for. There the record's own owner check is the guard.
 * Passing no guard is safe: retirement still refuses any record whose owner is
 * alive. */
export function retirementPid(interpreterLaunch: boolean, childPid: number | undefined): number | undefined {
  return interpreterLaunch ? undefined : childPid;
}

/** A spawn failure the user can act on: name the setting and the recovery. The
 * full probed list stays in the output channel rather than in a toast. */
function engineLaunchError(error: Error, enginePath: string, searched: string[]): Error {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return error;
  const probed = searched.length ? ` ${searched.length} locations were probed; see the CodeWhale output channel for the list.` : "";
  return new Error(
    `CodeWhale engine not found at "${enginePath}".${probed} Install CodeWhale, restart VS Code so it sees the new PATH, or set "brotherwhale.enginePath" to the full path (run \`where codewhale\` in a terminal).`
  );
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

/** A stable directory name per workspace: a window must come back to the store
 * it wrote, because the Runtime allows a single process per store. */
function workspaceStoreKey(workspace: string): string {
  if (!workspace) return "no-workspace";
  return `ws-${createHash("sha256").update(workspace).digest("hex").slice(0, 16)}`;
}

/** A failed start reports the child's own error line: a refusal the user can act
 * on, rather than only "the engine exited". */
export function engineStartupError(childError: string): Error {
  if (!childError) return new Error("Engine exited before becoming ready");
  // The Runtime holds a store through an owner record beside its control
  // endpoint. On Windows the endpoint is a kernel named pipe that dies with its
  // process while the record is a file only a *graceful* exit retires, so a
  // process killed outright leaves a record naming an endpoint that no longer
  // exists — and the engine refuses to start over it rather than recover. Name
  // that recovery here, because "reload the window" is exactly how the record
  // got stranded and will not clear it.
  const stranded = /opening selected Windows owner; refusing fallback|stale-owner recovery is not qualified/i.test(childError)
    ? ` The engine is refusing to start over an owner record left by a previous run. If no CodeWhale is running, delete "${ownerReceiptPath()}" and start again.`
    : "";
  return new Error(`Engine exited before becoming ready: ${childError}${stranded}`);
}

/** The record the Runtime publishes while it holds a store, beside its private
 * control endpoint. */
const OWNER_RECEIPT_NAME = "daemon.owner.json";

/** Whether the engine would accept a path as absolute on this platform. The
 * rules are Rust's, not Node's: Windows needs a drive or UNC prefix, so `/c/...`
 * and `\...` are relative there — which matters because a shell that hands the
 * process a POSIX-shaped `HOME` is exactly a shell whose `HOME` the engine
 * ignores. */
function engineAbsolute(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return path.posix.isAbsolute(candidate);
  return /^[a-zA-Z]:[\\/]/.test(candidate) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate);
}

/** `~` expansion as the engine does it: a leading `~`, `~/` or `~\`, and only
 * when the user home is known. */
function expandTilde(value: string, userHome: string, rules: path.PlatformPath): string {
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const suffix = value.slice(1).replace(/^[\\/]+/, "");
  return suffix ? rules.join(userHome, suffix) : userHome;
}

/** The user home the engine would resolve, in its documented order: `HOME`,
 * then `USERPROFILE`, then `HOMEDRIVE` + `HOMEPATH`, then the platform's own
 * answer. Only an absolute candidate counts — a relative one is not a home, and
 * the engine deliberately refuses to resolve it against the working directory.
 *
 * Note a deliberate divergence: when `HOME` is set but *not* absolute, Rust's
 * `user_home()` gives up rather than falling through to `USERPROFILE`, so an
 * engine started that way has no home and writes no record at all. This falls
 * through instead. That is inert rather than wrong — the path it computes then
 * holds no file, so nothing is retired — and it keeps the recovery it names
 * usable in the environments where a record does exist. */
function engineUserHome(env: NodeJS.ProcessEnv, fallback: string, platform: NodeJS.Platform): string {
  const absolute = (value?: string): string | undefined => {
    const candidate = (value ?? "").trim();
    return candidate && engineAbsolute(candidate, platform) ? candidate : undefined;
  };
  const drive = (env.HOMEDRIVE ?? "").trim();
  const rest = (env.HOMEPATH ?? "").trim();
  return absolute(env.HOME)
    ?? absolute(env.USERPROFILE)
    ?? (drive && rest ? absolute(`${drive}${rest}`) : undefined)
    ?? fallback;
}

/** Where that record lives: the CodeWhale home the engine was started with,
 * always in its `run` subdirectory. Mirrors the engine's `codewhale_home()`
 * followed by `owner_directory()` — an absolute `CODEWHALE_HOME` wins, a
 * relative one is ignored rather than resolved against the working directory
 * (in which case the engine refuses to start and writes nothing), and otherwise
 * the home is `<user home>/.codewhale`. Getting this wrong is not harmless: the
 * recovery this names is a path the user will act on. */
export function ownerReceiptPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const rules = platform === "win32" ? path.win32 : path.posix;
  const userHome = engineUserHome(env, home, platform);
  const override = expandTilde((env.CODEWHALE_HOME ?? "").trim(), userHome, rules);
  const codeWhaleHome = engineAbsolute(override, platform) ? override : rules.join(userHome, ".codewhale");
  return rules.join(codeWhaleHome, "run", OWNER_RECEIPT_NAME);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process this one may not signal is still a live process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ReceiptRetirement {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Retire only a receipt naming this process. */
  onlyPid?: number;
  isAlive?: (pid: number) => boolean;
  readFile?: (file: string) => string;
  remove?: (file: string) => void;
}

export interface RetirementResult {
  path: string;
  retired: boolean;
  /** Whether a record was found and understood. A record present but left
   * alone is the interesting case to report; an absent one is not. */
  found: boolean;
  reason: string;
}

/** Remove the owner record only when it is provably stale: it must name a
 * process that is no longer alive. A record naming a live process is left
 * alone — that owner may be another window or the user's own terminal — and so
 * is one that cannot be read or understood. */
export function retireDeadOwnerReceipt(options: ReceiptRetirement = {}): RetirementResult {
  const receiptPath = ownerReceiptPath(options.env, options.home, options.platform);
  const readFile = options.readFile ?? (file => fs.readFileSync(file, "utf8"));
  const remove = options.remove ?? (file => fs.unlinkSync(file));
  const isAlive = options.isAlive ?? processAlive;
  const nothing = (reason: string): RetirementResult => ({ path: receiptPath, retired: false, found: false, reason });
  const held = (reason: string, retired: boolean): RetirementResult => ({ path: receiptPath, retired, found: true, reason });

  let text: string;
  try {
    text = readFile(receiptPath);
  } catch {
    return nothing("no readable owner record");
  }

  let pid: unknown;
  try {
    pid = (JSON.parse(text) as { pid?: unknown }).pid;
  } catch {
    return nothing("owner record is unreadable; left in place");
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return nothing("owner record names no process; left in place");
  }
  if (options.onlyPid !== undefined && pid !== options.onlyPid) {
    return held(`owner record names ${pid}, not this child`, false);
  }
  if (isAlive(pid)) {
    return held(`owner ${pid} is still running`, false);
  }

  try {
    remove(receiptPath);
  } catch (error) {
    return held(`could not remove a stale owner record: ${(error as Error).message}`, false);
  }
  return held(`removed the stale owner record of dead process ${pid}`, true);
}

export class CodeWhaleEngine {
  private process: ChildProcess | null = null;
  private _port = 7878;
  private readonly _host = "127.0.0.1";
  private _token: string | null = null;
  private _running = false;
  private _starting: Promise<void> | null = null;
  private _stopping: Promise<void> | null = null;
  private _workspaceKey = "";
  private generation = 0;
  private disposed = false;
  /** True when the child is an interpreter running the engine, not the engine
   * itself — so `child.pid` names the interpreter. Windows only. */
  private interpreterLaunch = false;

  constructor(
    private outputChannel: vscode.OutputChannel,
    private context: vscode.ExtensionContext
  ) {}

  get port(): number { return this._port; }
  get host(): string { return this._host; }
  get baseUrl(): string { return `http://${this._host}:${this._port}`; }
  get token(): string | null { return this._token; }
  get isRunning(): boolean { return this._running; }

  private getWorkspaceKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error("Engine has been disposed");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before starting CodeWhale");
    const workspace = this.getWorkspaceKey();
    if (this._running && this.process && this._workspaceKey === workspace) return;
    if (this._starting) {
      await this._starting;
      return this.ensureRunning();
    }
    const starting = this.launch(workspace);
    this._starting = starting;
    try { await starting; }
    finally { if (this._starting === starting) this._starting = null; }
  }

  async start(): Promise<void> { await this.ensureRunning(); }

  private async launch(workspace: string): Promise<void> {
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    this.assertCurrent(generation);
    // One store per workspace, and always the same one. The Runtime allows a
    // single process per store, so a window must not borrow another window's,
    // and a reload must come back to its own history instead of a fresh store.
    const runtimeDir = path.join(this.context.globalStorageUri.fsPath, "runtime", workspaceStoreKey(workspace));
    const requestedPort = await findFreePort();
    this.assertCurrent(generation);
    this._port = 0;
    let port: number | undefined;
    const token = randomBytes(32).toString("hex");
    this._token = token;
    const tasksDir = path.join(this.context.globalStorageUri.fsPath, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    const config = vscode.workspace.getConfiguration("brotherwhale");
    const { path: enginePath, searched } = resolveEngine(config.get<string>("enginePath", "codewhale"));
    const args = workspace ? ["--workspace", workspace] : [];
    args.push("serve", "--http", "--host", this._host, "--port", String(requestedPort));
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
    // Usage reporting belongs to the engine, so the extension says only two
    // things about it: which client the server is serving, and whether the
    // user wants it at all. Everything else — the payload, the buffer, the
    // identity, the endpoint — is the engine's, resolved from the same
    // CodeWhale home the user's terminal sessions use. See
    // `utils/telemetry-settings`.
    Object.assign(env, telemetryEnv(telemetryEnabled()));
    delete env[isWindows ? "PATH" : "Path"];
    // This workspace's own store, named under both spellings so an older Runtime
    // isolates instead of silently sharing a store another window already owns.
    env.CODEWHALE_RUNTIME_DIR = runtimeDir;
    env.DEEPSEEK_RUNTIME_DIR = runtimeDir;
    // Never inherit an alternate token or pass the generated secret in argv.
    delete env.DEEPSEEK_RUNTIME_TOKEN;
    // A window reload kills the previous engine outright, so its owner record
    // outlives it; clear a record whose owner is provably gone before the new
    // child inherits the refusal.
    if (isWindows) {
      const retirement = retireDeadOwnerReceipt({ env });
      if (retirement.retired) this.log(`${retirement.reason}: ${retirement.path}`);
      else if (retirement.found) this.log(`Left the owner record alone: ${retirement.reason} (${retirement.path})`);
    }
    this.log(`Starting: ${enginePath} ${args.join(" ")}`);
    this.log(`With CODEWHALE_RUNTIME_DIR=${runtimeDir}`);
    // A bare name here means every known install location was probed and none
    // held one: the child is about to depend on PATH alone, so record what was
    // tried before the spawn line, not after a failure.
    if (!path.isAbsolute(enginePath)) {
      this.log(searched.length
        ? `No CodeWhale install in ${searched.length} known locations; relying on PATH for "${enginePath}"`
        : `Relying on PATH for "${enginePath}"`);
      if (searched.length) this.log(`Probed: ${searched.join(", ")}`);
    }
    let child: ChildProcess;
    const launch = engineLaunch(enginePath, args);
    this.interpreterLaunch = launch.verbatim;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        windowsHide: true,
        ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
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
    let childError = "";
    errorLines?.on("line", (line: string) => {
      // Keep the Runtime's own error line: a warning printed earlier in the same
      // stream must not become the reason reported to the user.
      const text = line.trim();
      if (text && !/error/i.test(childError)) childError = text;
      this.log(`[stderr] ${line}`, token);
    });
    child.once("exit", (code, signal) => {
      outputLines?.close();
      errorLines?.close();
      this.log(`Engine exited (code=${code}, signal=${signal})`);
      clear();
    });
    child.once("error", (error) => {
      outputLines?.close(); errorLines?.close();
      spawnError = engineLaunchError(error, enginePath, searched);
      clear();
    });
    try {
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (true) {
        this.assertCurrent(generation);
        if (spawnError) throw spawnError;
        if (this.process !== child) throw engineStartupError(childError);
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
      if (this.process !== child) throw engineStartupError(childError);
      this._port = port!;
      this._workspaceKey = workspace;
      this._running = true;
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
    // The shutdown above is forceful on Windows, so the record this child held
    // is still on disk. Retire it now while we know it is ours and it is dead,
    // rather than leaving the next start — ours, or the user's terminal — to
    // trip over it.
    if (isWindows && child.pid) {
      const retirement = retireDeadOwnerReceipt({ onlyPid: retirementPid(this.interpreterLaunch, child.pid) });
      if (retirement.retired) this.log(`${retirement.reason}: ${retirement.path}`);
      else if (retirement.found) this.log(`Left the owner record alone: ${retirement.reason} (${retirement.path})`);
    }
  }

  async restart(): Promise<void> {
    const starting = this._starting;
    const stopping = this.stop();
    const generation = this.generation;
    await stopping;
    if (starting) { try { await starting; } catch { /* cancelled start */ } }
    this.assertCurrent(generation);
    await this.ensureRunning();
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
    this.disposed = true;
    void this.stop().catch(() => { /* best effort on synchronous disposal; deactivate awaits stop */ });
  }
}
