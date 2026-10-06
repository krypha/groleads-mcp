import { scopeForRoute, scopesForTool, toolAccessTable } from "../src/tools.js";

process.stdout.write("| tool | route (API scope) | exchange scopes |\n| --- | --- | --- |\n");
for (const [tool, access] of toolAccessTable()) {
  if (access.dynamic) {
    const scope = tool === "magileads_get" ? "mcp:read (GET reads only)" : "operation.scope (mcp:read or mcp:write)";
    process.stdout.write(`| ${tool} | Exact method/path in docs/oauth-business-routes.json | ${scope} |\n`);
    continue;
  }
  const routes = access.routes.map((route) => `${route.replace(/\|/g, "\\|")} (${scopeForRoute(access, route)})`).join("<br>");
  process.stdout.write(`| ${tool} | ${routes} | ${scopesForTool(access).join(" ")} |\n`);
}
