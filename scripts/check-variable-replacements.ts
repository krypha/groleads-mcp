/** Real API verification through the local stdio MCP; not a deployed OAuth test.
 * Environment credentials only. Read-only unless --allow-update is explicitly set.
 * Update mode uses an authorized demo account and restores its exact saved settings.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readReplacements, mergeReplacements, type Replacement } from "../src/variable-replacements.js";
const expected = Number(process.env.MAGILEADS_TEST_EXPECTED_USER_ID);
const allowUpdate = process.argv.includes("--allow-update");
assert(Number.isSafeInteger(expected) && expected > 0, "Expected demo account ID required");
const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "src/index.ts"], cwd: process.cwd(), stderr: "pipe",
  env: { ...getDefaultEnvironment(), MAGILEADS_API_BASE: process.env.MAGILEADS_API_BASE || "https://app.api-magileads.net",
    MAGILEADS_API_KEY: process.env.MAGILEADS_API_KEY || "", MAGILEADS_EMAIL: process.env.MAGILEADS_EMAIL || "", MAGILEADS_PASSWORD: process.env.MAGILEADS_PASSWORD || "" } });
transport.stderr?.on("data", () => {});
const client = new Client({ name: "variable-fallback-live-check", version: "1" });
const outcomes: Record<string, unknown>[] = [];
function record(check: string, extra: Record<string, unknown> = {}) { const row = { check, ...extra }; outcomes.push(row); console.log(JSON.stringify(row)); }
async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
  const content = result.content as { type: string; text?: string }[];
  let data: any;
  try { data = JSON.parse(content.filter((item) => item.type === "text").map((item) => item.text || "").join("\n")); }
  catch { throw new Error(`${name}: invalid_json`); }
  assert(!result.isError, `${name}: ${typeof data.code === "string" ? data.code : "tool_failed"}`);
  return data;
}
async function saved() {
  const data = await tool("magileads_get", { path: "/users/me" });
  assert.equal(data.result?.user_profile?.id, expected, "Wrong demo account");
  return readReplacements(data.result.user_profile);
}
let original: Replacement[] | undefined;
let expectedCurrent: Replacement[] | undefined;
let attempted = false;
try {
  await client.connect(transport);
  original = await saved();
  expectedCurrent = original;
  const view = await tool("get_variable_replacements", { search: "Civilité" });
  assert.equal(view.account_id, expected);
  assert.equal(view.fields.length, 1, "Missing/ambiguous Civilité field");
  const field = view.fields[0];
  const definitions = [{ id: field.datafield_id, name: field.label, identifier: field.identifier, identifier_placeholder: field.placeholder },
    ...original.filter((row) => row.datafield_id !== field.datafield_id).map((row) => ({ id: row.datafield_id }))];
  record("account_and_civility_discovery", { passed: true, account_id: expected, datafield_id: field.datafield_id, placeholder: field.placeholder, configured_count: original.length });
  const replacement = field.replacement === "Mr/Mme" ? "Mr/Mme (MCP QA)" : "Mr/Mme";
  const preview = await tool("set_variable_replacements", { replacements: [{ field: "Civilité", replacement }] });
  assert.equal(preview.dry_run, true);
  assert.deepEqual(await saved(), original);
  record("dry_run_preserves_settings", { passed: true });
  if (!allowUpdate) record("real_update", { status: "skipped", reason: "Read-only run; --allow-update required" });
  else {
    expectedCurrent = mergeReplacements(original, definitions, [{ field: "Civilité", replacement }]).next;
    attempted = true;
    const updated = await tool("set_variable_replacements", { replacements: [{ field: "Civilité", replacement }], confirm: true });
    assert.equal(updated.executed, true);
    assert.deepEqual(await saved(), expectedCurrent);
    const after = await tool("get_variable_replacements", { search: field.identifier });
    assert.equal(after.fields[0].replacement, replacement);
    record("real_fallback_update_and_other_preferences_preserved", { passed: true });
    const unchanged = await tool("set_variable_replacements", { replacements: [{ field: field.placeholder, replacement }], confirm: true });
    assert.equal(unchanged.unchanged, true);
    record("identical_update_is_noop", { passed: true });
    expectedCurrent = mergeReplacements(expectedCurrent, definitions, [{ field: String(field.datafield_id), replacement: "" }]).next;
    const cleared = await tool("set_variable_replacements", { replacements: [{ field: String(field.datafield_id), replacement: "" }], confirm: true });
    assert.equal(cleared.executed, true);
    assert.deepEqual(await saved(), expectedCurrent);
    assert.equal((await tool("get_variable_replacements", { search: field.identifier })).fields[0].replacement, null);
    record("clear_one_fallback_preserves_other_preferences", { passed: true });
  }
} catch (error) {
  process.exitCode = 1;
  record("live_check", { passed: false, error: error instanceof Error && /tool_failed|invalid_json/.test(error.message) ? error.message : "identity_or_persistence_check_failed_details_suppressed" });
} finally {
  if (attempted && original && expectedCurrent) {
    try {
      assert.deepEqual(await saved(), expectedCurrent, "Concurrent changes; do not overwrite");
      await tool("magileads_request", { method: "PUT", path: "/users/me", body: { datafields_replacement: original }, confirm: true });
      assert.deepEqual(await saved(), original);
      record("exact_original_configuration_restored", { passed: true, account_id: expected, configured_count: original.length });
    } catch { process.exitCode = 1; record("restore", { passed: false, error: "Restoration not confirmed; inspect current preferences before any retry" }); }
  }
  await client.close();
  console.log(JSON.stringify({ transport: "local_stdio", validates_deployed_oauth: false, contacts_modified: false, outcomes }, null, 2));
}
