/** Opt-in live stdio recipe. Credentials are read ONLY from the environment.
 * Writes create labelled QA resources and never send messages or start campaigns.
 * This verifies API payloads, not deployed HTTP OAuth middleware/consent.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { redactString } from "../src/log.js";

const expected = Number(process.env.MAGILEADS_TEST_ACCOUNT_ID);
const target = Number(process.env.MAGILEADS_TEST_TARGET_USER_ID);
const writes = process.env.MAGILEADS_TEST_ALLOW_WRITES === "true";
assert(Number.isSafeInteger(expected) && expected > 0, "MAGILEADS_TEST_ACCOUNT_ID required");
assert(!writes || (Number.isSafeInteger(target) && target > 0 && target !== expected), "A distinct test destination user is required for writes");
const env = { ...getDefaultEnvironment(), MAGILEADS_API_BASE: process.env.MAGILEADS_API_BASE || "https://app.api-magileads.net",
  MAGILEADS_API_KEY: process.env.MAGILEADS_API_KEY || "", MAGILEADS_EMAIL: process.env.MAGILEADS_EMAIL || "", MAGILEADS_PASSWORD: process.env.MAGILEADS_PASSWORD || "" };
const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "src/index.ts"], cwd: process.cwd(), env, stderr: "pipe" });
transport.stderr?.on("data", () => {}); // Never publish child logs or credentials.
const client = new Client({ name: "magileads-resource-live-check", version: "1" });
const results: Record<string, unknown>[] = [];
const artifacts: Record<string, unknown>[] = [];
const marker = process.env.MAGILEADS_TEST_RESUME_MARKER || `MCP QA ${new Date().toISOString().replace(/[:.]/g, "-")}`;
const verifyDestinationId = Number(process.env.MAGILEADS_TEST_VERIFY_DESTINATION_ID || 0);
let stage = "connect";
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  stage = name;
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
  const texts = (reply.content as { type: string; text?: string }[]).filter((item) => item.type === "text").map((item) => item.text || "");
  let data: any;
  try { data = JSON.parse(texts.join("\n")); } catch { throw new Error(`Invalid ${name} response`); }
  assert(!reply.isError, `${name}: ${redactString(String(data.error || "tool error"))}`);
  return data;
}
async function profile(path: string, key: string) {
  const data = await tool("magileads_get", { path });
  assert(data.result?.[key], `Missing ${key}`);
  return data.result[key];
}
async function roundTripSharing(resource_type: string, id: number, path: string, key: string) {
  await tool("share_resource", { resource_type, resource_id: id, target_type: "user", target_ids: [target], name: marker, confirm: true });
  const shared = await profile(path, key);
  const hasTarget = (rule: any) => String(rule.sharing_type_to).toLowerCase() === "user" && (rule.ids_list ?? rule.sharing_targets?.map((item: any) => item.id) ?? []).includes(target);
  assert(shared.sharing.some(hasTarget), "Share accepted but missing in reread");
  await tool("share_resource", { resource_type, resource_id: id, action: "revoke", target_type: "user", target_ids: [target], confirm: true });
  assert(!(await profile(path, key)).sharing.some(hasTarget), "Revoke accepted but still present in reread");
  results.push({ check: `${resource_type}_share_and_revoke`, passed: true, id });
}
async function verifyCopy(id: number) {
  // Async jobs can outlast this recipe. Never turn a pending job into an automatic retry.
  let status: any;
  for (let i = 0; i < 10; i++) {
    status = await tool("get_contact_list_status", { contact_list_id: id });
    if (status.contacts === 2) break;
    const error = status.jobs?.some((job: any) => ["error", "failed"].includes(String(job.state).toLowerCase()));
    assert(!error, "Destination copy job failed; never replay automatically");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const completed = status.contacts === 2;
  results.push({ check: "global_two_lists_filter_cursor_and_copy", passed: completed ? true : null,
    status: completed ? "completed" : "pending_or_unverified", destination_list_id: id, contacts: status.contacts, jobs: status.jobs });
  if (!completed) process.exitCode = 2;
}
try {
  await client.connect(transport);
  const me = await tool("get_account_overview");
  assert.equal(me.id, expected, "Unexpected source account; no mutations permitted");
  results.push({ check: "original_account", passed: true, id: me.id });
  for (const resource_type of ["email_model", "smv_model", "workflow", "contact_list"]) {
    const listed = await tool("list_copyable_resources", { resource_type, per_page: 2 });
    assert(Array.isArray(listed.resources), "Missing compact resource list");
    results.push({ check: `list_${resource_type}`, passed: true, total: listed.total });
  }
  const unmatched = [{ field: "email", op: "equals", value: `qa-${crypto.randomUUID()}@example.invalid` }];
  const empty = await tool("query_all_contacts", { criteria: unmatched });
  assert.equal(empty.selected, 0);
  results.push({ check: "global_filter_no_match", passed: true });
  if (verifyDestinationId) {
    assert(Number.isSafeInteger(verifyDestinationId) && verifyDestinationId > 0, "Invalid verification destination ID");
    await verifyCopy(verifyDestinationId);
  }
  else if (!writes) results.push({ check: "mutations", skipped: "Set MAGILEADS_TEST_ALLOW_WRITES=true and an authorized target to enable" });
  else {
    let modelId: number;
    if (process.env.MAGILEADS_TEST_RESUME_MARKER) {
      const existing = await tool("list_copyable_resources", { resource_type: "email_model", search: marker });
      assert.equal(existing.resources.length, 1, "Cannot uniquely resume previous QA fixture");
      modelId = existing.resources[0].id;
    } else {
      const model = await tool("create_email_model", { name: marker, subject: marker, text: "Synthetic QA template. No message will be sent.", confirm: true });
      modelId = model.result?.model_id ?? model.result?.model_profile?.id ?? model.result?.id;
      if (!Number.isSafeInteger(modelId)) artifacts.push({ type: "email_model", account_id: expected, outcome: "created_or_uncertain_id_missing", name: marker });
    }
    assert(Number.isSafeInteger(modelId), "Missing created model ID");
    artifacts.push({ type: "email_model", id: modelId, account_id: expected });
    await roundTripSharing("email_model", modelId, `/models/email/${modelId}`, "model_profile");
    const copied = await tool("copy_resources_to_user", { resource_type: "email_model", resource_ids: [modelId], target_user_id: target, confirm: true });
    assert.equal(copied.accepted, 1);
    artifacts.push({ type: "email_model_copy", account_id: target, response: copied.results[0].result });
    results.push({ check: "email_model_copy", passed: true });
    const lists: number[] = [];
    for (const suffix of ["source A", "source B", "destination"]) {
      const created = await tool("magileads_request", { method: "POST", path: "/contact-lists", body: { name: `${marker} ${suffix}` }, confirm: true });
      const id = created.result?.contact_list_id;
      assert(Number.isSafeInteger(id), "Missing created list ID");
      lists.push(id);
      artifacts.push({ type: "contact_list", id, account_id: expected });
    }
    await roundTripSharing("contact_list", lists[2], `/contact-lists/${lists[2]}`, "contact_list_profile");
    const emailSuffix = `qa-${crypto.randomUUID()}@example.invalid`;
    for (let i = 0; i < 2; i++) await tool("add_contact_to_list", { contact_list_id: lists[i], properties: [{ field: "email", value: `${i}-${emailSuffix}` }], confirm: true });
    const criteria = [{ field: "email", op: "contains", value: emailSuffix }];
    const selection = await tool("query_all_contacts", { criteria, per_page: 1, page: 2 });
    assert.equal(selection.selected, 2, "Global filter must find exactly the two QA contacts");
    assert.equal(selection.sample.page, 2);
    const copy = await tool("copy_contacts_across_lists", { criteria, destination_list_id: lists[2], confirm_count: selection.selected, selection_fingerprint: selection.selection_fingerprint, confirm: true });
    results.push({ check: "global_copy_request", passed: true, selected: selection.selected, result: copy.result });
    await verifyCopy(lists[2]);
    // Test metadata-only SMV sharing on a new clone, never on an existing audio model.
    const smv = await tool("list_copyable_resources", { resource_type: "smv_model", per_page: 100 });
    const owned = smv.resources.find((item: any) => item.created_by === expected && !item.from_sharing);
    if (!owned) results.push({ check: "smv_metadata_sharing", skipped: "No owned SMV fixture available" });
    else {
      const clone = await tool("copy_resources_to_user", { resource_type: "smv_model", resource_ids: [owned.id], target_user_id: expected, confirm: true });
      const cloneId = clone.results[0]?.result?.model_id;
      assert(Number.isSafeInteger(cloneId), "Missing SMV clone ID");
      artifacts.push({ type: "smv_model_clone", id: cloneId, account_id: expected });
      await roundTripSharing("smv_model", cloneId, `/models/smv/${cloneId}`, "model_profile");
    }
  }
} catch (error) {
  process.exitCode = 1;
  results.push({ check: stage, passed: false, error: redactString(error instanceof Error ? error.message : "Unknown failure") });
} finally {
  await client.close();
  console.log(JSON.stringify({ transport: "local_stdio", proves: "API payload compatibility; does not validate deployed OAuth", writes_enabled: writes, marker, results, artifacts,
    cleanup: "QA resources are labelled and retained; the MCP contract intentionally exposes no DELETE" }, null, 2));
}
