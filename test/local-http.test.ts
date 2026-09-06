import test from "node:test";
import assert from "node:assert/strict";
import { allowLocalRequest } from "../src/security/local-http.js";
import { readHealth } from "../src/tunnel/health.js";

test("only same-origin JSON with CSRF token can start local processes or change credentials", () => {
  const origin = "http://127.0.0.1:3211";
  const good = { host: "127.0.0.1:3211", origin, "x-kotmail-csrf": "test-token", "content-type": "application/json" };
  assert.ok(allowLocalRequest("POST", good, origin, "test-token"));
  for (const headers of [{ ...good, host: "evil.invalid:3211" }, { ...good, origin: "https://evil.invalid" },
    { ...good, "x-kotmail-csrf": "wrong" }, { ...good, "content-type": "text/plain" }, { host: good.host }]) {
    assert.equal(allowLocalRequest("POST", headers, origin, "test-token"), false);
  }
  assert.equal(allowLocalRequest("GET", { host: "evil.invalid:3211" }, origin, "test-token"), false);
  assert.ok(allowLocalRequest("GET", { host: good.host }, origin, "test-token"));
});

test("historical nested health cannot override current local runtime status", () => {
  assert.deepEqual(readHealth({ process_running: false, healthy: false, ready: false,
    remote: { process_running: true, healthy: true, ready: true } }), { processRunning: false, healthy: false, ready: false });
  assert.deepEqual(readHealth({ process_running: true, healthy: true, ready: true }), { processRunning: true, healthy: true, ready: true });
  assert.equal(readHealth({ ready: "true" }).ready, false);
});
