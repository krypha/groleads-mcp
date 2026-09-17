import { z } from "zod";

const url = z.string().trim().min(1).url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}, "must be an absolute HTTP URL");

const schema = z.object({
  OAUTH_ISSUER: url,
  OAUTH_MCP_RESOURCE: url,
  OAUTH_API_RESOURCE: url,
  OAUTH_INTERNAL_CLIENT_ID: z.string().trim().min(1),
  OAUTH_INTERNAL_CLIENT_SECRET: z.string().refine((value) => value.trim().length > 0, "required"),
  MAGILEADS_API_URL: url.optional(),
  OAUTH_JWKS_URI: url.optional(),
  OAUTH_CLOCK_TOLERANCE: z.coerce.number().int().min(0).max(600).default(60),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  MCP_HTTP_PATH: z.string().default("/mcp"),
});

export type OAuthConfig = {
  issuer: string;
  mcpResource: string;
  apiResource: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  jwksUri?: string;
  clockTolerance: number;
  port: number;
  mcpPath: string;
  metadataUrl: string;
  metadataPath: string;
};

let cached: OAuthConfig | undefined;

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid OAuth configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}. See .env.example.`);
  }
  const value = parsed.data;
  const resource = new URL(value.OAUTH_MCP_RESOURCE);
  const issuer = new URL(value.OAUTH_ISSUER);
  const api = new URL(value.OAUTH_API_RESOURCE);
  const apiBase = new URL(value.MAGILEADS_API_URL ?? value.OAUTH_API_RESOURCE);
  if (issuer.search || issuer.hash || issuer.username || issuer.password || api.hash || api.username || api.password) {
    throw new Error("OAuth issuer and API resource URLs must not contain credentials or fragments.");
  }
  if (apiBase.search || apiBase.hash || apiBase.username || apiBase.password) {
    throw new Error("MAGILEADS_API_URL must not contain credentials, a query, or a fragment.");
  }
  const mcpPath = value.MCP_HTTP_PATH;
  if (!mcpPath.startsWith("/") || mcpPath !== resource.pathname || resource.search || resource.hash || resource.username || resource.password) {
    throw new Error("OAUTH_MCP_RESOURCE must have the same path as MCP_HTTP_PATH, with no query or fragment.");
  }
  if (value.OAUTH_API_RESOURCE === value.OAUTH_MCP_RESOURCE) {
    throw new Error("OAUTH_API_RESOURCE must differ from OAUTH_MCP_RESOURCE.");
  }
  const metadataPath = `/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : mcpPath.replace(/\/$/, "")}`;
  return {
    issuer: value.OAUTH_ISSUER,
    mcpResource: value.OAUTH_MCP_RESOURCE,
    apiResource: value.OAUTH_API_RESOURCE,
    clientId: value.OAUTH_INTERNAL_CLIENT_ID,
    clientSecret: value.OAUTH_INTERNAL_CLIENT_SECRET,
    apiUrl: (value.MAGILEADS_API_URL ?? value.OAUTH_API_RESOURCE).replace(/\/+$/, ""),
    jwksUri: value.OAUTH_JWKS_URI,
    clockTolerance: value.OAUTH_CLOCK_TOLERANCE,
    port: value.MCP_HTTP_PORT,
    mcpPath,
    metadataPath,
    metadataUrl: `${resource.origin}${metadataPath}`,
  };
}

export function oauthConfig(): OAuthConfig {
  cached ??= loadOAuthConfig();
  return cached;
}
