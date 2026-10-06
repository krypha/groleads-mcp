# OAuth server operations

The authorization server is registered only when `OAUTH_ENABLED=true`. Application startup validates the flag, the explicit trusted-proxy allowlist and the configured Redis store without performing network, SQL or cryptographic work. The deployment gate described below validates every URL, resource, encryption key, RSA signing key, Redis operation, OAuth table and internal client before traffic is enabled.

`OAUTH_ISSUER` must be an HTTPS origin without a path. `OAUTH_MCP_RESOURCE` identifies the MCP server. `OAUTH_API_RESOURCE` identifies this API and must be different. MCP Bearer tokens are never accepted by API routes: the MCP server exchanges them for five-minute API tokens using RFC 8693.

## Internal MCP client

Create the confidential Token Exchange client after the schema is installed:

```shell
./manager cli artisan oauth:create-internal-client "Magileads MCP"
```

The client secret is printed once and must be put in the MCP server's secret store. Rotate it with `oauth:rotate-internal-client-secret {client_id}`; rotation revokes every upstream API token issued to that internal client. `oauth:revoke-internal-client {client_id}` permanently revokes the client. DCR and CIMD clients cannot request the Token Exchange grant.

The hourly `oauth:cleanup` command is registered in the scheduler. Its cross-instance lock and all OAuth rate limits use `OAUTH_SHARED_CACHE_STORE`, which must name a Redis-backed Laravel cache store outside tests.

The authorization-code, refresh-token and Token Exchange grants run through `league/oauth2-server`. The only client-authentication path outside that grant pipeline is `/oauth/revoke`, because League 9.4.1 does not implement the RFC 7009 revocation endpoint; it uses the same client repository and secret verification rules.

## Signing-key rotation

1. Configure `OAUTH_SIGNING_KEY_ID_NEXT`, `OAUTH_PRIVATE_KEY_PATH_NEXT` and `OAUTH_PUBLIC_KEY_PATH_NEXT` while keeping `OAUTH_SIGNING_ACTIVE_KID` on the primary key.
2. Deploy and wait at least five minutes so clients can refresh the JWKS document.
3. Set `OAUTH_SIGNING_ACTIVE_KID` to the next key identifier and deploy again.
4. Keep the previous public key in the ring for at least 31 minutes after the switch.
5. Promote the next key to the primary variables and remove the retired key in a later deployment.

## Beta deployment gates

The OAuth migration has not been deployed yet, so beta must run the final migration directly; there is no corrective `ALTER TABLE` migration.

Before setting `OAUTH_ENABLED=true`:

1. Configure `TRUSTED_PROXIES` as an explicit comma-separated IP/CIDR allowlist. Wildcards and an empty list are rejected. Select only `x-forwarded`, `forwarded`, or `aws-elb` in `TRUSTED_PROXY_HEADERS`.
2. Restrict the API origin at the network layer so only those proxies can connect. Forwarding headers are not an origin-access control.
3. Mask or remove query strings for `/oauth/authorize` in proxy and observability access logs. `state`, PKCE values, authorization codes, Bearer tokens, refresh tokens and client secrets must never be recorded.
4. Configure and verify the shared Redis store, both resource URLs, the frontend authorization URL, the encryption key and the RSA keyring.
5. Create the internal MCP client and configure its one-time secret in the MCP deployment.
6. Run `./manager cli artisan oauth:check-readiness`. Deployment must stop unless it validates the full keyring, Redis read/write and locking, every OAuth table, the trusted-proxy configuration and an operational internal Token Exchange client.

`OAUTH_ENABLED=false` removes the OAuth routes and is the emergency cutoff.

## MCP integration contract

The MCP server validates the incoming token against the OAuth JWKS and `OAUTH_MCP_RESOURCE`, then authenticates as its internal client at `/oauth/token` with the Token Exchange grant. It sends only the returned `OAUTH_API_RESOURCE` token to an API route explicitly marked with `mcp.oauth.scope:read` or `mcp.oauth.scope:write`. The original MCP token must never be forwarded to this API.

Public MCP clients may use an HTTPS Client ID Metadata Document. The document is fetched without redirects or an outbound proxy, is limited to 5 KiB, and may only describe a public authorization-code client using PKCE. DCR remains available for clients that do not support CIMD.

CIMD documents may advertise additional grant types, as Claude does with `jwt-bearer`. Only `authorization_code` and `refresh_token` are retained; unsupported grants are ignored and cannot be used at the token endpoint. `authorization_code` remains mandatory, and empty grant lists, duplicate entries, empty strings and invalid value types are rejected. Only retained grants contribute to the persisted client's security fingerprint. DCR continues to reject unsupported grants.


## MCP business endpoint scopes

The table below is the explicit API allowlist for the prospecting and campaign MCP catalogue: 249 method/path pairs, including registered pagination and lookup variants. It covers the 231 operations selected from the supplied MCP inventory, 16 additional registered variants, and the two existing account/integration operations. Parameter names may be normalized, but methods and path segments must match an actual row. HEAD follows Laravel's registered GET route; no DELETE or PATCH endpoint is opened.

`mcp:write` does not imply `mcp:read`. Search, statistics, synchronous exports and URL construction use read even when their method is POST. Personalized model retrieval uses write because a cache miss can generate AI content; explicit regeneration always uses write. HTML import uses write because it stores imported images. Queued previews, extraction, enrichment, sending and campaign execution use write, including operations that consume credits. The existing Google Maps URL-generation read scope is preserved even though it calls an AI provider; it does not start extraction.

The route scope authorizes an API-upstream OAuth token, not access to every resource. Controllers still initialize their business models with the authenticated user. The existing model entry points listed in the table enforce ownership, resource sharing, account permissions and quotas. Search cursors remain bound to the caller and target. PRM reads never clear new-reply flags for OAuth MCP callers.

Business permission controls remain unchanged:

- Message models: `ModelModel::verifyModelPermission`, user-scoped lists, creation/generation permissions and sending limits. Copies to another user also require the existing administrative level and destination access.
- Lists and contacts: `ContactLists::verifyContactListPermission`, contact/list membership, selection permissions and import/export/enrichment permissions. Destination lists, blacklists, custom fields and external keys retain their own checks.
- PRM: `verifyPrmPermission`, `verifyContactPermission`, filtered sharing conditions, user-scoped nurturing/status/notification resources and destination permissions. Multiple-user searches retain administrative checks.
- Workflows: `verifyWorkflowPermission`, `verifyWorkflowProgrammationPermission`, user-scoped AI jobs, source/destination permissions and existing send/programming guards.
- Targeting and enrichment: account feature permissions, source list and integration ownership, batch owner, external-key permissions and credit/quota checks.
- Statistics: queries and exports remain scoped to the authenticated user's accessible campaigns and contacts. Data fields retain their visibility and write permissions.

### Message models

| Method | Path | Scope | Business entry point |
| --- | --- | --- | --- |
| GET | `/models/email` | `mcp:read` | `ModelsEmail::fetchList` |
| POST | `/models/email` | `mcp:write` | `ModelsEmail::create` |
| POST | `/models/email/generate` | `mcp:write` | `ModelsEmail::generate` |
| POST | `/models/email/generate/html` | `mcp:write` | `ModelsEmail::generateHTML` |
| POST | `/models/email/get/html/from/url` | `mcp:write` | `ModelsEmail::getHtmlFromUrl` |
| POST | `/models/email/send/test` | `mcp:write` | `ModelsEmail::sendTestWithoutModel` |
| GET | `/models/email/{model_id}` | `mcp:read` | `ModelsEmail::findProfileById` |
| PUT | `/models/email/{model_id}` | `mcp:write` | `ModelsEmail::updateProfileById` |
| POST | `/models/email/{model_id}/copy` | `mcp:write` | `ModelsEmail::copy` |
| POST | `/models/email/{model_id}/copy/to/{user_id}` | `mcp:write` | `ModelsEmail::copyTo` |
| POST | `/models/email/{model_id}/regenerate` | `mcp:write` | `ModelsEmail::regenerate` |
| POST | `/models/email/{model_id}/send/test` | `mcp:write` | `ModelsEmail::sendTest` |
| GET | `/models/email/{model_id}/{contact_id}` | `mcp:write` | `ModelsEmail::findProfileById` |
| GET | `/models/email/{model_id}/{contact_id}/regenerate` | `mcp:write` | `ModelsEmail::findProfileById` |
| GET | `/models/linkedin/invitation` | `mcp:read` | `ModelsLinkedinInvitation::fetchList` |
| POST | `/models/linkedin/invitation` | `mcp:write` | `ModelsLinkedinInvitation::create` |
| POST | `/models/linkedin/invitation/generate/content` | `mcp:write` | `ModelsLinkedinInvitation::generateContent` |
| GET | `/models/linkedin/invitation/{model_id}` | `mcp:read` | `ModelsLinkedinInvitation::findProfileById` |
| PUT | `/models/linkedin/invitation/{model_id}` | `mcp:write` | `ModelsLinkedinInvitation::updateProfileById` |
| POST | `/models/linkedin/invitation/{model_id}/copy` | `mcp:write` | `ModelsLinkedinInvitation::copy` |
| POST | `/models/linkedin/invitation/{model_id}/copy/to/{user_id}` | `mcp:write` | `ModelsLinkedinInvitation::copyTo` |
| GET | `/models/linkedin/invitation/{model_id}/{contact_id}` | `mcp:write` | `ModelsLinkedinInvitation::findProfileById` |
| GET | `/models/linkedin/invitation/{model_id}/{contact_id}/regenerate` | `mcp:write` | `ModelsLinkedinInvitation::findProfileById` |
| GET | `/models/linkedin/message` | `mcp:read` | `ModelsLinkedinMessage::fetchList` |
| POST | `/models/linkedin/message` | `mcp:write` | `ModelsLinkedinMessage::create` |
| POST | `/models/linkedin/message/generate/content` | `mcp:write` | `ModelsLinkedinMessage::generateContent` |
| GET | `/models/linkedin/message/{model_id}` | `mcp:read` | `ModelsLinkedinMessage::findProfileById` |
| PUT | `/models/linkedin/message/{model_id}` | `mcp:write` | `ModelsLinkedinMessage::updateProfileById` |
| POST | `/models/linkedin/message/{model_id}/copy` | `mcp:write` | `ModelsLinkedinMessage::copy` |
| POST | `/models/linkedin/message/{model_id}/copy/to/{user_id}` | `mcp:write` | `ModelsLinkedinMessage::copyTo` |
| GET | `/models/linkedin/message/{model_id}/{contact_id}` | `mcp:write` | `ModelsLinkedinMessage::findProfileById` |
| GET | `/models/linkedin/message/{model_id}/{contact_id}/regenerate` | `mcp:write` | `ModelsLinkedinMessage::findProfileById` |
| GET | `/models/sms` | `mcp:read` | `ModelsSms::fetchList` |
| POST | `/models/sms` | `mcp:write` | `ModelsSms::create` |
| GET | `/models/sms/{model_id}` | `mcp:read` | `ModelsSms::findProfileById` |
| PUT | `/models/sms/{model_id}` | `mcp:write` | `ModelsSms::updateProfileById` |
| POST | `/models/sms/{model_id}/copy` | `mcp:write` | `ModelsSms::copy` |
| POST | `/models/sms/{model_id}/copy/to/{user_id}` | `mcp:write` | `ModelsSms::copyTo` |
| GET | `/models/smv` | `mcp:read` | `ModelsSmv::fetchList` |
| POST | `/models/smv` | `mcp:write` | `ModelsSmv::create` |
| GET | `/models/smv/{model_id}` | `mcp:read` | `ModelsSmv::findProfileById` |
| POST | `/models/smv/{model_id}` | `mcp:write` | `ModelsSmv::updateProfileById` |
| POST | `/models/smv/{model_id}/copy` | `mcp:write` | `ModelsSmv::copy` |
| POST | `/models/smv/{model_id}/copy/to/{user_id}` | `mcp:write` | `ModelsSmv::copyTo` |

### Lists, contacts and data fields

| Method | Path | Scope | Business entry point |
| --- | --- | --- | --- |
| GET | `/contact-lists` | `mcp:read` | `ContactLists::fetchList` |
| POST | `/contact-lists` | `mcp:write` | `ContactLists::create` |
| GET | `/contact-lists-paginated` | `mcp:read` | `ContactLists::fetchListPaginated` |
| GET | `/contact-lists-paginated/page/{page}` | `mcp:read` | `ContactLists::fetchListPaginated` |
| POST | `/contact-lists/contacts/copy/prm` | `mcp:write` | `ContactLists::copyContactsToMyPrm` |
| POST | `/contact-lists/contacts/copy/to/{contact_list_id_destination}` | `mcp:write` | `ContactLists::copyContactsTo` |
| POST | `/contact-lists/contacts/copy/{contact_list_id_destination}` | `mcp:write` | `ContactLists::copyFromAll` |
| POST | `/contact-lists/contacts/search` | `mcp:read` | `ContactLists::searchContactsInAll` |
| GET | `/contact-lists/contacts/search/{search_id}/page/{page}` | `mcp:read` | `ContactLists::searchContactsInAll` |
| POST | `/contact-lists/download/{file_type}` | `mcp:read` | `ContactLists::downloadFromAll` |
| POST | `/contact-lists/merge` | `mcp:write` | `ContactLists::merge` |
| GET | `/contact-lists/names` | `mcp:read` | `ContactLists::fetchNames` |
| GET | `/contact-lists/{contact_list_id}` | `mcp:read` | `ContactLists::findProfileById` |
| PUT | `/contact-lists/{contact_list_id}` | `mcp:write` | `ContactLists::updateProfileById` |
| POST | `/contact-lists/{contact_list_id}/contact` | `mcp:write` | `ContactLists::importContact`, `ContactLists::markCoefficyAfterManualImport` |
| GET | `/contact-lists/{contact_list_id}/contacts` | `mcp:read` | `ContactLists::fetchContacts` |
| POST | `/contact-lists/{contact_list_id}/contacts` | `mcp:write` | `ContactLists::importContacts` |
| POST | `/contact-lists/{contact_list_id}/contacts/search` | `mcp:read` | `ContactLists::searchContacts` |
| GET | `/contact-lists/{contact_list_id}/contacts/search/{search_id}/page/{page}` | `mcp:read` | `ContactLists::searchContacts` |
| GET | `/contact-lists/{contact_list_id}/contacts/{contact_id}` | `mcp:read` | `ContactLists::findContactProfileById` |
| PUT | `/contact-lists/{contact_list_id}/contacts/{contact_id}` | `mcp:write` | `ContactLists::updateContactById` |
| POST | `/contact-lists/{contact_list_id}/contacts/{contact_id}/enrich/phone/mobile` | `mcp:write` | `ContactLists::enrichMobilePhone` |
| GET | `/contact-lists/{contact_list_id}/contacts/{search_id}/page/{page}` | `mcp:read` | `ContactLists::fetchContacts` |
| POST | `/contact-lists/{contact_list_id}/convert/linkedin/links` | `mcp:write` | `ContactLists::convertLinkedinLinks` |
| POST | `/contact-lists/{contact_list_id}/copy` | `mcp:write` | `ContactLists::copy` |
| POST | `/contact-lists/{contact_list_id}/copy/blacklist/{blacklist_id}` | `mcp:write` | `ContactLists::copyToBacklist` |
| POST | `/contact-lists/{contact_list_id}/copy/prm` | `mcp:write` | `ContactLists::copyContactListToMyPrm` |
| POST | `/contact-lists/{contact_list_id}/copy/to/{user_id}` | `mcp:write` | `ContactLists::copyTo` |
| POST | `/contact-lists/{contact_list_id}/copy/unsubscribers` | `mcp:write` | `ContactLists::copyToUnsubscribers` |
| POST | `/contact-lists/{contact_list_id}/datafield-ai/{datafield_id}` | `mcp:write` | `ContactLists::datafieldAi` |
| POST | `/contact-lists/{contact_list_id}/datafield-enrich/{datafield_id}` | `mcp:write` | `ContactLists::datafieldEnrich` |
| PUT | `/contact-lists/{contact_list_id}/datafields/{datafield_id}/bulk-set` | `mcp:write` | `ContactLists::bulkSetDatafield` |
| GET | `/contact-lists/{contact_list_id}/datafields/{datafield_id}/values` | `mcp:read` | `ContactLists::getUniqueDatafieldValues` |
| GET | `/contact-lists/{contact_list_id}/download/{file_type}` | `mcp:read` | `ContactLists::download` |
| POST | `/contact-lists/{contact_list_id}/download/{file_type}` | `mcp:read` | `ContactLists::download` |
| POST | `/contact-lists/{contact_list_id}/email-verifier` | `mcp:write` | `ContactLists::emailVerifier` |
| POST | `/contact-lists/{contact_list_id}/enrich` | `mcp:write` | `ContactLists::enrich` |
| POST | `/contact-lists/{contact_list_id}/enrich/external/{enrich_external_api}/{external_api_key_id}` | `mcp:write` | `ContactLists::enrichExternalApi` |
| POST | `/contact-lists/{contact_list_id}/enrich/linkedin` | `mcp:write` | `ContactLists::enrichLinkedinData` |
| POST | `/contact-lists/{contact_list_id}/enrich/linkedin/url` | `mcp:write` | `ContactLists::enrichLinkedinUrl` |
| POST | `/contact-lists/{contact_list_id}/enrich/phone/mobile` | `mcp:write` | `ContactLists::enrichMobilePhoneSelection` |
| POST | `/contact-lists/{contact_list_id}/icebreaker` | `mcp:write` | `ContactLists::iceBreaker` |
| POST | `/contact-lists/{contact_list_id}/split` | `mcp:write` | `ContactLists::split` |
| POST | `/contact-lists/{contact_list_id}/translate` | `mcp:write` | `ContactLists::translate` |
| POST | `/contacts/enrich/email` | `mcp:write` | `ContactLists::enrichEmailByCompany` |
| POST | `/contacts/enrich/phone/mobile` | `mcp:write` | `ContactLists::enrichMobilePhoneByLinkedinUrl` |
| GET | `/data-fields` | `mcp:read` | `DataFields::fetchList` |
| POST | `/data-fields` | `mcp:write` | `DataFields::create` |
| GET | `/data-fields/{data_field_id}` | `mcp:read` | `DataFields::findProfileById` |
| PUT | `/data-fields/{data_field_id}` | `mcp:write` | `DataFields::updateProfileById` |

### PRM and campaigns

| Method | Path | Scope | Business entry point |
| --- | --- | --- | --- |
| GET | `/prm/contact` | `mcp:read` | `PRM::findContactProfileByEmailOrLinkedinUrl` |
| GET | `/prm/contact/user/{user_id}` | `mcp:read` | `PRM::findContactProfileByEmailOrLinkedinUrl` |
| GET | `/prm/contact/{contact_id}` | `mcp:read` | `PRM::findContactProfileById` |
| PUT | `/prm/contact/{contact_id}` | `mcp:write` | `PRM::verifyContactPermission`, `DataFields::fetchList`, `PRM::findContactProfileById`, `DataFields::validateAndCorrectValue`, `PRM::updateContact` |
| POST | `/prm/contact/{contact_id}/call` | `mcp:write` | `PRM::createContactCall` |
| POST | `/prm/contact/{contact_id}/enrich/phone/mobile` | `mcp:write` | `PRM::enrichMobilePhone` |
| POST | `/prm/contact/{contact_id}/exclude/programmation/{programmation_id}` | `mcp:write` | `PRM::excludeContactFromWorkflowProgrammation` |
| POST | `/prm/contact/{contact_id}/exclude/{workflow_id}` | `mcp:write` | `PRM::excludeContactFromWorkflow` |
| POST | `/prm/contact/{contact_id}/linkedin/invitation` | `mcp:write` | `PRM::sendLinkedinInvitation` |
| POST | `/prm/contact/{contact_id}/linkedin/message` | `mcp:write` | `PRM::sendLinkedinMessage` |
| POST | `/prm/contact/{contact_id}/note` | `mcp:write` | `PRM::createContactNote` |
| PUT | `/prm/contact/{contact_id}/note/{note_id}` | `mcp:write` | `PRM::updateContactNote` |
| POST | `/prm/contact/{contact_id}/note/{note_id}/attachment` | `mcp:write` | `PRM::uploadNoteAttachments` |
| GET | `/prm/contact/{contact_id}/note/{note_id}/attachments` | `mcp:read` | `PRM::listNoteAttachments` |
| POST | `/prm/contact/{contact_id}/programmation/{programmation_id}/step/{step_id}` | `mcp:write` | `PRM::continueContactToStep` |
| PUT | `/prm/contact/{contact_id}/reply/{history_type_reply}/{reply_id}` | `mcp:write` | `PRM::setReplyPositive` |
| POST | `/prm/contact/{contact_id}/reply/{history_type_reply}/{reply_id}/suggest-reply` | `mcp:write` | `PRM::suggestReply` |
| GET | `/prm/contacts` | `mcp:read` | `PRM::fetchContacts` |
| POST | `/prm/contacts` | `mcp:write` | `DataFields::fetchList`, `DataFields::validateAndCorrectValue`, `PRM::verifyCustomStatusPermission`, `PRM::importContact` |
| POST | `/prm/contacts/contact-list/{contact_list_id}/add` | `mcp:write` | `PRM::addContactsToContactlist` |
| POST | `/prm/contacts/enrich/external/{enrich_external_api}/{external_api_key_id}` | `mcp:write` | `PRM::enrichExternalApi` |
| POST | `/prm/contacts/export/{file_type}` | `mcp:read` | `PRM::exportContacts` |
| POST | `/prm/contacts/import` | `mcp:write` | `PRM::verifyPrmPermission` |
| PUT | `/prm/contacts/new_reply` | `mcp:write` | `PRM::updateContactNewReplyContactsSelection` |
| GET | `/prm/contacts/shared` | `mcp:read` | `PRM::fetchSharedContacts` |
| GET | `/prm/contacts/shared/{search_id}/page/{page}` | `mcp:read` | `PRM::fetchSharedContacts` |
| PUT | `/prm/contacts/status` | `mcp:write` | `PRM::updateContactStatusContactsSelection` |
| GET | `/prm/contacts/user/{user_id}` | `mcp:read` | `PRM::fetchContacts` |
| POST | `/prm/contacts/user/{user_id}` | `mcp:write` | `DataFields::fetchList`, `DataFields::validateAndCorrectValue`, `PRM::verifyCustomStatusPermission`, `PRM::importContact` |
| POST | `/prm/contacts/user/{user_id}/copy/blacklist/{blacklist_id}` | `mcp:write` | `PRM::copyToBlacklist` |
| POST | `/prm/contacts/user/{user_id}/enrich/external/{enrich_external_api}/{external_api_key_id}` | `mcp:write` | `PRM::enrichExternalApi` |
| POST | `/prm/contacts/user/{user_id}/export/{file_type}` | `mcp:read` | `PRM::exportContacts` |
| POST | `/prm/contacts/user/{user_id}/tags` | `mcp:write` | `PRM::addTagsToContacts` |
| GET | `/prm/contacts/user/{user_id}/{search_id}/page/{page}` | `mcp:read` | `PRM::fetchContacts` |
| GET | `/prm/contacts/users` | `mcp:read` | `PRM::fetchContactsFromMultipleUsers` |
| GET | `/prm/contacts/users/{search_id}/page/{page}` | `mcp:read` | `PRM::fetchContactsFromMultipleUsers` |
| GET | `/prm/contacts/{search_id}/page/{page}` | `mcp:read` | `PRM::fetchContacts` |
| GET | `/prm/list` | `mcp:read` | `PRM::listVisiblePRM` |
| GET | `/prm/notifications/column-entry` | `mcp:read` | `PRM::getColumnEntryNotificationWatchlist` |
| PUT | `/prm/notifications/column-entry` | `mcp:write` | `PRM::replaceColumnEntryNotificationWatchlist` |
| POST | `/prm/nurturing` | `mcp:write` | `PRM::createNurturing` |
| GET | `/prm/nurturing/{nurturing_id}` | `mcp:read` | `PRM::getNurturing` |
| PUT | `/prm/nurturing/{nurturing_id}` | `mcp:write` | `PRM::updateNurturing` |
| GET | `/prm/nurturings` | `mcp:read` | `PRM::getNurturings` |
| GET | `/prm/sharings` | `mcp:read` | `PRM::getSharings` |
| POST | `/prm/sharings` | `mcp:write` | `PRM::createSharing` |
| PUT | `/prm/sharings/{sharing_id}` | `mcp:write` | `PRM::updateSharing` |
| GET | `/prm/status` | `mcp:read` | `PRM::getStatuses` |
| GET | `/prm/status/custom` | `mcp:read` | `PRM::getCustomStatuses` |
| POST | `/prm/status/custom` | `mcp:write` | `PRM::createCustomStatus` |
| PUT | `/prm/status/custom/{status_id}` | `mcp:write` | `PRM::getCustomStatus`, `PRM::updateCustomStatus` |
| PUT | `/prm/status/{status}` | `mcp:write` | `PRM::getStatuses`, `PRM::updateStatus` |
| GET | `/workflows` | `mcp:read` | `Workflows::fetchList` |
| POST | `/workflows` | `mcp:write` | `Workflows::create` |
| POST | `/workflows/ai-agent` | `mcp:write` | `WorkflowAiAgentGenerationJobs::create` |
| GET | `/workflows/ai-agent/jobs` | `mcp:read` | `WorkflowAiAgentGenerationJobs::fetchList` |
| GET | `/workflows/ai-agent/jobs/{job_uniqid}` | `mcp:read` | `WorkflowAiAgentGenerationJobs::findStatus` |
| POST | `/workflows/ai-agent/jobs/{job_uniqid}/contact-preview` | `mcp:write` | `WorkflowAiAgentContactPreviewJobs::create` |
| GET | `/workflows/exclude/programmation/{programmation_id}` | `mcp:read` | `Workflows::fetchExcludeContactFromWorkflowProgrammation` |
| GET | `/workflows/programmations` | `mcp:read` | `Workflows::findProgrammations` |
| GET | `/workflows/programmations/contacts` | `mcp:read` | `Workflows::getProgrammationContacts` |
| GET | `/workflows/programmations/contacts/{search_id}/page/{page}` | `mcp:read` | `Workflows::getProgrammationContacts` |
| GET | `/workflows/programmations/{search_id}/page/{page}` | `mcp:read` | `Workflows::findProgrammations` |
| GET | `/workflows/reply/email/{reply_id}/download/eml` | `mcp:read` | `Workflows::downloadEmailReplyEml` |
| POST | `/workflows/send/email` | `mcp:write` | `Workflows::sendEmail` |
| POST | `/workflows/send/email-with-attachments` | `mcp:write` | `Workflows::sendEmail` |
| GET | `/workflows/sent/email/{id}/download/eml` | `mcp:read` | `Workflows::downloadEmailManuallySentEml` |
| GET | `/workflows/{workflow_id}` | `mcp:read` | `Workflows::findProfileById` |
| PUT | `/workflows/{workflow_id}` | `mcp:write` | `Workflows::findProfileById`, `Workflows::updateProfileById` |
| POST | `/workflows/{workflow_id}/copy` | `mcp:write` | `Workflows::copy` |
| POST | `/workflows/{workflow_id}/copy/to/{user_id}` | `mcp:write` | `Workflows::copyTo` |
| POST | `/workflows/{workflow_id}/image` | `mcp:write` | `Workflows::uploadImage` |
| POST | `/workflows/{workflow_id}/program` | `mcp:write` | `Workflows::program` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}` | `mcp:read` | `Workflows::findProgrammationById` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}` | `mcp:write` | `Workflows::updateProgrammationProfileById` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/archive` | `mcp:write` | `Workflows::archiveProgrammationById` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/resume` | `mcp:write` | `Workflows::resumeProgrammationById` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/click/link/{link_url}` | `mcp:read` | `Workflows::getProgrammationContactsClickersByWorkflowAndStepAndLink` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/click/link_search/{search_id}/page/{page}` | `mcp:read` | `Workflows::getProgrammationContactsClickersByWorkflowAndStepAndLink` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/resume` | `mcp:write` | `Workflows::resumeProgrammationStepById` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/stop` | `mcp:write` | `Workflows::stopProgrammationStepById` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/{contact_type}` | `mcp:read` | `Workflows::getProgrammationContactsByWorkflowAndStepAndType` |
| POST | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/{contact_type}/blacklist/{blacklist_id}` | `mcp:write` | `Workflows::programmationBlacklistContactsByWorkflowAndStepAndType` |
| POST | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/{contact_type}/copy-to/{contact_list_id_destination}` | `mcp:write` | `Workflows::copyProgrammationContactsByWorkflowAndStepAndTypeToContactList` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/{contact_type}/search/{search_id}/page/{page}` | `mcp:read` | `Workflows::getProgrammationContactsByWorkflowAndStepAndType` |
| POST | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/step/{step_id}/{contact_type}/{file_type}` | `mcp:read` | `Workflows::downloadProgrammationContactsByWorkflowAndStepAndType` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/stop` | `mcp:write` | `Workflows::stopProgrammationById` |
| PUT | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/unarchive` | `mcp:write` | `Workflows::unarchiveProgrammationById` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/{contact_type}` | `mcp:read` | `Workflows::getProgrammationContactsByWorkflowAndType` |
| GET | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/{contact_type}/search/{search_id}/page/{page}` | `mcp:read` | `Workflows::getProgrammationContactsByWorkflowAndType` |
| POST | `/workflows/{workflow_id}/programmation/{workflow_programmation_id}/{contact_type}/{file_type}` | `mcp:read` | `Workflows::downloadProgrammationContactsByWorkflowAndType` |
| GET | `/workflows/{workflow_id}/programmations` | `mcp:read` | `Workflows::findProgrammationsByWorkflowId` |
| GET | `/workflows/{workflow_id}/programmations/page/{page}` | `mcp:read` | `Workflows::findProgrammationsByWorkflowId` |
| POST | `/workflows/{workflow_id}/readiness` | `mcp:read` | `Workflows::evaluateAiAgentReadiness` |

### Targeting, enrichment and statistics

| Method | Path | Scope | Business entry point |
| --- | --- | --- | --- |
| POST | `/enrich` | `mcp:write` | `EnrichBatch::createBatch` |
| POST | `/enrich/usage` | `mcp:read` | `EnrichBatch::getUsageStatistics` |
| GET | `/enrich/{batch_id}` | `mcp:read` | `EnrichBatch::getBatchContacts` |
| POST | `/statistics/date` | `mcp:read` | `Statistics::fetchDate` |
| POST | `/statistics/date/contacts` | `mcp:read` | `Statistics::downloadDateContacts` |
| POST | `/statistics/date/detailed` | `mcp:read` | `Statistics::fetchDateDetailed` |
| GET | `/statistics/global` | `mcp:read` | `Statistics::fetchGlobal` |
| POST | `/statistics/global/detailed` | `mcp:read` | `Statistics::fetchGlobalDetailed` |
| GET | `/statistics/integrations` | `mcp:read` | `Statistics::fetchIntegrations` |
| GET | `/statistics/messages` | `mcp:read` | `Statistics::fetchMessages` |
| GET | `/statistics/programmations` | `mcp:read` | `Statistics::fetchProgrammations` |
| GET | `/statistics/programmations/download/{file_type}` | `mcp:read` | `Statistics::downloadProgrammations` |
| GET | `/statistics/programmations/{programmation_id}` | `mcp:read` | `Statistics::fetchProgrammations` |
| GET | `/statistics/programmations/{programmation_id}/download/{file_type}` | `mcp:read` | `Statistics::downloadProgrammations` |
| POST | `/statistics/responders/by-channel-and-status` | `mcp:read` | `RespondersStats::byChannelAndStatus` |
| POST | `/statistics/responders/by-company-size` | `mcp:read` | `RespondersStats::byCompanySize` |
| POST | `/statistics/responders/by-company-size-and-status` | `mcp:read` | `RespondersStats::byCompanySizeAndStatus` |
| POST | `/statistics/responders/by-country` | `mcp:read` | `RespondersStats::byCountry` |
| POST | `/statistics/responders/by-prm-owner` | `mcp:read` | `RespondersStats::byPrmOwner` |
| POST | `/statistics/responders/by-programmation-and-list` | `mcp:read` | `RespondersStats::byProgrammationAndList` |
| POST | `/statistics/responders/by-region` | `mcp:read` | `RespondersStats::byRegion` |
| POST | `/statistics/responders/by-sector` | `mcp:read` | `RespondersStats::bySector` |
| POST | `/statistics/responders/by-sector-and-status` | `mcp:read` | `RespondersStats::bySectorAndStatus` |
| POST | `/statistics/responders/by-tag` | `mcp:read` | `RespondersStats::byTag` |
| POST | `/targeting/database/count` | `mcp:read` | `Targeting::databaseCount` |
| POST | `/targeting/database/count-preview` | `mcp:read` | `Targeting::databaseCountAndPreview` |
| POST | `/targeting/database/extract` | `mcp:write` | `Targeting::databaseExtract` |
| POST | `/targeting/database/locations/search` | `mcp:read` | `Targeting::searchDatabaseLocation` |
| POST | `/targeting/google/extract-maps-search` | `mcp:write` | `Targeting::addGoogleExtractMapsSearch` |
| POST | `/targeting/google/extract-maps-search/{contact_list_id}/relaunch` | `mcp:write` | `Targeting::relaunchGoogleExtractMapsSearch` |
| POST | `/targeting/google/extract-maps-search/{contact_list_id}/relaunch-errors` | `mcp:write` | `Targeting::relaunchGoogleExtractMapsSearchWithErrors` |
| POST | `/targeting/google/generate-maps-search-urls` | `mcp:read` | `Targeting::generateGoogleMapsSearchUrls` |
| POST | `/targeting/linkedin/extract-companies-search-sync` | `mcp:write` | `Targeting::addLinkedinExtractCompaniesSearchSync` |
| POST | `/targeting/linkedin/extract-company-viewers` | `mcp:write` | `Targeting::addLinkedinExtractCompanyViewers` |
| POST | `/targeting/linkedin/extract-connections` | `mcp:write` | `Targeting::addLinkedinExtractConnections` |
| POST | `/targeting/linkedin/extract-event-attendees` | `mcp:write` | `Targeting::addLinkedinExtractEventAttendees` |
| POST | `/targeting/linkedin/extract-group-members` | `mcp:write` | `Targeting::addLinkedinExtractGroupMembers` |
| POST | `/targeting/linkedin/extract-people-comment-activity` | `mcp:write` | `Targeting::addLinkedinExtractPeopleCommentActivity` |
| POST | `/targeting/linkedin/extract-people-post-activity` | `mcp:write` | `Targeting::addLinkedinExtractPeoplePostActivity` |
| POST | `/targeting/linkedin/extract-people-reaction-activity` | `mcp:write` | `Targeting::addLinkedinExtractPeopleReactionActivity` |
| POST | `/targeting/linkedin/extract-peoples-search` | `mcp:write` | `Targeting::addLinkedinExtractPeoplesSearch` |
| POST | `/targeting/linkedin/extract-peoples-search-alternative` | `mcp:write` | `Targeting::addLinkedinExtractPeoplesSearchAlternative` |
| POST | `/targeting/linkedin/extract-peoples-search-sync` | `mcp:write` | `Targeting::addLinkedinExtractPeoplesSearchSync` |
| POST | `/targeting/linkedin/extract-post-commenters` | `mcp:write` | `Targeting::addLinkedinExtractPostCommenters` |
| POST | `/targeting/linkedin/extract-post-likers` | `mcp:write` | `Targeting::addLinkedinExtractPostLikers` |
| POST | `/targeting/linkedin/extract-post-reposters` | `mcp:write` | `Targeting::addLinkedinExtractPostReposters` |
| POST | `/targeting/linkedin/extract-posts` | `mcp:write` | `Targeting::addLinkedinExtractSearchContent` |
| POST | `/targeting/linkedin/extract-posts-sync` | `mcp:write` | `Targeting::addLinkedinExtractSearchContentSync` |
| POST | `/targeting/linkedin/extract-profile-viewers` | `mcp:write` | `Targeting::addLinkedinExtractProfileViewers` |
| POST | `/targeting/linkedin/extract-publishers-job-offers` | `mcp:write` | `Targeting::addLinkedinExtractPublishersJobOffers` |
| POST | `/targeting/linkedin/extract-sales-navigator-companies-search` | `mcp:write` | `Targeting::addLinkedinExtractSalesNavigatorCompaniesSearch` |
| POST | `/targeting/linkedin/extract-sales-navigator-companies-search-alternative` | `mcp:write` | `Targeting::addLinkedinExtractSalesNavigatorCompaniesSearchAlternative` |
| POST | `/targeting/linkedin/extract-sales-navigator-peoples-search` | `mcp:write` | `Targeting::addLinkedinExtractSalesNavigatorPeoplesSearch` |
| POST | `/targeting/linkedin/extract-sales-navigator-peoples-search-alternative` | `mcp:write` | `Targeting::addLinkedinExtractSalesNavigatorPeoplesSearchAlternative` |
| POST | `/targeting/linkedin/generate-peoples-search-url` | `mcp:read` | `Targeting::generateLinkedinPeoplesSearchUrl` |
| POST | `/targeting/linkedin/generate-sales-navigator-peoples-search-url` | `mcp:read` | `Targeting::generateLinkedinSalesNavigatorPeoplesSearchUrl` |
| POST | `/targeting/linkedin/locations/search` | `mcp:read` | `Targeting::searchLinkedinLocation` |
| POST | `/targeting/linkedin/refresh/{contact_list_id}` | `mcp:write` | `Targeting::refreshLinkedinTargetingContactList` |
| POST | `/targeting/linkedin/{contact_list_id}/relaunch-errors` | `mcp:write` | `Targeting::relaunchLinkedinExtractions` |

### Existing account and integration access

| Method | Path | Scope | Business entry point |
| --- | --- | --- | --- |
| GET | `/integrations/linkedin` | `mcp:read` | User-scoped integration listing |
| GET | `/users/me` | `mcp:read` | Authenticated user profile |

### MCP repository handoff

The MCP repository is not present in this workspace. The API change alone does not update its catalogue or confirmation policy. In `src/endpoints.generated.ts`, retain only the documented method/path pairs and store their explicit required scope. Include the registered pagination variants above instead of accepting arbitrary suffixes. Remove the nonexistent `PUT /resellers/{reseller_id}/role/{user_id}` operation.

In `src/tools.ts` and `src/magileads.ts`, resolve the operation before Token Exchange, use its declared scope for generic and dedicated tools, and request the union for composite tools. A write operation requires `confirm:true` regardless of HTTP method; an unconfirmed call is a dry run and must not call the business endpoint. Its preview must report method, path and required scope. A route outside this allowlist must fail locally without a reconnect challenge. Preserve the existing public-token audience validation and confidential internal-client exchange.

Required MCP tests cover the two original POST read mismatches, every additional POST read, personalized GET write operations with and without confirmation, dry runs without an API call, parameter-name normalization, all documented pagination variants, rejected unregistered suffixes, excluded administrative/secret endpoints and composite scope unions. No live send or paid provider call belongs in these tests.

### Review batches and operational validation

Review the changes as four business batches: message models; lists/contacts/fields; PRM/campaigns; targeting/enrichment/statistics. Each batch includes the corresponding matrix rows, scope assertions and business permission regression cases. Keep each MR below 2,000 changed lines. The matrix assertions and OAuth fixtures are shared validation prerequisites.

After the API and MCP changes are available in a validation environment, connect using the OAuth client's published identity and verify consent, an authenticated read, model creation/update, the same search through dedicated and generic tools, and a confirmed real action with controlled test data. Check wrong-scope, foreign-resource and excluded-operation refusals. Keep production deployment separate from local verification. This extension requires no schema change, migration or SQL command.
