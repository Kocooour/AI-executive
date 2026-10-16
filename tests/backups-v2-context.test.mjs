import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

// Restore with the real Context, history and work-session code (the generic table checks are in backups-v2.test.mjs).
const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-backups-ctx-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const sources = await import("../lib/context-sources.ts");
const evidence = await import("../lib/context-evidence.ts");
const history = await import("../lib/context-history.ts");
const noteRevisions = await import("../lib/note-revisions.ts");
const work = await import("../lib/work-sessions.ts");
const engine = await import("../lib/backup-engine.ts");
const migrations = await import("../lib/schema-migrations.ts");
const store = await import("../lib/server-store.ts");

const backupsDir = path.join(dataDir, "backups");
const db = () => store.getDatabase();
const ws = "personal";
const task = (id, title = id) => ({ id, type: "task", title, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 });
const note = (id, title, content) => ({ id, type: "note", title, content, status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 2 });
const setEntities = (entities, deleted = []) => {
  const current = store.readSnapshot();
  const result = store.replaceSnapshot(current.revision, [current.entities.find((entity) => entity.id === "workspace:personal"), ...entities], [], deleted);
  assert.equal(result.conflict, false);
};
const makeClaim = (value) => claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  subject: { entityId: "workspace:personal" }, predicate: "preference", literal: { type: "string", value }, freshness: "current", sensitivity: "normal" }).claim;
const edit = (claim, value) => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision,
  predicate: claim.predicate, literal: { type: "string", value }, freshness: claim.freshness, sensitivity: claim.sensitivity }).claim;
const makeSource = () => sources.createContextSource({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  provider: "email", coverage: "excerpt", sensitivity: "normal" }).source;
const addEvidence = (claim, source) => evidence.addClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  claimId: claim.id, expectedClaimRevision: claim.revision, sourceId: source.id, stance: "supports", excerpt: "quote" });
const undo = () => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: history.readHistoryStacks(ws).undo[0] });
const state = () => ({
  claims: JSON.stringify(claims.listOwnerClaims(ws, { includeArchived: true }).map((claim) => [claim.id, claim.revision, claim.literal?.value ?? claim.literalValue ?? null]).sort()),
  stacks: JSON.stringify(history.readHistoryStacks(ws)),
  historyView: JSON.stringify(history.getContextHistory(ws)),
  sources: JSON.stringify(sources.listContextSources(ws, { includeArchived: true }).map((source) => [source.id, source.revision]).sort()),
  evidence: JSON.stringify(db().prepare("SELECT id, claim_id, source_id FROM context_evidence ORDER BY id").all()),
  versions: JSON.stringify(db().prepare("SELECT note_id, revision, origin, title, content FROM note_revisions ORDER BY note_id, revision").all()),
});

function alterBackup(name, change) {
  const file = path.join(backupsDir, name);
  const copy = new DatabaseSync(file);
  try { change(copy); } finally { copy.close(); }
  const sidecarFile = path.join(backupsDir, name.replace(/\.sqlite$/, ".meta.json"));
  const meta = JSON.parse(readFileSync(sidecarFile, "utf8"));
  Object.assign(meta, engine.describeFile(file));
  writeFileSync(sidecarFile, JSON.stringify(meta));
}

test("restore returns Context, its Undo and Redo steps and the note versions to the backup state", () => {
  setEntities([task("task:1", "One"), note("note:1", "Note", "first text")]);
  const a = makeClaim("Quiet mornings");
  const b = makeClaim("Coffee at nine");
  const source = makeSource();
  addEvidence(b, source);
  edit(a, "Quiet mornings, no calls");
  undo(); // the redo stack is not empty at backup time
  setEntities([task("task:1", "One"), note("note:1", "Note", "second text")]);
  const atBackup = state();
  assert.ok(history.readHistoryStacks(ws).undo.length > 0 && history.readHistoryStacks(ws).redo.length === 1);
  const backup = store.createBackup("manual");
  assert.ok(backup.claimCount >= 2 && backup.sourceCount === 1 && backup.noteRevisionCount === 2);

  // Afterwards: more claims, another edit, a new redo state, a note edit, a work session, one more source.
  const c = makeClaim("Walk after lunch");
  edit(c, "Walk before lunch");
  makeSource();
  undo();
  undo();
  setEntities([task("task:1", "One"), task("task:2", "Two"), note("note:1", "Note", "third text"), note("note:2", "New note", "x")]);
  work.transitionWorkSession({ workspaceId: ws, action: "start", idempotencyKey: randomUUID(), taskId: "task:2",
    expectedTaskUpdatedAt: 1, expectedRevision: 0, expectedState: "idle" });
  assert.notDeepEqual(state(), atBackup);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM work_sessions").get().value, 1);

  store.restoreBackup(backup.name);
  assert.deepEqual(state(), atBackup);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM work_sessions").get().value, 0, "the work session did not exist at backup time");
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM work_session_commands").get().value, 0);
  assert.equal(noteRevisions.listNoteRevisions(db(), "note:1").length, 2);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM note_revisions WHERE note_id = 'note:2'").get().value, 0);
  assert.deepEqual(store.readSnapshot().entities.map((entity) => entity.id).sort(), ["note:1", "task:1", "workspace:personal"]);

  // Undo and Redo work on the restored stacks.
  const top = history.readHistoryStacks(ws).redo[0];
  assert.ok(top);
  history.runHistoryCommand({ action: "redo", commandId: randomUUID(), workspaceId: ws, expectedEventId: top });
  assert.equal(history.readHistoryStacks(ws).redo.length, 0);

  // What was created after the backup survives in the safety backup.
  const safety = store.listBackups().find((entry) => entry.label === "before-restore");
  const safetyDb = new DatabaseSync(path.join(backupsDir, safety.name), { readOnly: true });
  try {
    assert.equal(safetyDb.prepare("SELECT COUNT(*) AS value FROM work_sessions").get().value, 1);
    assert.ok(safetyDb.prepare("SELECT 1 FROM entities WHERE id = 'note:2'").get());
    assert.ok(safetyDb.prepare("SELECT COUNT(*) AS value FROM context_claims").get().value > backup.claimCount);
  } finally {
    safetyDb.close();
  }
});

test("a backup made at an older schema is upgraded through the real migrations and restored", () => {
  const stamped = store.createBackup("manual");
  const sourcesBefore = db().prepare("SELECT COUNT(*) AS value FROM context_sources").get().value;
  const ids = migrations.schemaMigrations.map((migration) => migration.id);
  const older = ["2026-10-context-sources-and-evidence-records", "2026-10-context-claims-legacy-synced-revision", "2026-10-note-revisions"];
  assert.ok(older.every((id) => ids.includes(id)));
  alterBackup(stamped.name, (copy) => {
    copy.exec(`
      DROP TABLE context_evidence; DROP TABLE context_sources; DROP TABLE note_revisions;
      ALTER TABLE context_claims DROP COLUMN legacy_synced_revision;
      ALTER TABLE context_change_events DROP COLUMN claim_id;
      ALTER TABLE context_change_events DROP COLUMN claim_revision;
      DELETE FROM schema_migrations WHERE id IN (${older.map((id) => `'${id}'`).join(",")});
    `);
  });
  const old = new DatabaseSync(path.join(backupsDir, stamped.name), { readOnly: true });
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'note_revisions'").get(), undefined);
  old.close();

  setEntities([task("task:1", "One"), note("note:1", "Note", "changed after")]);
  db().exec("DELETE FROM note_revisions");
  const claimsBefore = db().prepare("SELECT id FROM context_claims ORDER BY id").all();
  store.restoreBackup(stamped.name);
  // The live schema is complete, the restored data came through the upgrade: notes have their baseline version, claims
  // keep their ids, and the evidence records are rebuilt from the claims' JSON source and evidence.
  assert.deepEqual(db().prepare("SELECT id FROM context_claims ORDER BY id").all(), claimsBefore);
  assert.deepEqual(db().prepare("SELECT note_id, revision, origin FROM note_revisions ORDER BY note_id").all().map((row) => [row.note_id, row.revision, row.origin]),
    [["note:1", 1, "baseline"]]);
  assert.equal(sourcesBefore, 1, "the data the backup was made from held one source");
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM context_sources").get().value, 1, "one source record rebuilt from the claim's JSON source");
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM context_evidence").get().value, 1);
  assert.equal(db().prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, String(store.readSnapshot().revision));
  const applied = db().prepare("SELECT id FROM schema_migrations").all().map((row) => row.id);
  assert.ok(ids.every((id) => applied.includes(id)));
  assert.deepEqual(readdirSync(path.join(dataDir, "tmp")), []);
  const claim = claims.listOwnerClaims(ws, { includeArchived: true })[0];
  assert.ok(claim, "restored claims can be read with the current code");
});
