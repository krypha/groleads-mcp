import { afterAll, expect, test } from "bun:test";
import http from "node:http";
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
let exchangeMode: "normal" | "invalid_grant" | "unauthorized" = "normal";
let apiMode: "normal" | "unauthorized" = "normal";
const exchanges: { subject: string; scope: string; resource: string; authorization: string }[] = [];
const apiBearers: string[] = [];
const apiKeys: string[] = [];

const authorization = await start((req, res) => {
  if (req.url === "/.well-known/oauth-authorization-server") {
    respond(res, 200, { issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${apiOrigin}/oauth/token` });
  } else if (req.url === "/jwks") respond(res, 200, { keys: [jwk] });
  else respond(res, 404, {});
});
issuer = authorization.origin;

const api = await start(async (req, res) => {
  if (req.url === "/oauth/token" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    exchanges.push({
      subject: body.get("subject_token") || "",
      scope: body.get("scope") || "",
      resource: body.get("resource") || "",
      authorization: req.headers.authorization || "",
    });
    if (exchangeMode === "invalid_grant") return respond(res, 400, { error: "invalid_grant" });
    if (exchangeMode === "unauthorized") return respond(res, 401, { error: "invalid_client" });
    return respond(res, 200, { access_token: `exchanged-${body.get("scope")}`, expires_in: 300, scope: body.get("scope") });
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
process.env.OAUTH_INTERNAL_CLIENT_ID = "test-client";
process.env.OAUTH_INTERNAL_CLIENT_SECRET = "test-secret";
process.env.MCP_HTTP_PATH = "/mcp";
process.env.MAGILEADS_API_BASE = apiOrigin;

// The resource URL must be the actual server address; choose a free port first.
const reservation = await start((_req, res) => respond(res, 503, {}));
const resourcePort = new URL(reservation.origin).port;
await new Promise<void>((resolve) => reservation.server.close(() => resolve()));
process.env.OAUTH_MCP_RESOURCE = `http://127.0.0.1:${resourcePort}/mcp`;

const { createHttpServer } = await import("../src/http.js");
const { toolAccessTable } = await import("../src/tools.js");
const { clearExchangeCache } = await import("../src/oauth/exchange.js");
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

test("HTTP auth mode is explicit and API-key-only needs no OAuth settings", () => {
  expect(loadHttpConfig({}).authMode).toBe("oauth");
  expect(loadHttpConfig({ MCP_HTTP_AUTH: "api_key" }).authMode).toBe("api_key");
  expect(loadHttpConfig({ MCP_HTTP_AUTH: "both" }).authMode).toBe("both");
  expect(() => loadHttpConfig({ MCP_HTTP_AUTH: "none" })).toThrow("MCP_HTTP_AUTH");
  expect(() => loadHttpConfig({ MCP_ALLOW_API_KEY_QUERY: "maybe" })).toThrow("MCP_ALLOW_API_KEY_QUERY");
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
  expect(exchanges.at(-1)?.authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
});

test("write tool with read bearer gives 403 and required scope", async () => {
  const response = await rpc("tools/call", await token("mcp:read"), { name: "add_contact_to_list", arguments: {} });
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  expect(response.headers.get("www-authenticate")).toContain('scope="mcp:write"');
});

test("write scope does not imply read scope", async () => {
  const listed = await rpc("tools/list", await token("mcp:write"));
  expect(listed.status).toBe(200);
  const names = (await listed.json() as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  expect(names).toContain("add_contact_to_list");
  expect(names).not.toContain("get_account_overview");
});

test("a write call exchanges only write scope", async () => {
  const caller = await token("mcp:read mcp:write");
  const response = await rpc("tools/call", caller, { name: "add_contact_to_list", arguments: {} });
  expect(response.status).toBe(200); // The SDK rejects the intentionally incomplete tool arguments.
  expect(exchanges.at(-1)?.scope).toBe("mcp:write");
  expect(exchanges.at(-1)?.subject).toBe(caller);
});

test("invalid_grant and API 401 both give fresh challenges", async () => {
  exchangeMode = "invalid_grant";
  clearExchangeCache();
  let response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  exchangeMode = "unauthorized";
  clearExchangeCache();
  response = await rpc("tools/call", await token("mcp:read"), { name: "get_account_overview", arguments: {} });
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

async function ephemeralMcp(mode: "api_key" | "both", withoutOAuth = false, allowQuery = false): Promise<{ server: http.Server; origin: string }> {
  const saved = {
    mode: process.env.MCP_HTTP_AUTH,
    allowQuery: process.env.MCP_ALLOW_API_KEY_QUERY,
    issuer: process.env.OAUTH_ISSUER,
    resource: process.env.OAUTH_MCP_RESOURCE,
  };
  try {
    process.env.MCP_HTTP_AUTH = mode;
    process.env.MCP_ALLOW_API_KEY_QUERY = allowQuery ? "true" : "false";
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
    if (saved.issuer === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = saved.issuer;
    if (saved.resource === undefined) delete process.env.OAUTH_MCP_RESOURCE;
    else process.env.OAUTH_MCP_RESOURCE = saved.resource;
  }
}

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
