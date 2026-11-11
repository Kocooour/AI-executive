/**
 * H1-real.3a — content-free, durable consent-INTENT ledger (not consent authority).
 *
 * This module never handles export bytes, grants import rights, or completes a
 * withdrawal. Owner/Area identifiers must be supplied only by trusted server
 * code AFTER current live authorization; no HTTP route calls this yet.
 * A separate external anti-rollback witness is required before any consent
 * event can become an authorization or a completed revocation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const HUMANWIKI_CONSENT_INTENT_SCHEMA = "humanwiki_consent_intent_v1";
export const HUMANWIKI_CONSENT_SOURCES = Object.freeze([
  "chatgpt_user_export", "claude_user_export",
]);
const SOURCE = new Set(HUMANWIKI_CONSENT_SOURCES);
const DECISIONS = new Set(["grant_requested", "withdrawal_requested"]);
const ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const AREA = /^[A-Za-z0-9_.:@-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const MAX_EVENTS = 10000;
// Only grant intents may consume the first 9000 slots. The final 1000
// are reserved for withdrawal intents until a witnessed continuation exists.
// Even a recorded withdrawal remains NON-authorizing and NOT completed.
const WITHDRAWAL_RESERVED_EVENTS = 1000;
const GRANT_EVENT_LIMIT = MAX_EVENTS - WITHDRAWAL_RESERVED_EVENTS;
const PURPOSE = "humanwiki_context_bootstrap";
const RETENTION_DAYS = new Set([30, 90, 180, 365]);
const COMMAND_FIELDS = [
  "commandId", "decision", "expectedRevision", "explicitConfirmation",
  "purpose", "retentionDays", "sourceType",
];
const EMPTY_MAC = "0".repeat(64);

const isRecord = value =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactly = (value, fields) =>
  isRecord(value) && Object.keys(value).sort().join(",") === [...fields].sort().join(",");
const validKey = key =>
  (typeof key === "string" || Buffer.isBuffer(key)) && Buffer.byteLength(key) >= 32;
const mac = (key, domain, data) =>
  createHmac("sha256", key).update(domain).update("\0").update(data).digest("hex");
const safeEqual = (a, b) =>
  HEX.test(a) && HEX.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const scopeToken = (key, { ownerUserId, privateAreaId }) =>
  mac(key, "humanwiki:consent-intent:scope:v1", JSON.stringify([ownerUserId, privateAreaId]));
const rowPayload = row => JSON.stringify([
  row.seq, row.scope_token, row.source_type, row.decision, row.purpose,
  row.retention_days, row.command_id, row.expected_revision, row.revision,
  row.occurred_at_ms, row.previous_mac,
]);
const rowMac = (key, row) => mac(key, "humanwiki:consent-intent:event:v1", rowPayload(row));

function validScope(scope) {
  return exactly(scope, ["ownerUserId", "privateAreaId"]) &&
    typeof scope.ownerUserId === "string" && ID.test(scope.ownerUserId) &&
    typeof scope.privateAreaId === "string" && AREA.test(scope.privateAreaId) &&
    scope.privateAreaId !== "all" && scope.privateAreaId !== "my-plan";
}

function validCommand(command) {
  return exactly(command, COMMAND_FIELDS) &&
    typeof command.commandId === "string" && UUID.test(command.commandId) &&
    SOURCE.has(command.sourceType) && DECISIONS.has(command.decision) &&
    command.purpose === PURPOSE &&
    command.explicitConfirmation === true &&
    Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0 &&
    (command.decision === "grant_requested"
      ? RETENTION_DAYS.has(command.retentionDays)
      : command.retentionDays === null);
}

/**
 * Canonical append-only SQLite schema. SQLite removes "IF NOT EXISTS" when
 * persisting SQL in sqlite_master. Check ALL declarations on every read/write:
 * a valid HMAC chain alone cannot prove the no-update/no-delete triggers exist.
 */
const SCHEMA_OBJECTS = [
  { type: "table", name: "humanwiki_consent_intent_events",
    table: "humanwiki_consent_intent_events", sql: `CREATE TABLE IF NOT EXISTS humanwiki_consent_intent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_token TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('chatgpt_user_export','claude_user_export')),
      decision TEXT NOT NULL CHECK(decision IN ('grant_requested','withdrawal_requested')),
      purpose TEXT NOT NULL CHECK(purpose = 'humanwiki_context_bootstrap'),
      retention_days INTEGER,
      command_id TEXT NOT NULL UNIQUE,
      expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms > 0),
      previous_mac TEXT NOT NULL,
      event_mac TEXT NOT NULL,
      CHECK(
        (decision = 'grant_requested' AND retention_days IN (30,90,180,365))
        OR (decision = 'withdrawal_requested' AND retention_days IS NULL)
      )
    )` },
  { type: "index", name: "humanwiki_consent_intent_scope_idx",
    table: "humanwiki_consent_intent_events", sql: `CREATE INDEX IF NOT EXISTS humanwiki_consent_intent_scope_idx
      ON humanwiki_consent_intent_events(scope_token,source_type,revision)` },
  { type: "trigger", name: "humanwiki_consent_intent_no_update",
    table: "humanwiki_consent_intent_events", sql: `CREATE TRIGGER IF NOT EXISTS humanwiki_consent_intent_no_update
      BEFORE UPDATE ON humanwiki_consent_intent_events
      BEGIN SELECT RAISE(ABORT,'append_only'); END` },
  { type: "trigger", name: "humanwiki_consent_intent_no_delete",
    table: "humanwiki_consent_intent_events", sql: `CREATE TRIGGER IF NOT EXISTS humanwiki_consent_intent_no_delete
      BEFORE DELETE ON humanwiki_consent_intent_events
      BEGIN SELECT RAISE(ABORT,'append_only'); END` },
];

export function assertHumanWikiConsentIntentSchema(db) {
  const found = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name IN ('humanwiki_consent_intent_events',
      'humanwiki_consent_intent_scope_idx',
      'humanwiki_consent_intent_no_update',
      'humanwiki_consent_intent_no_delete')`).all();
  if (found.length !== SCHEMA_OBJECTS.length) throw Error("unavailable");
  const observed = new Map(found.map(row => [row.name, row]));
  for (const definition of SCHEMA_OBJECTS) {
    const row = observed.get(definition.name);
    const expected = definition.sql.replace(" IF NOT EXISTS ", " ");
    if (!row || row.type !== definition.type ||
        row.tbl_name !== definition.table || row.sql !== expected)
      throw Error("unavailable");
  }
}

/**
 * Operator-only bootstrap for an isolated registry; DDL is one SQLite
 * transaction. An interrupted initialization must leave no partial table,
 * index or trigger set. Existing incompatible objects fail closed.
 */
export function createHumanWikiConsentIntentSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const definition of SCHEMA_OBJECTS) db.exec(definition.sql + ";");
    assertHumanWikiConsentIntentSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
    throw error;
  }
}

/**
 * Full verification at each read/write, not just the tail: failed integrity,
 * missing key, gaps, foreign history or changed contents all fail closed.
 * A clean but rolled-back DB cannot be detected locally; NO import can use it.
 */
function inspectHistory(db, key) {
  // Even read-only readiness must not present a ledger in an unsafe SQLite
  // journal mode as durable evidence. A writer also checks while locked.
  const mode = db.prepare("PRAGMA journal_mode").get();
  if (mode?.journal_mode !== "delete") throw Error("unavailable");
  assertHumanWikiConsentIntentSchema(db);
  const check = db.prepare("PRAGMA quick_check").get();
  if (!check || Object.values(check)[0] !== "ok") throw Error("unavailable");
  const rows = db.prepare(`SELECT seq,scope_token,source_type,decision,purpose,
    retention_days,command_id,expected_revision,revision,occurred_at_ms,
    previous_mac,event_mac FROM humanwiki_consent_intent_events ORDER BY seq`).all();
  if (rows.length > MAX_EVENTS) throw Error("unavailable");
  const revisions = new Map();
  let prior = EMPTY_MAC;
  let lastSeq = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq !== lastSeq + 1 ||
        !HEX.test(row.scope_token) || !SOURCE.has(row.source_type) ||
        !DECISIONS.has(row.decision) || row.purpose !== PURPOSE ||
        !UUID.test(row.command_id) ||
        !Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms <= 0 ||
        !safeEqual(row.previous_mac, prior) ||
        !safeEqual(row.event_mac, rowMac(key, row))) throw Error("unavailable");
    const scope = row.scope_token + ":" + row.source_type;
    const previousRevision = revisions.get(scope) ?? 0;
    if (row.expected_revision !== previousRevision ||
        row.revision !== previousRevision + 1 ||
        (row.decision === "grant_requested"
          ? !RETENTION_DAYS.has(row.retention_days)
          : row.retention_days !== null)) throw Error("unavailable");
    revisions.set(scope, row.revision);
    lastSeq = row.seq;
    prior = row.event_mac;
  }
  return { rows, revisions, prior, lastSeq };
}

/** Always non-authorizing: not a grant, an importer toggle or a witness. */
export function humanWikiConsentIntentReadiness(db, key, trustedScope, sourceType) {
  try {
    if (!validKey(key) || !validScope(trustedScope) || !SOURCE.has(sourceType))
      return { ok: false, reason: "invalid_request", importAuthorized: false };
    const history = inspectHistory(db, key);
    const revision = history.revisions.get(scopeToken(key, trustedScope) + ":" + sourceType) ?? 0;
    return {
      ok: true, schema: HUMANWIKI_CONSENT_INTENT_SCHEMA,
      revision, recordedEvents: revision, importAuthorized: false,
      consentVerified: false, withdrawalComplete: false,
      independentWitnessVerified: false,
    };
  } catch {
    return { ok: false, reason: "unavailable", importAuthorized: false };
  }
}

/**
 * H1-real.8: authoritative, scope-bound source-intent observation for the
 * real owner-only HTTP consumer. Never returns identifiers, HMAC tokens,
 * evidence or authorization; a withdrawal *intent* is not an erasure ACK.
 * The complete local HMAC history and canonical append-only schema must be
 * validated before any per-source result is derived.
 */
export function humanWikiConsentIntentSourceStates(db, key, trustedScope) {
  try {
    if (!validKey(key) || !validScope(trustedScope)) throw Error("unavailable");
    const history = inspectHistory(db, key);
    const token = scopeToken(key, trustedScope);
    const sources = {};
    for (const sourceType of HUMANWIKI_CONSENT_SOURCES) {
      const revision = history.revisions.get(token + ":" + sourceType) ?? 0;
      // Global ordering is immutable; the last scoped event is the latest
      // source-specific request. Foreign scopes never affect this result.
      let latestIntent = null;
      for (let i = history.rows.length - 1; i >= 0; i--) {
        const row = history.rows[i];
        if (row.scope_token === token && row.source_type === sourceType) {
          latestIntent = row.decision;
          break;
        }
      }
      if ((revision === 0) !== (latestIntent === null)) throw Error("unavailable");
      sources[sourceType] = { revision, latestIntent };
    }
    return {
      ok: true, sources,
      sequence: history.lastSeq, digest: history.prior,
      importAuthorized: false, consentVerified: false,
      independentWitnessVerified: false, withdrawalComplete: false,
    };
  } catch {
    return { ok: false, reason: "unavailable",
      importAuthorized: false, consentVerified: false,
      independentWitnessVerified: false, withdrawalComplete: false };
  }
}

/**
 * Record a source-specific preference only, after an upstream owner-private
 * Area check. ExplicitConfirmation is not proof of a real user's authenticated
 * consent until a later route and independently anchored revocation protocol
 * are reviewed. A retry with identical commandId is idempotent.
 */
export function appendHumanWikiConsentIntent(db, key, trustedScope, command, nowMs = Date.now()) {
  try {
    if (!validKey(key) || !validScope(trustedScope) || !validCommand(command) ||
        !Number.isSafeInteger(nowMs) || nowMs <= 0) {
      return { ok: false, reason: "invalid_request", importAuthorized: false };
    }
    // Consent intents must be durable even if the caller forgot to configure
    // SQLite for this connection. Reject in-memory databases altogether.
    const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
    if (!main || typeof main.file !== "string" || !main.file.startsWith("/"))
      return { ok: false, reason: "unavailable", importAuthorized: false };
    db.exec("PRAGMA synchronous=FULL");
    const sync = db.prepare("PRAGMA synchronous").get();
    if (!sync || Number(sync.synchronous) < 2) throw Error("unavailable");
    db.exec("BEGIN IMMEDIATE");
    // Check the active journal mode *under the write lock*: an existing
    // connection may have switched to OFF/MEMORY/WAL between opening and
    // committing. This isolated single-file ledger intentionally supports
    // DELETE only; WAL sidecars need a separate pinned-backup contract.
    const journal = db.prepare("PRAGMA journal_mode").get();
    if (journal?.journal_mode !== "delete") throw Error("unavailable");
    const history = inspectHistory(db, key);
    const token = scopeToken(key, trustedScope);
    const existing = history.rows.find(row => row.command_id === command.commandId);
    if (existing) {
      const equal = existing.scope_token === token &&
        existing.source_type === command.sourceType &&
        existing.decision === command.decision && existing.purpose === command.purpose &&
        existing.retention_days === command.retentionDays &&
        existing.expected_revision === command.expectedRevision;
      db.exec("COMMIT");
      return equal
        ? { ok: true, replayed: true, revision: existing.revision, importAuthorized: false,
          withdrawalComplete: false }
        : { ok: false, reason: "idempotency_conflict", importAuthorized: false };
    }
    const revision = history.revisions.get(token + ":" + command.sourceType) ?? 0;
    if (revision !== command.expectedRevision) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "revision_conflict", importAuthorized: false };
    }
    // Check the GLOBAL slot budget after idempotency lookup and CAS, while
    // holding BEGIN IMMEDIATE. Grants must not consume withdrawal reserve.
    // Once the entire ledger is exhausted, fail closed; a later witnessed
    // continuation/rotation (not implemented) is required.
    const limit = command.decision === "grant_requested" ? GRANT_EVENT_LIMIT : MAX_EVENTS;
    if (history.rows.length >= limit) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "capacity", importAuthorized: false };
    }
    const seq = history.lastSeq + 1;
    const row = {
      seq, scope_token: token, source_type: command.sourceType,
      decision: command.decision, purpose: command.purpose,
      retention_days: command.retentionDays, command_id: command.commandId,
      expected_revision: revision, revision: revision + 1,
      occurred_at_ms: nowMs, previous_mac: history.prior,
    };
    db.prepare(`INSERT INTO humanwiki_consent_intent_events
      (seq,scope_token,source_type,decision,purpose,retention_days,command_id,
       expected_revision,revision,occurred_at_ms,previous_mac,event_mac)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.seq, row.scope_token, row.source_type, row.decision, row.purpose,
      row.retention_days, row.command_id, row.expected_revision, row.revision,
      row.occurred_at_ms, row.previous_mac, rowMac(key, row),
    );
    db.exec("COMMIT");
    return { ok: true, replayed: false, revision: row.revision,
      importAuthorized: false, withdrawalComplete: false };
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    return { ok: false, reason: "unavailable", importAuthorized: false };
  }
}

/**
 * H1-real.3b: read-only, locally authenticated HMAC history head.
 * The digest is a non-content-bearing opaque chain checkpoint, not consent,
 * a witness receipt, a proof of current owner ACL or a release capability.
 * A coherent older database may still produce a valid local head.
 */
export function humanWikiConsentIntentLocalHead(db, key) {
  try {
    if (!validKey(key)) return {
      ok: false, reason: "unavailable", importAuthorized: false,
    };
    const head = inspectHistory(db, key);
    return {
      ok: true, sequence: head.lastSeq, digest: head.prior,
      importAuthorized: false, independentWitnessVerified: false,
    };
  } catch {
    return { ok: false, reason: "unavailable", importAuthorized: false };
  }
}
