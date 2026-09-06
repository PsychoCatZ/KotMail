import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { config } from "../config.js";
import { readHealth } from "./health.js";

const execFileAsync = promisify(execFile);
export const runtimeAlias = "kotmail";
export const tunnelBinary = resolve(config.dataDir, "tools/tunnel-client/tunnel-client.exe");
export const profileDir = resolve(config.dataDir, "tunnel/profiles");
const normalize = (value: string): string => process.platform === "win32" ? value.replaceAll("\\", "/") : value;
const entry = normalize(resolve(config.projectRoot, "dist/src/mcp/server.js"));
const node = normalize(process.platform === "win32" ? process.execPath.replace(/^C:\\Program Files\\/i, "C:\\Progra~1\\") : process.execPath);
if (/\s/.test(node) || /\s/.test(entry)) throw new Error("KotMail tunnel paths must not contain spaces for stdio launch");
const mcpCommand = `${node} ${entry}`;

export type RuntimeInfo = { processRunning: boolean; healthy: boolean; ready: boolean; tunnelId?: string };

export async function inspectRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<RuntimeInfo> {
  const result = await execFileAsync(tunnelBinary, ["runtimes", "status", runtimeAlias, "--json"], {
    cwd: config.projectRoot, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 1_000_000,
  });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const health = readHealth(parsed);
  const tunnelId = typeof parsed.tunnel_id === "string" && /^tunnel_[A-Za-z0-9_-]{16,200}$/.test(parsed.tunnel_id)
    ? parsed.tunnel_id : undefined;
  return { ...health, ...(tunnelId ? { tunnelId } : {}) };
}

export async function connectRuntime(tunnelId: string, runtimeKey: string, restart: boolean): Promise<RuntimeInfo> {
  const environment = { ...process.env, KOTMAIL_TUNNEL_API_KEY: runtimeKey, CONTROL_PLANE_API_KEY: runtimeKey };
  const current = await inspectRuntime(environment).catch(() => ({ processRunning: false, healthy: false, ready: false }));
  if (restart && current.processRunning) {
    await execFileAsync(tunnelBinary, ["runtimes", "stop", runtimeAlias], {
      cwd: config.projectRoot, env: environment, windowsHide: true, timeout: 20_000, maxBuffer: 1_000_000,
    });
  } else if (current.processRunning && current.healthy && current.ready) {
    return current;
  }
  await execFileAsync(tunnelBinary, [
    "runtimes", "connect", "--alias", runtimeAlias, "--profile", runtimeAlias, "--profile-dir", profileDir,
    "--tunnel-id", tunnelId, "--runtime-api-key", "env:KOTMAIL_TUNNEL_API_KEY", "--mcp-command", mcpCommand,
  ], { cwd: config.projectRoot, env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000 });
  let last: RuntimeInfo = { processRunning: false, healthy: false, ready: false };
  for (let attempt = 0; attempt < 15; attempt += 1) {
    last = await inspectRuntime(environment);
    if (last.processRunning && last.healthy && last.ready) return last;
    await new Promise(done => setTimeout(done, 2_000));
  }
  throw new Error("Runtime did not become ready");
}
