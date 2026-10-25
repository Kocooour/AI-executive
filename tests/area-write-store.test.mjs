import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-area-writes-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const { mergeSnapshots } = await import("../lib/server-sync.ts");
const { createAreaPreflight } = await import("../lib/area-normalization-preflight.ts");
const { readAreaNormalizationSource } = await import("../lib/area-normalization-source.ts");
const { generatedAreaId } = await import("../lib/area-normalization.ts");
const { commitInboxBatch, InboxBatchInvalid, validateInboxBatch } = await import("../lib/inbox-batch-store.ts");
const ai = await import("../lib/ai-actions.ts");
const work = await import("../lib/work-sessions.ts");

const FALLBACK = generatedAreaId("personal", "Nezařazeno");
const ent = (id, type, properties = {}, extra = {}) => ({
  id, type, title: "T " + id, workspaceId: "personal", properties,
  status: type === "task" ? "open" : "active", createdAt: 10, updatedAt: Date.now() + 1000, ...extra,
});
const rel = (id, s, t, type, createdAt = 50) => ({ id, sourceEntityId: s, targetEntityId: t, relationType: type, workspaceId: "personal", createdAt });
const snap = () => store.readSnapshot();
// What an app save sends: the full current state with the given records changed or added.
function save(change, { deletedIds = [] } = {}) {
  const current = snap();
  const next = change({ entities: [...current.entities], relations: [...current.relations] });
  const result = store.replaceSnapshot(current.revision, next.entities, next.relations, deletedIds, [], current.restoreGeneration);
  assert.equal(result.conflict, false);
  return result.snapshot;
}
const get = (id) => snap().entities.find((e) => e.id === id);
const links = (id, type = "belongs_to_area") => snap().relations.filter((r) => r.sourceEntityId === id && r.relationType === type);
const preflight = () => { const { source, identity, at } = readAreaNormalizationSource(store.getDatabase()); return createAreaPreflight(source, identity, at); };
const db = () => store.getDatabase();
const addRow = (entity) => db().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
const addLink = (relation) => db().prepare("INSERT INTO relations (id,payload,created_at) VALUES (?,?,?)").run(relation.id, JSON.stringify(relation), relation.createdAt);

test("a new project and a new standalone task are stored with the fallback Area (created with kind)", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("p1", "project"), ent("t1", "task", { inbox: true })] }));
  const fallback = get(FALLBACK);
  assert.equal(fallback.title, "Nezařazeno");
  assert.equal(fallback.properties.kind, "private");
  assert.deepEqual(links("p1").map((r) => r.targetEntityId), [FALLBACK]);
  assert.deepEqual(links("t1").map((r) => r.targetEntityId), [FALLBACK]);
  assert.equal(preflight().noChanges, true, "everything written so far is already normalized");
});

test("PUT: assigning Area B replaces existing Area A; the 2a preflight remains clear", () => {
  save((before) => ({ ...before,
    entities: [...before.entities, ent("move-area-b", "area", { kind: "private" }), ent("reassign-task", "task")],
  }));
  assert.deepEqual(links("reassign-task").map((link) => link.targetEntityId), [FALLBACK]);
  const oldId = links("reassign-task")[0].id;
  const response = save((before) => ({
    ...before,
    relations: [...before.relations, rel("r:reassign-b", "reassign-task", "move-area-b", "belongs_to_area", 90)],
  }));
  assert.deepEqual(links("reassign-task").map((link) => link.targetEntityId), ["move-area-b"]);
  assert.ok(response.tombstones.some((entry) => entry.id === oldId), "previous Area link must be tombstoned");
  assert.equal(preflight().noChanges, true);
});

test("PUT: a new project and task with legacy areaId are canonical without a 2a follow-up", () => {
  save((before) => ({
    ...before, entities: [...before.entities,
      ent("legacy-area-task", "task", { areaId: "move-area-b" }),
      ent("legacy-area-project", "project", { areaId: "move-area-b" }),
    ],
  }));
  for (const id of ["legacy-area-task", "legacy-area-project"]) {
    assert.deepEqual(links(id).map((link) => link.targetEntityId), ["move-area-b"]);
    assert.equal("areaId" in get(id).properties, false);
  }
  assert.equal(preflight().noChanges, true);
});

test("PUT: invalid explicit Area references rollback without modifying the store", () => {
  const before = snap();
  assert.throws(() => save((s) => ({ ...s,
    entities: [...s.entities, ent("invalid-area-item", "task", { areaId: "missing-area" })],
  })), /Invalid Area assignment/);
  assert.equal(snap().revision, before.revision);
  assert.equal(get("invalid-area-item"), undefined);
  assert.equal(preflight().noChanges, true);
});

test("PUT: reviving the tombstoned original Area link does not override the newer Area", () => {
  const current = snap();
  const old = current.tombstones.find((t) => t.id === current.tombstones.find((t) => t.id?.startsWith("relation:2a:"))?.id);
  const original = old && current.relations.find((r) => r.id === old.id);
  assert.equal(original, undefined, "the tombstoned link must be absent");
  // This test uses the task previously moved from the fallback Area to move-area-b.
  const id = [...current.tombstones].reverse().find((t) => t.id.startsWith("relation:2a:"))?.id;
  assert.ok(id);
  const task = get("reassign-task");
  const area = get(FALLBACK);
  assert.ok(task && area);
  const revived = rel(id, task.id, area.id, "belongs_to_area", 40);
  const attempt = store.replaceSnapshot(current.revision, current.entities,
    [...current.relations, revived], [], [id], current.restoreGeneration);
  assert.equal(attempt.conflict, false);
  assert.deepEqual(links(task.id).map((r) => r.targetEntityId), ["move-area-b"]);
  assert.ok(snap().tombstones.some((t) => t.id === id), "stale old link is tombstoned again");
  assert.equal(preflight().noChanges, true);
});

test("PUT: free-text legacy Area becomes a canonical Area and link immediately", () => {
  save((before) => ({ ...before,
    entities: [...before.entities,
      ent("legacy-label-task", "task", { area: "   Rodina  " }),
      ent("legacy-label-project", "project", { area: "rodina" }),
    ],
  }));
  const areaId = generatedAreaId("personal", "Rodina");
  assert.equal(get(areaId).properties.kind, "private");
  for (const id of ["legacy-label-task", "legacy-label-project"]) {
    assert.deepEqual(links(id).map((r) => r.targetEntityId), [areaId]);
    assert.equal("area" in get(id).properties, false);
  }
  assert.equal(preflight().noChanges, true);
});

test("an old client that adds a task-level Area to a task in a project is stored without it", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("area:work", "area", { kind: "private" }), ent("tp", "task", { areaId: "area:work" })],
    relations: [...s.relations, rel("r:tp-proj", "tp", "p1", "belongs_to_project"), rel("r:tp-area", "tp", "area:work", "belongs_to_area")] }));
  assert.deepEqual(links("tp"), []);
  assert.equal("areaId" in get("tp").properties, false);
  assert.equal(links("tp", "belongs_to_project").length, 1);
  assert.ok(snap().tombstones.some((t) => t.id === "r:tp-area"), "the dropped relation is announced as deleted");
  assert.equal(preflight().noChanges, true);
});

test("moving a task into a project removes its own Area link; taking it out gives the fallback", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("area:home", "area", { kind: "private" }), ent("mv", "task")],
    relations: [...s.relations, rel("r:mv-home", "mv", "area:home", "belongs_to_area")] }));
  assert.deepEqual(links("mv").map((r) => r.targetEntityId), ["area:home"]);
  save((s) => ({ ...s, relations: [...s.relations, rel("r:mv-proj", "mv", "p1", "belongs_to_project")] }));
  assert.deepEqual(links("mv"), []);
  assert.equal(preflight().noChanges, true);
  save((s) => ({ ...s, relations: s.relations.filter((r) => r.id !== "r:mv-proj") }), { deletedIds: ["r:mv-proj"] });
  assert.deepEqual(links("mv").map((r) => r.targetEntityId), [FALLBACK]);
  assert.equal(preflight().noChanges, true);
});

test("a base-less old client that strips an Area's kind gets it restored", () => {
  const before = get("area:home");
  save((s) => ({ ...s, entities: s.entities.map((e) => e.id === "area:home" ? { ...e, title: "Domov", updatedAt: before.updatedAt + 5000, properties: {} } : e) }));
  assert.equal(get("area:home").properties.kind, "private");
  assert.equal(get("area:home").title, "Domov");
  assert.equal(preflight().noChanges, true);
});

test("untouched legacy violations survive an unrelated save (they belong to the audited applicator)", () => {
  addRow(ent("legacy-p", "project"));
  addRow(ent("legacy-t", "task", { areaId: "area:home" }));
  addLink(rel("r:legacy-p-area", "legacy-p", "area:home", "belongs_to_area"));
  addLink(rel("r:legacy-t-proj", "legacy-t", "legacy-p", "belongs_to_project"));
  addLink(rel("r:legacy-t-area", "legacy-t", "area:home", "belongs_to_area"));
  const before = snap();
  save((s) => ({ ...s, entities: s.entities.map((e) => e.id === "t1" ? { ...e, title: "renamed", updatedAt: e.updatedAt + 1 } : e) }));
  assert.equal(links("legacy-p").length, 1);
  assert.equal(links("legacy-t").length, 1);
  assert.equal(get("legacy-t").properties.areaId, "area:home");
  assert.equal(get("legacy-t").updatedAt, before.entities.find((e) => e.id === "legacy-t").updatedAt);
  assert.equal(preflight().noChanges, false, "still pending for the applicator");
  db().prepare("DELETE FROM entities WHERE id IN ('legacy-p','legacy-t')").run();
  db().prepare("DELETE FROM relations WHERE id IN ('r:legacy-t-proj','r:legacy-t-area','r:legacy-p-area')").run();
});

// ---- client round trip --------------------------------------------------------------------------------------------
test("round trip: the corrected relation is adopted by the client; it is not re-sent or resurrected (with and without a sync base)", () => {
  const device = snap();                                   // what the device holds and shares with the server (its base)
  const localEntities = [...device.entities, ent("rt-area", "area", { kind: "private" }), ent("rt", "task", { areaId: "rt-area" })];
  const localRelations = [...device.relations, rel("rt-proj", "rt", "p1", "belongs_to_project"), rel("rt-area-link", "rt", "rt-area", "belongs_to_area")];
  const sent = store.replaceSnapshot(device.revision, localEntities, localRelations, [], [], device.restoreGeneration);
  assert.equal(sent.conflict, false);
  const stored = sent.snapshot;
  assert.equal(stored.relations.some((r) => r.id === "rt-area-link"), false);
  const canonical = (snapshot) => ({ ...snapshot, entities: [...snapshot.entities].sort((a, b) => (a.id < b.id ? -1 : 1)),
    relations: [...snapshot.relations].sort((a, b) => (a.id < b.id ? -1 : 1)), tombstones: [...snapshot.tombstones].sort((a, b) => (a.id < b.id ? -1 : 1)) });
  assert.deepEqual(canonical(stored), canonical(snap()), "the response is exactly what was stored");

  // A. The client adopts the response: local = base = stored. Nothing differs, the next merge is a no-op ...
  const merged = mergeSnapshots(stored, stored.entities, stored.relations, { entities: stored.entities, relations: stored.relations });
  assert.deepEqual(merged.relations.map((r) => r.id).sort(), stored.relations.map((r) => r.id).sort());
  // ... and saving it again changes nothing (no ping-pong).
  const again = store.replaceSnapshot(stored.revision, merged.entities, merged.relations, [], [], stored.restoreGeneration);
  assert.equal(again.conflict, false);
  assert.deepEqual(again.snapshot.relations.map((r) => r.id).sort(), stored.relations.map((r) => r.id).sort());
  assert.deepEqual(again.snapshot.entities.map((e) => [e.id, e.updatedAt]).sort(), stored.entities.map((e) => [e.id, e.updatedAt]).sort());

  // B. The adoption was skipped (local data changed meanwhile): the device keeps its copy with the link and its base is
  // what it sent. With the base the server's removal wins ...
  const server = snap();
  const withBase = mergeSnapshots(server, localEntities, localRelations, { entities: localEntities, relations: localRelations });
  assert.equal(withBase.relations.some((r) => r.id === "rt-area-link"), false);
  // ... and without a base the corrected entity carries a newer relationsUpdatedAt, so its relation set wins too.
  const withoutBase = mergeSnapshots(server, localEntities, localRelations, null);
  assert.equal(withoutBase.relations.some((r) => r.sourceEntityId === "rt" && r.relationType === "belongs_to_area"), false);
  const resent = store.replaceSnapshot(server.revision, withoutBase.entities, withoutBase.relations, [], [], server.restoreGeneration);
  assert.equal(resent.conflict, false);
  assert.deepEqual(links("rt"), []);
  assert.equal(links("rt", "belongs_to_project").length, 1);
});

// ---- Inbox batch --------------------------------------------------------------------------------------------------
const batch = (tasks, action, targets = []) => ({
  workspaceId: "personal", restoreGeneration: snap().restoreGeneration,
  selection: tasks.map((t) => ({ id: t.id, updatedAt: get(t.id).updatedAt })), action,
  targets: targets.map((x) => ({ id: x.id, type: x.type, title: get(x.id).title, updatedAt: get(x.id).updatedAt })),
});

test("Inbox batch: organize into a project removes the tasks' own Area link (they inherit); an Area only replaces it", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("ib1", "task", { inbox: true }), ent("ib2", "task", { inbox: true }), ent("ib-proj", "project"), ent("ib-area", "area", { kind: "private" })] }));
  assert.deepEqual(links("ib1").map((r) => r.targetEntityId), [FALLBACK]);
  commitInboxBatch(batch([get("ib1"), get("ib2")], "organize", [get("ib-proj") && { id: "ib-proj", type: "project" }]));
  for (const id of ["ib1", "ib2"]) {
    assert.deepEqual(links(id), []);
    assert.deepEqual(links(id, "belongs_to_project").map((r) => r.targetEntityId), ["ib-proj"]);
    assert.equal(get(id).properties.inbox, false);
  }
  save((s) => ({ ...s, entities: [...s.entities, ent("ib3", "task", { inbox: true })] }));
  const staleDevice = snap();
  const oldAreaLinkId = links("ib3")[0].id;
  commitInboxBatch(batch([get("ib3")], "organize", [{ id: "ib-area", type: "area" }]));
  assert.deepEqual(links("ib3").map((r) => r.targetEntityId), ["ib-area"]);
  assert.ok(snap().tombstones.some((t) => t.id === oldAreaLinkId), "SQL deletion must tombstone its old Area link");
  const stale = mergeSnapshots(snap(), staleDevice.entities, staleDevice.relations, {
    entities: staleDevice.entities, relations: staleDevice.relations,
  });
  assert.equal(stale.relations.some((r) => r.id === oldAreaLinkId), false, "stale device cannot restore old Area");
  assert.equal(preflight().noChanges, true);
});

test("Inbox batch: an Area for a task that is in a project is refused whole; project and Area together are invalid", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("ib4", "task", { inbox: true }), ent("ib5", "task", { inbox: true })],
    relations: [...s.relations, rel("r:ib4-proj", "ib4", "ib-proj", "belongs_to_project")] }));
  const before = snap();
  assert.throws(() => commitInboxBatch(batch([get("ib4"), get("ib5")], "organize", [{ id: "ib-area", type: "area" }])), InboxBatchInvalid);
  assert.equal(snap().revision, before.revision, "nothing was written");
  assert.deepEqual(links("ib4"), []);
  assert.throws(() => validateInboxBatch(batch([get("ib5")], "organize", [{ id: "ib-area", type: "area" }, { id: "ib-proj", type: "project" }])));
  // other actions leave the Area alone
  commitInboxBatch(batch([get("ib5")], "waiting"));
  assert.deepEqual(links("ib5").map((r) => r.targetEntityId), [FALLBACK]);
});

// ---- AI actions ---------------------------------------------------------------------------------------------------
test("AI actions: a created standalone task gets the fallback Area, a project task none; undo stays possible", async () => {
  const binding = "binding-" + randomUUID();
  const planned = await ai.planAIRequest({ message: "Přidej úkol Zavolat Petrovi", readWorkspaceId: "personal", writeWorkspaceId: "personal", sessionBinding: binding });
  assert.ok(planned.proposal);
  const applied = ai.confirmAIProposal(planned.proposal.id, binding);
  const created = snap().entities.find((e) => e.title === "Zavolat Petrovi");
  assert.deepEqual(links(created.id).map((r) => r.targetEntityId), [FALLBACK]);
  ai.undoAIAction(applied.actionId, binding);
  assert.equal(get(created.id), undefined);
  assert.deepEqual(links(created.id), []);

  const second = await ai.planAIRequest({ message: "Přidej do projektu T ib-proj úkol Zavolat Evě", readWorkspaceId: "personal", writeWorkspaceId: "personal", sessionBinding: binding });
  assert.ok(second.proposal, second.message);
  ai.confirmAIProposal(second.proposal.id, binding);
  const inProject = snap().entities.find((e) => e.title === "Zavolat Evě");
  assert.deepEqual(links(inProject.id), []);
  assert.deepEqual(links(inProject.id, "belongs_to_project").map((r) => r.targetEntityId), ["ib-proj"]);
});

test("AI actions: moving a standalone task into a project drops its Area link; undo returns it to the fallback", async () => {
  const binding = "binding-" + randomUUID();
  save((s) => ({ ...s, entities: [...s.entities, ent("ai-mv", "task", {}, { title: "Posunout mne" }), ent("area:keep", "area", { kind: "private" })],
    relations: [...s.relations, rel("r:ai-mv-keep", "ai-mv", "area:keep", "belongs_to_area")] }));
  assert.deepEqual(links("ai-mv").map((r) => r.targetEntityId), ["area:keep"]);
  const planned = await ai.planAIRequest({ message: "Přesuň úkol Posunout mne do projektu T ib-proj", readWorkspaceId: "personal", writeWorkspaceId: "personal", sessionBinding: binding });
  assert.ok(planned.proposal, planned.message);
  const applied = ai.confirmAIProposal(planned.proposal.id, binding);
  assert.deepEqual(links("ai-mv"), []);
  assert.ok(snap().tombstones.some((t) => t.id === "r:ai-mv-keep"), "AI move tombstones the prior Area link");
  assert.equal(links("ai-mv", "belongs_to_project").length, 1);
  ai.undoAIAction(applied.actionId, binding);
  assert.equal(links("ai-mv", "belongs_to_project").length, 0);
  assert.deepEqual(links("ai-mv").map((r) => r.targetEntityId), [FALLBACK]);
});

// ---- Work sessions: recurring occurrence --------------------------------------------------------------------------
function finish(task) {
  let now = Date.parse("2026-10-03T10:00:00Z");
  const clock = () => now;
  const started = work.transitionWorkSession({ workspaceId: "personal", action: "start", idempotencyKey: randomUUID(), taskId: task.id,
    expectedTaskUpdatedAt: get(task.id).updatedAt, expectedRevision: 0, expectedState: "idle" }, clock);
  now += 60_000;
  work.transitionWorkSession({ workspaceId: "personal", action: "finish", idempotencyKey: randomUUID(),
    expectedRevision: started.session.revision, expectedState: "running" }, clock);
  return `${task.id}:occurrence:2026-10-10`;
}
const recurrence = { frequency: "weekly", interval: 1, mode: "scheduled" };

test("recurring occurrence: a standalone task keeps its Area; one without gets the fallback; a project task inherits", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("rc1", "task", { when: "2026-10-03", recurrence }), ent("rc2", "task", { when: "2026-10-03", recurrence }),
    ent("rc3", "task", { when: "2026-10-03", recurrence, areaId: "area:keep" }), ent("area:rc", "area", { kind: "private" })],
  relations: [...s.relations, rel("r:rc1", "rc1", "area:rc", "belongs_to_area"), rel("r:rc3-proj", "rc3", "ib-proj", "belongs_to_project"), rel("r:rc3-area", "rc3", "area:rc", "belongs_to_area")] }));
  // rc2: legacy standalone task without any Area
  for (const row of db().prepare("SELECT id, payload FROM relations").all()) if (JSON.parse(row.payload).sourceEntityId === "rc2") db().prepare("DELETE FROM relations WHERE id = ?").run(row.id);
  const n1 = finish(get("rc1"));
  assert.deepEqual(links(n1).map((r) => r.targetEntityId), ["area:rc"]);
  const n2 = finish(get("rc2"));
  assert.deepEqual(links(n2).map((r) => r.targetEntityId), [FALLBACK]);
  const n3 = finish(get("rc3"));
  assert.deepEqual(links(n3), []);
  assert.equal("areaId" in get(n3).properties, false);
  assert.deepEqual(links(n3, "belongs_to_project").map((r) => r.targetEntityId), ["ib-proj"]);
  // rc2 was made Area-less on purpose (legacy); remove it so later preflight checks see only new writes.
  save((s) => ({ ...s, entities: s.entities.filter((e) => e.id !== "rc2") }), { deletedIds: ["rc2"] });
});

test("deleting a project leaves no dangling projectId: its tasks get the fallback Area and the 2a preflight is not blocked", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("dp", "project"), ent("dp-t1", "task", { projectId: "dp" }), ent("dp-t2", "task")],
    relations: [...s.relations, rel("r:dp-t2", "dp-t2", "dp", "belongs_to_project")] }));
  assert.deepEqual(links("dp-t1"), []);
  save((s) => ({ ...s, entities: s.entities.filter((e) => e.id !== "dp"), relations: s.relations.filter((r) => r.sourceEntityId !== "dp" && r.targetEntityId !== "dp") }), { deletedIds: ["dp"] });
  assert.equal("projectId" in get("dp-t1").properties, false);
  assert.deepEqual(links("dp-t1").map((r) => r.targetEntityId), [FALLBACK]);
  assert.deepEqual(links("dp-t2").map((r) => r.targetEntityId), [FALLBACK]);
  const result = preflight();
  assert.equal(result.noChanges, true, "no invalid-task-project, nothing pending");
});

test("a task joining and leaving a project many times is never left without an Area", () => {
  save((s) => ({ ...s, entities: [...s.entities, ent("cy", "task"), ent("cy-p", "project")] }));
  for (let cycle = 0; cycle < 14; cycle += 1) {
    save((s) => ({ ...s, relations: [...s.relations, rel("cy-join-" + cycle, "cy", "cy-p", "belongs_to_project")] }));
    assert.deepEqual(links("cy"), []);
    save((s) => ({ ...s, relations: s.relations.filter((r) => r.id !== "cy-join-" + cycle) }), { deletedIds: ["cy-join-" + cycle] });
    assert.equal(links("cy").length, 1, "cycle " + cycle);
  }
});

test("a raw PUT cannot rename or delete the protected system fallback Area", () => {
  const before = snap();
  assert.ok(get(FALLBACK));
  assert.throws(() => save((s) => ({ ...s,
    entities: s.entities.filter((e) => e.id !== FALLBACK),
    relations: s.relations.filter((r) => r.targetEntityId !== FALLBACK),
  }), { deletedIds: [FALLBACK, ...before.relations.filter((r) => r.targetEntityId === FALLBACK).map((r) => r.id)] }), /Invalid Area assignment/);
  assert.throws(() => save((s) => ({ ...s,
    entities: s.entities.map((e) => e.id === FALLBACK ? { ...e, title: "Deleted via rename" } : e),
  })), /Invalid Area assignment/);
  assert.equal(snap().revision, before.revision);
  assert.ok(get(FALLBACK));
  assert.equal(preflight().noChanges, true);
});
