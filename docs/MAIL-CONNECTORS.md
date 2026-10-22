# Lumi mail connectors — Gmail read-only v1

## First slice
Owner-session only, multi-account and workspace-scoped Gmail OAuth 2.0 (PKCE + state, 10-minute one-use authorization).
The only requested Google scope is `https://www.googleapis.com/auth/gmail.readonly`. The encrypted refresh token is stored in
canonical SQLite; access tokens exist in request memory only. No emails, message bodies, attachments or OAuth access tokens
are persisted. Inbox and Sent previews are fetched on demand (maximum 15 metadata results per request). No send, drafts,
archive, deletion, labeling, AI ingestion, automatic task creation, background sync or email backup.

## Configuration
1. Create a private Google Cloud OAuth **Web application** and enable the Gmail API. Register the exact HTTPS callback
   `https://<Lumi-host>/api/mail/gmail/callback`; list your Google account as a test user when the consent screen is in testing.
2. Set `AI_EXECUTIVE_GMAIL_CLIENT_ID`, `AI_EXECUTIVE_GMAIL_CLIENT_SECRET`,
   `AI_EXECUTIVE_GMAIL_REDIRECT_URI` and a **stable random 32+ character** `AI_EXECUTIVE_MAIL_SECRET`
   in server-only environment settings. Never commit these credentials. Restart after config.
3. In Lumi → Settings → Mail, choose a workspace and connect your Gmail. Review the Google consent screen.
4. Disconnect from Lumi to delete the locally stored token; separately revoke access in Google Account settings if desired.

## Security and lifecycle
Accounts are bound to a concrete existing workspace. `All my work` cannot read/connect/disconnect a mailbox.
The OAuth callback completes through a first-party same-origin POST because Lumi's SameSite=Strict owner session is deliberately never sent on Google's cross-site GET redirect. It requires the same signed owner session as the start request, a consumed one-time state, a matching
restore generation and a server-registered redirect URI. Only Google endpoints are contacted; redirects from those
endpoints are refused, responses are bounded, and secrets are never returned to the browser or security event logs.
OAuth pending state is cleared on restore and excluded from backups. Mail accounts and their encrypted refresh tokens
are included in full backups, like iCloud calendar account secrets; preserve the encryption key for restores.
Changing the mail encryption key makes stored tokens unreadable until you reconnect.
Disconnecting a Gmail account also cancels outstanding OAuth connection attempts for that workspace (including an exchange already in flight), so an older callback cannot reconnect a removed account. A later explicit connection starts a new authorization.
Gmail previews fetch up to 15 message summaries in bounded batches of five, with a 25-second overall deadline. Messages that disappear between list and metadata fetch are skipped rather than causing the whole preview to fail; other Gmail errors still surface.

Google classifies gmail.readonly as a restricted scope. Its use and any broader deployment must comply with Google's
OAuth app review, testing limits and restricted-scope data requirements. A testing-mode refresh token may expire after
seven days; account reconnection is then required.

## Mail v2 — first delivery slice (message detail → explicit task)
- A signed-in owner may explicitly open a single Gmail message from an existing workspace-scoped account; a same-origin no-store POST retrieves its full Gmail MIME payload on demand.
- The server extracts bounded plain text (HTML-only is converted to inert text, never inserted as HTML); attachment IDs are never fetched. MIME text parts respect a supported declared charset (including Windows-1250 and ISO-8859-2, with UTF-8 fallback for unknown labels), and blank plain-text alternatives fall back to inert HTML text. The message response is bounded to 1 MiB, with a maximum 32,000 characters displayed and an explicit truncation notice.
- The detail page offers an editable task title. **Only the owner's explicit Confirm and create task action** uses Lumi's existing local-first task creation flow; the task lands in the same workspace's Inbox. The approved title is stored literally: date words, dates and priority tokens from email subjects are not interpreted as Quick Capture commands.
- Created tasks record structured source IDs in `properties.mailSource`: `provider: gmail`, `accountId`, `messageId`, `threadId`. These identifiers are workspace-scoped. Email bodies, attachments, Gmail access tokens and refresh tokens are **not** copied into tasks.
- The task inspector identifies a Gmail source and offers **Open source message**. The UI transitions to the appropriate workspace and Mail screen with IDs held only in transient React state, reauthorizing the message fetch against the still-connected account. Disconnected sources show an explicit error.
- There is no automatic message analysis, LLM transfer, mail write, background sync or silent task creation. Gmail API consent remains read-only; task writes occur only in Lumi after confirmation.
- This slice intentionally does not yet support browsing entire threads, attachment previews, automated follow-up detection, or the provider-independent source inspector UI.

## Next slices
Incremental history sync and content index with retention/privacy controls, richer message details, iCloud Mail via
IMAP with an app-specific password, and Proton Mail Bridge. All integrations remain disabled until separately configured.

## Mail v3 — conversation summaries
- User-initiated read-only Gmail thread view: first fetches a minimal thread index containing only message IDs using Gmail's partial-response `fields`, then fetches only the latest 30 messages' metadata (headers and snippets) in concurrent batches of up to five. This avoids fetching large historical headers/snippets when the conversation contains hundreds of messages. The selected messages keep Gmail's original order; an omitted count indicates older messages. Messages that disappear between the index and detail read are skipped.
- Opening an individual message is a separate explicit action through the existing bounded message-detail API. Thread responses never include full message bodies, HTML markup or attachments, and are not stored locally or server-side.
- The new owner-session-only, restore-fenced, same-origin POST validates the concrete workspace, account and hexadecimal Gmail thread ID. It rechecks restore generation and account access after network I/O, and caps the response and request duration. No changes to Google OAuth scopes or Gmail write access.


## Mail v4 — explicit opt-in Gmail metadata synchronization (first backend/UI slice)
- **Disabled by default.** In Settings → Mail, enable synchronization for one selected connected Gmail account and choose a retention period (7, 30 or 90 days). Enabling does not start any network job. The owner must click **Synchronizovat nyní / Sync now**; background polling and automatic AI processing are NOT part of this first slice.
- The first sync reads the Gmail profile history cursor, then lists at most 25 Inbox and 25 Sent messages (deduplicated) and fetches metadata. Subsequent manual syncs use `users.history.list` for message additions, deletions and label changes. Large history backlogs are processed in bounded batches, checkpointed at the last fully consumed Gmail event; a persistent `historyPending` status survives reloads and requests another manual sync for remaining changes. Single large history events are resumed across user-triggered sync calls with a persistent within-event offset. Expired cursors (404) cause a bounded bootstrap. No cursor is advanced past unprocessed history.
- Only `message_id`, `thread_id`, subject (max 240 chars), sender (max 240 chars), Gmail internal timestamp and Inbox/Sent/Unread flags are persisted. **No snippets, bodies, HTML, MIME data, attachments, tokens, Google search queries or AI outputs** enter the index. Only Inbox and Sent are eligible. History pages/changed IDs, request duration and account index size are bounded.
- Oversized single Gmail History records are processed via a durable `pending_event_id` and `pending_event_offset` checkpoint, with a 120-distinct-ID budget per explicit sync. After reconnect, the next request resumes the same event at its saved position without skipping unprocessed IDs. Expired history cursors trigger a bounded, **non-destructive** rebootstrap: existing retained metadata is flagged as needing verification. The first 25 Inbox and 25 Sent IDs are only the first page; opaque `messages.list` next-page tokens are saved per folder and subsequent manual syncs traverse remaining pages. A persistent `discoveryPending` flag prevents falsely claiming completion before all pages are processed. Later manual synchronizations re-fetch up to the remaining per-request 120-ID budget, removing entries deleted or moved out of Inbox/Sent, and durably keep the incomplete state across page loads/restarts until all indexed IDs have been checked. Incremental Gmail history changes continue to be consumed against the saved profile cursor in parallel with revalidation.
- If Gmail rejects a saved `messages.list` page token with HTTP 400, the next manual sync restarts that folder's discovery from its first page and commits a fresh continuation cursor atomically with the metadata. Existing indexed messages are not erased. An HTTP 401 or a failure of the fresh first page fails closed without cursor changes; OAuth `invalid_grant` still requires reauthorization.
- If sync status is unavailable, the connected Gmail reader stays usable but the synchronization state is shown as **unknown** and controls changing consent/retention are disabled until fresh status is available.
- The sync cursor and indexed metadata are scoped by Gmail account and workspace. Writes are atomic, check the original consent UUID and history cursor (including after network I/O), and are rejected after restore, disconnect or disable/re-enable. Disconnecting Gmail or deleting the workspace clears both tables through SQLite triggers.
- **Vypnout a smazat metadata / Disable and delete metadata** deletes the account's consent row and all indexed messages in the same transaction. Retention purging runs automatically on the server at database startup and every 15 minutes while it is running (no Gmail network calls), as well as on manual sync and status inspection. Production deployment integrity checks accept only verified expired mail metadata losses; all other changes in retained records still fail closed. When the service is stopped, cleanup resumes at the next startup. Mail-sync settings and indexed metadata are included in full database backups; older backup copies must be managed separately under the user's backup retention policy.
- The OAuth scope remains `gmail.readonly`, with owner-only, same-origin, restore-fenced requests. No mail sending, modifying, deleting, silent task creation or cloud AI transfer. Automatic scheduling, notifications and full-text indexing are deferred to a later PR.
