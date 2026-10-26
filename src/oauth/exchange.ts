import { createHash } from "node:crypto";
import { oauthConfig } from "./config.js";
import { authorizationServerMetadata, AuthorizationServiceUnavailable, retryAfterSeconds } from "./discovery.js";
import { SCOPES, type Scope } from "./scopes.js";
import { log } from "../log.js";
import { basicClientAuthorization, ReauthenticationRequired } from "./client.js";
import { AccountContextError, isAccountRequestError, type AccountContext } from "./account-context.js";
export { basicClientAuthorization, ReauthenticationRequired } from "./client.js";

type Cached = { accessToken: string; expiresAt: number };
const cache = new Map<string, Cached>();
const EARLY_MS = 60_000;
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export function clearExchangeCache(): void {
  cache.clear();
}

function scopeValue(scopes: readonly Scope[]): string {
  const value = SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
  if (!value) throw new Error("Token exchange requires at least one scope.");
  return value;
}

function cacheKey(subjectToken: string, scopes: readonly Scope[]): string {
  return createHash("sha256").update(scopeValue(scopes)).update("\0").update(subjectToken).digest("base64url");
}

export function invalidateExchange(subjectToken: string, scopes: readonly Scope[]): void {
  cache.delete(cacheKey(subjectToken, scopes));
}

export async function exchangeToken(subjectToken: string, scopes: readonly Scope[], account?: { context: AccountContext; resource: string }): Promise<string> {
  const requestedScope = scopeValue(scopes);
  const key = cacheKey(subjectToken, scopes);
  const cached = cache.get(key);
  if (!account && cached && cached.expiresAt - EARLY_MS > Date.now()) return cached.accessToken;
  cache.delete(key);

  const config = oauthConfig();
  const metadata = await authorizationServerMetadata();
  if (account && new URL(metadata.token_endpoint).origin !== new URL(config.issuer).origin) {
    throw new AccountContextError("invalid_target");
  }
  if (metadata.token_endpoint_auth_methods_supported &&
      !metadata.token_endpoint_auth_methods_supported.includes("client_secret_basic")) {
    throw new Error("The OAuth issuer does not support client_secret_basic.");
  }
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    resource: config.apiResource,
    scope: requestedScope,
  });
  if (account) {
    body.set("account_context_revision", account.context.revision);
    body.set("mcp_resource", account.resource);
  }
  let response: Response;
  try {
    response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: basicClientAuthorization(config.clientId, config.clientSecret),
      },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: "error", // Never follow a redirect carrying the internal secret or caller bearer.
    });
  } catch {
    throw new AuthorizationServiceUnavailable();
  }
  const payload = await response.json().catch(() => ({})) as {
    access_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown;
    token_type?: unknown; issued_token_type?: unknown;
    account_context_revision?: unknown; actor_user_id?: unknown; effective_user_id?: unknown;
  } | null;
  const knownOAuthErrors = new Set([
    "invalid_grant", "invalid_client", "invalid_request", "unauthorized_client",
    "unsupported_grant_type", "invalid_scope", "server_error", "temporarily_unavailable",
  ]);
  const safeError = typeof payload?.error === "string" && knownOAuthErrors.has(payload.error)
    ? payload.error : "other";
  if (response.status === 429 || response.status >= 500) {
    throw new AuthorizationServiceUnavailable(retryAfterSeconds(response));
  }
  // Magileads documents HTTP 401 as failed INTERNAL client authentication.
  // Reconnecting the user's account cannot repair that deployment error.
  if (response.status === 400 && payload?.error === "invalid_grant") {
    log("info", "Token exchange requires reauthorization", { status: response.status, oauth_error: safeError });
    throw new ReauthenticationRequired();
  }
  if (account && payload?.error !== "invalid_client" && isAccountRequestError(payload?.error) && !response.ok) throw new AccountContextError(payload.error);
  if (!response.ok || !payload || typeof payload.access_token !== "string" || !payload.access_token) {
    log("error", "Token exchange failed", { status: response.status, oauth_error: safeError });
    throw new Error("Token exchange failed.");
  }
  if (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      (payload.issued_token_type !== undefined && payload.issued_token_type !== ACCESS_TOKEN_TYPE) ||
      typeof payload.expires_in !== "number" || !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 0 ||
      (account !== undefined && payload.expires_in > 300) ||
      (payload.scope !== undefined && typeof payload.scope !== "string")) {
    throw new Error("Token exchange returned an invalid access-token response.");
  }
  // The authorization server must not silently grant a broader or different scope.
  const returnedScopes = typeof payload.scope === "string" ? payload.scope.trim().split(/\s+/) : undefined;
  if (returnedScopes &&
      (new Set(returnedScopes).size !== requestedScope.split(" ").length ||
       requestedScope.split(" ").some((scope) => !returnedScopes.includes(scope)))) {
    log("error", "Token exchange returned an unexpected scope");
    throw new Error("Token exchange returned an unexpected scope.");
  }
  if (account) {
    if (payload.account_context_revision !== account.context.revision ||
        payload.actor_user_id !== account.context.original_account.id ||
        payload.effective_user_id !== account.context.active_account.id) {
      throw new AccountContextError("exchange_account_mismatch");
    }
    // Reauthorize the persisted selection on every call. Never reuse a token
    // across a switch, revocation, domain, or original grant.
    return payload.access_token;
  }
  const expiresIn = payload.expires_in;
  const entry = { accessToken: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  cache.set(key, entry);
  const timer = setTimeout(() => {
    if (cache.get(key) === entry) cache.delete(key);
  }, Math.min(2_147_483_647, Math.max(0, expiresIn * 1000 - EARLY_MS)));
  timer.unref();
  return payload.access_token;
}
