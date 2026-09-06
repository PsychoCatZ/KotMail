import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "../config.js";
import { protectForCurrentUser, unprotectForCurrentUser } from "../security/windows-dpapi.js";

const execFileAsync = promisify(execFile);
const secretPath = resolve(config.dataDir, "tunnel/runtime-key.dpapi.json");
const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const valueName = "KotMail Runtime";
const watcherPath = resolve(config.projectRoot, "dist/src/tunnel/watcher.js");
export const runCommand = `\"${process.execPath}\" \"${watcherPath}\"`;
if (runCommand.length > 260) throw new Error("KotMail project path is too long for Windows autostart");

type SecretFile = { version: 1; protection: "windows-dpapi-current-user"; tunnelId: string; ciphertext: string };

export async function saveRuntimeSecret(tunnelId: string, runtimeKey: string): Promise<void> {
  const input = Buffer.from(runtimeKey, "utf8");
  try {
    const ciphertext = await protectForCurrentUser(input);
    await mkdir(resolve(config.dataDir, "tunnel"), { recursive: true });
    const temporary = `${secretPath}.${randomUUID()}.tmp`;
    const file: SecretFile = { version: 1, protection: "windows-dpapi-current-user", tunnelId, ciphertext };
    await writeFile(temporary, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, secretPath);
  } finally { input.fill(0); }
}

export async function loadRuntimeSecret(): Promise<{ tunnelId: string; runtimeKey: string } | null> {
  try {
    const file = JSON.parse(await readFile(secretPath, "utf8")) as Partial<SecretFile>;
    if (file.version !== 1 || file.protection !== "windows-dpapi-current-user" ||
      typeof file.tunnelId !== "string" || !/^tunnel_[A-Za-z0-9_-]{16,200}$/.test(file.tunnelId) ||
      typeof file.ciphertext !== "string") throw new Error("Invalid saved runtime credential");
    const plain = await unprotectForCurrentUser(file.ciphertext);
    try {
      const runtimeKey = plain.toString("utf8");
      if (!runtimeKey.startsWith("sk-") || runtimeKey.length < 20 || runtimeKey.length > 500 || /\s/.test(runtimeKey)) {
        throw new Error("Invalid saved runtime credential");
      }
      return { tunnelId: file.tunnelId, runtimeKey };
    } finally { plain.fill(0); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function setRunValue(): Promise<void> {
  await execFileAsync("reg.exe", ["ADD", runKey, "/v", valueName, "/t", "REG_SZ", "/d", runCommand, "/f"], {
    windowsHide: true, timeout: 15_000, maxBuffer: 100_000,
  });
}

export async function autostartEnabled(): Promise<boolean> {
  try {
    const result = await execFileAsync("reg.exe", ["QUERY", runKey, "/v", valueName], {
      windowsHide: true, timeout: 15_000, maxBuffer: 100_000,
    });
    await access(secretPath);
    return result.stdout.includes(runCommand);
  } catch { return false; }
}

export async function enableAutostart(tunnelId: string, runtimeKey: string): Promise<void> {
  await saveRuntimeSecret(tunnelId, runtimeKey);
  try { await setRunValue(); } catch (error) { await removeRuntimeSecret(); throw error; }
  const watcher = spawn(process.execPath, [watcherPath], {
    cwd: config.projectRoot, detached: true, windowsHide: true, stdio: "ignore",
  });
  watcher.once("error", () => { /* The Windows logon entry remains the durable fallback. */ });
  watcher.unref();
}

export async function removeRuntimeSecret(): Promise<void> {
  try { await unlink(secretPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function disableAutostart(): Promise<void> {
  try {
    await execFileAsync("reg.exe", ["DELETE", runKey, "/v", valueName, "/f"], {
      windowsHide: true, timeout: 15_000, maxBuffer: 100_000,
    });
  } catch { /* Missing values are already disabled. */ }
  await removeRuntimeSecret();
}
