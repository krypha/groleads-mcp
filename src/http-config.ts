import { z } from "zod";

const schema = z.object({
  MCP_HTTP_AUTH: z.enum(["oauth", "api_key", "both"]).default("oauth"),
  MCP_ALLOW_API_KEY_QUERY: z.enum(["true", "false"]).default("false"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  MCP_HTTP_PATH: z.string().default("/mcp"),
});

export type HttpConfig = {
  authMode: "oauth" | "api_key" | "both";
  allowApiKeyQuery: boolean;
  port: number;
  mcpPath: string;
};

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid HTTP configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}. See .env.example.`);
  }
  const value = parsed.data;
  if (!value.MCP_HTTP_PATH.startsWith("/") || value.MCP_HTTP_PATH.includes("?") || value.MCP_HTTP_PATH.includes("#")) {
    throw new Error("MCP_HTTP_PATH must be an absolute URL path without a query or fragment.");
  }
  return {
    authMode: value.MCP_HTTP_AUTH,
    allowApiKeyQuery: value.MCP_ALLOW_API_KEY_QUERY === "true",
    port: value.MCP_HTTP_PORT,
    mcpPath: value.MCP_HTTP_PATH,
  };
}
