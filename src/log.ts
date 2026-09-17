import { inspect } from "node:util";

const SECRET_KEYS = new Set([
  "access_token", "refresh_token", "id_token", "subject_token", "actor_token",
  "token", "code", "authorization_code", "client_secret", "secret", "password",
  "authorization", "proxy-authorization", "www-authenticate", "cookie", "set-cookie",
  "code_verifier", "codeverifier", "code_challenge", "codechallenge", "assertion",
  "accesstoken", "refreshtoken", "idtoken", "subjecttoken", "clientsecret",
  "api_key", "apikey", "x-api-key", "x-magileads-api-key",
]);
const REDACTED = "[redacted]";
const BEARER = /\bBearer\s+\S+/gi;
const BASIC = /\bBasic\s+\S+/gi;
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const CREDENTIAL_QUERY = /([?&](?:code|access_token|refresh_token|token|id_token|code_verifier|code_challenge|client_secret|api_key)=)[^&\s"']+/gi;

export function redactString(value: string): string {
  const secret = process.env.OAUTH_INTERNAL_CLIENT_SECRET;
  const withoutKnownSecret = secret ? value.replaceAll(secret, REDACTED) : value;
  return withoutKnownSecret.replace(BEARER, `Bearer ${REDACTED}`)
    .replace(BASIC, `Basic ${REDACTED}`).replace(JWT, REDACTED)
    .replace(CREDENTIAL_QUERY, `$1${REDACTED}`);
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 10) return "[deep]";
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1, seen));
  const entries = value instanceof Error
    ? { name: value.name, message: value.message, cause: value.cause, ...Object.fromEntries(Object.entries(value)) }
    : value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return out;
}

export function log(level: "debug" | "info" | "warn" | "error", message: string, context?: unknown): void {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const record = { at: new Date().toISOString(), level, message: redactString(message), context: redact(context) };
  // stdio reserves stdout for JSON-RPC.
  process.stderr.write(`${inspect(record, { depth: 12, breakLength: Infinity })}\n`);
}
