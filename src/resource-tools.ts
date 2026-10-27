import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rawRequest, getMe, getContactList, listDataFields, queryAllContacts, updateSmvSharing, runWithPartialWriteResult, MagileadsError,
  type FilterNode, type ContactsPage, type Raw } from "./magileads.js";
import type { ToolAccess } from "./tools.js";
import { COPYABLE_RESOURCES, SHARABLE_RESOURCES, resourceTypeSchema, shareResourceTypeSchema,
  positiveIdSchema, distinctIdsSchema, targetTypeSchema, SHARING_TARGETS, checkedCount,
  readSharingRules, mergeSharingRules, selectionFingerprint } from "./resource-operations.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const errorText = (error: unknown) => error instanceof MagileadsError
  ? `${error.message}${error.key ? ` (${error.key})` : ""}` : error instanceof Error ? error.message : "Operation failed.";
const fail = (error: unknown): Result => ({ ...ok({ error: errorText(error) }), isError: true });
type Criterion = { field: string; op: string; value?: string | string[] };
type Helpers = {
  criterionSchema: z.ZodType<Criterion>;
  buildFilter: (criteria: Criterion[], match: "all" | "any") => Promise<FilterNode>;
  contactsView: (page: ContactsPage, pageNumber: number, perPage: number, fields: Map<number, string>) => Raw;
};
type Register = (access: ToolAccess) => McpServer["registerTool"];
const readHints = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writeHints = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const listRoutes = [...new Set(Object.values(COPYABLE_RESOURCES).map((item) => `GET ${item.list}`))];
const copyRoutes = Object.values(COPYABLE_RESOURCES).map((item) => `POST ${item.base}/{id}/copy/to/{user_id}`);
const shareRoutes = Object.entries(SHARABLE_RESOURCES).flatMap(([kind, item]) => [
  `GET ${item.base}/{id}`, `${kind === "smv_model" ? "POST" : "PUT"} ${item.base}/{id}`,
]);

function responseObject(value: unknown): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid API response.");
  const data = value as Raw;
  if (data.state === false) throw new Error("The API refused the operation; no automatic retry was performed.");
  return data;
}
function compactResponse(value: unknown, maxBytes = 12_000): unknown {
  const data = responseObject(value);
  const text = JSON.stringify(data);
  const identifiers = Object.fromEntries(["id", "model_id", "workflow_id", "contact_list_id", "job_id", "batch_id"].flatMap((key) =>
    typeof data[key] === "number" || (typeof data[key] === "string" && data[key].length <= 200) ? [[key, data[key]]] : []));
  return text.length <= maxBytes ? data : { response_omitted: true, bytes: text.length, state: data.state, ...identifiers,
    note: "The API accepted the request; its oversized response was omitted, not retried." };
}
const writeRequest = (method: string, path: string, body?: unknown) => rawRequest(method, path, body, false);

export function registerResourceTools(register: Register, helpers: Helpers): void {
  register({ scope: "mcp:read", routes: listRoutes })("list_copyable_resources", {
    title: "Find resources to copy or share", description: "List IDs and names of contact lists, email/LinkedIn/SMS/SMV models or workflows. Searches and pages the complete API list locally, without dumping message bodies. Iterate next_page to enumerate resources for a batch copy. No mandatory duplicate search before creation.",
    inputSchema: { resource_type: resourceTypeSchema, search: z.string().trim().max(200).optional(), page: z.number().int().min(1).max(1_000_000).default(1), per_page: z.number().int().min(1).max(100).default(50) },
    annotations: readHints,
  }, async ({ resource_type, search, page, per_page }): Promise<Result> => {
    try {
      const definition = COPYABLE_RESOURCES[resource_type];
      const data = responseObject(await rawRequest("GET", definition.list));
      const rows = data[definition.listKey];
      if (!Array.isArray(rows)) throw new Error("The API did not return the documented complete resource list.");
      const found = rows.filter((item): item is Raw => !!item && typeof item === "object" && !Array.isArray(item))
        .filter((item) => !search || String(item.name ?? "").toLowerCase().includes(search.toLowerCase()))
        .map((item) => ({ id: positiveIdSchema.parse(item.id), name: typeof item.name === "string" ? item.name.slice(0, 200) : null,
          from_sharing: typeof item.from_sharing === "boolean" ? item.from_sharing : null, created_by: typeof item.created_by === "number" ? item.created_by : null }))
        .sort((a, b) => Number(a.id) - Number(b.id));
      const offset = (page - 1) * per_page;
      return ok({ resource_type, total: found.length, page, per_page,
        next_page: offset + per_page < found.length ? page + 1 : null, resources: found.slice(offset, offset + per_page) });
    } catch (error) { return fail(error); }
  });

  register({ scope: "mcp:write", routes: copyRoutes })("copy_resources_to_user", {
    title: "Copy resources to a user", description: "Copy 1–50 explicitly selected resources of one type to a target user, without sending messages or scheduling campaigns. Supports all message model types, contact lists and workflows. Workflows include their attached models by default (with_models:true). Dry run until confirm:true. Each copy executes once, sequentially; stop on the first failure and report completed/uncertain/unattempted items. No automatic retry or rollback; API permissions still apply. Copying a workflow does not clone a running campaign programmation.",
    inputSchema: { resource_type: resourceTypeSchema, resource_ids: distinctIdsSchema, target_user_id: positiveIdSchema,
      with_models: z.boolean().default(true), confirm: z.boolean().optional() }, annotations: writeHints,
  }, async ({ resource_type, resource_ids, target_user_id, with_models, confirm }): Promise<Result> => {
    try {
      const definition = COPYABLE_RESOURCES[resource_type];
      const operations = resource_ids.map((id) => ({ method: "POST", path: `${definition.base}/${id}/copy/to/${target_user_id}`,
        ...(resource_type === "workflow" ? { body: { with_models } } : {}) }));
      if (confirm !== true) return ok({ dry_run: true, resource_type, target_user_id, copies: operations.length, would_call: operations,
        note: "No API call was made. Confirm the resource IDs, destination user and number of copies." });
      const results: Raw[] = [];
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        try {
          const send = () => writeRequest(operation.method, operation.path, "body" in operation ? operation.body : undefined);
          const result = compactResponse(await (results.length ? runWithPartialWriteResult(send) : send()), 700);
          results.push({ source_id: resource_ids[index], status: "accepted", result });
        } catch (error) {
          results.push({ source_id: resource_ids[index], status: "failed_or_uncertain", error: errorText(error) });
          return { ...ok({ executed: true, partial: true, target_user_id, results,
            unattempted_ids: resource_ids.slice(index + 1), note: "Stopped. Do not replay completed or uncertain copies automatically. No rollback was attempted." }), isError: true };
        }
      }
      return ok({ executed: true, resource_type, target_user_id, accepted: results.length, results,
        note: "API responses are authoritative; accepted does not imply an asynchronous job is already complete." });
    } catch (error) { return fail(error); }
  });

  const grantInputs = {
    target_type: targetTypeSchema, target_ids: distinctIdsSchema,
    name: z.string().trim().min(1).max(200).default("Shared via assistant"),
    allow_write: z.boolean().default(false), allow_delete: z.boolean().default(false), confirm: z.boolean().optional(),
  };
  register({ scope: "mcp:write", routes: shareRoutes })("share_resource", {
    title: "Share or unshare a resource", description: "Grant access to selected users, teams or organizations, or revoke their explicit grants. Supports contact lists, all model types, workflows and data fields. Read-only access by default; write/delete require explicit permission. Reads the complete current ACL only AFTER confirmation, preserves other destinations, never downgrades existing rights during a grant, and refuses hidden/unreadable ACLs. Revoke does not remove access inherited through another group. SMV changes metadata only, never uploads/replaces audio. Dry run until confirm:true. API owner/admin checks apply; the API has no atomic ACL compare-and-set.",
    inputSchema: { resource_type: shareResourceTypeSchema, resource_id: positiveIdSchema,
      action: z.enum(["grant", "revoke"]).default("grant"), ...grantInputs }, annotations: writeHints,
  }, async ({ resource_type, resource_id, action, target_type, target_ids, name, allow_write, allow_delete, confirm }): Promise<Result> => {
    try {
      const definition = SHARABLE_RESOURCES[resource_type];
      const path = `${definition.base}/${resource_id}`;
      const method = resource_type === "smv_model" ? "POST" : "PUT";
      if (confirm !== true) return ok({ dry_run: true, resource_type, resource_id, action, target_type, target_ids,
        permissions: action === "grant" ? { read: true, write: allow_write, delete: allow_delete } : null,
        would_call: [{ method: "GET", path }, { method, path, body: { sharing: "merged with the complete current ACL after confirmation" } }],
        note: "Nothing was read or modified. Other destinations will be preserved; effective inherited access is not revoked." });
      const data = responseObject(await rawRequest("GET", path));
      const profile = responseObject(data[definition.profileKey]);
      const existing = readSharingRules(profile);
      const sharing = mergeSharingRules(existing, { action, target_type, target_ids, name, allow_write, allow_delete });
      if (JSON.stringify(existing) === JSON.stringify(sharing)) return ok({ executed: false, unchanged: true, resource_type, resource_id });
      const result = compactResponse(await (resource_type === "smv_model" ? updateSmvSharing(resource_id, sharing) : writeRequest(method, path, { sharing })));
      return ok({ executed: true, resource_type, resource_id, action, target_type, target_ids, result,
        note: "Other explicit grants were preserved from the latest read. The API has no atomic sharing revision; concurrent ACL edits require coordination." });
    } catch (error) { return fail(error); }
  });

  register({ scope: "mcp:write", routes: ["POST /prm/sharings"] })("share_prm_contacts", {
    title: "Share selected PRM contacts", description: "Create a PRM sharing for explicit contact IDs and user/team/organization destinations. Read-only rights by default. Does not replace other existing PRM sharing rules. Dry run until confirm:true; API ownership/permissions apply.",
    inputSchema: { contact_ids: distinctIdsSchema, ...grantInputs }, annotations: writeHints,
  }, async ({ contact_ids, target_type, target_ids, name, allow_write, allow_delete, confirm }): Promise<Result> => {
    try {
      const body = { sharing: { sharing_type_to: SHARING_TARGETS[target_type], ids_list: target_ids, name,
        read_permission: true, write_permission: allow_write, delete_permission: allow_delete, contact_ids } };
      if (confirm !== true) return ok({ dry_run: true, would_call: { method: "POST", path: "/prm/sharings", body } });
      return ok({ executed: true, result: compactResponse(await writeRequest("POST", "/prm/sharings", body)) });
    } catch (error) { return fail(error); }
  });

  const criteriaInputs = {
    criteria: z.array(helpers.criterionSchema).max(30).refine((items) => JSON.stringify(items).length <= 16_000, "Criteria are too large; no filters are silently dropped.").default([]),
    match: z.enum(["all", "any"]).default("all"), target: z.enum(["matching", "all_except_matching"]).default("matching"),
  };
  async function selection(criteria: Criterion[], match: "all" | "any", target: "matching" | "all_except_matching", perPage: number, page: number) {
    const filter = await helpers.buildFilter(criteria, match);
    const me = await getMe();
    const accountId = positiveIdSchema.parse(me.id);
    const totalPage = await queryAllContacts({ per_page: 1, filter: { mode: "and", values: [] } }, 1);
    const total = checkedCount(totalPage.number_of_results);
    const result = await queryAllContacts({ per_page: perPage, filter }, page);
    const matched = checkedCount(result.number_of_results);
    if (matched > total) throw new Error("The account changed while counting. Refresh the preview before copying.");
    return { filter, result, total, matched, selected: target === "matching" ? matched : total - matched,
      fingerprint: selectionFingerprint({ account_id: accountId, filter, target, total, matched }), accountId };
  }
  const globalReadRoutes = ["GET /data-fields", "GET /users/me", "POST /contact-lists/contacts/search", "GET /contact-lists/contacts/search/{search_id}/page/{page}"];
  register({ scope: "mcp:read", routes: globalReadRoutes })("query_all_contacts", {
    title: "Filter contacts across all account lists", description: "Search ALL contact lists of the active account using readable field identifiers and criteria. Returns total/matching/selected counts, a sample (max 50), pages and a selection_fingerprint for copy_contacts_across_lists. No list ID required. No contacts are copied or modified. target:all_except_matching selects the complement; displayed sample still shows FILTER MATCHES, not the complement. Empty criteria preview the entire account.",
    inputSchema: { ...criteriaInputs, per_page: z.number().int().min(1).max(50).default(20), page: z.number().int().min(1).max(1_000_000).default(1) }, annotations: readHints,
  }, async ({ criteria, match, target, per_page, page }): Promise<Result> => {
    try {
      const view = await selection(criteria, match, target, per_page, page);
      const fields = await listDataFields();
      const identifiers = new Map(fields.map((field) => [field.id, field.identifier]));
      const sample = helpers.contactsView(view.result, page, per_page, identifiers);
      const contacts = sample.contacts as Raw[];
      while (contacts.length && JSON.stringify(sample).length > 40_000) {
        contacts.pop();
        sample.returned = contacts.length;
        sample.sample_truncated = true;
        sample.note = "Sample capped at 40 KB; counts and selection fingerprint remain complete.";
      }
      return ok({ account_id: view.accountId, total_on_account: view.total, matched: view.matched, selected: view.selected,
        target, criteria, match, selection_fingerprint: view.fingerprint,
        sample_matches_filter: true, sample,
        note: "Read-only snapshot. Pass selected as confirm_count and the fingerprint with identical criteria to copy_contacts_across_lists." });
    } catch (error) { return fail(error); }
  });
  register({ scope: "mcp:write", routes: [...globalReadRoutes, "GET /contact-lists/{id}", "POST /contact-lists/contacts/copy/{contact_list_id_destination}"] })("copy_contacts_across_lists", {
    title: "Copy a global filtered selection to a contact list", description: "Copy contacts selected across ALL lists of the active account into one existing destination list. First call query_all_contacts, then supply its selected count and selection_fingerprint with the same criteria. Dry run is local. On confirm:true, recounts and verifies account/filter/count before sending ONE copy request. Empty criteria require copy_entire_account:true. No contacts are deleted, no automatic retry; the backend filter copy is not an atomic frozen snapshot, so source edits during execution require coordination.",
    inputSchema: { ...criteriaInputs, destination_list_id: positiveIdSchema, confirm_count: z.number().int().min(0).safe().optional(),
      selection_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), copy_entire_account: z.boolean().default(false), confirm: z.boolean().optional() }, annotations: writeHints,
  }, async ({ criteria, match, target, destination_list_id, confirm_count, selection_fingerprint, copy_entire_account, confirm }): Promise<Result> => {
    try {
      if (confirm !== true) return ok({ dry_run: true, destination_list_id, criteria, match, target, copy_entire_account,
        would_call: { method: "POST", path: `/contact-lists/contacts/copy/${destination_list_id}` },
        note: "Nothing was read or copied. Run query_all_contacts and confirm its count/fingerprint before execution." });
      if (!criteria.length && !copy_entire_account) throw new Error("Empty criteria select the entire account. Set copy_entire_account:true only with explicit authorization.");
      if (confirm_count === undefined || !selection_fingerprint) throw new Error("A preview confirm_count and selection_fingerprint are required; no copy was sent.");
      const view = await selection(criteria, match, target, 1, 1);
      if (confirm_count !== view.selected || selection_fingerprint !== view.fingerprint) {
        throw new Error("The account, filter or live count differs from the preview. Run query_all_contacts again and obtain a new confirmation; no copy was sent.");
      }
      await getContactList(destination_list_id);
      if (view.selected === 0) return ok({ executed: false, selected: 0, note: "No contacts selected; no copy API call was made." });
      const body = { contacts_selection: { filter: view.filter, contact_ids: [], excluded_contact_ids: [], reverse_selection: target === "all_except_matching" } };
      const result = compactResponse(await writeRequest("POST", `/contact-lists/contacts/copy/${destination_list_id}`, body));
      return ok({ executed: true, destination_list_id, selected_before_execution: view.selected, result,
        next_check: { tool: "get_contact_list_status", arguments: { contact_list_id: destination_list_id } },
        note: "Copy request sent once; it may run asynchronously. Poll the destination Copy job until Completed before declaring completion. No deletion or retry; the filter selection is not locked against concurrent source edits." });
    } catch (error) { return fail(error); }
  });
}
