/** Repeated in initialization and tool descriptions: hosts may read either. */
export const USER_FACING_GUIDANCE =
  "Use neutral, reseller-compatible wording in user-facing replies. Refer to 'your account', " +
  "'the platform' and 'the platform administrator'. Use a service/reseller brand only when explicitly " +
  "identified by the user or the connected client's context. Never infer or introduce the underlying " +
  "API vendor's brand from technical server names, tool identifiers, API URLs or errors, and never " +
  "combine vendor and reseller brands. This wording rule does not alter actual account/contact data " +
  "or a user's explicit request to discuss a named service.";

export const CREATION_GUIDANCE =
  "For a user-requested creation, duplicate names/resources are acceptable for all resource types " +
  "unless the user explicitly requests uniqueness, deduplication or reuse. Do not list/search existing " +
  "resources solely to check for duplicates before creating, and do not block creation on a failed or " +
  "truncated listing. Keep reads needed for permissions, field resolution or an existing target ID. " +
  "Respect API uniqueness constraints and write confirmation. Execute each confirmed creation once; " +
  "do not automatically retry an uncertain write. If the user explicitly requests another creation " +
  "after an uncertain result, make one newly authorized attempt without a mandatory duplicate check. " +
  "Duplicate tolerance does not authorize extra sends, payments, overwrites or permission changes.";
export const ACCOUNT_SWITCHING_GUIDANCE =
  "Account switching is available on this OAuth connection. Use get_active_account to identify the active account at the start of work; announce its first name, last name and ID when switched. " +
  "Every tool result includes account_context with original and active identities and revision. This selection is shared by all chats using the same OAuth connection and MCP domain. " +
  "Before a confirmed write, use the account_revision from a current preview or get_active_account and confirm the intended account. " +
  "Use list_switchable_accounts to discover authorized targets, switch_account to change account and return_to_original_account to restore it. " +
  "The account list requires mcp:read; get_active_account also works with mcp:write alone, so do not block a known authorized selection or return merely because listing is unavailable. " +
  "Use only accounts returned by the authorized list when proposing a new target. Pagination cursors are opaque internal values: preserve the search when following them and never quote cursors in user-facing replies or diagnostics. " +
  "If the list is empty or contains only the current account, say no other authorized target was returned. " +
  "This alone does not prove a missing delegation: domain-specific access rules or backend configuration may also limit the list. " +
  "If help is needed, suggest asking the platform administrator to check access on the connected domain; do not promise a delegation grant will necessarily make more accounts appear. " +
  "Delegation lasts 60 minutes after each successful selection, including reselecting the same account. On delegation_expired explain the expiry and offer an explicitly confirmed reselection or return; never renew it automatically. " +
  "Switching requires explicit user authorization and confirm:true. Never switch or fall back automatically after an error. " +
  "If account_context.selection_status is unknown_after_change, the change may have committed: call get_active_account to resolve it, without repeating the switch automatically. " +
  "A switched_account_unauthorized error does not invalidate the original OAuth connection; report the failure instead of asking that account to reconnect. " +
  "Never automatically retry an uncertain write. The host cannot guarantee an account indicator on replies that make no tool call.";
