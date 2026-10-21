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


test("full Gmail read is on-demand, source-scoped, text-only and skips attached text", async () => {
  const account = mail.listMailAccounts("personal").find((row) => row.email === "restore@example.com");
  assert.ok(account);
  const oldFetch = globalThis.fetch;
  const calls = [];
  const encode = (text) => Buffer.from(text, "utf8").toString("base64url");
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (String(url) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "READ-ONLY-TEMP" });
    if (String(url).startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/abcdef123456?"))
      return Response.json({ threadId: "abcdef654321", payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: "Review the draft" }, { name: "From", value: "sender@example.com" },
          { name: "To", value: "restore@example.com" }, { name: "Date", value: "Wed, 21 Oct 2026 15:00:00 +0200" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: encode("Please review by Friday.\nSecond line.") } },
          { mimeType: "text/plain", filename: "private.txt", body: { data: encode("ATTACHMENT SECRET") } },
          { mimeType: "text/html", body: { data: encode("<script>alert(1)</script><p>HTML alternative</p>") } },
        ],
      } });
    throw new Error("Unexpected Google endpoint");
  };
  try {
    await assert.rejects(mail.readGmailMessage({ workspaceId: team, accountId: account.id, messageId: "abcdef123456" }), { status: 404 });
    await assert.rejects(mail.readGmailMessage({ workspaceId: "personal", accountId: account.id, messageId: "../wrong" }), { status: 400 });
    const result = await mail.readGmailMessage({ workspaceId: "personal", accountId: account.id, messageId: "abcdef123456" });
    assert.equal(result.subject, "Review the draft");
    assert.equal(result.from, "sender@example.com");
    assert.equal(result.text, "Please review by Friday.\nSecond line.");
    assert.equal(result.truncated, false);
    assert(!JSON.stringify(result).includes("ATTACHMENT SECRET"));
    assert(!JSON.stringify(result).includes("READ-ONLY-TEMP"));
    assert(calls.some((call) => call.url.includes("format=full")));
    assert(calls.every((call) => call.url.startsWith("https://oauth2.googleapis.com/") ||
      call.url.startsWith("https://gmail.googleapis.com/")));
    assert(!calls.some((call) => /\/send|\/modify|\/trash|\/attachments/.test(call.url)));
  } finally { globalThis.fetch = oldFetch; }
});

test("HTML-only Gmail messages are inert readable text, and oversized text is marked truncated", async () => {
  const account = mail.listMailAccounts("personal").find((row) => row.email === "restore@example.com");
  assert.ok(account);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "TEMP" });
    return Response.json({ threadId: "abcdef654321", payload: {
      mimeType: "text/html", headers: [], body: { data: Buffer.from(
        "<style>.hidden{color:red}</style><script>steal()</script><p>Visible &amp; safe</p>" + "Z".repeat(35_000),
      ).toString("base64url") },
    } });
  };
  try {
    const result = await mail.readGmailMessage({ workspaceId: "personal", accountId: account.id, messageId: "abcdef123456" });
    assert(result.text.includes("Visible & safe"));
    assert(!result.text.includes("<script>"));
    assert(!result.text.includes("steal()"));
    assert(!result.text.includes(".hidden"));
    assert.equal(result.text.length, 32_000);
    assert.equal(result.truncated, true);
  } finally { globalThis.fetch = oldFetch; }
});

test("Gmail detail endpoint never serves anonymous callers or accepts cross-workspace access", async () => {
  const route = await import("../app/api/mail/gmail/message/route.ts");
  const oldAuth = process.env.AI_EXECUTIVE_AUTH_ENABLED;
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  try {
    const response = await route.POST(new Request("https://lumi.example/api/mail/gmail/message", {
      method: "POST",
      headers: { origin: "https://lumi.example", "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "personal", accountId: "33333333-3333-4333-8333-333333333333", messageId: "abcdef123456" }),
    }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    if (oldAuth === undefined) delete process.env.AI_EXECUTIVE_AUTH_ENABLED;
    else process.env.AI_EXECUTIVE_AUTH_ENABLED = oldAuth;
  }
});


test("Windows-1250 and ISO-8859-2 MIME bodies retain Czech diacritics; unknown charsets use UTF-8", async () => {
  const account = mail.listMailAccounts("personal").find((row) => row.email === "restore@example.com");
  assert.ok(account);
  const expected = "Příliš žluťoučký kůň úpěl ďábelské ódy.";
  const fixtures = [
    {
      charset: 'text/plain; charset="windows-1250"',
      bytes: Buffer.from("50f8ed6c699a209e6c759d6f75e86bfd206bf9f220fa70ec6c20efe162656c736be920f364792e", "hex"),
    },
    {
      charset: "text/plain; charset=ISO-8859-2",
      bytes: Buffer.from("50f8ed6c69b920be6c75bb6f75e86bfd206bf9f220fa70ec6c20efe162656c736be920f364792e", "hex"),
    },
    {
      charset: "text/plain; charset=not-a-supported-charset",
      bytes: Buffer.from(expected, "utf8"),
    },
  ];
  const oldFetch = globalThis.fetch;
  try {
    for (const fixture of fixtures) {
      globalThis.fetch = async (target) => {
        if (String(target) === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: "TEMP-ACCESS" });
        if (String(target).includes("/gmail/v1/users/me/messages/abcdef123456?"))
          return Response.json({ threadId: "abcdef654321", payload: {
            mimeType: "text/plain",
            headers: [{ name: "CONTENT-TYPE", value: fixture.charset }],
            body: { data: fixture.bytes.toString("base64url") },
          } });
        throw new Error("Unexpected Google endpoint " + String(target));
      };
      const message = await mail.readGmailMessage({ workspaceId: "personal", accountId: account.id, messageId: "abcdef123456" });
      assert.equal(message.text, expected, fixture.charset);
      assert.equal(message.truncated, false);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test("empty or whitespace-only plain MIME alternative falls back to inert HTML text", async () => {
  const account = mail.listMailAccounts("personal").find((row) => row.email === "restore@example.com");
  assert.ok(account);
  const oldFetch = globalThis.fetch;
  const encode = (text) => Buffer.from(text).toString("base64url");
  globalThis.fetch = async (target) => {
    if (String(target) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "TEMP-ACCESS" });
    if (String(target).includes("/gmail/v1/users/me/messages/abcdef123456?"))
      return Response.json({ threadId: "abcdef654321", payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: encode(" \n\t ") } },
          { mimeType: "text/html", body: { data: encode("<script>steal()</script><p>Skutečný obsah &amp; text</p>") } },
        ],
      } });
    throw new Error("Unexpected Gmail URL");
  };
  try {
    const result = await mail.readGmailMessage({ workspaceId: "personal", accountId: account.id, messageId: "abcdef123456" });
    assert.match(result.text, /Skutečný obsah & text/);
    assert(!result.text.includes("steal()"));
    assert(!result.text.includes("<script>"));
    assert.equal(result.truncated, false);
  } finally { globalThis.fetch = oldFetch; }
});


test("Gmail conversation loads only the last 30 metadata records in order and refuses another workspace", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  database.prepare("INSERT OR REPLACE INTO mail_accounts (id, provider, workspace_id, email, encrypted_refresh_token, created_at, updated_at) VALUES (?, 'gmail', 'personal', 'thread-test@example.com', ?, 1, 1)")
    .run(id, mail.sealMail("TEST-THREAD-REFRESH"));
  await assert.rejects(mail.readGmailThread({ workspaceId: team, accountId: id, threadId: "abcdef123456" }), { status: 404 });
  await assert.rejects(mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId: "../steal" }), { status: 400 });
  const ids = Array.from({ length: 32 }, (_, i) => (i + 4096).toString(16).padStart(6, "0"));
  const requests = [];
  const original = globalThis.fetch;
  let concurrent = 0, peak = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(String(target));
    requests.push({ url, options });
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "TEST-ACCESS" });
    if (url.pathname === "/gmail/v1/users/me/threads/abcdef123456") {
      assert.equal(url.searchParams.get("format"), "minimal");
      assert.equal(url.searchParams.get("fields"), "id,messages(id,threadId)");
      assert.equal(url.searchParams.has("metadataHeaders"), false);
      return Response.json({ id: "abcdef123456", messages: ids.map((messageId) => ({
        id: messageId, threadId: "abcdef123456",
      })) });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      assert.equal(url.searchParams.get("format"), "metadata");
      assert.deepEqual(url.searchParams.getAll("metadataHeaders"), ["Subject", "From", "To", "Date"]);
      assert.equal(url.searchParams.get("fields"), "id,threadId,snippet,labelIds,payload/headers");
      const messageId = url.pathname.split("/").at(-1);
      const i = ids.indexOf(messageId);
      assert(i >= 2, "only 30 last messages are fetched");
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent--;
      return Response.json({
        id: messageId, threadId: "abcdef123456", snippet: "Preview " + i,
        payload: { headers: [{ name: "Subject", value: "Letter " + i }, { name: "From", value: "reader@example.com" }] },
        labelIds: i === 31 ? ["UNREAD"] : [],
        body: { data: "SECRET_MESSAGE_BODY_SHOULD_NOT_BE_INCLUDED" },
      });
    }
    throw new Error("Unexpected Google endpoint " + String(target));
  };
  try {
    const thread = await mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId: "abcdef123456" });
    assert.equal(thread.total, 32);
    assert.equal(thread.omitted, 2);
    assert.equal(thread.messages.length, 30);
    assert.equal(thread.messages[0].subject, "Letter 2");
    assert.equal(thread.messages.at(-1).subject, "Letter 31");
    assert.equal(thread.messages.at(-1).unread, true);
    assert.equal(thread.messages.at(-1).threadId, "abcdef123456");
    assert(!JSON.stringify(thread).includes("SECRET_MESSAGE_BODY_SHOULD_NOT_BE_INCLUDED"));
    assert(peak >= 2, "metadata requests use bounded concurrency");
    assert(peak <= 5, "maximum five concurrent detail reads");
    assert.equal(concurrent, 0);
    assert.equal(requests.filter((r) => r.url.pathname.includes("/messages/")).length, 30);
    assert(requests.every((r) => ["oauth2.googleapis.com", "gmail.googleapis.com"].includes(r.url.hostname)));
    assert(requests.every((r) => r.options.method !== "POST" || r.url.hostname === "oauth2.googleapis.com"));
  } finally { globalThis.fetch = original; }
});

test("Gmail thread with hundreds of large historical messages fetches only 30 summaries", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const threadId = "abcdef123456";
  const total = 650;
  const ids = Array.from({ length: total }, (_, i) => (i + 8192).toString(16).padStart(8, "0"));
  // If every historical metadata record were returned, 650 x 3,000 bytes
  // would exceed the old 1 MiB response guard. The minimal index stays small.
  const largeHistoricalSnippet = "DO_NOT_FETCH_HISTORICAL_SNIPPET_".repeat(100);
  assert(JSON.stringify(ids.map((messageId) => ({ id: messageId, snippet: largeHistoricalSnippet }))).length > 1024 * 1024);
  const original = globalThis.fetch;
  const fetched = [];
  const gone = ids.at(-3);
  globalThis.fetch = async (target) => {
    const url = new URL(String(target));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "TEST-ACCESS" });
    if (url.pathname === "/gmail/v1/users/me/threads/" + threadId) {
      assert.equal(url.searchParams.get("format"), "minimal");
      assert.equal(url.searchParams.get("fields"), "id,messages(id,threadId)");
      return Response.json({ id: threadId, messages: ids.map((messageId) => ({ id: messageId, threadId })) });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      const messageId = url.pathname.split("/").at(-1);
      fetched.push(messageId);
      assert(ids.indexOf(messageId) >= total - 30, "an older message was fetched");
      if (messageId === gone) return Response.json({ error: "gone" }, { status: 404 });
      return Response.json({
        id: messageId, threadId,
        snippet: "Recent " + messageId,
        payload: { headers: [{ name: "Subject", value: "Recent " + messageId }] },
      });
    }
    throw new Error("Unexpected URL " + String(target));
  };
  try {
    const thread = await mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId });
    assert.equal(thread.total, total);
    assert.equal(thread.omitted, total - 30);
    assert.equal(thread.messages.length, 29, "one vanished message does not hide the conversation");
    assert.deepEqual(thread.messages.map((message) => message.id), ids.slice(-30).filter((messageId) => messageId !== gone));
    assert.equal(fetched.length, 30);
    assert(!JSON.stringify(thread).includes(largeHistoricalSnippet));
  } finally { globalThis.fetch = original; }
});

test("Gmail thread fetch refuses vanished threads, invalid indexes and mismatching message membership", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const previous = globalThis.fetch;
  let mode = "vanished";
  globalThis.fetch = async (target) => {
    const url = new URL(String(target));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "TEST-ACCESS" });
    if (url.pathname.startsWith("/gmail/v1/users/me/threads/")) {
      if (mode === "vanished") return Response.json({ error: "not found" }, { status: 404 });
      if (mode === "invalid") return Response.json({ id: "different-thread", messages: [] });
      return Response.json({ id: "abcdef123456", messages: [{ id: "abcdef01", threadId: "abcdef123456" }] });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      return Response.json({ id: "abcdef01", threadId: "wrong-thread", snippet: "must not leak" });
    }
    throw new Error("Unexpected Google endpoint " + String(target));
  };
  try {
    await assert.rejects(mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId: "abcdef123456" }), { status: 404 });
    mode = "invalid";
    await assert.rejects(mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId: "abcdef123456" }), { status: 502 });
    mode = "mismatch";
    await assert.rejects(mail.readGmailThread({ workspaceId: "personal", accountId: id, threadId: "abcdef123456" }), { status: 502 });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mail_threads'").get().n, 0);
  } finally { globalThis.fetch = previous; }
});


test("Mail v4 opt-in, bounded initial and incremental History sync, metadata privacy and deletion", async () => {
  const workspaceId = "mail-v4-fixture";
  const accountId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const db = store.getDatabase();
  db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)").run("workspace:" + workspaceId,
    JSON.stringify({ id: "workspace:" + workspaceId, type: "workspace", workspaceId, title: "Mail v4",
      status: "active", properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: 1, updatedAt: 1 }), 1);
  db.prepare("INSERT INTO mail_accounts(id,provider,workspace_id,email,encrypted_refresh_token,created_at,updated_at) VALUES(?,'gmail',?,?,?,1,1)")
    .run(accountId, workspaceId, "sync@example.com", mail.sealMail("SYNC-REFRESH-SECRET"));
  assert.deepEqual(mail.listMailSyncStates(workspaceId), [], "disabled by default");
  assert.throws(() => mail.enableMailSync(workspaceId, accountId, 10), { status: 400 });
  assert.throws(() => mail.enableMailSync("personal", accountId, 30), { status: 404 });
  mail.enableMailSync(workspaceId, accountId, 7);
  assert.equal(mail.listMailSyncStates(workspaceId)[0].retentionDays, 7);
  assert.equal(mail.listMailSyncStates(workspaceId)[0].indexedCount, 0);
  const oldFetch = globalThis.fetch;
  const calls = [];
  const now = Date.now();
  let stage = "initial";
  const ids = ["abcdef0001", "abcdef0002", "abcdef0003", "abcdef0004"];
  globalThis.fetch = async (target, opts = {}) => {
    const url = new URL(String(target));
    calls.push({ url, opts });
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "SYNC-ACCESS-TOKEN" });
    assert.equal(opts.headers?.authorization, "Bearer SYNC-ACCESS-TOKEN");
    if (url.pathname === "/gmail/v1/users/me/profile")
      return Response.json({ emailAddress: "sync@example.com", historyId: stage === "expired" ? "300" : "100" });
    if (url.pathname === "/gmail/v1/users/me/messages") {
      assert.equal(url.searchParams.get("maxResults"), "25");
      return Response.json({ messages: url.searchParams.get("labelIds") === "INBOX"
        ? [{ id: ids[0] }, { id: ids[1] }] : [{ id: ids[1] }] });
    }
    if (url.pathname === "/gmail/v1/users/me/history") {
      assert.equal(url.searchParams.get("startHistoryId"), stage === "history" ? "100" : "200");
      if (stage === "expired") return Response.json({ error: "history expired" }, { status: 404 });
      return Response.json({ historyId: "200", history: [
        { id: "200", messagesAdded: [{ message: { id: ids[2] } }],
          messagesDeleted: [{ message: { id: ids[0] } }],
          labelsRemoved: [{ message: { id: ids[1] }, labelIds: ["INBOX"] }] },
      ] });
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/messages/")) {
      assert.equal(url.searchParams.get("format"), "metadata");
      assert.deepEqual(url.searchParams.getAll("metadataHeaders"), ["Subject", "From"]);
      const id = url.pathname.split("/").pop();
      if (id === ids[0] && stage === "expired") return Response.json({ error: "gone" }, { status: 404 });
      const labelIds = id === ids[1] ? ["SENT"] : ["INBOX", "UNREAD"];
      return Response.json({ id, threadId: "abcdef123456", internalDate: String(now),
        snippet: "NEVER_STORE_SNIPPET", payload: { headers: [
          { name: "Subject", value: "Topic " + id }, { name: "From", value: "friend@example.com" },
        ], body: { data: "NEVER_STORE_BODY" } }, labelIds });
    }
    throw new Error("Unexpected URL " + url);
  };
  try {
    const initial = await mail.syncMailAccount(workspaceId, accountId);
    assert.equal(initial.full, true);
    assert.equal(initial.updated, 2);
    assert.equal(mail.listMailSyncStates(workspaceId)[0].indexedCount, 2);
    assert.equal(db.prepare("SELECT history_id FROM mail_sync_accounts WHERE account_id=?").get(accountId).history_id, "100");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages WHERE account_id=?").get(accountId).n, 2);
    const stored = JSON.stringify(db.prepare("SELECT * FROM mail_sync_messages WHERE account_id=?").all(accountId));
    assert(!stored.includes("NEVER_STORE_SNIPPET"));
    assert(!stored.includes("NEVER_STORE_BODY"));
    assert(!stored.includes("SYNC-ACCESS-TOKEN"));
    assert(!stored.includes("SYNC-REFRESH-SECRET"));
    assert(calls.every((x) => x.url.hostname === "oauth2.googleapis.com" || x.url.hostname === "gmail.googleapis.com"));
    stage = "history";
    const incremental = await mail.syncMailAccount(workspaceId, accountId);
    assert.equal(incremental.full, false);
    assert.equal(db.prepare("SELECT history_id FROM mail_sync_accounts WHERE account_id=?").get(accountId).history_id, "200");
    assert.deepEqual(db.prepare("SELECT message_id FROM mail_sync_messages WHERE account_id=? ORDER BY message_id").all(accountId).map(x => x.message_id),
      [ids[1], ids[2]]);
    stage = "expired";
    const recovered = await mail.syncMailAccount(workspaceId, accountId);
    assert.equal(recovered.full, true, "expired history automatically falls back to bootstrap");
    assert.equal(db.prepare("SELECT history_id FROM mail_sync_accounts WHERE account_id=?").get(accountId).history_id, "300");
    assert.deepEqual(db.prepare("SELECT message_id FROM mail_sync_messages WHERE account_id=? ORDER BY message_id").all(accountId).map(x => x.message_id),
      [ids[1]]);
    mail.enableMailSync(workspaceId, accountId, 30);
    assert.equal(mail.listMailSyncStates(workspaceId)[0].retentionDays, 30);
    mail.disableMailSync(workspaceId, accountId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages WHERE account_id=?").get(accountId).n, 0);
    assert.deepEqual(mail.listMailSyncStates(workspaceId), []);
    await assert.rejects(mail.syncMailAccount(workspaceId, accountId), { status: 404 });
    assert.equal(mail.listMailAccounts(workspaceId).length, 1, "disabling sync keeps the Gmail connection");
  } finally { globalThis.fetch = oldFetch; }
});

test("Mail v4 concurrent disable-and-reenable cannot commit stale network results", async () => {
  const workspaceId = "mail-v4-fixture";
  const accountId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const db = store.getDatabase();
  mail.enableMailSync(workspaceId, accountId, 30);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (target) => {
    const url = new URL(String(target));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "SYNC-ACCESS-TOKEN" });
    if (url.pathname === "/gmail/v1/users/me/profile") {
      mail.disableMailSync(workspaceId, accountId);
      mail.enableMailSync(workspaceId, accountId, 30);
      return Response.json({ historyId: "400" });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") return Response.json({ messages: [] });
    throw new Error("Unexpected Google URL " + url);
  };
  try {
    await assert.rejects(mail.syncMailAccount(workspaceId, accountId), { status: 409 });
    assert.equal(db.prepare("SELECT history_id FROM mail_sync_accounts WHERE account_id=?").get(accountId).history_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages WHERE account_id=?").get(accountId).n, 0);
  } finally { globalThis.fetch = oldFetch; }
  db.prepare("DELETE FROM mail_accounts WHERE id=?").run(accountId);
  assert.deepEqual(mail.listMailSyncStates(workspaceId), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages WHERE account_id=?").get(accountId).n, 0);
});
