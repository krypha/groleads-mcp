import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

/** Build a fresh MCP server instance with all Magileads tools registered. */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "magileads-mcp",
    version: "0.8.0",
  });
  registerTools(server);
  return server;
}
