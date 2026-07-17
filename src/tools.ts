import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  generateMapsUrls,
  extractMaps,
  searchContactLists,
  getContactList,
  listDataFields,
  countContacts,
  deleteContactsSelection,
  EMPTY_FILTER,
  MagileadsError,
  type DataField,
  type FilterNode,
  type FilterValue,
} from "./magileads.js";

const MAX_LINKS = 40;
const MAX_URLS_PER_EXTRACT = 10; // the extract endpoint accepts at most 10 URLs
const MAX_RESULTS = 200;
const MAX_CRITERIA = 30; // guard against abusive/degenerate filters (API also caps)

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Serialize a success payload as pretty JSON text content. */
function ok(payload: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Turn any thrown error into an MCP tool error (never throw out of a handler). */
function fail(err: unknown): TextResult {
  let message: string;
  if (err instanceof MagileadsError) {
    const parts = [err.message];
    if (err.key) parts.push(`key=${err.key}`);
    if (err.detail) parts.push(err.detail);
    message = parts.join(" — ");
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/* -------------------------------------------------------------------------- */
/* Contact-selection filter helpers (shared by preview + delete)               */
/* -------------------------------------------------------------------------- */

/**
 * Friendly operator → Magileads filter `type` (verified against api.groleads.com
 * swagger `Type` enum). Aliases are accepted so an agent can say `starts_with`,
 * `gt`, `has_value`, `is_empty`, … and still land on the exact enum value.
 */
const OP_TO_TYPE: Record<string, string> = {
  contains: "contains",
  not_contains: "not_contains",
  equals: "equals",
  eq: "equals",
  is: "equals",
  not_equals: "not_equals",
  neq: "not_equals",
  is_not: "not_equals",
  starts_with: "start_with",
  start_with: "start_with",
  ends_with: "end_with",
  end_with: "end_with",
  greater_than: "more_than",
  more_than: "more_than",
  gt: "more_than",
  greater_or_equal: "more_or_equal_than",
  more_or_equal_than: "more_or_equal_than",
  gte: "more_or_equal_than",
  less_than: "less_than",
  lt: "less_than",
  less_or_equal: "less_or_equal_than",
  less_or_equal_than: "less_or_equal_than",
  lte: "less_or_equal_than",
  has_value: "does_exist",
  does_exist: "does_exist",
  exists: "does_exist",
  is_not_empty: "does_exist",
  is_empty: "does_not_exist",
  does_not_exist: "does_not_exist",
  not_exists: "does_not_exist",
  is_blank: "does_not_exist",
};

/** Enum values that take NO `value` (existence checks). */
const NO_VALUE_TYPES = new Set(["does_exist", "does_not_exist"]);

/**
 * `field_name` tokens the API accepts directly, beyond real data-field ids:
 *   id → the contact id, any_datafield → search across all fields, bounced.
 * (see the GET /contacts endpoint description in the swagger.)
 */
const SPECIAL_FIELDS = new Set(["id", "any_datafield", "bounced"]);

const OP_ALIASES = [...new Set(Object.keys(OP_TO_TYPE))].join(", ");

/** One raw criterion coming from a tool input. */
type Criterion = { field: string; op: string; value?: string | string[] };

const criterionSchema = z.object({
  field: z
    .string()
    .min(1)
    .describe('Field identifier from list_contact_fields, e.g. "email", "company", "first_name". "id" is the contact id.'),
  op: z
    .string()
    .min(1)
    .describe(
      "Operator: contains, not_contains, equals, not_equals, starts_with, ends_with, " +
        "greater_than, greater_or_equal, less_than, less_or_equal, has_value, is_empty.",
    ),
  value: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Value to compare against. Omit for has_value / is_empty (existence checks)."),
});

/**
 * Turn friendly criteria into a Magileads filter node, resolving each `field`
 * identifier to its numeric data_field_id (as a string, per the API).
 * Throws (with a clear, listing message) on an unknown field or operator, or on
 * a missing value for a value operator — callers wrap this in fail().
 */
async function buildFilter(criteria: Criterion[], match: "all" | "any"): Promise<FilterNode> {
  const fields = await listDataFields();
  const byIdentifier = new Map<string, number>();
  for (const f of fields) {
    if (f.identifier) byIdentifier.set(f.identifier.trim().toLowerCase(), f.id);
  }

  const values: FilterValue[] = criteria.map((c, i) => {
    const where = `criteria[${i}]`;
    const opKey = c.op.trim().toLowerCase();
    const type = OP_TO_TYPE[opKey];
    if (!type) {
      throw new Error(`${where}: unknown op "${c.op}". Allowed ops: ${OP_ALIASES}.`);
    }

    const raw = c.field.trim();
    const lc = raw.toLowerCase();
    let fieldName: string;
    if (byIdentifier.has(lc)) {
      fieldName = String(byIdentifier.get(lc));
    } else if (SPECIAL_FIELDS.has(lc)) {
      fieldName = lc;
    } else if (/^\d+$/.test(raw)) {
      fieldName = raw; // caller already passed a data_field_id
    } else {
      const known = [...byIdentifier.keys()].sort().join(", ") || "(none)";
      throw new Error(
        `${where}: unknown field "${c.field}". Available identifiers: ${known}. ` +
          `Call list_contact_fields to see them.`,
      );
    }

    const leaf: FilterValue = { field_name: fieldName, type };
    if (NO_VALUE_TYPES.has(type)) {
      // Existence checks carry no value; the API's Value shape still wants the key.
      leaf.value = "";
    } else {
      const hasValue =
        (typeof c.value === "string" && c.value.length > 0) ||
        (Array.isArray(c.value) && c.value.length > 0);
      if (!hasValue) {
        throw new Error(`${where}: op "${c.op}" requires a non-empty value.`);
      }
      leaf.value = c.value as string | string[];
    }
    return leaf;
  });

  return { mode: match === "any" ? "or" : "and", values };
}

/**
 * Resolve a selection to concrete numbers against the LIVE list: the filter, the
 * total contacts, the count matching the filter, and how many the delete would
 * actually remove given `target`. `to_delete` is the guardrail number.
 */
async function resolveSelection(
  listId: number,
  criteria: Criterion[],
  match: "all" | "any",
  target: "matching" | "all_except_matching",
): Promise<{
  list_name: string;
  filter: FilterNode;
  total_count: number;
  matched_count: number;
  to_delete: number;
  to_keep: number;
}> {
  const list = await getContactList(listId);
  const filter = await buildFilter(criteria, match);
  // Count total + matched from the SAME endpoint so the arithmetic is consistent.
  const total_count = await countContacts(listId, EMPTY_FILTER);
  const matched_count = criteria.length === 0 ? total_count : await countContacts(listId, filter);
  const to_delete = target === "matching" ? matched_count : Math.max(total_count - matched_count, 0);
  const to_keep = Math.max(total_count - to_delete, 0);
  return {
    list_name: list?.name ?? String(listId),
    filter,
    total_count,
    matched_count,
    to_delete,
    to_keep,
  };
}

/** Map a field record to the compact shape list_contact_fields returns. */
function fieldView(f: DataField): {
  data_field_id: number;
  identifier: string;
  label: string;
  type: string;
  possible_values?: string[];
} {
  // The API doesn't expose a discrete scalar type on data fields; surface one if
  // a future response carries it, else infer from possible_values (best-effort).
  const rawType =
    (typeof (f as Record<string, unknown>).type === "string" && (f as Record<string, unknown>).type) ||
    (typeof (f as Record<string, unknown>).data_type === "string" && (f as Record<string, unknown>).data_type) ||
    (typeof (f as Record<string, unknown>).field_type === "string" && (f as Record<string, unknown>).field_type) ||
    "";
  const pv = Array.isArray(f.possible_values) ? f.possible_values.filter(Boolean) : [];
  const type = (rawType as string) || (pv.length ? "select" : "text");
  return {
    data_field_id: f.id,
    identifier: f.identifier,
    label: f.name,
    type,
    ...(pv.length ? { possible_values: pv } : {}),
  };
}

/** Register the Google Maps targeting tools onto an McpServer instance. */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "generate_maps_search_urls",
    {
      title: "Generate Google Maps search URLs",
      description:
        "Turn a free-text business query (e.g. 'dentist', 'italian restaurant') plus optional " +
        "locations into ready-to-use Google Maps search URLs — no Google Maps account or manual " +
        "browsing needed. Returns the list of URLs; feed them to `extract_maps_search` (or use " +
        "`run_google_maps_targeting` to do both at once). Generates up to 40 URLs.",
      inputSchema: {
        search: z.string().min(1).describe("Business type / keyword to search, e.g. 'plumber'."),
        locations: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional locations (cities, regions), e.g. ['Paris', 'Lyon']. One URL set per location."),
        max_links: z
          .number()
          .int()
          .optional()
          .describe(`Max number of URLs to generate (1–${MAX_LINKS}, default 20).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, locations, max_links }): Promise<TextResult> => {
      try {
        const body = {
          search: search.trim(),
          ...(locations && locations.length
            ? { locations: locations.map((l) => l.trim()).filter(Boolean) }
            : {}),
          max_links: clamp(Math.trunc(max_links ?? 20), 1, MAX_LINKS),
        };
        const res = await generateMapsUrls(body);
        const urls = (res.google_maps_search_urls ?? []).filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        );
        return ok({ count: urls.length, urls });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "extract_maps_search",
    {
      title: "Extract contacts from Google Maps URLs",
      description:
        "Extract businesses (name, address, phone, website, etc.) from Google Maps search URLs into " +
        "a Groleads contact list. Accepts up to 10 URLs per call. Provide either `contact_list_name` " +
        "(creates a new list) or `contact_list_id` (appends to an existing one). Extraction runs " +
        "asynchronously: this returns the target list id immediately, then poll " +
        "`get_contact_list_status` until its extraction job reaches 'completed'.",
      inputSchema: {
        google_maps_search_urls: z
          .array(z.string().url())
          .min(1)
          .describe(`Google Maps search URLs (max ${MAX_URLS_PER_EXTRACT}). Get them from generate_maps_search_urls.`),
        max_results: z
          .number()
          .int()
          .optional()
          .describe(`Max businesses to extract (1–${MAX_RESULTS}, default 100).`),
        contact_list_name: z
          .string()
          .min(1)
          .optional()
          .describe("Name for a NEW contact list to create with the results."),
        contact_list_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Id of an EXISTING contact list to append the results to."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({
      google_maps_search_urls,
      max_results,
      contact_list_name,
      contact_list_id,
    }): Promise<TextResult> => {
      try {
        const name = contact_list_name?.trim();
        if (!name && !contact_list_id) {
          return fail(new Error("Provide either contact_list_name or contact_list_id."));
        }
        const urls = Array.from(
          new Set(google_maps_search_urls.map((u) => u.trim()).filter(Boolean)),
        ).slice(0, MAX_URLS_PER_EXTRACT);
        if (!urls.length) return fail(new Error("No valid URLs provided."));

        const res = await extractMaps({
          google_maps_search_urls: urls,
          max_results: clamp(Math.trunc(max_results ?? 100), 1, MAX_RESULTS),
          ...(name ? { contact_list_name: name } : { contact_list_id: contact_list_id! }),
        });
        return ok({
          contact_list_id: res.contact_list_id,
          urls_submitted: urls.length,
          status: "extraction_started",
          note: "Extraction is asynchronous. Poll get_contact_list_status with this contact_list_id.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "run_google_maps_targeting",
    {
      title: "Run a full Google Maps targeting (generate + extract)",
      description:
        "One-shot convenience: generate Google Maps search URLs from a query and immediately extract " +
        "businesses from them into a contact list. Combines generate_maps_search_urls + " +
        "extract_maps_search. Use this when you don't need to review the URLs first. Extraction is " +
        "asynchronous — poll get_contact_list_status afterwards.",
      inputSchema: {
        search: z.string().min(1).describe("Business type / keyword, e.g. 'coworking space'."),
        locations: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional locations, e.g. ['Bordeaux']."),
        contact_list_name: z
          .string()
          .min(1)
          .describe("Name for the new contact list to create with the results."),
        max_links: z
          .number()
          .int()
          .optional()
          .describe(`How many search URLs to generate, capped to ${MAX_URLS_PER_EXTRACT} for extraction (default 5).`),
        max_results: z
          .number()
          .int()
          .optional()
          .describe(`Max businesses to extract (1–${MAX_RESULTS}, default 100).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ search, locations, contact_list_name, max_links, max_results }): Promise<TextResult> => {
      try {
        const name = contact_list_name.trim();
        if (!name) return fail(new Error("contact_list_name must not be blank."));
        const gen = await generateMapsUrls({
          search: search.trim(),
          ...(locations && locations.length
            ? { locations: locations.map((l) => l.trim()).filter(Boolean) }
            : {}),
          max_links: clamp(Math.trunc(max_links ?? 5), 1, MAX_LINKS),
        });
        const urls = (gen.google_maps_search_urls ?? [])
          .filter((u): u is string => typeof u === "string" && u.length > 0)
          .slice(0, MAX_URLS_PER_EXTRACT);
        if (!urls.length) {
          return fail(new Error("No search URLs were generated for that query."));
        }
        const res = await extractMaps({
          google_maps_search_urls: urls,
          max_results: clamp(Math.trunc(max_results ?? 100), 1, MAX_RESULTS),
          contact_list_name: name,
        });
        return ok({
          contact_list_id: res.contact_list_id,
          urls_generated: urls.length,
          urls,
          status: "extraction_started",
          note: "Extraction is asynchronous. Poll get_contact_list_status with this contact_list_id.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_contact_lists",
    {
      title: "List / search contact lists",
      description:
        "List the account's contact lists, optionally filtered by name. Useful to pick a destination " +
        "list for extraction or to locate the list a previous extraction created.",
      inputSchema: {
        name: z.string().optional().describe("Optional name filter (contains match)."),
        limit: z.number().int().optional().describe("Max lists to return (1–200, default 25)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, limit }): Promise<TextResult> => {
      try {
        const { total, lists } = await searchContactLists(name, clamp(Math.trunc(limit ?? 25), 1, 200));
        return ok({
          total,
          returned: lists.length,
          lists: lists.map((l) => ({
            id: l.id,
            name: l.name,
            contacts: l.number_of_contacts ?? 0,
            emails: l.number_of_emails ?? 0,
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_contact_list_status",
    {
      title: "Get a contact list's status",
      description:
        "Fetch a contact list's current counts (contacts, emails, companies) and its extraction/enrichment " +
        "jobs (`state_details`). Poll this after an extraction to know when it has 'completed'.",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id to inspect."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id }): Promise<TextResult> => {
      try {
        const list = await getContactList(contact_list_id);
        const jobs = (list.state_details ?? []).map((j) => ({
          type: j.type,
          state: j.state,
          percent: j.percent,
        }));
        return ok({
          id: list.id,
          name: list.name,
          contacts: list.number_of_contacts ?? 0,
          emails: list.number_of_emails ?? 0,
          companies: list.number_of_companies ?? 0,
          jobs,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ------------------------------------------------------------------------ */
  /* Contact manipulation: list fields · preview selection · delete selection  */
  /* ------------------------------------------------------------------------ */

  server.registerTool(
    "list_contact_fields",
    {
      title: "List a contact list's filterable fields",
      description:
        "List the fields you can filter on in a contact list — for each: `data_field_id`, " +
        "`identifier` (e.g. 'email', 'company', 'first_name'), `label`, and `type`. Use the " +
        "`identifier` values to name fields in `preview_contact_selection` / " +
        "`delete_contacts_by_selection` criteria. Data fields are account-wide, so they apply " +
        "to every contact list.",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id to inspect."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id }): Promise<TextResult> => {
      try {
        // Validate the list exists (clear error on a bad id) and grab its name.
        const list = await getContactList(contact_list_id);
        const fields = await listDataFields();
        const view = fields
          .filter((f) => f && typeof f.id === "number" && typeof f.identifier === "string")
          .map(fieldView);
        return ok({
          contact_list_id,
          list_name: list?.name ?? String(contact_list_id),
          count: view.length,
          fields: view,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "preview_contact_selection",
    {
      title: "Preview a contact selection (read-only — deletes NOTHING)",
      description:
        "Count how a set of criteria would affect a contact list WITHOUT changing anything. " +
        "Returns `{ list_name, matched_count, total_count }` plus `to_delete` / `to_keep` for the " +
        "chosen `target`. ALWAYS call this before delete_contacts_by_selection: the `to_delete` it " +
        "returns is exactly the `confirm_count` the delete tool requires. `match:'all'` = every " +
        "criterion (AND), `match:'any'` = at least one (OR). `target:'matching'` selects the " +
        "contacts that match; `target:'all_except_matching'` selects everyone who does NOT match " +
        "(i.e. keep only the matches).",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id."),
        criteria: z
          .array(criterionSchema)
          .max(MAX_CRITERIA)
          .describe("Filter conditions. Empty array = matches the whole list."),
        match: z
          .enum(["all", "any"])
          .optional()
          .describe("Combine criteria with AND ('all', default) or OR ('any')."),
        target: z
          .enum(["matching", "all_except_matching"])
          .optional()
          .describe("Which contacts to select: 'matching' (default) or 'all_except_matching'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id, criteria, match, target }): Promise<TextResult> => {
      try {
        const sel = await resolveSelection(
          contact_list_id,
          criteria ?? [],
          match ?? "all",
          target ?? "matching",
        );
        return ok({
          list_name: sel.list_name,
          matched_count: sel.matched_count,
          total_count: sel.total_count,
          target: target ?? "matching",
          match: match ?? "all",
          to_delete: sel.to_delete,
          to_keep: sel.to_keep,
          note: "Nothing was deleted. Pass to_delete as confirm_count to delete_contacts_by_selection.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "delete_contacts_by_selection",
    {
      title: "Delete contacts by selection (DESTRUCTIVE)",
      description:
        "Permanently delete contacts from a list that match your criteria. DESTRUCTIVE and " +
        "guarded: it RE-COUNTS live and refuses unless `confirm_count` exactly equals the number " +
        "that will be deleted (get it from `preview_contact_selection`'s `to_delete`). Same " +
        "`criteria` / `match` / `target` semantics as preview — with `target:'all_except_matching'` " +
        "it deletes everyone who does NOT match. Empty criteria are refused (that would wipe the " +
        "whole list) unless you set `delete_entire_list:true`. Always preview first.",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id."),
        criteria: z
          .array(criterionSchema)
          .max(MAX_CRITERIA)
          .describe("Filter conditions. Empty array is refused unless delete_entire_list:true."),
        match: z
          .enum(["all", "any"])
          .optional()
          .describe("Combine criteria with AND ('all', default) or OR ('any')."),
        target: z
          .enum(["matching", "all_except_matching"])
          .optional()
          .describe("'matching' (default) deletes the matches; 'all_except_matching' deletes non-matches."),
        confirm_count: z
          .number()
          .int()
          .min(0)
          .describe("REQUIRED. Must equal the live to_delete count (from preview) or the delete is refused."),
        delete_entire_list: z
          .boolean()
          .optional()
          .describe("Explicit opt-in to allow empty criteria (delete every contact). Default false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({
      contact_list_id,
      criteria,
      match,
      target,
      confirm_count,
      delete_entire_list,
    }): Promise<TextResult> => {
      try {
        const crit = criteria ?? [];
        const tgt = target ?? "matching";

        // Guardrail 1: never let empty criteria silently wipe the list.
        if (crit.length === 0 && !delete_entire_list) {
          return fail(
            new Error(
              "Refusing: empty criteria would affect the whole list. " +
                "Set delete_entire_list:true to intentionally delete every contact.",
            ),
          );
        }

        // Re-count live — this is the authoritative number, not the preview's.
        const sel = await resolveSelection(contact_list_id, crit, match ?? "all", tgt);

        // Guardrail 2: confirm_count must match the live to_delete exactly.
        if (confirm_count !== sel.to_delete) {
          return fail(
            new Error(
              `Refusing: confirm_count (${confirm_count}) does not match the live count of ` +
                `contacts that would be deleted (${sel.to_delete}). Re-run ` +
                `preview_contact_selection and pass its to_delete as confirm_count.`,
            ),
          );
        }

        // Guardrail 3: nothing to do — don't call the destructive endpoint for 0.
        if (sel.to_delete === 0) {
          return ok({
            deleted: 0,
            list_name: sel.list_name,
            target: tgt,
            note: "No contacts matched the selection; nothing was deleted.",
          });
        }

        // target 'matching' → delete the matches; 'all_except_matching' → keep only
        // the matches (reverse_selection flips it), deleting everyone else.
        await deleteContactsSelection(contact_list_id, {
          filter: sel.filter,
          contact_ids: [],
          excluded_contact_ids: [],
          reverse_selection: tgt === "all_except_matching",
        });

        return ok({
          deleted: sel.to_delete,
          list_name: sel.list_name,
          target: tgt,
          remaining: sel.to_keep,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
