import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { MailPage, MessageMetadata, MessageContent } from "../yandex/imap.js";

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

const child = spawn(process.execPath, [resolve(config.projectRoot, "dist/src/mcp/server.js")], {
  cwd: config.projectRoot,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();
// Drain, but never collect or print potentially sensitive library diagnostics.
child.stderr.resume();
child.on("error", () => { for (const waiter of pending.values()) waiter.reject(new Error("MCP process could not start")); pending.clear(); });
child.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error("MCP process exited")); pending.clear(); });

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message: JsonRpcResponse;
  try { message = JSON.parse(line) as JsonRpcResponse; } catch { return; }
  if (typeof message.id !== "number") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`MCP request rejected (${message.error.code ?? "unknown"})`));
  else waiter.resolve(message);
});

let nextId = 1;
function request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = nextId++;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, 55_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await request("tools/call", { name, arguments: args });
  check(response.result?.isError !== true, `${name} returned a tool error (private details withheld)`);
  check(response.result?.structuredContent, `${name} omitted structured content`);
  return response.result.structuredContent as T;
}

const ok = (message: string): void => { process.stdout.write(`OK: ${message}\n`); };

try {
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "kotmail-private-smoke", version: "0.1.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await request("tools/list", {});
  const tools = Array.isArray(listed.result?.tools) ? listed.result.tools as Array<Record<string, unknown>> : [];
  const expected = new Set([
    "mail_list_recent",
    "mail_search",
    "mail_get_metadata",
    "mail_get_content",
    "mail_list_attachments",
  ]);
  if (tools.length !== expected.size || tools.some((tool) => !expected.has(String(tool.name)))) {
    throw new Error("Unexpected MCP tool set");
  }
  for (const tool of tools) {
    const annotations = tool.annotations as Record<string, unknown> | undefined;
    if (annotations?.readOnlyHint !== true || annotations.destructiveHint !== false) {
      throw new Error(`Tool ${String(tool.name)} is not strictly read-only`);
    }
  }

  const all = process.argv.includes("--all");
  const page = await call<MailPage>("mail_list_recent", { limit: all ? 25 : 1 });
  check(page.messages.length > 0, "No messages available for the live test");
  check(page.messages.every(m => !("text" in m)), "Metadata unexpectedly contained a body");
  ok(`MCP exposed ${tools.length} read-only tools; recent metadata received without bodies`);
  if (all) {
    if (page.hasMore) {
      const next = await call<MailPage>("mail_list_recent", { limit: 2, beforeId: page.nextBeforeId });
      check(next.messages.every(m => m.uid < page.messages.at(-1)!.uid), "Pagination overlapped");
      ok("older-message pagination has no overlaps");
    }
    const unread = await call<MailPage>("mail_search", { unread: true, limit: 1 });
    check(unread.messages.every(m => m.seen === false), "Unread filter returned read mail");
    ok("unread filter");
    const target = page.messages.find(m => !m.seen && m.attachments.length) ?? unread.messages[0] ?? page.messages[0]!;
    const before = await call<{ message: MessageMetadata }>("mail_get_metadata", { id: target.id });
    check(before.message.id === target.id && !("text" in before.message), "Metadata mismatch");
    ok("single-message metadata");
    const content = await call<{ message: MessageContent }>("mail_get_content", { id: target.id });
    check(content.message.id === target.id && typeof content.message.text === "string" && content.message.text.length <= 50_000, "Content contract failed");
    check(typeof content.message.truncated === "boolean", "Missing truncation flag");
    ok(`text body: ${content.message.text.length} characters; truncated=${content.message.truncated} (text not printed)`);
    const attachmentTarget = page.messages.find(m => m.attachments.length) ?? target;
    const attachments = await call<{ messageId: string; attachments: unknown[] }>("mail_list_attachments", { id: attachmentTarget.id });
    check(attachments.messageId === attachmentTarget.id && attachments.attachments.length === attachmentTarget.attachments.length, "Attachment metadata mismatch");
    ok(`attachment list: ${attachments.attachments.length} entries; no files downloaded`);
    const filters: Record<string, unknown> = {};
    const from = target.from.find(address => address.address)?.address;
    if (from) filters.from = from;
    if (target.subject !== "(без темы)") filters.subject = target.subject.slice(0, 100);
    if (target.receivedAt) {
      const timestamp = Date.parse(target.receivedAt);
      filters.after = new Date(timestamp - 86_400_000).toISOString().slice(0, 10);
      filters.before = new Date(timestamp + 2 * 86_400_000).toISOString().slice(0, 10);
    }
    if (Object.keys(filters).length) {
      const result = await call<MailPage>("mail_search", { ...filters, limit: 25 });
      check(result.messages.some(m => m.id === target.id), "Sender/subject/date search did not find the target");
      ok("combined sender/subject/received-date search");
      const word = content.message.text.match(/[\p{L}]{5,20}/u)?.[0];
      if (word) {
        const textSearch = await call<MailPage>("mail_search", { ...filters, text: word, limit: 25 });
        check(textSearch.messages.some(m => m.id === target.id), "Text search did not find the target");
        ok("server-side text search");
      }
    }
    const after = await call<{ message: MessageMetadata }>("mail_get_metadata", { id: target.id });
    check(before.message.seen === after.message.seen, "Seen flag changed during read-only test");
    ok(`Seen flag unchanged${before.message.seen ? " (target was already read)" : " (target remains unread)"}`);
    let rejected = false;
    try { await call("mail_search", { after: "2026-09-04", before: "2026-09-03" }); } catch { rejected = true; }
    check(rejected, "Invalid date range was accepted");
    ok("invalid date range rejected; all five tools checked without printing private fields");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "MCP smoke failed";
  process.stderr.write(`FAILED: ${message}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
}
