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
- The server extracts bounded plain text (HTML-only is converted to inert text, never inserted as HTML); attachment IDs are never fetched. The message response is bounded to 1 MiB, with a maximum 32,000 characters displayed and an explicit truncation notice.
- The detail page offers an editable task title. **Only the owner's explicit Confirm and create task action** uses Lumi's existing local-first task creation flow; the task lands in the same workspace's Inbox.
- Created tasks record structured source IDs in `properties.mailSource`: `provider: gmail`, `accountId`, `messageId`, `threadId`. These identifiers are workspace-scoped. Email bodies, attachments, Gmail access tokens and refresh tokens are **not** copied into tasks.
- There is no automatic message analysis, LLM transfer, mail write, background sync or silent task creation. Gmail API consent remains read-only; task writes occur only in Lumi after confirmation.
- This slice intentionally does not yet support browsing entire threads, attachment previews, automated follow-up detection, or the provider-independent source inspector UI.

## Next slices
Incremental history sync and content index with retention/privacy controls, richer message details, iCloud Mail via
IMAP with an app-specific password, and Proton Mail Bridge. All integrations remain disabled until separately configured.
