# Magileads MCP

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes
**Magileads** as tools for AI agents — Google Maps targeting, contact lists, campaign
audit, PRM (pipeline), data queries, and every Magileads OpenAPI endpoint except DELETE.

Turn a plain query — *"dentists in Lyon"* — into a filled Magileads contact list, audit a
prospecting campaign, or read the whole account. **No LinkedIn account** is needed.
It **runs on [Bun](https://bun.sh)** and is **model-agnostic**: it
works with any MCP-capable agent (Nous Research **Hermes**, Claude Desktop/Code, Cursor, …),
whatever LLM powers it (Claude, GPT, Ollama, OpenRouter, …). The HTTP transport
supports OAuth 2.1, per-client Magileads API keys, or both; the local stdio
transport uses Magileads environment credentials.

---

## Contents

- [Tools](#tools)
- [How targeting works](#how-targeting-works)
- [Transports](#transports)
- [Configuration](#configuration)
- [Run locally](#run-locally)
- [Deploy with Docker / Dokploy](#deploy-with-docker--dokploy)
- [Connect to a Hermes Agent](#connect-to-a-hermes-agent)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `generate_maps_search_urls` | `search` (string), `locations?` (string[]), `max_links?` (1–40, default 20) | `{ count, urls[] }` — Google Maps search URLs |
| `extract_maps_search` | `google_maps_search_urls` (1–10), `max_results?` (1–200, default 100), `contact_list_name?` **or** `contact_list_id?` | `{ contact_list_id, … }` — extraction started |
| `run_google_maps_targeting` | `search`, `locations?`, `contact_list_name`, `max_links?`, `max_results?` | `{ contact_list_id, urls[], … }` — generate **+** extract in one call |
| `list_contact_lists` | `name?` (filter), `limit?` (1–200, default 25) | `{ total, lists[] }` |
| `get_contact_list_status` | `contact_list_id` | `{ id, name, contacts, emails, companies, jobs[] }` |
| `list_contact_fields` | `contact_list_id` | `{ fields[] }` — each `{ data_field_id, identifier, label, type }` |
| `add_contact_to_list` | `contact_list_id`, `properties:[{field,value}]`, `confirm?` | imports one contact — **dry-run until `confirm:true`** |
| `preview_contact_selection` | `contact_list_id`, `criteria[]`, `match?`, `target?` | `{ list_name, matched_count, total_count, selected, not_selected }` — **read-only** |
| `list_campaigns` | `name?` (filter), `limit?` (1–100, default 50) | `{ campaigns[] }` — each `{ id, name, status, start_date, scenario_id }` |
| `get_campaign` | `campaign_id` | `{ id, name, status, channels[], scenario_id, target_lists:[{id,name,count}], total_contacts }` |
| `get_scenario` | `scenario_id` | `{ steps[] }` — each step with full `subject`/`body` (not truncated) |
| `get_campaign_statistics` | `campaign_id` | `{ aggregate, email, linkedin, by_action_type, per_step[] }` |
| `get_account_overview` | *(none)* | `{ id, name, email, level, subscription{…}, teams, organizations }` |
| `list_linkedin_accounts` | *(none)* | `{ count, valid, checkpoint, accounts[] }` |
| `search_contact_lists` | `name?`, `sort?` (contacts\|emails\|linkedin\|companies\|recent\|name), `per_page?` (1–200, default 25), `page?` | `{ total_lists, total_contacts, lists[] }` — ranks across ALL lists |
| `get_contact_list` | `contact_list_id` | `{ counts{…}, list_type, jobs[], in_progress }` |
| `query_contacts` | `contact_list_id`, `filter?`, `sort?`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — resolved field names, capped at 50 |
| `search_contacts` | `contact_list_id`, `query`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — resolved field names, capped at 50 |
| `list_prm_statuses` | *(none)* | `{ statuses[] }` — default + custom pipeline statuses |
| `query_prm_contacts` | `status?`, `only_positive?`, `search?`, `options?`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — capped at 50 |
| `get_prm_contact` | `contact_id` | `{ status, scoring, programmations[], calls[], history[] }` |
| `list_prm_nurturings` | *(none)* | `{ nurturings[] }` |
| `list_api_endpoints` | `search?`, `method?`, `reads_only?`, `writes_only?`, `limit?` | `{ endpoints[] }` — discover every endpoint except DELETE |
| `magileads_get` | `path`, `query?` | raw JSON — GET any indexed endpoint (read-only) |
| `magileads_request` | `method`, `path`, `query?`, `body?`, `confirm?` | call any POST/PUT/PATCH endpoint — **dry-run until `confirm:true`** |

## How targeting works

1. **Generate** search URLs from a query (+ optional locations). ⚠️ This calls a
   location-aware endpoint and can take **~30–60 s** — that's normal.
2. **Extract** businesses from up to 10 URLs into a contact list. This is
   **asynchronous**: the tool returns a `contact_list_id` immediately, then the
   extraction runs in the background.
3. **Poll** `get_contact_list_status` until the extraction job reads `completed`.
   Only then are the counts final. Never assume "done" from the extract call alone.

`run_google_maps_targeting` combines steps 1 + 2 for convenience.

## Manipulating contacts in a list

`list_contact_fields` returns the available fields (`identifier` such as `email`,
`company`, or `first_name`, plus `data_field_id`, `label`, and `type`). Use those readable
identifiers in both contact imports and filters.

`add_contact_to_list` resolves each `{ field, value }` property to the exact Magileads
body `{ properties:[{ data_field_id, value }] }`, then calls
`POST /contact-lists/{contact_list_id}/contact`. It returns a dry run by default; pass
`confirm:true` to import. The API can report `contacts_updated` when an existing contact
is matched.

`preview_contact_selection` is read-only. It counts a filtered segment and returns
`matched_count`, `total_count`, `selected`, and `not_selected`.

**Criteria** are `{ field, op, value? }` objects:

| `op` (aliases) | Meaning |
| --- | --- |
| `contains` / `not_contains` | substring match |
| `equals` / `not_equals` | exact match |
| `starts_with` / `ends_with` | prefix / suffix |
| `greater_than` (`gt`) / `greater_or_equal` / `less_than` (`lt`) / `less_or_equal` | numeric compare |
| `has_value` (`does_exist`) / `is_empty` (`does_not_exist`) | existence — **no `value` needed** |

- **`match`**: `all` (AND, default) or `any` (OR) across the criteria.
- **`target`**: `matching` (default — select the contacts that match) or
  `all_except_matching` (select everyone who does **not** match).

```
list_contact_fields → add_contact_to_list (dry run) → add_contact_to_list(confirm = true)
```

No HTTP `DELETE` operation is present in the generated endpoint index or accepted by a
tool.

## Auditing a prospecting campaign

Four **read-only** tools expose everything an agent needs to audit a campaign. They return
**raw, complete** data — the analysis is the agent's job, not the server's; nothing is
summarized or truncated.

In Magileads terms: a **campaign** is a *programmation*, and a **scenario** is the
*workflow* (step template) it runs.

1. `list_campaigns` — find campaigns (by `name` substring). Each has a `scenario_id`.
2. `get_campaign` — a campaign's setup: channels, `target_lists` (with live counts), and
   `total_contacts`.
3. `get_scenario` — the ordered steps with the **complete message content** (`subject` +
   `body`) for every email / LinkedIn / SMS step, fetched from the underlying templates.
4. `get_campaign_statistics` — `aggregate` (whole-campaign) **and** `per_step` (the crucial
   detail), plus convenience `email` / `linkedin` / `by_action_type` blocks and computed
   `open_rate` / `click_rate` / `reply_rate`.

`get_scenario` and `get_campaign_statistics` share the same `step_id`, so each message
can be correlated to its own stats.

> **Metric honesty.** The API reports **unique-contact** counts (contacts who opened /
> clicked / replied) and `contacted` = sent. It does **not** provide `delivered`, total
> (non-unique) opens, or a LinkedIn *invites-accepted* count — those fields are returned as
> `null` so the agent can tell facts from gaps. The `email` / `linkedin` / `by_action_type`
> blocks and the rates are **derived** (summed / computed), never returned by the API.

The campaign / scenario must belong to the account configured on the server; otherwise the
API returns `unauthorized_workflow` / `unauthorized_workflow_programmation`.

```
list_campaigns → get_campaign → get_scenario (messages) + get_campaign_statistics (per-step) → agent correlates by step_id
```

## Querying the account's data (read-only)

Six **read-only** tools let an agent explore everything in the account without changing a
thing. Responses are **compact and capped** (agents have limited context): they summarize,
paginate, and never dump giant raw payloads.

- `get_account_overview` — who's connected: identity + plan/subscription status. *(The API
  exposes subscription status but **no numeric credit balance**, so credits aren't reported.)*
- `list_linkedin_accounts` — connected LinkedIn accounts and their health (`is_valid`,
  `checkpoint_required`, …), so you can tell whether LinkedIn steps will run.
- `search_contact_lists` — **rank** lists across the whole account (`sort` by contacts, emails,
  linkedin, companies, recent, or name) + `name` filter. Returns `total_lists` and
  `total_contacts`. Fetches all lists in one call, so "biggest lists" is correct even on large
  accounts (and it's faster).
- `get_contact_list` — one list's counters, type, and job state (`in_progress` tells you if
  an import/extraction is still running).
- `query_contacts` — a list's contacts with a Magileads `filter` + `sort`. Field names may be
  **human identifiers** (`email`, `company`, `first_name`, …) — resolved to field ids for you —
  and each contact is returned with **resolved, readable** property names. **Capped at 50 rows**
  per call; page through for more.
- `search_contacts` — the same, but by a free-text `query` across fields.

> **Pagination.** Contacts use cursor pagination: the first call creates a cursor and the
> tool follows it for `page` > 1 automatically — just pass `page`.

## Querying the PRM / pipeline (read-only)

Four **read-only** tools expose the **PRM** (Magileads' CRM / prospection pipeline) so an
agent can see where each prospect stands. No writes — no status changes, notes, calls,
exclusions, LinkedIn sends, imports, or deletes.

- `list_prm_statuses` — the pipeline's statuses (built-in ones like `opener`/`answerer`, plus
  the account's custom statuses with their ids/names/colors). This is the referential that
  maps a contact's `custom_status` id to a name.
- `query_prm_contacts` — browse PRM contacts. Convenience filters: `status` (a default key, a
  custom-status name, or its id), `only_positive`, and `search` (across all fields); or pass a
  raw Magileads `options` object. Contacts come back with resolved names, status/custom_status
  (name + color), `is_positive`, `score`, and `new_reply`. **Capped at 50 rows.**
- `get_prm_contact` — one prospect's full record: resolved properties, status, `is_positive`,
  `score`/`amount`/`probability`, an aggregated engagement `scoring`
  (opens/clicks/answers/±/invites), `calls`, `programmations` (per-campaign
  unsubscribed/blacklisted/excluded flags + scoring), and the reply/interaction `history`.
- `list_prm_nurturings` — the account's nurturing sequences.

> **Read-only, deliberately.** `get_prm_contact` does **not** pass the API's
> `set_new_reply_read` flag, so viewing a prospect never marks their replies as read.
> **Notes** are not part of the profile response. Dedicated note endpoints can be discovered
> and called through the generic API tools; they may also appear as items inside `history`.

## Generic API access (everything else)

The dedicated tools above cover the common workflows. For anything else, three **generic
passthrough** tools reach every operation in the API's OpenAPI specification except HTTP
`DELETE`, including admin, billing, reseller, team, API-key, and account endpoints. The
generated index is committed in [`src/endpoints.generated.ts`](src/endpoints.generated.ts).

- `list_api_endpoints` — discover the callable endpoints (filter by `search`, `method`,
  reads/writes). Use it to find the exact `path` + `method`.
- `magileads_get` — **read-only**: GET any allow-listed endpoint. Pass `path` (with `{params}`
  filled in) and an optional `query` object (object values are JSON-encoded, e.g.
  `{ options: { per_page: 10 } }`). It even follows the API's own `next_page` / cursor URLs.
- `magileads_request` — **writes** (POST/PUT/PATCH): create lists/models, send LinkedIn
  messages, imports, PRM exclusions, status changes, and so on.

> **Write guardrail.** `magileads_request` performs a **dry run by default** — it returns
> exactly what *would* be sent and changes nothing. Set `confirm: true` to actually execute.
> HTTP `DELETE` is refused outright. Regenerate the endpoint index with
> `bun run gen:endpoints` if the API adds endpoints.

## Transports

| Transport | Entry point | Use when |
| --- | --- | --- |
| **stdio** | `bun run src/index.ts` | The agent runs the server as a local subprocess (Claude Desktop/Code, Cursor, a local script). |
| **HTTP** | `bun run src/http.ts` | The agent connects over the network — a remote / containerized agent (e.g. Hermes in Docker). This is the deployed mode. |

The HTTP transport is a stateless MCP **Streamable HTTP** endpoint at `POST /mcp`
(returns JSON), plus an unauthenticated `GET /health` liveness probe.

## Authentication (HTTP)

Choose `MCP_HTTP_AUTH=oauth` (default), `api_key`, or `both`. In `api_key` mode,
the HTTP server starts without any OAuth configuration. In `both` mode, each
request chooses **one** method; a Magileads API key and an OAuth bearer in the
same request are rejected. There is no fallback to the server's environment
credentials for HTTP requests.

For API-key access, each client sends its **own** Magileads key in
`X-API-Key`. The MCP sends it to the Magileads API under that same header for
that request only, so clients use separate Magileads accounts. In `api_key`-only
mode, `Authorization: Bearer <Magileads API key>` also works for legacy clients.
In `both` mode, `Authorization: Bearer` is reserved for OAuth; use the explicit
`X-API-Key` header for API keys. Keys in `?api_key=` or `?token=` are
disabled by default because URLs can appear in proxy logs. Set
`MCP_ALLOW_API_KEY_QUERY=true` only for a URL-only legacy client when you accept
that risk. Always use HTTPS in production. A bad key receives HTTP `401` when a
tool calls the Magileads API; `tools/list` itself makes no backend call. API-key
clients see the full tool set (including write tools); Magileads account permissions
and each tool's confirmation guardrails still apply.

For OAuth access, the bearer must be signed by `OAUTH_ISSUER`, name
`OAUTH_MCP_RESOURCE` in its audience, and carry `mcp:read` and/or `mcp:write`.
A token intended for the API is rejected. An unauthenticated request receives
`401` plus `WWW-Authenticate` pointing at protected-resource metadata. Both the
bare metadata URL and the RFC 9728 URL suffixed with `/mcp` are served with CORS
support when OAuth is enabled.

Before a `tools/call`, the MCP exchanges the caller's bearer at the Magileads
`/oauth/token` endpoint for a new bearer addressed to `OAUTH_API_RESOURCE` and
limited to **exactly one** tool scope. The caller's bearer is never forwarded to
the API. `tools/list` offers only tools covered by the caller's scopes; there is
no implicit write-to-read scope inheritance. A missing tool scope returns `403`
with `insufficient_scope`; an expired/revoked token or API `401` returns a fresh
`401` challenge.

The local stdio transport still uses its separate environment credentials.

## Configuration

All via environment variables (see [`.env.example`](.env.example)). OAuth modes
refuse to start unless all five required OAuth settings are present.

| Variable(s) | Meaning |
| --- | --- |
| `MCP_HTTP_AUTH` | `oauth` (default), `api_key`, or `both`. |
| `MCP_ALLOW_API_KEY_QUERY` | `false` (default); opt in to URL keys only for clients unable to send a header. |
| `OAUTH_ISSUER` | Required for OAuth modes; authorization-server issuer, equal to JWT `iss`. |
| `OAUTH_MCP_RESOURCE` | Required for OAuth modes; exact resource URL/audience for this MCP, e.g. `https://mcp.example.com/mcp`. |
| `OAUTH_API_RESOURCE` | Required for OAuth modes; API resource/audience requested during token exchange; must differ from the MCP resource. |
| `OAUTH_INTERNAL_CLIENT_ID` + `OAUTH_INTERNAL_CLIENT_SECRET` | Required for OAuth modes; confidential token-exchange client. Store the secret in the deployment secret store. |
| `MAGILEADS_API_URL` | Optional API base URL; defaults to `OAUTH_API_RESOURCE`. |
| `OAUTH_JWKS_URI` | Optional JWKS override; otherwise resolved from issuer discovery. |
| `OAUTH_CLOCK_TOLERANCE` | Optional JWT clock tolerance in seconds (default `60`). |
| `MAGILEADS_API_KEY` or `MAGILEADS_EMAIL` + `MAGILEADS_PASSWORD` | Optional credentials for **stdio only**; never a default HTTP account. |
| `MAGILEADS_API_BASE` | Optional API-key HTTP and stdio API base URL (default `https://app.api-magileads.net`). |
| `MCP_HTTP_PORT` | Listen port (default `8080`). |
| `MCP_HTTP_PATH` | MCP endpoint path (default `/mcp`). |

> **stdio** is always single-account — it uses the `MAGILEADS_*` env credentials (there is no
> per-request key over stdio).

## Run locally

The server runs on [Bun](https://bun.sh) (it executes the TypeScript directly — no build step).

```bash
bun install

# stdio (local agent) — single account from env
MAGILEADS_API_KEY=... bun run start

# HTTP OAuth — set the five required OAUTH_* values through your secret store first
bun run start:http

# HTTP API-key-only — no OAuth settings required
MCP_HTTP_AUTH=api_key bun run start:http
```

Smoke-test discovery and the unauthenticated challenge:

```bash
curl -s localhost:8080/health                       # {"status":"ok"}
curl -s localhost:8080/.well-known/oauth-protected-resource/mcp
curl -i -X POST localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# Expected: 401 with WWW-Authenticate pointing to the metadata URL.

# API-key-only or dual mode: each client supplies its own key
curl -s -X POST localhost:8080/mcp \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy with Docker / Dokploy

The Docker image runs the HTTP server on container port `8080`; expose it through
an HTTPS reverse proxy and route the public MCP URL to `/mcp`. `GET /health` is
unauthenticated and can be used as the health check. Configure the variables in
Dokploy's environment/secret settings, or in an uncommitted `.env` file for
Docker Compose (`.env` is git-ignored). **Do not put a customer's API key in the
server environment:** each client supplies its own `X-API-Key` header.

Choose one deployment profile:

| Clients | `MCP_HTTP_AUTH` | Variables to set on the server |
| --- | --- | --- |
| Static Magileads API keys only (for example, a Hermes client without OAuth) | `api_key` | `MCP_HTTP_AUTH=api_key`; optionally `MAGILEADS_API_BASE` if the API is not at its default URL. No `OAUTH_*` values are needed. |
| OAuth-capable clients only | `oauth` | The five `OAUTH_*` values below. |
| OAuth clients **and** API-key clients on the same URL | `both` | `MCP_HTTP_AUTH=both` plus the same five `OAUTH_*` values. |

For an API-key-only deployment, the minimal Compose/Dokploy configuration is:

```dotenv
MCP_HTTP_AUTH=api_key
MCP_ALLOW_API_KEY_QUERY=false
# MAGILEADS_API_BASE=https://app.api-magileads.net  # default
```

For OAuth or dual-mode deployment, obtain these values from the Magileads
authorization-server team and store the client secret as a deployment secret:

```dotenv
# Use oauth instead of both if API-key access must be disabled.
MCP_HTTP_AUTH=both
OAUTH_ISSUER=https://<magileads-authorization-server-issuer>
OAUTH_MCP_RESOURCE=https://<your-public-mcp-domain>/mcp
OAUTH_API_RESOURCE=https://<magileads-api-resource-audience>
OAUTH_INTERNAL_CLIENT_ID=<token-exchange-client-id>
OAUTH_INTERNAL_CLIENT_SECRET=<token-exchange-client-secret>
MCP_ALLOW_API_KEY_QUERY=false
```

`OAUTH_MCP_RESOURCE` must be the **exact public MCP URL**, including `/mcp`
(or the configured `MCP_HTTP_PATH`); it is the audience accepted by this server.
`OAUTH_API_RESOURCE` is the **different** audience requested for tokens sent to
the Magileads API. The authorization server must publish OAuth discovery/JWKS,
support authorization code + PKCE for clients, and permit this internal client
to exchange MCP-audience tokens for API-audience tokens. If the API's network
base URL differs from `OAUTH_API_RESOURCE`, set `MAGILEADS_API_URL` too (when
using the supplied Compose file, uncomment its `MAGILEADS_API_URL` environment
line). OAuth modes fail at startup if a required value is missing.

```bash
docker compose up -d --build
```

On **Dokploy**: create an app from this repo, build the `Dockerfile`, set the
selected profile's variables, attach a domain, and terminate TLS at Dokploy's
reverse proxy. Point its upstream at container port `8080`. Keep
`MCP_ALLOW_API_KEY_QUERY=false` unless a legacy client truly cannot set a
header; query-string keys can leak through proxy logs. In `both` mode, clients
using API keys send `X-API-Key`; `Authorization: Bearer` is reserved for OAuth.
If Compose publishes host port `8080`, restrict direct public access to that
port so clients reach the service through HTTPS.

The image is Bun-based (`oven/bun`), runs `bun run src/http.ts`, listens on `8080`, runs as a
non-root user, and declares a `HEALTHCHECK` against `/health`.

After deployment, check `https://<your-public-mcp-domain>/health`. For OAuth,
also check `/.well-known/oauth-protected-resource/mcp`; for API keys, make a
real tool call (for example `get_account_overview`) using a test account's
`X-API-Key`. A successful `tools/list` alone does **not** validate the key
against Magileads.

## Connect to a Hermes Agent

[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) supports
remote HTTP MCP servers and discovers their tools automatically at startup.

An OAuth-capable Hermes client can connect in `oauth` or `both` mode. A Hermes
client that only supports static credentials can use `api_key` or `both` mode:
set its MCP URL to `https://<your-domain>/mcp` and configure its own
`X-API-Key` header. If it cannot set headers, URL keys require the
explicit `MCP_ALLOW_API_KEY_QUERY=true` opt-in described above.

## Project structure

```
src/
├── magileads.ts             Self-contained Magileads client (dual auth + JWT refresh + API calls)
├── tools.ts                 The 25 MCP tool definitions + handlers (input validation, error wrapping)
├── endpoints.generated.ts   All OpenAPI operations except DELETE (generated)
├── server.ts                buildServer() — creates an McpServer with all tools registered
├── index.ts                 stdio entry point
├── oauth/                  OAuth config, JWT verification, metadata, token exchange
├── http-config.ts          HTTP authentication mode and key-in-URL opt-in
├── log.ts                  Credential-redacting stderr logger
└── http.ts                  OAuth/API-key Streamable HTTP + /health
scripts/generate-endpoints.mjs  Regenerates endpoints.generated.ts from the OpenAPI spec
scripts/tool-table.ts         Prints the declared tool/route/scope table
tests/oauth.test.ts           Isolated OAuth and fake-API smoke tests
Dockerfile                   Bun image (oven/bun); runs `bun run src/http.ts`
docker-compose.yml           Standalone deployment
```

`magileads.ts` is deliberately standalone — it does **not** import anything from any
parent app.

## Development

Runs on [Bun](https://bun.sh) — Bun executes the TypeScript directly, so there's no build
step for running; TypeScript is used only for type-checking.

```bash
bun install
bun run typecheck      # tsc --noEmit (type safety)
bun run dev            # run stdio
bun run dev:http       # run HTTP
bun run gen:endpoints  # refresh the all-except-DELETE API index from the OpenAPI spec
bun run tools:table     # print the tool/route/scope table for the API team
bun run test:oauth     # fake issuer, token exchange, and API smoke test
bun run build          # optional: bundle to dist/ with `bun build`
```

The server logs to **stderr**. In stdio mode, **stdout is reserved** for the JSON-RPC
transport — never `console.log` to stdout there.

## Troubleshooting

- **HTTP `401` with `WWW-Authenticate`** — complete or repeat OAuth authorization.
  Check issuer, resource audience, expiry, and token exchange at the backend.
- **HTTP `401` without `WWW-Authenticate`** — check the client's Magileads API key.
- **HTTP `403 insufficient_scope`** — request the indicated `mcp:read` or `mcp:write`
  scope. A write-only token does not imply read access.
- **Every HTTP client sees the same account** — check that the Magileads
  authorization server issues distinct user tokens and that the token exchange
  preserves each subject's account identity.
- **`generate_*` seems to hang** — it's slow (~30–60 s), not stuck. Give clients a
  generous timeout.
- **Extraction "not finished"** — it's asynchronous. Poll `get_contact_list_status`
  until the job is `completed`.
- **A small/free model reports "done" too early** — that's a model-orchestration
  limitation, not the server. Prompt it to always check `get_contact_list_status`
  before claiming completion, or handle polling in the harness.
