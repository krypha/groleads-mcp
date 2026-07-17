# CLAUDE.md — Groleads Google Maps MCP server

Instructions for Claude Code working in **this** repository. (User-facing docs live in
[README.md](README.md); read it too.)

## What this is

A standalone **MCP server** (`@modelcontextprotocol/sdk` v1.x, TypeScript, ESM/NodeNext)
that exposes **Groleads / Magileads Google Maps targeting** as tools for AI agents.
It runs in production, deployed via Docker on Dokploy at **`mcp.groleads.com`**, and is
consumed by a **Nous Research Hermes Agent** over HTTP. No LinkedIn account is involved —
Google Maps targeting only needs Magileads credentials. The server is model-agnostic.

This repo was split out of the main Groleads Next.js app; it has **no dependency on that
app** and must stay that way.

## Architecture

```
src/magileads.ts   Self-contained Magileads API client. Dual auth from env:
                   MAGILEADS_API_KEY (X-API-Key) OR MAGILEADS_EMAIL+MAGILEADS_PASSWORD
                   (JWT via POST /users/authentication, auto-refreshed via
                   /users/authentication/refresh, 30s-early renewal, retry-once on 401).
                   Base URL MAGILEADS_API_BASE (default https://app.api-magileads.net).
src/tools.ts       The 8 tools + handlers. Every handler is wrapped so it NEVER throws
                   (returns {content:[...], isError:true} on failure via fail()). Inputs
                   are clamped (max_links 1–40, max_results 1–200, urls sliced to 10,
                   criteria capped at 30 — never silently dropped on a delete).
src/server.ts      buildServer() → McpServer with all tools registered. Shared by both
                   entry points.
src/index.ts       stdio transport (StdioServerTransport).
src/http.ts        HTTP transport: stateless StreamableHTTPServerTransport
                   (sessionIdGenerator: undefined, enableJsonResponse: true), a fresh
                   server+transport per request, GET /health, and auth (see below).
```

**The 8 tools:**

*Google Maps targeting* — `generate_maps_search_urls`, `extract_maps_search`,
`run_google_maps_targeting` (one-shot generate+extract).

*Contact lists* — `list_contact_lists`, `get_contact_list_status`.

*Contact manipulation* — `list_contact_fields` (read-only; the filterable fields of a
list), `preview_contact_selection` (read-only; counts a criteria selection, deletes
nothing), `delete_contacts_by_selection` (DESTRUCTIVE; deletes contacts by criteria
behind two guardrails — see below).

## Key behavioral facts (don't relearn these the hard way)

- **URL generation is slow (~30–60 s)** — the `generate-maps-search-urls` endpoint is
  location-aware. Not a bug. Use generous timeouts in any test harness.
- **Extraction is asynchronous** — `extract_maps_search` / `run_google_maps_targeting`
  return a `contact_list_id` immediately; the extraction job finishes later. Poll
  `get_contact_list_status` until the job state is `completed`.
- **stdio: stdout is sacred** — JSON-RPC only. All logs go to `console.error` (stderr).
- **Data fields are account-global** — `list_contact_fields` returns them from
  `GET /data-fields` (not per-list); they apply to every contact list. `identifier`
  (e.g. "email", "company") is what agents name; `data_field_id` is what the API filters on.

## Contact selection & deletion (the destructive path)

Filters go to Magileads as `ContactLists.ContactsSelection` on
`DELETE /contact-lists/{id}/contacts`:
`{ filter, contact_ids:[], excluded_contact_ids:[], reverse_selection }`.

- **filter** = `{ mode:'and'|'or', values:[{ field_name:<data_field_id as STRING>, type, value }] }`.
  An empty `{mode:'and',values:[]}` matches EVERY contact.
- **op → type** (verified against the swagger `Type` enum, note `start_with`/`end_with`,
  not `starts_*`): contains, not_contains, equals, not_equals, start_with, end_with,
  more_than, more_or_equal_than, less_than, less_or_equal_than, does_exist, does_not_exist.
  `tools.ts` accepts friendly aliases (`starts_with`, `gt`, `has_value`, `is_empty`, …).
- **target** `matching` → `reverse_selection:false` (delete the matches);
  `all_except_matching` → `reverse_selection:true` (keep only the matches, delete the rest).
- **Count / guardrail source**: `GET /contact-lists/{id}/contacts?options={per_page:1,filter}`
  → read `number_of_results`. `preview_*` returns this; `delete_*` RE-COUNTS it live.
- **Two guardrails in `delete_contacts_by_selection`**: (1) empty criteria are refused
  unless `delete_entire_list:true`; (2) `confirm_count` must equal the live `to_delete`
  or the delete is refused. Preview → pass its `to_delete` as `confirm_count`.
- Magileads login body is `{ email, password }` → `{ access_token, refresh_token }`.

## Auth (HTTP mode)

- `MCP_AUTH_TOKEN` is **required** in HTTP mode (network-reachable endpoint).
- A client authenticates with **either** `Authorization: Bearer <token>` **or**
  `?token=<token>` in the URL. The query form exists because the Hermes dashboard's
  "Add MCP server" form has no headers field (its "Environment" field is stdio-only).
- `/health` is intentionally unauthenticated.

## Commands

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm run start:http   # run HTTP locally (needs MCP_AUTH_TOKEN + Magileads creds)
npm run start        # run stdio locally
```

**Verify a change without an MCP client** — drive JSON-RPC over the transport directly:

```bash
# HTTP: start the server, then
curl -s -X POST 'localhost:8080/mcp?token=T' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For stdio, pipe newline-delimited JSON-RPC (`initialize` → `notifications/initialized`
→ `tools/list` → `tools/call`) into `node dist/index.js`.

`tools/list` needs no Magileads call, so a dummy `MAGILEADS_API_KEY=dummy` is enough to
smoke-test plumbing. A real `generate_maps_search_urls` call takes ~30–60 s and hits the
live API.

## Deployment

- `Dockerfile` (multi-stage, non-root, `CMD node dist/http.js`, HEALTHCHECK on /health)
  + `docker-compose.yml`. Dokploy builds the Dockerfile and terminates TLS at its proxy.
- Env in prod: `MCP_AUTH_TOKEN`, `MAGILEADS_API_KEY` (or email/password).

## Hermes integration

Register as a remote HTTP MCP server in Hermes (dashboard or `~/.hermes/config.yaml`):
`url: https://mcp.groleads.com/mcp` + token (via `?token=` in the URL, or an
`Authorization: Bearer` header in config.yaml). Hermes auto-discovers the tools.

## Conventions

- Keep `magileads.ts` free of any Groleads-app imports (standalone).
- New tools: register in `tools.ts`, validate + clamp inputs, wrap the body so it can't
  throw, return text content (JSON string) — mirror the existing 5.
- Never log secrets. Never write to stdout in stdio mode.
- Credentials come from env only — never hardcode them (not even test creds) in the repo.
