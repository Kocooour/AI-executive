import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-mail-gmail-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_MAIL_SECRET = "test-only-mail-key-is-long-enough-0123456789";
process.env.AI_EXECUTIVE_GMAIL_CLIENT_ID = "test-id.apps.googleusercontent.com";
process.env.AI_EXECUTIVE_GMAIL_CLIENT_SECRET = "fake-client-secret";
process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI = "https://lumi.example/api/mail/gmail/callback";
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const mail = await import("../lib/mail-gmail.ts");
const { includedTables, excludedClearedTables } = await import("../lib/backup-scope.ts");
const database = store.getDatabase();
const team = "test-mail-team";
database.prepare("INSERT INTO entities(id, payload, updated_at) VALUES(?, ?, ?)").run(
  "workspace:" + team, JSON.stringify({
    id: "workspace:" + team, type: "workspace", workspaceId: team, title: "Test Team",
    status: "active", properties: { role: "owner" }, createdAt: 1, updatedAt: 1,
  }), 1,
);

test("mail schema and backup lifecycle are explicitly classified", () => {
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  assert(names.has("mail_accounts"));
  assert(names.has("mail_oauth_pending"));
  assert(includedTables.includes("mail_accounts"));
  assert(excludedClearedTables.includes("mail_oauth_pending"));
});

test("only explicit real workspace and a configured fixed callback can start authorization", () => {
  assert.throws(() => mail.startGmailAuthorization("all", "session-1"), { status: 404 });
  assert.throws(() => mail.startGmailAuthorization("unlisted", "session-1"), { status: 404 });
  const original = process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI;
  process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI = "https://evil.example/steal";
  assert.throws(() => mail.startGmailAuthorization("personal", "session-1"), { status: 503 });
  process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI = original;
});

test("refresh-token encryption is authenticated and uses a dedicated required key", () => {
  const sealed = mail.sealMail("refresh-sensitive-1");
  assert.notEqual(sealed, "refresh-sensitive-1");
  assert.equal(mail.openMail(sealed), "refresh-sensitive-1");
  const parts = sealed.split(".");
  parts[2] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => mail.openMail(parts.join(".")), { status: 503 });
  const before = process.env.AI_EXECUTIVE_MAIL_SECRET;
  delete process.env.AI_EXECUTIVE_MAIL_SECRET;
  assert.throws(() => mail.sealMail("password"), { status: 503 });
  process.env.AI_EXECUTIVE_MAIL_SECRET = before;
});

test("OAuth state binds owner session, expires after use, and never stores access token", async () => {
  const url = new URL(mail.startGmailAuthorization("personal", "session-1"));
  const state = url.searchParams.get("state");
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), mail.gmailScope);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("redirect_uri"), process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI);
  assert(!JSON.stringify(database.prepare("SELECT * FROM mail_oauth_pending").all()).includes(state));
  await assert.rejects(mail.finishGmailAuthorization(state, "code", "session-2"), { status: 400 });

  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (target, options = {}) => {
    requests.push({ url: String(target), method: options.method || "GET" });
    if (String(target) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH", scope: mail.gmailScope });
    if (String(target) === "https://gmail.googleapis.com/gmail/v1/users/me/profile")
      return Response.json({ emailAddress: "Reader@Example.com" });
    throw new Error("Unexpected endpoint: " + target);
  };
  try {
    const connected = await mail.finishGmailAuthorization(state, "code", "session-1");
    assert.equal(connected.email, "reader@example.com");
    assert.deepEqual(mail.listMailAccounts("personal").map((r) => r.email), ["reader@example.com"]);
    assert.deepEqual(mail.listMailAccounts(team), []);
    const stored = database.prepare("SELECT * FROM mail_accounts").get();
    assert(!JSON.stringify(stored).includes("SECRET-REFRESH"));
    assert(!JSON.stringify(stored).includes("SECRET-ACCESS"));
    assert.equal(mail.openMail(stored.encrypted_refresh_token), "SECRET-REFRESH");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending").get().n, 0);
    await assert.rejects(mail.finishGmailAuthorization(state, "code", "session-1"), { status: 400 });
    assert(requests.every((r) => r.url.startsWith("https://oauth2.googleapis.com/") ||
      r.url.startsWith("https://gmail.googleapis.com/")));
  } finally { globalThis.fetch = original; }
});

test("on-demand read fetches bounded metadata only, and refuses another workspace", async () => {
  const account = mail.listMailAccounts("personal")[0];
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(String(target));
    requests.push({ url, options });
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "TEMP-ACCESS" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "a1b2c3d4e5f6" }] });
    if (url.pathname.endsWith("/messages/a1b2c3d4e5f6"))
      return Response.json({
        threadId: "thread-1", snippet: "A short snippet",
        labelIds: ["INBOX", "UNREAD"],
        payload: { headers: [
          { name: "Subject", value: "Subject" }, { name: "From", value: "sender@example.com" },
          { name: "Date", value: "Wed, 21 Oct 2026 10:00:00 +0200" },
        ] },
      });
    throw new Error("Unexpected endpoint " + url);
  };
  try {
    await assert.rejects(mail.readGmailMessages({ workspaceId: team, accountId: account.id, folder: "inbox" }), { status: 404 });
    const result = await mail.readGmailMessages({ workspaceId: "personal", accountId: account.id, folder: "inbox", q: "meeting" });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].subject, "Subject");
    assert.equal(result.messages[0].unread, true);
    assert(requests.some((r) => r.url.searchParams.get("q") === "meeting"));
    assert(requests.every((r) => r.url.hostname === "oauth2.googleapis.com" ||
      r.url.hostname === "gmail.googleapis.com"));
    assert(!requests.some((r) => /send|modify|trash|drafts/.test(r.url.pathname)));
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name = 'mail_messages'").all(), []);
  } finally { globalThis.fetch = original; }
});

test("disconnect is workspace-scoped and removes encrypted account credentials", () => {
  const account = mail.listMailAccounts("personal")[0];
  assert.throws(() => mail.disconnectMailAccount(team, account.id), { status: 404 });
  assert.equal(mail.listMailAccounts("personal").length, 1);
  mail.disconnectMailAccount("personal", account.id);
  assert.equal(mail.listMailAccounts("personal").length, 0);
});

test("full backup restores encrypted credentials and discards obsolete OAuth state", () => {
  const accountId = "33333333-3333-4333-8333-333333333333";
  const encryptedToken = mail.sealMail("RESTORED-REFRESH-TOKEN");
  const db = store.getDatabase();
  db.prepare("INSERT INTO mail_accounts(id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', 'personal', 'restore@example.com', ?, 1, 1)")
    .run(accountId, encryptedToken);
  mail.startGmailAuthorization("personal", "fresh-session");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending").get().n, 1);
  const backup = store.createBackup("manual");
  db.prepare("DELETE FROM mail_accounts WHERE id=?").run(accountId);
  db.prepare("DELETE FROM mail_oauth_pending").run();
  store.restoreBackup(backup.name);
  const restored = store.getDatabase();
  const account = restored.prepare("SELECT * FROM mail_accounts WHERE id=?").get(accountId);
  assert.ok(account, "mail account survives an actual restore");
  assert.equal(account.encrypted_refresh_token, encryptedToken);
  assert.equal(mail.openMail(account.encrypted_refresh_token), "RESTORED-REFRESH-TOKEN");
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending").get().n, 0);
});
