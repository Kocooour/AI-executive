import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d-note-live-"));
const legacy = path.join(root, "production-sentinel");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "keep"), "unchanged");
const previousDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { readAuthorizedTargetNote } = await import("../lib/target-note-access.ts");
const { verifyTargetStagingReadLive, issueDurableTargetStagingSession,
  hashTargetStagingSessionToken, revokeDurableTargetStagingSession } =
  await import("../lib/target-staging-durable-session.ts");

const fixtures = [];
function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const store = {
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  };
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run("personal-" + user, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?,'Unassigned','private',?,?,'unassigned')`)
      .run("unassigned-" + user, "personal-" + user, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(user, role);
  }
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','team-area','Project')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('private',?,'Private','Private body')")
    .run(stage.unassignedAreaId);
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('child','project','Child','Shared body')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('direct','team-area','Direct','Shared standalone')").run();
  fixtures.push(db);
  return { stage, store, db };
}
after(() => {
  for (const db of fixtures) db.close();
  if (previousDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previousDataDir;
  assert.equal(readFileSync(path.join(legacy, "keep"), "utf8"), "unchanged");
  rmSync(root, { recursive: true, force: true });
});
const snapshot = (db, actor, id) => {
  const found = readAuthorizedTargetNote(db, { actorUserId: actor, noteId: id });
  assert.ok(found, "fixture must be initially readable");
  return found;
};
const release = (store, actor, observed) => verifyTargetStagingReadLive(
  store, { ownerUserId: actor }, observed.linearization, Date.now(),
  undefined, undefined, observed.guard,
);
const stale = { ok: false, reason: "stale" };

test("exact notes release for current private owner and shared viewer/editor; reject mismatched actor", () => {
  const { store, db } = fixture();
  for (const [actor, note] of [["alice", "private"], ["bob", "child"], ["carol", "direct"]]) {
    const view = snapshot(db, actor, note);
    assert.deepEqual(release(store, actor, view), { ok: true });
    assert.deepEqual(release(store, "carol" === actor ? "bob" : "carol", view),
      { ok: false, reason: "unavailable" });
  }
  assert.equal(readAuthorizedTargetNote(db, { actorUserId: "bob", noteId: "private" }), null);
});

test("edited note body and content ABA cannot release an earlier snapshot", () => {
  const { store, db } = fixture();
  const view = snapshot(db, "bob", "child");
  db.prepare("UPDATE notes SET body='Revised' WHERE id='child'").run();
  assert.deepEqual(release(store, "bob", view), stale);
  db.prepare("UPDATE notes SET body='Shared body' WHERE id='child'").run();
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='child'").get().body, view.note.body);
  assert.deepEqual(release(store, "bob", view), stale);
  assert.deepEqual(release(store, "bob", snapshot(db, "bob", "child")), { ok: true });
});

test("project metadata ABA invalidates inherited note snapshots even without Area change", () => {
  const { store, db } = fixture();
  const view = snapshot(db, "bob", "child");
  db.prepare("UPDATE projects SET title='Renamed' WHERE id='project'").run();
  assert.deepEqual(release(store, "bob", view), stale);
  db.prepare("UPDATE projects SET title='Project' WHERE id='project'").run();
  assert.deepEqual(release(store, "bob", view), stale);
  assert.deepEqual(release(store, "bob", snapshot(db, "bob", "child")), { ok: true });
});

test("reparenting and a future confirmed project move invalidate the old note snapshot", () => {
  const { store, db, stage } = fixture();
  const child = snapshot(db, "bob", "child");
  // Same effective Area, but the note no longer inherits the parent.
  db.prepare("UPDATE notes SET project_id=NULL,area_id='team-area' WHERE id='child'").run();
  assert.deepEqual(release(store, "bob", child), stale);
  const newView = snapshot(db, "bob", "child");
  assert.equal(newView.guard.projectId, null);
  assert.deepEqual(release(store, "bob", newView), { ok: true });

  const attached = snapshot(db, "bob", "direct");
  // Independent standalone notes are unaffected by a project title change.
  db.prepare("UPDATE projects SET title='New project title' WHERE id='project'").run();
  assert.deepEqual(release(store, "bob", attached), { ok: true });

  // Project Area moves are intentionally forbidden in the active staging model.
  // Simulate a future confirmed move in this disposable store only, restoring
  // exactly the canonical guard before committing (same as project ACL tests).
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('attached','project','Linked','Contents')").run();
  const beforeMove = snapshot(db, "bob", "attached");
  const moveGuard = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='project_area_assignment_guard'",
  ).get()?.sql;
  assert.equal(typeof moveGuard, "string");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TRIGGER project_area_assignment_guard");
    db.prepare("UPDATE projects SET area_id=? WHERE id='project'").run(stage.unassignedAreaId);
    db.exec(moveGuard + ";");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  assert.deepEqual(release(store, "bob", beforeMove), stale);
  assert.equal(readAuthorizedTargetNote(db, { actorUserId: "bob", noteId: "attached" }), null);
  assert.equal(snapshot(db, "alice", "attached").note.areaId, stage.unassignedAreaId);
});

test("role revocation and valid durable-session revocation invalidate the live release", () => {
  const { store, db } = fixture();
  const view = snapshot(db, "bob", "child");
  const session = issueDurableTargetStagingSession(store, "bob");
  assert.equal(session.ok, true, JSON.stringify(session));
  const subject = { tokenHash: hashTargetStagingSessionToken(session.sessionToken) };
  const check = () => verifyTargetStagingReadLive(
    store, subject, view.linearization, Date.now(), undefined, undefined, view.guard,
  );
  assert.deepEqual(check(), { ok: true });
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(check(), stale);
  assert.deepEqual(revokeDurableTargetStagingSession(store, session.sessionId),
    { ok: true, changed: true });
  assert.deepEqual(check(), { ok: false, reason: "invalid", code: "session_revoked" });
});

test("invalid, forged or inconsistent note guards fail closed", () => {
  const { store, db, stage } = fixture();
  const view = snapshot(db, "alice", "private");
  for (const guard of [
    { ...view.guard, noteId: ".." },
    { ...view.guard, noteId: "x\u0000bad" },
    { ...view.guard, noteId: "x".repeat(513) },
    { ...view.guard, areaId: "team-area" },
    { ...view.guard, projectId: "project", parentRevision: 0 },
    { ...view.guard, noteRevision: -1 },
    { ...view.guard, parentRevision: 0 },
    { ...view.guard, noteId: "missing" },
  ]) {
    const result = verifyTargetStagingReadLive(
      store, { ownerUserId: "alice" }, view.linearization,
      Date.now(), undefined, undefined, guard,
    );
    assert.equal(result.ok, false, JSON.stringify(guard));
  }
  assert.deepEqual(release({ ...store, expectedRestoreGeneration: randomUUID() }, "alice", view),
    { ok: false, reason: "unavailable" });
  assert.deepEqual(release(store, "alice", view), { ok: true });
  assert.equal(view.guard.areaId, stage.unassignedAreaId);
});
