import { z } from "zod";
import { LIMITS } from "../policy.js";

export const messageId = z.string().min(20).max(1000);
const paging = {
  limit: z.number().int().min(1).max(LIMITS.recent.max).default(LIMITS.recent.default),
  beforeId: messageId.optional().describe("Для следующей страницы передайте nextBeforeId предыдущего ответа. Новые письма не сдвигают страницы."),
};
export const recentInput = z.strictObject(paging);
export const singleMessageInput = z.strictObject({ id: messageId });
export const searchInput = z.strictObject({
  ...paging,
  from: z.string().trim().min(1).max(320).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  text: z.string().trim().min(1).max(1000).optional().describe("Серверный поиск IMAP TEXT в заголовках и теле; не возвращает тело."),
  unread: z.boolean().optional().describe("true — только непрочитанные, false — только прочитанные."),
  after: z.string().date().optional().describe("Дата получения включительно, YYYY-MM-DD, календарный день IMAP."),
  before: z.string().date().optional().describe("Дата получения исключительно, YYYY-MM-DD, календарный день IMAP."),
}).refine(v => Boolean(v.from || v.subject || v.text || v.after || v.before || v.unread !== undefined), {
  message: "Нужен хотя бы один критерий поиска",
}).refine(v => !v.after || !v.before || v.after < v.before, {
  message: "after должна быть раньше before",
});

export type RecentInput = z.infer<typeof recentInput>;
export type SearchInput = z.infer<typeof searchInput>;
