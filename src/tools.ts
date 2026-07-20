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
  listProgrammations,
  getProgrammationById,
  getWorkflow,
  getProgrammationStatistics,
  getStepModel,
  getMe,
  listLinkedinAccounts,
  searchContactListsPaginated,
  queryContacts,
  searchContacts,
  listPrmStatuses,
  queryPrmContacts,
  getPrmContact,
  listPrmNurturings,
  EMPTY_FILTER,
  MagileadsError,
  type DataField,
  type FilterNode,
  type FilterValue,
  type Raw,
  type ContactsPage,
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

/* -------------------------------------------------------------------------- */
/* Campaign-audit helpers (shared by the campaign/scenario/stats tools)        */
/* -------------------------------------------------------------------------- */

/** A finite number, or null. Keeps "not applicable" (null) distinct from 0. */
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A percentage (one decimal) of part/whole, or null when it can't be computed. */
function rate(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Derive a campaign status from the raw stopped/archived flags. */
function deriveStatus(item: Raw): string {
  if (item.archived === true) return "archived";
  if (item.stopped === true) return "stopped";
  return "running";
}

/** has_*_step flags on a programmation → the channels/actions it uses. */
const STEP_FLAGS: [string, string][] = [
  ["has_email_step", "email"],
  ["has_linkedin_invitation_step", "linkedin_invitation"],
  ["has_linkedin_message_step", "linkedin_message"],
  ["has_linkedin_visit_step", "linkedin_visit"],
  ["has_sms_step", "sms"],
  ["has_smv_step", "smv"],
  ["has_call_step", "call"],
];
function channelsFromFlags(item: Raw): string[] {
  return STEP_FLAGS.filter(([k]) => item[k] === true).map(([, v]) => v);
}

/** Coarse channel bucket for an action_type (email vs linkedin vs …). */
function channelOfAction(actionType: string | null): string {
  if (!actionType) return "other";
  if (actionType.startsWith("linkedin")) return "linkedin";
  if (["email", "sms", "smv", "call"].includes(actionType)) return actionType;
  return "other";
}

/** The numeric step id, whether nested ({type,id}) or flat. */
function stepIdOf(step: Raw): number | null {
  const sid = step.step_id;
  if (sid && typeof sid === "object") {
    const inner = (sid as Raw).id;
    if (typeof inner === "number") return inner;
  }
  return num(step.id);
}

/** Best-effort friendly step type; raw step_type/action_type/event_type stay authoritative. */
function normalizedStepType(step: Raw): string {
  const st = typeof step.step_type === "string" ? step.step_type : null;
  const at = typeof step.action_type === "string" ? step.action_type : null;
  const et = typeof step.event_type === "string" ? step.event_type : null;
  if (st === "event") {
    if (et === "not_active" || et === "all_contacts" || !et) return "delay";
    return "condition";
  }
  if (at === "linkedin_invitation") return "linkedin_invite";
  return at ?? st ?? "unknown";
}

/** Pull normalized subject/body out of a message model (full content, no truncation). */
function normalizeMessage(model: Raw | null): { subject: string | null; body: string | null } {
  if (!model) return { subject: null, body: null };
  const pick = (k: string): string | null =>
    typeof model[k] === "string" && (model[k] as string).length > 0 ? (model[k] as string) : null;
  const subject = pick("subject");
  const body = pick("html") ?? pick("text") ?? pick("content") ?? pick("message") ?? null;
  return { subject, body };
}

/* -------------------------------------------------------------------------- */
/* Data-query helpers (account / lists / contacts)                             */
/* -------------------------------------------------------------------------- */

/** Thousands-separated integer (12345 → "12,345"); passes non-numbers through. */
const fmt = (n: unknown): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : String(n ?? "");

/** Build id↔identifier maps from the account's (global) data fields. */
async function dataFieldMaps(): Promise<{
  idToIdentifier: Map<number, string>;
  identifierToId: Map<string, number>;
}> {
  const fields = await listDataFields();
  const idToIdentifier = new Map<number, string>();
  const identifierToId = new Map<string, number>();
  for (const f of fields) {
    if (typeof f.id === "number" && typeof f.identifier === "string") {
      idToIdentifier.set(f.id, f.identifier);
      identifierToId.set(f.identifier.trim().toLowerCase(), f.id);
    }
  }
  return { idToIdentifier, identifierToId };
}

/** Resolve a human field name (or numeric id / special token) to the API field_name string. */
function resolveFieldName(name: string, identifierToId: Map<string, number>): string {
  const raw = String(name).trim();
  const lc = raw.toLowerCase();
  if (identifierToId.has(lc)) return String(identifierToId.get(lc));
  if (SPECIAL_FIELDS.has(lc)) return lc;
  if (/^\d+$/.test(raw)) return raw; // already a data_field_id
  throw new Error(
    `Unknown field "${name}". Call list_contact_fields for valid identifiers, or pass a numeric data_field_id.`,
  );
}

/** Recursively resolve field names inside a Magileads Filter object, via `resolve`. */
function resolveFilter(filter: Raw, resolve: (name: string) => string): FilterNode {
  const mode = filter.mode === "or" ? "or" : "and";
  const rawValues = Array.isArray(filter.values) ? (filter.values as Raw[]) : [];
  const values = rawValues.map((v) => {
    if (v && typeof v === "object" && Array.isArray((v as Raw).values)) {
      return resolveFilter(v as Raw, resolve); // nested filter node
    }
    const o = v as Raw;
    const fieldRaw = (o.field_name ?? o.field) as string | undefined;
    if (fieldRaw == null) throw new Error("Each filter value needs a `field_name` (or `field`).");
    const leaf: FilterValue = { field_name: resolve(String(fieldRaw)), type: String(o.type ?? "contains") };
    if (o.value !== undefined) leaf.value = o.value as string | string[];
    return leaf;
  });
  return { mode, values };
}

/** Resolve a contact's `[{data_field_id,value}]` properties to a `{ identifier: value }` object. */
function resolveProps(contact: Raw, idToIdentifier: Map<number, string>): Raw {
  const props = Array.isArray(contact.properties) ? (contact.properties as Raw[]) : [];
  const out: Raw = {};
  for (const p of props) {
    const fid = typeof p.data_field_id === "number" ? p.data_field_id : null;
    if (fid == null) continue;
    out[idToIdentifier.get(fid) ?? `field_${fid}`] = p.value;
  }
  return out;
}

/** Like resolveProps but with the contact `id` folded in (flat row shape). */
function resolveContact(contact: Raw, idToIdentifier: Map<number, string>): Raw {
  return { id: contact.id, ...resolveProps(contact, idToIdentifier) };
}

/**
 * PRM filter/sort fields the API allows beyond data-field identifiers (verified live).
 * These take priority over data-field identifiers so e.g. `status`/`score` aren't
 * mistaken for a similarly-named data field.
 */
const PRM_FIELDS = new Set([
  "id", "status", "custom_status", "is_positive", "created_on", "score", "status_changed_date",
  "any_datafield", "last_link_click", "last_email_open", "last_email_answered",
  "last_linkedin_invitation_accepted", "last_linkedin_message_answered", "last_call",
  "last_sms_got", "last_sms_not_got", "last_reply", "last_reply_or_status_changed_date",
  "programmation_id", "workflow_id", "contact_list_id", "status_from_programmation",
  "integration_id", "call_created_by", "person_in_charge", "company_has_person_in_charge",
  "phone_has_person_in_charge", "in_active_programmation", "contacted_linkedin", "contacted_email",
  "link_click", "tag_id", "last_note_date", "notes", "status_change_count", "new_reply",
  "new_first_reply", "opener_step", "clicker_step", "answerer_step", "email_open_count", "click_count",
]);

/** Resolve a PRM field name: PRM special field → as-is; else data-field identifier → id;
 *  else numeric id → as-is; else pass through (the API validates unknown fields). */
function resolvePrmFieldName(name: string, identifierToId: Map<string, number>): string {
  const raw = String(name).trim();
  const lc = raw.toLowerCase();
  if (PRM_FIELDS.has(lc)) return lc;
  if (identifierToId.has(lc)) return String(identifierToId.get(lc));
  if (/^\d+$/.test(raw)) return raw;
  return lc; // permissive: many PRM fields exist; let the API reject truly invalid ones
}

/** Build lookup maps from the PRM status referential (custom id↔name, default keys). */
async function prmStatusMaps(): Promise<{
  customById: Map<number, { name: string | null; color: unknown }>;
  customByName: Map<string, number>;
  defaultKeys: Set<string>;
}> {
  const { default: defs, custom } = await listPrmStatuses();
  const customById = new Map<number, { name: string | null; color: unknown }>();
  const customByName = new Map<string, number>();
  for (const c of custom) {
    const id = typeof c.id === "number" ? c.id : null;
    if (id == null) continue;
    customById.set(id, { name: (typeof c.name === "string" && c.name) || null, color: c.color ?? null });
    if (typeof c.name === "string") customByName.set(c.name.trim().toLowerCase(), id);
  }
  const defaultKeys = new Set(defs.map((s) => String(s.status ?? "").toLowerCase()).filter(Boolean));
  return { customById, customByName, defaultKeys };
}

/** Resolve a contact's custom_status id to `{id,name,color}` (or null). */
function customStatusView(
  customStatus: unknown,
  customById: Map<number, { name: string | null; color: unknown }>,
): Raw | null {
  const id = num(customStatus);
  if (id == null) return null;
  const found = customById.get(id);
  return { id, name: found?.name ?? null, color: found?.color ?? null };
}

/** Compact per-page view of a contacts result (max 50 rows), shared by query/search. */
function contactsView(
  res: ContactsPage,
  page: number,
  perPage: number,
  idToIdentifier: Map<number, string>,
): Raw {
  const contacts = (res.results ?? []).slice(0, 50).map((c) => resolveContact(c, idToIdentifier));
  return {
    total: num(res.number_of_results),
    total_formatted: fmt(res.number_of_results),
    pages: num(res.number_of_pages),
    page,
    per_page: perPage,
    counts: {
      contacts: num(res.number_of_contacts),
      emails: num(res.number_of_emails),
      linkedin_url: num(res.number_of_linkedin_url),
    },
    returned: contacts.length,
    contacts,
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

  /* ------------------------------------------------------------------------ */
  /* Campaign audit (READ-ONLY): campaigns · scenarios · statistics            */
  /* All four operate on the MCP server's own Magileads account. The campaign  */
  /* / scenario must belong to that account (else the API returns unauthorized).*/
  /* ------------------------------------------------------------------------ */

  server.registerTool(
    "list_campaigns",
    {
      title: "List prospecting campaigns",
      description:
        "List the account's prospecting campaigns (Magileads 'programmations'). Each entry: " +
        "`id`, `name` (the scenario/workflow name), `status` (running/stopped/archived, derived " +
        "from the raw stopped/archived flags), `start_date`, and `scenario_id` (the workflow to " +
        "pass to get_scenario). Use `name` to filter (case-insensitive substring on the campaign " +
        "name — done client-side, since the API can't filter campaigns by name).",
      inputSchema: {
        name: z.string().optional().describe("Optional case-insensitive substring filter on the campaign name."),
        limit: z.number().int().optional().describe("Max campaigns to scan/return (1–100, default 50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, limit }): Promise<TextResult> => {
      try {
        const perPage = clamp(Math.trunc(limit ?? 50), 1, 100);
        const { total, results } = await listProgrammations(perPage);
        const q = name?.trim().toLowerCase();
        const rows = results
          .map((p) => ({
            id: num(p.id),
            name: (typeof p.workflow_name === "string" && p.workflow_name) || null,
            status: deriveStatus(p),
            start_date: p.date_start ?? null,
            scenario_id: num(p.workflow_id),
          }))
          .filter((r) => !q || (r.name ?? "").toLowerCase().includes(q));
        return ok({
          total_on_account: total,
          scanned: results.length,
          returned: rows.length,
          ...(q ? { name_filter: name } : {}),
          campaigns: rows,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get a campaign's setup",
      description:
        "Fetch one campaign's (programmation's) configuration for audit: `id`, `name`, `status`, " +
        "`start_date`, `channels` (the action types it uses), `scenario_id` (pass to get_scenario), " +
        "`target_lists` (each with live contact `count`), and `total_contacts` (sum of those " +
        "counts). Returns raw stopped/archived/date_stop too. Errors clearly if the campaign isn't " +
        "found or isn't owned by this account.",
      inputSchema: {
        campaign_id: z.number().int().positive().describe("The campaign (programmation) id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ campaign_id }): Promise<TextResult> => {
      try {
        const prog = await getProgrammationById(campaign_id);
        if (!prog) {
          return fail(
            new Error(
              `Campaign ${campaign_id} was not found on this Magileads account ` +
                `(it may belong to a different account, or not exist).`,
            ),
          );
        }
        const lists = Array.isArray(prog.contact_lists) ? (prog.contact_lists as Raw[]) : [];
        const target_lists = await Promise.all(
          lists.map(async (l) => {
            const id = num(l.id);
            let count: number | null = null;
            if (id != null) {
              try {
                const cl = await getContactList(id);
                count = num(cl.number_of_contacts);
              } catch {
                count = null; // list may be inaccessible; don't sink the whole read
              }
            }
            return { id, name: (typeof l.name === "string" && l.name) || null, count };
          }),
        );
        const total_contacts = target_lists.reduce((a, l) => a + (l.count ?? 0), 0);
        return ok({
          id: num(prog.id),
          name: (typeof prog.workflow_name === "string" && prog.workflow_name) || null,
          status: deriveStatus(prog),
          start_date: prog.date_start ?? null,
          date_stop: prog.date_stop ?? null,
          stopped: prog.stopped ?? null,
          archived: prog.archived ?? null,
          channels: channelsFromFlags(prog),
          scenario_id: num(prog.workflow_id),
          target_lists,
          total_contacts,
          daily_send_limit: num(prog.daily_send_limit),
          tags: prog.tags ?? [],
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_scenario",
    {
      title: "Get a scenario's full steps and message content",
      description:
        "Fetch a scenario (workflow) and its ordered steps for audit. For EACH step returns: " +
        "`order`, `step_id`, `step_type` (action/event), `action_type` (email, linkedin_visit, " +
        "linkedin_invitation, linkedin_message, sms, …), a normalized `type`, `channel`, " +
        "`delay_minutes`, `parent_ids`, and — for message steps — the COMPLETE `subject` and " +
        "`body` (fetched from the underlying template; never truncated), plus the full raw " +
        "`message` model and raw `step`. Nothing is summarized or truncated. The `step_id` matches " +
        "the per-step `step_id` in get_campaign_statistics, so messages can be correlated to stats.",
      inputSchema: {
        scenario_id: z.number().int().positive().describe("The scenario (workflow) id — from a campaign's scenario_id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scenario_id }): Promise<TextResult> => {
      try {
        const wf = await getWorkflow(scenario_id);
        const steps = Array.isArray(wf.steps) ? (wf.steps as Raw[]) : [];
        const mapped = await Promise.all(
          steps.map(async (s, i) => {
            const actionType = typeof s.action_type === "string" ? s.action_type : null;
            const modelId = num(s.model_id);
            const model = actionType && modelId != null ? await getStepModel(actionType, modelId) : null;
            const { subject, body } = normalizeMessage(model);
            return {
              order: i + 1,
              step_id: stepIdOf(s),
              step_type: s.step_type ?? null,
              action_type: actionType,
              event_type: s.event_type ?? null,
              type: normalizedStepType(s),
              channel: channelOfAction(actionType),
              delay_minutes: num(s.when_minutes),
              name: (typeof s.model_name === "string" && s.model_name) || (typeof s.name === "string" && s.name) || null,
              model_id: modelId,
              parent_ids: s.parent_ids ?? [],
              is_initial: s.is_initial ?? null,
              subject,
              body,
              message: model, // full raw template (complete, untruncated)
              step: s, // full raw step (complete, untruncated)
            };
          }),
        );
        return ok({
          id: num(wf.id),
          name: (typeof wf.name === "string" && wf.name) || null,
          archived: wf.archived ?? null,
          programmed: wf.programmed ?? null,
          step_count: mapped.length,
          steps: mapped,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_campaign_statistics",
    {
      title: "Get a campaign's statistics (aggregate + per-step)",
      description:
        "Fetch a campaign's (programmation's) statistics for audit — RAW and COMPLETE, no " +
        "summarizing. Returns `aggregate` (whole-campaign counts) and `per_step` (the crucial " +
        "detail: one entry per scenario step, with sent/opens/clicks/replies/bounces, computed " +
        "open_rate/click_rate/reply_rate, timing, links, and the full raw step). `per_step[].step_id` " +
        "matches get_scenario's `step_id`, so each message can be correlated to its stats. Also " +
        "returns derived `by_action_type` sums and convenience `email`/`linkedin` blocks. " +
        "IMPORTANT — metric semantics: the API exposes UNIQUE-contact counts (contacts who opened/" +
        "clicked/replied), `contacted` = sent; it does NOT expose 'delivered', total (non-unique) " +
        "opens, or LinkedIn invite-accepted counts, so those fields are null (facts vs. gaps). " +
        "LinkedIn acceptance, if tracked, appears as a following step's event in per_step timing.",
      inputSchema: {
        campaign_id: z.number().int().positive().describe("The campaign (programmation) id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ campaign_id }): Promise<TextResult> => {
      try {
        const p = await getProgrammationStatistics(campaign_id);
        const steps = Array.isArray(p.steps) ? (p.steps as Raw[]) : [];

        const per_step = steps.map((s) => {
          const sent = num(s.contacted);
          const opens = num(s.contacts_opened);
          const clicks = num(s.contacts_clicked);
          const replies = num(s.contacts_answered);
          const bounces = num(s.bounced);
          const at = typeof s.action_type === "string" ? s.action_type : null;
          return {
            step_id: num(s.id),
            action_type: at,
            channel: channelOfAction(at),
            is_initial: s.is_initial ?? null,
            is_stopped: s.is_stopped ?? null,
            sent,
            to_contact: num(s.to_contact),
            in_queue: num(s.in_queue),
            opens,
            clicks,
            replies,
            bounces,
            unsubscribers: num(s.unsubscribers),
            blacklisted: num(s.blacklisted),
            open_rate: rate(opens, sent),
            click_rate: rate(clicks, sent),
            reply_rate: rate(replies, sent),
            timing: Array.isArray(s.parent_steps) ? s.parent_steps : [],
            links: Array.isArray(s.links) ? s.links : [],
            last_contacted: s.last_contacted ?? null,
            sent_today: num(s.sent_today),
            limit_send_per_day: num(s.limit_send_per_day),
            waiting: num(s.waiting),
            step: s, // full raw step — nothing dropped
          };
        });

        // Derived sums grouped by action_type (faithful channel/subtype breakdown).
        const by_action_type: Record<
          string,
          { steps: number; sent: number; opens: number; clicks: number; replies: number; bounces: number; unsubscribers: number }
        > = {};
        for (const s of per_step) {
          const key = s.action_type ?? "unknown";
          const b = (by_action_type[key] ??= {
            steps: 0,
            sent: 0,
            opens: 0,
            clicks: 0,
            replies: 0,
            bounces: 0,
            unsubscribers: 0,
          });
          b.steps += 1;
          b.sent += s.sent ?? 0;
          b.opens += s.opens ?? 0;
          b.clicks += s.clicks ?? 0;
          b.replies += s.replies ?? 0;
          b.bounces += s.bounces ?? 0;
          b.unsubscribers += s.unsubscribers ?? 0;
        }
        const at = (k: string) => by_action_type[k];

        // Convenience channel blocks (derived). Fields the API doesn't provide are null.
        const email = {
          sent: at("email")?.sent ?? 0,
          delivered: null as number | null, // not exposed by the API
          opens: null as number | null, // total (non-unique) opens not exposed
          unique_opens: at("email")?.opens ?? 0,
          clicks: at("email")?.clicks ?? 0,
          replies: at("email")?.replies ?? 0,
          bounces: at("email")?.bounces ?? 0,
          unsubscribes: at("email")?.unsubscribers ?? 0,
        };
        const linkedin = {
          profile_visits: at("linkedin_visit")?.sent ?? 0,
          invites_sent: at("linkedin_invitation")?.sent ?? 0,
          invites_accepted: null as number | null, // not exposed as a count — see per_step timing
          messages_sent: at("linkedin_message")?.sent ?? 0,
          replies: at("linkedin_message")?.replies ?? 0,
        };

        const aggregate = {
          contacted: num(p.contacted),
          to_contact: num(p.to_contact),
          contacts_opened: num(p.contacts_opened),
          contacts_clicked: num(p.contacts_clicked),
          contacts_answered: num(p.contacts_answered),
          bounced: num(p.bounced),
          unsubscribers: num(p.unsubscribers),
          blacklisted: num(p.blacklisted),
          excluded_previous_programmation: num(p.excluded_previous_programmation),
          excluded_workflow: num(p.excluded_workflow),
          excluded_programmation: num(p.excluded_programmation),
        };

        // Everything else from the raw campaign stats (minus the steps we mapped above).
        const { steps: _omit, ...raw_campaign } = p;

        return ok({
          campaign_id,
          workflow_id: num(p.workflow_id),
          workflow_name: p.workflow_name ?? null,
          status: deriveStatus(p),
          stopped: p.stopped ?? null,
          archived: p.archived ?? null,
          date_start: p.date_start ?? null,
          contact_lists: p.contact_lists ?? [],
          aggregate,
          email,
          linkedin,
          by_action_type,
          per_step,
          ab_tests: p.ab_tests ?? [],
          blacklists_stats: p.blacklists_stats ?? [],
          tags: p.tags ?? [],
          raw_campaign, // complete passthrough of all non-step campaign fields
          _notes:
            "sent=contacted; opens/clicks/replies are UNIQUE-contact counts; rates are percentages. " +
            "email.delivered, email.opens (total), and linkedin.invites_accepted are null (not exposed by the API). " +
            "Correlate per_step.step_id with get_scenario steps to tie each message to its stats.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ------------------------------------------------------------------------ */
  /* Read-only data browsing: account · linkedin · lists · contacts            */
  /* Compact, capped responses (agents have limited context). No writes.       */
  /* ------------------------------------------------------------------------ */

  server.registerTool(
    "get_account_overview",
    {
      title: "Get the Magileads account overview",
      description:
        "Summarize the connected Magileads/Groleads account: identity (name, email, id), company/" +
        "role, and plan/subscription status (active, trial, end_date, billing). Note: the API " +
        "exposes subscription STATUS but no numeric credit balance, so credit counts are not " +
        "reported. Takes no parameters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<TextResult> => {
      try {
        const me = await getMe();
        const subs = (me.subscriptions ?? {}) as Raw;
        const teams = Array.isArray(me.teams) ? (me.teams as Raw[]) : [];
        const orgs = Array.isArray(me.organizations) ? (me.organizations as Raw[]) : [];
        const name = [me.first_name, me.last_name].filter(Boolean).join(" ").trim() || null;
        return ok({
          id: num(me.id),
          first_name: me.first_name ?? null,
          last_name: me.last_name ?? null,
          email: me.email ?? null,
          company: me.company ?? null,
          job_title: me.job_title ?? null,
          phone: me.phone ?? me.mobile_phone ?? null,
          country: me.country ?? null,
          language: me.language ?? null,
          timezone: me.timezone ?? null,
          level: me.level ?? null,
          activated: me.activated ?? null,
          created_on: me.created_on ?? null,
          last_activity: me.last_activity ?? null,
          subscription: {
            active: subs.active ?? null,
            trial: subs.trial ?? null,
            end_date: subs.end_date ?? null,
            recurring_interval: subs.recurring_interval ?? null,
            monthly_amount: subs.monthly_amount ?? null,
            is_canceled: subs.is_canceled ?? null,
            payment_method_valid: subs.payment_method_valid ?? null,
          },
          teams: { count: teams.length, names: teams.map((t) => t.name).filter(Boolean) },
          organizations: { count: orgs.length, names: orgs.map((o) => o.name).filter(Boolean) },
          permissions_count: Array.isArray(me.permissions) ? me.permissions.length : null,
          summary:
            `${name ?? me.email ?? "account"} — plan ${subs.active ? "active" : "inactive"}` +
            `${subs.end_date ? ` until ${String(subs.end_date).slice(0, 10)}` : ""}, ` +
            `${teams.length} team(s), ${orgs.length} org(s)`,
          _note: "No numeric credit balance is exposed by the API; subscription status is what's available.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_linkedin_accounts",
    {
      title: "List connected LinkedIn accounts",
      description:
        "List the account's connected LinkedIn integration accounts and their health, so an agent " +
        "can tell whether LinkedIn steps will run. Per account: id, name, username, is_valid, " +
        "validity_tested, checkpoint_required, is_sales_navigator_account, last_use. Takes no " +
        "parameters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<TextResult> => {
      try {
        const accounts = await listLinkedinAccounts();
        const view = accounts.map((a) => ({
          id: num(a.id),
          name: a.name ?? null,
          username: a.username ?? null,
          is_valid: a.is_valid ?? null,
          validity_tested: a.validity_tested ?? null,
          checkpoint_required: a.checkpoint_required ?? null,
          is_sales_navigator_account: a.is_sales_navigator_account ?? null,
          last_use: a.last_use ?? null,
        }));
        const valid = view.filter((a) => a.is_valid === true).length;
        const checkpoint = view.filter((a) => a.checkpoint_required === true).length;
        return ok({
          count: view.length,
          valid,
          checkpoint,
          accounts: view,
          summary: `${view.length} LinkedIn account(s): ${valid} valid, ${checkpoint} in checkpoint`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_contact_lists",
    {
      title: "Search / browse contact lists (paged)",
      description:
        "Browse the account's contact lists with paging and sorting. Filter by `name` (substring); " +
        "sort by `name` or `id` (default `id`, newest first). Returns each list's id, name, and " +
        "counters (contacts/emails/linkedin/companies), plus list_type/created_on, and the total " +
        "count and number of pages. The API only supports name/id for sort & filter.",
      inputSchema: {
        name: z.string().optional().describe("Optional case-insensitive substring filter on the list name."),
        sort: z.enum(["name", "id"]).optional().describe("Sort field: 'id' (default, newest first) or 'name' (A→Z)."),
        per_page: z.number().int().optional().describe("Results per page (1–100, default 25)."),
        page: z.number().int().optional().describe("1-based page number (default 1)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, sort, per_page, page }): Promise<TextResult> => {
      try {
        const perPage = clamp(Math.trunc(per_page ?? 25), 1, 100);
        const pg = Math.max(Math.trunc(page ?? 1), 1);
        const sortField = sort === "name" ? "name" : "id";
        const sortDirection: "asc" | "desc" = sortField === "name" ? "asc" : "desc";
        const res = await searchContactListsPaginated({ name, sortField, sortDirection, perPage, page: pg });
        const lists = (res.results ?? []).map((l) => ({
          id: num(l.id),
          name: l.name ?? null,
          number_of_contacts: num(l.number_of_contacts),
          number_of_emails: num(l.number_of_emails),
          number_of_linkedin_url: num(l.number_of_linkedin_url),
          number_of_companies: num(l.number_of_companies),
          list_type: l.list_type ?? null,
          created_on: l.created_on ?? null,
        }));
        return ok({
          total: num(res.number_of_results),
          total_formatted: fmt(res.number_of_results),
          pages: num(res.number_of_pages),
          page: pg,
          per_page: perPage,
          ...(name?.trim() ? { name_filter: name.trim() } : {}),
          returned: lists.length,
          lists,
          summary: `${fmt(res.number_of_results)} list(s) — page ${pg}/${res.number_of_pages ?? 1}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_contact_list",
    {
      title: "Get a contact list's profile",
      description:
        "Fetch one contact list's profile: counts (contacts/emails/linkedin/companies), list_type, " +
        "language, country, created_on, pin, and the state of any running jobs (`jobs` + " +
        "`in_progress`) so an agent can tell whether an import/extraction is still underway.",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id }): Promise<TextResult> => {
      try {
        const p = await getContactList(contact_list_id);
        const details = Array.isArray(p.state_details) ? p.state_details : [];
        const jobs = details.map((j) => ({ type: j.type, state: j.state, percent: j.percent }));
        // A job is "running" unless its state is terminal. States are Capitalized
        // (e.g. "Completed", "Error") so compare case-insensitively.
        const TERMINAL = new Set(["completed", "error", "failed", "canceled", "cancelled", "done"]);
        const in_progress = details.some((j) => {
          const s = String(j.state ?? "").toLowerCase();
          return s !== "" && !TERMINAL.has(s);
        });
        return ok({
          id: num(p.id),
          name: p.name ?? null,
          list_type: p.list_type ?? null,
          language: p.language ?? null,
          country: p.country ?? null,
          created_on: p.created_on ?? null,
          pin: p.pin ?? null,
          counts: {
            contacts: num(p.number_of_contacts),
            emails: num(p.number_of_emails),
            linkedin_url: num(p.number_of_linkedin_url),
            companies: num(p.number_of_companies),
          },
          jobs,
          in_progress,
          summary:
            `${p.name ?? contact_list_id} — ${fmt(p.number_of_contacts ?? 0)} contacts ` +
            `(${fmt(p.number_of_emails ?? 0)} emails)${in_progress ? ", job in progress" : ""}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "query_contacts",
    {
      title: "Query contacts in a list (filter + sort, paged)",
      description:
        "List a contact list's contacts with an optional Magileads `filter` and `sort`. Field names " +
        "may be human identifiers (email, company, first_name, …) — they're resolved to data-field " +
        "ids automatically. Contacts are returned with RESOLVED, readable property names, capped at " +
        "50 rows per call. `filter` = { mode:'and'|'or', values:[{ field/field_name, type, value }] } " +
        "(type: contains, equals, start_with, does_exist, …). Also returns the total match count and " +
        "page count. Never returns more than 50 contacts — page through for more.",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id."),
        filter: z
          .object({
            mode: z.enum(["and", "or"]).optional(),
            values: z.array(z.any()),
          })
          .optional()
          .describe("Magileads Filter object. Leaf: { field (identifier or id), type, value }; nesting allowed."),
        sort: z
          .object({
            field: z.string().describe("Field identifier or data_field_id to sort on."),
            direction: z.enum(["asc", "desc"]).optional(),
          })
          .optional()
          .describe("Sort by a field, asc/desc (default desc)."),
        per_page: z.number().int().optional().describe("Rows per page (1–50, default 50)."),
        page: z.number().int().optional().describe("1-based page number (default 1)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id, filter, sort, per_page, page }): Promise<TextResult> => {
      try {
        const perPage = clamp(Math.trunc(per_page ?? 50), 1, 50);
        const pg = Math.max(Math.trunc(page ?? 1), 1);
        const { idToIdentifier, identifierToId } = await dataFieldMaps();
        const options: Record<string, unknown> = { per_page: perPage };
        if (filter) options.filter = resolveFilter(filter as Raw, (n) => resolveFieldName(n, identifierToId));
        if (sort?.field) {
          options.sort = {
            field_name: resolveFieldName(sort.field, identifierToId),
            sort_direction: sort.direction === "asc" ? "asc" : "desc",
          };
        }
        const res = await queryContacts(contact_list_id, JSON.stringify(options), pg);
        const view = contactsView(res, pg, perPage, idToIdentifier);
        return ok({
          list_id: contact_list_id,
          ...view,
          summary: `${fmt(res.number_of_results)} contact(s) match — page ${pg}/${res.number_of_pages ?? 1}, showing ${view.returned}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Free-text search contacts in a list (paged)",
      description:
        "Search a contact list's contacts by a free-text `query` (matched across fields by the API). " +
        "Returns contacts with RESOLVED, readable property names, capped at 50 rows per call, plus " +
        "the total match count and page count. The query must be at least a couple of characters " +
        "(the API rejects very short queries).",
      inputSchema: {
        contact_list_id: z.number().int().positive().describe("The contact list id."),
        query: z.string().min(1).describe("Free-text search string (a few characters minimum)."),
        per_page: z.number().int().optional().describe("Rows per page (1–50, default 50)."),
        page: z.number().int().optional().describe("1-based page number (default 1)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_list_id, query, per_page, page }): Promise<TextResult> => {
      try {
        const q = query.trim();
        if (!q) return fail(new Error("query must not be blank."));
        const perPage = clamp(Math.trunc(per_page ?? 50), 1, 50);
        const pg = Math.max(Math.trunc(page ?? 1), 1);
        const { idToIdentifier } = await dataFieldMaps();
        const res = await searchContacts(contact_list_id, q, JSON.stringify({ per_page: perPage }), pg);
        const view = contactsView(res, pg, perPage, idToIdentifier);
        return ok({
          list_id: contact_list_id,
          query: q,
          ...view,
          summary: `"${q}": ${fmt(res.number_of_results)} match(es) — page ${pg}/${res.number_of_pages ?? 1}, showing ${view.returned}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ------------------------------------------------------------------------ */
  /* PRM (CRM / prospection pipeline) — READ-ONLY                              */
  /* No status changes, notes, calls, exclusions, sends, imports or deletes.   */
  /* ------------------------------------------------------------------------ */

  server.registerTool(
    "list_prm_statuses",
    {
      title: "List PRM pipeline statuses",
      description:
        "List the PRM (CRM) pipeline statuses — the referential that maps a contact's " +
        "`custom_status` id to a name. Merges the built-in statuses (kind:'default', keyed by a " +
        "string like 'opener'/'answerer') and the account's custom statuses (kind:'custom', with a " +
        "numeric id + name). Each: id (null for default), key, name, color, visible, sorting, kind. " +
        "Takes no parameters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<TextResult> => {
      try {
        const { default: defs, custom } = await listPrmStatuses();
        const statuses = [
          ...defs.map((s) => ({
            kind: "default" as const,
            id: null,
            key: s.status ?? null,
            name: s.status ?? null,
            color: s.color ?? null,
            visible: s.visible ?? null,
            sorting: num(s.sorting),
          })),
          ...custom.map((s) => ({
            kind: "custom" as const,
            id: num(s.id),
            key: num(s.id),
            name: s.name ?? null,
            color: s.color ?? null,
            visible: s.visible ?? null,
            sorting: num(s.sorting),
          })),
        ];
        return ok({
          count: statuses.length,
          default_count: defs.length,
          custom_count: custom.length,
          statuses,
          summary: `${statuses.length} status(es): ${defs.length} default, ${custom.length} custom`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "query_prm_contacts",
    {
      title: "Query PRM (pipeline) contacts",
      description:
        "List the account's PRM (CRM) contacts with convenience filters or a raw Magileads " +
        "`options` object. `status` accepts a default-status key (opener/answerer/…), a custom-" +
        "status name, or a custom-status id. `only_positive:true` keeps contacts marked positive. " +
        "`search` matches across all data fields. Contacts are returned with RESOLVED, readable " +
        "property names plus status/custom_status (name+color), is_positive, score and new_reply — " +
        "capped at 50 rows per call, with the total match count and page count. Never returns >50.",
      inputSchema: {
        options: z
          .object({ filter: z.any().optional(), sort: z.any().optional() })
          .optional()
          .describe("Advanced: a raw Magileads PaginationOptions ({filter, sort}); AND-combined with the convenience filters."),
        status: z.string().optional().describe("Filter by status: default key, custom-status name, or custom-status id."),
        only_positive: z.boolean().optional().describe("Keep only contacts marked positive (is_positive=true)."),
        search: z.string().optional().describe("Free-text match across all data fields (any_datafield contains)."),
        per_page: z.number().int().optional().describe("Rows per page (1–50, default 50)."),
        page: z.number().int().optional().describe("1-based page number (default 1)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ options, status, only_positive, search, per_page, page }): Promise<TextResult> => {
      try {
        const perPage = clamp(Math.trunc(per_page ?? 50), 1, 50);
        const pg = Math.max(Math.trunc(page ?? 1), 1);
        const { idToIdentifier, identifierToId } = await dataFieldMaps();
        const { customById, customByName, defaultKeys } = await prmStatusMaps();

        // Convenience conditions.
        const conds: FilterValue[] = [];
        if (status != null && String(status).trim()) {
          const s = String(status).trim();
          const lc = s.toLowerCase();
          if (/^\d+$/.test(s)) conds.push({ field_name: "custom_status", type: "equals", value: s });
          else if (customByName.has(lc))
            conds.push({ field_name: "custom_status", type: "equals", value: String(customByName.get(lc)) });
          else if (defaultKeys.has(lc)) conds.push({ field_name: "status", type: "equals", value: lc });
          else conds.push({ field_name: "status", type: "equals", value: s });
        }
        if (only_positive === true) conds.push({ field_name: "is_positive", type: "equals", value: "true" });
        if (search != null && String(search).trim())
          conds.push({ field_name: "any_datafield", type: "contains", value: String(search).trim() });

        // Merge with a caller-supplied raw filter.
        const provided =
          options && (options as Raw).filter
            ? resolveFilter((options as Raw).filter as Raw, (n) => resolvePrmFieldName(n, identifierToId))
            : null;
        let filter: FilterNode | undefined;
        if (provided && conds.length) filter = { mode: "and", values: [provided, ...conds] };
        else if (provided) filter = provided;
        else if (conds.length) filter = { mode: "and", values: conds };

        const opt: Record<string, unknown> = { per_page: perPage };
        if (filter) opt.filter = filter;
        const rawSort = options && (options as Raw).sort ? ((options as Raw).sort as Raw) : null;
        if (rawSort && (rawSort.field_name ?? rawSort.field)) {
          opt.sort = {
            field_name: resolvePrmFieldName(String(rawSort.field_name ?? rawSort.field), identifierToId),
            sort_direction: rawSort.sort_direction === "asc" ? "asc" : "desc",
          };
        }

        const res = await queryPrmContacts(JSON.stringify(opt), pg);
        const contacts = (res.results ?? []).slice(0, 50).map((c) => ({
          ...resolveContact(c, idToIdentifier),
          status: c.status ?? null,
          custom_status: customStatusView(c.custom_status, customById),
          is_positive: c.is_positive ?? null,
          score: num(c.score),
          new_reply: c.new_reply ?? null,
          number_of_replies: num(c.number_of_replies),
        }));
        return ok({
          total: num(res.number_of_results),
          total_formatted: fmt(res.number_of_results),
          pages: num(res.number_of_pages),
          page: pg,
          per_page: perPage,
          returned: contacts.length,
          contacts,
          summary: `${fmt(res.number_of_results)} PRM contact(s) — page ${pg}/${res.number_of_pages ?? 1}, showing ${contacts.length}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_prm_contact",
    {
      title: "Get a PRM (pipeline) contact's full profile",
      description:
        "Fetch one PRM contact's complete pipeline record: resolved properties, current status + " +
        "custom_status (name+color), is_positive, score/amount/probability, an aggregated engagement " +
        "`scoring` (opens/link_clicks/answers/positive/negative/invitations_accepted, summed across " +
        "campaigns), `calls`, `programmations` (per-campaign flags unsubscribed/blacklisted/excluded " +
        "+ per-campaign scoring), and the reply/interaction `history` (raw, capped). This is READ-" +
        "ONLY: it does NOT mark replies as read. NOTE: notes are not part of the profile response " +
        "(they live behind dedicated note endpoints not exposed here); notes may still appear as " +
        "items inside `history`.",
      inputSchema: {
        contact_id: z.number().int().positive().describe("The PRM contact id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contact_id }): Promise<TextResult> => {
      try {
        const [p, { idToIdentifier }, { customById }] = await Promise.all([
          getPrmContact(contact_id),
          dataFieldMaps(),
          prmStatusMaps(),
        ]);
        const progsRaw = Array.isArray(p.programmations) ? (p.programmations as Raw[]) : [];
        const sum = (k: string) => progsRaw.reduce((a, pr) => a + (num(pr[k]) ?? 0), 0);
        const scoring = {
          open: sum("score_open_count"),
          link_click: sum("score_link_click_count"),
          answer: sum("score_answer_count"),
          positive_answer: sum("score_positive_answer_count"),
          negative_answer: sum("score_negative_answer_count"),
          invitation_accepted: sum("score_invitation_accepted_count"),
        };
        const programmations = progsRaw.map((pr) => ({
          programmation_id: num(pr.programmation_id),
          workflow_id: num(pr.workflow_id),
          workflow_name: pr.workflow_name ?? null,
          contact_list_id: num(pr.contact_list_id),
          contact_lists: pr.contact_lists ?? [],
          status: pr.status ?? null,
          date_start: pr.date_start ?? null,
          unsubscribed: pr.unsubscribed ?? null,
          blacklisted: pr.blacklisted ?? null,
          excluded_workflow: pr.excluded_workflow ?? null,
          excluded_programmation: pr.excluded_programmation ?? null,
          excluded_previous_programmation: pr.excluded_previous_programmation ?? null,
          score: num(pr.score),
          scoring: {
            open: num(pr.score_open_count),
            link_click: num(pr.score_link_click_count),
            answer: num(pr.score_answer_count),
            positive_answer: num(pr.score_positive_answer_count),
            negative_answer: num(pr.score_negative_answer_count),
            invitation_accepted: num(pr.score_invitation_accepted_count),
          },
        }));
        const calls = (Array.isArray(p.calls) ? (p.calls as Raw[]) : []).map((c) => ({
          id: num(c.id),
          name: c.name ?? null,
          call_date: c.call_date ?? null,
          type: c.type ?? null,
          created_on: c.created_on ?? null,
          created_by: c.created_by ?? null,
        }));
        const historyRaw = Array.isArray(p.history) ? (p.history as Raw[]) : [];
        return ok({
          id: num(p.id),
          created_on: p.created_on ?? null,
          status: p.status ?? null,
          custom_status: customStatusView(p.custom_status, customById),
          is_positive: p.is_positive ?? null,
          score: num(p.score),
          amount: num(p.amount),
          probability: num(p.probability),
          closing_date: p.closing_date ?? null,
          status_changed_date: p.status_changed_date ?? null,
          in_active_programmation: p.in_active_programmation ?? null,
          new_reply: p.new_reply ?? null,
          new_first_reply: p.new_first_reply ?? null,
          last_reply_date: p.last_reply_date ?? null,
          tags: p.tags ?? [],
          properties: resolveProps(p, idToIdentifier),
          scoring,
          programmations,
          calls,
          excluded_programmations: p.excluded_programmations ?? [],
          excluded_workflows: p.excluded_workflows ?? [],
          history_count: historyRaw.length,
          history: historyRaw.slice(0, 30),
          _notes:
            "Engagement `scoring` is aggregated from per-campaign counters (see programmations[].scoring). " +
            "Notes are NOT in this profile (dedicated note endpoints are not exposed); they may appear inside history. " +
            "Replies are NOT marked read by this tool. history is capped at 30 items.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_prm_nurturings",
    {
      title: "List PRM nurturing sequences",
      description:
        "List the account's PRM nurturing sequences: id, name, contact_list_ids, created_on, and the " +
        "`filter` that selects contacts into the sequence. Takes no parameters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (): Promise<TextResult> => {
      try {
        const nurt = await listPrmNurturings();
        const nurturings = nurt.map((n) => ({
          id: num(n.id),
          name: n.name ?? null,
          contact_list_ids: n.contact_list_ids ?? [],
          created_on: n.created_on ?? null,
          filter: n.filter ?? null,
        }));
        return ok({
          count: nurturings.length,
          nurturings,
          summary: `${nurturings.length} nurturing sequence(s)`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
