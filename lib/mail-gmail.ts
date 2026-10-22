import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureDailyBackup, getDatabase, readSnapshot } from "./server-store";
import { currentRestoreGeneration } from "./restore-fence";

export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const tokenUrl = "https://oauth2.googleapis.com/token";
const apiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_REPLY = 256 * 1024;
const MAX_MESSAGE_REPLY = 1024 * 1024;
const MAX_MESSAGE_TEXT = 32_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MESSAGE_PREVIEW_DEADLINE_MS = 25_000;
const MESSAGE_DETAIL_CONCURRENCY = 5;

export class MailError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function mailKey() {
  const secret = process.env.AI_EXECUTIVE_MAIL_SECRET || "";
  if (secret.length < 32) throw new MailError("Mail encryption is not configured", 503);
  return createHash("sha256").update("lumi-mail-v1\0" + secret).digest();
}

export function sealMail(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mailKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function openMail(value: string) {
  const [iv, tag, content, extra] = value.split(".");
  if (!iv || !tag || !content || extra) throw new MailError("Mail credentials are unreadable", 503);
  const rawIv = Buffer.from(iv, "base64url");
  const rawTag = Buffer.from(tag, "base64url");
  if (rawIv.length !== 12 || rawTag.length !== 16) throw new MailError("Mail credentials are unreadable", 503);
  try {
    const decipher = createDecipheriv("aes-256-gcm", mailKey(), rawIv);
    decipher.setAuthTag(rawTag);
    return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new MailError("Mail credentials are unreadable", 503); }
}

function googleConfig() {
  const clientId = process.env.AI_EXECUTIVE_GMAIL_CLIENT_ID || "";
  const clientSecret = process.env.AI_EXECUTIVE_GMAIL_CLIENT_SECRET || "";
  const redirectValue = process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI || "";
  if (!clientId || !clientSecret || !redirectValue) throw new MailError("Gmail OAuth is not configured", 503);
  let redirect: URL;
  try { redirect = new URL(redirectValue); } catch { throw new MailError("Gmail redirect URI is invalid", 503); }
  if ((redirect.protocol !== "https:" && !(redirect.protocol === "http:" && redirect.hostname === "localhost")) ||
      redirect.pathname !== "/api/mail/gmail/callback" || redirect.search || redirect.hash || redirect.username || redirect.password)
    throw new MailError("Gmail redirect URI is invalid", 503);
  return { clientId, clientSecret, redirect: redirect.toString() };
}

function workspaceExists(workspaceId: string) {
  return workspaceId !== "all" && readSnapshot().entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
}

export function requireMailWorkspace(workspaceId: string) {
  if (!workspaceId || workspaceId.length > 160 || !workspaceExists(workspaceId))
    throw new MailError("Workspace not found", 404);
}

function hashState(state: string) { return createHash("sha256").update(state).digest("hex"); }
function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function startGmailAuthorization(workspaceId: string, sessionBinding: string) {
  requireMailWorkspace(workspaceId);
  const { clientId, redirect } = googleConfig();
  mailKey();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expires = Date.now() + 10 * 60_000;
  const database = getDatabase();
  database.prepare("DELETE FROM mail_oauth_pending WHERE expires_at < ?").run(Date.now());
  database.prepare("INSERT INTO mail_oauth_pending (state_hash, workspace_id, session_binding, encrypted_verifier, restore_generation, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(hashState(state), workspaceId, sessionBinding, sealMail(verifier), currentRestoreGeneration(), expires);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope: gmailScope,
    access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state,
  })) url.searchParams.set(key, value);
  return url.toString();
}

type Pending = { workspace_id: string; session_binding: string; encrypted_verifier: string; restore_generation: number; expires_at: number; claimed_at: number | null };
function consumeOAuthState(state: string, sessionBinding: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) throw new MailError("Gmail authorization expired or invalid", 400);
  const database = getDatabase();
  const pending = database.prepare("SELECT * FROM mail_oauth_pending WHERE state_hash = ?").get(hashState(state)) as Pending | undefined;
  if (!pending || pending.claimed_at !== null || !safeEqual(pending.session_binding, sessionBinding) ||
      pending.expires_at <= Date.now() || pending.restore_generation !== currentRestoreGeneration())
    throw new MailError("Gmail authorization expired or invalid", 400);
  const verifier = openMail(pending.encrypted_verifier);
  // Claim exactly once, before network I/O. Keep the row until completion so a
  // concurrent disconnect can revoke an already-running Google exchange.
  const claimedAt = Date.now();
  const stateHash = hashState(state);
  const claimed = database.prepare("UPDATE mail_oauth_pending SET claimed_at = ? WHERE state_hash = ? AND claimed_at IS NULL AND expires_at > ?")
    .run(claimedAt, stateHash, claimedAt);
  if (Number(claimed.changes) !== 1) throw new MailError("Gmail authorization expired or invalid", 400);
  return { workspaceId: pending.workspace_id, verifier, restoreGeneration: pending.restore_generation, stateHash, claimedAt };
}

// Only the isolated browser-test instance can redirect Gmail calls to its loopback
// mock. A fake test OAuth client id AND explicit e2e flags are mandatory; real
// account tokens can never use this override, even if E2E was set by mistake.
function gmailE2EEndpoint(value: string) {
  if (process.env.AI_EXECUTIVE_E2E !== "true" ||
      process.env.AI_EXECUTIVE_GMAIL_CLIENT_ID !== "lumi-e2e-only" ||
      !(process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI || "").startsWith("http://localhost:")) return value;
  const raw = process.env.AI_EXECUTIVE_E2E_GMAIL_URL || "";
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/$/.test(raw)) return value;
  const original = new URL(value);
  if (original.origin !== "https://oauth2.googleapis.com" &&
      original.origin !== "https://gmail.googleapis.com") throw new MailError("Gmail test origin refused", 502);
  return new URL(original.pathname + original.search, raw).toString();
}

async function googleJson(url: string, options: RequestInit = {}, deadlineAt?: number, maxBytes = MAX_REPLY): Promise<Record<string, unknown>> {
  const remaining = deadlineAt === undefined ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, deadlineAt - Date.now());
  if (remaining <= 0) throw new MailError("Gmail request timed out", 502);
  let response: Response;
  try {
    response = await fetch(gmailE2EEndpoint(url), { ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(remaining) });
  } catch { throw new MailError("Gmail is temporarily unavailable", 502); }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) throw new MailError("Gmail authorization was refused or expired", 401);
    if (response.status === 404) throw new MailError("Gmail item no longer exists", 404);
    throw new MailError("Gmail request failed", 502);
  }
  if (!response.body) throw new MailError("Gmail returned an empty response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new MailError("Gmail response is too large", 502);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks.map((part) => Buffer.from(part))).toString("utf8");
  try {
    const json: unknown = JSON.parse(body);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new MailError("Gmail response is invalid", 502);
    return json as Record<string, unknown>;
  } catch { throw new MailError("Gmail response is invalid", 502); }
}

function tokensForm(values: Record<string, string>) {
  return new URLSearchParams(values);
}

export async function finishGmailAuthorization(state: string, code: string, sessionBinding: string) {
  if (!code || code.length > 4096) throw new MailError("Gmail authorization code is invalid");
  const pending = consumeOAuthState(state, sessionBinding);
  requireMailWorkspace(pending.workspaceId);
  const config = googleConfig();
  const tokens = await googleJson(tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokensForm({ code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirect, grant_type: "authorization_code", code_verifier: pending.verifier }),
  });
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!accessToken) throw new MailError("Gmail did not issue an access token", 502);
  if (typeof tokens.scope === "string" && !tokens.scope.split(" ").includes(gmailScope))
    throw new MailError("Required read-only permission was not granted", 403);
  const profile = await googleJson(apiBase + "/profile", { headers: { authorization: "Bearer " + accessToken } });
  const email = typeof profile.emailAddress === "string" ? profile.emailAddress.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new MailError("Gmail profile is invalid", 502);

  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    // The same transaction checks revocation and inserts credentials. Disconnect
    // deletes all pending states for this workspace, including claimed ones.
    if (pending.restoreGeneration !== currentRestoreGeneration()) throw new MailError("Data was restored; reconnect Gmail", 409);
    requireMailWorkspace(pending.workspaceId);
    const stillAuthorized = database.prepare(`SELECT 1 FROM mail_oauth_pending
      WHERE state_hash = ? AND workspace_id = ? AND claimed_at = ? AND expires_at > ?`)
      .get(pending.stateHash, pending.workspaceId, pending.claimedAt, Date.now());
    if (!stillAuthorized) throw new MailError("Gmail connection was cancelled; reconnect Gmail", 409);

    const existing = database.prepare("SELECT id, encrypted_refresh_token FROM mail_accounts WHERE provider='gmail' AND workspace_id=? AND email=?")
      .get(pending.workspaceId, email) as { id: string; encrypted_refresh_token: string } | undefined;
    if (!refreshToken && !existing) throw new MailError("Google did not issue offline access; revoke Lumi permission and reconnect", 400);
    const encrypted = refreshToken ? sealMail(refreshToken) : existing!.encrypted_refresh_token;
    const now = Date.now();
    database.prepare("INSERT INTO mail_accounts (id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, provider, email) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token, updated_at=excluded.updated_at")
      .run(existing?.id || randomUUID(), pending.workspaceId, email, encrypted, now, now);
    database.prepare("DELETE FROM mail_oauth_pending WHERE state_hash = ?").run(pending.stateHash);
    database.exec("COMMIT");
    return { workspaceId: pending.workspaceId, email };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export type MailAccount = { id: string; provider: "gmail"; workspaceId: string; email: string; updatedAt: number };
export function listMailAccounts(workspaceId: string): MailAccount[] {
  requireMailWorkspace(workspaceId);
  return (getDatabase().prepare("SELECT id, provider, workspace_id, email, updated_at FROM mail_accounts WHERE workspace_id=? ORDER BY email").all(workspaceId) as Array<Record<string, unknown>>)
    .map((r) => ({ id: String(r.id), provider: "gmail", workspaceId: String(r.workspace_id), email: String(r.email), updatedAt: Number(r.updated_at) }));
}
export function disconnectMailAccount(workspaceId: string, accountId: string) {
  requireMailWorkspace(workspaceId);
  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database.prepare("DELETE FROM mail_accounts WHERE id=? AND workspace_id=? AND provider='gmail'").run(accountId, workspaceId);
    if (Number(result.changes) !== 1) throw new MailError("Mail account not found", 404);
    // Cancel even already-claimed OAuth states. The callback rechecks these rows
    // under the write lock before persisting any refreshed credentials.
    database.prepare("DELETE FROM mail_oauth_pending WHERE workspace_id = ?").run(workspaceId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function accountCredentials(workspaceId: string, accountId: string) {
  requireMailWorkspace(workspaceId);
  const account = getDatabase().prepare("SELECT encrypted_refresh_token FROM mail_accounts WHERE id=? AND provider='gmail' AND workspace_id=?")
    .get(accountId, workspaceId) as { encrypted_refresh_token: string } | undefined;
  if (!account) throw new MailError("Mail account not found", 404);
  return openMail(account.encrypted_refresh_token);
}

async function freshAccessToken(refresh: string, deadlineAt?: number) {
  const { clientId, clientSecret } = googleConfig();
  const tokens = await googleJson(tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokensForm({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
  }, deadlineAt);
  if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new MailError("Gmail authorization expired", 401);
  return tokens.access_token;
}

export type GmailMessageSummary = {
  id: string; threadId: string; subject: string; from: string; to: string; date: string;
  snippet: string; unread: boolean;
};
export async function readGmailMessages(input: { workspaceId: string; accountId: string; folder: "inbox" | "sent"; q?: string }) {
  const refresh = accountCredentials(input.workspaceId, input.accountId);
  if (input.folder !== "inbox" && input.folder !== "sent") throw new MailError("Folder is invalid");
  if (input.q && input.q.length > 200) throw new MailError("Search query is too long");

  const deadlineAt = Date.now() + MESSAGE_PREVIEW_DEADLINE_MS;
  const accessToken = await freshAccessToken(refresh, deadlineAt);
  const headers = { authorization: "Bearer " + accessToken };
  const listUrl = new URL(apiBase + "/messages");
  listUrl.searchParams.set("maxResults", "15");
  listUrl.searchParams.append("labelIds", input.folder === "inbox" ? "INBOX" : "SENT");
  if (input.q?.trim()) listUrl.searchParams.set("q", input.q.trim());
  const listed = await googleJson(listUrl.toString(), { headers }, deadlineAt);
  const ids = Array.isArray(listed.messages) ? listed.messages.slice(0, 15) : [];
  const messages: GmailMessageSummary[] = [];

  // Gmail list and get aren't atomic: a deleted message returns 404, but other
  // messages remain useful. Read at most five details concurrently, in list
  // order, with one end-to-end preview deadline (including token refresh).
  for (let index = 0; index < ids.length; index += MESSAGE_DETAIL_CONCURRENCY) {
    const batch = await Promise.all(ids.slice(index, index + MESSAGE_DETAIL_CONCURRENCY).map(
      async (item): Promise<GmailMessageSummary | null> => {
        if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" ||
            !/^[0-9a-f]{5,64}$/i.test(item.id)) return null;
        const url = new URL(apiBase + "/messages/" + item.id);
        url.searchParams.set("format", "metadata");
        for (const key of ["Subject", "From", "To", "Date"]) url.searchParams.append("metadataHeaders", key);
        let data: Record<string, unknown>;
        try {
          data = await googleJson(url.toString(), { headers }, deadlineAt);
        } catch (error) {
          if (error instanceof MailError && error.status === 404) return null;
          throw error;
        }
        const payload = data.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {};
        const pairs = Array.isArray(payload.headers) ? payload.headers : [];
        const header = (name: string) => {
          const found = pairs.find((h) => h && typeof h === "object" && String(h.name || "").toLowerCase() === name.toLowerCase());
          return found && typeof found.value === "string" ? found.value.slice(0, 500) : "";
        };
        return {
          id: item.id, threadId: typeof data.threadId === "string" ? data.threadId : "",
          subject: header("subject"), from: header("from"), to: header("to"), date: header("date"),
          snippet: typeof data.snippet === "string" ? data.snippet.slice(0, 500) : "",
          unread: Array.isArray(data.labelIds) && data.labelIds.includes("UNREAD"),
        };
      },
    ));
    for (const message of batch) if (message) messages.push(message);
  }
  return { messages };
}


export type GmailMessageDetail = {
  id: string; threadId: string; subject: string; from: string; to: string; date: string;
  text: string; truncated: boolean;
};

type GmailPart = {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: { data?: unknown; attachmentId?: unknown } | null;
  parts?: unknown;
};

function gmailHeader(part: GmailPart, name: string): string {
  const headers = Array.isArray(part.headers) ? part.headers : [];
  const found = headers.find((entry) => entry && typeof entry === "object" &&
    String((entry as Record<string, unknown>).name || "").toLowerCase() === name.toLowerCase()) as
    Record<string, unknown> | undefined;
  return typeof found?.value === "string" ? found.value.slice(0, 500) : "";
}

// Gmail MIME part bodies are base64url-encoded bytes, not necessarily UTF-8.
// Accept only bounded, syntactically valid charset labels; TextDecoder's built-in
// registry rejects unsupported names, which safely fall back to UTF-8.
function decodeGmailPart(data: string, part: GmailPart): string {
  const contentType = gmailHeader(part, "Content-Type");
  const match = contentType.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]{1,40})"|'([^']{1,40})'|([A-Za-z][A-Za-z0-9._-]{0,39}))/i);
  const declared = match?.[1] || match?.[2] || match?.[3] || "";
  const charset = /^[A-Za-z0-9._-]{1,40}$/.test(declared) ? declared : "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(Buffer.from(data, "base64url"));
}

function gmailBodyText(payload: GmailPart): { text: string; truncated: boolean } {
  const plain: string[] = [];
  const html: string[] = [];
  let visited = 0;
  // Do not fetch Gmail attachment IDs or retain MIME bodies in storage. Ignore
  // attachments even when their declared MIME type is text/plain or text/html.
  function walk(part: GmailPart, depth: number) {
    if (++visited > 80 || depth > 10 || typeof part !== "object" || part === null) return;
    if (typeof part.filename === "string" && part.filename !== "") return;
    if (/attachment/i.test(gmailHeader(part, "content-disposition"))) return;
    const mime = String(part.mimeType || "").toLowerCase();
    const data = part.body?.data;
    if ((mime === "text/plain" || mime === "text/html") && typeof data === "string" &&
        data.length < MAX_MESSAGE_REPLY && /^[A-Za-z0-9_-]+={0,2}$/.test(data)) {
      const value = decodeGmailPart(data, part);
      (mime === "text/plain" ? plain : html).push(value);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        if (child && typeof child === "object" && visited <= 80) walk(child as GmailPart, depth + 1);
      }
    }
  }
  walk(payload, 0);
  // HTML-only messages are displayed as inert text. Never send HTML to the
  // browser for insertion as markup or load remote images/tracking pixels.
  const htmlToText = (value: string) => value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>|<\s*\/(?:p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gi, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
      "&apos;": "'", "&nbsp;": " ", "&#39;": "'",
    }[entity.toLowerCase()] || entity));
  // A blank text/plain placeholder is not a useful alternative. Prefer real
  // plain text but fall back to readable HTML text when it is empty/whitespace.
  const readablePlain = plain.filter((value) => value.trim().length > 0);
  const readableHtml = html.map(htmlToText).filter((value) => value.trim().length > 0);
  const combined = (readablePlain.length ? readablePlain : readableHtml).join("\n\n");
  return { text: combined.slice(0, MAX_MESSAGE_TEXT), truncated: combined.length > MAX_MESSAGE_TEXT };
}

// A single message is fetched only after an explicit owner action. Bodies,
// attachments and access tokens never enter canonical SQLite or backups.
export async function readGmailMessage(input: { workspaceId: string; accountId: string; messageId: string }): Promise<GmailMessageDetail> {
  if (!/^[0-9a-f]{5,64}$/i.test(input.messageId)) throw new MailError("Message identifier is invalid", 400);
  const refresh = accountCredentials(input.workspaceId, input.accountId);
  const generation = currentRestoreGeneration();
  const deadlineAt = Date.now() + MESSAGE_PREVIEW_DEADLINE_MS;
  const accessToken = await freshAccessToken(refresh, deadlineAt);
  const url = new URL(apiBase + "/messages/" + input.messageId);
  url.searchParams.set("format", "full");
  const data = await googleJson(url.toString(), { headers: { authorization: "Bearer " + accessToken } }, deadlineAt, MAX_MESSAGE_REPLY);
  if (generation !== currentRestoreGeneration()) throw new MailError("Data was restored; retry Gmail", 409);
  // An account revoked while the request is in flight must not deliver content.
  accountCredentials(input.workspaceId, input.accountId);
  const payload = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
    ? data.payload as GmailPart : {};
  const body = gmailBodyText(payload);
  return {
    id: input.messageId,
    threadId: typeof data.threadId === "string" ? data.threadId.slice(0, 128) : "",
    subject: gmailHeader(payload, "Subject"),
    from: gmailHeader(payload, "From"),
    to: gmailHeader(payload, "To"),
    date: gmailHeader(payload, "Date"),
    ...body,
  };
}


// Gmail threads.get has no pagination or maxResults. First request the
// minimal thread index (only IDs via partial-response fields), then fetch
// metadata for at most the last 30 messages in bounded concurrent batches.
// This avoids downloading every historical header/snippet for long threads.
export type GmailThreadSummary = {
  id: string; total: number; omitted: number; messages: GmailMessageSummary[];
};

export async function readGmailThread(input: { workspaceId: string; accountId: string; threadId: string }): Promise<GmailThreadSummary> {
  if (!/^[0-9a-f]{5,64}$/i.test(input.threadId)) throw new MailError("Thread identifier is invalid", 400);
  const refresh = accountCredentials(input.workspaceId, input.accountId);
  const generation = currentRestoreGeneration();
  const deadlineAt = Date.now() + MESSAGE_PREVIEW_DEADLINE_MS;
  const token = await freshAccessToken(refresh, deadlineAt);
  const headers = { authorization: "Bearer " + token };

  // Gmail's minimal format omits headers and body; fields further excludes
  // labels/snippets to keep even hundreds of historical messages lightweight.
  const indexUrl = new URL(apiBase + "/threads/" + input.threadId);
  indexUrl.searchParams.set("format", "minimal");
  indexUrl.searchParams.set("fields", "id,messages(id,threadId)");
  const data = await googleJson(indexUrl.toString(), { headers }, deadlineAt, MAX_MESSAGE_REPLY);
  if (generation !== currentRestoreGeneration()) throw new MailError("Data was restored; retry Gmail", 409);
  accountCredentials(input.workspaceId, input.accountId);
  if (data.id !== input.threadId || !Array.isArray(data.messages)) throw new MailError("Gmail thread is invalid", 502);

  const all = data.messages;
  const last = all.slice(-30);
  const messages: GmailMessageSummary[] = [];

  for (let index = 0; index < last.length; index += MESSAGE_DETAIL_CONCURRENCY) {
    // A restore or disconnect invalidates the source even between batches.
    if (generation !== currentRestoreGeneration()) throw new MailError("Data was restored; retry Gmail", 409);
    accountCredentials(input.workspaceId, input.accountId);
    const batch = await Promise.all(last.slice(index, index + MESSAGE_DETAIL_CONCURRENCY).map(
      async (item): Promise<GmailMessageSummary | null> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || !/^[0-9a-f]{5,64}$/i.test(record.id) ||
            (record.threadId !== undefined && record.threadId !== input.threadId)) return null;
        const url = new URL(apiBase + "/messages/" + record.id);
        url.searchParams.set("format", "metadata");
        for (const name of ["Subject", "From", "To", "Date"]) url.searchParams.append("metadataHeaders", name);
        url.searchParams.set("fields", "id,threadId,snippet,labelIds,payload/headers");
        let detail: Record<string, unknown>;
        try {
          detail = await googleJson(url.toString(), { headers }, deadlineAt);
        } catch (error) {
          // A single message can disappear between thread and message reads.
          if (error instanceof MailError && error.status === 404) return null;
          throw error;
        }
        if (detail.id !== record.id || detail.threadId !== input.threadId)
          throw new MailError("Gmail message is not part of the requested thread", 502);
        const payload = detail.payload && typeof detail.payload === "object" && !Array.isArray(detail.payload)
          ? detail.payload as GmailPart : {};
        return {
          id: record.id, threadId: input.threadId,
          subject: gmailHeader(payload, "Subject"), from: gmailHeader(payload, "From"),
          to: gmailHeader(payload, "To"), date: gmailHeader(payload, "Date"),
          snippet: typeof detail.snippet === "string" ? detail.snippet.slice(0, 500) : "",
          unread: Array.isArray(detail.labelIds) && detail.labelIds.includes("UNREAD"),
        };
      },
    ));
    for (const message of batch) if (message) messages.push(message);
  }
  // Never return mailbox data after a disconnect or restoration while fetching.
  if (generation !== currentRestoreGeneration()) throw new MailError("Data was restored; retry Gmail", 409);
  accountCredentials(input.workspaceId, input.accountId);
  return { id: input.threadId, total: all.length, omitted: all.length - last.length, messages };
}


// Mail v4: opt-in Gmail History synchronizer. Only bounded metadata is kept;
// snippets, MIME content, attachments, HTML, tokens and Google search queries
// are never persisted. Network reads happen outside the SQLite write lock.
const SYNC_DEADLINE_MS = 45_000;
const SYNC_MAX_ITEMS = 120;
const SYNC_KEEP_ITEMS = 250;
const SYNC_RETAIN_DAYS = [7, 30, 90] as const;
const gmailId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{5,64}$/i.test(value);
const historyId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,30}$/.test(value);
type SyncRow = {
  account_id: string; workspace_id: string; consent_id: string;
  history_id: string | null; retention_days: number; last_synced_at: number | null;
};
type SyncMessage = {
  id: string; thread: string; subject: string; sender: string; received: number;
  unread: number; inbox: number; sent: number;
};
export type MailSyncState = {
  accountId: string; workspaceId: string; enabled: boolean;
  retentionDays: number; lastSyncedAt: number | null; indexedCount: number;
};

function syncRow(workspaceId: string, accountId: string): SyncRow | undefined {
  return getDatabase().prepare("SELECT * FROM mail_sync_accounts WHERE workspace_id=? AND account_id=?")
    .get(workspaceId, accountId) as SyncRow | undefined;
}

function requireSyncAccount(workspaceId: string, accountId: string) {
  const row = syncRow(workspaceId, accountId);
  if (!row) throw new MailError("Gmail sync is not enabled", 404);
  return row;
}

function trimMailIndex(accountId: string, retentionDays: number, now: number) {
  const db = getDatabase();
  db.prepare("DELETE FROM mail_sync_messages WHERE account_id = ? AND received_at < ?")
    .run(accountId, now - retentionDays * 86_400_000);
  db.prepare(`DELETE FROM mail_sync_messages WHERE account_id = ? AND message_id NOT IN
    (SELECT message_id FROM mail_sync_messages WHERE account_id = ?
     ORDER BY received_at DESC, message_id DESC LIMIT ?)`)
    .run(accountId, accountId, SYNC_KEEP_ITEMS);
}

export function listMailSyncStates(workspaceId: string): MailSyncState[] {
  requireMailWorkspace(workspaceId);
  const db = getDatabase();
  const now = Date.now();
  // Enforce the configured retention bound when the status is inspected,
  // even if a sync has not been requested since the last visit.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of db.prepare("SELECT account_id, retention_days FROM mail_sync_accounts WHERE workspace_id=?")
      .all(workspaceId) as Array<{ account_id: string; retention_days: number }>)
      trimMailIndex(row.account_id, row.retention_days, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return (db.prepare(`SELECT a.id AS account_id, a.workspace_id, s.retention_days, s.last_synced_at,
      (SELECT COUNT(*) FROM mail_sync_messages m WHERE m.account_id=a.id) AS indexed_count
    FROM mail_accounts a JOIN mail_sync_accounts s ON s.account_id=a.id AND s.workspace_id=a.workspace_id
    WHERE a.provider='gmail' AND a.workspace_id=? ORDER BY a.email`).all(workspaceId) as Array<{
      account_id: string; workspace_id: string; retention_days: number;
      last_synced_at: number | null; indexed_count: number;
    }>).map((r) => ({
      accountId: r.account_id, workspaceId: r.workspace_id, enabled: true,
      retentionDays: r.retention_days, lastSyncedAt: r.last_synced_at,
      indexedCount: r.indexed_count,
    }));
}

export function enableMailSync(workspaceId: string, accountId: string, retentionDays: number): void {
  if (!SYNC_RETAIN_DAYS.includes(retentionDays as 7 | 30 | 90))
    throw new MailError("Mail retention must be 7, 30 or 90 days", 400);
  accountCredentials(workspaceId, accountId);
  ensureDailyBackup();
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO mail_sync_accounts
      (account_id, workspace_id, consent_id, history_id, last_synced_at, retention_days, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        consent_id=CASE WHEN mail_sync_accounts.retention_days != excluded.retention_days THEN excluded.consent_id ELSE mail_sync_accounts.consent_id END,
        history_id=CASE WHEN mail_sync_accounts.retention_days != excluded.retention_days THEN NULL ELSE mail_sync_accounts.history_id END,
        last_synced_at=CASE WHEN mail_sync_accounts.retention_days != excluded.retention_days THEN NULL ELSE mail_sync_accounts.last_synced_at END,
        retention_days=excluded.retention_days, updated_at=excluded.updated_at`)
      .run(accountId, workspaceId, randomUUID(), retentionDays, Date.now(), Date.now());
    trimMailIndex(accountId, retentionDays, Date.now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function disableMailSync(workspaceId: string, accountId: string) {
  accountCredentials(workspaceId, accountId);
  ensureDailyBackup();
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM mail_sync_accounts WHERE workspace_id=? AND account_id=?")
      .run(workspaceId, accountId);
    // Triggers clear every indexed message, even if the sync was active.
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function parseMailSyncMessage(raw: Record<string, unknown>, retentionDays: number, now: number): SyncMessage | null {
  if (!gmailId(raw.id) || !gmailId(raw.threadId)) return null;
  const labels = Array.isArray(raw.labelIds) ? raw.labelIds : [];
  if (!labels.includes("INBOX") && !labels.includes("SENT")) return null;
  if (["SPAM", "TRASH", "DRAFT"].some((x) => labels.includes(x))) return null;
  const stamp = typeof raw.internalDate === "string" && /^[0-9]{1,16}$/.test(raw.internalDate)
    ? Number(raw.internalDate) : NaN;
  if (!Number.isSafeInteger(stamp) || stamp < now - retentionDays * 86_400_000 || stamp > now + 86_400_000) return null;
  const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
    ? raw.payload as GmailPart : {};
  return {
    id: raw.id, thread: raw.threadId,
    subject: gmailHeader(payload, "Subject").slice(0, 240),
    sender: gmailHeader(payload, "From").slice(0, 240),
    received: stamp, unread: Number(labels.includes("UNREAD")),
    inbox: Number(labels.includes("INBOX")), sent: Number(labels.includes("SENT")),
  };
}

export async function syncMailAccount(workspaceId: string, accountId: string) {
  const settings = requireSyncAccount(workspaceId, accountId);
  const refresh = accountCredentials(workspaceId, accountId);
  const generation = currentRestoreGeneration();
  const deadline = Date.now() + SYNC_DEADLINE_MS;
  const token = await freshAccessToken(refresh, deadline);
  const headers = { authorization: "Bearer " + token };
  const current = Date.now();
  let full = !settings.history_id;
  let nextHistory: string | null = null;
  let partial = false;
  const changes = new Set<string>();
  const deleted = new Set<string>();
  if (!full) {
    try {
      let pageToken = "";
      let page = 0;
      let lastAppliedEventId: string | null = null;
      while (true) {
        const url = new URL(apiBase + "/history");
        url.searchParams.set("startHistoryId", settings.history_id!);
        url.searchParams.set("maxResults", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"])
          url.searchParams.append("historyTypes", type);
        const response = await googleJson(url.toString(), { headers }, deadline);
        if (!historyId(response.historyId)) throw new MailError("Invalid Gmail history cursor", 502);
        const entries = Array.isArray(response.history) ? response.history : [];
        let atCapacity = false;
        for (const event of entries) {
          if (!event || typeof event !== "object") throw new MailError("Invalid Gmail history event", 502);
          const obj = event as Record<string, unknown>;
          if (!historyId(obj.id) ||
              (lastAppliedEventId !== null && BigInt(obj.id) <= BigInt(lastAppliedEventId)))
            throw new MailError("Invalid Gmail history event cursor", 502);
          const updates = new Set<string>();
          const removals = new Set<string>();
          for (const [name, target] of [["messagesAdded", updates], ["messagesDeleted", removals],
            ["labelsAdded", updates], ["labelsRemoved", updates]] as const) {
            const events = Array.isArray(obj[name]) ? obj[name] : [];
            for (const record of events) {
              const message = record && typeof record === "object" ? (record as Record<string, unknown>).message : null;
              const id = message && typeof message === "object" ? (message as Record<string, unknown>).id : null;
              if (gmailId(id)) target.add(id);
            }
          }
          // Check the cost BEFORE admitting an entire event. A checkpoint can
          // only point at a fully consumed event, never partway through one.
          const projected = new Set([...changes, ...deleted, ...updates, ...removals]).size;
          if (projected > SYNC_MAX_ITEMS) { atCapacity = true; break; }
          for (const id of updates) changes.add(id);
          for (const id of removals) deleted.add(id);
          lastAppliedEventId = obj.id;
        }
        // A backlog is replayed over subsequent explicit sync requests. Never
        // discard the existing index or checkpoint beyond events not processed.
        if (atCapacity) {
          if (!lastAppliedEventId) throw new MailError("Gmail history event exceeds sync budget; retry later", 409);
          nextHistory = lastAppliedEventId;
          partial = true;
          break;
        }
        if (!response.nextPageToken) {
          nextHistory = response.historyId;
          break;
        }
        if (typeof response.nextPageToken !== "string" || response.nextPageToken.length > 512)
          throw new MailError("Invalid Gmail history page", 502);
        if (++page >= 5) {
          if (!lastAppliedEventId) throw new MailError("Gmail history page exceeds sync budget", 409);
          nextHistory = lastAppliedEventId;
          partial = true;
          break;
        }
        pageToken = response.nextPageToken;
      }
    } catch (error) {
      // Gmail expires old history IDs. Rebuild from a recent bounded snapshot,
      // never advance the cursor past data we failed to read.
      if (error instanceof MailError && error.status === 404) full = true;
      else throw error;
    }
  }
  if (full) {
    changes.clear(); deleted.clear();
    const profile = await googleJson(apiBase + "/profile", { headers }, deadline);
    if (!historyId(profile.historyId)) throw new MailError("Gmail profile history is invalid", 502);
    nextHistory = profile.historyId;
    for (const folder of ["INBOX", "SENT"]) {
      const url = new URL(apiBase + "/messages");
      url.searchParams.set("maxResults", "25");
      url.searchParams.set("labelIds", folder);
      const result = await googleJson(url.toString(), { headers }, deadline);
      for (const item of Array.isArray(result.messages) ? result.messages.slice(0, 25) : []) {
        if (item && typeof item === "object" && gmailId((item as Record<string, unknown>).id))
          changes.add((item as Record<string, string>).id);
      }
    }
  }
  if (!nextHistory) throw new MailError("Gmail did not return a history cursor", 502);
  const fetched: SyncMessage[] = [];
  // Bounded and concurrent, metadata format never requests MIME bodies.
  const ids = [...changes].filter((id) => !deleted.has(id));
  for (let i = 0; i < ids.length; i += MESSAGE_DETAIL_CONCURRENCY) {
    const batch = await Promise.all(ids.slice(i, i + MESSAGE_DETAIL_CONCURRENCY).map(async (id) => {
      const url = new URL(apiBase + "/messages/" + id);
      url.searchParams.set("format", "metadata");
      for (const name of ["Subject", "From"]) url.searchParams.append("metadataHeaders", name);
      try {
        const data = await googleJson(url.toString(), { headers }, deadline);
        if (data.id !== id) throw new MailError("Gmail message identity changed", 502);
        return parseMailSyncMessage(data, settings.retention_days, current);
      } catch (error) {
        if (error instanceof MailError && error.status === 404) return null;
        throw error;
      }
    }));
    for (const message of batch) if (message) fetched.push(message);
  }
  ensureDailyBackup();
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentRow = requireSyncAccount(workspaceId, accountId);
    // Consent and cursor compare prevent stale or overlapping sync commits.
    // A disable/re-enable gets a new consent_id, defeating ABA races.
    if (generation !== currentRestoreGeneration() ||
        currentRow.consent_id !== settings.consent_id || currentRow.history_id !== settings.history_id)
      throw new MailError("Gmail sync configuration changed; retry", 409);
    accountCredentials(workspaceId, accountId);
    if (full) db.prepare("DELETE FROM mail_sync_messages WHERE account_id=?").run(accountId);
    else {
      const clear = db.prepare("DELETE FROM mail_sync_messages WHERE account_id=? AND message_id=?");
      for (const id of new Set([...changes, ...deleted])) clear.run(accountId, id);
    }
    const insert = db.prepare(`INSERT INTO mail_sync_messages
      (account_id, workspace_id, message_id, thread_id, subject, sender, received_at, unread, in_inbox, in_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of fetched) insert.run(accountId, workspaceId, entry.id, entry.thread,
      entry.subject, entry.sender, entry.received, entry.unread, entry.inbox, entry.sent);
    trimMailIndex(accountId, currentRow.retention_days, Date.now());
    db.prepare("UPDATE mail_sync_accounts SET history_id=?, last_synced_at=?, updated_at=? WHERE account_id=? AND consent_id=?")
      .run(nextHistory, Date.now(), Date.now(), accountId, settings.consent_id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { full, updated: fetched.length, historyId: nextHistory,
    partial, state: listMailSyncStates(workspaceId).find((s) => s.accountId === accountId) };
}
