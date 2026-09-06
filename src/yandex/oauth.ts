import type { YandexCredentials } from "../storage/vault.js";

const DEVICE_CODE_URL = "https://oauth.yandex.ru/device/code";
const TOKEN_URL = "https://oauth.yandex.ru/token";
const USER_INFO_URL = "https://login.yandex.ru/info?format=json";
const REQUESTED_SCOPES = ["mail:imap_ro", "login:email"] as const;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

async function postForm(url: string, values: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok && typeof body.error !== "string") throw new Error(`Yandex OAuth returned HTTP ${response.status}`);
  return body;
}

export async function requestDeviceAuthorization(clientId: string): Promise<DeviceAuthorization> {
  const body = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: REQUESTED_SCOPES.join(" "),
  });
  if (
    typeof body.device_code !== "string" || typeof body.user_code !== "string" ||
    typeof body.verification_url !== "string" || typeof body.expires_in !== "number"
  ) throw new Error("Unexpected response from Yandex device authorization");
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url,
    intervalSeconds: typeof body.interval === "number" ? Math.max(body.interval, 5) : 5,
    expiresInSeconds: body.expires_in,
  };
}

type TokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope: string[];
};

function parseToken(body: Record<string, unknown>): TokenResult {
  if (typeof body.access_token !== "string") throw new Error("Yandex did not return an access token");
  const expiresAt = typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined;
  const scope = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [...REQUESTED_SCOPES];
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scope,
  };
}

export async function pollDeviceToken(
  clientId: string,
  clientSecret: string,
  authorization: DeviceAuthorization,
): Promise<TokenResult> {
  const deadline = Date.now() + authorization.expiresInSeconds * 1000;
  let interval = authorization.intervalSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const body = await postForm(TOKEN_URL, {
      grant_type: "device_code",
      code: authorization.deviceCode,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") { interval += 5_000; continue; }
    if (typeof body.error === "string") throw new Error(`Yandex OAuth rejected authorization: ${body.error}`);
    return parseToken(body);
  }
  throw new Error("Yandex authorization expired before consent was completed");
}

export async function refreshAccessToken(credentials: YandexCredentials): Promise<YandexCredentials> {
  if (!credentials.refreshToken) throw new Error("Yandex token expired and no refresh token is available");
  const body = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  if (typeof body.error === "string") throw new Error(`Yandex OAuth refresh failed: ${body.error}`);
  const token = parseToken(body);
  return {
    ...credentials,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? credentials.refreshToken,
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    scope: token.scope,
  };
}

export async function fetchYandexEmail(accessToken: string): Promise<string> {
  const response = await fetch(USER_INFO_URL, {
    headers: { authorization: `OAuth ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Yandex ID returned HTTP ${response.status}`);
  const body = await response.json() as { default_email?: unknown; emails?: unknown };
  if (typeof body.default_email === "string" && body.default_email.includes("@")) return body.default_email;
  if (Array.isArray(body.emails) && typeof body.emails[0] === "string") return body.emails[0];
  throw new Error("Yandex ID did not return a mailbox email; add login:email permission");
}
