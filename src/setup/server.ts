import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { loadCredentials, saveCredentials } from "../storage/vault.js";
import { fetchYandexEmail, pollDeviceToken, requestDeviceAuthorization } from "../yandex/oauth.js";
import { describeImapError, verifyImapConnection } from "../yandex/imap.js";
import { randomBytes } from "node:crypto";
import { allowLocalRequest } from "../security/local-http.js";
const csrf = randomBytes(32).toString("hex");
const origin = `http://${config.setupHost}:${config.setupPort}`;

type SetupStatus =
  | { state: "idle" }
  | { state: "waiting"; verificationUrl: string; userCode: string }
  | { state: "verifying" }
  | { state: "ready"; email: string; inboxMessages: number }
  | { state: "error"; message: string };

let status: SetupStatus = { state: "idle" };
let running = false;

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

async function startConnection(clientId: string, clientSecret: string): Promise<void> {
  running = true;
  try {
    const authorization = await requestDeviceAuthorization(clientId);
    status = {
      state: "waiting",
      verificationUrl: authorization.verificationUrl,
      userCode: authorization.userCode,
    };
    const token = await pollDeviceToken(clientId, clientSecret, authorization);
    status = { state: "verifying" };
    const email = await fetchYandexEmail(token.accessToken);
    await saveCredentials({
      clientId,
      clientSecret,
      email,
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      scope: token.scope,
    });
    const verified = await verifyImapConnection();
    status = { state: "ready", ...verified };
  } catch (error) {
    status = { state: "error", message: describeImapError(error) };
  } finally {
    running = false;
  }
}

const page = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KotMail — подключение Яндекс Почты</title>
  <style>
    body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#18181b}
    main{border:1px solid #ddd;border-radius:16px;padding:28px;box-shadow:0 8px 28px #0001}
    label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #aaa;border-radius:8px}
    button{margin-top:20px;padding:11px 18px;border:0;border-radius:9px;background:#111;color:#fff;cursor:pointer}
    code{font-size:1.35em;letter-spacing:.08em}.muted{color:#666}.ok{color:#08752d}.error{color:#b42318;white-space:pre-wrap}
  </style>
</head>
<body><main>
  <h1>KotMail</h1>
  <p>Локальное подключение одного тестового ящика. Данные отправляются только процессу на этом компьютере.</p>
  <form id="form">
    <label for="clientId">Client ID приложения Яндекса</label><input id="clientId" autocomplete="off" required>
    <label for="clientSecret">Client Secret</label><input id="clientSecret" type="password" autocomplete="off" required>
    <button>Начать OAuth-подключение</button>
  </form>
  <section id="result" aria-live="polite"></section>
</main>
<script>
const form=document.querySelector('#form'), result=document.querySelector('#result');
const escapeHtml=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function poll(){
  const s=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json());
  if(s.state==='waiting') result.innerHTML='<h2>Подтвердите доступ</h2><p>Откройте <a target="_blank" rel="noopener" href="'+encodeURI(s.verificationUrl)+'">страницу Яндекса</a> и введите код:</p><p><code>'+escapeHtml(s.userCode)+'</code></p><p class="muted">KotMail ожидает подтверждения…</p>';
  else if(s.state==='verifying') result.innerHTML='<p>Проверяю readonly IMAP…</p>';
  else if(s.state==='ready'){result.innerHTML='<p class="ok"><strong>Готово.</strong> Ящик '+escapeHtml(s.email)+' подключён; INBOX доступен.</p>';form.hidden=true;return;}
  else if(s.state==='error'){result.innerHTML='<p class="error">'+escapeHtml(s.message)+'</p>';return;}
  setTimeout(poll,1500);
}
form.addEventListener('submit',async e=>{e.preventDefault();result.textContent='Запрашиваю код…';
  const response=await fetch('/api/connect',{method:'POST',headers:{'content-type':'application/json','x-kotmail-csrf':'${csrf}'},body:JSON.stringify({clientId:clientId.value.trim(),clientSecret:clientSecret.value})});
  const body=await response.json();clientSecret.value='';if(!response.ok){result.textContent=body.error||'Ошибка';return;}poll();
});
poll();
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    if (!allowLocalRequest(request.method, request.headers, origin, csrf)) { sendJson(response, 403, { error: "Local origin required" }); return; }
    const url = new URL(request.url ?? "/", `http://${config.setupHost}:${config.setupPort}`);
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
      sendJson(response, 200, status);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/connect") {
      if (running) { sendJson(response, 409, { error: "Подключение уже выполняется" }); return; }
      const body = await jsonBody(request);
      if (running) { sendJson(response, 409, { error: "Подключение уже выполняется" }); return; }
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId) || clientSecret.length < 8 || clientSecret.length > 500) {
        sendJson(response, 400, { error: "Проверьте Client ID и Client Secret" });
        return;
      }
      status = { state: "idle" };
      void startConnection(clientId, clientSecret);
      sendJson(response, 202, { accepted: true });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch {
    sendJson(response, 400, { error: "Некорректный запрос" });
  }
});

const existing = await loadCredentials();
if (existing) {
  try {
    status = { state: "ready", ...(await verifyImapConnection()) };
  } catch (error) {
    status = { state: "error", message: describeImapError(error) };
  }
}

server.listen(config.setupPort, config.setupHost, () => {
  process.stdout.write(`KotMail setup: http://${config.setupHost}:${config.setupPort}\n`);
});
