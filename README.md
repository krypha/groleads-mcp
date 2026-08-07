# @groleads/mcp-google-maps

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes
**Groleads / Magileads Google Maps targeting** as tools for AI agents.

Turn a plain query — *"dentists in Lyon"* — into a filled Groleads contact list.
**No LinkedIn account** is needed, only Magileads credentials. The server is
**model-agnostic**: it works with any MCP-capable agent (Nous Research **Hermes**,
Claude Desktop/Code, Cursor, …), whatever LLM powers it (Claude, GPT, Ollama,
OpenRouter, …).

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
| `preview_contact_selection` | `contact_list_id`, `criteria[]`, `match?`, `target?` | `{ list_name, matched_count, total_count, to_delete, to_keep }` — **read-only** |
| `delete_contacts_by_selection` | `contact_list_id`, `criteria[]`, `match?`, `target?`, `confirm_count`, `delete_entire_list?` | `{ deleted, list_name, remaining }` — **destructive, guarded** |
| `list_campaigns` | `name?` (filter), `limit?` (1–100, default 50) | `{ campaigns[] }` — each `{ id, name, status, start_date, scenario_id }` |
| `get_campaign` | `campaign_id` | `{ id, name, status, channels[], scenario_id, target_lists:[{id,name,count}], total_contacts }` |
| `get_scenario` | `scenario_id` | `{ steps[] }` — each step with full `subject`/`body` (not truncated) |
| `get_campaign_statistics` | `campaign_id` | `{ aggregate, email, linkedin, by_action_type, per_step[] }` |
| `get_account_overview` | *(none)* | `{ id, name, email, level, subscription{…}, teams, organizations }` |
| `list_linkedin_accounts` | *(none)* | `{ count, valid, checkpoint, accounts[] }` |
| `search_contact_lists` | `name?`, `sort?` (name\|id), `per_page?` (1–100, default 25), `page?` | `{ total, pages, lists[] }` |
| `get_contact_list` | `contact_list_id` | `{ counts{…}, list_type, jobs[], in_progress }` |
| `query_contacts` | `contact_list_id`, `filter?`, `sort?`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — resolved field names, capped at 50 |
| `search_contacts` | `contact_list_id`, `query`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — resolved field names, capped at 50 |
| `list_prm_statuses` | *(none)* | `{ statuses[] }` — default + custom pipeline statuses |
| `query_prm_contacts` | `status?`, `only_positive?`, `search?`, `options?`, `per_page?` (1–50), `page?` | `{ total, contacts[] }` — capped at 50 |
| `get_prm_contact` | `contact_id` | `{ status, scoring, programmations[], calls[], history[] }` |
| `list_prm_nurturings` | *(none)* | `{ nurturings[] }` |
| `list_api_endpoints` | `search?`, `method?`, `reads_only?`, `writes_only?`, `limit?` | `{ endpoints[] }` — discover the callable non-admin API surface |
| `magileads_get` | `path`, `query?` | raw JSON — GET any non-admin endpoint (read-only) |
| `magileads_request` | `method`, `path`, `query?`, `body?`, `confirm?` | write any non-admin endpoint — **dry-run until `confirm:true`** |

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

Beyond building lists, the server can **prune** them by criteria — with a safety net so
an agent can't wipe a list by accident.

1. **Discover fields** — `list_contact_fields` returns the filterable fields
   (`identifier` like `email` / `company` / `first_name`, plus `data_field_id`, `label`,
   `type`). Name fields by their `identifier` in criteria.
2. **Preview** — `preview_contact_selection` counts what a selection would affect and
   **deletes nothing**. It returns `matched_count`, `total_count`, and — for the chosen
   `target` — `to_delete` / `to_keep`.
3. **Delete** — `delete_contacts_by_selection` removes contacts, behind two guardrails.

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
  `all_except_matching` (select everyone who does **not** match, i.e. keep only the matches).

**Guardrails on `delete_contacts_by_selection`:**

- **`confirm_count` is required** and must equal the **live** `to_delete` (re-counted at
  delete time). Pass the `to_delete` you got from `preview_contact_selection`. If the list
  changed in between (count differs), the delete is refused — preview again.
- **Empty criteria are refused** (they would match the whole list) unless you explicitly
  set `delete_entire_list: true`.

```
list_contact_fields → preview_contact_selection → (read to_delete) → delete_contacts_by_selection(confirm_count = to_delete)
```

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
- `search_contact_lists` — browse lists with paging + `name` filter, sorted by `name` or `id`.
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
> **Notes** are not part of the profile response (they live behind dedicated note endpoints
> this server doesn't expose); they may still appear as items inside `history`.

## Generic API access (everything else)

The dedicated tools above cover the common workflows. For anything else, three **generic
passthrough** tools reach the account's **entire non-admin API surface** (admin, billing,
reseller, team, and account-settings endpoints are excluded by an allowlist generated from
the API's OpenAPI spec — see [`src/endpoints.generated.ts`](src/endpoints.generated.ts)):

- `list_api_endpoints` — discover the callable endpoints (filter by `search`, `method`,
  reads/writes). Use it to find the exact `path` + `method`.
- `magileads_get` — **read-only**: GET any allow-listed endpoint. Pass `path` (with `{params}`
  filled in) and an optional `query` object (object values are JSON-encoded, e.g.
  `{ options: { per_page: 10 } }`). It even follows the API's own `next_page` / cursor URLs.
- `magileads_request` — **writes** (POST/PUT/DELETE/PATCH): create lists/models, send LinkedIn
  messages, imports, PRM exclusions, status changes, and so on.

> **Write guardrail.** `magileads_request` performs a **dry run by default** — it returns
> exactly what *would* be sent and changes nothing. Set `confirm: true` to actually execute.
> Admin/billing endpoints are refused outright. Regenerate the allowlist with
> `bun run gen:endpoints` if the API adds endpoints.

## Transports

| Transport | Entry point | Use when |
| --- | --- | --- |
| **stdio** | `bun run src/index.ts` | The agent runs the server as a local subprocess (Claude Desktop/Code, Cursor, a local script). |
| **HTTP** | `bun run src/http.ts` | The agent connects over the network — a remote / containerized agent (e.g. Hermes in Docker). This is the deployed mode. |

The HTTP transport is a stateless MCP **Streamable HTTP** endpoint at `POST /mcp`
(returns JSON), plus an unauthenticated `GET /health` liveness probe.

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)).

**Magileads authentication — pick ONE:**

| Variable(s) | Meaning |
| --- | --- |
| `MAGILEADS_API_KEY` | Sent as `X-API-Key` (preferred). |
| `MAGILEADS_EMAIL` + `MAGILEADS_PASSWORD` | JWT login, auto-refreshed. |
| `MAGILEADS_API_BASE` | Optional; defaults to `https://app.api-magileads.net`. |

**HTTP transport:**

| Variable | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | **Required in HTTP mode.** Clients must present this token (the endpoint is network-reachable). Generate one with `openssl rand -hex 32`. |
| `MCP_HTTP_PORT` | Listen port (default `8080`). |
| `MCP_HTTP_PATH` | MCP endpoint path (default `/mcp`). |

A client proves the token **either** way:

- `Authorization: Bearer <token>` header (preferred — used by config-file clients), **or**
- a `?token=<token>` query parameter on the URL (handy for dashboards that only
  expose a URL field — note the token may appear in reverse-proxy access logs).

## Run locally

The server runs on [Bun](https://bun.sh) (it executes the TypeScript directly — no build step).

```bash
bun install

# stdio (local agent)
MAGILEADS_API_KEY=... bun run start

# HTTP (remote agent) — listens on :8080/mcp
MAGILEADS_API_KEY=... MCP_AUTH_TOKEN=$(openssl rand -hex 32) bun run start:http
```

Smoke-test the HTTP endpoint:

```bash
curl -s localhost:8080/health                       # {"status":"ok"}
curl -s -X POST 'localhost:8080/mcp?token=YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Deploy with Docker / Dokploy

```bash
cp .env.example .env          # set MCP_AUTH_TOKEN + MAGILEADS_API_KEY
docker compose up -d --build
```

On **Dokploy**: create an app from this repo, let it build the `Dockerfile`, set the
env vars (`MCP_AUTH_TOKEN`, `MAGILEADS_API_KEY`), and give it a domain. Dokploy's
reverse proxy terminates TLS, so the agent reaches the server at
`https://<your-domain>/mcp`.

The image is Bun-based (`oven/bun`), runs `bun run src/http.ts`, listens on `8080`, runs as a
non-root user, and declares a `HEALTHCHECK` against `/health`.

## Connect to a Hermes Agent

[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) supports
remote HTTP MCP servers and discovers their tools automatically at startup.

### Option 1 — dashboard (simplest)

In the dashboard's **Add MCP server** form:

| Field | Value |
| --- | --- |
| **Name** | `groleads_gmaps` |
| **Transport** | `HTTP/SSE` |
| **URL** | `https://<your-domain>/mcp?token=<MCP_AUTH_TOKEN>` |
| **Environment** | *(leave empty — it applies to stdio servers only, not HTTP)* |

The token goes in the URL because this form has no headers field.

### Option 2 — config.yaml (cleaner, keeps the token out of the URL)

```yaml
mcp_servers:
  groleads_gmaps:
    url: "https://<your-domain>/mcp"
    headers:
      Authorization: "Bearer <MCP_AUTH_TOKEN>"
```

Either way, the Magileads credentials stay in **this** server — Hermes never sees
them. Hermes namespaces the tools as `groleads_gmaps.<tool>` (or similar) once
discovered.

## Project structure

```
src/
├── magileads.ts             Self-contained Magileads client (dual auth + JWT refresh + API calls)
├── tools.ts                 The 25 MCP tool definitions + handlers (input validation, error wrapping)
├── endpoints.generated.ts   Non-admin API allowlist for the generic passthrough tools (generated)
├── server.ts                buildServer() — creates an McpServer with all tools registered
├── index.ts                 stdio entry point
└── http.ts                  HTTP entry point (Streamable HTTP + bearer/query auth + /health)
scripts/generate-endpoints.mjs  Regenerates endpoints.generated.ts from the OpenAPI spec
Dockerfile                   Bun image (oven/bun); runs `bun run src/http.ts`
docker-compose.yml           Standalone deployment
```

`magileads.ts` is deliberately standalone — it does **not** import anything from the
Groleads app.

## Development

Runs on [Bun](https://bun.sh) — Bun executes the TypeScript directly, so there's no build
step for running; TypeScript is used only for type-checking.

```bash
bun install
bun run typecheck      # tsc --noEmit (type safety)
bun run dev            # run stdio
bun run dev:http       # run HTTP
bun run gen:endpoints  # refresh the non-admin API allowlist from the OpenAPI spec
bun run build          # optional: bundle to dist/ with `bun build`
```

The server logs to **stderr**. In stdio mode, **stdout is reserved** for the JSON-RPC
transport — never `console.log` to stdout there.

## Troubleshooting

- **Hermes shows the server but tools fail / 401** — the token is wrong or missing.
  Check the `?token=` in the URL (Option 1) or the `Authorization` header (Option 2)
  matches `MCP_AUTH_TOKEN` exactly.
- **Server won't start in HTTP mode** — `MCP_AUTH_TOKEN` is unset (required) or no
  Magileads credentials are configured.
- **`generate_*` seems to hang** — it's slow (~30–60 s), not stuck. Give clients a
  generous timeout.
- **Extraction "not finished"** — it's asynchronous. Poll `get_contact_list_status`
  until the job is `completed`.
- **A small/free model reports "done" too early** — that's a model-orchestration
  limitation, not the server. Prompt it to always check `get_contact_list_status`
  before claiming completion, or handle polling in the harness.
