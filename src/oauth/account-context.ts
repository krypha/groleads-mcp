import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { oauthConfig } from "./config.js";
import { oauthEndpoint, AuthorizationServiceUnavailable, retryAfterSeconds } from "./discovery.js";
import { basicClientAuthorization, ReauthenticationRequired } from "./client.js";

const identitySchema = z.object({
  id: z.number().int().positive().safe(),
  first_name: z.string().max(256),
  last_name: z.string().max(256),
});
export const revisionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const contextSchema = z.object({
  revision: revisionSchema,
  original_account: identitySchema,
  active_account: identitySchema,
  is_switched: z.boolean(),
}).refine((value) => value.is_switched === (value.original_account.id !== value.active_account.id));
export type AccountContext = z.infer<typeof contextSchema>;

export class AccountContextError extends Error {
  constructor(public readonly code: string) {
    // Do not reflect upstream descriptions, request bodies, or tokens.
    const reason = {
      delegation_expired: "The temporary account delegation has expired (60 minutes after selection). Offer an explicitly confirmed new selection or return to the original account; never renew automatically.",
      account_context_changed: "The account context changed. Read get_active_account and obtain a new confirmation before any write.",
      delegation_denied: "The actor, target, internal client or MCP resource is not authorized for this delegation.",
      target_unavailable: "The selected account is unavailable. Offer an explicit return to the original account.",
      invalid_client: "Internal OAuth client authentication failed. Check server configuration; reconnecting the user's account cannot repair it.",
      invalid_target: "The MCP resource is invalid or unauthorized. Check the exact domain and the internal client's resource authorization.",
      invalid_request: "The private OAuth account request was rejected. Check the server integration parameters.",
    }[code];
    super(`Account operation refused (${code}). ${reason ?? "Check the active account or the server integration."} Keep the original OAuth connection. No automatic retry or fallback was performed.`);
    this.name = "AccountContextError";
  }
}

const delegationErrors = new Set([
  "account_context_changed", "delegation_denied", "delegation_expired", "target_unavailable",
]);
export function isDelegationError(code: unknown): code is string {
  return typeof code === "string" && delegationErrors.has(code);
}
export function isAccountRequestError(code: unknown): code is string {
  return isDelegationError(code) || code === "invalid_client" || code === "invalid_target" || code === "invalid_request";
}

/** Private control-plane calls only, bound to the validated issuer and MCP resource. */
async function control(
  subjectToken: string, resource: string, path: "/oauth/mcp/account-context" | "/oauth/mcp/switchable-accounts",
  method: "POST" | "PUT", fields: Record<string, unknown> = {},
): Promise<unknown> {
  const config = oauthConfig();
  const endpoint = oauthEndpoint(new URL(path, config.issuer).href);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: {
        Authorization: basicClientAuthorization(config.clientId, config.clientSecret),
        "Content-Type": "application/json", Accept: "application/json",
      },
      body: JSON.stringify({ ...fields, subject_token: subjectToken, resource }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new AuthorizationServiceUnavailable(); }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    throw new AuthorizationServiceUnavailable(retryAfterSeconds(response));
  }
  // Bound the response even if the peer omits or lies about Content-Length.
  let length = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  try {
    if (!reader) throw new Error();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 256 * 1024) throw new Error();
      chunks.push(item.value);
    }
  } catch {
    await reader?.cancel().catch(() => {});
    throw new AuthorizationServiceUnavailable();
  } finally { reader?.releaseLock(); }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AccountContextError("invalid_control_response"); }
  const data = payload as { state?: unknown; error?: unknown } | null;
  // 401 is reserved for INTERNAL Basic failure. Only this explicit subject error
  // can ask the end user to reconnect; target/delegation errors must never do so.
  if (response.status === 400 && data?.error === "invalid_subject_token") throw new ReauthenticationRequired();
  if (!response.ok || data?.state !== true) {
    throw new AccountContextError(isAccountRequestError(data?.error) ? data.error : "control_service_rejected");
  }
  return payload;
}

function parseContext(payload: unknown): AccountContext {
  const parsed = z.object({ state: z.literal(true), context: contextSchema }).safeParse(payload);
  if (!parsed.success) throw new AccountContextError("invalid_control_response");
  return parsed.data.context;
}

export type AccountSession = {
  context: AccountContext;
  selectionUncertain?: boolean;
  reauthenticationRequired?: boolean;
  listAccounts: (input: { search?: string; cursor?: string; limit?: number }) => Promise<unknown>;
  changeAccount: (targetUserId: number | null, expectedRevision: string) => Promise<AccountContext>;
};

/** No process-wide active account: persistence and authorization belong to the API. */
export async function loadAccountSession(subjectToken: string, resource: string): Promise<AccountSession> {
  const context = parseContext(await control(subjectToken, resource, "/oauth/mcp/account-context", "POST"));
  const request = async (path: "/oauth/mcp/account-context" | "/oauth/mcp/switchable-accounts", method: "POST" | "PUT", fields: Record<string, unknown>) => {
    try { return await control(subjectToken, resource, path, method, fields); }
    catch (error) {
      if (error instanceof ReauthenticationRequired) session.reauthenticationRequired = true;
      throw error;
    }
  };
  const session: AccountSession = {
    context,
    async listAccounts(input) {
      const payload = await request("/oauth/mcp/switchable-accounts", "POST", input);
      const parsed = z.object({
        state: z.literal(true), accounts: z.array(identitySchema).max(100),
        next_cursor: z.string().min(1).max(512).nullable(),
      }).safeParse(payload);
      if (!parsed.success) throw new AccountContextError("invalid_control_response");
      return parsed.data;
    },
    async changeAccount(targetUserId, expectedRevision) {
      assertAccountRevision(session.context, expectedRevision);
      // A timeout/5xx can occur after the API committed the switch. Until we
      // receive and validate its reply, do not present the old identity as current.
      session.selectionUncertain = true;
      const next = parseContext(await request("/oauth/mcp/account-context", "PUT", {
        expected_revision: expectedRevision, target_user_id: targetUserId,
      }));
      if (next.original_account.id !== context.original_account.id ||
          next.active_account.id !== (targetUserId ?? context.original_account.id) || next.revision === expectedRevision) {
        throw new AccountContextError("invalid_control_response");
      }
      session.context = next;
      session.selectionUncertain = false;
      return next;
    },
  };
  return session;
}

const sessions = new AsyncLocalStorage<AccountSession | undefined>();
export function runWithAccountSession<T>(session: AccountSession | undefined, action: () => T): T {
  return sessions.run(session, action);
}
export function currentAccountSession(): AccountSession | undefined { return sessions.getStore(); }
export function accountContextForResult(session = currentAccountSession()): AccountContext | (AccountContext & { selection_status: "unknown_after_change" }) | undefined {
  return session?.selectionUncertain
    ? { ...session.context, selection_status: "unknown_after_change" as const } : session?.context;
}
export function requireAccountSession(): AccountSession {
  const session = currentAccountSession();
  if (!session) throw new AccountContextError("switching_unavailable");
  return session;
}
export function assertAccountRevision(context: AccountContext, revision: unknown): void {
  if (revision !== context.revision) throw new AccountContextError("account_context_changed");
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };
/** Safe identity only: private credentials never appear in a tool response. */
export function withAccountContext<T extends TextResult>(result: T, context?: AccountContext): T {
  if (!context) return result;
  const content = [...result.content];
  try {
    const data: unknown = JSON.parse(content[0]?.text ?? "");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    content[0] = { type: "text", text: JSON.stringify({ ...data, account_context: context }, null, 2) };
  } catch {
    // Idempotent when HTTP also decorates SDK validation errors after dispatch.
    const index = content.findIndex((item) => {
      try {
        const value = JSON.parse(item.text) as Record<string, unknown>;
        return value && Object.keys(value).length === 1 && "account_context" in value;
      } catch { return false; }
    });
    const item = { type: "text" as const, text: JSON.stringify({ account_context: context }) };
    if (index >= 0) content[index] = item;
    else content.push(item);
  }
  return { ...result, content };
}
