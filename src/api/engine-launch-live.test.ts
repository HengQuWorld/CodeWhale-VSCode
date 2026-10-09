/**
 * Live check: the extension's own resolve → launch → readiness → auth path
 * against a real installed `codewhale` binary.
 *
 * Not part of the default suite — it spawns the engine and needs one on PATH.
 * Run with:
 *   CODEWHALE_LIVE_ENGINE=1 npx vitest run src/api/engine-launch-live.test.ts
 *
 * It exists because the resolved path, the `cmd` wrapper for a `.cmd` shim, and
 * the listener announcement are exactly what a mocked spawn cannot exercise:
 * they are machine- and platform-specific.
 */
import { describe, expect, it, vi } from "vitest";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { randomBytes } from "crypto";

vi.mock("vscode", () => ({ workspace: {} }));
import { engineLaunch, resolveEngine } from "./engine";

const live = process.env.CODEWHALE_LIVE_ENGINE ? describe : describe.skip;

/** The engine's credential directory must be a symlink-free path, and its
 * daemon socket must fit the platform's limit (macOS allows 103 bytes), so the
 * scratch tree is short and, on macOS, spelled through /private. */
function scratchRoot(): string {
  return process.platform === "darwin" ? "/private/tmp" : fs.realpathSync(os.tmpdir());
}

function probe(port: number, token?: string): Promise<number | null> {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/v1/threads?limit=1`, {
      timeout: 3000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

interface Started {
  root: string;
  token: string;
  child: ChildProcess;
  port: number;
}

/** Start a real engine through the extension's own resolve + launch path. */
async function startEngine(): Promise<Started> {
  const { path: enginePath, searched } = resolveEngine("codewhale");
  expect(fs.existsSync(enginePath), `resolved ${enginePath} from: ${searched.join(", ")}`).toBe(true);

  const root = fs.mkdtempSync(path.join(scratchRoot(), "cwlive-"));
  const workspace = path.join(root, "ws");
  const engineHome = path.join(root, "home");
  const runtimeDir = path.join(root, "rt");
  for (const dir of [workspace, engineHome, runtimeDir]) fs.mkdirSync(dir);
  const token = randomBytes(32).toString("hex");

  const args = ["--workspace", workspace, "serve", "--http", "--host", "127.0.0.1", "--port", "0"];
  const launch = engineLaunch(enginePath, args);
  const child = spawn(launch.command, launch.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    env: {
      ...process.env,
      CODEWHALE_HOME: engineHome,
      CODEWHALE_RUNTIME_DIR: runtimeDir,
      DEEPSEEK_RUNTIME_DIR: runtimeDir,
      CODEWHALE_RUNTIME_TOKEN: token,
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });

  const port = await new Promise<number>((resolve, reject) => {
    const poll = setInterval(() => {
      const match = /Runtime API listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(Number(match[1]));
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`no listener announcement in time.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 60000);
  }).catch(async (error: Error) => {
    // Nothing owns this child yet, so its caller cannot clean it up.
    child.kill("SIGKILL");
    await settled(child);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  });

  return { root, token, child, port };
}

async function settled(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once("exit", resolve));
}

live("launching a real engine", () => {
  it("resolves a real binary, starts it, and is answered only under its token", async () => {
    const { root, token, child, port } = await startEngine();
    try {
      expect(await probe(port)).toBe(401);
      expect(await probe(port, token)).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await settled(child);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90000);
});
