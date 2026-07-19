import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

/** Build a fresh MCP server instance with all Google Maps tools registered. */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "groleads-google-maps",
    version: "0.5.0",
  });
  registerTools(server);
  return server;
}
