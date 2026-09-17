import type http from "node:http";
import { oauthConfig } from "./config.js";
import { SCOPES, type Scope } from "./scopes.js";

export function protectedResourceMetadata(): object {
  const config = oauthConfig();
  return {
    resource: config.mcpResource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

function quoted(value: string): string {
  return value.replace(/[\\"\r\n]/g, "_");
}

export function challengeHeader(error: "invalid_token" | "insufficient_scope", scope?: Scope): string {
  const parts = [
    `Bearer resource_metadata="${quoted(oauthConfig().metadataUrl)}"`,
    `error="${error}"`,
    `error_description="${error === "invalid_token" ? "Authorization required." : "Insufficient scope."}"`,
  ];
  if (scope) parts.push(`scope="${scope}"`);
  return parts.join(", ");
}

export function sendChallenge(res: http.ServerResponse, status: 401 | 403, scope?: Scope): void {
  const error = status === 401 ? "invalid_token" : "insufficient_scope";
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: status === 401 ? "Authorization required." : "Insufficient scope." }, id: null });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "WWW-Authenticate": challengeHeader(error, scope),
  });
  res.end(body);
}
