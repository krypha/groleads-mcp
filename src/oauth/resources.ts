import type http from "node:http";
import { isIP } from "node:net";
import { oauthConfig, type OAuthConfig } from "./config.js";
import { AuthorizationServiceUnavailable, oauthEndpoint } from "./discovery.js";
import { basicClientAuthorization } from "./exchange.js";
import { log } from "../log.js";

const REFRESH_MS = 60_000;
const MAX_AGE_MS = 120_000;
const MAX_BODY_BYTES = 256 * 1024;

export type McpResource = Readonly<{ resource: string; metadataUrl: string }>;
export class InvalidResourceHost extends Error {
  constructor() { super("MCP hostname is not authorized."); }
}

/** Authority comes only from Host. Forwarding headers never select an OAuth audience. */
export function requestAuthority(req: Pick<http.IncomingMessage, "headers" | "rawHeaders">): string {
  const hostCount = req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host").length;
  const host = req.headers.host;
  if (hostCount !== 1 || typeof host !== "string" || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) {
    throw new InvalidResourceHost();
  }
  return host.toLowerCase();
}

/** Validate the entire replacement list; never authorize partially parsed upstream data. */
export function parseMcpResources(payload: unknown, config: OAuthConfig): ReadonlyMap<string, McpResource> {
  const data = payload as { state?: unknown; resources?: unknown } | null;
  if (!data || data.state !== true || !Array.isArray(data.resources)) throw new Error("Invalid MCP resource list.");
  const entries = new Map<string, McpResource>();
  for (const value of data.resources) {
    if (typeof value !== "string" || /[?#]/.test(value)) throw new Error("Invalid MCP resource URL.");
    const url = oauthEndpoint(value);
    if (value === config.apiResource || url.href === new URL(config.apiResource).href) {
      throw new Error("The API cannot be an MCP resource.");
    }
    if (value !== config.mcpResource) {
      // Reseller resources must be the exact normalized public HTTPS domain + /mcp.
      const labels = url.hostname.split(".");
      if (url.protocol !== "https:" || url.port || url.pathname !== "/mcp" || config.mcpPath !== "/mcp" ||
          url.search || url.hash || value !== url.href || isIP(url.hostname) || labels.length < 2 ||
          url.hostname.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("Invalid reseller MCP resource.");
      }
    }
    if (entries.has(url.host)) throw new Error("Duplicate MCP resource authority.");
    entries.set(url.host, Object.freeze({ resource: value, metadataUrl: `${url.origin}${config.metadataPath}` }));
  }
  // An empty successful list explicitly authorizes nothing. No fallback to the environment resource.
  return entries;
}

/** One registry per HTTP server, never shared across environments or exposed to MCP tools. */
export class McpResourceRegistry {
  private snapshot?: ReadonlyMap<string, McpResource>;
  private succeededAt = -Infinity;
  private nextAttemptAt = -Infinity;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private readonly endpoint: URL;

  constructor(
    private readonly config: OAuthConfig = oauthConfig(),
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = () => performance.now(),
  ) {
    // Fixed path on the configured issuer: never use a client-provided URL or reseller host.
    this.endpoint = oauthEndpoint(new URL("/oauth/mcp-resources", config.issuer).href);
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.nextAttemptAt = this.now() + REFRESH_MS;
    const operation = this.retrieve().catch(() => {
      // Never log response bodies, errors or the Basic credentials.
      log("warn", "Private MCP resource discovery failed");
    });
    this.pending = operation.finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async retrieve(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.request(this.endpoint, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: basicClientAuthorization(this.config.clientId, this.config.clientSecret) },
        redirect: "error", // Never forward internal credentials to a redirected URL.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error("MCP discovery unavailable.");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_BODY_BYTES) throw new Error("MCP resource list too large.");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const resources = parseMcpResources(JSON.parse(Buffer.concat(chunks).toString("utf8")), this.config);
      this.snapshot = resources; // Atomic replacement: removed domains disappear, never merge.
      this.succeededAt = this.now();
      this.nextAttemptAt = this.succeededAt + REFRESH_MS;
    } finally { if (this.controller === controller) this.controller = undefined; }
  }

  async forRequest(req: Pick<http.IncomingMessage, "headers" | "rawHeaders">): Promise<McpResource> {
    const authority = requestAuthority(req);
    if (this.now() >= this.nextAttemptAt) await this.refresh();
    else if (!this.snapshot && this.pending) await this.pending;
    // Re-check time after I/O: an in-flight failure must not extend the 120s window.
    if (!this.snapshot || this.now() - this.succeededAt >= MAX_AGE_MS) throw new AuthorizationServiceUnavailable();
    const resource = this.snapshot.get(authority);
    if (!resource) throw new InvalidResourceHost();
    return resource;
  }
}
