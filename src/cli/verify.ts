import { loadCredentials } from "../storage/vault.js";
import { describeImapError, verifyImapConnection } from "../yandex/imap.js";

const credentials = await loadCredentials();
if (!credentials) {
  process.stderr.write("NOT READY: Yandex mailbox is not connected. Run `npm run setup`.\n");
  process.exitCode = 1;
} else {
  try {
    const result = await verifyImapConnection();
    process.stdout.write(`OK: readonly IMAP login succeeded; INBOX contains ${result.inboxMessages} message(s). Address withheld.\n`);
  } catch (error) {
    process.stderr.write(`FAILED: ${describeImapError(error)}\n`);
    process.exitCode = 1;
  }
}
