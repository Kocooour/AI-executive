import assert from "node:assert/strict";
import test from "node:test";

const { mergeEntity, mergeRelations, entityConflicts } = await import("../lib/field-merge.ts");
const { mergeSnapshots } = await import("../lib/server-sync.ts");

const task = (overrides = {}, properties = {}) => ({
  id: "t1", type: "task", title: "Zavolat", status: "open", workspaceId: "personal",
  createdAt: 1, updatedAt: 10, ...overrides,
  properties: { priority: "none", notes: "", ...properties },
});
const relation = (target, type = "belongs_to_project", id = `${target}-${type}`) => ({
  id, workspaceId: "personal", sourceEntityId: "t1", targetEntityId: target, relationType: type, createdAt: 1,
});

test("different fields changed on two devices are both kept, without a conflict", () => {
  const base = task();
  const local = task({ title: "Zavolat Petrovi", updatedAt: 20 });
  const server = task({ updatedAt: 30 }, { priority: "high", deadline: "2026-10-10" });
  const merged = mergeEntity(base, local, server, 100);
  assert.equal(merged.title, "Zavolat Petrovi");
  assert.equal(merged.properties.priority, "high");
  assert.equal(merged.properties.deadline, "2026-10-10");
  assert.equal(merged.updatedAt, 30);
  assert.deepEqual(entityConflicts(merged), []);
});

test("the same field changed on both devices: the newer wins and the replaced value is kept", () => {
  const base = task({}, { notes: "původní" });
  const local = task({ updatedAt: 20 }, { notes: "z telefonu" });
  const server = task({ updatedAt: 30 }, { notes: "z počítače" });
  const merged = mergeEntity(base, local, server, 100);
  assert.equal(merged.properties.notes, "z počítače");
  const [conflict] = entityConflicts(merged);
  assert.equal(conflict.field, "properties.notes");
  assert.equal(conflict.lostValue, "z telefonu");
  // The local record is newer: its value wins.
  const localNewer = mergeEntity(base, { ...local, updatedAt: 40 }, server, 100);
  assert.equal(localNewer.properties.notes, "z telefonu");
  assert.equal(entityConflicts(localNewer)[0].lostValue, "z počítače");
});

test("the same change on both devices is not a conflict", () => {
  const merged = mergeEntity(task(), task({ status: "done", updatedAt: 20 }), task({ status: "done", updatedAt: 30 }), 100);
  assert.equal(merged.status, "done");
  assert.deepEqual(entityConflicts(merged), []);
});

test("a field removed on one device and left alone on the other is removed", () => {
  const merged = mergeEntity(task({}, { deadline: "2026-10-10" }), task({ updatedAt: 20 }, {}), task({ updatedAt: 5 }, { deadline: "2026-10-10" }), 100);
  assert.equal("deadline" in merged.properties, false);
});

test("activity logs from both devices are joined; bookkeeping is never a conflict", () => {
  const base = task({}, { activity: [{ at: 1, action: "created" }], manualOrders: { a: 1 } });
  const local = task({ updatedAt: 20 }, { activity: [{ at: 1, action: "created" }, { at: 5, action: "renamed" }], manualOrders: { a: 2 } });
  const server = task({ updatedAt: 30 }, { activity: [{ at: 1, action: "created" }, { at: 3, action: "completed" }], manualOrders: { a: 3, b: 1 } });
  const merged = mergeEntity(base, local, server, 100);
  assert.deepEqual(merged.properties.activity.map((entry) => entry.action), ["created", "completed", "renamed"]);
  assert.deepEqual(merged.properties.manualOrders, { a: 3, b: 1 });
  assert.deepEqual(entityConflicts(merged), []);
});

test("checklist items are merged one by one", () => {
  const item = (id, title, done = false) => ({ id, title, done });
  const base = task({}, { checklist: [item("a", "Mléko"), item("b", "Chléb")] });
  const local = task({ updatedAt: 20 }, { checklist: [item("a", "Mléko", true), item("b", "Chléb"), item("c", "Vejce")] });
  const server = task({ updatedAt: 30 }, { checklist: [item("a", "Mléko"), item("d", "Máslo")] });
  const merged = mergeEntity(base, local, server, 100);
  // a ticked here, b removed there, c added here, d added there.
  assert.deepEqual(merged.properties.checklist, [item("a", "Mléko", true), item("d", "Máslo"), item("c", "Vejce")]);
  assert.deepEqual(entityConflicts(merged), []);
});

test("a dismissed conflict stays dismissed when the other device merges", () => {
  const conflict = { id: "k1", field: "title", lostValue: "A", at: 1 };
  const base = task({}, { syncConflicts: [conflict] });
  const local = task({ updatedAt: 20 }, { syncConflicts: [] });
  const server = task({ updatedAt: 30 }, { syncConflicts: [conflict], priority: "high" });
  const merged = mergeEntity(base, local, server, 100);
  assert.deepEqual(entityConflicts(merged), []);
  assert.equal(merged.properties.priority, "high");
});

test("relations: a project changed on one device is kept; changed on both, the newer wins", () => {
  const onlyLocal = mergeRelations([relation("p1")], [relation("p2")], [relation("p1")], () => false, 100);
  assert.deepEqual(onlyLocal.relations.map((item) => item.targetEntityId), ["p2"]);
  assert.equal(onlyLocal.conflicts.size, 0);
  const both = mergeRelations([relation("p1")], [relation("p2")], [relation("p3")], () => false, 100);
  assert.deepEqual(both.relations.map((item) => item.targetEntityId), ["p3"]);
  assert.equal(both.conflicts.get("t1")[0].field, "relation.belongs_to_project");
  assert.equal(both.conflicts.get("t1")[0].lostValue, "p2");
  // An area added on one device and a project changed on the other are both kept.
  const independent = mergeRelations([relation("p1")], [relation("p1"), relation("a1", "belongs_to_area")], [relation("p3")], () => false, 100);
  assert.deepEqual(independent.relations.map((item) => item.targetEntityId).sort(), ["a1", "p3"]);
});

test("mergeSnapshots with a common version merges fields; without one it keeps the newer record", () => {
  const project = (id) => ({ id, type: "project", title: id, status: "active", workspaceId: "personal", createdAt: 1, updatedAt: 1, properties: {} });
  const base = { entities: [task(), project("p1"), project("p2")], relations: [relation("p1")] };
  const local = [task({ title: "Zavolat Petrovi", updatedAt: 20 }), project("p1"), project("p2")];
  const server = { revision: 5, updatedAt: 0, entities: [task({ updatedAt: 30 }, { priority: "high" }), project("p1"), project("p2")], relations: [relation("p2")] };
  const merged = mergeSnapshots(server, local, [relation("p1")], base);
  const mergedTask = merged.entities.find((entity) => entity.id === "t1");
  assert.equal(mergedTask.title, "Zavolat Petrovi");
  assert.equal(mergedTask.properties.priority, "high");
  assert.deepEqual(merged.relations.map((item) => item.targetEntityId), ["p2"]);
  const legacy = mergeSnapshots(server, local, [relation("p1")]);
  assert.equal(legacy.entities.find((entity) => entity.id === "t1").title, "Zavolat");
});

test("a record deleted on the server stays deleted; a record deleted here does not lose server relations of others", () => {
  const project = (id) => ({ id, type: "project", title: id, status: "active", workspaceId: "personal", createdAt: 1, updatedAt: 1, properties: {} });
  const base = { entities: [task(), project("p1")], relations: [relation("p1")] };
  const server = { revision: 5, updatedAt: 0, tombstones: [{ id: "t1", deletedAt: 2 }], entities: [project("p1")], relations: [] };
  const merged = mergeSnapshots(server, [task({ title: "Upraveno", updatedAt: 20 }), project("p1")], [relation("p1")], base);
  assert.equal(merged.entities.some((entity) => entity.id === "t1"), false);
  assert.deepEqual(merged.relations, []);
  // The task is not on this device (for example deleted here and waiting to be sent): its
  // relations on the server are not treated as removed here.
  const kept = mergeSnapshots({ revision: 5, updatedAt: 0, entities: [task(), project("p1")], relations: [relation("p1")] }, [project("p1")], [], base);
  assert.deepEqual(kept.relations.map((item) => item.targetEntityId), ["p1"]);
});

const { limitConflicts } = await import("../lib/field-merge.ts");

test("a conflict on a very long field keeps the record within the server's size limit", () => {
  const merged = mergeEntity(task({}, { notes: "" }), task({ updatedAt: 20 }, { notes: "a".repeat(130_000) }), task({ updatedAt: 30 }, { notes: "b".repeat(130_000) }), 100);
  assert.equal(merged.properties.notes, "b".repeat(130_000));
  assert.ok(JSON.stringify(merged.properties).length <= 250_000);
  const [conflict] = entityConflicts(merged);
  assert.equal(conflict.field, "properties.notes");
  assert.equal(conflict.truncated, true);
  assert.ok(String(conflict.lostValue).startsWith("aaa"));
});

test("a checklist conflict keeps only the items whose other version was replaced", () => {
  const base = task({}, { checklist: [{ id: "a", title: "A", done: false }, { id: "b", title: "B", done: false }] });
  const local = task({ updatedAt: 20 }, { checklist: [{ id: "a", title: "A z telefonu", done: false }, { id: "b", title: "B", done: false }] });
  const server = task({ updatedAt: 30 }, { checklist: [{ id: "a", title: "A z počítače", done: false }, { id: "b", title: "B", done: true }, { id: "c", title: "C", done: false }] });
  const merged = mergeEntity(base, local, server, 100);
  assert.deepEqual(merged.properties.checklist.map((item) => item.title), ["A z počítače", "B", "C"]);
  assert.deepEqual(entityConflicts(merged).map((conflict) => conflict.lostValue), [[{ id: "a", title: "A z telefonu", done: false }]]);
});

test("a side that did not change the record takes the other side as it is", () => {
  const base = task({}, { notes: "x" });
  const server = task({ title: "Nový", updatedAt: 30 }, { notes: "y" });
  assert.equal(mergeEntity(base, task({}, { notes: "x" }), server, 100), server);
  const local = task({ title: "Místní", updatedAt: 20 });
  assert.equal(mergeEntity(base, local, task({}, { notes: "x" }), 100), local);
});

test("all records together keep a bounded amount of notices, the oldest go first", () => {
  const notice = (id, at) => ({ id, field: "properties.notes", lostValue: "z".repeat(1_000), at });
  const entities = [
    task({ id: "t1" }, { syncConflicts: [notice("old", 1), notice("new", 3)] }),
    task({ id: "t2" }, { syncConflicts: [notice("middle", 2)] }),
  ];
  const limited = limitConflicts(entities, 2_200);
  assert.deepEqual(limited.flatMap((entity) => entityConflicts(entity).map((conflict) => conflict.id)), ["new", "middle"]);
  assert.equal(limitConflicts(entities, 10_000), entities);
});

test("a merged record keeps the change it carries when it is merged again", () => {
  // Device A's common version is S; the server then holds M, the merge of S with B's offline notes
  // (M keeps S's timestamp). A edits again before it has seen M: B's notes must survive.
  const S = task({ title: "renamed by A", updatedAt: 30 });
  const M = mergeEntity(task(), task({ updatedAt: 20 }, { notes: "from B offline" }), S, 100);
  assert.equal(M.updatedAt, 30);
  const again = mergeEntity(S, task({ title: "renamed by A", updatedAt: 50 }, { priority: "high" }), M, 200);
  assert.equal(again.properties.notes, "from B offline");
  assert.equal(again.properties.priority, "high");
  // The startup retry: the first merge M0 has the first server copy's timestamp; a later server
  // copy must not replace the offline edit it carries.
  const S0 = task({ updatedAt: 30 }, { notes: "server" });
  const M0 = mergeEntity(task({}, { notes: "server" }), task({ updatedAt: 20 }, { priority: "high", notes: "server" }), S0, 100);
  const S1 = task({ updatedAt: 40, title: "later" }, { notes: "server" });
  const retry = mergeEntity(S0, M0, S1, 200);
  assert.equal(retry.properties.priority, "high");
  assert.equal(retry.title, "later");
});

test("moves to two different lists keep one placement, the newer, and offer the other", () => {
  const base = task({}, { inbox: true });
  const local = task({ updatedAt: 20 }, { inbox: false, today: true, when: "2026-10-09" });
  const server = task({ updatedAt: 30 }, { inbox: false, someday: true, when: "" });
  const merged = mergeEntity(base, local, server, 100);
  assert.deepEqual(
    { inbox: merged.properties.inbox, today: merged.properties.today, someday: merged.properties.someday, when: merged.properties.when },
    { inbox: false, today: undefined, someday: true, when: "" },
  );
  const [conflict] = entityConflicts(merged);
  assert.equal(conflict.field, "properties.placement");
  assert.deepEqual(conflict.lostValue, { inbox: false, today: true, when: "2026-10-09" });
});

test("a placement changed on one side only is taken whole", () => {
  const merged = mergeEntity(task({}, { inbox: true }), task({ updatedAt: 20 }, { inbox: false, today: true, when: "2026-10-09" }), task({ updatedAt: 30 }, { inbox: true, priority: "high" }), 100);
  assert.equal(merged.properties.today, true);
  assert.equal(merged.properties.inbox, false);
  assert.equal(merged.properties.priority, "high");
  assert.deepEqual(entityConflicts(merged), []);
});

test("a checklist item removed on one device and changed on the other is removed, and the change can be restored", () => {
  const item = { id: "a", title: "A", done: false };
  const changed = { id: "a", title: "A upraveno", done: true };
  for (const [local, server] of [
    [task({ updatedAt: 20 }, { checklist: [] }), task({ updatedAt: 30 }, { checklist: [changed] })],
    [task({ updatedAt: 20 }, { checklist: [changed] }), task({ updatedAt: 30 }, { checklist: [] })],
  ]) {
    const merged = mergeEntity(task({}, { checklist: [item] }), local, server, 100);
    assert.deepEqual(merged.properties.checklist, []);
    const conflicts = entityConflicts(merged);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, "properties.checklist");
    assert.deepEqual(conflicts[0].lostValue, [changed]);
  }
});

test("two moves to the same place are not a conflict, however the fields are written", () => {
  const merged = mergeEntity(task({}, { inbox: true, today: false }),
    task({ updatedAt: 20 }, { today: true, when: "2026-10-09", inbox: false }),
    task({ updatedAt: 30 }, { today: true, when: "2026-10-09", inbox: false, someday: false }), 100);
  assert.deepEqual(entityConflicts(merged), []);
  assert.equal(merged.properties.today, true);
  assert.equal(merged.properties.when, "2026-10-09");
});

test("the evening mark merges with the placement it belongs to", () => {
  const base = task({}, { when: "2026-10-22", today: true });
  // Device A: this evening. Device B: next week. The newer placement wins whole, without a stray evening mark.
  const local = task({ updatedAt: 20 }, { when: "2026-10-22", today: true, evening: true });
  const server = task({ updatedAt: 30 }, { when: "2026-10-26", today: false, evening: false });
  const merged = mergeEntity(base, local, server, 100);
  assert.deepEqual({ when: merged.properties.when, today: merged.properties.today, evening: merged.properties.evening },
    { when: "2026-10-26", today: false, evening: false });
  const [conflict] = entityConflicts(merged);
  assert.equal(conflict.field, "properties.placement");
  assert.equal(conflict.lostValue.evening, true);
  // Evening changed on one side only is taken, with the rest of the placement.
  const only = mergeEntity(base, local, task({ updatedAt: 30 }, { when: "2026-10-22", today: true, priority: "high" }), 100);
  assert.equal(only.properties.evening, true);
  assert.deepEqual(entityConflicts(only), []);
});
