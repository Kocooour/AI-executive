import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  HUMANWIKI_CONSENT_INTENT_SCHEMA, HUMANWIKI_CONSENT_SOURCES,
  appendHumanWikiConsentIntent, createHumanWikiConsentIntentSchema,
  humanWikiConsentIntentReadiness,
} from "../lib/humanwiki-consent-intents.mjs";
import {
  HumanWikiH1RealEntryBlockedError, denyHumanWikiH1RealImport,
} from "../lib/humanwiki-h1-real-entry.mjs";

const key = Buffer.alloc(32, 0x65);
const owner = { ownerUserId: "owner-alpha", privateAreaId: "private-alpha" };
const other = { ownerUserId: "owner-beta", privateAreaId: "private-beta" };
const makeCommand = (extra = {}) => ({
  commandId: randomUUID(),
  sourceType: "chatgpt_user_export",
  decision: "grant_requested",
  purpose: "humanwiki_context_bootstrap",
  retentionDays: 90,
  expectedRevision: 0,
  explicitConfirmation: true,
  ...extra,
});

function withLedger(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-h1-real3-consent-"));
  const file = path.join(dir, "intents.sqlite");
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;");
    createHumanWikiConsentIntentSchema(db);
    fn({ db, file, dir, reopen() {
      if (db.isOpen) db.close();
      db = new DatabaseSync(file);
      return db;
    } });
  } finally {
    if (db?.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("H1-real.3 source-specific intent persists across SQLite reopen; never authorizes import", () =>
  withLedger(({ db, file, reopen }) => {
    assert.deepEqual(HUMANWIKI_CONSENT_SOURCES, [
      "chatgpt_user_export", "claude_user_export",
    ]);
    const request = makeCommand();
    const recorded = appendHumanWikiConsentIntent(db, key, owner, request, 1_800_000_000_000);
    assert.deepEqual(recorded, {
      ok: true, replayed: false, revision: 1,
      importAuthorized: false, withdrawalComplete: false,
    });
    const before = humanWikiConsentIntentReadiness(db, key, owner, request.sourceType);
    assert.equal(before.schema, HUMANWIKI_CONSENT_INTENT_SCHEMA);
    assert.equal(before.revision, 1);
    assert.equal(before.importAuthorized, false);
    assert.equal(before.consentVerified, false);
    assert.equal(before.independentWitnessVerified, false);
    assert.equal(humanWikiConsentIntentReadiness(db, key, owner, "claude_user_export").revision, 0);
    assert.equal(humanWikiConsentIntentReadiness(db, key, other, request.sourceType).revision, 0);

    const reopened = reopen();
    assert.equal(humanWikiConsentIntentReadiness(reopened, key, owner, request.sourceType).revision, 1);
    assert.deepEqual(appendHumanWikiConsentIntent(reopened, key, owner, request, 1_900_000_000_000), {
      ok: true, replayed: true, revision: 1,
      importAuthorized: false, withdrawalComplete: false,
    });
    // The ledger stores pseudonymous HMAC scopes, never raw identifiers or content.
    const bytes = readFileSync(file).toString("utf8");
    assert.ok(!bytes.includes(owner.ownerUserId));
    assert.ok(!bytes.includes(owner.privateAreaId));
    assert.ok(!bytes.includes("private-conversation-body"));
  }));

test("H1-real.3 maintains independent source and owner/Area revisions with strict CAS", () =>
  withLedger(({ db }) => {
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand()).ok, true);
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      sourceType: "claude_user_export",
    })).revision, 1);
    assert.equal(appendHumanWikiConsentIntent(db, key, other, makeCommand()).revision, 1);
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand()).reason,
      "revision_conflict");
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      decision: "withdrawal_requested", expectedRevision: 1, retentionDays: null,
    })).revision, 2);
    assert.equal(humanWikiConsentIntentReadiness(db, key, owner, "chatgpt_user_export").revision, 2);
    assert.equal(humanWikiConsentIntentReadiness(db, key, other, "chatgpt_user_export").revision, 1);
  }));

test("H1-real.3 same command UUID cannot be reused with changed scope or payload", () =>
  withLedger(({ db }) => {
    const c = makeCommand();
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, c).ok, true);
    for (const [scope, command] of [
      [other, c],
      [owner, { ...c, retentionDays: 180 }],
      [owner, { ...c, sourceType: "claude_user_export" }],
      [owner, { ...c, expectedRevision: 1 }],
    ]) {
      const result = appendHumanWikiConsentIntent(db, key, scope, command);
      assert.equal(result.reason, "idempotency_conflict");
      assert.equal(result.importAuthorized, false);
    }
    assert.equal(humanWikiConsentIntentReadiness(db, key, owner, c.sourceType).revision, 1);
  }));

test("H1-real.3 rejects forged scope, accidental implied consent and forbidden source/content", () =>
  withLedger(({ db }) => {
    const candidates = [
      makeCommand({ sourceType: "gmail" }),
      makeCommand({ sourceType: "icloud" }),
      makeCommand({ sourceType: "chatgpt_user_export", explicitConfirmation: false }),
      makeCommand({ retentionDays: 999999 }),
      makeCommand({ retentionDays: "90" }),
      makeCommand({ purpose: "marketing" }),
      makeCommand({ excerpt: "Sensitive private body" }),
      makeCommand({ originalEmailAddress: "a@example.test" }),
      makeCommand({ expectedRevision: -1 }),
      makeCommand({ commandId: "fake-command" }),
      makeCommand({ decision: "withdrawal_requested", retentionDays: 90 }),
      makeCommand({ decision: "grant_requested", retentionDays: null }),
    ];
    for (const candidate of candidates) {
      const result = appendHumanWikiConsentIntent(db, key, owner, candidate);
      assert.equal(result.reason, "invalid_request", JSON.stringify(candidate));
      assert.equal(result.importAuthorized, false);
    }
    for (const scope of [
      { ownerUserId: "foreign", privateAreaId: "all" },
      { ownerUserId: "foreign", privateAreaId: "../escape" },
      { ...owner, claimedOwner: true },
    ]) {
      assert.equal(appendHumanWikiConsentIntent(db, key, scope, makeCommand()).ok, false);
    }
    assert.equal(humanWikiConsentIntentReadiness(db, key, owner, "chatgpt_user_export").revision, 0);
  }));

test("H1-real.3 detects altered history, lost key and missing rows; SQL updates are blocked", () =>
  withLedger(({ db }) => {
    const first = makeCommand();
    const second = makeCommand({ sourceType: "claude_user_export" });
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, first).ok, true);
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, second).ok, true);
    assert.throws(() => db.exec("DELETE FROM humanwiki_consent_intent_events"));
    assert.throws(() => db.exec("UPDATE humanwiki_consent_intent_events SET retention_days=30"));
    assert.equal(humanWikiConsentIntentReadiness(db, Buffer.alloc(32, 0x33), owner,
      "chatgpt_user_export").reason, "unavailable");
    db.exec("DROP TRIGGER humanwiki_consent_intent_no_update");
    db.exec("UPDATE humanwiki_consent_intent_events SET retention_days=30 WHERE seq=1");
    const status = humanWikiConsentIntentReadiness(db, key, owner, "chatgpt_user_export");
    assert.equal(status.reason, "unavailable");
    assert.equal(status.importAuthorized, false);
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      expectedRevision: 1,
    })).reason, "unavailable");
  }));

test("H1-real.3 restore of old DB cannot be mistaken for completed withdrawal without witness", () =>
  withLedger(({ db, file, dir, reopen }) => {
    const c = makeCommand();
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, c).ok, true);
    // A DB and its local HMAC chain can both be restored coherently to a past state.
    const oldBackup = path.join(dir, "old.sqlite");
    copyFileSync(file, oldBackup);
    assert.equal(appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      decision: "withdrawal_requested", retentionDays: null, expectedRevision: 1,
    })).revision, 2);
    assert.equal(humanWikiConsentIntentReadiness(db, key, owner, c.sourceType).withdrawalComplete, false);
    db.close();
    copyFileSync(oldBackup, file);
    const restored = reopen();
    const report = humanWikiConsentIntentReadiness(restored, key, owner, c.sourceType);
    assert.equal(report.revision, 1, "local ledger alone cannot catch coherent old restore");
    assert.equal(report.importAuthorized, false);
    assert.equal(report.independentWitnessVerified, false);
    assert.equal(report.withdrawalComplete, false);
    assert.throws(() => denyHumanWikiH1RealImport({ sourceType: c.sourceType }, c),
      HumanWikiH1RealEntryBlockedError);
  }));

test("H1-real.3 cannot record a non-durable in-memory consent intent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createHumanWikiConsentIntentSchema(db);
    const result = appendHumanWikiConsentIntent(db, key, owner, makeCommand());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unavailable");
    assert.equal(result.importAuthorized, false);
  } finally {
    db.close();
  }
});


test("H1-real.3 allows durable intents only in crash-safe DELETE journal mode", () => {
  for (const mode of ["OFF", "MEMORY", "WAL"]) {
    withLedger(({ db }) => {
      const selected = db.prepare("PRAGMA journal_mode=" + mode).get();
      assert.equal(selected.journal_mode, mode.toLowerCase());
      const denied = appendHumanWikiConsentIntent(db, key, owner, makeCommand());
      assert.equal(denied.ok, false, mode);
      assert.equal(denied.reason, "unavailable", mode);
      assert.equal(denied.importAuthorized, false);
      const read = humanWikiConsentIntentReadiness(db, key, owner, "chatgpt_user_export");
      assert.equal(read.ok, false, mode);
      assert.equal(read.reason, "unavailable", mode);
      assert.equal(read.importAuthorized, false);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM humanwiki_consent_intent_events").get().n, 0);
      // Explicitly restore the supported journal mode: same DB may now record
      // an intent, but never grants authority to import real exports.
      assert.equal(db.prepare("PRAGMA journal_mode=DELETE").get().journal_mode, "delete");
      const accepted = appendHumanWikiConsentIntent(db, key, owner, makeCommand());
      assert.equal(accepted.ok, true);
      assert.equal(accepted.importAuthorized, false);
    });
  }
});

// A direct SQL fixture efficiently creates a *cryptographically valid* 10k
// history. Calling append 10k times would make the regression O(n²) because
// production verifies the entire local HMAC chain for every append.
function seedValidConsentHistory(db, targetCount) {
  const h = (domain, value) => createHmac("sha256", key)
    .update(domain).update("\0").update(value).digest("hex");
  const scope = h("humanwiki:consent-intent:scope:v1",
    JSON.stringify([owner.ownerUserId, owner.privateAreaId]));
  const statement = db.prepare(`INSERT INTO humanwiki_consent_intent_events (
    seq,scope_token,source_type,decision,purpose,retention_days,command_id,
    expected_revision,revision,occurred_at_ms,previous_mac,event_mac
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let previousMac = "0".repeat(64);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let seq = 1; seq <= targetCount; seq++) {
      const values = [
        seq, scope, "chatgpt_user_export", "grant_requested",
        "humanwiki_context_bootstrap", 90, randomUUID(),
        seq - 1, seq, 1_800_000_000_000 + seq, previousMac,
      ];
      const eventMac = h("humanwiki:consent-intent:event:v1",
        JSON.stringify(values));
      statement.run(...values, eventMac);
      previousMac = eventMac;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("H1-real.3 keeps withdrawal capacity available after grant budget is exhausted", () =>
  withLedger(({ db, reopen }) => {
    seedValidConsentHistory(db, 9000);
    const deniedGrant = appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      expectedRevision: 9000,
    }));
    assert.equal(deniedGrant.reason, "capacity");
    assert.equal(deniedGrant.importAuthorized, false);

    const withdrawal = makeCommand({
      decision: "withdrawal_requested", retentionDays: null, expectedRevision: 9000,
    });
    const recorded = appendHumanWikiConsentIntent(db, key, owner, withdrawal);
    assert.deepEqual(recorded, {
      ok: true, replayed: false, revision: 9001,
      importAuthorized: false, withdrawalComplete: false,
    });
    assert.deepEqual(appendHumanWikiConsentIntent(db, key, owner, withdrawal), {
      ok: true, replayed: true, revision: 9001,
      importAuthorized: false, withdrawalComplete: false,
    });
    const restored = reopen();
    assert.equal(humanWikiConsentIntentReadiness(restored, key, owner,
      "chatgpt_user_export").revision, 9001);
    assert.equal(appendHumanWikiConsentIntent(restored, key, owner, makeCommand({
      expectedRevision: 9001,
    })).reason, "capacity", "grants cannot consume withdrawal reserve");
  }));

test("H1-real.3 last reserved slot accepts withdrawal and a full store fails closed", () =>
  withLedger(({ db }) => {
    // Synthetic near-full ledger; the append limit is 10,000 total events.
    seedValidConsentHistory(db, 9999);
    const command = makeCommand({
      decision: "withdrawal_requested", retentionDays: null, expectedRevision: 9999,
    });
    const recorded = appendHumanWikiConsentIntent(db, key, owner, command);
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, 10000);
    assert.equal(recorded.withdrawalComplete, false);
    assert.deepEqual(appendHumanWikiConsentIntent(db, key, owner, command), {
      ok: true, replayed: true, revision: 10000,
      importAuthorized: false, withdrawalComplete: false,
    });
    const denied = appendHumanWikiConsentIntent(db, key, owner, makeCommand({
      decision: "withdrawal_requested", retentionDays: null, expectedRevision: 10000,
    }));
    assert.equal(denied.reason, "capacity");
    assert.equal(denied.importAuthorized, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM humanwiki_consent_intent_events").get().n, 10000);
  }));
