/**
 * Minimal, self-contained Magileads API client for the MCP server.
 *
 * Unlike the app's `src/lib/magileads.ts` (which is `server-only` and cookie-bound),
 * this client is a standalone Node module. It authenticates in one of two ways,
 * chosen from the environment:
 *
 *   - MAGILEADS_API_KEY               -> sent as `X-API-Key` (machine-to-machine, preferred for agents)
 *   - MAGILEADS_EMAIL + MAGILEADS_PASSWORD -> POST /users/authentication (JWT, auto-refreshed)
 *
 * Base URL defaults to https://app.api-magileads.net (override with MAGILEADS_API_BASE).
 */

const API_BASE = (process.env.MAGILEADS_API_BASE || "https://app.api-magileads.net").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.MAGILEADS_API_KEY?.trim() || "";
const EMAIL = process.env.MAGILEADS_EMAIL?.trim() || "";
const PASSWORD = process.env.MAGILEADS_PASSWORD || "";

export type AuthMode = "apiKey" | "password" | "none";

export function authMode(): AuthMode {
  if (API_KEY) return "apiKey";
  if (EMAIL && PASSWORD) return "password";
  return "none";
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

/** Return the auth headers, logging in / refreshing the JWT as needed. */
async function authHeaders(): Promise<Record<string, string>> {
  const mode = authMode();
  if (mode === "apiKey") return { "X-API-Key": API_KEY };
  if (mode === "none") {
    throw new MagileadsError(
      "No Magileads credentials configured. Set MAGILEADS_API_KEY, or MAGILEADS_EMAIL + MAGILEADS_PASSWORD.",
      0,
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

  // A mid-flight token expiry (password mode) → re-auth once and retry.
  if (res.status === 401 && authMode() === "password" && retryOn401) {
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

export { API_BASE };
