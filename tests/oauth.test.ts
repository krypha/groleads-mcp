import { afterAll, expect, test } from "bun:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

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
  "expired" | "invalid_scope_type" | "omitted_optional" | "redirect" = "normal";
let discoveryMode: "normal" | "unavailable" | "not_found" | "mismatched_issuer" | "unsafe_endpoint" | "oidc_only" = "normal";
let jwksUnavailable = false;
let apiMode: "normal" | "unauthorized" = "normal";
const exchanges: {
  subject: string; scope: string; resource: string; authorization: string;
  grant: string; subjectType: string; requestedType: string; contentType: string;
}[] = [];
const apiBearers: string[] = [];
const apiKeys: string[] = [];
const businessCalls: { method: string; path: string; bearer: string }[] = [];

function hasExchangedScope(req: http.IncomingMessage, scope: string): boolean {
  const bearer = req.headers.authorization;
  if (typeof bearer !== "string" || !bearer.startsWith("Bearer exchanged-")) return false;
  return bearer.slice("Bearer exchanged-".length).replaceAll("+", " ").split(" ").includes(scope);
}

// Authorization and business API live on DIFFERENT origins. The MCP must use
// the discovered token_endpoint, not assume it lives at the business API base.
const authorization = await start(async (req, res) => {
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
      token_endpoint: discoveryMode === "unsafe_endpoint" ? "http://untrusted.example/oauth/token" : `${new URL(issuer).origin}/oauth/token`,
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
      expires_in: exchangeMode === "expired" ? 0 : 300,
      scope: exchangeMode === "invalid_scope_type" ? [requestedScope] : responseScope,
    };
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
    if (req.headers.authorization !== "Bearer exchanged-mcp:read") return respond(res, 401, {});
    return respond(res, 200, { user_profile: { id: 7, first_name: "Test", last_name: "User", subscriptions: {} } });
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
const { isToolExposed, scopesForTool, scopeForRoute, toolAccessTable } = await import("../src/tools.js");
const { basicClientAuthorization, clearExchangeCache } = await import("../src/oauth/exchange.js");
const { discoveryUrls, oauthEndpoint, resetDiscovery } = await import("../src/oauth/discovery.js");
const { resetKeySet } = await import("../src/oauth/verify.js");
const { loadOAuthConfig } = await import("../src/oauth/config.js");
const { loadHttpConfig } = await import("../src/http-config.js");
const { log, redact, redactString } = await import("../src/log.js");
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
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setIssuer(issuer).setAudience(audience).setSubject("user-7")
    .setIssuedAt().setExpirationTime("1h").sign(privateKey);
}

async function rpc(method: string, bearer?: string, params?: unknown): Promise<Response> {
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

test("metadata is available at both RFC and bare paths with CORS", async () => {
  expect(toolAccessTable().size).toBe(25);
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
  expect(tools).toHaveLength(25);
  const openWorld = new Set([
    "generate_maps_search_urls", "extract_maps_search", "run_google_maps_targeting", "magileads_request",
  ]);
  const writes = new Set(["extract_maps_search", "run_google_maps_targeting", "add_contact_to_list", "magileads_request"]);
  for (const tool of tools) {
    expect(tool.annotations.openWorldHint).toBe(openWorld.has(tool.name));
    expect(tool.annotations.readOnlyHint).toBe(!writes.has(tool.name));
    expect(tool.annotations.destructiveHint).toBe(tool.name === "magileads_request");
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
  expect(names).not.toContain("magileads_request");
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
    name: "run_google_maps_targeting", arguments: { search: "plumber", contact_list_name: "Plumbers" },
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
    arguments: { google_maps_search_urls: ["https://maps.google.com/search?q=plumber"], contact_list_name: "Plumbers" },
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
      arguments: { contact_list_id: 42, properties: [{ field: "email", value: "test@example.com" }] },
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as { result: { isError?: boolean } }).result.isError).not.toBe(true);

    exchangeMode = "broader_scopes";
    clearExchangeCache();
    const refused = await rpc("tools/call", caller, {
      name: "add_contact_to_list",
      arguments: { contact_list_id: 42, properties: [{ field: "email", value: "test@example.com" }] },
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
    const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toHaveLength(22);
    expect(names).toContain("run_google_maps_targeting");
    expect(names).toContain("add_contact_to_list");
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
    expect((await keyListed.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(22);
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
