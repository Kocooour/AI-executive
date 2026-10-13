import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-history-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const subjects = await import("../lib/context-subjects.ts");
const history = await import("../lib/context-history.ts");
const migrations = await import("../lib/schema-migrations.ts");
const store = await import("../lib/server-store.ts");

const db = () => store.getDatabase();
const boom = () => { throw new Error("forced failure"); };

// Every scenario gets its own workspace, so stacks never mix between scenarios.
function newWorkspace() {
  const id = `ws${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const workspace = { id: `workspace:${id}`, type: "workspace", title: id, status: "active", workspaceId: id,
    properties: { kind: "personal", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now };
  db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)").run(workspace.id, JSON.stringify(workspace), now);
  return id;
}
const events = (workspaceId) => db().prepare("SELECT * FROM context_change_events WHERE workspace_id = ? ORDER BY sequence").all(workspaceId);

function makeClaim(ws, overrides = {}) {
  return claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
    subject: { entityId: `workspace:${ws}` }, predicate: "preference", literal: { type: "string", value: "Quiet mornings" },
    freshness: "current", sensitivity: "normal", ...overrides }).claim;
}
const edit = (ws, claim, value, overrides = {}) => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id,
  expectedRevision: claim.revision, predicate: claim.predicate, literal: { type: "string", value }, freshness: claim.freshness,
  sensitivity: claim.sensitivity, ...overrides }).claim;
const review = (ws, claim, decision) => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id,
  expectedRevision: claim.revision, decision }).claim;
const archive = (ws, claim) => claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision }).claim;
const makeSubject = (ws, title = `Osoba ${randomUUID()}`, type = "person") => subjects.createStandaloneSubject({ commandId: randomUUID(),
  workspaceId: ws, id: randomUUID(), expectedRevision: 0, type, title }).subject;
const rename = (ws, subject, title) => subjects.renameStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: subject.id,
  expectedRevision: subject.revision, title }).subject;
const archiveSubject = (ws, subject) => subjects.archiveStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: subject.id,
  expectedRevision: subject.revision }).subject;
const getClaim = (ws, id) => claims.listOwnerClaims(ws, { includeArchived: true }).find((claim) => claim.id === id);

function step(ws, action, overrides = {}) {
  const state = history.getContextHistory(ws);
  const expectedEventId = (action === "undo" ? state.undo : state.redo)?.eventId;
  return history.runHistoryCommand({ action, commandId: randomUUID(), workspaceId: ws, expectedEventId, ...overrides });
}
const undo = (ws, overrides) => step(ws, "undo", overrides);
const redo = (ws, overrides) => step(ws, "redo", overrides);

test("undo and redo of every claim operation are new revisions and only append history", () => {
  const ws = newWorkspace();
  // create -> archived, redo -> back
  const created = makeClaim(ws);
  const undone = undo(ws);
  assert.equal(undone.changed, true);
  assert.equal(undone.object.archivedAt !== null, true);
  assert.equal(undone.object.revision, created.revision + 1);
  assert.equal(undone.step.operation, "create");
  assert.equal(getClaim(ws, created.id).archivedAt !== null, true);
  const redone = redo(ws);
  assert.equal(redone.object.archivedAt, null);
  assert.equal(redone.object.revision, created.revision + 2);
  assert.equal(redone.object.literal.value, "Quiet mornings");

  // update -> previous editable fields, including source and evidence; redo -> the newer ones
  let claim = getClaim(ws, created.id);
  const updated = edit(ws, claim, "Loud evenings", { predicate: "importance", freshness: "stale", sensitivity: "restricted",
    validFrom: "2026-01-01", validTo: "2026-12-31", source: { provider: "manual", locator: "https://example.test/a" },
    evidence: { excerpt: "Quoted", stance: "supports" } });
  assert.equal(undo(ws).object.revision, updated.revision + 1);
  claim = getClaim(ws, created.id);
  assert.deepEqual([claim.predicate, claim.literal.value, claim.freshness, claim.sensitivity, claim.validFrom, claim.source, claim.evidence],
    ["preference", "Quiet mornings", "current", "normal", null, null, null]);
  redo(ws);
  claim = getClaim(ws, created.id);
  assert.deepEqual([claim.predicate, claim.literal.value, claim.freshness, claim.sensitivity, claim.validFrom, claim.validTo, claim.source.provider, claim.evidence.excerpt],
    ["importance", "Loud evenings", "stale", "restricted", "2026-01-01", "2026-12-31", "manual", "Quoted"]);

  // review (and an edit that returned a confirmed claim to proposed): the review status comes back, with review events
  claim = review(ws, claim, "confirmed");
  const reviewEventsBefore = claims.listClaimReviewEvents(ws, claim.id).length;
  const undoReview = undo(ws);
  assert.equal(undoReview.object.reviewStatus, "proposed");
  assert.equal(undoReview.step.operation, "review");
  assert.equal(undoReview.step.reviewStatus, "confirmed", "the step names the action that was undone");
  const reviewEvents = claims.listClaimReviewEvents(ws, claim.id);
  assert.equal(reviewEvents.length, reviewEventsBefore + 1);
  assert.deepEqual([reviewEvents[0].decision, reviewEvents[0].reason, reviewEvents[0].claimRevision], ["proposed", "undo", undoReview.object.revision]);
  assert.equal(redo(ws).object.reviewStatus, "confirmed");
  assert.equal(claims.listClaimReviewEvents(ws, claim.id)[0].reason, "redo");
  const confirmed = getClaim(ws, claim.id);
  const afterEdit = edit(ws, confirmed, "Edited after confirmation");
  assert.equal(afterEdit.reviewStatus, "proposed");
  assert.equal(undo(ws).object.reviewStatus, "confirmed", "undoing the edit restores the confirmation");
  assert.equal(getClaim(ws, claim.id).literal.value, "Loud evenings");

  // archive -> unarchive; redo -> archive again
  claim = getClaim(ws, claim.id);
  archive(ws, claim);
  assert.equal(undo(ws).object.archivedAt, null);
  assert.equal(redo(ws).object.archivedAt !== null, true);

  // History only grew: every old row is untouched and every step added exactly one row.
  const rows = events(ws);
  assert.deepEqual(rows.map((row) => row.sequence), rows.map((_, index) => rows[0].sequence + index));
  assert.ok(rows.every((row) => row.kind === "change" || row.reverts_event_id));
});

test("undo and redo of people and organizations: create, rename and archive", () => {
  const ws = newWorkspace();
  const person = makeSubject(ws, "Jana");
  const org = makeSubject(ws, "Acme", "organization");
  const renamed = rename(ws, person, "Jan");
  // Newest first: rename -> org create -> person create
  const undoRename = undo(ws);
  assert.equal(undoRename.object.title, "Jana");
  assert.equal(undoRename.object.revision, renamed.revision + 1);
  // Named as the step was done: the rename went from Jana to Jan, and Undo restores Jana.
  assert.equal(undoRename.step.fromTitle, "Jana");
  assert.equal(undoRename.step.toTitle, "Jan");
  assert.equal(redo(ws).object.title, "Jan");
  undo(ws); // rename again
  const undoOrg = undo(ws);
  assert.equal(undoOrg.object.id, org.id);
  assert.notEqual(undoOrg.object.archivedAt, null);
  assert.equal(redo(ws).object.archivedAt, null);
  // archive -> unarchive
  const current = subjects.getStandaloneSubject(ws, org.id);
  archiveSubject(ws, current);
  assert.equal(undo(ws).object.archivedAt, null);
  assert.equal(subjects.getStandaloneSubject(ws, org.id).archivedAt, null);
  assert.notEqual(redo(ws).object.archivedAt, null);
  assert.equal(subjects.listStandaloneSubjectHistory(ws, org.id)[0].kind, "redo");
});

test("a Context Inbox approval is a claim create and can be undone", async () => {
  const inbox = await import("../lib/context-inbox.ts");
  const ws = newWorkspace();
  const approved = inbox.approveContextInboxClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), subjectId: `workspace:${ws}`,
    predicate: "preference", literal: { type: "string", value: "No meetings on Friday" }, freshness: "needs_review", evidenceExcerpt: "No meetings on Friday" });
  assert.equal(history.getContextHistory(ws).undo.operation, "create");
  assert.notEqual(undo(ws).object.archivedAt, null);
  assert.equal(getClaim(ws, approved.claim.id).archivedAt !== null, true);
});

test("steps undo in order, redo in order, and a new change empties the redo stack", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const v1 = edit(ws, claim, "one");
  const v2 = edit(ws, v1, "two");
  edit(ws, v2, "three");
  const labels = () => getClaim(ws, claim.id).literal.value;
  undo(ws); assert.equal(labels(), "two");
  undo(ws); assert.equal(labels(), "one");
  assert.equal(history.getContextHistory(ws).redo.operation, "update");
  redo(ws); assert.equal(labels(), "two");
  undo(ws); assert.equal(labels(), "one");
  // A new ordinary change: the two undone steps stay in history but cannot be redone.
  edit(ws, getClaim(ws, claim.id), "fresh");
  assert.equal(history.getContextHistory(ws).redo, null);
  assert.throws(() => history.runHistoryCommand({ action: "redo", commandId: randomUUID(), workspaceId: ws, expectedEventId: "anything" }),
    (error) => error.status === 409 && error.code === "history_changed");
  undo(ws); assert.equal(labels(), "one");
  undo(ws); assert.equal(labels(), "Quiet mornings");
  undo(ws); // the create
  assert.notEqual(getClaim(ws, claim.id).archivedAt, null);
  assert.equal(history.getContextHistory(ws).undo, null);
  assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: "x" }),
    (error) => error.code === "history_changed");
  // everything was recorded: create + 3 edits + 2 undos + 1 redo + 1 undo + 1 edit + 3 undos
  assert.equal(events(ws).length, 4 + 2 + 1 + 1 + 1 + 3);
  assert.equal(history.getContextHistory(ws).recent.length, 0);
});

test("no-op commands and replays consume no step", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const edited = edit(ws, claim, "changed");
  const before = history.getContextHistory(ws).undo.eventId;
  assert.equal(claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: edited.revision,
    predicate: edited.predicate, literal: edited.literal, freshness: edited.freshness, sensitivity: edited.sensitivity }).changed, false);
  assert.equal(history.getContextHistory(ws).undo.eventId, before);
  const key = randomUUID();
  const first = history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: before });
  const replay = history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: before });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.object, first.object);
  assert.equal(getClaim(ws, claim.id).literal.value, "Quiet mornings");
  assert.equal(events(ws).length, 3);
  // Another key with the same expectation is refused: the step was used.
  assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: before }),
    (error) => error.status === 409 && error.code === "history_changed");
  // The same key with another request is a conflict.
  assert.throws(() => history.runHistoryCommand({ action: "redo", commandId: key, workspaceId: ws, expectedEventId: before }),
    (error) => error.code === "idempotency_conflict");
});

test("a stale expected step is refused with history_changed and writes nothing", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const seen = history.getContextHistory(ws).undo.eventId;
  edit(ws, claim, "another tab");
  const rowsBefore = events(ws).length;
  const key = randomUUID();
  assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: seen }),
    (error) => error.status === 409 && error.code === "history_changed");
  assert.equal(events(ws).length, rowsBefore);
  assert.equal(getClaim(ws, claim.id).literal.value, "another tab");
  assert.equal(Number(db().prepare("SELECT COUNT(*) AS count FROM context_commands WHERE idempotency_key = ?").get(key).count), 0);
  assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: "" }), /invalid/i);
  assert.throws(() => history.runHistoryCommand({ action: "bogus", commandId: randomUUID(), workspaceId: ws, expectedEventId: seen }), /Unknown/);
});

test("undo is refused as undo_conflict when the object changed outside the stack, and nothing is written", () => {
  const ws = newWorkspace();
  const claim = edit(ws, makeClaim(ws), "stack edit");
  // A later edit that is not in the history (a direct write).
  db().prepare("UPDATE context_claims SET literal_value = ?, revision = revision + 1 WHERE id = ?").run(JSON.stringify("sneaked in"), claim.id);
  const rowsBefore = events(ws).length;
  assert.throws(() => undo(ws), (error) => error.status === 409 && error.code === "undo_conflict");
  assert.equal(events(ws).length, rowsBefore);
  const stored = getClaim(ws, claim.id);
  assert.equal(stored.literal.value, "sneaked in");
  assert.equal(stored.revision, claim.revision + 1);
  // The same without a revision change (content differs from what the step left behind).
  db().prepare("UPDATE context_claims SET revision = ? WHERE id = ?").run(claim.revision, claim.id);
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
  // A subject renamed outside the stack.
  const ws2 = newWorkspace();
  const person = rename(ws2, makeSubject(ws2, "Petra"), "Petra B.");
  db().prepare("UPDATE context_subjects SET display_title = 'Petr', revision = revision + 1 WHERE id = ?").run(person.id);
  assert.throws(() => undo(ws2), (error) => error.code === "undo_conflict");
  assert.equal(subjects.getStandaloneSubject(ws2, person.id).title, "Petr");
});

test("a rename or an archive is not undone into a name another active person already holds", () => {
  const ws = newWorkspace();
  const renamed = rename(ws, makeSubject(ws, "Marie Dvořáková"), "Marie Novotná");
  // Another active person with the old name appears outside this history (the stack alone cannot allow it).
  const now = Date.now();
  db().prepare(`INSERT INTO context_subjects (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, 'person', NULL, 'Marie Dvořáková', 1, ?, ?, NULL)`).run(randomUUID(), ws, now, now);
  const rowsBefore = events(ws).length;
  assert.throws(() => undo(ws), (error) => error.status === 409 && error.code === "duplicate_subject");
  assert.equal(events(ws).length, rowsBefore);
  assert.equal(subjects.getStandaloneSubject(ws, renamed.id).title, "Marie Novotná");
  assert.equal(subjects.getStandaloneSubject(ws, renamed.id).revision, renamed.revision);
  // The stack did not move: the step is still on top and a later undo can succeed once the name is free.
  db().prepare("UPDATE context_subjects SET archived_at = ? WHERE workspace_id = ? AND display_title = 'Marie Dvořáková'").run(now, ws);
  assert.equal(undo(ws).object.title, "Marie Dvořáková");

  // Unarchiving is checked the same way.
  const ws2 = newWorkspace();
  const eva = archiveSubject(ws2, makeSubject(ws2, "Eva Malá"));
  db().prepare(`INSERT INTO context_subjects (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at, archived_at)
    VALUES (?, ?, 'person', NULL, 'Eva Malá', 1, ?, ?, NULL)`).run(randomUUID(), ws2, now, now);
  assert.throws(() => undo(ws2), (error) => error.code === "duplicate_subject");
  assert.notEqual(subjects.getStandaloneSubject(ws2, eva.id).archivedAt, null);
});

test("a claim is not brought back for a subject or target that is archived or gone", () => {
  const ws = newWorkspace();
  const person = makeSubject(ws, "Tereza");
  const claim = makeClaim(ws, { predicate: "waiting_for", literal: undefined, target: { subjectId: person.id } });
  archive(ws, claim);
  // The person is archived outside the history: the claim cannot come back pointing at them.
  db().prepare("UPDATE context_subjects SET archived_at = ? WHERE id = ?").run(Date.now(), person.id);
  const rowsBefore = events(ws).length;
  assert.throws(() => undo(ws), (error) => error.status === 409 && error.code === "archived_subject");
  assert.equal(events(ws).length, rowsBefore);
  assert.notEqual(getClaim(ws, claim.id).archivedAt, null);
  db().prepare("UPDATE context_subjects SET archived_at = NULL WHERE id = ?").run(person.id);
  assert.equal(undo(ws).object.archivedAt, null);
  // Archiving (the undo of a create) never needs the target.
  db().prepare("UPDATE context_subjects SET archived_at = ? WHERE id = ?").run(Date.now(), person.id);
  const created = makeClaim(ws);
  assert.notEqual(undo(ws).object.archivedAt, null);
  assert.equal(created.archivedAt, null);
});

test("an interrupted undo leaves nothing behind and can be retried", () => {
  for (const hook of ["afterMutate", "beforeCommit"]) {
    const ws = newWorkspace();
    const claim = edit(ws, makeClaim(ws), "kept");
    const key = randomUUID();
    const top = history.getContextHistory(ws).undo.eventId;
    const rowsBefore = events(ws).length;
    assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: top }, { [hook]: boom }), /forced failure/);
    assert.equal(events(ws).length, rowsBefore);
    assert.equal(getClaim(ws, claim.id).literal.value, "kept");
    assert.equal(getClaim(ws, claim.id).revision, claim.revision);
    assert.equal(history.getContextHistory(ws).undo.eventId, top);
    assert.equal(Number(db().prepare("SELECT COUNT(*) AS count FROM context_commands WHERE idempotency_key = ?").get(key).count), 0);
    assert.equal(history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: top }).changed, true);
    assert.equal(getClaim(ws, claim.id).literal.value, "Quiet mornings");
  }
  // An interrupted review undo does not leave a review event either.
  const ws3 = newWorkspace();
  const toReview = review(ws3, makeClaim(ws3), "rejected");
  const topId = history.getContextHistory(ws3).undo.eventId;
  for (const hook of ["afterMutate", "beforeCommit"]) {
    assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws3, expectedEventId: topId }, { [hook]: boom }), /forced failure/);
    assert.equal(claims.listClaimReviewEvents(ws3, toReview.id).length, 1);
    assert.equal(getClaim(ws3, toReview.id).reviewStatus, "rejected");
    assert.equal(getClaim(ws3, toReview.id).revision, toReview.revision);
  }
  assert.equal(undo(ws3).object.reviewStatus, "proposed");
});

test("workspaces are isolated: undo in one never touches the other", () => {
  const a = newWorkspace();
  const b = newWorkspace();
  const claimA = edit(a, makeClaim(a), "A edited");
  const claimB = edit(b, makeClaim(b), "B edited");
  assert.notEqual(history.getContextHistory(a).undo.eventId, history.getContextHistory(b).undo.eventId);
  undo(a);
  assert.equal(getClaim(a, claimA.id).literal.value, "Quiet mornings");
  assert.equal(getClaim(b, claimB.id).literal.value, "B edited");
  assert.equal(history.getContextHistory(b).redo, null);
  // A step of workspace A is not a valid expectation in workspace B.
  assert.throws(() => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: b,
    expectedEventId: history.getContextHistory(a).redo.eventId }), (error) => error.code === "history_changed");
  assert.throws(() => history.getContextHistory("all"), /workspace/i);
  assert.throws(() => history.getContextHistory("nope"), (error) => error.status === 404);
});

// A second process opens the same data directory: the stacks must be derived from the database alone.
function child(code) {
  const result = spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", "--input-type=module", "-e", code],
    { cwd: process.cwd(), env: { ...process.env, AI_EXECUTIVE_DATA_DIR: dataDir }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("the stacks survive a restart and continue correctly in a new process", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const v1 = edit(ws, claim, "one");
  edit(ws, v1, "two");
  undo(ws);
  const expected = history.getContextHistory(ws);
  const seen = child(`
    const history = await import("./lib/context-history.ts");
    const state = history.getContextHistory(${JSON.stringify(ws)});
    // continue in the new process: undo the next step and redo the one that was undone before the restart
    const next = history.runHistoryCommand({ action: "undo", commandId: "restart-undo-${ws}", workspaceId: ${JSON.stringify(ws)}, expectedEventId: state.undo.eventId });
    const back = history.runHistoryCommand({ action: "redo", commandId: "restart-redo-${ws}", workspaceId: ${JSON.stringify(ws)}, expectedEventId: next.redo.eventId });
    console.log(JSON.stringify({ state, value: back.object.literal.value }));`);
  assert.deepEqual(seen.state, JSON.parse(JSON.stringify(expected)));
  assert.equal(seen.value, "one");
  // And this process sees what the other wrote: the stacks continue from there.
  assert.equal(getClaim(ws, claim.id).literal.value, "one");
  const stacks = history.getContextHistory(ws);
  assert.equal(stacks.redo?.operation, "update");
  redo(ws);
  assert.equal(getClaim(ws, claim.id).literal.value, "two");
  undo(ws); undo(ws); undo(ws);
  assert.notEqual(getClaim(ws, claim.id).archivedAt, null);
  assert.equal(history.getContextHistory(ws).undo, null);
});

test("the migration backfills sequence, type and kind for events written before it, and rewrites no content", () => {
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE context_change_events (id TEXT PRIMARY KEY, command_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor TEXT NOT NULL,
    object_id TEXT NOT NULL, operation TEXT NOT NULL, before_revision INTEGER, after_revision INTEGER, before_payload TEXT, after_payload TEXT,
    created_at INTEGER NOT NULL)`);
  const insert = old.prepare("INSERT INTO context_change_events VALUES (?, ?, 'personal', 'owner', ?, ?, ?, ?, ?, ?, ?)");
  insert.run("e2", "c2", "claim-1", "update", 1, 2, '{"a":1}', '{"a":2}', 2000);
  insert.run("e1", "c1", "claim-1", "create", null, 1, null, '{"a":1}', 1000);
  insert.run("e3", "c3", "person-1", "subject.rename", 1, 2, '{"title":"A"}', '{"title":"B"}', 3000);
  const before = old.prepare("SELECT id, before_payload, after_payload, before_revision, after_revision, created_at FROM context_change_events ORDER BY id").all().map((row) => ({ ...row }));
  const migration = migrations.schemaMigrations.find((item) => item.id === "2026-10-context-change-events-undo-linkage");
  assert.ok(migration);
  assert.deepEqual(migrations.runSchemaMigrations(old, [migration]), [migration.id]);
  const rows = old.prepare("SELECT id, sequence, object_type, kind, reverts_event_id FROM context_change_events ORDER BY sequence").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: "e1", sequence: 1, object_type: "claim", kind: "change", reverts_event_id: null },
    { id: "e2", sequence: 2, object_type: "claim", kind: "change", reverts_event_id: null },
    { id: "e3", sequence: 3, object_type: "subject", kind: "change", reverts_event_id: null },
  ]);
  assert.deepEqual(old.prepare("SELECT id, before_payload, after_payload, before_revision, after_revision, created_at FROM context_change_events ORDER BY id").all().map((row) => ({ ...row })), before);
  // Running it again (a database whose registry row was lost) changes nothing.
  old.prepare("DELETE FROM schema_migrations").run();
  assert.deepEqual(migrations.runSchemaMigrations(old, [migration]), [migration.id]);
  assert.deepEqual(old.prepare("SELECT id, sequence FROM context_change_events ORDER BY sequence").all().map((row) => row.id), ["e1", "e2", "e3"]);
  // The new column set also holds on the live database, where the stacks are derived from it.
  const live = db().prepare("PRAGMA table_info(context_change_events)").all().map((row) => row.name);
  for (const column of ["sequence", "object_type", "kind", "reverts_event_id"]) assert.ok(live.includes(column), column);
});

test("history is derived for events written before the migration (all ordinary changes)", () => {
  const ws = newWorkspace();
  const claim = edit(ws, makeClaim(ws), "legacy");
  // Make the rows look like the previous release wrote them.
  db().prepare("UPDATE context_change_events SET kind = 'change', reverts_event_id = NULL, object_type = NULL WHERE workspace_id = ?").run(ws);
  assert.equal(history.getContextHistory(ws).undo.operation, "update");
  assert.equal(undo(ws).object.literal.value, "Quiet mornings");
  assert.equal(getClaim(ws, claim.id).revision, claim.revision + 1);
});

test("the integration API and bearer-token routes expose no undo or redo", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full); else files.push(full);
    }
  };
  walk(path.join(root, "app/api/integrations"));
  assert.ok(files.length > 0);
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /undo|redo|context-history|api\/context\/history/i, file);
  const pact = readFileSync(path.join(root, "lib/pact-tools.ts"), "utf8");
  assert.doesNotMatch(pact, /undo|redo|context-history/i);
  // The history route accepts only the owner session, never the integration token.
  const route = readFileSync(path.join(root, "app/api/context/history/route.ts"), "utf8");
  assert.match(route, /isAuthenticated\(request\)/);
  assert.doesNotMatch(route, /isIntegrationAuthenticated/);
  assert.match(route, /requireSameOrigin/);
});

test("a command reports the history step it recorded; a no-op and a retry report none or the original", () => {
  const ws = newWorkspace();
  const input = { commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, subject: { entityId: `workspace:${ws}` },
    predicate: "preference", literal: { type: "string", value: "x" }, freshness: "current", sensitivity: "normal" };
  const created = claims.createOwnerClaim(input);
  assert.equal(created.historyEventId, history.getContextHistory(ws).undo.eventId);
  assert.equal(claims.createOwnerClaim(input).historyEventId, created.historyEventId, "a retry returns the original step");
  const noop = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: input.id, expectedRevision: 1, predicate: "preference",
    literal: { type: "string", value: "x" }, freshness: "current", sensitivity: "normal" });
  assert.deepEqual([noop.changed, noop.historyEventId], [false, null]);
  const person = makeSubject(ws, "Hana");
  const same = subjects.renameStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: person.id, expectedRevision: 1, title: "Hana" });
  assert.deepEqual([same.changed, same.historyEventId], [false, null]);
});

test("skipping a step that cannot succeed makes the next older step the top, and changes no object", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const edited = edit(ws, claim, "later");
  const olderTop = history.getContextHistory(ws).undo;
  // The edited claim changes outside the history: its newest step can never be undone now.
  db().prepare("UPDATE context_claims SET literal_value = ?, revision = revision + 1 WHERE id = ?").run(JSON.stringify("outside"), claim.id);
  const other = makeSubject(ws, "Ida");
  rename(ws, other, "Ida B.");
  rename(ws, subjects.getStandaloneSubject(ws, other.id), "Ida C.");
  // Make the claim's step the top: undo the two renames and the subject create is below; instead block with the claim step directly.
  undo(ws); undo(ws); undo(ws); // renames and the subject create
  const top = history.getContextHistory(ws).undo;
  assert.equal(top.eventId, olderTop.eventId);
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
  const rowsBefore = events(ws).length;
  const stored = getClaim(ws, claim.id);
  // A stale expectation is refused.
  assert.throws(() => history.runHistoryCommand({ action: "skip", stack: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: "stale" }),
    (error) => error.code === "history_changed");
  assert.equal(events(ws).length, rowsBefore);
  const skipped = history.runHistoryCommand({ action: "skip", stack: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: top.eventId });
  assert.equal(skipped.step.eventId, top.eventId);
  assert.equal(events(ws).length, rowsBefore + 1);
  const last = events(ws).at(-1);
  assert.deepEqual([last.kind, last.reverts_event_id], ["skip", top.eventId]);
  assert.deepEqual({ ...getClaim(ws, claim.id) }, { ...stored }, "no object changed");
  assert.equal(edited.literal.value, "later");
  // The next older step is the top now; the skipped one is no longer on either stack.
  const state = history.getContextHistory(ws);
  assert.equal(state.undo.operation, "create");
  assert.ok(!state.recent.some((item) => item.eventId === top.eventId));
  // Its conflict is real: the claim was edited outside, so the older create cannot be undone either; the older steps of other objects can.
  const ws2 = newWorkspace();
  const keep = makeSubject(ws2, "Older person");
  const broken = makeClaim(ws2);
  db().prepare("UPDATE context_claims SET archived_at = NULL, literal_value = ?, revision = revision + 1 WHERE id = ?").run(JSON.stringify("outside"), broken.id);
  assert.throws(() => undo(ws2), (error) => error.code === "undo_conflict");
  const t = history.getContextHistory(ws2).undo.eventId;
  history.runHistoryCommand({ action: "skip", stack: "undo", commandId: randomUUID(), workspaceId: ws2, expectedEventId: t });
  assert.notEqual(undo(ws2).object.archivedAt, null);
  assert.equal(subjects.getStandaloneSubject(ws2, keep.id).archivedAt !== null, true);
  // A skip on the redo stack leaves the undo stack alone, and the skip itself is not a step.
  const ws4 = newWorkspace();
  const blocked = makeSubject(ws4, "Original person");
  undo(ws4);
  // Simulate a concurrent write outside Context commands without clearing the Redo stack.
  db().prepare("UPDATE context_subjects SET display_title = ?, revision = revision + 1 WHERE id = ?").run("Externally changed", blocked.id);
  const redoStep = history.getContextHistory(ws4).redo;
  assert.throws(() => redo(ws4), (error) => error.code === "undo_conflict");
  history.runHistoryCommand({ action: "skip", stack: "redo", commandId: randomUUID(), workspaceId: ws4, expectedEventId: redoStep.eventId });
  const redoAfter = history.getContextHistory(ws4);
  assert.equal(redoAfter.redo, null);
  assert.equal(redoAfter.undo, null);
  // The skip survives a restart.
  const seen = child(`const history = await import("./lib/context-history.ts"); console.log(JSON.stringify(history.getContextHistory(${JSON.stringify(ws4)})));`);
  assert.deepEqual(seen, JSON.parse(JSON.stringify(redoAfter)));
});

test("skip refuses a compensatable step without object, history, review or idempotency writes", () => {
  const ws = newWorkspace();
  let claim = makeClaim(ws);
  claim = review(ws, claim, "confirmed");
  const top = history.getContextHistory(ws).undo.eventId;
  const key = randomUUID();
  const rowBefore = db().prepare("SELECT * FROM context_claims WHERE id = ?").get(claim.id);
  const eventCount = events(ws).length;
  const reviewCount = claims.listClaimReviewEvents(ws, claim.id).length;
  const commandCount = db().prepare("SELECT COUNT(*) AS n FROM context_commands WHERE workspace_id = ?").get(ws).n;
  assert.throws(() => history.runHistoryCommand({ action: "skip", stack: "undo", commandId: key, workspaceId: ws, expectedEventId: top }),
    (error) => error.status === 409 && error.code === "skip_not_needed");
  assert.deepEqual(db().prepare("SELECT * FROM context_claims WHERE id = ?").get(claim.id), rowBefore);
  assert.equal(events(ws).length, eventCount);
  assert.equal(claims.listClaimReviewEvents(ws, claim.id).length, reviewCount);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM context_commands WHERE workspace_id = ?").get(ws).n, commandCount);
  assert.equal(history.getContextHistory(ws).undo.eventId, top);
  assert.equal(history.runHistoryCommand({ action: "undo", commandId: key, workspaceId: ws, expectedEventId: top }).changed, true,
    "the rejected skip did not consume its idempotency key");

  const redoTop = history.getContextHistory(ws).redo.eventId;
  const redoRowBefore = db().prepare("SELECT * FROM context_claims WHERE id = ?").get(claim.id);
  const redoEventCount = events(ws).length;
  const redoReviewCount = claims.listClaimReviewEvents(ws, claim.id).length;
  assert.throws(() => history.runHistoryCommand({ action: "skip", stack: "redo", commandId: randomUUID(), workspaceId: ws, expectedEventId: redoTop }),
    (error) => error.status === 409 && error.code === "skip_not_needed");
  assert.deepEqual(db().prepare("SELECT * FROM context_claims WHERE id = ?").get(claim.id), redoRowBefore);
  assert.equal(events(ws).length, redoEventCount);
  assert.equal(claims.listClaimReviewEvents(ws, claim.id).length, redoReviewCount);
  assert.equal(history.getContextHistory(ws).redo.eventId, redoTop);
});

test("skip refuses an unexpected compensation failure", () => {
  const ws = newWorkspace();
  makeClaim(ws);
  const top = history.getContextHistory(ws).undo.eventId;
  db().prepare("UPDATE context_change_events SET after_payload = ? WHERE id = ?").run("invalid JSON", top);
  const eventCount = events(ws).length;
  assert.throws(() => history.runHistoryCommand({ action: "skip", stack: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: top }), SyntaxError);
  assert.equal(events(ws).length, eventCount);
  assert.equal(history.readHistoryStacks(ws).undo[0], top);
});

test("events written without a sequence by an older binary are ordered on the next start", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  // A rolled-back binary inserts a change event with no sequence, object type or kind linkage.
  const changed = { ...claim, literal: { type: "string", value: "from the old binary" }, revision: claim.revision + 1 };
  db().prepare("UPDATE context_claims SET literal_value = ?, revision = revision + 1 WHERE id = ?").run(JSON.stringify("from the old binary"), claim.id);
  db().prepare(`INSERT INTO context_change_events (id, command_id, workspace_id, actor, object_id, operation, before_revision, after_revision,
    before_payload, after_payload, created_at) VALUES (?, ?, ?, 'owner', ?, 'update', ?, ?, ?, ?, ?)`)
    .run("old-binary-event", randomUUID(), ws, claim.id, claim.revision, changed.revision, JSON.stringify(claim), JSON.stringify(changed), Date.now());
  assert.equal(db().prepare("SELECT sequence FROM context_change_events WHERE id = 'old-binary-event'").get().sequence, null);
  migrations.repairContextEventOrder(db());
  const row = db().prepare("SELECT sequence, object_type FROM context_change_events WHERE id = 'old-binary-event'").get();
  assert.equal(row.object_type, "claim");
  assert.equal(Number(row.sequence), Number(db().prepare("SELECT MAX(sequence) AS m FROM context_change_events").get().m));
  // It is the top step and Undo targets it.
  assert.equal(history.getContextHistory(ws).undo.eventId, "old-binary-event");
  assert.equal(undo(ws).object.literal.value, "Quiet mornings");
  assert.equal(history.getContextHistory(ws).redo.operation, "update");
  // A process starting on this file repairs it by itself.
  const ws2 = newWorkspace();
  const second = makeClaim(ws2);
  db().prepare(`INSERT INTO context_change_events (id, command_id, workspace_id, actor, object_id, operation, before_revision, after_revision,
    before_payload, after_payload, created_at) VALUES ('old-two', ?, ?, 'owner', ?, 'review', 1, 1, NULL, ?, ?)`)
    .run(randomUUID(), ws2, second.id, JSON.stringify(second), Date.now());
  const seen = child(`const history = await import("./lib/context-history.ts"); console.log(JSON.stringify(history.getContextHistory(${JSON.stringify(ws2)}).undo.eventId));`);
  assert.equal(seen, "old-two");
});
