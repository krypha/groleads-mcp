/** Public deployment checks only: no client secret, token exchange, or API writes. */
import { discoverAuthorizationServer, discoveryUrls, oauthEndpoint } from "../src/oauth/discovery.js";

const issuer = process.env.OAUTH_ISSUER;
const resource = process.env.OAUTH_MCP_RESOURCE;
if (!issuer || !resource) {
  console.error("Set OAUTH_ISSUER and OAUTH_MCP_RESOURCE (public URLs only). No client secret is needed.");
  process.exit(1);
}

let failed = false;
async function check(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    console.log(`OK ${label}`);
  } catch {
    // Never echo response bodies or fetch errors: a deployment may load .env.
    console.error(`FAIL ${label}`);
    failed = true;
  }
}

async function publicJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(oauthEndpoint(url), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("HTTP failure");
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON object");
  return body as Record<string, unknown>;
}

await check("Authorization-server discovery (issuer, token_endpoint, jwks_uri)", async () => {
  const metadata = await discoverAuthorizationServer(issuer);
  if (metadata.token_endpoint_auth_methods_supported &&
      !metadata.token_endpoint_auth_methods_supported.includes("client_secret_basic")) throw new Error("Missing Basic support");
  await check("Public signing keys (JWKS)", async () => {
    const jwks = await publicJson(metadata.jwks_uri);
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error("Missing signing keys");
  });
});

await check("MCP protected-resource metadata (exact resource and issuer)", async () => {
  const url = oauthEndpoint(resource);
  if (url.search || url.hash) throw new Error("Invalid resource");
  const path = url.pathname.replace(/\/+$/, "");
  const document = await publicJson(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  if (document.resource !== resource || !Array.isArray(document.authorization_servers) ||
      !document.authorization_servers.includes(issuer) || !Array.isArray(document.scopes_supported) ||
      !["mcp:read", "mcp:write"].every((scope) => (document.scopes_supported as unknown[]).includes(scope))) {
    throw new Error("Metadata mismatch");
  }
});

if (failed) {
  console.error("Check the public issuer discovery URLs, JWKS availability, and canonical MCP audience in deployment settings.");
  // Print paths, not URLs: no environment-derived credentials can appear here.
  try {
    for (const url of discoveryUrls(issuer)) console.error(`Discovery path: ${new URL(url).pathname}`);
  } catch { /* The invalid issuer is already reported above. */ }
  process.exit(1);
}
console.log("Public OAuth checks passed. A real client authorization + tool call is still needed to validate internal credentials and route scopes.");
