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
    status: "active", properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: 1, updatedAt: 1,
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

test("OAuth landing permits only its first-party completion script and API call", async () => {
  const callback = await import("../app/api/mail/gmail/callback/route.ts");
  const state = "A".repeat(43);
  const response = await callback.GET(new Request(
    "https://lumi.example/api/mail/gmail/callback?state=" + state + "&code=TEMP-CODE",
  ));
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy") || "";
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /form-action 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.ok(html.includes("mail-oauth-finish.js"));
  assert(!html.includes("SECRET-REFRESH"));
});

test("deleting a workspace erases stored Gmail credentials and pending OAuth state in the same database transaction", () => {
  const db = store.getDatabase();
  const encrypted = mail.sealMail("WORKSPACE-CREDENTIAL");
  db.prepare("INSERT INTO mail_accounts (id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', ?, ?, ?, 1, 1)")
    .run("66666666-6666-4666-8666-666666666666", team, "orphan@example.com", encrypted);
  mail.startGmailAuthorization(team, "session-delete");
  assert.equal(mail.listMailAccounts(team).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending WHERE workspace_id=?").get(team).n, 1);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("DELETE FROM entities WHERE id = ?").run("workspace:" + team);
    assert.equal(result.changes, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_accounts WHERE workspace_id=?").get(team).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending WHERE workspace_id=?").get(team).n, 0);
    db.exec("ROLLBACK");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  assert.equal(mail.listMailAccounts(team).length, 1, "rollback preserves the credentials");
  db.prepare("DELETE FROM entities WHERE id = ?").run("workspace:" + team);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_accounts WHERE workspace_id=?").get(team).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending WHERE workspace_id=?").get(team).n, 0);
  assert.deepEqual(mail.listMailAccounts("personal").map((a) => a.email), ["restore@example.com"]);
});

test("OAuth callback never exchanges a code on public GET or unauthenticated POST", async () => {
  const callback = await import("../app/api/mail/gmail/callback/route.ts");
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error("unexpected Google request"); };
  const previousAuth = process.env.AI_EXECUTIVE_AUTH_ENABLED;
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  try {
    const state = "B".repeat(43);
    const landing = await callback.GET(new Request(
      "https://lumi.example/api/mail/gmail/callback?state=" + state + "&code=PUBLIC-CODE",
    ));
    assert.equal(landing.status, 200);
    const response = await callback.POST(new Request(
      "https://lumi.example/api/mail/gmail/callback", {
        method: "POST", headers: { origin: "https://lumi.example", "content-type": "application/json" },
        body: JSON.stringify({ state, code: "PUBLIC-CODE" }),
      },
    ));
    assert.equal(response.status, 401, "public callback POST requires owner login even with a valid-looking state");
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
    if (previousAuth === undefined) delete process.env.AI_EXECUTIVE_AUTH_ENABLED;
    else process.env.AI_EXECUTIVE_AUTH_ENABLED = previousAuth;
  }
});

test("disconnect cancels unclaimed and already exchanging OAuth, without resurrecting credentials", async () => {
  const db = store.getDatabase();
  const workspaceId = "personal";
  const accountId = "77777777-7777-4777-8777-777777777777";
  db.prepare("INSERT INTO mail_accounts (id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', ?, ?, ?, 1, 1)")
    .run(accountId, workspaceId, "disconnect-race@example.com", mail.sealMail("OLD-REFRESH"));

  const session = "disconnect-race-owner";
  const inFlightState = new URL(mail.startGmailAuthorization(workspaceId, session)).searchParams.get("state");
  const unclaimedState = new URL(mail.startGmailAuthorization(workspaceId, session)).searchParams.get("state");
  let unblockToken;
  const tokenGate = new Promise((resolve) => { unblockToken = resolve; });
  let tokenStarted;
  const started = new Promise((resolve) => { tokenStarted = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      tokenStarted();
      await tokenGate;
      return Response.json({ access_token: "NEW-ACCESS", refresh_token: "NEW-REFRESH", scope: mail.gmailScope });
    }
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/profile")
      return Response.json({ emailAddress: "disconnect-race@example.com" });
    throw new Error("Unexpected Gmail URL");
  };
  try {
    const completing = mail.finishGmailAuthorization(inFlightState, "fake-code", session);
    await started;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending WHERE workspace_id=? AND claimed_at IS NOT NULL").get(workspaceId).n, 1);
    mail.disconnectMailAccount(workspaceId, accountId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_oauth_pending WHERE workspace_id=?").get(workspaceId).n, 0);
    unblockToken();
    await assert.rejects(completing, (error) => error instanceof mail.MailError && error.status === 409);
    await assert.rejects(mail.finishGmailAuthorization(unclaimedState, "fake-code", session), { status: 400 });
    assert(!db.prepare("SELECT 1 FROM mail_accounts WHERE id=?").get(accountId), "disconnected account was not recreated");
    assert.equal(mail.listMailAccounts(workspaceId).some((account) => account.email === "disconnect-race@example.com"), false);
  } finally {
    unblockToken();
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM mail_accounts WHERE id=?").run(accountId);
  }
});

test("message preview skips vanished items, retains list order and limits concurrent detail reads", async () => {
  const account = mail.listMailAccounts("personal").find((item) => item.email === "restore@example.com");
  assert.ok(account);
  const originalFetch = globalThis.fetch;
  const ids = Array.from({ length: 7 }, (_, i) => (i + 100).toString(16).padStart(12, "0"));
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async (target) => {
    const url = new URL(String(target));
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "TEMP-ACCESS" });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: ids.map((id) => ({ id })) });
    const id = url.pathname.split("/").at(-1);
    if (url.pathname.includes("/messages/") && ids.includes(id)) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (id === ids[2]) return Response.json({ error: { code: 404 } }, { status: 404 });
      return Response.json({ threadId: id, snippet: "preview", payload: { headers: [{ name: "Subject", value: id }] } });
    }
    throw new Error("Unexpected Gmail URL: " + url);
  };
  try {
    const result = await mail.readGmailMessages({ workspaceId: "personal", accountId: account.id, folder: "inbox" });
    assert.deepEqual(result.messages.map((message) => message.id), ids.filter((id) => id !== ids[2]));
    assert(peak >= 2, "detail fetches run concurrently");
    assert(peak <= 5, "never exceeds five concurrent detail fetches");
    assert.equal(inFlight, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("message preview still fails on Gmail errors other than missing individual messages", async () => {
  const account = mail.listMailAccounts("personal").find((item) => item.email === "restore@example.com");
  assert.ok(account);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (target) => {
    const url = new URL(String(target));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "TEMP-ACCESS" });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "abc123def456" }] });
    return Response.json({ error: "unavailable" }, { status: 503 });
  };
  try {
    await assert.rejects(mail.readGmailMessages({ workspaceId: "personal", accountId: account.id, folder: "inbox" }),
      (error) => error instanceof mail.MailError && error.status === 502);
  } finally { globalThis.fetch = originalFetch; }
});
