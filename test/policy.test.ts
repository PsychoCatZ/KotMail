import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS, READ_ONLY_TOOL } from "../src/policy.js";

test("all shared MCP annotations are read-only and non-destructive", () => {
  assert.deepEqual(READ_ONLY_TOOL, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test("mail result limits remain narrow", () => {
  assert.ok(LIMITS.recent.max <= 25);
  assert.ok(LIMITS.search.max <= 25);
});
