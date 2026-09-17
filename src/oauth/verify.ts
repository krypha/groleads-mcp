import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { oauthConfig } from "./config.js";
import { parseScopes, type Scope } from "./scopes.js";
import { log } from "../log.js";

export type VerifiedToken = { subject: string; scopes: Scope[]; expiresAt: number };

let keySet: ReturnType<typeof createRemoteJWKSet> | undefined;
let keySetPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

async function discoverKeySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const config = oauthConfig();
  if (config.jwksUri) return createRemoteJWKSet(new URL(config.jwksUri));
  const discoveryBase = config.issuer.replace(/\/+$/, "");
  for (const suffix of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const response = await fetch(`${discoveryBase}${suffix}`, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const document = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (document.issuer !== config.issuer || typeof document.jwks_uri !== "string") continue;
      const jwks = new URL(document.jwks_uri);
      if (jwks.protocol !== "https:" && jwks.protocol !== "http:") continue;
      return createRemoteJWKSet(jwks);
    } catch (error) {
      log("warn", "OAuth discovery failed", { source: suffix, error });
    }
  }
  throw new Error("OAuth issuer did not publish a usable JWKS URI.");
}

async function keys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (keySet) return keySet;
  keySetPromise ??= discoverKeySet();
  try {
    keySet = await keySetPromise;
    return keySet;
  } catch (error) {
    keySetPromise = undefined;
    throw error;
  }
}

export function resetKeySet(): void {
  keySet = undefined;
  keySetPromise = undefined;
}

export function bearerFrom(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match?.[1];
}

export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  const config = oauthConfig();
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, await keys(), {
      issuer: config.issuer,
      audience: config.mcpResource,
      clockTolerance: config.clockTolerance,
    });
    payload = result.payload;
    // jose enforces exp and nbf only when present; this resource requires exp.
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new Error("Missing exp");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing sub");
  } catch (error) {
    log("warn", "Caller token verification failed", {
      reason: error instanceof Error ? `${error.name}: ${error.message}` : "unknown verification error",
    });
    throw new InvalidTokenError();
  }
  return {
    subject: payload.sub!,
    scopes: parseScopes(payload.scope ?? payload.scp),
    expiresAt: payload.exp! * 1000,
  };
}

export class InvalidTokenError extends Error {
  constructor() {
    super("Invalid token");
    this.name = "InvalidTokenError";
  }
}
