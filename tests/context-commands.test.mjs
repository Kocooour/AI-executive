import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-commands-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const subjects = await import("../lib/context-subjects.ts");
const store = await import("../lib/server-store.ts");
const migrations = await import("../lib/schema-migrations.ts");

const db = () => store.getDatabase();
const count = (sql, ...args) => Number(db().prepare(sql).get(...args).count);
const eventCount = (objectId) => count("SELECT COUNT(*) AS count FROM context_change_events WHERE object_id = ?", objectId);
const commandCount = (key) => count("SELECT COUNT(*) AS count FROM context_commands WHERE idempotency_key = ?", key);

function claimInput(overrides = {}) {
  return { commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "preference",
    literal: { type: "string", value: "Quiet mornings" }, freshness: "current", sensitivity: "normal", ...overrides };
}
const updateInput = (claim, overrides = {}) => ({ commandId: randomUUID(), workspaceId: "personal", id: claim.id,
  expectedRevision: claim.revision, predicate: claim.predicate, literal: claim.literal, freshness: claim.freshness,
  sensitivity: claim.sensitivity, ...overrides });
const review = (claim, decision) => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal",
  id: claim.id, expectedRevision: claim.revision, decision }).claim;
const subjectInput = (overrides = {}) => ({ commandId: randomUUID(), id: randomUUID(), workspaceId: "personal",
  expectedRevision: 0, type: "person", title: `Osoba ${randomUUID()}`, ...overrides });
const boom = () => { throw new Error("forced failure"); };

test("a failure after the claim mutation leaves no object change, event or command, and the retry succeeds once", () => {
  for (const hook of ["afterMutate", "beforeCommit"]) {
    const input = claimInput();
    assert.throws(() => claims.createOwnerClaim(input, { [hook]: boom }), /forced failure/);
    assert.equal(claims.listOwnerClaims("personal").some((claim) => claim.id === input.id), false);
    assert.equal(eventCount(input.id), 0);
    assert.equal(commandCount(input.commandId), 0);
    const retry = claims.createOwnerClaim(input);
    assert.equal(retry.replayed, false);
    assert.equal(retry.changed, true);
    assert.equal(eventCount(input.id), 1);
    assert.equal(commandCount(input.commandId), 1);
  }
});

test("a failed update, review and archive roll back the whole command", () => {
  const claim = claims.createOwnerClaim(claimInput()).claim;
  const update = updateInput(claim, { literal: { type: "string", value: "Changed" } });
  assert.throws(() => claims.updateOwnerClaim(update, { beforeCommit: boom }), /forced failure/);
  assert.throws(() => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: claim.id,
    expectedRevision: claim.revision, decision: "confirmed" }, { afterMutate: boom }), /forced failure/);
  assert.throws(() => claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: claim.id,
    expectedRevision: claim.revision }, { afterMutate: boom }), /forced failure/);
  const stored = claims.listOwnerClaims("personal").find((item) => item.id === claim.id);
  assert.equal(stored.revision, claim.revision);
  assert.equal(stored.literal.value, "Quiet mornings");
  assert.equal(stored.reviewStatus, "proposed");
  assert.equal(stored.archivedAt, null);
  assert.equal(eventCount(claim.id), 1);
  assert.equal(claims.listClaimReviewEvents("personal", claim.id).length, 0);
  assert.equal(commandCount(update.commandId), 0);
  assert.equal(claims.updateOwnerClaim(update).claim.revision, claim.revision + 1);
});

test("a failed subject command rolls back and the retry succeeds once", () => {
  const input = subjectInput();
  assert.throws(() => subjects.createStandaloneSubject(input, { afterMutate: boom }), /forced failure/);
  assert.equal(eventCount(input.id), 0);
  assert.equal(commandCount(input.commandId), 0);
  assert.throws(() => subjects.getStandaloneSubject("personal", input.id), (error) => error.code === "not_found");
  assert.equal(subjects.createStandaloneSubject(input).replayed, false);
  const rename = { commandId: randomUUID(), id: input.id, workspaceId: "personal", expectedRevision: 1, title: "Nové jméno" };
  assert.throws(() => subjects.renameStandaloneSubject(rename, { beforeCommit: boom }), /forced failure/);
  assert.equal(subjects.getStandaloneSubject("personal", input.id).title, input.title);
  assert.equal(eventCount(input.id), 1);
  assert.equal(subjects.renameStandaloneSubject(rename).subject.title, "Nové jméno");
  assert.equal(eventCount(input.id), 2);
});

test("exact retries return the stored result for claims and subjects; a changed request under the same key is a conflict", () => {
  const input = claimInput();
  const first = claims.createOwnerClaim(input);
  const second = claims.createOwnerClaim(input);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.claim, first.claim);
  assert.equal(eventCount(input.id), 1);
  assert.throws(() => claims.createOwnerClaim({ ...input, predicate: "importance" }), (error) => error.status === 409 && error.code === "idempotency_conflict");
  const person = subjectInput();
  const created = subjects.createStandaloneSubject(person);
  const again = subjects.createStandaloneSubject(person);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.subject, created.subject);
  assert.equal(eventCount(person.id), 1);
  assert.throws(() => subjects.createStandaloneSubject({ ...person, title: "Jiný název" }), (error) => error.code === "idempotency_conflict");
  assert.throws(() => subjects.renameStandaloneSubject({ commandId: person.commandId, id: person.id, workspaceId: "personal",
    expectedRevision: 1, title: person.title }), (error) => error.code === "idempotency_conflict");
});

test("no-op edits report changed:false and write no event", () => {
  const claim = claims.createOwnerClaim(claimInput()).claim;
  const noop = claims.updateOwnerClaim(updateInput(claim));
  assert.equal(noop.changed, false);
  assert.equal(noop.claim.revision, claim.revision);
  assert.equal(eventCount(claim.id), 1);
  const same = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: claim.id,
    expectedRevision: claim.revision, decision: "proposed" });
  assert.equal(same.changed, false);
  assert.equal(claims.listClaimReviewEvents("personal", claim.id).length, 0);
  const person = subjects.createStandaloneSubject(subjectInput()).subject;
  const renamed = subjects.renameStandaloneSubject({ commandId: randomUUID(), id: person.id, workspaceId: "personal",
    expectedRevision: person.revision, title: `  ${person.title}  ` });
  assert.equal(renamed.changed, false);
  assert.equal(eventCount(person.id), 1);
});

test("two updates against one expected revision: one wins, the other is a 409 and writes nothing", () => {
  const claim = claims.createOwnerClaim(claimInput()).claim;
  const winner = updateInput(claim, { literal: { type: "string", value: "Winner" } });
  const loser = updateInput(claim, { literal: { type: "string", value: "Loser" } });
  claims.updateOwnerClaim(winner);
  assert.throws(() => claims.updateOwnerClaim(loser), (error) => error.status === 409 && error.code === "revision_conflict");
  const stored = claims.listOwnerClaims("personal").find((item) => item.id === claim.id);
  assert.equal(stored.literal.value, "Winner");
  assert.equal(stored.revision, claim.revision + 1);
  assert.equal(eventCount(claim.id), 2);
  assert.equal(commandCount(loser.commandId), 0);
  const person = subjects.createStandaloneSubject(subjectInput()).subject;
  const base = { id: person.id, workspaceId: "personal", expectedRevision: person.revision };
  subjects.renameStandaloneSubject({ ...base, commandId: randomUUID(), title: "První" });
  assert.throws(() => subjects.renameStandaloneSubject({ ...base, commandId: randomUUID(), title: "Druhý" }), (error) => error.code === "revision_conflict");
  assert.equal(subjects.getStandaloneSubject("personal", person.id).title, "První");
});

test("a subject can be renamed A to B and back to A", () => {
  const person = subjects.createStandaloneSubject(subjectInput({ title: "Alena Nováková" })).subject;
  const toB = subjects.renameStandaloneSubject({ commandId: randomUUID(), id: person.id, workspaceId: "personal", expectedRevision: person.revision, title: "Alena Svobodová" }).subject;
  const backToA = subjects.renameStandaloneSubject({ commandId: randomUUID(), id: person.id, workspaceId: "personal", expectedRevision: toB.revision, title: "Alena Nováková" }).subject;
  assert.equal(backToA.title, "Alena Nováková");
  assert.equal(backToA.revision, 3);
  const history = subjects.listStandaloneSubjectHistory("personal", person.id).filter((event) => event.operation === "subject.rename");
  assert.equal(history.length, 2);
  // Another active person with the same name still blocks the rename.
  const other = subjects.createStandaloneSubject(subjectInput({ title: "Alena Svobodová" })).subject;
  assert.ok(other);
  assert.throws(() => subjects.renameStandaloneSubject({ commandId: randomUUID(), id: person.id, workspaceId: "personal", expectedRevision: backToA.revision, title: "Alena Svobodová" }), (error) => error.code === "duplicate_subject");
});

test("every review transition is allowed and recorded, and an edit returns the claim to proposed", () => {
  const states = ["proposed", "confirmed", "rejected"];
  for (const from of states) for (const to of states) {
    if (from === to) continue;
    let claim = claims.createOwnerClaim(claimInput()).claim;
    if (from !== "proposed") claim = review(claim, from);
    const before = claims.listClaimReviewEvents("personal", claim.id).length;
    const moved = review(claim, to);
    assert.equal(moved.reviewStatus, to, `${from} -> ${to}`);
    assert.equal(moved.revision, claim.revision + 1);
    const events = claims.listClaimReviewEvents("personal", claim.id);
    assert.equal(events.length, before + 1, `${from} -> ${to} review event`);
    assert.equal(events[0].decision, to);
    assert.equal(events[0].claimRevision, moved.revision);
  }
  let claim = review(claims.createOwnerClaim(claimInput()).claim, "confirmed");
  claim = claims.updateOwnerClaim(updateInput(claim, { literal: { type: "string", value: "Edited" } })).claim;
  assert.equal(claim.reviewStatus, "proposed");
});

test("sensitivity: sensitive input is stored as confidential, three levels are valid, others are refused", () => {
  const legacy = claims.createOwnerClaim(claimInput({ sensitivity: "sensitive" })).claim;
  assert.equal(legacy.sensitivity, "confidential");
  assert.equal(db().prepare("SELECT sensitivity FROM context_claims WHERE id = ?").get(legacy.id).sensitivity, "confidential");
  for (const level of ["normal", "confidential", "restricted"]) {
    assert.equal(claims.createOwnerClaim(claimInput({ sensitivity: level })).claim.sensitivity, level);
  }
  assert.throws(() => claims.createOwnerClaim(claimInput({ sensitivity: "secret" })), /invalid/i);
  // The legacy and the new spelling are one request for idempotency purposes.
  const input = claimInput({ sensitivity: "sensitive" });
  claims.createOwnerClaim(input);
  assert.equal(claims.createOwnerClaim({ ...input, sensitivity: "confidential" }).replayed, true);
  // Updating from sensitive to the same level is a no-op.
  assert.equal(claims.updateOwnerClaim(updateInput(legacy, { sensitivity: "sensitive" })).changed, false);
});

test("only normal claims are eligible; confidential and restricted are excluded", () => {
  const eligible = {};
  for (const level of ["normal", "confidential", "restricted"]) {
    const claim = review(claims.createOwnerClaim(claimInput({ sensitivity: level, predicate: `level_${level}` })).claim, "confirmed");
    eligible[level] = claims.isEligibleClaim(claim);
    assert.equal(claims.listEligibleClaims("personal").some((item) => item.id === claim.id), level === "normal");
  }
  assert.deepEqual(eligible, { normal: true, confidential: false, restricted: false });
});

test("an unknown stored sensitivity is read as restricted and needs review, without rewriting the row", () => {
  const claim = review(claims.createOwnerClaim(claimInput()).claim, "confirmed");
  db().prepare("UPDATE context_claims SET sensitivity = 'top-secret' WHERE id = ?").run(claim.id);
  const read = claims.listOwnerClaims("personal").find((item) => item.id === claim.id);
  assert.equal(read.sensitivity, "restricted");
  assert.equal(read.freshness, "needs_review");
  assert.equal(claims.isEligibleClaim(read), false);
  assert.equal(db().prepare("SELECT sensitivity FROM context_claims WHERE id = ?").get(claim.id).sensitivity, "top-secret");
  assert.equal(db().prepare("SELECT freshness FROM context_claims WHERE id = ?").get(claim.id).freshness, "current");
});

test("a Context Inbox approval retried later is the same command, although its ingestion time differs", async () => {
  const inbox = await import("../lib/context-inbox.ts");
  const input = { commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), subjectId: "workspace:personal",
    predicate: "preference", literal: { type: "string", value: "Bez porad v pátek" }, freshness: "needs_review",
    validFrom: null, validTo: null, evidenceExcerpt: "Bez porad v pátek" };
  const first = inbox.approveContextInboxClaim(input);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const retry = inbox.approveContextInboxClaim({ ...input, validFrom: undefined });
  assert.equal(retry.replayed, true);
  assert.equal(retry.claim.id, first.claim.id);
  assert.equal(retry.claim.source.ingestedAt, first.claim.source.ingestedAt);
  assert.equal(claims.listOwnerClaims("personal").filter((item) => item.id === input.id).length, 1);
  assert.throws(() => inbox.approveContextInboxClaim({ ...input, predicate: "importance" }), (error) => error.code === "idempotency_conflict");
});

test("a stored sensitivity nobody recognises is repaired by any save with a valid level", () => {
  const claim = claims.createOwnerClaim(claimInput()).claim;
  db().prepare("UPDATE context_claims SET sensitivity = 'weird' WHERE id = ?").run(claim.id);
  const read = claims.listOwnerClaims("personal").find((item) => item.id === claim.id);
  assert.equal(read.sensitivity, "restricted");
  assert.equal(read.freshness, "needs_review");
  const saved = claims.updateOwnerClaim(updateInput(read, { sensitivity: "restricted", freshness: "needs_review" }));
  assert.equal(saved.changed, true);
  assert.equal(saved.claim.revision, read.revision + 1);
  assert.equal(db().prepare("SELECT sensitivity FROM context_claims WHERE id = ?").get(claim.id).sensitivity, "restricted");
  assert.equal(eventCount(claim.id), 2);
  // Now the level is valid and an identical save is a no-op again.
  assert.equal(claims.updateOwnerClaim(updateInput(saved.claim)).changed, false);
});

test("absent, null and empty optional fields are one request for idempotency", () => {
  const base = claimInput();
  claims.createOwnerClaim(base);
  const variants = [
    { validFrom: null }, { validFrom: "", validTo: "" }, { source: null, evidence: null }, { source: undefined, target: undefined }, {},
  ];
  for (const extra of variants) assert.equal(claims.createOwnerClaim({ ...base, ...extra }).replayed, true, JSON.stringify(extra));
  const claim = claims.listOwnerClaims("personal").find((item) => item.id === base.id);
  const update = updateInput(claim, { literal: { type: "string", value: "Jinak" } });
  claims.updateOwnerClaim(update);
  assert.equal(claims.updateOwnerClaim({ ...update, validFrom: null, validTo: "", source: null }).replayed, true);
  const reviewKey = randomUUID();
  const current = claims.listOwnerClaims("personal").find((item) => item.id === base.id);
  const reviewInput = { commandId: reviewKey, workspaceId: "personal", id: base.id, expectedRevision: current.revision, decision: "confirmed" };
  claims.reviewOwnerClaim(reviewInput);
  assert.equal(claims.reviewOwnerClaim({ ...reviewInput, reason: "" }).replayed, true);
});

test("claim history names the review decision", () => {
  let claim = claims.createOwnerClaim(claimInput()).claim;
  claim = review(claim, "confirmed");
  claim = review(claim, "proposed");
  const history = claims.listClaimHistory("personal", claim.id);
  assert.deepEqual(history.map((event) => [event.operation, event.decision ?? null]), [["review", "proposed"], ["review", "confirmed"], ["create", null]]);
});

test("schema migrations: the sensitive rows are converted once, and a reopened database does not run them again", async () => {
  const claim = claims.createOwnerClaim(claimInput()).claim;
  const rows = db().prepare("SELECT id, applied_at FROM schema_migrations").all();
  assert.equal(rows.length, migrations.schemaMigrations.length);
  // Simulate a database written by the previous release: old value, migration not recorded yet.
  db().prepare("UPDATE context_claims SET sensitivity = 'sensitive' WHERE id = ?").run(claim.id);
  const revision = db().prepare("SELECT revision, updated_at FROM context_claims WHERE id = ?").get(claim.id);
  db().prepare("DELETE FROM schema_migrations").run();
  const metadataBefore = db().prepare("SELECT value FROM metadata WHERE key = 'revision'").get()?.value;
  db().close();
  const reopened = await import("../lib/server-store.ts?reopen=1");
  const database = reopened.getDatabase();
  assert.equal(database.prepare("SELECT sensitivity FROM context_claims WHERE id = ?").get(claim.id).sensitivity, "confidential");
  assert.deepEqual({ ...database.prepare("SELECT revision, updated_at FROM context_claims WHERE id = ?").get(claim.id) }, { ...revision });
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get()?.value, metadataBefore);
  const applied = database.prepare("SELECT id, applied_at FROM schema_migrations").all();
  assert.equal(applied.length, migrations.schemaMigrations.length);
  // A second open of the same file runs nothing and keeps the recorded time.
  assert.deepEqual(migrations.runSchemaMigrations(database), []);
  assert.deepEqual(database.prepare("SELECT id, applied_at FROM schema_migrations").all().map((row) => ({ ...row })), applied.map((row) => ({ ...row })));
  // New rows written after the migration are never touched by it.
  database.prepare("UPDATE context_claims SET sensitivity = 'sensitive' WHERE id = ?").run(claim.id);
  migrations.runSchemaMigrations(database);
  assert.equal(database.prepare("SELECT sensitivity FROM context_claims WHERE id = ?").get(claim.id).sensitivity, "sensitive");
});

test("the migration runner is transactional: a failing migration is not recorded and runs again next time", () => {
  const scratch = new DatabaseSync(":memory:");
  scratch.exec("CREATE TABLE t (v INTEGER)");
  let runs = 0;
  const list = [
    { id: "a", up: (database) => { runs += 1; database.exec("INSERT INTO t VALUES (1)"); } },
    { id: "b", up: (database) => { database.exec("INSERT INTO t VALUES (2)"); throw new Error("migration failed"); } },
  ];
  assert.throws(() => migrations.runSchemaMigrations(scratch, list), /migration failed/);
  assert.deepEqual(scratch.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id), ["a"]);
  assert.equal(Number(scratch.prepare("SELECT COUNT(*) AS count FROM t").get().count), 1);
  list[1].up = (database) => database.exec("INSERT INTO t VALUES (2)");
  assert.deepEqual(migrations.runSchemaMigrations(scratch, list), ["b"]);
  assert.deepEqual(migrations.runSchemaMigrations(scratch, list), []);
  assert.equal(runs, 1);
});
