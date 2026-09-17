import { createHash } from "node:crypto";
import { oauthConfig } from "./config.js";
import type { Scope } from "./scopes.js";
import { log } from "../log.js";

type Cached = { accessToken: string; expiresAt: number };
const cache = new Map<string, Cached>();
const EARLY_MS = 60_000;

export class ReauthenticationRequired extends Error {
  constructor() {
    super("Authorization required.");
    this.name = "ReauthenticationRequired";
  }
}

export function clearExchangeCache(): void {
  cache.clear();
}

function cacheKey(subjectToken: string, scope: Scope): string {
  return createHash("sha256").update(scope).update("\0").update(subjectToken).digest("base64url");
}

export function invalidateExchange(subjectToken: string, scope: Scope): void {
  cache.delete(cacheKey(subjectToken, scope));
}

export async function exchangeToken(subjectToken: string, scope: Scope): Promise<string> {
  const key = cacheKey(subjectToken, scope);
  const cached = cache.get(key);
  if (cached && cached.expiresAt - EARLY_MS > Date.now()) return cached.accessToken;
  cache.delete(key);

  const config = oauthConfig();
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    resource: config.apiResource,
    scope,
  });
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch(`${config.apiUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown;
  };
  const knownOAuthErrors = new Set([
    "invalid_grant", "invalid_client", "invalid_request", "unauthorized_client",
    "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable",
  ]);
  const safeError = typeof payload.error === "string" && knownOAuthErrors.has(payload.error)
    ? payload.error : "other";
  if (response.status === 401 || payload.error === "invalid_grant") {
    log("info", "Token exchange requires reauthorization", { status: response.status, oauth_error: safeError });
    throw new ReauthenticationRequired();
  }
  if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
    log("error", "Token exchange failed", { status: response.status, oauth_error: safeError });
    throw new Error("Token exchange failed.");
  }
  // The authorization server must not silently grant a broader or different scope.
  if (typeof payload.scope === "string" && payload.scope.trim() !== scope) {
    log("error", "Token exchange returned an unexpected scope");
    throw new Error("Token exchange returned an unexpected scope.");
  }
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? Math.max(0, payload.expires_in) : 300;
  const entry = { accessToken: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  cache.set(key, entry);
  const timer = setTimeout(() => {
    if (cache.get(key) === entry) cache.delete(key);
  }, Math.max(0, expiresIn * 1000 - EARLY_MS));
  timer.unref();
  return payload.access_token;
}
