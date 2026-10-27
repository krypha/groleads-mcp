/** Live comparison of two deployed MCP domains with fresh public OAuth grants.
 * Credentials stay in memory/environment. Only authorized demo accounts may be used.
 * Read-only business calls; --allow-switch additionally selects the known target
 * only if returned by the authorized list, then explicitly restores the original.
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const issuer = "https://app.api-magileads.net";
const domains = ["https://mcp.magileads.io", "https://mcp.surleads.com"];
const expected = Number(process.env.MAGILEADS_TEST_EXPECTED_USER_ID);
const target = Number(process.env.MAGILEADS_TEST_TARGET_USER_ID);
const allowSwitch = process.argv.includes("--allow-switch");
assert(Number.isSafeInteger(expected) && expected > 0, "Expected demo account required");
assert(!allowSwitch || (Number.isSafeInteger(target) && target > 0 && target !== expected), "Distinct authorized target required");
assert(process.env.MAGILEADS_EMAIL && process.env.MAGILEADS_PASSWORD, "Demo credentials required in environment");
const records: Record<string, unknown>[] = [];
function record(check: string, data: Record<string, unknown> = {}) {
  const row = { check, ...data };
  records.push(row);
  console.log(JSON.stringify(row));
}
class SafeFailure extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new SafeFailure(code); }
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(25_000) });
}
async function jsonRequest(url: string, init: RequestInit = {}): Promise<{ response: Response; data: any }> {
  const response = await request(url, init);
  let data;
  try { data = await response.json(); } catch { throw new SafeFailure(`non_json_http_${response.status}`); }
  return { response, data };
}
const json = (data: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(data) });
const apiEndpoint = (value: unknown): string => {
  check(typeof value === "string" && new URL(value).origin === issuer, "unexpected_authorization_endpoint");
  return value;
};
let clientId = "";
let metadata: any;
const grants: { resource: string; access: string; refresh?: string }[] = [];
let step = "setup";
try {
  step = "login";
  const login = await jsonRequest(`${issuer}/users/authentication`, json({ email: process.env.MAGILEADS_EMAIL, password: process.env.MAGILEADS_PASSWORD }));
  check(login.response.ok && typeof login.data.access_token === "string", `demo_login_${login.response.status}`);
  const webHeaders = { Authorization: `Bearer ${login.data.access_token}` };
  const me = await jsonRequest(`${issuer}/users/me`, { headers: webHeaders });
  check(me.response.ok && me.data.user_profile?.id === expected, "unexpected_original_account");
  record("demo_login_identity", { passed: true, account_id: expected, level: me.data.user_profile.level ?? null,
    reseller_id: me.data.user_profile.reseller_id ?? me.data.user_profile.reseller?.id ?? null });
  step = "discovery";
  const discovery = await jsonRequest(`${issuer}/.well-known/oauth-authorization-server`);
  check(discovery.response.ok && discovery.data.issuer === issuer, "invalid_oauth_discovery");
  metadata = discovery.data;
  step = "register_public_qa_client";
  const registered = await jsonRequest(apiEndpoint(metadata.registration_endpoint), json({ client_name: `Magileads reseller switch QA ${new Date().toISOString()}`,
    redirect_uris: domains.map((domain) => `${domain}/oauth-test/callback`), grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp:read mcp:write" }));
  check(registered.response.ok && typeof registered.data.client_id === "string", `client_registration_${registered.response.status}`);
  clientId = registered.data.client_id;
  record("public_qa_client_registered", { passed: true, shared_client_for_both_domains: true });
  for (const domain of domains) {
    const resource = `${domain}/mcp`;
    let bearer = "";
    let initial: any;
    let switchAttempted = false;
    let id = 0;
    async function rpc(method: string, params?: unknown): Promise<any> {
      const call = await jsonRequest(resource, json({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) },
        { Authorization: `Bearer ${bearer}`, Accept: "application/json, text/event-stream" }));
      check(call.response.ok && call.data.result && !call.data.error, `mcp_http_${call.response.status}`);
      return call.data.result;
    }
    async function tool(name: string, args: Record<string, unknown> = {}) {
      step = `${new URL(domain).host}:${name}`;
      const result = await rpc("tools/call", { name, arguments: args });
      let data: any = {};
      let context: any;
      for (const item of result.content ?? []) {
        if (item.type !== "text") continue;
        try {
          const parsed = JSON.parse(item.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (!Object.keys(data).length) data = parsed;
            context = parsed.account_context ?? context;
          }
        } catch { /* No raw responses, bearer values or cursors in diagnostics. */ }
      }
      if (result.isError) {
        const code = result.content?.map((item: any) => String(item.text || "")).join(" ").match(/\((delegation_denied|invalid_target|invalid_client|invalid_request|invalid_control_response|target_unavailable|delegation_expired)\)/)?.[1];
        throw new SafeFailure(code || "mcp_tool_failed");
      }
      return { data, context };
    }
    try {
      step = `${new URL(domain).host}:oauth_authorize`;
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const redirect = `${domain}/oauth-test/callback`;
      const url = new URL(apiEndpoint(metadata.authorization_endpoint));
      url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state,
        scope: "mcp:read mcp:write", resource }).toString();
      const authorization = await request(url.href);
      check([302, 303].includes(authorization.status), `authorization_${authorization.status}`);
      const consent = new URL(authorization.headers.get("location") || "");
      check(consent.protocol === "https:", "insecure_consent_origin");
      const transaction = consent.searchParams.get("transaction_id");
      check(transaction && /^[a-f0-9]{32,128}$/.test(transaction), "missing_consent_transaction");
      const transactionUrl = `${issuer}/oauth/authorization-transactions/${transaction}`;
      const viewed = await jsonRequest(transactionUrl, { headers: webHeaders });
      check(viewed.response.ok && viewed.data.transaction?.resource === resource, `consent_read_${viewed.response.status}`);
      step = `${new URL(domain).host}:oauth_consent`;
      // Same documented decision value as the existing consent frontend.
      const approved = await jsonRequest(transactionUrl, json({ decision: "approved" }, { ...webHeaders, Origin: consent.origin }));
      check(approved.response.ok && typeof approved.data.redirect_url === "string", `consent_approval_${approved.response.status}`);
      const callback = new URL(approved.data.redirect_url);
      check(callback.origin + callback.pathname === redirect && callback.searchParams.get("state") === state, "invalid_consent_callback");
      const code = callback.searchParams.get("code");
      check(code, "missing_authorization_code");
      const exchanged = await jsonRequest(apiEndpoint(metadata.token_endpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code_verifier: verifier, code, resource }) });
      check(exchanged.response.ok && typeof exchanged.data.access_token === "string", `authorization_code_exchange_${exchanged.response.status}`);
      bearer = exchanged.data.access_token;
      grants.push({ resource, access: bearer, refresh: exchanged.data.refresh_token });
      record("fresh_oauth_grant", { passed: true, resource });
      const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reseller-switch-qa", version: "1" } });
      const catalogue = await rpc("tools/list");
      check(catalogue.tools?.some((item: any) => item.name === "list_switchable_accounts"), "switch_tools_not_exposed");
      initial = (await tool("get_active_account")).context;
      check(initial?.original_account?.id === expected && initial.active_account?.id === expected && !initial.is_switched, "unexpected_fresh_account_context");
      const overview = await tool("get_account_overview");
      check(overview.data.id === expected, "original_business_identity_mismatch");
      const defaultList = await tool("list_switchable_accounts");
      check(Array.isArray(defaultList.data.accounts), "missing_default_account_list");
      record("default_authorized_account_list", { passed: true, resource, account_ids: defaultList.data.accounts.map((item: any) => item.id),
        count: defaultList.data.accounts.length, has_next_page: defaultList.data.next_cursor !== null });
      let cursor: string | undefined;
      let found = false;
      let total = 0;
      let pages = 0;
      const accountIds: number[] = [];
      const seen = new Set<string>();
      do {
        const list = await tool("list_switchable_accounts", { limit: 100, ...(cursor ? { cursor } : {}) });
        check(Array.isArray(list.data.accounts), "missing_account_list");
        total += list.data.accounts.length;
        accountIds.push(...list.data.accounts.map((item: any) => item.id));
        pages++;
        found ||= list.data.accounts.some((item: any) => item.id === target);
        const next = list.data.next_cursor;
        check(next === null || (typeof next === "string" && !seen.has(next)), "invalid_account_cursor");
        if (next) seen.add(next);
        cursor = next || undefined;
      } while (cursor && pages < 30);
      record("authorized_account_list", { passed: true, resource, version: initialized.serverInfo?.version, original_account_id: expected,
        count: total, account_ids: accountIds, pages, complete: !cursor, target_user_id: target, target_found: found });
      if (!found || !allowSwitch) record("switch", { resource, status: "not_attempted", reason: !found ? "target_absent_from_authorized_list" : "read_only_run" });
      else {
        const preview = await tool("switch_account", { user_id: target });
        check(preview.data.dry_run === true && preview.context?.revision === initial.revision, "switch_preview_changed_context");
        switchAttempted = true;
        const selected = await tool("switch_account", { user_id: target, confirm: true, account_revision: initial.revision });
        check(selected.context?.active_account?.id === target, "switch_target_mismatch");
        check((await tool("get_account_overview")).data.id === target, "switched_business_identity_mismatch");
        record("switch", { passed: true, resource, original_account_id: expected, active_account_id: target });
      }
    } catch (error) {
      process.exitCode = 1;
      record("domain_diagnostic", { passed: false, resource, step, error: error instanceof SafeFailure ? error.message : "network_or_protocol_failure_details_suppressed" });
    } finally {
      if (switchAttempted && bearer) {
        try {
          const current = (await tool("get_active_account")).context;
          check(current?.original_account?.id === expected, "teardown_original_mismatch");
          if (current.active_account.id === target) {
            const returned = await tool("return_to_original_account", { confirm: true, account_revision: current.revision });
            check(returned.context?.active_account?.id === expected, "return_context_mismatch");
          } else check(current.active_account.id === expected, "concurrent_selection_do_not_overwrite");
          check((await tool("get_account_overview")).data.id === expected, "restored_business_identity_mismatch");
          record("original_account_restored", { passed: true, resource, active_account_id: expected });
        } catch { process.exitCode = 1; record("teardown", { passed: false, resource, error: "original_account_restoration_unconfirmed" }); }
      }
    }
  }
} catch (error) {
  process.exitCode = 1;
  record("setup", { passed: false, step, error: error instanceof SafeFailure ? error.message : "network_or_protocol_failure_details_suppressed" });
} finally {
  if (metadata?.revocation_endpoint && clientId) {
    for (const grant of grants) {
      let revoked = true;
      for (const [hint, token] of [["refresh_token", grant.refresh], ["access_token", grant.access]]) {
        if (typeof token !== "string") continue;
        try {
          const response = await request(apiEndpoint(metadata.revocation_endpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, token, token_type_hint: hint! }) });
          revoked &&= response.ok;
          await response.body?.cancel();
        } catch { revoked = false; }
      }
      record("qa_grant_cleanup", { resource: grant.resource, revoked });
    }
  }
  if (process.env.MAGILEADS_TEST_REPORT_PATH) await writeFile(process.env.MAGILEADS_TEST_REPORT_PATH, JSON.stringify({ at: new Date().toISOString(), transport: "deployed_http_oauth", records }, null, 2));
}
