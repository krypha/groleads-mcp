import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { oauthConfig } from "./config.js";
import { authorizationServerMetadata, AuthorizationServiceUnavailable, oauthEndpoint } from "./discovery.js";
import { parseScopes, type Scope } from "./scopes.js";
import { log } from "../log.js";

export type VerifiedToken = { subject: string; scopes: Scope[]; expiresAt: number };

let keySet: ReturnType<typeof createRemoteJWKSet> | undefined;
let keySetPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

async function discoverKeySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const config = oauthConfig();
  const uri = config.jwksUri ?? (await authorizationServerMetadata()).jwks_uri;
  return createRemoteJWKSet(oauthEndpoint(uri));
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
  const keySet = await keys(); // Discovery failure is a service error, not a bad caller token.
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, keySet, {
      issuer: config.issuer,
      audience: config.mcpResource,
      clockTolerance: config.clockTolerance,
    });
    payload = result.payload;
    // jose enforces exp and nbf only when present; this resource requires exp.
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new InvalidTokenError();
    if (typeof payload.sub !== "string" || !payload.sub) throw new InvalidTokenError();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const invalidTokenCodes = [
      "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_EXPIRED", "ERR_JWS_INVALID", "ERR_JWT_INVALID",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "ERR_JWKS_NO_MATCHING_KEY",
      "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JOSE_NOT_SUPPORTED",
    ];
    if (!(error instanceof InvalidTokenError) && !invalidTokenCodes.includes(String(code))) {
      resetKeySet();
      throw new AuthorizationServiceUnavailable();
    }
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
