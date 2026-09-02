/**
 * Minimal, self-contained Magileads API client for the MCP server.
 *
 * Standalone Node module. Authentication is resolved per request, in this order:
 *
 *   1. A PER-REQUEST client API key (multi-tenant) — the HTTP transport puts each
 *      calling client's own Magileads key into an AsyncLocalStorage store, so every
 *      tool call runs against THAT client's account. Sent as `X-API-Key`, stateless.
 *   2. Otherwise the server's own ENV credentials (single-account fallback / stdio):
 *      - MAGILEADS_API_KEY               -> `X-API-Key`
 *      - MAGILEADS_EMAIL + MAGILEADS_PASSWORD -> POST /users/authentication (JWT, auto-refreshed)
 *
 * Base URL defaults to https://app.api-magileads.net (override with MAGILEADS_API_BASE).
 */

import { AsyncLocalStorage } from "node:async_hooks";

const API_BASE = (process.env.MAGILEADS_API_BASE || "https://app.api-magileads.net").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.MAGILEADS_API_KEY?.trim() || "";
const EMAIL = process.env.MAGILEADS_EMAIL?.trim() || "";
const PASSWORD = process.env.MAGILEADS_PASSWORD || "";

export type AuthMode = "apiKey" | "password" | "none";

/** The ENV auth mode — the fallback used when no per-request client key is present. */
export function authMode(): AuthMode {
  if (API_KEY) return "apiKey";
  if (EMAIL && PASSWORD) return "password";
  return "none";
}

/**
 * Per-request Magileads credential (multi-tenant). The HTTP transport puts the
 * calling client's own API key here for the duration of a request, so every tool
 * runs against THAT client's Magileads account — no shared/global credential.
 * When absent (stdio, or a request with no key), auth falls back to the env vars.
 */
export type RequestAuth = { apiKey?: string };
const authStore = new AsyncLocalStorage<RequestAuth>();

/** Run `fn` with `auth` as the active per-request credential. */
export function runWithAuth<T>(auth: RequestAuth, fn: () => T): T {
  return authStore.run(auth, fn);
}

/** The per-request client API key for the current async context, if any. */
function currentApiKey(): string | undefined {
  const k = authStore.getStore()?.apiKey;
  return k && k.trim() ? k.trim() : undefined;
}

/** An error carrying the HTTP status and Magileads' machine-readable key (`state_message`). */
export class MagileadsError extends Error {
  status: number;
  key?: string;
  detail?: string;
  constructor(message: string, status: number, key?: string, detail?: string) {
    super(message);
    this.name = "MagileadsError";
    this.status = status;
    this.key = key;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

let accessToken = "";
let refreshToken = "";
let expiresAt = 0; // epoch ms; renew a little early

/** Decode a JWT's `exp` (seconds → ms). Returns null if it can't be read. */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pull Magileads' machine key + human detail out of an error body. */
function errorInfo(data: unknown): { key?: string; detail?: string } {
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const key = typeof o.state_message === "string" ? o.state_message : undefined;
  const detail = Array.isArray(o.errors)
    ? (o.errors as unknown[]).filter((e): e is string => typeof e === "string").join(" · ")
    : undefined;
  return { key, detail };
}

async function login(): Promise<void> {
  const res = await fetch(`${API_BASE}/users/authentication`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const data = await readBody(res);
  if (!res.ok) {
    const { key, detail } = errorInfo(data);
    throw new MagileadsError(
      `Magileads login failed (${res.status})`,
      res.status,
      key,
      detail,
    );
  }
  const tokens = data as { access_token?: string; refresh_token?: string };
  if (!tokens.access_token) {
    throw new MagileadsError("Magileads login returned no access token", res.status);
  }
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token || "";
  expiresAt = jwtExpiryMs(accessToken) ?? Date.now() + 25 * 60 * 1000;
}

async function refresh(): Promise<void> {
  if (!refreshToken) return login();
  const res = await fetch(`${API_BASE}/users/authentication/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    // Refresh token likely expired — fall back to a full login.
    return login();
  }
  const tokens = (await readBody(res)) as { access_token?: string; refresh_token?: string };
  if (!tokens.access_token) return login();
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token || refreshToken;
  expiresAt = jwtExpiryMs(accessToken) ?? Date.now() + 25 * 60 * 1000;
}

/** Return the auth headers for the current request, logging in / refreshing as needed. */
async function authHeaders(): Promise<Record<string, string>> {
  // Multi-tenant: a per-request client key wins and is sent as-is (stateless — no JWT cache).
  const perReq = currentApiKey();
  if (perReq) return { "X-API-Key": perReq };

  // Fall back to the server's own env credentials (single-account / stdio).
  const mode = authMode();
  if (mode === "apiKey") return { "X-API-Key": API_KEY };
  if (mode === "none") {
    throw new MagileadsError(
      "No Magileads credentials for this request. Send the client's Magileads API key " +
        "(X-Magileads-Api-Key header, Authorization: Bearer <key>, or ?api_key=<key>), " +
        "or configure MAGILEADS_API_KEY / MAGILEADS_EMAIL+PASSWORD on the server.",
      401,
      "no_credentials",
    );
  }
  // Renew 30s early to avoid racing the 30-minute expiry.
  if (!accessToken || Date.now() >= expiresAt - 30_000) {
    if (refreshToken) await refresh();
    else await login();
  }
  return { Authorization: `Bearer ${accessToken}` };
}

/* -------------------------------------------------------------------------- */
/* Request core                                                                */
/* -------------------------------------------------------------------------- */

async function api<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  // A mid-flight token expiry (env password mode only) → re-auth once and retry.
  // Never for a per-request client key: a 401 there means the client's key is bad.
  if (res.status === 401 && !currentApiKey() && authMode() === "password" && retryOn401) {
    accessToken = "";
    expiresAt = 0;
    return api<T>(path, init, false);
  }

  const data = await readBody(res);
  if (!res.ok) {
    const { key, detail } = errorInfo(data);
    throw new MagileadsError(
      `Magileads request failed: ${init.method || "GET"} ${path} (${res.status})`,
      res.status,
      key,
      detail,
    );
  }
  return data as T;
}

/* -------------------------------------------------------------------------- */
/* Google Maps targeting                                                       */
/* -------------------------------------------------------------------------- */

export type GeneratedUrls = { google_maps_search_urls: string[] };

/** Generate Google Maps search URLs from a free-text query (+ optional locations). */
export function generateMapsUrls(body: {
  search: string;
  locations?: string[];
  max_links: number;
}): Promise<GeneratedUrls> {
  return api<GeneratedUrls>("/targeting/google/generate-maps-search-urls", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Extract businesses from Google Maps search URLs into a contact list (async job). */
export function extractMaps(body: {
  google_maps_search_urls: string[];
  max_results: number;
  contact_list_name?: string;
  contact_list_id?: number;
}): Promise<{ contact_list_id: number }> {
  return api<{ contact_list_id: number }>("/targeting/google/extract-maps-search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* -------------------------------------------------------------------------- */
/* Contact lists (for choosing a destination & polling extraction status)      */
/* -------------------------------------------------------------------------- */

export type Job = {
  uniqid?: string;
  type?: string;
  state?: string;
  percent?: number;
  queued_date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

export type ContactListSummary = {
  id: number;
  name: string;
  number_of_contacts?: number;
  number_of_emails?: number;
  number_of_companies?: number;
  state_details?: Job[];
  created_on?: string;
  [key: string]: unknown;
};

type PaginatedLists = {
  number_of_results: number;
  number_of_pages: number;
  results: ContactListSummary[];
};

/**
 * List contact lists, optionally filtered by name. Uses the paginated endpoint
 * (fast even with thousands of lists). The endpoint only filters/sorts on
 * `name`/`id`, so a name query maps to a `name contains` filter.
 */
export async function searchContactLists(
  nameQuery: string | undefined,
  limit: number,
): Promise<{ total: number; lists: ContactListSummary[] }> {
  const options: Record<string, unknown> = { per_page: Math.min(Math.max(limit, 1), 200) };
  if (nameQuery && nameQuery.trim()) {
    options.filter = {
      mode: "and",
      values: [{ field_name: "name", type: "contains", value: nameQuery.trim() }],
    };
  }
  const q = `?options=${encodeURIComponent(JSON.stringify(options))}`;
  const data = await api<PaginatedLists>(`/contact-lists-paginated/page/1${q}`, {
    method: "GET",
  });
  return { total: data.number_of_results ?? 0, lists: data.results ?? [] };
}

/** Fetch one list's profile — counts + `state_details` jobs (extraction progress). */
export async function getContactList(id: number): Promise<ContactListSummary> {
  const data = await api<{ contact_list_profile: ContactListSummary }>(
    `/contact-lists/${id}`,
    { method: "GET" },
  );
  return data.contact_list_profile;
}

/* -------------------------------------------------------------------------- */
/* Contact fields & selection (filter / count / delete)                        */
/* -------------------------------------------------------------------------- */

/**
 * A Magileads data field. Data fields are account-global (shared across
 * every contact list), so `listDataFields()` is what backs `list_contact_fields`.
 * `id` is the numeric field id used as `field_name` (as a STRING) inside filters;
 * `identifier` is the stable slug an agent names ("email", "company", ...).
 */
export type DataField = {
  id: number;
  name: string;
  identifier: string;
  possible_values?: string[] | null;
  [key: string]: unknown;
};

/** One leaf filter condition. `field_name` is a data_field_id serialized as a string. */
export type FilterValue = {
  field_name: string;
  type: string;
  value?: string | string[];
};

/** A filter node: `and`/`or` over leaf conditions (and, recursively, nested nodes). */
export type FilterNode = {
  mode: "and" | "or";
  values: (FilterValue | FilterNode)[];
};

/** An all-matching (empty) filter — matches every contact in the list. */
export const EMPTY_FILTER: FilterNode = { mode: "and", values: [] };

/** List the account's data fields (the filterable contact fields). */
export async function listDataFields(): Promise<DataField[]> {
  const data = await api<{ data_fields_list?: DataField[] }>("/data-fields", {
    method: "GET",
  });
  return data.data_fields_list ?? [];
}

/**
 * Count the contacts of a list that match `filter`, via the paginated contacts
 * endpoint. `per_page:1` keeps the payload tiny; `number_of_results` is the FULL
 * match count (not the page size). This is the source of truth for the guardrail.
 */
export async function countContacts(listId: number, filter: FilterNode): Promise<number> {
  const options = { per_page: 1, filter };
  const q = `?options=${encodeURIComponent(JSON.stringify(options))}`;
  const data = await api<{ number_of_results?: number }>(
    `/contact-lists/${listId}/contacts${q}`,
    { method: "GET" },
  );
  return data.number_of_results ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Campaigns / scenarios / statistics (READ-ONLY — campaign audit)             */
/*                                                                             */
/* Magileads vocabulary: a "campaign" is a workflow *programmation* (a         */
/* scheduled run of a scenario against contact lists); a "scenario" is a       */
/* *workflow* (the step template). Statistics hang off the programmation.      */
/* -------------------------------------------------------------------------- */

/** A record with arbitrary keys — these API objects are large and untyped in swagger. */
export type Raw = Record<string, unknown>;

type ProgrammationList = {
  number_of_results?: number;
  results?: Raw[];
};

/**
 * List workflow programmations (campaigns). The endpoint filters/sorts only on
 * id/created_on/workflow_id/date_start (NOT name), so name search is done by the
 * caller against `workflow_name`. `per_page` is capped at 100 by the API.
 */
export async function listProgrammations(perPage: number): Promise<{ total: number; results: Raw[] }> {
  const options = { per_page: Math.min(Math.max(perPage, 1), 100) };
  const q = `?options=${encodeURIComponent(JSON.stringify(options))}`;
  const data = await api<ProgrammationList>(`/workflows/programmations${q}`, { method: "GET" });
  return { total: data.number_of_results ?? 0, results: data.results ?? [] };
}

/**
 * Fetch a single programmation (campaign) by its id, using the list endpoint's
 * server-side `id equals` filter (the by-id GET needs the workflow_id in the path,
 * which we don't have from a campaign id alone). Returns null if not found/owned.
 */
export async function getProgrammationById(id: number): Promise<Raw | null> {
  const options = {
    per_page: 1,
    filter: { mode: "and", values: [{ field_name: "id", type: "equals", value: String(id) }] },
  };
  const q = `?options=${encodeURIComponent(JSON.stringify(options))}`;
  const data = await api<ProgrammationList>(`/workflows/programmations${q}`, { method: "GET" });
  return (data.results ?? [])[0] ?? null;
}

/** Fetch a workflow (scenario) profile, including its `steps` array. */
export async function getWorkflow(id: number): Promise<Raw> {
  const data = await api<{ workflow_profile: Raw }>(`/workflows/${id}`, { method: "GET" });
  return data.workflow_profile;
}

/** Fetch a programmation's (campaign's) statistics — aggregate + per-step. */
export async function getProgrammationStatistics(id: number): Promise<Raw> {
  const data = await api<{ programmation: Raw }>(`/statistics/programmations/${id}`, {
    method: "GET",
  });
  return data.programmation;
}

/** Map a step `action_type` to its message-model endpoint (null if it has no model). */
function modelPath(actionType: string, modelId: number): string | null {
  switch (actionType) {
    case "email":
      return `/models/email/${modelId}`;
    case "linkedin_message":
      return `/models/linkedin/message/${modelId}`;
    case "linkedin_invitation":
      return `/models/linkedin/invitation/${modelId}`;
    case "sms":
      return `/models/sms/${modelId}`;
    case "smv":
      return `/models/smv/${modelId}`;
    default:
      return null; // linkedin_visit, call, dummy, split_contacts, remove_prospect
  }
}

/**
 * Fetch the full message model (template) behind a scenario step, so the scenario
 * tool can return complete subject/body content. Returns null for step types that
 * carry no model. Never throws — a fetch failure yields `{ _model_error }` so one
 * bad template can't sink the whole scenario read.
 */
export async function getStepModel(actionType: string, modelId: number): Promise<Raw | null> {
  const path = modelPath(actionType, modelId);
  if (!path) return null;
  try {
    const data = await api<{ model_profile?: Raw }>(path, { method: "GET" });
    return data.model_profile ?? (data as Raw);
  } catch (err) {
    const message = err instanceof MagileadsError ? err.message : String(err);
    return { _model_error: message, model_id: modelId, action_type: actionType };
  }
}

/* -------------------------------------------------------------------------- */
/* Account / integrations / data browsing (READ-ONLY)                          */
/* -------------------------------------------------------------------------- */

/** Fetch the authenticated account's profile (`GET /users/me` -> user_profile). */
export async function getMe(): Promise<Raw> {
  const data = await api<{ user_profile: Raw }>("/users/me", { method: "GET" });
  return data.user_profile;
}

/** List the account's connected LinkedIn integration accounts. */
export async function listLinkedinAccounts(): Promise<Raw[]> {
  const data = await api<{ linkedin_accounts_list?: Raw[] }>("/integrations/linkedin", {
    method: "GET",
  });
  return data.linkedin_accounts_list ?? [];
}

/** A page of contact lists (root envelope of the paginated list endpoint). */
/**
 * Fetch ALL contact lists in one call — ids, names, and counters
 * (number_of_contacts/emails/linkedin_url/companies), plus created_on and
 * list_type. Non-paginated, so sorting/ranking (e.g. "biggest lists") is correct
 * across the whole account, not just one page. Filtering/sorting is done by the
 * caller (`search_contact_lists`) in memory.
 */
export async function listContactListNames(): Promise<ContactListSummary[]> {
  const data = await api<{ contact_lists?: ContactListSummary[] }>("/contact-lists/names", {
    method: "GET",
  });
  return data.contact_lists ?? [];
}

/**
 * A page of contacts. NOTE (verified live, differs from some docs): `results` is a
 * FLAT array of Contact objects and the per-list counters sit at the ROOT — there
 * is no `results[0].results` nesting. Pagination is cursor-based: `current_page` /
 * `next_page` are URLs of the form
 * `/contact-lists/{id}/contacts[/search]/{cursor}/page/{n}`, and a `page` field
 * inside `options` is ignored.
 */
export type ContactsPage = {
  number_of_results?: number;
  number_of_pages?: number;
  current_page?: string | null;
  next_page?: string | null;
  previous_page?: string | null;
  number_of_contacts?: number;
  number_of_emails?: number;
  number_of_linkedin_url?: number;
  results?: Raw[];
};

/** Derive the path for page N from a cursor URL, keeping only the pathname. */
function cursorPagePath(currentPage: string | null | undefined, page: number): string | null {
  if (!currentPage) return null;
  try {
    const { pathname } = new URL(currentPage);
    return /\/page\/\d+$/.test(pathname) ? pathname.replace(/\/page\/\d+$/, `/page/${page}`) : null;
  } catch {
    return null;
  }
}

/**
 * Query a list's contacts with a pre-built `options` JSON (PaginationOptions). The
 * first call creates the cursor; for page>1 we replay the requested page against the
 * cursor URL the first call returned. `optionsJson` is passed through verbatim.
 */
export async function queryContacts(
  listId: number,
  optionsJson: string,
  page: number,
): Promise<ContactsPage> {
  const q = `?options=${encodeURIComponent(optionsJson)}`;
  const first = await api<ContactsPage>(`/contact-lists/${listId}/contacts${q}`, { method: "GET" });
  if (page <= 1) return first;
  const path = cursorPagePath(first.current_page, page);
  if (!path) return first;
  return api<ContactsPage>(`${path}${q}`, { method: "GET" });
}

/**
 * Free-text search within a list's contacts. POST creates the cursor; deeper pages
 * are GET on the returned cursor URL (per the API). Same flat envelope as queryContacts.
 */
export async function searchContacts(
  listId: number,
  query: string,
  optionsJson: string,
  page: number,
): Promise<ContactsPage> {
  const q = `?options=${encodeURIComponent(optionsJson)}`;
  const first = await api<ContactsPage>(`/contact-lists/${listId}/contacts/search${q}`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  if (page <= 1) return first;
  const path = cursorPagePath(first.current_page, page);
  if (!path) return first;
  return api<ContactsPage>(`${path}${q}`, { method: "GET" });
}

/* -------------------------------------------------------------------------- */
/* PRM — the CRM / prospection pipeline (READ-ONLY)                            */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the PRM status referential. Two shapes (verified live):
 *   default statuses  → { status:<key string>, visible, color, sorting }  (no id/name)
 *   custom statuses   → { id, name, visible, color, sorting, type_default_status }
 * A PRM contact's `custom_status` is a custom-status id; its `status` is a default key.
 */
export async function listPrmStatuses(): Promise<{ default: Raw[]; custom: Raw[] }> {
  const [def, cust] = await Promise.all([
    api<{ status?: Raw[] }>("/prm/status", { method: "GET" }),
    api<{ status?: Raw[] }>("/prm/status/custom", { method: "GET" }),
  ]);
  return { default: def.status ?? [], custom: cust.status ?? [] };
}

/**
 * Query PRM contacts with a pre-built `options` JSON. Same flat envelope + cursor
 * pagination as the contact-list contacts (`/prm/contacts/{cursor}/page/{n}`).
 */
export async function queryPrmContacts(optionsJson: string, page: number): Promise<ContactsPage> {
  const q = `?options=${encodeURIComponent(optionsJson)}`;
  const first = await api<ContactsPage>(`/prm/contacts${q}`, { method: "GET" });
  if (page <= 1) return first;
  const path = cursorPagePath(first.current_page, page);
  if (!path) return first;
  return api<ContactsPage>(`${path}${q}`, { method: "GET" });
}

/** Fetch one PRM contact's full profile (`GET /prm/contact/{id}` → contact_profile). */
export async function getPrmContact(contactId: number): Promise<Raw> {
  const data = await api<{ contact_profile: Raw }>(`/prm/contact/${contactId}`, { method: "GET" });
  return data.contact_profile;
}

/** List the account's PRM nurturing sequences. */
export async function listPrmNurturings(): Promise<Raw[]> {
  const data = await api<{ nurturings?: Raw[] }>("/prm/nurturings", { method: "GET" });
  return data.nurturings ?? [];
}

/* -------------------------------------------------------------------------- */
/* Generic passthrough (used by the allow-listed magileads_get/_request tools) */
/* -------------------------------------------------------------------------- */

/**
 * Make an arbitrary authenticated request to the Magileads API. `pathWithQuery`
 * must already include the leading slash and any (encoded) `?query`. Returns the
 * parsed JSON body; throws MagileadsError on a non-2xx (surfaced via fail()).
 * The caller is responsible for restricting which paths/methods are allowed.
 */
export async function rawRequest(
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method: method.toUpperCase() };
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return api<unknown>(pathWithQuery, init);
}

export { API_BASE };
