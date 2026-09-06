import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type MessageStructureObject, type SearchObject } from "imapflow";
import { config } from "../config.js";
import { decodeMessageId, encodeMessageId } from "../domain/message-id.js";
import { loadCredentials, saveCredentials, type YandexCredentials } from "../storage/vault.js";
import { refreshAccessToken } from "./oauth.js";
import { bodyTextParts, isAttachment, parseTextPart } from "./body.js";
import { mailErrorMessage } from "../domain/errors.js";
import { recentInput, searchInput, type RecentInput, type SearchInput } from "../domain/contracts.js";

export type Address = { name?: string; address?: string };
export type AttachmentInfo = { part: string; filename?: string; contentType: string; size?: number };
export type MessageMetadata = {
  id: string;
  uid: number;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  date?: string;
  receivedAt?: string;
  messageId?: string;
  size?: number;
  seen: boolean;
  attachments: AttachmentInfo[];
};

export type MessageContent = MessageMetadata & {
  text: string;
  truncated: boolean;
  contentStatus: "text" | "no_text_body";
};

export type MailPage = { messages: MessageMetadata[]; hasMore: boolean; nextBeforeId?: string };

function addresses(values?: MessageAddressObject[]): Address[] {
  return (values ?? []).map(({ name, address }) => ({
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
  }));
}

function attachmentNodes(node?: MessageStructureObject): AttachmentInfo[] {
  if (!node) return [];
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (!isAttachment(node) || !node.part) return (node.childNodes ?? []).flatMap(attachmentNodes);
  return [{
    part: node.part,
    ...(filename ? { filename } : {}),
    contentType: node.type,
    ...(typeof node.size === "number" ? { size: node.size } : {}),
  }];
}

function metadata(message: FetchMessageObject, uidValidity: bigint): MessageMetadata {
  const envelope = message.envelope;
  return {
    id: encodeMessageId(uidValidity, message.uid),
    uid: message.uid,
    subject: envelope?.subject ?? "(без темы)",
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    cc: addresses(envelope?.cc),
    ...(envelope?.date ? { date: envelope.date.toISOString() } : {}),
    ...(message.internalDate ? { receivedAt: new Date(message.internalDate).toISOString() } : {}),
    ...(envelope?.messageId ? { messageId: envelope.messageId } : {}),
    ...(typeof message.size === "number" ? { size: message.size } : {}),
    seen: message.flags?.has("\\Seen") ?? false,
    attachments: attachmentNodes(message.bodyStructure),
  };
}

async function currentCredentials(): Promise<YandexCredentials> {
  let credentials = await loadCredentials();
  if (!credentials) throw new Error("Yandex mailbox is not connected. Run `npm run setup`.");
  if (credentials.expiresAt && credentials.expiresAt <= Date.now() + 60_000) {
    credentials = await refreshAccessToken(credentials);
    await saveCredentials(credentials);
  }
  return credentials;
}

async function withInbox<T>(operation: (client: ImapFlow, uidValidity: bigint) => Promise<T>): Promise<T> {
  const credentials = await currentCredentials();
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: credentials.email, accessToken: credentials.accessToken },
    logger: false,
    disableAutoIdle: true,
    maxResponseSize: 20 * 1024 * 1024,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableBinary: true,
  });
  // An EventEmitter error must not crash stdio or print a raw server response.
  client.on("error", () => client.close());
  let expired = false;
  const deadline = setTimeout(() => { expired = true; client.close(); }, 40_000);
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX", { readOnly: true });
    if (!client.mailbox) throw new Error("Yandex did not open INBOX");
    return await operation(client, client.mailbox.uidValidity);
  } catch (error) {
    if (expired) throw new Error("Mailbox request timed out");
    throw error;
  } finally {
    clearTimeout(deadline);
    lock?.release();
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      client.close();
    }
  }
}

export function describeImapError(error: unknown): string {
  return mailErrorMessage(error);
}

const metadataQuery = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
} as const;

export async function listRecent(input: RecentInput): Promise<MailPage> {
  return findPage(recentInput.parse(input));
}

export async function searchMail(input: SearchInput): Promise<MailPage> {
  return findPage(searchInput.parse(input));
}

async function findPage(input: RecentInput | SearchInput): Promise<MailPage> {
  const search = input as SearchInput;
  const pointer = input.beforeId ? decodeMessageId(input.beforeId) : undefined;
  return withInbox(async (client, uidValidity) => {
    const query: SearchObject = {};
    if (pointer) {
      if (pointer.uidValidity !== String(uidValidity)) throw new Error("Message id is stale; search for the message again");
      if (pointer.uid <= 1) return { messages: [], hasMore: false };
      query.uid = `1:${pointer.uid - 1}`;
    }
    if (search.from) query.from = search.from;
    if (search.subject) query.subject = search.subject;
    if (search.text) query.text = search.text;
    if (search.unread !== undefined) query.seen = !search.unread;
    // Date strings are IMAP calendar dates, not UTC instants shifted by the local timezone.
    if (search.after) query.since = search.after;
    if (search.before) query.before = search.before;
    if (Object.keys(query).length === 0) query.all = true;
    const found = await client.search(query, { uid: true });
    if (!found || found.length === 0) return { messages: [], hasMore: false };
    const selected = found.sort((a, b) => b - a).slice(0, input.limit);
    const messages = await client.fetchAll(selected, metadataQuery, { uid: true });
    const byUid = new Map(messages.map((message) => [message.uid, message]));
    const page = selected.flatMap((uid) => {
      const message = byUid.get(uid);
      return message ? [metadata(message, uidValidity)] : [];
    });
    const hasMore = found.length > selected.length;
    return { messages: page, hasMore,
      ...(hasMore ? { nextBeforeId: encodeMessageId(uidValidity, selected.at(-1)!) } : {}),
    };
  });
}

async function withMessage<T>(id: string, operation: (client: ImapFlow, message: FetchMessageObject, uidValidity: bigint) => Promise<T>): Promise<T> {
  const pointer = decodeMessageId(id);
  return withInbox(async (client, uidValidity) => {
    if (pointer.uidValidity !== String(uidValidity)) throw new Error("Message id is stale; search for the message again");
    const message = await client.fetchOne(pointer.uid, metadataQuery, { uid: true });
    if (!message) throw new Error("Message not found");
    return operation(client, message, uidValidity);
  });
}

export async function getMetadata(id: string): Promise<MessageMetadata> {
  return withMessage(id, async (_client, message, validity) => metadata(message, validity));
}

export async function getContent(id: string): Promise<MessageContent> {
  return withMessage(id, async (client, message, uidValidity) => {
    const parts = bodyTextParts(message.bodyStructure);
    let budget = config.maxMessageSourceBytes;
    let text = "";
    let truncated = parts.length > 8;
    for (const part of parts.slice(0, 8)) {
      if (budget <= 0 || text.length >= config.maxReturnedTextChars) { truncated = true; break; }
      const key = part === message.bodyStructure ? "text" : part.part;
      if (!key || !/^(text|\d+(\.\d+)*)$/.test(key)) throw new Error("Yandex did not return message content");
      const fetched = await client.fetchOne(message.uid, { bodyParts: [{ key, maxLength: budget + 1 }] }, { uid: true, binary: false });
      const raw = fetched && fetched.bodyParts?.get(key);
      if (!raw) throw new Error("Yandex did not return message content");
      truncated ||= raw.length > budget;
      const bounded = raw.subarray(0, budget);
      budget -= bounded.length;
      const piece = await parseTextPart(part, bounded);
      text += (text ? "\n\n" : "") + piece;
    }
    return { ...metadata(message, uidValidity), text: text.slice(0, config.maxReturnedTextChars),
      truncated: truncated || text.length > config.maxReturnedTextChars,
      contentStatus: parts.length ? "text" : "no_text_body",
    };
  });
}

export async function verifyImapConnection(): Promise<{ email: string; inboxMessages: number }> {
  const credentials = await currentCredentials();
  return withInbox(async (client) => ({
    email: credentials.email,
    inboxMessages: client.mailbox ? client.mailbox.exists : 0,
  }));
}
