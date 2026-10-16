# Reseller OAuth deployment verification

Implements the backend's reseller MCP integration and private resource discovery
contracts supplied on 2026-10-16. This does not add business routes or change the
existing MCP tool scopes/confirmation rules.

## Backend and proxy prerequisites

1. `GET https://<configured issuer origin>/oauth/mcp-resources` must accept the same
   confidential HTTP Basic client used for Token Exchange and return HTTP 200,
   `{ "state": true, "resources": ["https://mcp.magileads.io/mcp", "https://mcp-engage.lebonlogiciel.com/mcp"] }`.
   List entries are strings, not objects. Keep this endpoint server-side; never put
   its credentials in a browser, MCP client, URL, command history or shared logs.
2. The list must reflect active `domain_mcp` records. No MCP allowlist environment
   variable is needed. The server replaces its list every 60 seconds; after an
   outage its last successful list expires at age 120 seconds, not 120 seconds
   after the failure. Unknown hosts get 421; missing/expired lists get 503.
3. The shared proxy must serve a valid TLS certificate for each registered domain
   and preserve the original Host plus `/mcp`, request body and auth headers.
   Do not redirect MCP requests to a different hostname. Forwarding headers do not
   override Host. Restrict direct access to the origin/container.
4. Backend access tokens must be RS256 JWTs with `typ: JWT` or `typ: at+jwt`, a
   subject, expiration, issuer, scopes and exactly one matching audience. A singleton
   `aud` array is also supported; multiple audiences are refused.

## Public checks (no credentials)

Run this command in a separate diagnostic shell for each resource; it does not
change production settings or require access to the private discovery endpoint:

```powershell
$env:OAUTH_ISSUER = 'https://app.api-magileads.net'
$env:OAUTH_MCP_RESOURCE = 'https://mcp-engage.lebonlogiciel.com/mcp'
bun run check:oauth
```

Repeat with `https://mcp.magileads.io/mcp`. Each must publish the exact domain-local
resource at both `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. POST `/mcp` without credentials must
return 401 and advertise the same domain's suffixed metadata URL. Do not treat a
successful `/health` as successful OAuth configuration.

## Client and negative checks

- In the affected OAuth client, add each resource separately, finish the common
  authorization/consent flow and call `get_account_overview`. Verify the identity
  actually authorized; do not send an email or consume targeting credits.
- In a controlled integration harness, present the Coefficy token to Magileads and
  vice versa. Expect 401 with the challenged domain's metadata URL, no business
  request and no Token Exchange. Do not share raw tokens or place them in logs.
- Deactivate a test reseller. After the next successful refresh its metadata and
  OAuth requests must be refused. The API independently checks active resources
  when granting/exchanging tokens; previously issued upstream tokens retain their
  bounded lifetime according to the backend contract.
- In a validation environment only, make private discovery fail. During the grace
  period expect the old list, then 503 when its age reaches 120 seconds. Restoration
  must replace the list and restore service without a restart. Keys in API-key
  mode must remain unaffected. Never perform this outage test on customer traffic.

`bun run typecheck` and `bun run test:oauth` validate local behavior. Production
deployment and external client authorization remain separate verification steps.
