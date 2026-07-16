#!/usr/bin/env node
/**
 * Groleads MCP — Google Maps targeting (HTTP transport).
 *
 * Serves the MCP Streamable HTTP transport so a remote / containerized agent
 * (e.g. a Nous Research Hermes Agent) can connect over the network by URL,
 * instead of spawning a local stdio subprocess.
 *
 * Environment:
 *   MCP_AUTH_TOKEN   REQUIRED — clients must send `Authorization: Bearer <token>`.
 *   MCP_HTTP_PORT    listen port (default 8080)
 *   MCP_HTTP_PATH    MCP endpoint path (default /mcp)
 *   MAGILEADS_API_KEY  or  MAGILEADS_EMAIL + MAGILEADS_PASSWORD   (Magileads auth)
 *   MAGILEADS_API_BASE (optional)
 *
 * All logging goes to stderr.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { authMode, API_BASE } from "./magileads.js";

const PORT = Number(process.env.MCP_HTTP_PORT) || 8080;
const MCP_PATH = process.env.MCP_HTTP_PATH || "/mcp";
const TOKEN = process.env.MCP_AUTH_TOKEN || "";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Constant-time compare of a candidate secret against MCP_AUTH_TOKEN. */
function tokenMatches(candidate: string): boolean {
  const got = Buffer.from(candidate);
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * A request is authorized if it carries the token either as:
 *   - `Authorization: Bearer <token>` header  (preferred — used by config.yaml `headers`), or
 *   - a `?token=<token>` URL query parameter   (lets a dashboard that only exposes a
 *     URL field authenticate; note the token may appear in proxy access logs).
 */
function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers["authorization"] || "";
  if (header.startsWith("Bearer ") && tokenMatches(header.slice(7))) return true;
  const q = new URL(req.url || "/", "http://localhost").searchParams.get("token");
  if (q && tokenMatches(q)) return true;
  return false;
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
  if (!authorized(req)) {
    json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return;
  }

  // Stateless: a fresh server + transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function main(): Promise<void> {
  if (authMode() === "none") {
    console.error(
      "[groleads-mcp] No credentials configured. Set MAGILEADS_API_KEY, or " +
        "MAGILEADS_EMAIL + MAGILEADS_PASSWORD.",
    );
    process.exit(1);
  }
  if (!TOKEN) {
    console.error(
      "[groleads-mcp] MCP_AUTH_TOKEN is required in HTTP mode (the endpoint is " +
        "network-reachable). Generate one, e.g.: openssl rand -hex 32",
    );
    process.exit(1);
  }

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
      console.error("[groleads-mcp] request error:", err);
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    });
  });

  server.listen(PORT, () => {
    console.error(
      `[groleads-mcp] HTTP MCP ready on :${PORT}${MCP_PATH} ` +
        `(auth: bearer + ${authMode()}, base: ${API_BASE}).`,
    );
  });
}

main().catch((err) => {
  console.error("[groleads-mcp] Fatal error:", err);
  process.exit(1);
});
