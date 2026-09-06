import { config } from "../config.js";
import { signOpaque, verifyOpaque } from "../security/crypto.js";

type MessagePointer = { version: 1; mailbox: "INBOX"; uidValidity: string; uid: number };

export function encodeMessageId(uidValidity: bigint, uid: number): string {
  const pointer: MessagePointer = { version: 1, mailbox: "INBOX", uidValidity: String(uidValidity), uid };
  const payload = Buffer.from(JSON.stringify(pointer), "utf8").toString("base64url");
  return `${payload}.${signOpaque(payload, config.masterKey)}`;
}

export function decodeMessageId(value: string): MessagePointer {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !verifyOpaque(payload, signature, config.masterKey)) {
    throw new Error("Invalid message id");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<MessagePointer>;
  if (
    parsed.version !== 1 || parsed.mailbox !== "INBOX" ||
    typeof parsed.uidValidity !== "string" || typeof parsed.uid !== "number" ||
    !Number.isSafeInteger(parsed.uid) || parsed.uid <= 0
  ) throw new Error("Invalid message id");
  return parsed as MessagePointer;
}
