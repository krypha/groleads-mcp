/** Authenticated live checks against the real API through this checkout's MCP.
 * No secrets in arguments/output. Read-only unless explicit mutation flags are set.
 * Run only with a dedicated OAuth authorization for demonstration accounts.
 */
import { loadOAuthConfig } from "../src/oauth/config.js";

const flags = new Set(process.argv.slice(2));
const allowSwitch = flags.has("--allow-switch");
const allowModel = flags.has("--allow-create-model");
const subjectToken = process.env.MCP_TEST_SUBJECT_TOKEN;
const originalId = Number(process.env.MCP_TEST_EXPECTED_USER_ID);
const targetId = Number(process.env.MCP_TEST_TARGET_USER_ID);
const outcomes: { check: string; status: "PASS" | "FAIL" | "BLOCKED"; detail?: string }[] = [];
const record = (check: string, status: "PASS" | "FAIL" | "BLOCKED", detail?: string) => {
  outcomes.push({ check, status, ...(detail ? { detail } : {}) });
  console.log(JSON.stringify(outcomes.at(-1)));
};
class CheckFailure extends Error {
  constructor(public readonly safeCode: string) { super(safeCode); }
}
function assert(value: unknown, safeCode: string): asserts value {
  if (!value) throw new CheckFailure(safeCode);
}
type Context = {
  revision: string; is_switched: boolean;
  original_account: { id: number }; active_account: { id: number };
  selection_status?: string;
};
type Reply = { error: boolean; data: Record<string, any>; context?: Context };

async function main(): Promise<void> {
  const missing = ["OAUTH_ISSUER", "OAUTH_MCP_RESOURCE", "OAUTH_API_RESOURCE", "OAUTH_INTERNAL_CLIENT_ID", "OAUTH_INTERNAL_CLIENT_SECRET", "MCP_TEST_SUBJECT_TOKEN"]
    .filter((name) => !process.env[name]);
  if (missing.length) {
    record("authenticated live prerequisites", "BLOCKED", `Missing environment variables: ${missing.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (allowModel && !allowSwitch) throw new CheckFailure("model_creation_requires_explicit_switch_test");
  if (allowSwitch && (!Number.isSafeInteger(originalId) || originalId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0 || originalId === targetId)) {
    throw new CheckFailure("explicit_distinct_original_and_target_ids_required_for_mutations");
  }
  const config = loadOAuthConfig();
  // The harness deliberately exercises the automatic private HTTP OAuth path.
  process.env.MCP_HTTP_AUTH = "oauth";
  process.env.MCP_TOOL_PROFILE = "full";
  const { createHttpServer } = await import("../src/http.js");
  const server = createHttpServer();
  let origin = "";
  let switchedByThisTest = false;
  let switchOutcomeUnknown = false;
  let rpcId = 0;
  let failed = false;

  async function rpc(method: string, params?: unknown): Promise<any> {
    const response = await fetch(`${origin}${config.mcpPath}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: {
        Host: new URL(config.mcpResource).host, Authorization: `Bearer ${subjectToken}`,
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
    });
    assert(response.status === 200, `mcp_http_${response.status}`);
    const payload = await response.json() as { result?: unknown; error?: unknown };
    assert(payload.result && !payload.error, "invalid_json_rpc_result");
    return payload.result;
  }
  async function tool(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const result = await rpc("tools/call", { name, arguments: args });
    let data: Record<string, any> = {};
    let context: Context | undefined;
    for (const item of result.content ?? []) {
      if (item.type !== "text") continue;
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (Object.keys(data).length === 0) data = parsed;
          context = parsed.account_context ?? context;
        }
      } catch { /* Never print raw error text or cursor values. */ }
    }
    if (context?.selection_status === "unknown_after_change") switchOutcomeUnknown = true;
    return { data, context, error: result.isError === true };
  }
  const active = async (): Promise<Context> => {
    const result = await tool("get_active_account");
    assert(!result.error && result.context?.revision, "get_active_account_failed");
    return result.context;
  };

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string", "no_loopback_port");
    origin = `http://127.0.0.1:${address.port}`;
    const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "magileads-switch-live-check", version: "1" } });
    record("local MCP initialization with real OAuth token", "PASS", `MCP ${initialized.serverInfo?.version ?? "unknown"}`);
    const listed = await rpc("tools/list");
    assert(listed.tools?.some((item: { name: string }) => item.name === "get_active_account"), "context_tool_missing_for_scope");
    record("automatic private OAuth discovery", "PASS");
    const initial = await active();
    if (originalId > 0) assert(initial.original_account.id === originalId, "unexpected_original_account");
    record("real private context read and confidential client/resource authorization", "PASS", `Original ${initial.original_account.id}; active ${initial.active_account.id}`);
    const overview = await tool("get_account_overview");
    assert(!overview.error && overview.data.id === initial.active_account.id, "business_identity_mismatch");
    record("real contextual token exchange and business identity", "PASS");

    if (!allowSwitch) {
      record("switch / model creation / return", "BLOCKED", "Read-only run; explicit mutation flags and account IDs required.");
      process.exitCode = 2;
      return;
    }
    assert(!initial.is_switched && initial.active_account.id === originalId, "test_authorization_must_start_on_original_account");
    let cursor: string | undefined;
    let foundTarget = false;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 30 && !foundTarget; page++) {
      const result = await tool("list_switchable_accounts", { limit: 100, ...(cursor ? { cursor } : {}) });
      assert(!result.error && Array.isArray(result.data.accounts), "switchable_accounts_failed");
      foundTarget = result.data.accounts.some((item: { id: number }) => item.id === targetId);
      const next = result.data.next_cursor;
      if (next === null) break;
      assert(typeof next === "string" && !seenCursors.has(next), "invalid_or_repeated_account_cursor");
      seenCursors.add(next);
      cursor = next;
    }
    assert(foundTarget, "target_not_found_in_authorized_account_pages");
    record("target appears in the authorized account list", "PASS", `Target ${targetId}`);
    const preview = await tool("switch_account", { user_id: targetId });
    assert(!preview.error && preview.data.dry_run === true, "switch_preview_failed");
    assert((await active()).revision === initial.revision, "preview_changed_selection");
    const missingRevision = await tool("switch_account", { user_id: targetId, confirm: true });
    assert(missingRevision.error && (await active()).revision === initial.revision, "missing_revision_not_rejected");
    record("preview and missing-revision guards", "PASS");
    switchOutcomeUnknown = true;
    const selected = await tool("switch_account", { user_id: targetId, confirm: true, account_revision: initial.revision });
    assert(!selected.error && selected.context?.active_account.id === targetId, "confirmed_switch_failed_or_unknown");
    switchOutcomeUnknown = false;
    switchedByThisTest = true;
    const context = await active();
    assert(context.original_account.id === originalId && context.active_account.id === targetId && context.revision !== initial.revision, "switch_binding_mismatch");
    const targetOverview = await tool("get_account_overview");
    assert(!targetOverview.error && targetOverview.data.id === targetId, "switched_business_identity_mismatch");
    record("confirmed switch and real business identity", "PASS", `Active ${targetId}`);
    const model = { name: `MCP switch QA ${new Date().toISOString()}`, subject: "MCP account switching integration test", text: "Bonjour %first_name%,\nModèle de recette, aucun email envoyé." };
    const stale = await tool("create_email_model", { ...model, confirm: true, account_revision: initial.revision });
    assert(stale.error, "stale_model_confirmation_not_rejected");
    const modelPreview = await tool("create_email_model", model);
    assert(!modelPreview.error && modelPreview.data.dry_run === true && modelPreview.context?.active_account.id === targetId, "model_preview_failed");
    record("model preview and stale-account confirmation guard", "PASS");
    if (allowModel) {
      const created = await tool("create_email_model", { ...model, confirm: true, account_revision: context.revision });
      assert(!created.error && created.data.executed === true, "model_creation_failed_or_uncertain_never_retry");
      const modelId = created.data.result?.model_id ?? created.data.result?.model_profile?.id ?? created.data.result?.id;
      assert(Number.isSafeInteger(modelId) && modelId > 0, "model_created_but_id_unavailable_never_retry");
      const reread = await tool("magileads_get", { path: `/models/email/${modelId}` });
      assert(!reread.error && reread.context?.active_account.id === targetId, "created_model_read_failed");
      record("confirmed model creation and ID re-read, without email sending", "PASS", `Account ${targetId}; model ${modelId} left as labeled test data`);
    } else record("real model creation", "BLOCKED", "--allow-create-model not set; no model saved.");
  } catch (error) {
    failed = true;
    record("authenticated integration", "FAIL", error instanceof CheckFailure ? error.safeCode : "network_or_protocol_error_details_suppressed");
  } finally {
    // This explicit return is pre-authorized test teardown, not a server fallback.
    // Do not replay an uncertain switch or overwrite a concurrent account choice.
    if (switchedByThisTest && !switchOutcomeUnknown) {
      try {
        const context = await active();
        assert(context.active_account.id === targetId, "concurrent_selection_changed_do_not_overwrite");
        const returned = await tool("return_to_original_account", { confirm: true, account_revision: context.revision });
        assert(!returned.error && returned.context?.active_account.id === originalId, "return_failed_or_uncertain_never_retry");
        assert((await active()).active_account.id === originalId, "return_identity_mismatch");
        const overview = await tool("get_account_overview");
        assert(!overview.error && overview.data.id === originalId, "original_business_identity_not_restored");
        record("explicit return and original business identity restored", "PASS", `Active ${originalId}`);
      } catch {
        failed = true;
        record("test teardown", "FAIL", "Could not confirm original account restored; inspect context, never replay blindly.");
      }
    } else if (switchOutcomeUnknown) {
      failed = true;
      record("selection after uncertain switch", "BLOCKED", "Read get_active_account; no automatic switch or return attempted.");
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (failed) process.exitCode = 1;
  else if (outcomes.some((item) => item.status === "BLOCKED")) process.exitCode = 2;
}

await main().catch((error) => {
  record("live test setup", "FAIL", error instanceof CheckFailure ? error.safeCode : "invalid_configuration_or_runtime_error_details_suppressed");
  process.exitCode = 1;
});
