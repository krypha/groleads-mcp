/** Account-level merge-variable fallbacks, never contact properties. No API I/O. */
import { z } from "zod";
const id = z.number().int().positive().safe();
export const replacementSchema = z.object({ datafield_id: id, replacement: z.string() }).strict();
export type Replacement = z.infer<typeof replacementSchema>;
export type ReplacementField = { id: number; identifier?: string; identifier_placeholder?: string; name?: string };
export const replacementListSchema = z.array(replacementSchema)
  .refine((rows) => new Set(rows.map((row) => row.datafield_id)).size === rows.length, "Duplicate replacement field IDs are refused.")
  .refine((rows) => Buffer.byteLength(JSON.stringify(rows), "utf8") <= 65_535, "The complete replacement configuration exceeds the API's 65535-byte limit.");
const profileBodySchema = z.object({ datafields_replacement: replacementListSchema }).strict();
export function validateReplacementProfileUpdate(path: string, body: unknown): { datafields_replacement: Replacement[] } {
  if (path.includes("?")) throw new Error("Profile replacement updates accept no query parameters.");
  const parsed = profileBodySchema.safeParse(body);
  if (!parsed.success) throw new Error("PUT /users/me only accepts {datafields_replacement:[{datafield_id,replacement}]}; other profile settings, duplicate IDs and oversized configurations are refused.");
  return parsed.data;
}
export function readReplacements(profile: Record<string, unknown>): Replacement[] {
  if (!Object.hasOwn(profile, "datafields_replacement")) throw new Error("The full replacement configuration is missing; refusing to overwrite unknown account preferences.");
  if (profile.datafields_replacement === null) return [];
  const parsed = replacementListSchema.safeParse(profile.datafields_replacement);
  if (!parsed.success) throw new Error("The saved replacement configuration is malformed or too large; nothing was modified.");
  return parsed.data;
}
export const replacementChangesSchema = z.array(z.object({
  field: z.string().trim().min(1).max(256).describe("Readable field identifier, exact placeholder, field label (e.g. Civilité), or numeric ID as a string."),
  replacement: z.string().max(65_535).describe("Fallback when a contact has no value. Empty string removes only this field's account fallback; contact data is unchanged."),
}).strict()).min(1).max(50).refine((rows) => Buffer.byteLength(JSON.stringify(rows), "utf8") <= 65_535, "Requested changes exceed 65535 bytes; no values are silently dropped.");
export type ReplacementChange = z.infer<typeof replacementChangesSchema>[number];
export const normalizeFieldName = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
export function mergeReplacements(existing: Replacement[], fields: ReplacementField[], changes: ReplacementChange[]) {
  const resolved = changes.map((change) => {
    const key = normalizeFieldName(change.field);
    let matches: ReplacementField[];
    if (/^\d+$/.test(key)) {
      const fieldId = Number(key);
      matches = fields.filter((field) => field.id === fieldId);
      // Explicitly clearing a stale preference does not require reading that deleted field.
      if (!matches.length && change.replacement === "" && existing.some((row) => row.datafield_id === fieldId)) matches = [{ id: fieldId }];
    } else {
      matches = fields.filter((field) => [field.identifier, field.identifier_placeholder].some((name) => name && normalizeFieldName(name) === key));
      if (!matches.length) matches = fields.filter((field) => field.name && normalizeFieldName(field.name) === key);
    }
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous field '${change.field}'; use its numeric ID.` : `Unknown or unreadable field '${change.field}'; use get_variable_replacements to find its identifier/ID.`);
    return { ...change, definition: matches[0], datafield_id: matches[0].id };
  });
  if (new Set(resolved.map((row) => row.datafield_id)).size !== resolved.length) throw new Error("Multiple changes resolve to the same field; nothing was modified.");
  const next = existing.map((row) => ({ ...row }));
  for (const change of resolved) {
    const index = next.findIndex((row) => row.datafield_id === change.datafield_id);
    if (change.replacement === "") { if (index >= 0) next.splice(index, 1); }
    else if (index >= 0) next[index] = { datafield_id: change.datafield_id, replacement: change.replacement };
    else next.push({ datafield_id: change.datafield_id, replacement: change.replacement });
  }
  replacementListSchema.parse(next);
  const unchanged = JSON.stringify(existing) === JSON.stringify(next);
  if (!unchanged) {
    const readable = new Set(fields.map((field) => field.id));
    const stale = next.find((row) => !readable.has(row.datafield_id));
    if (stale) throw new Error(`Saved replacement ${stale.datafield_id} references an unreadable/deleted field. Explicitly clear that ID first or in the same request; no other preference was silently removed.`);
  }
  return { next, unchanged, changes: resolved.map((row) => ({ datafield_id: row.datafield_id, identifier: row.definition.identifier ?? null,
    label: row.definition.name ?? null, placeholder: row.definition.identifier_placeholder ?? null, replacement: row.replacement, removed: row.replacement === "" })) };
}
