import { resolve } from "node:path";
import dotenv from "dotenv";

const projectRoot = process.cwd();
dotenv.config({ path: resolve(projectRoot, ".env.local"), quiet: true });

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function masterKey(): Buffer {
  const raw = process.env.KOTMAIL_MASTER_KEY;
  if (!raw) {
    throw new Error("KotMail is not bootstrapped. Run `npm run bootstrap` first.");
  }
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error("KOTMAIL_MASTER_KEY must contain 32 bytes");
  return key;
}

export const config = {
  projectRoot,
  dataDir: resolve(projectRoot, process.env.KOTMAIL_DATA_DIR ?? "data"),
  masterKey: masterKey(),
  setupHost: "127.0.0.1",
  setupPort: integer("KOTMAIL_SETUP_PORT", 3210),
  imapHost: process.env.KOTMAIL_IMAP_HOST ?? "imap.yandex.com",
  imapPort: integer("KOTMAIL_IMAP_PORT", 993),
  maxMessageSourceBytes: 1_000_000,
  maxReturnedTextChars: 50_000,
} as const;
