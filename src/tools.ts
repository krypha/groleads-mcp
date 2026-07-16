import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  generateMapsUrls,
  extractMaps,
  searchContactLists,
  getContactList,
  MagileadsError,
} from "./magileads.js";

const MAX_LINKS = 40;
const MAX_URLS_PER_EXTRACT = 10; // the extract endpoint accepts at most 10 URLs
const MAX_RESULTS = 200;

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
}
