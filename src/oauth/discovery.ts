import { oauthConfig } from "./config.js";

export type AuthorizationServerMetadata = {
  issuer: string;
  jwks_uri: string;
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
};

export class AuthorizationServiceUnavailable extends Error {
  constructor(public readonly retryAfter?: string) {
    super("Authorization service unavailable.");
    this.name = "AuthorizationServiceUnavailable";
  }
}

/** Only forward the documented seconds form, never arbitrary upstream headers. */
export function retryAfterSeconds(response: Response): string | undefined {
  const value = response.headers.get("retry-after");
  return value && /^[1-9]\d{0,5}$/.test(value) && Number(value) <= 86400 ? value : undefined;
}

/** Credentials and signing keys may only travel over TLS (except local tests). */
export function oauthEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.hash) {
    throw new Error("OAuth endpoints require HTTPS, with no URL credentials or fragment.");
  }
  return url;
}

export function discoveryUrls(issuer: string): string[] {
  const url = oauthEndpoint(issuer);
  if (url.search) throw new Error("OAuth issuer must not contain a query.");
  // RFC 8414 inserts the well-known segment before an issuer's path.
  const path = url.pathname.replace(/\/+$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  ];
}

let pending: Promise<AuthorizationServerMetadata> | undefined;
let expiresAt = 0;

export async function discoverAuthorizationServer(issuer: string): Promise<AuthorizationServerMetadata> {
  for (const endpoint of discoveryUrls(issuer)) {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (response.status === 404 || response.status === 405) continue;
    if (!response.ok) throw new AuthorizationServiceUnavailable(retryAfterSeconds(response));
    const document = await response.json() as Record<string, unknown> | null;
    if (!document || document.issuer !== issuer ||
        typeof document.jwks_uri !== "string" || typeof document.token_endpoint !== "string") {
      throw new AuthorizationServiceUnavailable();
    }
    oauthEndpoint(document.jwks_uri);
    oauthEndpoint(document.token_endpoint);
    const authMethods = document.token_endpoint_auth_methods_supported;
    if (authMethods !== undefined &&
        (!Array.isArray(authMethods) || !authMethods.every((method) => typeof method === "string"))) {
      throw new AuthorizationServiceUnavailable();
    }
    return {
      issuer: document.issuer,
      jwks_uri: document.jwks_uri,
      token_endpoint: document.token_endpoint,
      token_endpoint_auth_methods_supported: authMethods as string[] | undefined,
    };
  }
  throw new AuthorizationServiceUnavailable();
}

export async function authorizationServerMetadata(): Promise<AuthorizationServerMetadata> {
  if (Date.now() >= expiresAt) pending = undefined;
  if (!pending) {
    expiresAt = Date.now() + 5 * 60_000;
    pending = discoverAuthorizationServer(oauthConfig().issuer);
  }
  try {
    return await pending;
  } catch (error) {
    pending = undefined; // An outage must not poison discovery until restart.
    if (error instanceof AuthorizationServiceUnavailable) throw error;
    throw new AuthorizationServiceUnavailable();
  }
}

export function resetDiscovery(): void {
  pending = undefined;
  expiresAt = 0;
}
