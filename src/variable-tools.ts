import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMe, listDataFields, rawRequest, MagileadsError } from "./magileads.js";
import type { ToolAccess } from "./tools.js";
import { readReplacements, mergeReplacements, replacementChangesSchema, normalizeFieldName } from "./variable-replacements.js";
const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: unknown) => ({ ...ok({ error: error instanceof Error ? error.message : "Operation failed.",
  ...(error instanceof MagileadsError && error.key ? { code: error.key } : {}) }), isError: true });
const readRoutes = ["GET /users/me", "GET /data-fields"];
export function registerVariableTools(register: (access: ToolAccess) => McpServer["registerTool"]) {
  register({ scope: "mcp:read", routes: readRoutes })("get_variable_replacements", {
    title: "Get account variable fallbacks",
    description: "Read the active account's variable replacement/fallback settings, e.g. Civilité -> Mr/Mme when a contact lacks salutation. Lists readable fields with labels, identifiers, exact placeholders and configured replacement values; no contact list ID needed. This is an account profile setting, not a data-field definition or bulk contact edit. Use set_variable_replacements to change selected fallbacks, preserving other settings.",
    inputSchema: { search: z.string().trim().max(256).optional(), page: z.number().int().min(1).max(1_000_000).default(1), per_page: z.number().int().min(1).max(50).default(25) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ search, page, per_page }) => {
    try {
      const profile = await getMe();
      const saved = readReplacements(profile);
      const fields = await listDataFields();
      const values = new Map(saved.map((row) => [row.datafield_id, row.replacement]));
      const found = fields.filter((field) => !search || [field.name, field.identifier, field.identifier_placeholder, String(field.id)]
        .some((value) => typeof value === "string" && normalizeFieldName(value).includes(normalizeFieldName(search))));
      const offset = (page - 1) * per_page;
      const unreadable = saved.filter((row) => !fields.some((field) => field.id === row.datafield_id)).map((row) => row.datafield_id);
      return ok({ account_id: profile.id, configured_replacements: saved.length, total_fields: found.length, page, per_page,
        next_page: offset + per_page < found.length ? page + 1 : null, unavailable_field_count: unreadable.length,
        unavailable_field_ids: unreadable.slice(0, 50), unavailable_field_ids_truncated: unreadable.length > 50,
        fields: found.slice(offset, offset + per_page).map((field) => {
          const replacement = values.get(field.id) ?? null;
          const metadata = [field.identifier, field.name, field.identifier_placeholder];
          return { datafield_id: field.id, identifier: field.identifier.slice(0, 128), label: field.name.slice(0, 128),
            placeholder: typeof field.identifier_placeholder === "string" ? field.identifier_placeholder.slice(0, 128) : null,
            ...(metadata.some((value) => typeof value === "string" && value.length > 128) ? { field_metadata_truncated: true } : {}),
            ...(replacement && replacement.length > 512 ? { replacement_preview: replacement.slice(0, 512), replacement_truncated: true, replacement_characters: replacement.length } : { replacement }) };
        }),
        note: "Account fallbacks apply when a contact value is absent; contact properties are not modified. Null/empty replacement means no configured fallback. Long values have an explicit preview; updates still merge the complete saved values." });
    } catch (error) { return fail(error); }
  });
  register({ scope: "mcp:write", routes: [...readRoutes, "PUT /users/me"] })("set_variable_replacements", {
    title: "Set account variable fallbacks",
    description: "Set selected account-level variable replacements, e.g. [{field:'Civilité',replacement:'Mr/Mme'}]. Resolve by readable identifier, placeholder, unambiguous label or numeric ID. Preserve every unrelated saved replacement. Empty replacement removes only that field's fallback. No contact data is filled or modified, no messages are sent, and no field definition or other profile setting is changed. Local dry run until confirm:true. Reads account preferences and fields after confirmation, then sends one complete merged configuration. Requires read+write scopes. Concurrent account setting edits are not locked atomically.",
    inputSchema: { replacements: replacementChangesSchema, confirm: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ replacements, confirm }) => {
    try {
      if (confirm !== true) return ok({ dry_run: true, changes: replacements, would_read: readRoutes,
        would_call: { method: "PUT", path: "/users/me", body: { datafields_replacement: "complete saved configuration merged with these selected changes after confirmation" } },
        note: "Nothing was read or changed. Confirm the account and these fallback changes; existing unrelated settings will be preserved. Contact data stays unchanged." });
      const profile = await getMe();
      const existing = readReplacements(profile);
      const merged = mergeReplacements(existing, await listDataFields(), replacements);
      if (merged.unchanged) return ok({ executed: false, unchanged: true, account_id: profile.id, changes: merged.changes });
      const result = await rawRequest("PUT", "/users/me", { datafields_replacement: merged.next }, false);
      if (!result || typeof result !== "object" || (result as { state?: unknown }).state !== true) throw new Error("The API did not confirm the settings update. Do not retry automatically; read get_variable_replacements first.");
      return ok({ executed: true, account_id: profile.id, configured_replacements: merged.next.length, changes: merged.changes,
        note: "Account fallback update accepted once. Other replacements were preserved from the latest read; no contacts or messages were modified. Concurrent profile edits require coordination." });
    } catch (error) { return fail(error); }
  });
}
