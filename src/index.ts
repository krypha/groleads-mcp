#!/usr/bin/env node
/**
 * Magileads MCP (stdio transport).
 *
 * A stdio Model Context Protocol server exposing Magileads as tools for AI agents
 * (targeting, contact lists, campaign audit, PRM, and a generic API passthrough).
 * Only Magileads credentials are required.
 *
 * For a containerized / remote deployment (e.g. an agent that connects over the
 * network), use the HTTP entrypoint instead: `bun run src/http.ts` (see http.ts).
 *
 * Configure via environment (see .env.example):
 *   MAGILEADS_API_KEY                       (preferred), or
 *   MAGILEADS_EMAIL + MAGILEADS_PASSWORD
 *   MAGILEADS_API_BASE                      (optional; defaults to app.api-magileads.net)
 *
 * All logging goes to stderr — stdout is reserved for the JSON-RPC transport.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { authMode, API_BASE } from "./magileads.js";

async function main(): Promise<void> {
  const mode = authMode();
  if (mode === "none") {
    console.error(
      "[magileads-mcp] No credentials configured. Set MAGILEADS_API_KEY, or " +
        "MAGILEADS_EMAIL + MAGILEADS_PASSWORD, then restart.",
    );
    process.exit(1);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[magileads-mcp] server ready (stdio, auth: ${mode}, base: ${API_BASE}).`,
  );
}

main().catch((err) => {
  console.error("[magileads-mcp] Fatal error:", err);
  process.exit(1);
});
