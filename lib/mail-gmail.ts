import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureDailyBackup, getDatabase, readSnapshot } from "./server-store";
import { currentRestoreGeneration } from "./restore-fence";

export const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const tokenUrl = "https://oauth2.googleapis.com/token";
const apiBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_REPLY = 256 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

export class MailError extends Error {
  constructor(message: string, public status = 400) { super(message); }
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

type Pending = { workspace_id: string; session_binding: string; encrypted_verifier: string; restore_generation: number; expires_at: number };
function consumeOAuthState(state: string, sessionBinding: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) throw new MailError("Gmail authorization expired or invalid", 400);
  const database = getDatabase();
  const pending = database.prepare("SELECT * FROM mail_oauth_pending WHERE state_hash = ?").get(hashState(state)) as Pending | undefined;
  if (!pending || !safeEqual(pending.session_binding, sessionBinding) ||
      pending.expires_at <= Date.now() || pending.restore_generation !== currentRestoreGeneration())
    throw new MailError("Gmail authorization expired or invalid", 400);
  const verifier = openMail(pending.encrypted_verifier);
  // Consume before network I/O so the same state cannot be redeemed twice.
  database.prepare("DELETE FROM mail_oauth_pending WHERE state_hash = ?").run(hashState(state));
  return { workspaceId: pending.workspace_id, verifier, restoreGeneration: pending.restore_generation };
}

async function googleJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new MailError("Gmail is temporarily unavailable", 502); }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) throw new MailError("Gmail authorization was refused or expired", 401);
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
      if (bytes > MAX_REPLY) throw new MailError("Gmail response is too large", 502);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks.map((part) => Buffer.from(part))).toString("utf8");
  try {
    const json: unknown = JSON.parse(body);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid");
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
  if (pending.restoreGeneration !== currentRestoreGeneration()) throw new MailError("Data was restored; reconnect Gmail", 409);
  requireMailWorkspace(pending.workspaceId);
  const database = getDatabase();
  const existing = database.prepare("SELECT id, encrypted_refresh_token FROM mail_accounts WHERE provider='gmail' AND workspace_id=? AND email=?")
    .get(pending.workspaceId, email) as { id: string; encrypted_refresh_token: string } | undefined;
  if (!refreshToken && !existing) throw new MailError("Google did not issue offline access; revoke Lumi permission and reconnect", 400);
  const encrypted = refreshToken ? sealMail(refreshToken) : existing!.encrypted_refresh_token;
  ensureDailyBackup();
  const now = Date.now();
  database.prepare("INSERT INTO mail_accounts (id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, provider, email) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token, updated_at=excluded.updated_at")
    .run(existing?.id || randomUUID(), pending.workspaceId, email, encrypted, now, now);
  return { workspaceId: pending.workspaceId, email };
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
  const result = getDatabase().prepare("DELETE FROM mail_accounts WHERE id=? AND workspace_id=? AND provider='gmail'").run(accountId, workspaceId);
  if (Number(result.changes) !== 1) throw new MailError("Mail account not found", 404);
}

function accountCredentials(workspaceId: string, accountId: string) {
  requireMailWorkspace(workspaceId);
  const account = getDatabase().prepare("SELECT encrypted_refresh_token FROM mail_accounts WHERE id=? AND provider='gmail' AND workspace_id=?")
    .get(accountId, workspaceId) as { encrypted_refresh_token: string } | undefined;
  if (!account) throw new MailError("Mail account not found", 404);
  return openMail(account.encrypted_refresh_token);
}

async function freshAccessToken(refresh: string) {
  const { clientId, clientSecret } = googleConfig();
  const tokens = await googleJson(tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokensForm({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
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
  const accessToken = await freshAccessToken(refresh);
  const headers = { authorization: "Bearer " + accessToken };
  const listUrl = new URL(apiBase + "/messages");
  listUrl.searchParams.set("maxResults", "15");
  listUrl.searchParams.append("labelIds", input.folder === "inbox" ? "INBOX" : "SENT");
  if (input.q?.trim()) listUrl.searchParams.set("q", input.q.trim());
  const listed = await googleJson(listUrl.toString(), { headers });
  const ids = Array.isArray(listed.messages) ? listed.messages.slice(0, 15) : [];
  const messages: GmailMessageSummary[] = [];
  // Bounded sequential reads: the list response contains IDs, not headers.
  for (const item of ids) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" ||
        !/^[0-9a-f]{5,64}$/i.test(item.id)) continue;
    const url = new URL(apiBase + "/messages/" + item.id);
    url.searchParams.set("format", "metadata");
    for (const key of ["Subject", "From", "To", "Date"]) url.searchParams.append("metadataHeaders", key);
    const data = await googleJson(url.toString(), { headers });
    const payload = data.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {};
    const pairs = Array.isArray(payload.headers) ? payload.headers : [];
    const header = (name: string) => {
      const found = pairs.find((h) => h && typeof h === "object" && String(h.name || "").toLowerCase() === name.toLowerCase());
      return found && typeof found.value === "string" ? found.value.slice(0, 500) : "";
    };
    messages.push({
      id: item.id, threadId: typeof data.threadId === "string" ? data.threadId : "",
      subject: header("subject"), from: header("from"), to: header("to"), date: header("date"),
      snippet: typeof data.snippet === "string" ? data.snippet.slice(0, 500) : "",
      unread: Array.isArray(data.labelIds) && data.labelIds.includes("UNREAD"),
    });
  }
  return { messages };
}
