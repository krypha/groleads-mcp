import { toolAccessTable } from "../src/tools.js";

process.stdout.write("| tool | route | scope |\n| --- | --- | --- |\n");
for (const [tool, access] of toolAccessTable()) {
  process.stdout.write(`| ${tool} | ${access.routes.join("<br>").replace(/\|/g, "\\|")} | ${access.scope} |\n`);
}
