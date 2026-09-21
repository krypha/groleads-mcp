import { scopeForRoute, scopesForTool, toolAccessTable } from "../src/tools.js";

process.stdout.write("| tool | route (API scope) | exchange scopes |\n| --- | --- | --- |\n");
for (const [tool, access] of toolAccessTable()) {
  const routes = access.routes.map((route) => `${route.replace(/\|/g, "\\|")} (${scopeForRoute(access, route)})`).join("<br>");
  process.stdout.write(`| ${tool} | ${routes} | ${scopesForTool(access).join(" ")} |\n`);
}
