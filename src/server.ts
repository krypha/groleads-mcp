import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolProfile } from "./tools.js";
import type { Scope } from "./oauth/scopes.js";
import { ACCOUNT_SWITCHING_GUIDANCE, CREATION_GUIDANCE } from "./instructions.js";

/** Build a fresh MCP server instance with all Magileads tools registered. */
export function buildServer(allowedScopes?: readonly Scope[], profile: ToolProfile = "full", accountSwitchingEnabled = false): McpServer {
  const server = new McpServer({
    name: "magileads-mcp",
    version: "0.14.0",
  }, { instructions: [CREATION_GUIDANCE, ...(accountSwitchingEnabled ? [ACCOUNT_SWITCHING_GUIDANCE] : [])].join(" ") });
  registerTools(server, allowedScopes, profile, accountSwitchingEnabled);
  return server;
}
