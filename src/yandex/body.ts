import type { MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";

export function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition?.toLowerCase() === "attachment" ||
    Boolean(node.dispositionParameters?.filename || node.parameters?.name) ||
    node.type.toLowerCase() === "message/rfc822";
}

// Follow MIME alternatives/related roots; never descend into attached messages or files.
export function bodyTextParts(node?: MessageStructureObject): MessageStructureObject[] {
  if (!node || isAttachment(node)) return [];
  const type = node.type.toLowerCase();
  if (type === "text/plain" || type === "text/html") return [node];
  const children = node.childNodes ?? [];
  if (type === "multipart/alternative") {
    const alternatives = children.map(bodyTextParts).filter(parts => parts.length);
    return alternatives.find(parts => parts.some(part => part.type.toLowerCase() === "text/plain")) ?? alternatives[0] ?? [];
  }
  if (type === "multipart/related") {
    const start = node.parameters?.start;
    return bodyTextParts(children.find(child => start && child.id === start) ?? children[0]);
  }
  return type.startsWith("multipart/") ? children.flatMap(bodyTextParts) : [];
}

export async function parseTextPart(node: MessageStructureObject, raw: Buffer): Promise<string> {
  const type = node.type.toLowerCase();
  if (type !== "text/plain" && type !== "text/html") throw new Error("Unsupported text part");
  // Only allow MIME parameter values, not arbitrary header text supplied by a sender.
  const charset = node.parameters?.charset;
  const encoding = node.encoding?.toLowerCase();
  const parameters = charset && /^[a-z0-9._-]{1,80}$/i.test(charset) ? `; charset="${charset}"` : "; charset=utf-8";
  const transfer = encoding && ["base64", "quoted-printable", "7bit", "8bit", "binary"].includes(encoding) ? encoding : "8bit";
  const flowed = type === "text/plain" && node.parameters?.format?.toLowerCase() === "flowed"
    ? `; format=flowed${node.parameters?.delsp?.toLowerCase() === "yes" ? "; delsp=yes" : ""}` : "";
  const header = `Content-Type: ${type}${parameters}${flowed}\r\nContent-Transfer-Encoding: ${transfer}\r\n\r\n`;
  const parsed = await simpleParser(Buffer.concat([Buffer.from(header), raw]), {
    skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true,
    maxHtmlLengthToParse: 1_000_000,
  });
  return (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
}
