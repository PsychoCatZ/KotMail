import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = 'http://127.0.0.1:3211/';
async function status() {
  try {
    const response = await fetch(url + 'api/status', { signal: AbortSignal.timeout(12_000) });
    const value = await response.json();
    return value.service === 'kotmail-tunnel-setup' ? value : null;
  } catch { return null; }
}
async function portIsFree() {
  return new Promise(resolveResult => {
    const probe = createServer();
    probe.once('error', () => resolveResult(false));
    probe.listen(3211, '127.0.0.1', () => probe.close(() => resolveResult(true)));
  });
}
try {
  let ready = await status();
  if (!ready) {
    if (!await portIsFree()) throw new Error('Port 3211 is occupied. Ask Codex to update the old KotMail setup process.');
    await access(resolve(root, '.env.local'));
    execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--pretty', 'false'], {
      cwd: root, windowsHide: true, stdio: 'pipe', timeout: 60_000,
    });
    const child = spawn(process.execPath, [resolve(root, 'dist/src/tunnel/setup.js')], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
    });
    let failed = false;
    child.on('error', () => { failed = true; });
    child.unref();
    const deadline = Date.now() + 40_000;
    while (!ready && !failed && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 500));
      ready = await status();
    }
    if (!ready) throw new Error('KotMail local page did not start.');
  }
  if (!process.argv.includes('--no-browser')) {
    const browser = spawn('explorer.exe', [url], { detached: true, windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => {});
    browser.unref();
  }
  console.log('KotMail: open http://127.0.0.1:3211/ to start or check the tunnel.');
} catch {
  console.error('KotMail could not start. Ask Codex to check the project and local port 3211.');
  process.exitCode = 1;
}
