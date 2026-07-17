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

## Transports

| Transport | Entry point | Use when |
| --- | --- | --- |
| **stdio** | `node dist/index.js` | The agent runs the server as a local subprocess (Claude Desktop/Code, Cursor, a local script). |
| **HTTP** | `node dist/http.js` | The agent connects over the network — a remote / containerized agent (e.g. Hermes in Docker). This is the deployed mode. |

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

```bash
npm install
npm run build

# stdio (local agent)
MAGILEADS_API_KEY=... npm start

# HTTP (remote agent) — listens on :8080/mcp
MAGILEADS_API_KEY=... MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http
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

The image runs `node dist/http.js`, listens on `8080`, runs as a non-root user, and
declares a `HEALTHCHECK` against `/health`.

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
├── magileads.ts   Self-contained Magileads client (dual auth + JWT refresh + API calls)
├── tools.ts       The 8 MCP tool definitions + handlers (input validation, error wrapping)
├── server.ts      buildServer() — creates an McpServer with all tools registered
├── index.ts       stdio entry point
└── http.ts        HTTP entry point (Streamable HTTP + bearer/query auth + /health)
Dockerfile         Multi-stage build; runs dist/http.js
docker-compose.yml Standalone deployment
```

`magileads.ts` is deliberately standalone — it does **not** import anything from the
Groleads app.

## Development

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run dev         # build + run stdio
npm run dev:http    # build + run HTTP
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
