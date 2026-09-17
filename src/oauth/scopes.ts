export const SCOPES = ["mcp:read", "mcp:write"] as const;
export type Scope = (typeof SCOPES)[number];

export function parseScopes(value: unknown): Scope[] {
  const raw = typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) ? value : [];
  return [...new Set(raw.filter((item): item is Scope => item === "mcp:read" || item === "mcp:write"))];
}
