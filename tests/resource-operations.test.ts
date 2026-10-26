import { expect, test } from "bun:test";
import { checkedCount, distinctIdsSchema, mergeSharingRules, readSharingRules, selectionFingerprint,
  type SharingRule } from "../src/resource-operations.js";

const rule = (ids: number[], write = false, remove = false, type: SharingRule["sharing_type_to"] = "User"): SharingRule => ({
  sharing_type_to: type, ids_list: ids, name: "Existing access", read_permission: true, write_permission: write, delete_permission: remove,
});
const change = { action: "grant" as const, target_type: "user" as const, target_ids: [7], name: "New access", allow_write: false, allow_delete: false };

test("ACL parsing keeps the documented input and resolves sharing_targets safely", () => {
  expect(readSharingRules({ permission: { is_admin: true }, sharing: [rule([7])] })).toEqual([rule([7])]);
  const { ids_list, ...existing } = rule([7]);
  expect(readSharingRules({ sharing: [{ ...existing, sharing_targets: [{ id: 7, name: "User" }] }] })).toEqual([rule([7])]);
});
test("hidden, malformed, incomplete or non-admin ACLs fail closed", () => {
  for (const value of [{}, { sharing: null }, { sharing: [null] }, { sharing: [{ ids_list: [7] }] },
    { sharing: [rule([7])], permission: { is_admin: false } }, { sharing: [{ ...rule([7]), ids_list: ["7"] }] }]) {
    expect(() => readSharingRules(value)).toThrow();
  }
});
test("granting access preserves unrelated users, teams, organizations and reseller-customer rules", () => {
  const existing = [rule([8, 9]), rule([3], false, false, "Team"), rule([4], false, false, "Organization"), rule([], false, false, "ResellerCustomers")];
  const result = mergeSharingRules(existing, change);
  expect(result.slice(0, existing.length)).toEqual(existing);
  expect(result.at(-1)?.ids_list).toEqual([7]);
  expect(existing).toEqual([rule([8, 9]), rule([3], false, false, "Team"), rule([4], false, false, "Organization"), rule([], false, false, "ResellerCustomers")]);
});
test("read-only grants never downgrade existing write/delete rights, including overlapping groups", () => {
  const result = mergeSharingRules([rule([7, 8], true), rule([7], false, true)], change);
  expect(result.find((item) => item.ids_list.includes(8))).toEqual(rule([7, 8], true));
  const selected = result.filter((item) => item.sharing_type_to === "User" && item.ids_list.includes(7));
  expect(selected.some((item) => item.write_permission)).toBe(true);
  expect(selected.some((item) => item.delete_permission)).toBe(true);
});
test("new rights are added only to the selected destinations and grouped by effective permissions", () => {
  const result = mergeSharingRules([rule([7], true), rule([8], false, true), rule([9])], { ...change, target_ids: [7, 8], allow_write: true });
  expect(result.find((item) => item.ids_list.includes(7))).toMatchObject({ write_permission: true, delete_permission: false });
  expect(result.find((item) => item.ids_list.includes(8))).toMatchObject({ write_permission: true, delete_permission: true });
  expect(result.find((item) => item.ids_list.includes(9))).toEqual(rule([9]));
});
test("revocation removes explicit selected destinations only, without touching inherited groups", () => {
  const result = mergeSharingRules([rule([7, 8]), rule([7], true, false, "Team")], { ...change, action: "revoke" });
  expect(result).toEqual([rule([8]), rule([7], true, false, "Team")]);
  expect(mergeSharingRules([rule([7])], { ...change, action: "revoke" })).toEqual([]);
});
test("resource batch IDs reject duplicates, fractions, unsafe IDs, empty and oversized inputs", () => {
  expect(distinctIdsSchema.parse([1, 2])).toEqual([1, 2]);
  for (const input of [[], [1, 1], [0], [1.1], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 51 }, (_, i) => i + 1)]) {
    expect(distinctIdsSchema.safeParse(input).success).toBe(false);
  }
});
test("selection fingerprints bind account, resolved filter, target and live counts", () => {
  const base = { account_id: 7, filter: { mode: "and", values: [] }, target: "matching", total: 10, matched: 3 };
  const fingerprint = selectionFingerprint(base);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(selectionFingerprint({ ...base })).toBe(fingerprint);
  for (const input of [{ ...base, account_id: 8 }, { ...base, filter: { mode: "or", values: [] } }, { ...base, target: "all_except_matching" },
    { ...base, total: 11 }, { ...base, matched: 4 }]) expect(selectionFingerprint(input)).not.toBe(fingerprint);
});
test("copy counts are never silently coerced to zero", () => {
  expect(checkedCount(0)).toBe(0);
  expect(checkedCount(123)).toBe(123);
  for (const value of [undefined, null, "123", -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => checkedCount(value)).toThrow();
});
