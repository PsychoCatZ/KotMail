import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptJson, encryptJson } from "../src/security/crypto.js";
import { decodeMessageId, encodeMessageId } from "../src/domain/message-id.js";

test("vault encryption round-trips without plaintext fields", () => {
  const key = randomBytes(32);
  const secret = { accessToken: "not-for-logs", email: "test@yandex.ru" };
  const encrypted = encryptJson(secret, key);
  assert.equal(JSON.stringify(encrypted).includes(secret.accessToken), false);
  assert.deepEqual(decryptJson(encrypted, key), secret);
});

test("vault authentication detects tampering", () => {
  const key = randomBytes(32);
  const encrypted = encryptJson({ token: "secret" }, key);
  const bytes = Buffer.from(encrypted.ciphertext, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  encrypted.ciphertext = bytes.toString("base64url");
  assert.throws(() => decryptJson(encrypted, key));
});

test("message ids are opaque, signed and bound to UIDVALIDITY", () => {
  const id = encodeMessageId(123456n, 42);
  assert.deepEqual(decodeMessageId(id), {
    version: 1,
    mailbox: "INBOX",
    uidValidity: "123456",
    uid: 42,
  });
  const [payload, signature] = id.split(".") as [string, string];
  const replacement = signature[0] === "A" ? "B" : "A";
  assert.throws(() => decodeMessageId(`${payload}.${replacement}${signature.slice(1)}`), /Invalid message id/);
});
