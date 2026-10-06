/** Shared by initialization and write-tool descriptions: clients may use either. */
export const CREATION_GUIDANCE =
  "For a user-requested creation, duplicate names/resources are acceptable for all resource types " +
  "unless the user explicitly requests uniqueness, deduplication or reuse. Do not list/search existing " +
  "resources solely to check for duplicates before creating, and do not block creation on a failed or " +
  "truncated listing. Keep reads needed for permissions, field resolution or an existing target ID. " +
  "Respect API uniqueness constraints and write confirmation. Execute each confirmed creation once; " +
  "do not automatically retry an uncertain write. If the user explicitly requests another creation " +
  "after an uncertain result, make one newly authorized attempt without a mandatory duplicate check. " +
  "Duplicate tolerance does not authorize extra sends, payments, overwrites or permission changes.";
