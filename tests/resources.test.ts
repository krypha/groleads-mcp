import { expect, test } from "bun:test";
import { loadOAuthConfig } from "../src/oauth/config.js";
import { basicClientAuthorization } from "../src/oauth/exchange.js";
import { McpResourceRegistry, parseMcpResources, requestAuthority } from "../src/oauth/resources.js";

const canonical = "https://mcp.magileads.io/mcp";
const reseller = "https://mcp-engage.lebonlogiciel.com/mcp";
const config = loadOAuthConfig({
  OAUTH_ISSUER: "https://app.api-magileads.net", OAUTH_MCP_RESOURCE: canonical,
  OAUTH_API_RESOURCE: "https://app.api-magileads.net",
  OAUTH_INTERNAL_CLIENT_ID: crypto.randomUUID(), OAUTH_INTERNAL_CLIENT_SECRET: crypto.randomUUID(),
});
const requestFor = (host: string) => ({ headers: { host }, rawHeaders: ["Host", host] });

function fixture() {
  const state = { time: 0, status: 200, payload: { state: true, resources: [canonical, reseller] } as unknown };
  const calls: { url: string; init?: RequestInit }[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(state.payload), { status: state.status });
  }) as typeof fetch;
  const registry = new McpResourceRegistry(config, request, () => state.time);
  return { state, calls, registry };
}

test("private resource discovery uses the issuer origin, GET and confidential Basic auth without redirects", async () => {
  const { registry, calls } = fixture();
  expect(await registry.forRequest(requestFor("mcp-engage.lebonlogiciel.com"))).toEqual({
    resource: reseller, metadataUrl: "https://mcp-engage.lebonlogiciel.com/.well-known/oauth-protected-resource/mcp",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://app.api-magileads.net/oauth/mcp-resources");
  expect(calls[0]!.init?.method).toBe("GET");
  expect(calls[0]!.init?.headers).toEqual({ Accept: "application/json", Authorization: basicClientAuthorization(config.clientId, config.clientSecret) });
  expect(calls[0]!.init?.redirect).toBe("error");
});

test("starting the registry prefetches once and stopping cancels its background lifecycle", async () => {
  const { registry, calls } = fixture();
  try {
    registry.start();
    registry.start();
    await registry.forRequest(requestFor("mcp.magileads.io"));
    expect(calls).toHaveLength(1);
  } finally { registry.stop(); }
});

test("at 60 seconds the list is atomically replaced, including removed canonical and reseller domains", async () => {
  const { registry, state, calls } = fixture();
  await registry.forRequest(requestFor("mcp.magileads.io"));
  state.time = 59_999;
  await registry.forRequest(requestFor("mcp-engage.lebonlogiciel.com"));
  expect(calls).toHaveLength(1);
  state.payload = { state: true, resources: ["https://mcp.surleads.com/mcp"] };
  state.time = 60_000;
  await expect(registry.forRequest(requestFor("mcp.magileads.io"))).rejects.toThrow("hostname is not authorized");
  await expect(registry.forRequest(requestFor("mcp-engage.lebonlogiciel.com"))).rejects.toThrow("hostname is not authorized");
  expect((await registry.forRequest(requestFor("mcp.surleads.com"))).resource).toBe("https://mcp.surleads.com/mcp");
  expect(calls).toHaveLength(2);
});

test("failure never extends the 120-second window since the last success; recovery replaces the list", async () => {
  const { registry, state, calls } = fixture();
  await registry.forRequest(requestFor("mcp.magileads.io"));
  state.status = 503;
  state.time = 60_000;
  expect((await registry.forRequest(requestFor("mcp.magileads.io"))).resource).toBe(canonical);
  state.time = 119_999;
  await registry.forRequest(requestFor("mcp.magileads.io"));
  expect(calls).toHaveLength(2);
  state.time = 120_000;
  await expect(registry.forRequest(requestFor("mcp.magileads.io"))).rejects.toThrow("Authorization service unavailable");
  state.time = 179_999;
  await expect(registry.forRequest(requestFor("mcp.magileads.io"))).rejects.toThrow("Authorization service unavailable");
  expect(calls).toHaveLength(3);
  state.status = 200;
  state.time = 180_000;
  state.payload = { state: true, resources: [canonical] };
  await registry.forRequest(requestFor("mcp.magileads.io"));
  await expect(registry.forRequest(requestFor("mcp-engage.lebonlogiciel.com"))).rejects.toThrow("hostname is not authorized");
});

test("an initial failure has no canonical fallback and concurrent requests share one fetch", async () => {
  const { registry, state, calls } = fixture();
  state.status = 401;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => registry.forRequest(requestFor("mcp.magileads.io"))));
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(calls).toHaveLength(1);
});

test("malformed lists are not partially trusted, and successful empty lists remove all access", async () => {
  for (const payload of [null, {}, { state: "true", resources: [canonical] }, { state: true, resources: {} },
    { state: true, resources: [canonical, { resource: reseller }] },
    { state: true, resources: [canonical, "https://evil.example/mcp/"] }]) {
    expect(() => parseMcpResources(payload, config)).toThrow();
  }
  const { registry, state } = fixture();
  await registry.forRequest(requestFor("mcp.magileads.io"));
  state.time = 60_000;
  state.payload = { state: true, resources: [] };
  await expect(registry.forRequest(requestFor("mcp.magileads.io"))).rejects.toThrow("hostname is not authorized");
});

test("reseller resources reject alternate paths, explicit ports, credentials and noncanonical URLs", () => {
  for (const value of ["http://mcp.surleads.com/mcp", "https://mcp.surleads.com:443/mcp",
    "https://mcp.surleads.com:8443/mcp", "https://mcp.surleads.com/mcp/", "https://mcp.surleads.com/other",
    "https://mcp.surleads.com/mcp?", "https://mcp.surleads.com/mcp#", "https://mcp.surleads.com/mcp?key=1",
    "https://user:pass@mcp.surleads.com/mcp", "https://MCP.SURLEADS.COM/mcp", "https://mcp.surleads.com./mcp",
    "https://*.surleads.com/mcp", "https://127.0.0.1/mcp", "https://localhost/mcp", config.apiResource,
    "https://mcp.surleads.com/a/../mcp", "https://mcp.surleads.com/%6dcp"]) {
    expect(() => parseMcpResources({ state: true, resources: [value] }, config)).toThrow();
  }
  expect(() => parseMcpResources({ state: true, resources: [canonical, canonical] }, config)).toThrow("Duplicate");
});

test("invalid and duplicate Host authorities cannot select a resource", () => {
  expect(requestAuthority(requestFor("MCP.SURLEADS.COM"))).toBe("mcp.surleads.com");
  for (const host of ["", "mcp.surleads.com,evil.example", "mcp.surleads.com/mcp", "user@mcp.surleads.com", " mcp.surleads.com", "mcp.surleads.com%00"]) {
    expect(() => requestAuthority(requestFor(host))).toThrow("hostname is not authorized");
  }
  expect(() => requestAuthority({ headers: { host: "mcp.magileads.io" }, rawHeaders: ["Host", "mcp.magileads.io", "Host", "mcp.surleads.com"] })).toThrow();
});

test("oversized and non-JSON private responses never authorize a resource", async () => {
  for (const body of ["x".repeat(256 * 1024 + 1), "<html>502 proxy error</html>"]) {
    const request = (async () => new Response(body)) as unknown as typeof fetch;
    const registry = new McpResourceRegistry(config, request);
    await expect(registry.forRequest(requestFor("mcp.magileads.io"))).rejects.toThrow("Authorization service unavailable");
  }
});
