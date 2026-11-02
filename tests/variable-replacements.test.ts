import { expect, test } from "bun:test";
import { mergeReplacements, readReplacements, replacementChangesSchema, validateReplacementProfileUpdate } from "../src/variable-replacements.js";
const fields = [{ id: 1, identifier: "email", name: "Email", identifier_placeholder: "%email%" },
  { id: 2, identifier: "civility", name: "Civilité", identifier_placeholder: "%civility%" }, { id: 3, identifier: "company", name: "Entreprise" }];
test("saved account fallbacks are read strictly; missing configuration never becomes an empty overwrite", () => {
  expect(readReplacements({ datafields_replacement: null })).toEqual([]);
  expect(readReplacements({ datafields_replacement: [{ datafield_id: 2, replacement: "" }] })).toEqual([{ datafield_id: 2, replacement: "" }]);
  for (const profile of [{}, { datafields_replacement: {} }, { datafields_replacement: [{ datafield_id: "2", replacement: "Mr/Mme" }] },
    { datafields_replacement: [{ datafield_id: 2, replacement: "A" }, { datafield_id: 2, replacement: "B" }] }]) expect(() => readReplacements(profile)).toThrow();
});
test("Civilité resolves by label, identifier, exact placeholder and ID, preserving unrelated preferences", () => {
  const saved = [{ datafield_id: 1, replacement: "existing" }, { datafield_id: 3, replacement: "votre entreprise" }];
  for (const field of ["Civilité", "civilite", "civility", "%civility%", "2"]) {
    const merged = mergeReplacements(saved, fields, [{ field, replacement: "Mr/Mme" }]);
    expect(merged.next).toEqual([...saved, { datafield_id: 2, replacement: "Mr/Mme" }]);
    expect(merged.changes[0]).toMatchObject({ datafield_id: 2, placeholder: "%civility%" });
  }
  expect(saved).toHaveLength(2);
});
test("clearing removes only the requested field and supports removing the last fallback", () => {
  const saved = [{ datafield_id: 1, replacement: "keep" }, { datafield_id: 2, replacement: "Mr/Mme" }];
  expect(mergeReplacements(saved, fields, [{ field: "Civilité", replacement: "" }]).next).toEqual([saved[0]]);
  expect(mergeReplacements([saved[1]], fields, [{ field: "2", replacement: "" }]).next).toEqual([]);
  expect(mergeReplacements(saved, fields, [{ field: "2", replacement: "Mr/Mme" }]).unchanged).toBe(true);
});
test("ambiguous fields, unknown fields and duplicate resolved aliases are refused", () => {
  for (const changes of [[{ field: "missing", replacement: "x" }], [{ field: "civility", replacement: "x" }, { field: "2", replacement: "y" }]]) {
    expect(() => mergeReplacements([], fields, changes)).toThrow();
  }
  expect(() => mergeReplacements([], [...fields, { id: 4, name: "Civilité" }], [{ field: "Civilité", replacement: "x" }])).toThrow("Ambiguous");
});
test("stale saved fields are not silently removed, and can be explicitly cleared by ID", () => {
  const saved = [{ datafield_id: 99, replacement: "old" }, { datafield_id: 2, replacement: "Mr/Mme" }];
  expect(mergeReplacements(saved, fields, [{ field: "2", replacement: "Mr/Mme" }]).unchanged).toBe(true);
  expect(() => mergeReplacements(saved, fields, [{ field: "2", replacement: "Bonjour" }])).toThrow("99");
  expect(mergeReplacements(saved, fields, [{ field: "99", replacement: "" }, { field: "2", replacement: "Bonjour" }]).next)
    .toEqual([{ datafield_id: 2, replacement: "Bonjour" }]);
});
test("the complete merged configuration is capped by UTF-8 bytes, not characters", () => {
  expect(() => mergeReplacements([], fields, [{ field: "2", replacement: "🙂".repeat(20_000) }])).toThrow();
  expect(() => mergeReplacements([{ datafield_id: 1, replacement: "a".repeat(33_000) }], fields, [{ field: "2", replacement: "b".repeat(33_000) }])).toThrow();
  expect(mergeReplacements([], fields, [{ field: "2", replacement: "  Mr/Mme  " }]).next[0].replacement).toBe("  Mr/Mme  ");
  expect(replacementChangesSchema.safeParse([]).success).toBe(false);
  expect(replacementChangesSchema.safeParse(Array.from({ length: 51 }, () => ({ field: "2", replacement: "x" }))).success).toBe(false);
});
test("generic profile updates expose only the explicit replacements array, never other profile settings or query arguments", () => {
  expect(validateReplacementProfileUpdate("/users/me", { datafields_replacement: [] })).toEqual({ datafields_replacement: [] });
  for (const body of [{}, { datafields_replacement: null }, { email: "other@example.invalid" }, { datafields_replacement: [], password: "test" },
    { datafields_replacement: [{ datafield_id: 2, replacement: "x", extra: true }] }, JSON.stringify({ datafields_replacement: [] })]) {
    expect(() => validateReplacementProfileUpdate("/users/me", body)).toThrow();
  }
  expect(() => validateReplacementProfileUpdate("/users/me?email=other", { datafields_replacement: [] })).toThrow();
});
