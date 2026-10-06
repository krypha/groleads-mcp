import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolProfile } from "./tools.js";
import type { Scope } from "./oauth/scopes.js";
import { CREATION_GUIDANCE } from "./instructions.js";

/** Build a fresh MCP server instance with all Magileads tools registered. */
export function buildServer(allowedScopes?: readonly Scope[], profile: ToolProfile = "full"): McpServer {
  const server = new McpServer({
    name: "magileads-mcp",
    version: "0.11.1",
  }, { instructions: CREATION_GUIDANCE });
  registerTools(server, allowedScopes, profile);
  return server;
}
