import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import type { Scope } from "./oauth/scopes.js";

/** Build a fresh MCP server instance with all Magileads tools registered. */
export function buildServer(allowedScopes?: readonly Scope[]): McpServer {
  const server = new McpServer({
    name: "magileads-mcp",
    version: "0.10.0",
  });
  registerTools(server, allowedScopes);
  return server;
}
