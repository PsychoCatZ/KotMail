import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env.local");
const dataPath = resolve(root, "data");

await mkdir(dataPath, { recursive: true });

try {
  await access(envPath, constants.F_OK);
  process.stdout.write("KotMail is already bootstrapped; .env.local was left unchanged.\n");
} catch {
  const masterKey = randomBytes(32).toString("base64url");
  const contents = [
    `KOTMAIL_MASTER_KEY=${masterKey}`,
    "KOTMAIL_DATA_DIR=./data",
    "KOTMAIL_SETUP_HOST=127.0.0.1",
    "KOTMAIL_SETUP_PORT=3210",
    "KOTMAIL_IMAP_HOST=imap.yandex.com",
    "KOTMAIL_IMAP_PORT=993",
    "",
  ].join("\n");
  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  process.stdout.write("Created private .env.local and data directory.\n");
}
