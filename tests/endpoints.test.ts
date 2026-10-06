import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CALLABLE_ENDPOINTS, buildPath, matchEndpoint, resolveEndpoint } from "../src/endpoints.js";

const document = readFileSync(new URL("../docs/oauth-server.md", import.meta.url), "utf8");
const documented = [...document.matchAll(/^\| (GET|POST|PUT) \| `([^`]+)` \| `(mcp:read|mcp:write)`/gm)]
  .map((match) => ({ method: match[1], path: match[2], scope: match[3] }));
const shape = (method: string, path: string) => `${method} ${path.replace(/\{[^}]+\}/g, "{}")}`;
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, "7");

test("catalogue exactly equals all 249 documented method/path/scope pairs", () => {
  expect(documented).toHaveLength(249);
  expect(CALLABLE_ENDPOINTS).toHaveLength(documented.length);
  expect(new Set(CALLABLE_ENDPOINTS.map((row) => shape(row.method, row.path))).size).toBe(249);
  for (const expected of documented) {
    const actual = matchEndpoint(expected.method, concrete(expected.path));
    expect(actual?.scope).toBe(expected.scope);
    expect(actual && shape(actual.method, actual.path)).toBe(shape(expected.method, expected.path));
    expect(actual?.write).toBe(expected.scope === "mcp:write");
  }
});

test("POST read operations and personalized GET writes use explicit scopes", () => {
  expect(CALLABLE_ENDPOINTS.filter((row) => row.method === "POST" && !row.write)).toHaveLength(31);
  expect(CALLABLE_ENDPOINTS.filter((row) => row.method === "GET" && row.write)).toHaveLength(6);
  for (const row of CALLABLE_ENDPOINTS.filter((row) => row.method === "GET" && row.write)) {
    const path = concrete(row.path);
    expect(resolveEndpoint("GET", path).endpoint.scope).toBe("mcp:write");
  }
});

test("all registered pagination variants resolve without suffix inference", () => {
  const pages = documented.filter((row) => row.path.includes("/page/"));
  expect(pages.length).toBeGreaterThan(10);
  for (const row of pages) expect(resolveEndpoint(row.method, concrete(row.path)).endpoint.scope).toBe(row.scope);
  for (const path of ["/users/me/page/2", "/models/email/7/page/2", "/prm/contact/7/page/2", "/users/me/cursor/page/2"]) {
    expect(matchEndpoint("GET", path)).toBeUndefined();
  }
});

test("administration, credentials, DELETE and PATCH are absent and refused", () => {
  for (const [method, path] of [
    ["GET", "/users"], ["GET", "/api-keys"], ["GET", "/external-api-keys"],
    ["POST", "/users/authentication"], ["GET", "/subscriptions"],
    ["PUT", "/resellers/7/role/7"], ["GET", "/blacklists"],
    ["DELETE", "/models/email/7"], ["PATCH", "/models/email/7"],
  ]) {
    expect(() => resolveEndpoint(method, path)).toThrow("not authorized");
  }
});

test("parameter names do not affect dedicated route resolution", () => {
  expect(matchEndpoint("GET", "/contact-lists/{id}")?.scope).toBe("mcp:read");
});

test("echoed URLs stay on local API paths and invalid path segments are refused", () => {
  expect(buildPath("https://echoed.example/prm/contacts/cursor/page/2", { options: { per_page: 5 } }))
    .toEqual({ base: "/prm/contacts/cursor/page/2", full: "/prm/contacts/cursor/page/2?options=%7B%22per_page%22%3A5%7D" });
  for (const path of ["/models/email/../users", "/models/email/%2e%2e", "/models/email/%2fusers", "/models/email/{id}",
    "/models/email/7#fragment", "https://user:secret@example.com/models/email"]) expect(() => buildPath(path)).toThrow();
});
