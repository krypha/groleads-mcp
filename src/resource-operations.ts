/** Pure resource/ACL helpers. No API calls or account-wide mutable state. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const COPYABLE_RESOURCES = {
  contact_list: { base: "/contact-lists", list: "/contact-lists/names", listKey: "contact_lists", profileKey: "contact_list_profile" },
  email_model: { base: "/models/email", list: "/models/email", listKey: "models_list", profileKey: "model_profile" },
  linkedin_invitation_model: { base: "/models/linkedin/invitation", list: "/models/linkedin/invitation", listKey: "models_list", profileKey: "model_profile" },
  linkedin_message_model: { base: "/models/linkedin/message", list: "/models/linkedin/message", listKey: "models_list", profileKey: "model_profile" },
  sms_model: { base: "/models/sms", list: "/models/sms", listKey: "models_list", profileKey: "model_profile" },
  smv_model: { base: "/models/smv", list: "/models/smv", listKey: "models_list", profileKey: "model_profile" },
  workflow: { base: "/workflows", list: "/workflows", listKey: "workflows", profileKey: "workflow_profile" },
} as const;
export const SHARABLE_RESOURCES = {
  ...COPYABLE_RESOURCES,
  data_field: { base: "/data-fields", list: "/data-fields", listKey: "data_fields_list", profileKey: "data_field_profile" },
} as const;
export const resourceTypeSchema = z.enum(["contact_list", "email_model", "linkedin_invitation_model", "linkedin_message_model", "sms_model", "smv_model", "workflow"]);
export const shareResourceTypeSchema = z.enum([...resourceTypeSchema.options, "data_field"]);
export const positiveIdSchema = z.number().int().positive().safe();
export const distinctIdsSchema = z.array(positiveIdSchema).min(1).max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate IDs are refused; no input is silently dropped.");
export const targetTypeSchema = z.enum(["user", "team", "organization"]);
export type CopyableResource = keyof typeof COPYABLE_RESOURCES;
export type SharedResource = keyof typeof SHARABLE_RESOURCES;
export type TargetType = z.infer<typeof targetTypeSchema>;
export const SHARING_TARGETS = { user: "User", team: "Team", organization: "Organization" } as const;

export type SharingRule = {
  sharing_type_to: "User" | "Team" | "Organization" | "ResellerCustomers";
  read_permission: boolean;
  write_permission: boolean;
  delete_permission: boolean;
  ids_list: number[];
  name: string;
};
const sharingRuleSchema = z.object({
  sharing_type_to: z.enum(["User", "Team", "Organization", "ResellerCustomers"]),
  read_permission: z.boolean(), write_permission: z.boolean(), delete_permission: z.boolean(),
  ids_list: z.array(positiveIdSchema).max(10_000), name: z.string().max(200),
});

/** Convert the full owner-visible ACL to the documented write shape, or refuse. */
export function readSharingRules(profile: Record<string, unknown>): SharingRule[] {
  if (profile.permission && typeof profile.permission === "object" &&
      (profile.permission as { is_admin?: unknown }).is_admin === false) {
    throw new Error("Only an owner/administrator may change this resource's sharing.");
  }
  if (!Array.isArray(profile.sharing)) {
    throw new Error("The full sharing configuration is not visible. Refusing to replace it or erase unknown access rights.");
  }
  return profile.sharing.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid existing sharing rule; nothing was modified.");
    const raw = item as Record<string, unknown>;
    const types: Record<string, SharingRule["sharing_type_to"]> = { user: "User", team: "Team", organization: "Organization", resellercustomers: "ResellerCustomers" };
    // Some API responses expose target objects rather than ids_list.
    const ids = raw.ids_list ?? (Array.isArray(raw.sharing_targets)
      ? raw.sharing_targets.map((target: unknown) => target && typeof target === "object" ? (target as { id?: unknown }).id : undefined) : undefined);
    const parsed = sharingRuleSchema.safeParse({ ...raw, sharing_type_to: typeof raw.sharing_type_to === "string" ? types[raw.sharing_type_to.toLowerCase()] : undefined, ids_list: ids });
    if (!parsed.success) throw new Error("Cannot safely round-trip the existing sharing rules; nothing was modified.");
    return parsed.data;
  });
}

/** Change only the explicitly selected destinations; preserve other grants. */
export function mergeSharingRules(
  existing: readonly SharingRule[],
  change: { action: "grant" | "revoke"; target_type: TargetType; target_ids: number[]; name: string; allow_write: boolean; allow_delete: boolean },
): SharingRule[] {
  const type = SHARING_TARGETS[change.target_type];
  const selected = new Set(change.target_ids);
  if (change.action === "grant" && change.target_ids.every((id) => {
    const current = existing.filter((rule) => rule.sharing_type_to === type && rule.ids_list.includes(id));
    return current.some((rule) => rule.read_permission) &&
      (!change.allow_write || current.some((rule) => rule.write_permission)) &&
      (!change.allow_delete || current.some((rule) => rule.delete_permission));
  })) return existing.map((rule) => ({ ...rule, ids_list: [...rule.ids_list] }));
  const effective = new Map<number, { write: boolean; remove: boolean }>();
  for (const id of change.target_ids) effective.set(id, { write: change.allow_write, remove: change.allow_delete });
  const kept: SharingRule[] = [];
  for (const rule of existing) {
    if (rule.sharing_type_to !== type || !rule.ids_list.some((id) => selected.has(id))) {
      kept.push({ ...rule, ids_list: [...rule.ids_list] });
      continue;
    }
    for (const id of rule.ids_list) {
      const rights = effective.get(id);
      if (rights) {
        rights.write ||= rule.write_permission;
        rights.remove ||= rule.delete_permission;
      }
    }
    const remaining = rule.ids_list.filter((id) => !selected.has(id));
    if (remaining.length) kept.push({ ...rule, ids_list: remaining });
  }
  if (change.action === "grant") {
    // Group destinations with identical effective rights; adding read-only access
    // must never downgrade a destination which already had write/delete rights.
    const groups = new Map<string, SharingRule>();
    for (const id of change.target_ids) {
      const rights = effective.get(id)!;
      const key = `${rights.write}:${rights.remove}`;
      const group = groups.get(key) ?? {
        sharing_type_to: type, read_permission: true, write_permission: rights.write,
        delete_permission: rights.remove, ids_list: [], name: change.name,
      };
      group.ids_list.push(id);
      groups.set(key, group);
    }
    kept.push(...groups.values());
  }
  if (kept.length > 1_000) throw new Error("Too many sharing rules; nothing was modified.");
  return kept;
}

/** Not an authorization token: detects accidental stale/changed preview inputs. */
export function selectionFingerprint(value: {
  account_id: number; filter: unknown; target: string; total: number; matched: number;
}): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function checkedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("The API did not return a reliable selection count. Refusing an unverified copy.");
  }
  return value;
}
