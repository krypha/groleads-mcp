import { MAGILEADS_ENDPOINTS, type EndpointDef } from "./endpoints.generated.js";
import type { Raw } from "./magileads.js";

export const CALLABLE_ENDPOINTS = MAGILEADS_ENDPOINTS;
const matchers = CALLABLE_ENDPOINTS.map((endpoint) => ({
  endpoint,
  specificity: endpoint.path.replace(/\{[^}]+\}/g, "").length,
  regex: new RegExp("^" + endpoint.path.split(/\{[^}]+\}/g)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$"),
})).sort((a, b) => b.specificity - a.specificity);

/** Only registered method/path pairs. No arbitrary pagination suffix fallback. */
export function matchEndpoint(method: string, path: string): EndpointDef | undefined {
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  return matchers.find((item) => item.endpoint.method === method && item.regex.test(clean))?.endpoint;
}

/** Echoed cursor URLs are reduced to a local API path; their origin is never used. */
export function buildPath(rawPath: string, query?: Raw): { base: string; full: string } {
  let raw = rawPath.trim();
  if (!raw || /[#{}\\]/.test(raw) || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(raw)) {
    throw new Error("Invalid API path. Fill all path parameters; fragments and traversal are refused.");
  }
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.username || url.password) throw new Error("URL credentials are refused.");
    raw = url.pathname + url.search;
  }
  const split = raw.indexOf("?");
  const pathname = split < 0 ? raw : raw.slice(0, split);
  const base = ("/" + pathname.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
  for (const part of base.split("/")) {
    const decoded = decodeURIComponent(part);
    if (decoded === "." || decoded === ".." || /[\/\\{}?#]/.test(decoded)) throw new Error("Invalid encoded path segment.");
  }
  const params = new URLSearchParams(split < 0 ? "" : raw.slice(split + 1));
  if (query) for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const qs = params.toString();
  return { base, full: qs ? `${base}?${qs}` : base };
}

export function resolveEndpoint(method: string, path: string, query?: Raw): { endpoint: EndpointDef; full: string } {
  const { base, full } = buildPath(path, query);
  const endpoint = matchEndpoint(method, base);
  if (!endpoint) throw new Error(`${method} ${base} is not authorized by the MCP business route contract.`);
  return { endpoint, full };
}
