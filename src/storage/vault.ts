import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";
import { decryptJson, encryptJson, type EncryptedValue } from "../security/crypto.js";

export type YandexCredentials = {
  clientId: string;
  clientSecret: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope: string[];
};

type VaultFile = {
  version: 1;
  encrypted: EncryptedValue;
};

const vaultPath = resolve(config.dataDir, "vault.json");

export async function loadCredentials(): Promise<YandexCredentials | null> {
  try {
    const raw = await readFile(vaultPath, "utf8");
    const file = JSON.parse(raw) as VaultFile;
    if (file.version !== 1) throw new Error("Unsupported vault version");
    return decryptJson<YandexCredentials>(file.encrypted, config.masterKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveCredentials(credentials: YandexCredentials): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const file: VaultFile = {
    version: 1,
    encrypted: encryptJson(credentials, config.masterKey),
  };
  const temporary = `${vaultPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, vaultPath);
}
