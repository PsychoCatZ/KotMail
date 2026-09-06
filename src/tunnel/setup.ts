import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { allowLocalRequest } from "../security/local-http.js";
import { autostartEnabled, disableAutostart, enableAutostart } from "./autostart.js";
import { connectRuntime, inspectRuntime } from "./runtime.js";

const host = "127.0.0.1";
const port = 3211;
const origin = `http://${host}:${port}`;
const csrf = randomBytes(32).toString("hex");
type TunnelStatus =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "ready"; processRunning: boolean; healthy: boolean; ready: boolean }
  | { state: "error"; message: string };

let status: TunnelStatus = { state: "idle" };
let running = false;
let checkedAt: string | null = null;
let lastCheckedMs = 0;
let tunnelIdHint = "";
let healthCheck: Promise<void> | undefined;

function sendJson(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8_192) throw new Error("Request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function safeError(error: unknown, secret: string): string {
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const parts = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("; ")
    .replaceAll(secret, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  return parts.slice(0, 1_500) || "Tunnel setup failed";
}

async function refreshStatus(): Promise<void> {
  if (running || Date.now() - lastCheckedMs < 5_000) return;
  if (healthCheck) return healthCheck;
  healthCheck = (async () => {
    try {
      const flags = await inspectRuntime();
      if (flags.tunnelId) tunnelIdHint = flags.tunnelId;
      if (!running) status = flags.processRunning && flags.healthy && flags.ready
        ? { state: "ready", ...flags }
        : { state: "error", message: "Туннель сейчас не готов. Запустите его через форму ниже; после перезагрузки это ожидаемо." };
    } catch {
      if (!running) status = { state: "error", message: "Не удалось проверить локальный туннель. Проверьте установку tunnel-client и подключитесь через форму ниже." };
    } finally {
      lastCheckedMs = Date.now();
      checkedAt = new Date().toISOString();
    }
  })();
  try { await healthCheck; } finally { healthCheck = undefined; }
}

async function connectTunnel(tunnelId: string, runtimeKey: string, remember: boolean): Promise<void> {
  running = true;
  status = { state: "starting" };
  try {
    const state = await connectRuntime(tunnelId, runtimeKey, true);
    if (remember) await enableAutostart(tunnelId, runtimeKey);
    status = { state: "ready", ...state };
  } catch (error) {
    status = { state: "error", message: safeError(error, runtimeKey) };
  } finally {
    running = false;
    lastCheckedMs = Date.now();
    checkedAt = new Date().toISOString();
  }
}

const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KotMail — Secure MCP Tunnel</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#18181b}main{border:1px solid #ddd;border-radius:16px;padding:28px;box-shadow:0 8px 28px #0001}label{display:block;margin:16px 0 6px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:10px;border:1px solid #aaa;border-radius:8px}.choice{display:flex;gap:10px;align-items:flex-start}.choice input{margin-top:6px}button{margin-top:20px;padding:11px 18px;border:0;border-radius:9px;background:#111;color:#fff;cursor:pointer}.secondary{background:#fff;color:#8a1c13;border:1px solid #b42318}.muted{color:#666}.ok{color:#08752d}.error{color:#b42318;white-space:pre-wrap}</style></head>
<body><main><h1>KotMail</h1>
<p>Личная Яндекс Почта в ChatGPT · только чтение</p>
<section id="result" aria-live="polite">Проверяю туннель…</section><p id="checked" class="muted"></p>
<p id="autostart" class="muted"></p>
<p>Повторять вход в Яндекс после перезапуска обычно не нужно. Runtime key можно использовать только для текущего запуска или зашифрованно сохранить для автоматического восстановления связи.</p>
<p class="muted">Если ключа ещё нет, создайте его в <a target="_blank" rel="noopener" href="https://platform.openai.com/settings/organization/api-keys">OpenAI Platform → API keys</a>. Владельцу ключа нужны Tunnels Read + Use.</p>
<form id="form"><label for="tunnelId">Tunnel ID</label><input id="tunnelId" placeholder="tunnel_..." autocomplete="off" required>
<label for="runtimeKey">Runtime API key</label><input id="runtimeKey" type="password" placeholder="sk-..." autocomplete="off" required>
<label class="choice"><input id="remember" type="checkbox"><span><strong>Автоматически восстанавливать KotMail после входа в Windows</strong><br><span class="muted">Открытый ключ будет зашифрован средствами Windows для этой учётной записи и не попадёт в файлы или логи.</span></span></label>
<button>Запустить / перезапустить KotMail</button><p class="muted">При перезапуске связь с ChatGPT прервётся на несколько секунд. После изменения инструментов обновите их список в настройках KotMail в ChatGPT.</p></form>
<button id="disable" class="secondary" type="button" hidden>Отключить автозапуск и удалить сохранённый ключ</button>
<h2>Что уже можно попросить</h2><p>«Покажи 10 непрочитанных писем за неделю, без текста писем».<br>«Найди письма от … по теме …».<br>«Покажи следующую страницу».<br>«Прочитай это письмо и кратко перескажи».<br>«Какие вложения в этом письме?»</p>
<p class="muted">Пока только Входящие. Файлы вложений не скачиваются. Не предоставляйте другим людям доступ к этому туннелю: он подключён к одному вашему ящику.</p></main>
<script>const form=document.querySelector('#form'),result=document.querySelector('#result'),auto=document.querySelector('#autostart'),disable=document.querySelector('#disable');const esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let submitting=false;
async function poll(){try{const s=await fetch('/api/status',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json()});if(!tunnelId.value&&s.tunnelId)tunnelId.value=s.tunnelId;auto.textContent=s.autostart?'Автовосстановление: включено. После входа в Windows KotMail будет следить за туннелем.':'Автовосстановление: выключено.';disable.hidden=!s.autostart;if(!submitting){if(s.state==='starting')result.textContent='Запускаю и проверяю туннель…';else if(s.state==='ready')result.innerHTML='<p class="ok"><strong>Туннель работает.</strong> Можно обращаться к KotMail в ChatGPT.</p>';else result.innerHTML='<p class="error">'+esc(s.message||'Туннель не запущен')+'</p>';}document.querySelector('#checked').textContent=s.checkedAt?'Проверено: '+new Date(s.checkedAt).toLocaleTimeString():'';}catch{result.innerHTML='<p class="error">Локальный KotMail не отвечает. Запустите Start KotMail.cmd из папки проекта.</p>';document.querySelector('#checked').textContent='';}finally{setTimeout(poll,5000)}}
form.addEventListener('submit',async e=>{e.preventDefault();submitting=true;form.querySelector('button').disabled=true;result.textContent='Запускаю…';try{const response=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json','x-kotmail-csrf':'${csrf}'},body:JSON.stringify({tunnelId:tunnelId.value.trim(),runtimeKey:runtimeKey.value.trim(),remember:remember.checked})});const body=await response.json();result.textContent=response.ok?'Перезапуск принят, проверяю готовность…':body.error||'Ошибка';}catch{result.textContent='Нет связи с локальным KotMail';}finally{runtimeKey.value='';submitting=false;form.querySelector('button').disabled=false;}});
disable.addEventListener('click',async()=>{disable.disabled=true;try{const response=await fetch('/api/autostart/disable',{method:'POST',headers:{'x-kotmail-csrf':'${csrf}'}});const body=await response.json();result.textContent=response.ok?'Автозапуск отключён, сохранённый ключ удалён. Текущий туннель продолжает работать.':body.error||'Ошибка';}catch{result.textContent='Нет связи с локальным KotMail';}finally{disable.disabled=false;}});poll();</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    if (!allowLocalRequest(request.method, request.headers, origin, csrf)) { sendJson(response, 403, { error: "Local origin required" }); return; }
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      });
      response.end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      await refreshStatus();
      sendJson(response, 200, { ...status, service: "kotmail-tunnel-setup", version: "0.3.0", checkedAt, tunnelId: tunnelIdHint, autostart: await autostartEnabled() }); return;
    }
    if (request.method === "POST" && url.pathname === "/api/connect") {
      if (running) { sendJson(response, 409, { error: "Tunnel уже запускается" }); return; }
      const body = await jsonBody(request);
      const tunnelId = typeof body.tunnelId === "string" ? body.tunnelId.trim() : "";
      const runtimeKey = typeof body.runtimeKey === "string" ? body.runtimeKey.trim() : "";
      if (!/^tunnel_[A-Za-z0-9_-]{16,200}$/.test(tunnelId) || !runtimeKey.startsWith("sk-") || runtimeKey.length < 20 || runtimeKey.length > 500 || /\s/.test(runtimeKey)) {
        sendJson(response, 400, { error: "Проверьте Tunnel ID и runtime API key" });
        return;
      }
      void connectTunnel(tunnelId, runtimeKey, body.remember === true);
      sendJson(response, 202, { accepted: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/autostart/disable") {
      await disableAutostart();
      sendJson(response, 200, { disabled: true });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch {
    sendJson(response, 400, { error: "Некорректный запрос" });
  }
});

server.listen(port, host, () => process.stdout.write(`KotMail tunnel setup: http://${host}:${port}\n`));
