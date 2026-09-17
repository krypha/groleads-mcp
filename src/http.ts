#!/usr/bin/env node
/** Stateless HTTP MCP with isolated OAuth and bring-your-own-API-key modes. */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { runWithAuth } from "./magileads.js";
import { accessForTool, toolAccessTable } from "./tools.js";
import { log } from "./log.js";
import { loadHttpConfig, type HttpConfig } from "./http-config.js";
import { oauthConfig } from "./oauth/config.js";
import { exchangeToken, invalidateExchange, ReauthenticationRequired } from "./oauth/exchange.js";
import { protectedResourceMetadata, sendChallenge } from "./oauth/metadata.js";
import { bearerFrom, InvalidTokenError, verifyAccessToken } from "./oauth/verify.js";

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function apiKeyUnauthorized(res: http.ServerResponse): void {
  json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Invalid or missing Magileads API key." }, id: null });
}

type Credential = { kind: "oauth"; bearer: string } | { kind: "apiKey"; apiKey: string };

function selectCredential(req: http.IncomingMessage, config: HttpConfig): Credential | "missing" | "ambiguous" | "query_disabled" | "key_disabled" {
  const credentialHeaders = req.rawHeaders.filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (credentialHeaders.filter((name) => name === "x-api-key").length > 1 ||
      credentialHeaders.filter((name) => name === "authorization").length > 1) return "ambiguous";
  const header = req.headers["x-api-key"];
  if (Array.isArray(header)) return "ambiguous";
  const url = new URL(req.url || "/", "http://localhost");
  const queryKeys = [...url.searchParams.getAll("api_key"), ...url.searchParams.getAll("token")];
  if (queryKeys.length && !config.allowApiKeyQuery) return "query_disabled";
  if (queryKeys.length > 1 || (header !== undefined && queryKeys.length > 0)) return "ambiguous";
  const key = header ?? queryKeys[0];
  if (key !== undefined && (!key.trim() || req.headers.authorization !== undefined)) return "ambiguous";
  if (key !== undefined) {
    if (config.authMode === "oauth") return "key_disabled";
    return { kind: "apiKey", apiKey: key.trim() };
  }
  const bearer = bearerFrom(req.headers.authorization);
  if (bearer) {
    if (config.authMode === "api_key") return { kind: "apiKey", apiKey: bearer };
    return { kind: "oauth", bearer };
  }
  return "missing";
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 4 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function callName(body: unknown): string | undefined {
  // A batch could mix read and write scopes. Reject it instead of selecting
  // the first call and accidentally running a later call under that exchange.
  if (Array.isArray(body)) throw new Error("JSON-RPC batches are not supported.");
  if (!body || typeof body !== "object") return undefined;
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (message.method !== "tools/call") return undefined;
  if (typeof message.params?.name !== "string") return undefined;
  return message.params.name;
}

/**
 * MCP handlers turn backend exceptions into HTTP 200 tool errors. Buffering a
 * tool-call response until the handler completes lets an API 401 become the
 * HTTP 401 challenge the client actually understands, before bytes are sent.
 */
function bufferResponse(res: http.ServerResponse): { finish: (onUnauthorized?: () => void) => void; restore: () => void } {
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const writeHead = res.writeHead.bind(res);
  const chunks: Buffer[] = [];
  let ended = false;
  const append = (chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), encoding));
    }
  };
  res.writeHead = ((status: number, reasonOrHeaders?: string | http.OutgoingHttpHeaders, headers?: http.OutgoingHttpHeaders) => {
    res.statusCode = status;
    const values = typeof reasonOrHeaders === "string" ? headers : reasonOrHeaders;
    if (values) for (const [key, value] of Object.entries(values)) if (value !== undefined) res.setHeader(key, value);
    return res;
  }) as typeof res.writeHead;
  res.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    append(chunk, typeof encoding === "string" ? encoding : undefined);
    (typeof encoding === "function" ? encoding : callback)?.();
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    append(chunk, typeof encoding === "string" ? encoding : undefined);
    ended = true;
    (typeof encoding === "function" ? encoding : callback)?.();
    return res;
  }) as typeof res.end;
  const restore = () => {
    res.write = write as typeof res.write;
    res.end = end as typeof res.end;
    res.writeHead = writeHead as typeof res.writeHead;
  };
  return {
    restore,
    finish(onUnauthorized?: () => void) {
      restore();
      if (onUnauthorized) {
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        onUnauthorized();
      } else if (!res.headersSent) {
        if (!ended) throw new Error("MCP transport did not end its response.");
        writeHead(res.statusCode);
        end(Buffer.concat(chunks));
      }
    },
  };
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, config: HttpConfig): Promise<void> {
  const credential = selectCredential(req, config);
  if (credential === "query_disabled") return json(res, 400, { error: "API keys in URLs are disabled. Use X-API-Key." });
  if (credential === "ambiguous") return json(res, 400, { error: "Provide exactly one valid authentication credential." });
  if (credential === "key_disabled") return json(res, 401, { error: "API-key authentication is disabled." });
  if (credential === "missing") {
    return config.authMode === "api_key" ? apiKeyUnauthorized(res) : sendChallenge(res, 401);
  }

  let caller;
  if (credential.kind === "oauth") {
    try {
      caller = await verifyAccessToken(credential.bearer);
    } catch (error) {
      if (error instanceof InvalidTokenError) return sendChallenge(res, 401);
      log("error", "Token verification unavailable", { error });
      return json(res, 503, { error: "Authorization service unavailable." });
    }
    if (caller.scopes.length === 0) return sendChallenge(res, 403, "mcp:read");
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  let body: unknown;
  let name: string | undefined;
  try {
    body = await readJsonBody(req);
    name = callName(body);
  } catch {
    return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON-RPC request." }, id: null });
  }

  const access = name ? accessForTool(name) : undefined;
  if (access && caller && !caller.scopes.includes(access.scope)) return sendChallenge(res, 403, access.scope);

  let exchangedBearer: string | undefined;
  if (access && credential.kind === "oauth") {
    try {
      exchangedBearer = await exchangeToken(credential.bearer, access.scope);
    } catch (error) {
      if (error instanceof ReauthenticationRequired) return sendChallenge(res, 401);
      log("error", "Token exchange unavailable", { error });
      return json(res, 502, { error: "Token exchange failed." });
    }
  }

  const server = buildServer(caller?.scopes);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const buffered = access ? bufferResponse(res) : undefined;
  let apiUnauthorized = false;
  const unauthorized = () => credential.kind === "oauth" ? sendChallenge(res, 401) : apiKeyUnauthorized(res);
  try {
    const requestAuth = credential.kind === "oauth"
      ? { kind: "oauth" as const, exchangedBearer, onUnauthorized: () => { apiUnauthorized = true; } }
      : { kind: "apiKey" as const, apiKey: credential.apiKey, onUnauthorized: () => { apiUnauthorized = true; } };
    await runWithAuth(requestAuth, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    if (apiUnauthorized && access && credential.kind === "oauth") invalidateExchange(credential.bearer, access.scope);
    buffered?.finish(apiUnauthorized ? unauthorized : undefined);
  } catch (error) {
    buffered?.restore();
    log("error", "MCP request failed", { error });
    if (!res.headersSent) {
      if (apiUnauthorized) {
        if (access && credential.kind === "oauth") invalidateExchange(credential.bearer, access.scope);
        unauthorized();
      }
      else json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

/** Exported for the throwaway-server smoke test; production runs main below. */
export function createHttpServer(): http.Server {
  const config = loadHttpConfig();
  const oauthEnabled = config.authMode !== "api_key";
  if (oauthEnabled) oauthConfig(); // OAuth modes fail closed when required values are absent.
  toolAccessTable(); // Validate every tool's declared scope and routes at boot.
  const paths = oauthEnabled ? new Set(["/.well-known/oauth-protected-resource", oauthConfig().metadataPath]) : new Set<string>();
  return http.createServer((req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (paths.has(path)) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
        });
        res.end();
      } else if (req.method === "GET") {
        json(res, 200, protectedResourceMetadata(), {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
      } else json(res, 405, { error: "Method not allowed." });
      return;
    }
    if (req.method === "GET" && path === "/health") return json(res, 200, { status: "ok" });
    if (path !== config.mcpPath) return json(res, 404, { error: "Not found." });
    handleMcp(req, res, config).catch((error) => {
      log("error", "MCP request failed", { error });
      if (!res.headersSent) json(res, 500, { error: "Internal error." });
    });
  });
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  try {
    const config = loadHttpConfig();
    createHttpServer().listen(config.port, () => {
      log("info", "HTTP MCP ready", { port: config.port, path: config.mcpPath, authMode: config.authMode });
    });
  } catch (error) {
    log("error", "HTTP MCP cannot start", { error });
    process.exit(1);
  }
}
