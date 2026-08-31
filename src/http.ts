#!/usr/bin/env node
/**
 * Magileads MCP (HTTP transport) — multi-tenant.
 *
 * Serves the MCP Streamable HTTP transport so a remote / containerized agent
 * (e.g. a Nous Research Hermes Agent) can connect over the network by URL.
 *
 * AUTH IS PER CLIENT (bring-your-own-key): each request must carry the calling
 * client's OWN Magileads API key, which the server uses for that request only —
 * so different clients hit different Magileads accounts. A client presents its key
 * as ANY of:
 *   - `X-Magileads-Api-Key: <key>` header      (preferred)
 *   - `Authorization: Bearer <key>` header      (config-file friendly)
 *   - `?api_key=<key>` (or `?token=<key>`) query (URL-only dashboards; may appear in proxy logs)
 * There is no separate gate token: a request without a usable key is rejected
 * (unless the server has its own MAGILEADS_* env credentials as a default account).
 *
 * Environment:
 *   MCP_HTTP_PORT    listen port (default 8080)
 *   MCP_HTTP_PATH    MCP endpoint path (default /mcp)
 *   MAGILEADS_API_KEY  or  MAGILEADS_EMAIL + MAGILEADS_PASSWORD   (OPTIONAL default account)
 *   MAGILEADS_API_BASE (optional)
 *
 * All logging goes to stderr. The client's key is never logged.
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { authMode, API_BASE, runWithAuth } from "./magileads.js";

const PORT = Number(process.env.MCP_HTTP_PORT) || 8080;
const MCP_PATH = process.env.MCP_HTTP_PATH || "/mcp";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Extract the calling client's Magileads API key from the request, checking (in
 * order) the `X-Magileads-Api-Key` header, an `Authorization: Bearer` header, and
 * an `?api_key=` / `?token=` query parameter. Returns undefined if none is present.
 */
function extractClientKey(req: http.IncomingMessage): string | undefined {
  const hdr = req.headers["x-magileads-api-key"];
  if (typeof hdr === "string" && hdr.trim()) return hdr.trim();

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }

  const sp = new URL(req.url || "/", "http://localhost").searchParams;
  const q = sp.get("api_key") || sp.get("token");
  if (q && q.trim()) return q.trim();

  return undefined;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Only POST carries JSON-RPC in our stateless setup; GET/DELETE (SSE/session)
  // aren't used because each request is independent.
  if (req.method !== "POST") {
    json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }

  // Per-client key. If none is provided AND the server has no default account, reject.
  const clientKey = extractClientKey(req);
  if (!clientKey && authMode() === "none") {
    json(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Unauthorized: provide your Magileads API key via the X-Magileads-Api-Key header, " +
          "Authorization: Bearer <key>, or ?api_key=<key>.",
      },
      id: null,
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return;
  }

  // Stateless: a fresh server + transport per request, run under this client's credential.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await runWithAuth({ apiKey: clientKey }, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (path !== MCP_PATH) {
      json(res, 404, { jsonrpc: "2.0", error: { code: -32601, message: "Not found" }, id: null });
      return;
    }
    handleMcp(req, res).catch((err) => {
      console.error("[magileads-mcp] request error:", err);
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    });
  });

  server.listen(PORT, () => {
    const mode = authMode();
    const authDesc =
      mode === "none"
        ? "per-request client key required (multi-tenant)"
        : `per-request client key, else env ${mode} (default account)`;
    console.error(
      `[magileads-mcp] HTTP MCP ready on :${PORT}${MCP_PATH} (auth: ${authDesc}, base: ${API_BASE}).`,
    );
  });
}

main().catch((err) => {
  console.error("[magileads-mcp] Fatal error:", err);
  process.exit(1);
});
