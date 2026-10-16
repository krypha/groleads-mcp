import type http from "node:http";
import { oauthConfig } from "./config.js";
import { SCOPES } from "./scopes.js";
import type { McpResource } from "./resources.js";

export function protectedResourceMetadata(resource: McpResource): object {
  const config = oauthConfig();
  return {
    resource: resource.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

function quoted(value: string): string {
  return value.replace(/[\\"\r\n]/g, "_");
}

export function challengeHeader(error: "invalid_token" | "insufficient_scope", resource: McpResource, scope?: string): string {
  const parts = [
    `Bearer resource_metadata="${quoted(resource.metadataUrl)}"`,
    `error="${error}"`,
    `error_description="${error === "invalid_token" ? "Authorization required." : "Insufficient scope."}"`,
  ];
  if (scope) parts.push(`scope="${scope}"`);
  return parts.join(", ");
}

export function sendChallenge(res: http.ServerResponse, status: 401 | 403, resource: McpResource, scope?: string): void {
  const error = status === 401 ? "invalid_token" : "insufficient_scope";
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: status === 401 ? "Authorization required." : "Insufficient scope." }, id: null });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "WWW-Authenticate": challengeHeader(error, resource, scope),
  });
  res.end(body);
}
