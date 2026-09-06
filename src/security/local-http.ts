import type { IncomingHttpHeaders } from "node:http";

export function allowLocalRequest(method: string | undefined, headers: IncomingHttpHeaders, origin: string, csrf: string): boolean {
  if (headers.host !== new URL(origin).host) return false;
  if (headers.origin !== undefined && headers.origin !== origin) return false;
  if (method === "GET" || method === "HEAD") return headers["sec-fetch-site"] !== "cross-site" || headers["sec-fetch-mode"] === "navigate";
  return method === "POST" && headers.origin === origin &&
    headers["x-kotmail-csrf"] === csrf &&
    /^application\/json(?:;|$)/i.test(headers["content-type"] ?? "");
}
