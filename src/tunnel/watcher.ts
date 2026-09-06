import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { loadRuntimeSecret } from "./autostart.js";
import { connectRuntime, inspectRuntime } from "./runtime.js";

const lockPath = resolve(config.dataDir, "tunnel/watcher.lock");
async function takeLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      try { if (Number.isSafeInteger(pid) && pid > 0) { process.kill(pid, 0); return null; } } catch { /* stale */ }
      await unlink(lockPath).catch(() => {});
    }
  }
  return null;
}

const lock = await takeLock();
if (lock) {
  const cleanup = async () => { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); };
  process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
  let delay = 15_000;
  while (true) {
    try {
      const saved = await loadRuntimeSecret();
      if (!saved) break;
      const state = await inspectRuntime().catch(() => ({ processRunning: false, healthy: false, ready: false }));
      if (!state.processRunning || !state.healthy || !state.ready) await connectRuntime(saved.tunnelId, saved.runtimeKey, false);
      delay = 15_000;
    } catch { delay = Math.min(delay * 2, 120_000); }
    if (process.argv.includes("--once")) break;
    await new Promise(done => setTimeout(done, delay));
  }
  await cleanup();
}
