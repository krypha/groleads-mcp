import { scopeForRoute, scopesForTool, toolAccessTable } from "../src/tools.js";

process.stdout.write("| tool | route (API scope) | exchange scopes |\n| --- | --- | --- |\n");
for (const [tool, access] of toolAccessTable()) {
  if (access.accountControl) {
    process.stdout.write(`| ${tool} (private HTTP OAuth only) | Private control plane: docs/account-switching-api-contract.md | No business token exchange; caller requires ${access.scopeAlternatives?.join(" OR ") ?? access.scope} |\n`);
    continue;
  }
  if (access.dynamic) {
    const scope = tool === "magileads_get" ? "mcp:read (GET reads only)" : "operation.scope (mcp:read or mcp:write)";
    process.stdout.write(`| ${tool} | Exact method/path in docs/oauth-business-routes.json | ${scope} |\n`);
    continue;
  }
  const routes = access.routes.map((route) => `${route.replace(/\|/g, "\\|")} (${scopeForRoute(access, route)})`).join("<br>");
  process.stdout.write(`| ${tool} | ${routes} | ${scopesForTool(access).join(" ")} |\n`);
}
