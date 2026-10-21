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


// A conversation view fetches only metadata: no remote image loads, full HTML,
// attachment fetches, background sync, or persistence. The most recent 30
// message summaries retain Gmail's chronological ordering.
export type GmailThreadSummary = {
  id: string; total: number; omitted: number; messages: GmailMessageSummary[];
};

export async function readGmailThread(input: { workspaceId: string; accountId: string; threadId: string }): Promise<GmailThreadSummary> {
  if (!/^[0-9a-f]{5,64}$/i.test(input.threadId)) throw new MailError("Thread identifier is invalid", 400);
  const refresh = accountCredentials(input.workspaceId, input.accountId);
  const generation = currentRestoreGeneration();
  const deadlineAt = Date.now() + MESSAGE_PREVIEW_DEADLINE_MS;
  const token = await freshAccessToken(refresh, deadlineAt);
  const url = new URL(apiBase + "/threads/" + input.threadId);
  url.searchParams.set("format", "metadata");
  for (const name of ["Subject", "From", "To", "Date"]) url.searchParams.append("metadataHeaders", name);
  const data = await googleJson(url.toString(), { headers: { authorization: "Bearer " + token } }, deadlineAt, MAX_MESSAGE_REPLY);
  if (generation !== currentRestoreGeneration()) throw new MailError("Data was restored; retry Gmail", 409);
  // An account disconnected while Gmail was responding cannot return content.
  accountCredentials(input.workspaceId, input.accountId);
  if (data.id !== input.threadId || !Array.isArray(data.messages)) throw new MailError("Gmail thread is invalid", 502);
  const all = data.messages;
  const limited = all.slice(-30);
  const messages: GmailMessageSummary[] = [];
  for (const item of limited) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !/^[0-9a-f]{5,64}$/i.test(record.id) ||
        (record.threadId !== undefined && record.threadId !== input.threadId)) continue;
    const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? record.payload as GmailPart : {};
    messages.push({
      id: record.id, threadId: input.threadId,
      subject: gmailHeader(payload, "Subject"), from: gmailHeader(payload, "From"),
      to: gmailHeader(payload, "To"), date: gmailHeader(payload, "Date"),
      snippet: typeof record.snippet === "string" ? record.snippet.slice(0, 500) : "",
      unread: Array.isArray(record.labelIds) && record.labelIds.includes("UNREAD"),
    });
  }
  return { id: input.threadId, total: all.length, omitted: all.length - limited.length, messages };
}
