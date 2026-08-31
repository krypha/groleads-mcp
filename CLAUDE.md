# CLAUDE.md — Magileads MCP server

Instructions for Claude Code working in **this** repository. (User-facing docs live in
[README.md](README.md); read it too.)

## What this is

A standalone **MCP server** (`@modelcontextprotocol/sdk` v1.x, TypeScript, ESM/NodeNext)
that exposes **Magileads** as tools for AI agents (Google Maps targeting, contact
lists, campaign audit, PRM, plus a generic non-admin API passthrough).
**Runs on Bun** — Bun executes the TypeScript entry points directly, so there is **no build
step to run** (`tsc` is used only for type-checking). It runs in production, deployed via
Docker on Dokploy (behind a domain of your choice), and is consumed by a **Nous Research
Hermes Agent** over HTTP. No LinkedIn account is required. The server is model-agnostic.

This repo is standalone; it has **no dependency on any parent app** and must stay that way.

## Architecture

```
src/magileads.ts   Self-contained Magileads API client. Dual auth from env:
                   MAGILEADS_API_KEY (X-API-Key) OR MAGILEADS_EMAIL+MAGILEADS_PASSWORD
                   (JWT via POST /users/authentication, auto-refreshed via
                   /users/authentication/refresh, 30s-early renewal, retry-once on 401).
                   Base URL MAGILEADS_API_BASE (default https://app.api-magileads.net).
src/tools.ts       The 25 tools + handlers. Every handler is wrapped so it NEVER throws
                   (returns {content:[...], isError:true} on failure via fail()). Inputs
                   are clamped (max_links 1–40, max_results 1–200, urls sliced to 10,
                   criteria capped at 30 — never silently dropped on a delete).
src/endpoints.generated.ts  GENERATED non-admin API allowlist (method/path/tag/summary) that
                   the generic passthrough tools may call. Regenerate with
                   `bun run gen:endpoints` (scripts/generate-endpoints.mjs, from the OpenAPI spec).
src/server.ts      buildServer() → McpServer with all tools registered. Shared by both
                   entry points.
src/index.ts       stdio transport (StdioServerTransport).
src/http.ts        HTTP transport: stateless StreamableHTTPServerTransport
                   (sessionIdGenerator: undefined, enableJsonResponse: true), a fresh
                   server+transport per request, GET /health, and auth (see below).
```

**The 25 tools:**

*Google Maps targeting* — `generate_maps_search_urls`, `extract_maps_search`,
`run_google_maps_targeting` (one-shot generate+extract).

*Contact lists* — `list_contact_lists`, `get_contact_list_status`.

*Contact manipulation* — `list_contact_fields` (read-only; the filterable fields of a
list), `preview_contact_selection` (read-only; counts a criteria selection, deletes
nothing), `delete_contacts_by_selection` (DESTRUCTIVE; deletes contacts by criteria
behind two guardrails — see below).

*Campaign audit (all read-only)* — `list_campaigns`, `get_campaign`, `get_scenario`
(full step content), `get_campaign_statistics` (aggregate + per-step). See below.

*Data browsing (all read-only)* — `get_account_overview`, `list_linkedin_accounts`,
`search_contact_lists`, `get_contact_list`, `query_contacts`, `search_contacts`. See below.

*PRM / pipeline (all read-only)* — `list_prm_statuses`, `query_prm_contacts`,
`get_prm_contact`, `list_prm_nurturings`. See below.

*Generic passthrough* — `list_api_endpoints` (read-only; discover the callable surface),
`magileads_get` (read-only; GET any non-admin endpoint), `magileads_request` (writes any
non-admin endpoint; dry-run until `confirm:true`). See below.

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

## Campaign audit (the read-only path)

Magileads vocabulary: a **campaign** = a workflow *programmation*; a **scenario** = a
*workflow* (its step template); **statistics** hang off the programmation.

- `list_campaigns` / `get_campaign` → `GET /workflows/programmations` (the list item, not
  the by-id GET, is richer: `workflow_name`, `contact_lists:[{id,name}]`, `has_*_step`
  flags, `stopped`/`archived`). The list only filters server-side on `id`/`created_on`/
  `workflow_id`/`date_start` — **not name**, so `get_campaign` fetches by an `id equals`
  filter, and `list_campaigns` does the name substring match client-side. `status` is
  derived (archived→stopped→running). Per-list `count` comes from `getContactList`.
- `get_scenario` → `GET /workflows/{id}`. `steps` is untyped (`[any]`) in swagger; each step
  carries `action_type`, `step_type` (action/event), `model_id`/`model_name`, `parent_ids`,
  `is_initial`. **The message content is NOT inline** — it lives in a separate model, fetched
  per `action_type`: `/models/email/{id}` (subject+text+html), `/models/linkedin/message/{id}`,
  `/models/linkedin/invitation/{id}` (text), `/models/sms|smv/{id}`. `get_scenario` fetches it
  and returns full `subject`/`body` + the raw model + raw step — never truncated.
- `get_campaign_statistics` → `GET /statistics/programmations/{id}`: channel-agnostic
  `aggregate` + `steps:[Statistics.Step]` (per-step `contacted`=sent, `contacts_opened/
  clicked/answered` = UNIQUE-contact counts, `bounced`, `parent_steps[{event_type,
  when_minutes}]`, `links`). The stats step `id` == the scenario `step_id.id` → correlate
  messages to stats. The API has **no** `delivered`, total (non-unique) opens, or LinkedIn
  invite-accepted count → those are exposed as `null` (facts vs. gaps), per the tool desc.
  `by_action_type`/`email`/`linkedin`/rates are DERIVED (summed/computed), never from the API.
- These tools return RAW + COMPLETE data; the audit/analysis is the agent's job, not the MCP's.
- Auth: the campaign/scenario must belong to the server's own account, else the API returns
  `unauthorized_workflow` / `unauthorized_workflow_programmation` (surfaced via `fail()`).

## Data browsing (the read-only query path)

Six tools let an agent read the whole account. Responses are COMPACT + CAPPED (summaries,
paging; never dump giant payloads).

- `get_account_overview` → `GET /users/me` → `user_profile`. Identity + `subscriptions`
  (plan STATUS: active/trial/end_date/…). **No numeric credit balance exists** in the API —
  don't invent one; the tool says so.
- `list_linkedin_accounts` → `GET /integrations/linkedin` → `linkedin_accounts_list`
  (id/name/username/is_valid/validity_tested/checkpoint_required/is_sales_navigator_account/last_use).
- `search_contact_lists` → `GET /contact-lists/names` (NON-paginated: returns ALL lists with
  counters + created_on + list_type). Filtering/sorting/paging is done in memory, so ranking
  (`sort`: contacts/emails/linkedin/companies/recent/name) is correct across the whole account —
  not just one page (and it's ~5× faster than the old paginated endpoint). Returns `total_lists`
  + `total_contacts` (sums over the filtered set). NOT `/contact-lists-paginated` any more.
- `get_contact_list` → reuses `getContactList` (`GET /contact-lists/{id}` → `contact_list_profile`).
  Job states are Capitalized (`"Completed"`, `"Error"`) → compare case-insensitively; `in_progress`
  is true only for non-terminal states.
- `query_contacts` → `GET /contact-lists/{id}/contacts?options=` and `search_contacts` →
  `POST /contact-lists/{id}/contacts/search {query}` (+ `?options=`). Key facts (verified live,
  differ from swagger prose):
  - **Flat envelope**: contacts are `results[]` directly (each a `Contact` with
    `properties:[{data_field_id,value}]`); per-list counters (`number_of_contacts/emails/
    linkedin_url`) sit at the ROOT — there is NO `results[0].results` nesting.
  - **Cursor pagination**: the first call mints a cursor; `current_page`/`next_page` are URLs
    `/contact-lists/{id}/contacts[/search]/{cursor}/page/{n}`. A `page` field inside `options`
    is IGNORED. `magileads.ts` derives page-N by rewriting the cursor URL's pathname
    (`cursorPagePath`), so the server's base URL — not the API's echoed host — is used.
  - **Field resolution**: `field_name` in filters/sort is a `data_field_id` as a STRING;
    `tools.ts` resolves human identifiers → id via `/data-fields`, and resolves each contact's
    `properties` back to `{ identifier: value }`. Output is CAPPED at 50 contacts per call.
  - Search rejects very short queries (`query_too_short`) — surfaced via `fail()`.

## PRM / pipeline (the read-only CRM path)

The PRM is Magileads' CRM / prospection pipeline. Four read-only tools; NO writes (no status
change, note, call, exclusion, LinkedIn send, import, delete).

- `list_prm_statuses` → `GET /prm/status` + `GET /prm/status/custom` (merged). **Two different
  shapes** (verified live): default statuses are `{status:<key string>, visible, color, sorting}`
  (NO id/name — the key IS the name, e.g. "opener"); custom statuses are `{id, name, visible,
  color, sorting, type_default_status}`. A contact's `custom_status` (int) resolves via the
  custom list; its `status` is a default key.
- `query_prm_contacts` → `GET /prm/contacts?options=` — same flat envelope + cursor pagination
  as the contacts endpoint (`/prm/contacts/{cursor}/page/{n}`; `page` in options ignored).
  Convenience params build a Filter: `status` → `status`/`custom_status equals` (name→id via the
  custom list), `only_positive` → `is_positive equals true`, `search` → `any_datafield contains`.
  `resolvePrmFieldName` passes PRM special fields through (status/custom_status/is_positive/score/
  created_on/any_datafield/…, `PRM_FIELDS`) and resolves data-field identifiers → id. Capped at 50.
- `get_prm_contact` → `GET /prm/contact/{id}` → `contact_profile`. **Do NOT pass
  `set_new_reply_read`** (it marks replies read = a write). Engagement `scoring` is DERIVED:
  summed from each `programmations[].score_{open,link_click,answer,positive_answer,
  negative_answer,invitation_accepted}_count` — there is no top-level scoring object. **Notes are
  NOT in the profile** (dedicated `/prm/contact/{id}/note*` endpoints, not exposed); they may
  appear as items inside `history` (a heterogeneous, swagger-undocumented oneOf → passed raw,
  capped at 30).
- `list_prm_nurturings` → `GET /prm/nurturings` → `{id, name, filter, contact_list_ids, created_on}`.
- Auth errors (`prm_contact_does_not_exist`, unauthorized) surface via `fail()`.

## Generic passthrough (the "everything else" path)

Three tools reach the account's whole **non-admin** API surface for endpoints without a
dedicated tool. Backed by `src/endpoints.generated.ts` (the allowlist).

- **Admin is excluded at generation time** — `ADMIN_TAGS` in `scripts/generate-endpoints.mjs`
  (Resellers/Organizations/Teams/Roles/Permissions/API Keys/External API keys/Subscriptions/
  Crons/Webhooks/OVH/Zapier/Affiliation/Pools, and all of Users except `GET /users/me*`).
  Regenerate with `bun run gen:endpoints`.
- `magileads_get` allows only GET matches; `magileads_request` only POST/PUT/DELETE/PATCH.
  `matchEndpoint` turns each template into a regex and ALSO strips a trailing `/page/{n}` or
  `/{cursor}/page/{n}` so agents can follow the API's own `next_page`/cursor URLs. `buildPath`
  accepts either a plain path or a full echoed URL (it keeps only pathname+query).
- **Write guardrail**: `magileads_request` is a DRY RUN unless `confirm:true` — it returns
  `{dry_run:true, would_call}` and sends nothing. `destructiveHint:true`, `readOnlyHint:false`.
- Responses are capped at ~60 KB (`capResult`) to protect agent context.
- Prefer the dedicated tools; the passthrough is the escape hatch. It CAN write, so it is the
  one place (besides `delete_contacts_by_selection`) that mutates data.

## Auth (HTTP mode) — MULTI-TENANT, bring-your-own-key

- There is **no gate token** (`MCP_AUTH_TOKEN` was removed at v0.9.0). Each HTTP request
  carries the **calling client's own Magileads API key**, used for that request only, so
  different clients hit different Magileads accounts.
- `http.ts:extractClientKey` reads the key from `X-Magileads-Api-Key`, `Authorization: Bearer
  <key>`, or `?api_key=` / `?token=` (the last two for URL-only dashboards). It then wraps the
  per-request server in `runWithAuth({apiKey})`.
- `magileads.ts` carries the key via **`AsyncLocalStorage`** (`runWithAuth` / `currentApiKey`):
  `authHeaders()` uses a per-request key (sent as `X-API-Key`, STATELESS — no JWT cache) when
  present, else falls back to the ENV credentials (`authMode()`). The 401-retry (env password
  refresh) is skipped when a per-request key is in play. NEVER log the key.
- Requests with no key are `401` unless the server has ENV creds (an optional default account).
  **stdio is always single-account** (env only — no per-request key). `/health` is unauthenticated.

## Commands

```bash
bun install
bun run typecheck      # tsc --noEmit (Bun runs TS directly; no emit needed to run)
bun run start:http     # run HTTP locally (multi-tenant; clients send their own key)
bun run start          # run stdio locally (single account from env)
bun run gen:endpoints  # regenerate the non-admin passthrough allowlist from the OpenAPI spec
bun run build          # optional: bundle to dist/ via `bun build`
```

**Verify a change without an MCP client** — drive JSON-RPC over the transport directly:

```bash
# HTTP: start the server, then (send the client's Magileads key)
curl -s -X POST 'localhost:8080/mcp' -H 'X-Magileads-Api-Key: KEY' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

For stdio, pipe newline-delimited JSON-RPC (`initialize` → `notifications/initialized`
→ `tools/list` → `tools/call`) into `bun run src/index.ts`.

`tools/list` needs no Magileads call, so a dummy `MAGILEADS_API_KEY=dummy` is enough to
smoke-test plumbing. A real `generate_maps_search_urls` call takes ~30–60 s and hits the
live API.

## Deployment

- `Dockerfile` (Bun image `oven/bun:1-alpine`, non-root `bun` user, `bun install --production`
  against `bun.lock`, `CMD bun run src/http.ts`, HEALTHCHECK on /health) + `docker-compose.yml`.
  Bun runs the TS directly — no build/dist stage. Dokploy builds the Dockerfile and terminates TLS.
- Env in prod: **none required** (multi-tenant). Optionally `MAGILEADS_API_KEY` (or
  email/password) as a default account for keyless requests.

## Hermes integration

Register as a remote HTTP MCP server in Hermes (dashboard or `~/.hermes/config.yaml`). Each
Hermes agent uses **its own** Magileads API key as the client key: `url:
https://<your-domain>/mcp` with `?api_key=<key>` in the URL, or an `X-Magileads-Api-Key`
header in config.yaml. Hermes auto-discovers the tools.

## Conventions

- Keep `magileads.ts` free of any parent-app imports (standalone).
- New tools: register in `tools.ts`, validate + clamp inputs, wrap the body so it can't
  throw, return text content (JSON string) — mirror the existing ones. Read-only tools set
  `readOnlyHint:true`; anything that mutates sets `destructiveHint:true` + a confirm guard.
- The server runs under **Bun** (no build step to run). Keep code Bun+Node-compatible
  (`node:*` built-ins are fine). Don't reintroduce a `tsc`-emit runtime dependency.
- Never log secrets. Never write to stdout in stdio mode.
- Credentials come from env only — never hardcode them (not even test creds) in the repo.
