import assert from "node:assert/strict";
import test from "node:test";
import type { MessageStructureObject } from "imapflow";
import { bodyTextParts, parseTextPart } from "../src/yandex/body.js";
import { recentInput, searchInput, singleMessageInput } from "../src/domain/contracts.js";
import { mailErrorMessage } from "../src/domain/errors.js";

test("mail contracts reject extra powers, invalid limits, dates and empty searches", () => {
  for (const input of [{}, { subject: " " }, { unread: true, folder: "Sent" },
    { from: "test", limit: 26 }, { after: "2026-02-30" },
    { after: "2026-09-03", before: "2026-09-03" },
    { after: "2026-09-04", before: "2026-09-03" }]) assert.equal(searchInput.safeParse(input).success, false);
  assert.equal(searchInput.parse({ unread: false }).unread, false);
  assert.equal(searchInput.parse({ unread: true }).limit, 10);
  assert.equal(recentInput.safeParse({ limit: 0 }).success, false);
  assert.equal(singleMessageInput.safeParse({ id: "a".repeat(30), markRead: true }).success, false);
});

test("MIME alternatives select plain text and never attached files or embedded messages", () => {
  const plain: MessageStructureObject = { part: "1.1", type: "text/plain" };
  const tree: MessageStructureObject = { type: "multipart/mixed", childNodes: [
    { part: "1", type: "multipart/alternative", childNodes: [
      { part: "1.2", type: "text/html" }, plain,
    ] },
    { part: "2", type: "text/plain", parameters: { name: "private.txt" } },
    { part: "3", type: "message/rfc822", childNodes: [{ part: "3.1", type: "text/plain" }] },
    { part: "4", type: "multipart/mixed", disposition: "attachment", childNodes: [plain] },
  ] };
  assert.deepEqual(bodyTextParts(tree), [plain]);
});

test("related selects only its root; ordinary mixed text parts keep order", () => {
  const html: MessageStructureObject = { part: "2", type: "text/html", id: "<root>" };
  const tree: MessageStructureObject = { type: "multipart/related", parameters: { start: "<root>" },
    childNodes: [{ part: "1", type: "text/plain", id: "<resource>" }, html] };
  assert.deepEqual(bodyTextParts(tree), [html]);
  assert.deepEqual(bodyTextParts({ type: "multipart/mixed", childNodes: [html, { part: "3", type: "text/plain" }] }).map(x => x.part), ["2", "3"]);
  assert.deepEqual(bodyTextParts({ type: "application/pdf" }), []);
});

test("base64 Cyrillic and Windows-1251 quoted printable are decoded", async () => {
  assert.equal(await parseTextPart({ type: "text/plain", encoding: "base64", parameters: { charset: "UTF-8" } }, Buffer.from(Buffer.from("Привет, Кот!").toString("base64"))), "Привет, Кот!");
  assert.equal(await parseTextPart({ type: "text/plain", encoding: "quoted-printable", parameters: { charset: "windows-1251" } }, Buffer.from("=CF=F0=E8=E2=E5=F2")), "Привет");
});

test("HTML becomes text; scripts/styles do not become instructions or executable output", async () => {
  const text = await parseTextPart({ type: "text/html" }, Buffer.from('<style>badstyle</style><script>badscript</script><p>Привет &amp; мир</p><img src="https://example.invalid/tracker">'));
  assert.ok(text.includes("Привет & мир"));
  assert.ok(!text.includes("badscript") && !text.includes("badstyle") && !text.includes("<script"));
});

test("raw server errors and secrets never cross the error boundary", () => {
  const error = Object.assign(new Error("access_token=private-message-and-secret"), { responseText: "private" });
  assert.ok(!mailErrorMessage(error).includes("private-message"));
  assert.equal(mailErrorMessage(new Error("Message not found")), "Message not found");
  assert.ok(mailErrorMessage({ authenticationFailed: true }).includes("authorization"));
});
