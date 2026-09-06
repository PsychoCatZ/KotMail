import assert from "node:assert/strict";
import test from "node:test";
import { protectForCurrentUser, unprotectForCurrentUser } from "../src/security/windows-dpapi.js";

test("Windows DPAPI round-trips a synthetic runtime key", { skip: process.platform !== "win32" }, async () => {
  const plain = Buffer.from("sk-test-kotmail-runtime-key-not-a-real-secret", "utf8");
  const protectedValue = await protectForCurrentUser(plain);
  assert.equal(protectedValue.includes(plain.toString("utf8")), false);
  const restored = await unprotectForCurrentUser(protectedValue);
  assert.deepEqual(restored, plain);
  plain.fill(0);
  restored.fill(0);
});

test("Windows DPAPI rejects malformed protected data", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(unprotectForCurrentUser("not-protected"), /Invalid protected credential/);
});
