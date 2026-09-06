import type { ToolAnnotations } from "@modelcontextprotocol/server";

export const READ_ONLY_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const LIMITS = {
  recent: { default: 10, max: 25 },
  search: { default: 10, max: 25 },
} as const;
