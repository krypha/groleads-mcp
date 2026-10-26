import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AccountContext } from "../src/oauth/account-context.js";
import { CALLABLE_ENDPOINTS, matchEndpoint } from "../src/endpoints.js";
import { ACCOUNT_SWITCHING_GUIDANCE, CREATION_GUIDANCE } from "../src/instructions.js";

async function start(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "smoke-key", alg: "RS256", use: "sig" };
let issuer = "";
let apiOrigin = "";
let exchangeMode: "normal" | "invalid_grant" | "unauthorized" | "reordered_scopes" | "broader_scopes" |
  "unavailable" | "rate_limited" | "invalid_type" | "invalid_issued_type" | "missing_expires" |
  "expired" | "invalid_scope_type" | "omitted_optional" | "redirect" | "excessive_lifetime" | "invalid_target" | "invalid_request" = "normal";
let discoveryMode: "normal" | "unavailable" | "not_found" | "mismatched_issuer" | "unsafe_endpoint" | "oidc_only" | "other_token_origin" = "normal";
let jwksUnavailable = false;
let apiMode: "normal" | "unauthorized" | "forbidden" = "normal";
let privateResourcesMode: "normal" | "redirect" = "normal";
const privateDiscoveryHeaders: string[] = [];
let leakedPrivateDiscovery = 0;
const resellerResource = "https://mcp-engage.lebonlogiciel.com/mcp";
const otherResellerResource = "https://mcp.surleads.com/mcp";
const exchanges: {
  subject: string; scope: string; resource: string; authorization: string;
  grant: string; subjectType: string; requestedType: string; contentType: string;
}[] = [];
const apiBearers: string[] = [];
const apiKeys: string[] = [];
const businessCalls: { method: string; path: string; bearer: string; body?: unknown }[] = [];
const accountContexts = new Map<string, AccountContext>();
const delegationDeadlines = new Map<string, number>();
let accountClock = 0; // Fake API time only; never alters HTTP/JWT timers.
let accountResourceAllowed = true;
let accountTargetState: "available" | "unavailable" | "denied" = "available";
const delegatedTokens = new Map<string, { context: AccountContext; key: string; scopes: string }>();
const accountControlCalls: { path: string; method: string; authorization: string; body: Record<string, unknown> }[] = [];
const accountCursors = new Map<string, { key: string; search: string }>();
let accountControlMode: "normal" | "unavailable" | "invalid_client" | "invalid_subject_token" | "malformed" | "redirect" = "normal";
let accountExchangeMode: "normal" | "missing_binding" | "wrong_actor" | "wrong_target" | "wrong_revision" | "race" | "expired" = "normal";
let accountMutationFailure: "none" | "lost_response" | "invalid_subject_token" = "none";
function accountKey(subjectToken: string, resource: string): string {
  const claims = decodeJwt(subjectToken);
  return JSON.stringify([claims.iss, claims.sub, claims.grant_id ?? claims.jti, resource]);
}
function fixtureContext(subjectToken: string, resource: string): AccountContext {
  const key = accountKey(subjectToken, resource);
  let context = accountContexts.get(key);
  if (!context) {
    const id = decodeJwt(subjectToken).sub === "user-8" ? 8 : 7;
    const original = { id, first_name: "Original", last_name: `User${id}` };
    context = { revision: crypto.randomUUID(), original_account: original, active_account: original, is_switched: false };
    accountContexts.set(key, context);
  }
  return context;
}

function hasExchangedScope(req: http.IncomingMessage, scope: string): boolean {
  const bearer = req.headers.authorization;
  const delegated = delegatedTokens.get(bearer || "");
  if (delegated) return delegated.scopes.split(" ").includes(scope);
  if (typeof bearer !== "string" || !bearer.startsWith("Bearer exchanged-")) return false;
  return bearer.slice("Bearer exchanged-".length).replaceAll("+", " ").split(" ").includes(scope);
}

// Authorization and business API live on DIFFERENT origins. The MCP must use
// the discovered token_endpoint, not assume it lives at the business API base.
const authorization = await start(async (req, res) => {
  if (["/oauth/mcp/account-context", "/oauth/mcp/switchable-accounts"].includes(req.url || "")) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    accountControlCalls.push({ path: req.url!, method: req.method!, authorization: req.headers.authorization || "", body });
    const permittedFields = new Set(["subject_token", "resource", ...(req.url === "/oauth/mcp/switchable-accounts" ? ["search", "limit", "cursor"] : req.method === "PUT" ? ["expected_revision", "target_user_id"] : [])]);
    if (Object.keys(body).some((field) => !permittedFields.has(field))) return respond(res, 400, { error: "invalid_request" });
    if (req.headers.authorization !== basicClientAuthorization(process.env.OAUTH_INTERNAL_CLIENT_ID!, process.env.OAUTH_INTERNAL_CLIENT_SECRET!) || accountControlMode === "invalid_client") {
      return respond(res, 401, { error: "invalid_client", error_description: `must not leak ${body.subject_token}` });
    }
    if (accountControlMode === "unavailable") return respond(res, 503, {});
    if (accountControlMode === "invalid_subject_token") return respond(res, 400, { error: "invalid_subject_token" });
    if (accountControlMode === "malformed") return respond(res, 200, { state: true, context: {} });
    if (accountControlMode === "redirect") {
      res.writeHead(307, { Location: `${apiOrigin}/private-discovery-leak` });
      return res.end();
    }
    if (!accountResourceAllowed) return respond(res, 403, { error: "delegation_denied" });
    const claims = decodeJwt(String(body.subject_token));
    if (claims.aud !== body.resource) return respond(res, 400, { error: "invalid_target" });
    const scopes = String(claims.scope).split(" ");
    const needed = req.url === "/oauth/mcp/switchable-accounts" ? "mcp:read" : req.method === "PUT" ? "mcp:write" : undefined;
    if (needed && !scopes.includes(needed)) return respond(res, 403, { error: "insufficient_scope" });
    const context = fixtureContext(String(body.subject_token), String(body.resource));
    if (req.url === "/oauth/mcp/switchable-accounts") {
      const key = accountKey(String(body.subject_token), String(body.resource));
      const search = typeof body.search === "string" ? body.search : "";
      let offset = 0;
      if (body.cursor) {
        const saved = accountCursors.get(String(body.cursor));
        if (!saved || saved.key !== key || saved.search !== search) return respond(res, 400, { error: "invalid_request" });
        offset = 1;
      }
      const choices = [{ id: 42, first_name: "Target", last_name: "User" }, { id: 43, first_name: "Target", last_name: "Second" }]
        .filter((item) => `${item.first_name} ${item.last_name}`.toLowerCase().includes(search.toLowerCase()));
      const limit = typeof body.limit === "number" ? body.limit : 25;
      const nextCursor = choices.length > offset + limit ? crypto.randomUUID() : null;
      if (nextCursor) accountCursors.set(nextCursor, { key, search });
      return respond(res, 200, { state: true, accounts: choices.slice(offset, offset + limit), next_cursor: nextCursor });
    }
    if (req.method === "PUT") {
      if (accountMutationFailure === "invalid_subject_token") return respond(res, 400, { error: "invalid_subject_token" });
      if (body.expected_revision !== context.revision) return respond(res, 409, { error: "account_context_changed" });
      if (body.target_user_id !== null && body.target_user_id !== 42) return respond(res, 403, { error: "delegation_denied" });
      if (body.target_user_id !== null && accountTargetState !== "available") return respond(res, 403, { error: accountTargetState === "unavailable" ? "target_unavailable" : "delegation_denied" });
      const next = { ...context, revision: crypto.randomUUID(), is_switched: body.target_user_id !== null,
        active_account: body.target_user_id === null ? context.original_account : { id: 42, first_name: "Target", last_name: "User" } };
      accountContexts.set(accountKey(String(body.subject_token), String(body.resource)), next);
      delegationDeadlines.set(accountKey(String(body.subject_token), String(body.resource)), accountClock + 60 * 60_000);
      if (accountMutationFailure === "lost_response") return respond(res, 503, {});
      return respond(res, 200, { state: true, context: next });
    }
    return respond(res, 200, { state: true, context });
  }
  if (req.url === "/oauth/mcp-resources" && req.method === "GET") {
    privateDiscoveryHeaders.push(req.headers.authorization || "");
    if (req.headers.authorization !== basicClientAuthorization(process.env.OAUTH_INTERNAL_CLIENT_ID!, process.env.OAUTH_INTERNAL_CLIENT_SECRET!)) {
      return respond(res, 401, { error: "invalid_client" });
    }
    if (privateResourcesMode === "redirect") {
      res.writeHead(307, { Location: `${apiOrigin}/private-discovery-leak` });
      return res.end();
    }
    return respond(res, 200, { state: true, resources: [process.env.OAUTH_MCP_RESOURCE, resellerResource, otherResellerResource] });
  }
  if (req.url === "/.well-known/oauth-authorization-server/tenant" ||
      req.url === "/tenant/.well-known/openid-configuration") {
    if (discoveryMode === "not_found" || (discoveryMode === "oidc_only" &&
        req.url === "/.well-known/oauth-authorization-server/tenant")) return respond(res, 404, {});
    if (discoveryMode === "unavailable") {
      res.setHeader("Retry-After", "10");
      return respond(res, 503, { error: "temporarily_unavailable" });
    }
    return respond(res, 200, {
      issuer: discoveryMode === "mismatched_issuer" ? `${issuer}/wrong` : issuer,
      jwks_uri: `${new URL(issuer).origin}/oauth/jwks.json`,
      token_endpoint: discoveryMode === "unsafe_endpoint" ? "http://untrusted.example/oauth/token" : `${discoveryMode === "other_token_origin" ? apiOrigin : new URL(issuer).origin}/oauth/token`,
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    });
  }
  if (req.url === "/oauth/jwks.json") {
    return respond(res, jwksUnavailable ? 503 : 200, jwksUnavailable ? {} : { keys: [jwk] });
  }
  if (req.url === "/oauth/token" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    exchanges.push({
      subject: body.get("subject_token") || "",
      scope: body.get("scope") || "",
      resource: body.get("resource") || "",
      authorization: req.headers.authorization || "",
      grant: body.get("grant_type") || "",
      subjectType: body.get("subject_token_type") || "",
      requestedType: body.get("requested_token_type") || "",
      contentType: req.headers["content-type"] || "",
    });
    if (exchangeMode === "invalid_grant") return respond(res, 400, { error: "invalid_grant" });
    if (exchangeMode === "invalid_target" || exchangeMode === "invalid_request") return respond(res, 400, { error: exchangeMode });
    if (exchangeMode === "unauthorized") return respond(res, 401, { error: "invalid_client" });
    if (exchangeMode === "unavailable" || exchangeMode === "rate_limited") {
      res.setHeader("Retry-After", "10");
      return respond(res, exchangeMode === "rate_limited" ? 429 : 503, { error: "temporarily_unavailable" });
    }
    if (exchangeMode === "redirect") {
      res.writeHead(307, { Location: `${apiOrigin}/oauth/token` });
      return res.end();
    }
    const requestedScope = body.get("scope") || "";
    const responseScope = exchangeMode === "reordered_scopes"
      ? requestedScope.split(" ").reverse().join(" ")
      : exchangeMode === "broader_scopes" ? `${requestedScope} unrelated:scope` : requestedScope;
    const payload: Record<string, unknown> = {
      access_token: `exchanged-${requestedScope.replaceAll(" ", "+")}`,
      token_type: exchangeMode === "invalid_type" ? "N_A" : "Bearer",
      issued_token_type: exchangeMode === "invalid_issued_type"
        ? "urn:ietf:params:oauth:token-type:refresh_token" : "urn:ietf:params:oauth:token-type:access_token",
      expires_in: exchangeMode === "expired" ? 0 : exchangeMode === "excessive_lifetime" ? 301 : 300,
      scope: exchangeMode === "invalid_scope_type" ? [requestedScope] : responseScope,
    };
    if (body.has("account_context_revision")) {
      const subject = body.get("subject_token")!;
      const resource = body.get("mcp_resource")!;
      const context = fixtureContext(subject, resource);
      if (!accountResourceAllowed) return respond(res, 403, { error: "delegation_denied" });
      if (accountExchangeMode === "race" || context.revision !== body.get("account_context_revision")) {
        return respond(res, 409, { error: "account_context_changed" });
      }
      if (accountExchangeMode === "expired") return respond(res, 403, { error: "delegation_expired" });
      if (context.is_switched) {
        if (accountTargetState !== "available") return respond(res, 403, { error: accountTargetState === "unavailable" ? "target_unavailable" : "delegation_denied" });
        const remaining = (delegationDeadlines.get(accountKey(subject, resource)) ?? 0) - accountClock;
        if (remaining <= 0) return respond(res, 403, { error: "delegation_expired" });
        payload.expires_in = Math.min(300, Math.ceil(remaining / 1000));
      }
      if (accountExchangeMode !== "missing_binding") {
        payload.account_context_revision = accountExchangeMode === "wrong_revision" ? "wrong" : context.revision;
        payload.actor_user_id = accountExchangeMode === "wrong_actor" ? 999 : context.original_account.id;
        payload.effective_user_id = accountExchangeMode === "wrong_target" ? 999 : context.active_account.id;
      }
      // Stable original-account fixture strings keep legacy route-scope assertions
      // readable. The switch scenarios use grant_id and unique account-bound tokens.
      if (decodeJwt(subject).grant_id) {
        const accessToken = `delegated-${crypto.randomUUID()}`;
        payload.access_token = accessToken;
        delegatedTokens.set(`Bearer ${accessToken}`, { context, key: accountKey(subject, resource), scopes: requestedScope });
      }
    }
    if (exchangeMode === "missing_expires") delete payload.expires_in;
    if (exchangeMode === "omitted_optional") {
      delete payload.issued_token_type;
      delete payload.scope;
    }
    return respond(res, 200, payload);
  }
  respond(res, 404, {});
});
issuer = `${authorization.origin}/tenant`;

let misplacedExchanges = 0;
const api = await start(async (req, res) => {
  const delegated = delegatedTokens.get(req.headers.authorization || "");
  if (delegated && accountContexts.get(delegated.key)?.revision !== delegated.context.revision) {
    return respond(res, 409, { error: "account_context_changed" });
  }
  if (req.url === "/private-discovery-leak") {
    leakedPrivateDiscovery++;
    return respond(res, 200, { state: true, resources: [] });
  }
  if (req.url === "/oauth/token") {
    misplacedExchanges++;
    return respond(res, 404, {});
  }
  if (["/contact-lists/42", "/data-fields", "/contact-lists/42/contact",
    "/targeting/google/generate-maps-search-urls", "/targeting/google/extract-maps-search"].includes(req.url || "")) {
    businessCalls.push({ method: req.method || "", path: req.url || "", bearer: req.headers.authorization || "" });
    const needed = req.url === "/contact-lists/42/contact" || req.url === "/targeting/google/extract-maps-search"
      ? "mcp:write" : "mcp:read";
    if (!hasExchangedScope(req, needed)) return respond(res, 401, { state_message: "insufficient_scope" });
    if (req.url === "/contact-lists/42") return respond(res, 200, { contact_list_profile: { id: 42, name: "Test list" } });
    if (req.url === "/data-fields") return respond(res, 200, { data_fields_list: [{ id: 1, identifier: "email", name: "Email" }] });
    if (req.url === "/contact-lists/42/contact") return respond(res, 200, { state: true, contacts_added: 1 });
    if (req.url === "/targeting/google/generate-maps-search-urls") return respond(res, 200, { google_maps_search_urls: ["https://maps.google.com/search?q=plumber"] });
    return respond(res, 200, { contact_list_id: 42 });
  }
  if (req.url === "/users/me") {
    apiBearers.push(req.headers.authorization || "");
    const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
    apiKeys.push(apiKey);
    if (apiKey === "key-alpha" || apiKey === "key-beta") {
      return respond(res, 200, { user_profile: { id: apiKey === "key-alpha" ? 71 : 72, first_name: "Key", last_name: "User", subscriptions: {} } });
    }
    if (apiMode === "unauthorized") return respond(res, 401, { state_message: "token_expired" });
    if (delegated) return respond(res, 200, { user_profile: { ...delegated.context.active_account, subscriptions: {} } });
    if (req.headers.authorization !== "Bearer exchanged-mcp:read") return respond(res, 401, {});
    return respond(res, 200, { user_profile: { id: 7, first_name: "Test", last_name: "User", subscriptions: {} } });
  }
  const endpoint = matchEndpoint(req.method || "GET", new URL(req.url || "/", "http://localhost").pathname);
  if (endpoint) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    businessCalls.push({ method: req.method || "", path: req.url || "", bearer: req.headers.authorization || "", body });
    if (apiMode === "unauthorized") return respond(res, 401, { state_message: "token_expired" });
    if (apiMode === "forbidden") return respond(res, 403, { state_message: "unauthorized_model" });
    if (!hasExchangedScope(req, endpoint.scope)) return respond(res, 401, { state_message: "insufficient_scope" });
    if (req.url === "/models/email" && req.method === "POST") {
      // Measured on the deployed API: text alone is refused with empty_html.
      if (typeof body?.html !== "string" || !body.html.trim()) return respond(res, 400, { state_message: "empty_html" });
      return respond(res, 200, { state: true, model_id: 81 });
    }
    return respond(res, 200, { state: true, results: [], operation: endpoint.path });
  }
  respond(res, 404, {});
});
apiOrigin = api.origin;

process.env.OAUTH_ISSUER = issuer;
process.env.OAUTH_MCP_RESOURCE = "http://127.0.0.1:1/mcp";
process.env.OAUTH_API_RESOURCE = apiOrigin;
process.env.OAUTH_INTERNAL_CLIENT_ID = crypto.randomUUID();
process.env.OAUTH_INTERNAL_CLIENT_SECRET = crypto.randomUUID();
process.env.MCP_HTTP_PATH = "/mcp";
process.env.MAGILEADS_API_BASE = apiOrigin;
delete process.env.MAGILEADS_API_URL;
delete process.env.OAUTH_JWKS_URI;

// The resource URL must be the actual server address; choose a free port first.
const reservation = await start((_req, res) => respond(res, 503, {}));
const resourcePort = new URL(reservation.origin).port;
await new Promise<void>((resolve) => reservation.server.close(() => resolve()));
process.env.OAUTH_MCP_RESOURCE = `http://127.0.0.1:${resourcePort}/mcp`;

const { createHttpServer } = await import("../src/http.js");
const { isToolExposed, preflightToolCall, scopesForTool, scopeForRoute, toolAccessTable } = await import("../src/tools.js");
const { basicClientAuthorization, clearExchangeCache } = await import("../src/oauth/exchange.js");
const { discoveryUrls, oauthEndpoint, resetDiscovery } = await import("../src/oauth/discovery.js");
const { resetKeySet } = await import("../src/oauth/verify.js");
const { loadOAuthConfig } = await import("../src/oauth/config.js");
const { loadHttpConfig } = await import("../src/http-config.js");
const { runWithAuth, rawRequest } = await import("../src/magileads.js");
const { log, redact, redactString } = await import("../src/log.js");
const { McpResourceRegistry } = await import("../src/oauth/resources.js");
const mcp = createHttpServer();
await new Promise<void>((resolve) => mcp.listen(Number(resourcePort), "127.0.0.1", resolve));
const mcpOrigin = `http://127.0.0.1:${resourcePort}`;

afterAll(async () => {
  await Promise.all([mcp, api.server, authorization.server].map((server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
});

async function token(scope: string, audience = process.env.OAUTH_MCP_RESOURCE!): Promise<string> {
  return new SignJWT({ scope, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(audience).setSubject("user-7")
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
}

async function rpc(method: string, bearer?: string, params?: unknown): Promise<Response> {
  // Older route tests confirm writes on the original account. Supply their
  // explicit fixture revision; accountRpc intentionally does NOT do this, so
  // missing/stale-revision security tests exercise the actual HTTP boundary.
  const call = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
  if (method === "tools/call" && bearer && call?.arguments?.confirm === true && call.arguments.account_revision === undefined) {
    params = { ...call, arguments: { ...call.arguments, account_revision: fixtureContext(bearer, process.env.OAUTH_MCP_RESOURCE!).revision } };
  }
  return fetch(`${mcpOrigin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function toolResult(response: Response): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const payload = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
  return payload.result;
}

async function switchingInstance(): Promise<{ server: http.Server; origin: string }> {
  return ephemeralMcp("both");
}

async function closeTestServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function grantToken(grant = crypto.randomUUID(), resource = process.env.OAUTH_MCP_RESOURCE!, subject = "user-7", scope = "mcp:read mcp:write"): Promise<string> {
  return new SignJWT({ scope, grant_id: grant, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(resource).setSubject(subject)
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
}

function accountRpc(origin: string, bearer: string, name: string, args: Record<string, unknown> = {}, resource = process.env.OAUTH_MCP_RESOURCE!): Promise<Response> {
  return keyRpc(origin, undefined, "tools/call", { name, arguments: args }, { Authorization: `Bearer ${bearer}`, Host: new URL(resource).host });
}

async function activeContext(origin: string, bearer: string, resource = process.env.OAUTH_MCP_RESOURCE!): Promise<AccountContext> {
  const response = await accountRpc(origin, bearer, "get_active_account", {}, resource);
  expect(response.status).toBe(200);
  const result = await toolResult(response);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text).account_context as AccountContext;
}

test("switching is automatic only for private HTTP OAuth; API keys and public profile stay unchanged", async () => {
  expect("accountSwitchingEnabled" in loadHttpConfig({})).toBe(false);
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const before = accountControlCalls.length;
    const listed = await keyRpc(instance.origin, undefined, "tools/list", undefined, { Authorization: `Bearer ${bearer}` });
    const tools = (await listed.json() as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
    expect(tools).toHaveLength(30);
    expect(tools.find((tool) => tool.name === "create_email_model")?.inputSchema.properties.account_revision).toBeDefined();
    expect(accountControlCalls.length).toBe(before);
    const standard = await rpc("tools/list", bearer);
    expect((await standard.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(30);
    for (const response of [await keyRpc(instance.origin, "key-alpha", "tools/list")]) {
      const data = await response.json() as { result: { tools: { name: string }[] } };
      expect(data.result.tools).toHaveLength(26);
      expect(data.result.tools.some((tool) => tool.name === "switch_account")).toBe(false);
    }
    const hidden = await keyRpc(instance.origin, "key-alpha", "tools/call", { name: "switch_account", arguments: { user_id: 42, confirm: true } });
    expect((await toolResult(hidden)).isError).toBe(true);
    expect(accountControlCalls.length).toBe(before);
  } finally { await closeTestServer(instance.server); }
});

test("account discovery and switch previews use only the private Basic-auth control plane", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const beforeBusiness = businessCalls.length + apiBearers.length;
    const beforeExchanges = exchanges.length;
    const context = await activeContext(instance.origin, bearer);
    expect(context.active_account).toEqual(context.original_account);
    const listed = await accountRpc(instance.origin, bearer, "list_switchable_accounts", { limit: 10, search: "Target" });
    const data = JSON.parse((await toolResult(listed)).content[0].text);
    expect(data.accounts[0].id).toBe(42);
    expect(data.account_context.active_account.id).toBe(7);
    const preview = await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42 });
    expect(JSON.parse((await toolResult(preview)).content[0].text).dry_run).toBe(true);
    expect((await activeContext(instance.origin, bearer)).revision).toBe(context.revision);
    expect(businessCalls.length + apiBearers.length).toBe(beforeBusiness);
    expect(exchanges.length).toBe(beforeExchanges);
    const call = accountControlCalls.at(-1)!;
    expect(call.authorization).toBe(basicClientAuthorization(process.env.OAUTH_INTERNAL_CLIENT_ID!, process.env.OAUTH_INTERNAL_CLIENT_SECRET!));
    expect(call.body).toEqual({ subject_token: bearer, resource: process.env.OAUTH_MCP_RESOURCE });
    expect(call.path).toBe("/oauth/mcp/account-context");
    expect(call.method).toBe("POST");
  } finally { await closeTestServer(instance.server); }
});

test("account selection survives token refresh and MCP replica replacement, but isolates grants, users and reseller domains", async () => {
  const first = await switchingInstance();
  const second = await switchingInstance();
  try {
    const grant = crypto.randomUUID();
    const bearer = await grantToken(grant);
    const context = await activeContext(first.origin, bearer);
    const switched = await accountRpc(first.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: context.revision });
    expect((await toolResult(switched)).isError).not.toBe(true);
    const refreshed = await grantToken(grant);
    expect(refreshed).not.toBe(bearer);
    await closeTestServer(first.server);
    const continued = await activeContext(second.origin, refreshed);
    expect(continued.is_switched).toBe(true);
    expect(continued.active_account).toEqual({ id: 42, first_name: "Target", last_name: "User" });
    expect(continued.original_account.id).toBe(7);
    const isolated = await Promise.all([
      activeContext(second.origin, await grantToken()),
      activeContext(second.origin, await grantToken(grant, process.env.OAUTH_MCP_RESOURCE!, "user-8")),
      activeContext(second.origin, await grantToken(grant, resellerResource), resellerResource),
    ]);
    expect(isolated.map((value) => value.is_switched)).toEqual([false, false, false]);
    expect(isolated.map((value) => value.active_account.id)).toEqual([7, 8, 7]);
    const result = await toolResult(await accountRpc(second.origin, refreshed, "get_account_overview"));
    const payload = JSON.parse(result.content[0].text);
    expect(payload.account_context.active_account.id).toBe(42);
    expect(payload.account_context.original_account.id).toBe(7);
    const lastBearer = apiBearers.at(-1)!;
    expect(lastBearer).not.toContain(refreshed);
    expect(delegatedTokens.get(lastBearer)?.context.active_account.id).toBe(42);
    // Another private HTTP OAuth instance sees exactly the same shared selection.
    const shared = await toolResult(await rpc("tools/call", refreshed, { name: "get_account_overview", arguments: {} }));
    expect(JSON.parse(shared.content[0].text).account_context.active_account.id).toBe(42);
  } finally { await closeTestServer(first.server); await closeTestServer(second.server); }
});

test("confirmed writes and account changes require a fresh revision before any exchange or mutation", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const original = await activeContext(instance.origin, bearer);
    const before = exchanges.length;
    for (const name of ["switch_account", "create_email_model"] as const) {
      const args = name === "switch_account" ? { user_id: 42 } : { name: "Test", subject: "Hello", text: "Hello" };
      const refused = await accountRpc(instance.origin, bearer, name, { ...args, confirm: true });
      expect((await toolResult(refused)).isError).toBe(true);
      expect(refused.headers.get("www-authenticate")).toBeNull();
    }
    expect(exchanges.length).toBe(before);
    await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: original.revision });
    const beforeWrites = businessCalls.length;
    const stale = await accountRpc(instance.origin, bearer, "magileads_request", { method: "POST", path: "/models/email", body: { html: "<p>Test</p>" }, confirm: true, account_revision: original.revision });
    expect((await toolResult(stale)).isError).toBe(true);
    expect(exchanges.length).toBe(before);
    expect(businessCalls.length).toBe(beforeWrites);
    const preview = await accountRpc(instance.origin, bearer, "create_email_model", { name: "Test", subject: "Hello", text: "Hello" });
    const active = JSON.parse((await toolResult(preview)).content[0].text).account_context as AccountContext;
    expect(active.active_account.id).toBe(42);
    const executed = await accountRpc(instance.origin, bearer, "create_email_model", { name: "Test", subject: "Hello", text: "Hello", confirm: true, account_revision: active.revision });
    expect((await toolResult(executed)).isError).not.toBe(true);
    expect(businessCalls.length).toBe(beforeWrites + 1);
    expect(exchanges.length).toBe(before + 1);
    expect(delegatedTokens.get(businessCalls.at(-1)!.bearer)?.context.active_account.id).toBe(42);
  } finally { await closeTestServer(instance.server); }
});

test("a switched business 401 is a normal tool error without reconnect, retry or fallback; return still works", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const context = await activeContext(instance.origin, bearer);
    await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: context.revision });
    apiMode = "unauthorized";
    const before = apiBearers.length;
    const failed = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect(failed.status).toBe(200);
    expect(failed.headers.get("www-authenticate")).toBeNull();
    const result = await toolResult(failed);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("switched_account_unauthorized");
    expect(JSON.parse(result.content[1].text).account_context.active_account.id).toBe(42);
    expect(apiBearers.length).toBe(before + 1);
    const active = await activeContext(instance.origin, bearer);
    expect(active.is_switched).toBe(true);
    const writesBefore = businessCalls.length;
    const writeFailed = await accountRpc(instance.origin, bearer, "create_email_model", {
      name: "Refused", subject: "Hello", text: "Hello", confirm: true, account_revision: active.revision,
    });
    expect(writeFailed.status).toBe(200);
    expect(writeFailed.headers.get("www-authenticate")).toBeNull();
    expect((await toolResult(writeFailed)).isError).toBe(true);
    expect(businessCalls.length).toBe(writesBefore + 1); // Exactly one attempt; no original-account fallback.
    accountExchangeMode = "expired";
    const beforeExchange = exchanges.length;
    const returned = await accountRpc(instance.origin, bearer, "return_to_original_account", { confirm: true, account_revision: active.revision });
    expect((await toolResult(returned)).isError).not.toBe(true);
    expect(exchanges.length).toBe(beforeExchange);
    expect((await activeContext(instance.origin, bearer)).is_switched).toBe(false);
    // A business 401 on the ORIGINAL account retains the existing OAuth challenge.
    accountExchangeMode = "normal";
    const rootFailed = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect(rootFailed.status).toBe(401);
    expect(rootFailed.headers.get("www-authenticate")).toContain("resource_metadata=");
  } finally { apiMode = "normal"; accountExchangeMode = "normal"; await closeTestServer(instance.server); }
});

test("delegation denial, expiry, context races and exchange binding mismatches never reach business APIs", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const context = await activeContext(instance.origin, bearer);
    const denied = await accountRpc(instance.origin, bearer, "switch_account", { user_id: 999, confirm: true, account_revision: context.revision });
    expect((await toolResult(denied)).content[0].text).toContain("delegation_denied");
    expect(denied.headers.get("www-authenticate")).toBeNull();
    expect((await activeContext(instance.origin, bearer)).revision).toBe(context.revision);
    const before = apiBearers.length;
    for (const mode of ["missing_binding", "wrong_actor", "wrong_target", "wrong_revision", "race", "expired"] as const) {
      accountExchangeMode = mode;
      const response = await accountRpc(instance.origin, bearer, "get_account_overview");
      expect(response.status).toBe(200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect((await toolResult(response)).isError).toBe(true);
    }
    expect(apiBearers.length).toBe(before);
  } finally { accountExchangeMode = "normal"; await closeTestServer(instance.server); }
});

test("parallel switches use compare-and-set; each successful business read exchanges again", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const context = await activeContext(instance.origin, bearer);
    const attempts = await Promise.all([1, 2].map(() => accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: context.revision })));
    const results = await Promise.all(attempts.map(toolResult));
    expect(results.filter((value) => !value.isError)).toHaveLength(1);
    expect(results.filter((value) => value.isError)).toHaveLength(1);
    const before = exchanges.length;
    await Promise.all([1, 2].map(() => accountRpc(instance.origin, bearer, "get_account_overview")));
    expect(exchanges.length).toBe(before + 2);
  } finally { await closeTestServer(instance.server); }
});

test("switched composite tools retain the read/write union and SDK validation errors identify the active account", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const context = await activeContext(instance.origin, bearer);
    await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: context.revision });
    const active = await activeContext(instance.origin, bearer);
    const before = businessCalls.length;
    const imported = await accountRpc(instance.origin, bearer, "add_contact_to_list", {
      contact_list_id: 42, properties: [{ field: "email", value: "example@example.com" }],
      confirm: true, account_revision: active.revision,
    });
    expect((await toolResult(imported)).isError).not.toBe(true);
    expect(exchanges.at(-1)?.scope).toBe("mcp:read mcp:write");
    for (const call of businessCalls.slice(before)) expect(delegatedTokens.get(call.bearer)?.context.active_account.id).toBe(42);
    const invalid = await accountRpc(instance.origin, bearer, "switch_account", { user_id: "not-an-id" });
    const result = await toolResult(invalid);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('account_context');
    expect(JSON.parse(result.content.at(-1)!.text).account_context.active_account.id).toBe(42);
  } finally { await closeTestServer(instance.server); }
});

test("an uncertain switch is not repeated or presented as a known active identity", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const original = await activeContext(instance.origin, bearer);
    const before = accountControlCalls.filter((call) => call.method === "PUT").length;
    accountMutationFailure = "lost_response";
    const failed = await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: original.revision });
    expect(failed.status).toBe(200);
    expect(failed.headers.get("www-authenticate")).toBeNull();
    const result = await toolResult(failed);
    expect(result.isError).toBe(true);
    const snapshot = JSON.parse(result.content.at(-1)!.text).account_context;
    expect(snapshot.selection_status).toBe("unknown_after_change");
    expect(snapshot.active_account.id).toBe(7); // Explicitly marked as the old snapshot, not the actual selection.
    expect(accountControlCalls.filter((call) => call.method === "PUT").length).toBe(before + 1);
    accountMutationFailure = "none";
    const actual = await activeContext(instance.origin, bearer);
    expect(actual.active_account.id).toBe(42);
    expect(actual.revision).not.toBe(original.revision);
    accountMutationFailure = "invalid_subject_token";
    const revoked = await accountRpc(instance.origin, bearer, "return_to_original_account", { confirm: true, account_revision: actual.revision });
    expect(revoked.status).toBe(401); // True root revocation during control dispatch must still challenge.
    expect(revoked.headers.get("www-authenticate")).toContain("resource_metadata=");
  } finally { accountMutationFailure = "none"; await closeTestServer(instance.server); }
});

test("private context outages, redirects and internal authentication errors never cause false reconnects or leaks", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const before = apiBearers.length;
    const leaks = leakedPrivateDiscovery;
    for (const mode of ["unavailable", "redirect", "invalid_client", "malformed"] as const) {
      accountControlMode = mode;
      const response = await accountRpc(instance.origin, bearer, "get_account_overview");
      expect(response.status).toBe(["unavailable", "redirect"].includes(mode) ? 503 : 200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      const text = await response.text();
      expect(text).not.toContain(bearer);
      expect(text).not.toContain(process.env.OAUTH_INTERNAL_CLIENT_SECRET!);
    }
    expect(leakedPrivateDiscovery).toBe(leaks);
    expect(apiBearers.length).toBe(before);
    accountControlMode = "invalid_subject_token";
    const expired = await accountRpc(instance.origin, bearer, "get_active_account");
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain("resource_metadata=");
  } finally { accountControlMode = "normal"; await closeTestServer(instance.server); }
});

test("write-only OAuth can inspect context, select, create a model and return without list/read access", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken(crypto.randomUUID(), process.env.OAUTH_MCP_RESOURCE!, "user-7", "mcp:write");
    const list = await keyRpc(instance.origin, undefined, "tools/list", undefined, { Authorization: `Bearer ${bearer}` });
    const names = (await list.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toContain("get_active_account");
    expect(names).toContain("switch_account");
    expect(names).not.toContain("list_switchable_accounts");
    expect(names).not.toContain("get_account_overview");
    const original = await activeContext(instance.origin, bearer);
    const beforeListCalls = accountControlCalls.filter((call) => call.path.endsWith("switchable-accounts")).length;
    const denied = await accountRpc(instance.origin, bearer, "list_switchable_accounts");
    expect(denied.status).toBe(403);
    expect(accountControlCalls.filter((call) => call.path.endsWith("switchable-accounts")).length).toBe(beforeListCalls);
    const switched = await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: original.revision });
    expect((await toolResult(switched)).isError).not.toBe(true);
    const active = await activeContext(instance.origin, bearer);
    expect(active.active_account.id).toBe(42);
    const created = await accountRpc(instance.origin, bearer, "create_email_model", { name: "Write-only test", subject: "Test", text: "Hello", confirm: true, account_revision: active.revision });
    expect((await toolResult(created)).isError).not.toBe(true);
    expect(exchanges.at(-1)?.scope).toBe("mcp:write");
    const returned = await accountRpc(instance.origin, bearer, "return_to_original_account", { confirm: true, account_revision: active.revision });
    expect((await toolResult(returned)).isError).not.toBe(true);
    expect((await activeContext(instance.origin, bearer)).is_switched).toBe(false);
    expect(accountControlCalls.filter((call) => call.path.endsWith("switchable-accounts")).length).toBe(beforeListCalls);
  } finally { await closeTestServer(instance.server); }
});

test("read-only OAuth inspects context but cannot switch, return or write", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken(crypto.randomUUID(), process.env.OAUTH_MCP_RESOURCE!, "user-7", "mcp:read");
    const context = await activeContext(instance.origin, bearer);
    const before = accountControlCalls.filter((call) => call.method === "PUT").length;
    for (const name of ["switch_account", "return_to_original_account", "create_email_model"]) {
      const response = await accountRpc(instance.origin, bearer, name, { user_id: 42, confirm: true, account_revision: context.revision });
      expect(response.status).toBe(403);
    }
    expect(accountControlCalls.filter((call) => call.method === "PUT").length).toBe(before);
    expect((await activeContext(instance.origin, bearer)).revision).toBe(context.revision);
  } finally { await closeTestServer(instance.server); }
});

test("delegation expires at 60 minutes without automatic renewal; explicit reselection changes revision", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const original = await activeContext(instance.origin, bearer);
    await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: original.revision });
    const selected = await activeContext(instance.origin, bearer);
    accountClock = 60 * 60_000 - 1_000;
    const lastSecond = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect((await toolResult(lastSecond)).isError).not.toBe(true);
    accountClock += 1_000;
    const puts = accountControlCalls.filter((call) => call.method === "PUT").length;
    const expired = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect(expired.status).toBe(200);
    expect(expired.headers.get("www-authenticate")).toBeNull();
    const error = await toolResult(expired);
    expect(error.isError).toBe(true);
    expect(error.content[0].text).toContain("delegation_expired");
    expect(error.content[0].text).toContain("60 minutes");
    expect(accountControlCalls.filter((call) => call.method === "PUT").length).toBe(puts);
    expect((await activeContext(instance.origin, bearer)).revision).toBe(selected.revision);
    const renewed = await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: selected.revision });
    expect((await toolResult(renewed)).isError).not.toBe(true);
    const next = await activeContext(instance.origin, bearer);
    expect(next.revision).not.toBe(selected.revision);
    expect(next.active_account.id).toBe(42);
    expect((await toolResult(await accountRpc(instance.origin, bearer, "get_account_overview"))).isError).not.toBe(true);
    accountClock += 60 * 60_000;
    const returned = await accountRpc(instance.origin, bearer, "return_to_original_account", { confirm: true, account_revision: next.revision });
    expect((await toolResult(returned)).isError).not.toBe(true);
  } finally { accountClock = 0; await closeTestServer(instance.server); }
});

test("target removal or lost delegation permissions cannot block an explicit return", async () => {
  const instance = await switchingInstance();
  try {
    for (const state of ["unavailable", "denied"] as const) {
      const bearer = await grantToken();
      const original = await activeContext(instance.origin, bearer);
      await accountRpc(instance.origin, bearer, "switch_account", { user_id: 42, confirm: true, account_revision: original.revision });
      accountTargetState = state;
      const active = await activeContext(instance.origin, bearer);
      expect(active.active_account.id).toBe(42);
      const refused = await accountRpc(instance.origin, bearer, "get_account_overview");
      expect(refused.status).toBe(200);
      expect(refused.headers.get("www-authenticate")).toBeNull();
      expect((await toolResult(refused)).isError).toBe(true);
      const returned = await accountRpc(instance.origin, bearer, "return_to_original_account", { confirm: true, account_revision: active.revision });
      expect((await toolResult(returned)).isError).not.toBe(true);
      expect((await activeContext(instance.origin, bearer)).active_account.id).toBe(7);
      accountTargetState = "available";
    }
  } finally { accountTargetState = "available"; await closeTestServer(instance.server); }
});

test("account list pagination forwards only the contract fields and preserves opaque cursors", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const first = await accountRpc(instance.origin, bearer, "list_switchable_accounts", { search: "Target", limit: 1 });
    const page1 = JSON.parse((await toolResult(first)).content[0].text);
    expect(page1.accounts.map((item: { id: number }) => item.id)).toEqual([42]);
    expect(typeof page1.next_cursor).toBe("string");
    const second = await accountRpc(instance.origin, bearer, "list_switchable_accounts", { search: "Target", limit: 1, cursor: page1.next_cursor });
    const page2 = JSON.parse((await toolResult(second)).content[0].text);
    expect(page2.accounts.map((item: { id: number }) => item.id)).toEqual([43]);
    expect(page2.next_cursor).toBeNull();
    for (const invalid of [await accountRpc(instance.origin, bearer, "list_switchable_accounts", { search: "Other", cursor: page1.next_cursor }),
      await accountRpc(instance.origin, await grantToken(), "list_switchable_accounts", { search: "Target", cursor: page1.next_cursor })]) {
      expect(invalid.status).toBe(200);
      expect(invalid.headers.get("www-authenticate")).toBeNull();
      expect((await toolResult(invalid)).content[0].text).toContain("invalid_request");
    }
  } finally { await closeTestServer(instance.server); }
});

test("resource authorization refusals fail closed before exchange, including on the original account", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    accountResourceAllowed = false;
    const before = exchanges.length;
    const businessBefore = apiBearers.length;
    const result = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect(result.status).toBe(200);
    expect(result.headers.get("www-authenticate")).toBeNull();
    expect((await toolResult(result)).content[0].text).toContain("delegation_denied");
    expect(exchanges.length).toBe(before);
    expect(apiBearers.length).toBe(businessBefore);
  } finally { accountResourceAllowed = true; await closeTestServer(instance.server); }
});

test("contextual exchange refuses incomplete resources, excessive lifetime and another token origin", async () => {
  const instance = await switchingInstance();
  try {
    const bearer = await grantToken();
    const before = apiBearers.length;
    for (const mode of ["invalid_target", "invalid_request", "excessive_lifetime"] as const) {
      exchangeMode = mode;
      const response = await accountRpc(instance.origin, bearer, "get_account_overview");
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.status).toBe(mode === "excessive_lifetime" ? 502 : 200);
      if (mode !== "excessive_lifetime") expect((await toolResult(response)).content[0].text).toContain(mode);
    }
    exchangeMode = "normal";
    discoveryMode = "other_token_origin";
    resetDiscovery();
    const misplaced = misplacedExchanges;
    const refused = await accountRpc(instance.origin, bearer, "get_account_overview");
    expect((await toolResult(refused)).content[0].text).toContain("invalid_target");
    expect(misplacedExchanges).toBe(misplaced);
    expect(apiBearers.length).toBe(before);
  } finally { exchangeMode = "normal"; discoveryMode = "normal"; resetDiscovery(); await closeTestServer(instance.server); }
});

test("logger redacts account pagination cursors in nested values and query strings", () => {
  expect(JSON.stringify(redact({ cursor: "secret-cursor", nested: { next_cursor: "next-secret" } }))).not.toContain("secret");
  expect(redactString("https://example.test/list?cursor=secret-cursor&next_cursor=next-secret")).not.toContain("secret");
});

async function runLiveHarness(bearer: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["run", "scripts/check-account-switching.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_TEST_SUBJECT_TOKEN: bearer, MCP_TEST_EXPECTED_USER_ID: "7", MCP_TEST_TARGET_USER_ID: "42" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  return { code, stdout, stderr };
}

test("the live harness exercises the actual local MCP, switched model creation and explicit restoration", async () => {
  const bearer = await grantToken();
  const output = await runLiveHarness(bearer, ["--allow-switch", "--allow-create-model"]);
  expect(output.code).toBe(0);
  const rows = output.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  expect(rows.every((row) => row.status === "PASS")).toBe(true);
  expect(rows.some((row) => row.check.includes("model creation and ID re-read"))).toBe(true);
  expect(rows.at(-1).check).toContain("original business identity restored");
  expect(fixtureContext(bearer, process.env.OAUTH_MCP_RESOURCE!).active_account.id).toBe(7);
  for (const secret of [bearer, process.env.OAUTH_INTERNAL_CLIENT_SECRET!]) {
    expect(output.stdout).not.toContain(secret);
    expect(output.stderr).not.toContain(secret);
  }
}, 15_000);

test("the live harness defaults to read-only and accurately reports blocked mutation checks", async () => {
  const bearer = await grantToken();
  const puts = accountControlCalls.filter((call) => call.method === "PUT").length;
  const writes = businessCalls.filter((call) => call.method === "POST").length;
  const output = await runLiveHarness(bearer, []);
  expect(output.code).toBe(2);
  expect(output.stdout).toContain('"status":"BLOCKED"');
  expect(accountControlCalls.filter((call) => call.method === "PUT").length).toBe(puts);
  expect(businessCalls.filter((call) => call.method === "POST").length).toBe(writes);
}, 15_000);

test("the live harness never reports success with a mismatched original account", async () => {
  const bearer = await grantToken(crypto.randomUUID(), process.env.OAUTH_MCP_RESOURCE!, "user-8");
  const puts = accountControlCalls.filter((call) => call.method === "PUT").length;
  const output = await runLiveHarness(bearer, ["--allow-switch", "--allow-create-model"]);
  expect(output.code).toBe(1);
  expect(output.stdout).toContain("unexpected_original_account");
  expect(accountControlCalls.filter((call) => call.method === "PUT").length).toBe(puts);
}, 15_000);

test("generic preflight derives all endpoint scopes and leaves write previews local", () => {
  for (const row of CALLABLE_ENDPOINTS) {
    const path = row.path.replace(/\{[^}]+\}/g, "7");
    expect(preflightToolCall("magileads_request", { method: row.method, path }))
      .toEqual({ scopes: [row.scope], exchange: !row.write });
    expect(preflightToolCall("magileads_request", { method: row.method, path, confirm: true }))
      .toEqual({ scopes: [row.scope], exchange: true });
  }
});

test("all dedicated write previews are local, including contact import and composite targeting", async () => {
  const caller = await token("mcp:read mcp:write");
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  const cases = [
    { name: "add_contact_to_list", arguments: { contact_list_id: 42, properties: [{ field: "email", value: "example@example.com" }] } },
    { name: "extract_maps_search", arguments: { google_maps_search_urls: ["https://maps.google.com/search?q=plumber"], contact_list_name: "Test" } },
    { name: "run_google_maps_targeting", arguments: { search: "plumber", contact_list_name: "Test" } },
    { name: "create_email_model", arguments: { name: "Test", subject: "Hello", text: "Hello %first_name%" } },
  ];
  for (const params of cases) {
    const response = await rpc("tools/call", caller, params);
    expect(response.status).toBe(200);
    expect(JSON.parse((await toolResult(response)).content[0].text).dry_run).toBe(true);
  }
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
});

test("the OAuth API client rejects omitted scopes and excluded routes before making a request", async () => {
  const before = businessCalls.length;
  let unauthorized = false;
  const auth = { kind: "oauth" as const, scopes: ["mcp:read" as const], exchangedBearer: "exchanged-mcp:read",
    onUnauthorized: () => { unauthorized = true; } };
  await expect(runWithAuth(auth, () => rawRequest("POST", "/models/email", { name: "Test" })))
    .rejects.toThrow("does not cover");
  await expect(runWithAuth(auth, () => rawRequest("GET", "/api-keys"))).rejects.toThrow("not authorized");
  expect(businessCalls.length).toBe(before);
  expect(unauthorized).toBe(false);
});

test("every POST read executes with a read-only bearer, including search and Maps URL generation", async () => {
  const caller = await token("mcp:read");
  for (const row of CALLABLE_ENDPOINTS.filter((row) => row.method === "POST" && !row.write)) {
    const path = row.path.replace(/\{[^}]+\}/g, "7");
    const before = businessCalls.length;
    const response = await rpc("tools/call", caller, { name: "magileads_request", arguments: { method: "POST", path, body: {} } });
    expect(response.status).toBe(200);
    expect((await toolResult(response)).isError).not.toBe(true);
    expect(businessCalls.length).toBe(before + 1);
    expect(businessCalls.at(-1)?.bearer).toBe("Bearer exchanged-mcp:read");
    expect(exchanges.at(-1)?.scope).toBe("mcp:read");
  }
});

test("personalized GET writes require confirmation and an exchanged write token", async () => {
  for (const row of CALLABLE_ENDPOINTS.filter((row) => row.method === "GET" && row.write)) {
    const caller = await token("mcp:write");
    const path = row.path.replace(/\{[^}]+\}/g, "7");
    const args = { method: "GET", path };
    const before = businessCalls.length;
    const beforeExchanges = exchanges.length;
    const preview = await rpc("tools/call", caller, { name: "magileads_request", arguments: args });
    expect(preview.status).toBe(200);
    const previewData = JSON.parse((await toolResult(preview)).content[0].text);
    expect(previewData.dry_run).toBe(true);
    expect(previewData.would_call.required_scope).toBe("mcp:write");
    expect(businessCalls.length).toBe(before);
    expect(exchanges.length).toBe(beforeExchanges);
    const confirmed = await rpc("tools/call", caller, { name: "magileads_request", arguments: { ...args, confirm: true } });
    expect(confirmed.status).toBe(200);
    expect((await toolResult(confirmed)).isError).not.toBe(true);
    expect(businessCalls.length).toBe(before + 1);
    expect(businessCalls.at(-1)?.bearer).toBe("Bearer exchanged-mcp:write");
    const unsafeRead = await rpc("tools/call", await token("mcp:read mcp:write"), { name: "magileads_get", arguments: { path } });
    expect(unsafeRead.status).toBe(200);
    expect((await toolResult(unsafeRead)).isError).toBe(true);
    expect(unsafeRead.headers.get("www-authenticate")).toBeNull();
    expect(businessCalls.length).toBe(before + 1);
  }
});

test("initialization and all write descriptions advertise creation without duplicate checks", async () => {
  const caller = await token("mcp:read mcp:write");
  const before = businessCalls.length;
  const initialized = await rpc("initialize", caller, {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
  });
  expect(initialized.status).toBe(200);
  const initialization = await initialized.json() as { result: { instructions: string; serverInfo: { version: string } } };
  expect(initialization.result.instructions).toContain(CREATION_GUIDANCE);
  expect(initialization.result.instructions).toContain(ACCOUNT_SWITCHING_GUIDANCE);
  expect(initialization.result.serverInfo.version).toBe("0.13.0");
  const listed = await rpc("tools/list", caller);
  const tools = (await listed.json() as { result: { tools: {
    name: string; description: string; annotations: { readOnlyHint: boolean };
  }[] } }).result.tools;
  for (const tool of tools) {
    expect(tool.description.includes(CREATION_GUIDANCE)).toBe(!tool.annotations.readOnlyHint);
  }
  expect(businessCalls.length).toBe(before);
});

test("separately confirmed same-name creations execute once each without listing any resource", async () => {
  // A write-only caller cannot list anything: both creation paths must remain independent of reads.
  const caller = await token("mcp:write");
  const before = businessCalls.length;
  const email = { name: "Salutation prénom", subject: "Salut %first_name%", text: "Salut %first_name%" };
  for (const creation of [
    { name: "create_email_model", arguments: { ...email, confirm: true } },
    { name: "magileads_request", arguments: { method: "POST", path: "/contact-lists", body: { name: "Same name" }, confirm: true } },
  ]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await rpc("tools/call", caller, creation);
      expect(response.status).toBe(200);
      expect((await toolResult(response)).isError).not.toBe(true);
    }
  }
  expect(businessCalls.slice(before).map(({ method, path }) => ({ method, path }))).toEqual([
    { method: "POST", path: "/models/email" }, { method: "POST", path: "/models/email" },
    { method: "POST", path: "/contact-lists" }, { method: "POST", path: "/contact-lists" },
  ]);
});

test("model list, confirmed creation and update have the correct separate scopes", async () => {
  const caller = await token("mcp:read mcp:write");
  clearExchangeCache();
  const list = await rpc("tools/call", caller, { name: "magileads_get", arguments: { path: "/models/email" } });
  expect((await toolResult(list)).isError).not.toBe(true);
  expect(exchanges.at(-1)?.scope).toBe("mcp:read");
  const args = { name: "Salutation prénom", subject: "Salut %first_name%", text: "Salut %first_name%" };
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  const preview = await rpc("tools/call", caller, { name: "create_email_model", arguments: args });
  expect(JSON.parse((await toolResult(preview)).content[0].text).dry_run).toBe(true);
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
  const created = await rpc("tools/call", caller, { name: "create_email_model", arguments: { ...args, confirm: true } });
  expect(created.status).toBe(200);
  const data = JSON.parse((await toolResult(created)).content[0].text);
  expect(data.executed).toBe(true);
  expect(data.result.model_id).toBe(81);
  expect(businessCalls.at(-1)?.body).toEqual({ ...args, html: "<p>Salut %first_name%</p>" });
  expect(exchanges.at(-1)?.scope).toBe("mcp:write");
  const updated = await rpc("tools/call", caller, { name: "magileads_request",
    arguments: { method: "PUT", path: "/models/email/81", body: { text: "Bonjour %first_name%" }, confirm: true } });
  expect((await toolResult(updated)).isError).not.toBe(true);
  expect(businessCalls.at(-1)?.bearer).toBe("Bearer exchanged-mcp:write");
  expect(businessCalls.slice(before).map((call) => call.path)).toEqual(["/models/email", "/models/email/81"]);
});

test("generic email creation previews and sends the same normalized HTML body", async () => {
  const caller = await token("mcp:write");
  const body = { name: "Generic test", subject: "Salut %first_name%", text: "Salut %first_name%\nA < B & C", tags_ids: [7] };
  const args = { method: "POST", path: "/models/email", body };
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  const preview = await rpc("tools/call", caller, { name: "magileads_request", arguments: args });
  const previewBody = JSON.parse((await toolResult(preview)).content[0].text).would_call.body;
  expect(previewBody).toEqual({ ...body, html: "<p>Salut %first_name%<br>A &lt; B &amp; C</p>" });
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
  const created = await rpc("tools/call", caller, { name: "magileads_request", arguments: { ...args, confirm: true } });
  expect((await toolResult(created)).isError).not.toBe(true);
  expect(businessCalls.at(-1)?.body).toEqual(previewBody);
  expect(businessCalls.at(-1)?.bearer).toBe("Bearer exchanged-mcp:write");
});

test("dedicated creation handles blank HTML and keeps explicit HTML unchanged", async () => {
  const caller = await token("mcp:write");
  for (const input of [
    { name: "Blank HTML", subject: "Hello", text: "Salut %first_name%", html: " \n " },
    { name: "Explicit HTML", subject: "Hello", text: "Plain alternative", html: '<div style="color:red">Salut %first_name%</div>' },
    { name: "HTML only", subject: "Hello", html: "<p>Hello</p>" },
    { name: "Blank alternative", subject: "Hello", text: "", html: "<p>Hello</p>" },
  ]) {
    const preview = await rpc("tools/call", caller, { name: "create_email_model", arguments: input });
    const previewBody = JSON.parse((await toolResult(preview)).content[0].text).would_call.body;
    const created = await rpc("tools/call", caller, { name: "create_email_model", arguments: { ...input, confirm: true } });
    expect((await toolResult(created)).isError).not.toBe(true);
    expect(businessCalls.at(-1)?.body).toEqual(previewBody);
    expect(previewBody.html).toBe(input.html.trim() ? input.html : "<p>Salut %first_name%</p>");
  }
});

test("API content validation errors remain tool errors, not reconnects or retries", async () => {
  const caller = await token("mcp:write");
  const before = businessCalls.length;
  const response = await rpc("tools/call", caller, { name: "magileads_request",
    arguments: { method: "POST", path: "/models/email", body: { name: "Missing body" }, confirm: true } });
  expect(response.status).toBe(200);
  expect(response.headers.get("www-authenticate")).toBeNull();
  const result = await toolResult(response);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("empty_html");
  expect(businessCalls.length).toBe(before + 1);
});

test("all generic write dry runs and discovery avoid exchange and business calls", async () => {
  const caller = await token("mcp:read mcp:write");
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  for (const row of CALLABLE_ENDPOINTS.filter((row) => row.write)) {
    const path = row.path.replace(/\{[^}]+\}/g, "7");
    const response = await rpc("tools/call", caller, { name: "magileads_request", arguments: { method: row.method, path, confirm: false } });
    expect(response.status).toBe(200);
    const data = JSON.parse((await toolResult(response)).content[0].text);
    expect(data.dry_run).toBe(true);
    expect(data.would_call.required_scope).toBe(row.scope);
  }
  const discovered = await rpc("tools/call", caller, { name: "list_api_endpoints", arguments: { search: "models/email", reads_only: true } });
  const rows = JSON.parse((await toolResult(discovered)).content[0].text).endpoints;
  expect(rows.every((row: { scope: string }) => row.scope === "mcp:read")).toBe(true);
  expect(rows.some((row: { path: string }) => row.path.includes("{contact_id}"))).toBe(false);
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
});

test("excluded endpoints and unregistered pagination fail locally without a challenge or exchange", async () => {
  const caller = await token("mcp:read mcp:write");
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  for (const [method, path] of [["GET", "/api-keys"], ["GET", "/users"], ["GET", "/users/me/page/2"],
    ["PUT", "/resellers/7/role/7"], ["DELETE", "/models/email/7"], ["PATCH", "/models/email/7"]]) {
    const response = await rpc("tools/call", caller, { name: "magileads_request", arguments: { method, path, confirm: true } });
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect((await toolResult(response)).isError).toBe(true);
  }
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
});

test("wrong scope blocks model writes before exchange; missing body is refused locally", async () => {
  const before = businessCalls.length;
  const beforeExchanges = exchanges.length;
  const response = await rpc("tools/call", await token("mcp:read"), { name: "magileads_request",
    arguments: { method: "POST", path: "/models/email", body: { name: "Test" }, confirm: true } });
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('scope="mcp:write"');
  const invalid = await rpc("tools/call", await token("mcp:write"), { name: "create_email_model",
    arguments: { name: "Test", subject: "Test" } });
  expect((await toolResult(invalid)).isError).toBe(true);
  expect(businessCalls.length).toBe(before);
  expect(exchanges.length).toBe(beforeExchanges);
});

test("a business permission refusal is surfaced without reconnecting", async () => {
  apiMode = "forbidden";
  try {
    const response = await rpc("tools/call", await token("mcp:read"), { name: "magileads_get", arguments: { path: "/models/email/999" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    const result = await toolResult(response);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unauthorized_model");
  } finally { apiMode = "normal"; }
});

test("dedicated and generic contact search both request the read scope", async () => {
  const caller = await token("mcp:read");
  const dedicated = await rpc("tools/call", caller, { name: "search_contacts", arguments: { contact_list_id: 42, query: "example" } });
  expect((await toolResult(dedicated)).isError).not.toBe(true);
  expect(exchanges.at(-1)?.scope).toBe("mcp:read");
  const generic = await rpc("tools/call", caller, { name: "magileads_request",
    arguments: { method: "POST", path: "/contact-lists/42/contacts/search", body: { query: "example" } } });
  expect((await toolResult(generic)).isError).not.toBe(true);
  expect(businessCalls.at(-1)?.bearer).toBe("Bearer exchanged-mcp:read");
});

test("metadata is available at both RFC and bare paths with CORS", async () => {
  expect(toolAccessTable().size).toBe(30); // Four private HTTP OAuth account-control tools.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetch(`${mcpOrigin}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      resource: process.env.OAUTH_MCP_RESOURCE,
      authorization_servers: [issuer],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
    });
    expect((await fetch(`${mcpOrigin}${path}`, { method: "OPTIONS" })).status).toBe(204);
  }
});

test("tool declarations compute route-scope unions for composite tools", () => {
  const table = toolAccessTable();
  expect(scopesForTool(table.get("add_contact_to_list")!)).toEqual(["mcp:read", "mcp:write"]);
  expect(scopesForTool(table.get("run_google_maps_targeting")!)).toEqual(["mcp:read", "mcp:write"]);
  expect(scopesForTool(table.get("extract_maps_search")!)).toEqual(["mcp:write"]);
  expect(scopesForTool(table.get("search_contacts")!)).toEqual(["mcp:read"]);
  expect(scopeForRoute(table.get("run_google_maps_targeting")!, "POST /targeting/google/generate-maps-search-urls")).toBe("mcp:read");
});

test("public plugin tool annotations match private-account and open-world behavior", async () => {
  const response = await rpc("tools/list", await token("mcp:read mcp:write"));
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    result: { tools: { name: string; annotations: {
      readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean;
    } }[] };
  };
  const tools = payload.result.tools;
  expect(tools).toHaveLength(30);
  const openWorld = new Set([
    "generate_maps_search_urls", "extract_maps_search", "run_google_maps_targeting", "magileads_request",
    "get_active_account", "list_switchable_accounts", "switch_account", "return_to_original_account",
  ]);
  const writes = new Set(["extract_maps_search", "run_google_maps_targeting", "add_contact_to_list", "magileads_request", "create_email_model", "switch_account", "return_to_original_account"]);
  for (const tool of tools) {
    expect(tool.annotations.openWorldHint).toBe(openWorld.has(tool.name));
    expect(tool.annotations.readOnlyHint).toBe(!writes.has(tool.name));
    expect(tool.annotations.destructiveHint).toBe(writes.has(tool.name));
  }
});

test("reseller metadata and every OAuth challenge use the requested, privately authorized host", async () => {
  for (const resource of [process.env.OAUTH_MCP_RESOURCE!, resellerResource, otherResellerResource]) {
    const host = new URL(resource).host;
    const metadataUrl = `${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp`;
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(`${mcpOrigin}${path}`, { headers: { Host: host, "X-Forwarded-Host": "evil.example" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource, authorization_servers: [issuer], scopes_supported: ["mcp:read", "mcp:write"], bearer_methods_supported: ["header"] });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const missing = await keyRpc(mcpOrigin, undefined, "tools/list", undefined, { Host: host });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(`resource_metadata="${metadataUrl}"`);
    const insufficient = await keyRpc(mcpOrigin, undefined, "tools/call", { name: "create_email_model", arguments: {} },
      { Host: host, Authorization: `Bearer ${await token("mcp:read", resource)}` });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain(metadataUrl);
  }
});

test("each MCP domain accepts only its own exact audience before exchange, including cached tokens", async () => {
  const resources = [process.env.OAUTH_MCP_RESOURCE!, resellerResource, otherResellerResource];
  clearExchangeCache();
  for (const resource of resources) {
    const bearer = await token("mcp:read", resource);
    const own = await keyRpc(mcpOrigin, undefined, "tools/call", { name: "get_account_overview", arguments: {} },
      { Host: new URL(resource).host, Authorization: `Bearer ${bearer}` });
    expect(own.status).toBe(200);
    expect(JSON.parse((await toolResult(own)).content[0].text).id).toBe(7);
    expect(exchanges.at(-1)?.resource).toBe(apiOrigin);
    expect(exchanges.at(-1)?.subject).toBe(bearer);
    expect(apiBearers.at(-1)).toBe("Bearer exchanged-mcp:read");
    for (const wrong of resources.filter((entry) => entry !== resource)) {
      const beforeExchanges = exchanges.length;
      const beforeApi = apiBearers.length;
      const response = await keyRpc(mcpOrigin, undefined, "tools/call", { name: "get_account_overview", arguments: {} },
        { Host: new URL(wrong).host, Authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(new URL(wrong).origin);
      expect(exchanges.length).toBe(beforeExchanges);
      expect(apiBearers.length).toBe(beforeApi);
    }
  }
});

test("unregistered hosts and forwarding spoofing never reflect metadata or reach exchange", async () => {
  const beforeExchanges = exchanges.length;
  const beforeApi = apiBearers.length;
  for (const host of ["evil.example", "mcp.surleads.com:443", "mcp.surleads.com.", "mcp.surleads.com,evil.example"]) {
    const headers = { Host: host, "X-Forwarded-Host": "mcp.surleads.com", Forwarded: "host=mcp.surleads.com;proto=https" };
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(mcpOrigin + path, { headers });
      expect(response.status).toBe(421);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.text()).not.toContain(host);
    }
    const response = await keyRpc(mcpOrigin, undefined, "tools/list", undefined,
      { ...headers, Authorization: `Bearer ${await token("mcp:read", otherResellerResource)}` });
    expect(response.status).toBe(421);
    expect(response.headers.get("www-authenticate")).toBeNull();
  }
  expect(exchanges.length).toBe(beforeExchanges);
  expect(apiBearers.length).toBe(beforeApi);
});

test("OAuth JWT types, multiple audiences and audience URL variants are refused", async () => {
  const beforeExchanges = exchanges.length;
  const beforeApi = apiBearers.length;
  for (const [typ, audience] of [
    [undefined, resellerResource], ["id+jwt", resellerResource], ["refresh+jwt", resellerResource],
    ["JWT", [resellerResource, otherResellerResource]], ["JWT", `${resellerResource}/`],
    ["JWT", "https://mcp-engage.lebonlogiciel.com:443/mcp"],
  ] as [string | undefined, string | string[]][]) {
    const bearer = await new SignJWT({ scope: "mcp:read" }).setProtectedHeader({ alg: "RS256", kid: "smoke-key", ...(typ ? { typ } : {}) })
      .setIssuer(issuer).setAudience(audience).setSubject("user-7").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    const response = await keyRpc(mcpOrigin, undefined, "tools/list", undefined,
      { Host: "mcp-engage.lebonlogiciel.com", Authorization: `Bearer ${bearer}` });
    expect(response.status).toBe(401);
  }
  const accepted = await new SignJWT({ scope: "mcp:read" }).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "smoke-key" })
    .setIssuer(issuer).setAudience([resellerResource]).setSubject("user-7").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  expect((await keyRpc(mcpOrigin, undefined, "tools/list", undefined,
    { Host: "mcp-engage.lebonlogiciel.com", Authorization: `Bearer ${accepted}` })).status).toBe(200);
  expect(exchanges.length).toBe(beforeExchanges);
  expect(apiBearers.length).toBe(beforeApi);
});

test("private discovery failure yields 503, expiry is anchored to success, and removed domains are refused", async () => {
  let time = 0;
  let unavailable = true;
  let resources = [process.env.OAUTH_MCP_RESOURCE!, resellerResource];
  const request = (async () => new Response(JSON.stringify({ state: true, resources }), { status: unavailable ? 503 : 200 })) as unknown as typeof fetch;
  const registry = new McpResourceRegistry(loadOAuthConfig(), request, () => time);
  const server = createHttpServer(registry);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const origin = `http://127.0.0.1:${address.port}`;
  const beforeExchanges = exchanges.length;
  const beforeApi = apiBearers.length;
  const bearer = await token("mcp:read", resellerResource);
  const headers = { Host: "mcp-engage.lebonlogiciel.com", Authorization: `Bearer ${bearer}` };
  try {
    const missingList = await keyRpc(origin, undefined, "tools/list", undefined, headers);
    expect(missingList.status).toBe(503);
    expect(missingList.headers.get("www-authenticate")).toBeNull();
    expect((await fetch(origin + "/.well-known/oauth-protected-resource/mcp", { headers })).status).toBe(503);
    unavailable = false;
    await registry.refresh();
    expect((await keyRpc(origin, undefined, "tools/list", undefined, headers)).status).toBe(200);
    unavailable = true;
    time = 60_000;
    expect((await keyRpc(origin, undefined, "tools/list", undefined, headers)).status).toBe(200);
    time = 120_000;
    const expiredList = await keyRpc(origin, undefined, "tools/list", undefined, headers);
    expect(expiredList.status).toBe(503);
    expect(expiredList.headers.get("www-authenticate")).toBeNull();
    resources = [process.env.OAUTH_MCP_RESOURCE!];
    unavailable = false;
    await registry.refresh();
    expect((await keyRpc(origin, undefined, "tools/list", undefined, headers)).status).toBe(421);
    expect((await keyRpc(origin, undefined, "tools/list", undefined, { Authorization: `Bearer ${await token("mcp:read")}` })).status).toBe(200);
    expect(exchanges.length).toBe(beforeExchanges);
    expect(apiBearers.length).toBe(beforeApi);
  } finally { await close(server); }
});

test("private discovery sends only internal Basic credentials and refuses cross-origin redirects", async () => {
  privateResourcesMode = "redirect";
  const registry = new McpResourceRegistry(loadOAuthConfig());
  try {
    await expect(registry.forRequest({ headers: { host: new URL(mcpOrigin).host }, rawHeaders: ["Host", new URL(mcpOrigin).host] }))
      .rejects.toThrow("Authorization service unavailable");
    expect(leakedPrivateDiscovery).toBe(0);
    expect(privateDiscoveryHeaders.length).toBeGreaterThan(0);
    expect(privateDiscoveryHeaders.every((header) => header === basicClientAuthorization(process.env.OAUTH_INTERNAL_CLIENT_ID!, process.env.OAUTH_INTERNAL_CLIENT_SECRET!))).toBe(true);
  } finally {
    registry.stop();
    privateResourcesMode = "normal";
  }
});

test("missing token receives discoverable 401 challenge", async () => {
  const response = await rpc("tools/list");
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(`${mcpOrigin}/.well-known/oauth-protected-resource/mcp`);
  expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
});

test("missing OAuth configuration fails closed", () => {
  expect(() => loadOAuthConfig({})).toThrow("Invalid OAuth configuration");
  expect(() => loadOAuthConfig({ ...process.env, OAUTH_MCP_RESOURCE: "" })).toThrow("OAUTH_MCP_RESOURCE");
});

test("OAuth discovery uses RFC 8414 issuer paths and safe endpoint URLs", () => {
  expect(discoveryUrls("https://auth.example/tenant/")).toEqual([
    "https://auth.example/.well-known/oauth-authorization-server/tenant",
    "https://auth.example/tenant/.well-known/openid-configuration",
  ]);
  expect(discoveryUrls("https://auth.example")[0]).toBe("https://auth.example/.well-known/oauth-authorization-server");
  expect(() => oauthEndpoint("http://auth.example/oauth/token")).toThrow("HTTPS");
  expect(() => oauthEndpoint("https://user:secret@auth.example/oauth/token")).toThrow("credentials");
  expect(() => oauthEndpoint("https://auth.example/oauth/token#fragment")).toThrow("fragment");
  expect(oauthEndpoint("http://127.0.0.1/oauth/token").hostname).toBe("127.0.0.1");
});

test("client_secret_basic form-encodes reserved characters", () => {
  const clientId = `${crypto.randomUUID()}: /+`;
  const clientSecret = `${crypto.randomUUID()}: /+`;
  const header = basicClientAuthorization(clientId, clientSecret);
  const components = Buffer.from(header.slice("Basic ".length), "base64").toString().split(":");
  expect(components).toHaveLength(2);
  expect(components[0]).toContain("%3A+%2F%2B");
  expect(new URLSearchParams(`value=${components[0]}`).get("value")).toBe(clientId);
  expect(new URLSearchParams(`value=${components[1]}`).get("value")).toBe(clientSecret);
});

async function publicPreflight(): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["run", "scripts/check-oauth.ts"], {
    env: { ...process.env, OAUTH_ISSUER: issuer, OAUTH_MCP_RESOURCE: mcpOrigin + "/mcp" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("public deployment preflight validates metadata without token exchange or account calls", async () => {
  const beforeExchanges = exchanges.length;
  const beforeBusinessCalls = businessCalls.length;
  const result = await publicPreflight();
  expect(result.code).toBe(0);
  expect(result.output).toContain("Public OAuth checks passed");
  expect(result.output).not.toContain(process.env.OAUTH_INTERNAL_CLIENT_SECRET!);
  expect(exchanges.length).toBe(beforeExchanges);
  expect(businessCalls.length).toBe(beforeBusinessCalls);
  try {
    discoveryMode = "unavailable";
    const failed = await publicPreflight();
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("FAIL Authorization-server discovery");
  } finally {
    discoveryMode = "normal";
  }
});

test("discovery outages or invalid metadata fail without a reconnect and recover", async () => {
  const caller = await token("mcp:read");
  try {
    for (const mode of ["unavailable", "not_found", "mismatched_issuer", "unsafe_endpoint"] as const) {
      discoveryMode = mode;
      resetDiscovery();
      resetKeySet();
      const response = await rpc("tools/list", caller);
      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
      if (mode === "unavailable") expect(response.headers.get("retry-after")).toBe("10");
    }
    discoveryMode = "normal";
    // Failed discovery retries without restarting the MCP.
    expect((await rpc("tools/list", caller)).status).toBe(200);
  } finally {
    discoveryMode = "normal";
    resetDiscovery();
    resetKeySet();
  }
});

test("OpenID discovery fallback and unavailable JWKS are handled without false reconnects", async () => {
  const caller = await token("mcp:read");
  try {
    discoveryMode = "oidc_only";
    resetDiscovery();
    resetKeySet();
    expect((await rpc("tools/list", caller)).status).toBe(200);
    jwksUnavailable = true;
    resetKeySet();
    const response = await rpc("tools/list", caller);
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    jwksUnavailable = false;
    expect((await rpc("tools/list", caller)).status).toBe(200);
  } finally {
    discoveryMode = "normal";
    jwksUnavailable = false;
    resetDiscovery();
    resetKeySet();
  }
});

test("HTTP auth mode is explicit and API-key-only needs no OAuth settings", () => {
  expect(loadHttpConfig({}).authMode).toBe("oauth");
  expect(loadHttpConfig({ MCP_HTTP_AUTH: "api_key" }).authMode).toBe("api_key");
  expect(loadHttpConfig({ MCP_HTTP_AUTH: "both" }).authMode).toBe("both");
  expect(() => loadHttpConfig({ MCP_HTTP_AUTH: "none" })).toThrow("MCP_HTTP_AUTH");
  expect(() => loadHttpConfig({ MCP_ALLOW_API_KEY_QUERY: "maybe" })).toThrow("MCP_ALLOW_API_KEY_QUERY");
  expect(loadHttpConfig({}).toolProfile).toBe("full");
  expect(loadHttpConfig({ MCP_TOOL_PROFILE: "public" }).toolProfile).toBe("public");
  expect(() => loadHttpConfig({ MCP_TOOL_PROFILE: "anything" })).toThrow("MCP_TOOL_PROFILE");
  expect(loadHttpConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "portal-token" }).openaiAppsChallengeToken).toBe("portal-token");
  expect(loadHttpConfig({ OPENAI_APPS_CHALLENGE_TOKEN: "" }).openaiAppsChallengeToken).toBeUndefined();
});

test("optional public plugin domain challenge returns only the portal token", async () => {
  const path = "/.well-known/openai-apps-challenge";
  expect((await fetch(`${mcpOrigin}${path}`)).status).toBe(404);
  const previous = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  const token = crypto.randomUUID();
  let server: http.Server | undefined;
  try {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = token;
    const instance = await ephemeralMcp("api_key", true);
    server = instance.server;
    const response = await fetch(`${instance.origin}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(token);
    expect((await fetch(`${instance.origin}${path}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${instance.origin}/.well-known/openai-apps-challenge/extra`)).status).toBe(404);
  } finally {
    if (server) await close(server);
    if (previous === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    else process.env.OPENAI_APPS_CHALLENGE_TOKEN = previous;
  }
});

test("wrong audience is refused", async () => {
  const response = await rpc("tools/list", await token("mcp:read", apiOrigin));
  expect(response.status).toBe(401);
});

test("invalid signature is refused", async () => {
  const alien = await generateKeyPair("RS256");
  const forged = await new SignJWT({ scope: "mcp:read" })
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(process.env.OAUTH_MCP_RESOURCE!).setSubject("user-7")
    .setIssuedAt().setExpirationTime("1h").sign(alien.privateKey);
  expect((await rpc("tools/list", forged)).status).toBe(401);
});

test("expired and not-yet-valid tokens are refused", async () => {
  const expired = await new SignJWT({ scope: "mcp:read" })
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(process.env.OAUTH_MCP_RESOURCE!).setSubject("user-7")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 300).sign(privateKey);
  expect((await rpc("tools/list", expired)).status).toBe(401);
  const premature = await new SignJWT({ scope: "mcp:read" })
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(process.env.OAUTH_MCP_RESOURCE!).setSubject("user-7")
    .setNotBefore(Math.floor(Date.now() / 1000) + 300)
    .setExpirationTime("1h").sign(privateKey);
  expect((await rpc("tools/list", premature)).status).toBe(401);
});

test("read bearer sees and runs read tools, but not write tools; API gets only exchanged token", async () => {
  const caller = await token("mcp:read");
  const listed = await rpc("tools/list", caller);
  expect(listed.status).toBe(200);
  const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  expect(names).toContain("get_account_overview");
  expect(names).not.toContain("add_contact_to_list");
  // The generic request tool now also handles read-scoped POST searches.
  expect(names).toContain("magileads_request");
  expect(names).not.toContain("create_email_model");
  const response = await rpc("tools/call", caller, { name: "get_account_overview", arguments: {} });
  expect(response.status).toBe(200);
  expect(apiBearers.at(-1)).toBe("Bearer exchanged-mcp:read");
  expect(apiBearers.at(-1)).not.toBe(`Bearer ${caller}`);
  expect(exchanges.at(-1)?.subject).toBe(caller);
  expect(exchanges.at(-1)?.scope).toBe("mcp:read");
  expect(exchanges.at(-1)?.resource).toBe(process.env.OAUTH_API_RESOURCE);
  expect(exchanges.at(-1)?.authorization).toBe(`Basic ${Buffer.from(`${process.env.OAUTH_INTERNAL_CLIENT_ID}:${process.env.OAUTH_INTERNAL_CLIENT_SECRET}`).toString("base64")}`);
  expect(exchanges.at(-1)?.grant).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
  expect(exchanges.at(-1)?.subjectType).toBe("urn:ietf:params:oauth:token-type:access_token");
  expect(exchanges.at(-1)?.requestedType).toBe("urn:ietf:params:oauth:token-type:access_token");
  expect(exchanges.at(-1)?.contentType).toBe("application/x-www-form-urlencoded");
  expect(misplacedExchanges).toBe(0);
});

test("write tool with read bearer gives 403 and required scope", async () => {
  const response = await rpc("tools/call", await token("mcp:read"), { name: "add_contact_to_list", arguments: {} });
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  expect(response.headers.get("www-authenticate")).toContain('scope="mcp:read mcp:write"');
});

test("write scope does not imply read scope", async () => {
  const listed = await rpc("tools/list", await token("mcp:write"));
  expect(listed.status).toBe(200);
  const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  expect(names).toContain("extract_maps_search");
  expect(names).not.toContain("add_contact_to_list");
  expect(names).not.toContain("run_google_maps_targeting");
  expect(names).not.toContain("get_account_overview");
  const response = await rpc("tools/call", await token("mcp:write"), { name: "add_contact_to_list", arguments: {} });
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('scope="mcp:read mcp:write"');
});

test("contact import exchanges read and write scopes and completes its read-then-write API calls", async () => {
  const caller = await token("mcp:read mcp:write");
  const listed = await rpc("tools/list", caller);
  const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  expect(names).toContain("add_contact_to_list");
  const response = await rpc("tools/call", caller, {
    name: "add_contact_to_list",
    arguments: { contact_list_id: 42, properties: [{ field: "email", value: "test@example.com" }], confirm: true },
  });
  expect(response.status).toBe(200);
  const result = (await response.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content[0].text).executed).toBe(true);
  expect(exchanges.at(-1)?.scope).toBe("mcp:read mcp:write");
  expect(exchanges.at(-1)?.subject).toBe(caller);
  expect(businessCalls.slice(-3).map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
    "GET /contact-lists/42", "GET /data-fields", "POST /contact-lists/42/contact",
  ]);
  expect(businessCalls.slice(-3).every(({ bearer }) => bearer === "Bearer exchanged-mcp:read+mcp:write")).toBe(true);
});

test("Google Maps composite exchanges both scopes; standalone extract needs only write", async () => {
  const caller = await token("mcp:read mcp:write");
  const composite = await rpc("tools/call", caller, {
    name: "run_google_maps_targeting", arguments: { search: "plumber", contact_list_name: "Plumbers", confirm: true },
  });
  expect(composite.status).toBe(200);
  const compositeResult = (await composite.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
  expect(compositeResult.isError).not.toBe(true);
  expect(JSON.parse(compositeResult.content[0].text).contact_list_id).toBe(42);
  expect(exchanges.at(-1)?.scope).toBe("mcp:read mcp:write");
  expect(businessCalls.slice(-2).map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /targeting/google/generate-maps-search-urls", "POST /targeting/google/extract-maps-search",
  ]);

  const standalone = await rpc("tools/call", caller, {
    name: "extract_maps_search",
    arguments: { google_maps_search_urls: ["https://maps.google.com/search?q=plumber"], contact_list_name: "Plumbers", confirm: true },
  });
  expect(standalone.status).toBe(200);
  expect(exchanges.at(-1)?.scope).toBe("mcp:write");
});

test("token exchange accepts reordered scopes but refuses an unexpected extra scope", async () => {
  const caller = await token("mcp:read mcp:write");
  try {
    exchangeMode = "reordered_scopes";
    const accepted = await rpc("tools/call", caller, {
      name: "add_contact_to_list",
      arguments: { contact_list_id: 42, properties: [{ field: "email", value: "test@example.com" }], confirm: true },
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as { result: { isError?: boolean } }).result.isError).not.toBe(true);

    exchangeMode = "broader_scopes";
    clearExchangeCache();
    const refused = await rpc("tools/call", caller, {
      name: "add_contact_to_list",
      arguments: { contact_list_id: 42, properties: [{ field: "email", value: "test@example.com" }], confirm: true },
    });
    expect(refused.status).toBe(502);
  } finally {
    exchangeMode = "normal";
    clearExchangeCache();
  }
});

test("invalid_grant and API 401 both give fresh challenges", async () => {
  exchangeMode = "invalid_grant";
  clearExchangeCache();
  let response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  exchangeMode = "normal";
  apiMode = "unauthorized";
  clearExchangeCache();
  response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  apiMode = "normal";
});

test("internal client authentication failure is 502, not a user reconnect", async () => {
  try {
    exchangeMode = "unauthorized";
    clearExchangeCache();
    const before = apiBearers.length;
    const response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
    expect(response.status).toBe(502);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(apiBearers.length).toBe(before);
  } finally {
    exchangeMode = "normal";
    clearExchangeCache();
  }
});

test("token endpoint outages, limits, and redirects never forward credentials or reconnect", async () => {
  try {
    for (const mode of ["unavailable", "rate_limited", "redirect"] as const) {
      exchangeMode = mode;
      clearExchangeCache();
      const response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
      expect(response.status).toBe(503);
      expect(response.headers.get("www-authenticate")).toBeNull();
      if (mode !== "redirect") expect(response.headers.get("retry-after")).toBe("10");
    }
    expect(misplacedExchanges).toBe(0);
  } finally {
    exchangeMode = "normal";
    clearExchangeCache();
  }
});

test("only valid Bearer access-token responses reach the business API", async () => {
  try {
    for (const mode of ["invalid_type", "invalid_issued_type", "missing_expires", "expired", "invalid_scope_type"] as const) {
      exchangeMode = mode;
      clearExchangeCache();
      const before = apiBearers.length;
      const response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
      expect(response.status).toBe(502);
      expect(apiBearers.length).toBe(before);
    }
    exchangeMode = "omitted_optional";
    clearExchangeCache();
    expect((await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} })).status).toBe(200);
  } finally {
    exchangeMode = "normal";
    clearExchangeCache();
  }
});

async function keyRpc(origin: string, key: string | undefined, method: string, params?: unknown, extraHeaders: Record<string, string> = {}, suffix = ""): Promise<Response> {
  return fetch(`${origin}/mcp${suffix}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: new URL(process.env.OAUTH_MCP_RESOURCE!).host,
      ...(key !== undefined ? { "X-API-Key": key } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function ephemeralMcp(mode: "api_key" | "both", withoutOAuth = false, allowQuery = false, profile: "full" | "public" = "full"): Promise<{ server: http.Server; origin: string }> {
  const saved = {
    mode: process.env.MCP_HTTP_AUTH,
    allowQuery: process.env.MCP_ALLOW_API_KEY_QUERY,
    profile: process.env.MCP_TOOL_PROFILE,
    issuer: process.env.OAUTH_ISSUER,
    resource: process.env.OAUTH_MCP_RESOURCE,
  };
  try {
    process.env.MCP_HTTP_AUTH = mode;
    process.env.MCP_ALLOW_API_KEY_QUERY = allowQuery ? "true" : "false";
    process.env.MCP_TOOL_PROFILE = profile;
    if (withoutOAuth) {
      delete process.env.OAUTH_ISSUER;
      delete process.env.OAUTH_MCP_RESOURCE;
    }
    const server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    return { server, origin: `http://127.0.0.1:${address.port}` };
  } finally {
    if (saved.mode === undefined) delete process.env.MCP_HTTP_AUTH;
    else process.env.MCP_HTTP_AUTH = saved.mode;
    if (saved.allowQuery === undefined) delete process.env.MCP_ALLOW_API_KEY_QUERY;
    else process.env.MCP_ALLOW_API_KEY_QUERY = saved.allowQuery;
    if (saved.profile === undefined) delete process.env.MCP_TOOL_PROFILE;
    else process.env.MCP_TOOL_PROFILE = saved.profile;
    if (saved.issuer === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = saved.issuer;
    if (saved.resource === undefined) delete process.env.OAUTH_MCP_RESOURCE;
    else process.env.OAUTH_MCP_RESOURCE = saved.resource;
  }
}

test("public profile keeps dedicated tools but hides the generic passthrough", async () => {
  expect(isToolExposed("future_unreviewed_tool", "public")).toBe(false);
  expect(isToolExposed("future_unreviewed_tool", "full")).toBe(true);
  const { server, origin } = await ephemeralMcp("both", false, false, "public");
  try {
    const bearer = await token("mcp:read mcp:write");
    const listed = await keyRpc(origin, undefined, "tools/list", undefined, { Authorization: `Bearer ${bearer}` });
    expect(listed.status).toBe(200);
    const tools = (await listed.json() as { result: { tools: { name: string; description: string }[] } }).result.tools;
    const names = tools.map((tool) => tool.name);
    for (const name of ["create_email_model", "add_contact_to_list", "extract_maps_search", "run_google_maps_targeting"]) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain(CREATION_GUIDANCE);
    }
    expect(names).toHaveLength(23);
    expect(names).toContain("run_google_maps_targeting");
    expect(names).toContain("add_contact_to_list");
    expect(names).toContain("create_email_model");
    const beforeModelPreview = businessCalls.length;
    const preview = await keyRpc(origin, undefined, "tools/call", { name: "create_email_model",
      arguments: { name: "Public template", subject: "Hello", text: "Hello %first_name%" } },
      { Authorization: `Bearer ${bearer}` });
    expect(JSON.parse((await toolResult(preview)).content[0].text).dry_run).toBe(true);
    expect(businessCalls.length).toBe(beforeModelPreview);
    const created = await keyRpc(origin, undefined, "tools/call", { name: "create_email_model",
      arguments: { name: "Public template", subject: "Hello", text: "Hello %first_name%", confirm: true } },
      { Authorization: `Bearer ${bearer}` });
    expect((await toolResult(created)).isError).not.toBe(true);
    expect(businessCalls.at(-1)?.path).toBe("/models/email");
    for (const excluded of ["list_api_endpoints", "magileads_get", "magileads_request"]) {
      expect(names).not.toContain(excluded);
    }
    const beforeExchanges = exchanges.length;
    const hidden = await keyRpc(origin, undefined, "tools/call",
      { name: "magileads_request", arguments: { method: "POST", path: "/not-an-indexed-route", confirm: true } },
      { Authorization: `Bearer ${bearer}` });
    expect(hidden.status).toBe(200);
    const hiddenResult = await hidden.json() as { error?: unknown; result?: { isError?: boolean } };
    expect(hiddenResult.error !== undefined || hiddenResult.result?.isError === true).toBe(true);
    expect(exchanges.length).toBe(beforeExchanges);
    const keyListed = await keyRpc(origin, "key-alpha", "tools/list");
    expect((await keyListed.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(23);
  } finally {
    await close(server);
  }
});

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("API-key-only mode boots without OAuth and isolates keys per request", async () => {
  const { server, origin } = await ephemeralMcp("api_key", true);
  try {
    expect((await fetch(`${origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
    const missing = await keyRpc(origin, undefined, "tools/list");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBeNull();
    const formerHeader = await keyRpc(origin, undefined, "tools/list", undefined, { "X-Magileads-Api-Key": "key-alpha" });
    expect(formerHeader.status).toBe(401);

    const listed = await keyRpc(origin, "key-alpha", "tools/list");
    expect(listed.status).toBe(200);
    const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toContain("get_account_overview");
    expect(names).toContain("magileads_request");

    const beforeExchanges = exchanges.length;
    const [alpha, beta] = await Promise.all([
      keyRpc(origin, "key-alpha", "tools/call", { name: "get_account_overview", arguments: {} }),
      keyRpc(origin, "key-beta", "tools/call", { name: "get_account_overview", arguments: {} }),
    ]);
    expect(alpha.status).toBe(200);
    expect(beta.status).toBe(200);
    const alphaText = (await alpha.json() as { result: { content: { text: string }[] } }).result.content[0].text;
    const betaText = (await beta.json() as { result: { content: { text: string }[] } }).result.content[0].text;
    expect(JSON.parse(alphaText).id).toBe(71);
    expect(JSON.parse(betaText).id).toBe(72);
    expect(apiKeys).toContain("key-alpha");
    expect(apiKeys).toContain("key-beta");
    expect(exchanges.length).toBe(beforeExchanges);

    const bad = await keyRpc(origin, "bad-key", "tools/call", { name: "get_account_overview", arguments: {} });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBeNull();
  } finally {
    await close(server);
  }
});

test("custom reseller hosts work with API keys in api_key and both modes without OAuth exchange", async () => {
  for (const mode of ["api_key", "both"] as const) {
    const { server, origin } = await ephemeralMcp(mode, mode === "api_key");
    const seenHosts: (string | undefined)[] = [];
    server.on("request", (req) => seenHosts.push(req.headers.host));
    try {
      const beforeExchanges = exchanges.length;
      const beforeKeys = apiKeys.length;
      const hosts = ["mcp.surleads.com", "mcp.other-reseller.example"];
      for (const host of hosts) {
        expect((await fetch(`${origin}/health`, { headers: { Host: host } })).status).toBe(200);
        const initialized = await keyRpc(origin, "key-alpha", "initialize", {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reseller-test", version: "1" },
        }, { Host: host });
        expect(initialized.status).toBe(200);
        expect((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("magileads-mcp");
        const listed = await keyRpc(origin, "key-alpha", "tools/list", undefined, { Host: host });
        expect(listed.status).toBe(200);
        expect((await listed.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(26);
        // The hostname is an alias, not an account selector: two keys keep their identities on either host.
        for (const [key, id] of [["key-alpha", 71], ["key-beta", 72]] as const) {
          const result = await keyRpc(origin, key, "tools/call", { name: "get_account_overview", arguments: {} }, { Host: host });
          expect(result.status).toBe(200);
          expect(JSON.parse((await toolResult(result)).content[0].text).id).toBe(id);
        }
        const missing = await keyRpc(origin, undefined, "tools/list", undefined, { Host: host });
        expect(missing.status).toBe(mode === "both" && host === "mcp.other-reseller.example" ? 421 : 401);
        const bad = await keyRpc(origin, "bad-key", "tools/call", { name: "get_account_overview", arguments: {} }, { Host: host });
        expect(bad.status).toBe(401);
        expect(bad.headers.get("www-authenticate")).toBeNull();
      }
      expect(new Set(seenHosts)).toEqual(new Set(hosts));
      expect(apiKeys.slice(beforeKeys)).toEqual(["key-alpha", "key-beta", "bad-key", "key-alpha", "key-beta", "bad-key"]);
      expect(exchanges.length).toBe(beforeExchanges);
    } finally {
      await close(server);
    }
  }
});

test("dual mode keeps OAuth and API-key credentials separate", async () => {
  const { server, origin } = await ephemeralMcp("both");
  try {
    expect((await keyRpc(origin, undefined, "tools/list")).headers.get("www-authenticate")).toContain("resource_metadata=");
    expect((await keyRpc(origin, "key-alpha", "tools/call", { name: "get_account_overview", arguments: {} })).status).toBe(200);
    expect((await keyRpc(origin, undefined, "tools/list", undefined, { Authorization: `Bearer ${await token("mcp:read")}` })).status).toBe(200);
    expect((await keyRpc(origin, "key-alpha", "tools/list", undefined, { Authorization: `Bearer ${await token("mcp:read")}` })).status).toBe(400);
    expect((await keyRpc(origin, undefined, "tools/list", undefined, {}, "?api_key=key-alpha")).status).toBe(400);
  } finally {
    await close(server);
  }
});

test("API-key-only mode accepts legacy Bearer keys and opt-in URL keys", async () => {
  const { server, origin } = await ephemeralMcp("api_key", true, true);
  try {
    const bearer = await keyRpc(origin, undefined, "tools/call", { name: "get_account_overview", arguments: {} }, { Authorization: "Bearer key-alpha" });
    expect(bearer.status).toBe(200);
    const query = await keyRpc(origin, undefined, "tools/call", { name: "get_account_overview", arguments: {} }, {}, "?api_key=key-beta");
    expect(query.status).toBe(200);
    expect(apiKeys.slice(-2)).toEqual(["key-alpha", "key-beta"]);
    expect((await keyRpc(origin, "key-alpha", "tools/list", undefined, {}, "?token=key-beta")).status).toBe(400);
  } finally {
    await close(server);
  }
});

test("OAuth-only mode does not accept an API key", async () => {
  const response = await keyRpc(mcpOrigin, "key-alpha", "tools/list");
  expect(response.status).toBe(401);
  expect((await response.json() as { error: string }).error).toBe("API-key authentication is disabled.");
});

test("logger redacts nested credentials, JWTs, URLs, and Error causes", () => {
  const jwt = "abcdefgh.ijklmnop.qrstuvwx";
  const error = new Error(`Bearer opaque-token ${jwt}`, { cause: { authorization: "Bearer another-token", url: "https://x.test/?code=abc&token=def" } });
  const output = JSON.stringify(redact({ access_token: "one", nested: [error, { clientSecret: "two", code_verifier: "three", header: "Basic YWJjOmRlZg==" }] }));
  for (const secret of ["opaque-token", jwt, "another-token", "?code=abc", "token=def", "YWJjOmRlZg==", "one", "two", "three"]) {
    expect(output).not.toContain(secret);
  }
  expect(redactString("ordinary log line survives")).toBe("ordinary log line survives");
  const write = process.stderr.write;
  let emitted = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    emitted += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    log("info", "ordinary log line survives", { authorization: "Bearer live-token", query: "https://x.test/?code=live-code" });
  } finally {
    process.stderr.write = write;
  }
  expect(emitted).toContain("ordinary log line survives");
  expect(emitted).not.toContain("live-token");
  expect(emitted).not.toContain("live-code");
});
