# @groleads/mcp-google-maps

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes
**Groleads / Magileads Google Maps targeting** as tools for AI agents.

Turn a plain query ("dentists in Lyon") into a filled contact list — **no LinkedIn
account** needed, only Magileads credentials. Works with any MCP-capable agent
(Nous Research Hermes, Claude Desktop/Code, Cursor, …), whatever model powers it.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_maps_search_urls` | Query + optional locations → Google Maps search URLs (up to 40). |
| `extract_maps_search` | Up to 10 URLs → extract businesses into a new/existing contact list (async). |
| `run_google_maps_targeting` | One-shot: generate URLs **and** extract, in a single call. |
| `list_contact_lists` | List / search the account's contact lists. |
| `get_contact_list_status` | Counts + job states for a list — poll after extraction until `completed`. |

Extraction is **asynchronous**: the extract tools return a `contact_list_id`
immediately; poll `get_contact_list_status` until the extraction job reads
`completed`. URL generation can take **~30–60 s**.

## Two transports

| Transport | Entry | Use when |
| --- | --- | --- |
| **stdio** | `node dist/index.js` | The agent runs the server as a local subprocess (Claude Desktop/Code, Cursor, a local script). |
| **HTTP** | `node dist/http.js` | The agent connects over the network — a remote/containerized agent (e.g. Hermes in Docker). |

## Configure

Magileads auth — pick **one** (see [`.env.example`](.env.example)):

- `MAGILEADS_API_KEY` — sent as `X-API-Key` (preferred), **or**
- `MAGILEADS_EMAIL` + `MAGILEADS_PASSWORD` — JWT login, auto-refreshed.

HTTP mode additionally requires **`MCP_AUTH_TOKEN`** — a bearer token clients must
send (the endpoint is network-reachable). Generate one: `openssl rand -hex 32`.

## Run locally

```bash
npm install
npm run build

# stdio
MAGILEADS_API_KEY=... npm start

# HTTP (listens on :8080/mcp)
MAGILEADS_API_KEY=... MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http
```

Health check (HTTP mode): `GET /health` → `{"status":"ok"}` (no auth).

## Deploy with Docker

```bash
# 1. a token + your Magileads key in .env  (copy from .env.example)
cp .env.example .env

# 2. build + run
docker compose up -d --build
```

On **Dokploy**: create an app from this repo, let it build the `Dockerfile`, set the
env vars (`MCP_AUTH_TOKEN`, `MAGILEADS_API_KEY`), and give it a domain — Dokploy's
reverse proxy terminates TLS, so the agent reaches it at
`https://<your-domain>/mcp`.

## Connect it to a Hermes Agent (Nous Research)

Add it as a **remote HTTP MCP server** in Hermes (`~/.hermes/config.yaml`, or via the
dashboard's MCP page):

```yaml
mcp_servers:
  groleads_gmaps:
    url: "https://<your-mcp-domain>/mcp"
    headers:
      Authorization: "Bearer <the-same-MCP_AUTH_TOKEN>"
```

Hermes discovers the 5 tools automatically at startup. The Magileads credentials
stay in *this* server — Hermes never sees them.

The server writes logs to **stderr**; in HTTP mode, `/mcp` speaks JSON-RPC and
`/health` is a plain liveness probe.
