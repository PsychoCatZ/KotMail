// Never echo raw IMAP/OAuth responses, user inputs, mail text, paths or credentials to MCP/logs.
export function mailErrorMessage(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; authenticationFailed?: unknown } | null;
  const known = new Set([
    "Invalid message id", "Message id is stale; search for the message again", "Message not found",
    "Yandex mailbox is not connected. Run `npm run setup`.", "Mailbox request timed out",
    "Yandex did not open INBOX", "Yandex did not return message content",
  ]);
  if (typeof e?.message === "string" && known.has(e.message)) return e.message;
  if (e?.authenticationFailed === true) return "Yandex rejected authorization. Check IMAP is enabled and reconnect Yandex OAuth locally.";
  if (["ETIMEDOUT", "ETIMEOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED"].includes(String(e?.code))) {
    return "Yandex is temporarily unreachable. Check the connection and retry.";
  }
  return "Mailbox operation failed. Check the local KotMail connection; private error details were withheld.";
}
