import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "lumi-project-context-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const ctx = await import("../lib/project-context.ts");
const { isSendable, forServer } = await import("../lib/sendable.ts");
const { mergeEntity } = await import("../lib/field-merge.ts");
const { summarizeProject } = await import("../lib/project-summary.ts");
const { providerContext } = await import("../lib/ai-provider-context.ts");
const { runSchemaMigrations, schemaMigrations } = await import("../lib/schema-migrations.ts");

const project = (properties = {}, overrides = {}) => ({ id: "p1", type: "project", title: "Web", status: "active", workspaceId: "personal", properties, createdAt: 1, updatedAt: 5, ...overrides });
const context = (overrides = {}) => ({ why: "Proč", goals: ["a"], doneWhen: "Hotovo", provenance: "owner", updatedAt: 10, ...overrides });

test("limits: why 600, five goals of 200, doneWhen 300; provenance and updatedAt are required", () => {
  assert.ok(ctx.validProjectContext(context()));
  assert.ok(ctx.validProjectContext(context({ why: "x".repeat(600), goals: Array(5).fill("y".repeat(200)), doneWhen: "z".repeat(300) })));
  assert.ok(!ctx.validProjectContext(context({ why: "x".repeat(601) })));
  assert.ok(!ctx.validProjectContext(context({ goals: Array(6).fill("a") })));
  assert.ok(!ctx.validProjectContext(context({ goals: ["y".repeat(201)] })));
  assert.ok(!ctx.validProjectContext(context({ goals: [1] })));
  assert.ok(!ctx.validProjectContext(context({ doneWhen: "z".repeat(301) })));
  assert.ok(!ctx.validProjectContext(context({ provenance: "lumi" })));
  assert.ok(!ctx.validProjectContext(context({ updatedAt: Number.NaN })));
  assert.ok(!ctx.validProjectContext(context({ proposalId: "" })));
  assert.ok(ctx.validProjectContext(context({ provenance: "lumi-approved", proposalId: "prop-1" })));
  assert.ok(!ctx.validProjectContext("text") && !ctx.validProjectContext(null) && !ctx.validProjectContext([]));
});

test("a stale editing base never overwrites another device's context without an explicit choice", () => {
  const initial = context({ why: "A started with this", doneWhen: "Old finish" });
  const editBase = ctx.readProjectContext({ context: initial });
  const myDraft = ctx.ownerProjectContext({ why: "A has typed new why", goals: ["a"], doneWhen: "Old finish" }, 30);
  const remote = context({ why: "B saved something else", doneWhen: "B new finish", updatedAt: 20 });
  const live = { context: remote, goal: remote.doneWhen };
  // A's field was focused when B synced. The guard runs at write time, in the current DB transaction.
  assert.equal(ctx.contextPatchIfUnchanged(live, editBase, myDraft), null);
  assert.deepEqual(ctx.readProjectContext(live), remote, "B must remain fully available after A's rejected blur");
  // An explicit resolution uses the current B version as its new base.
  assert.deepEqual(ctx.contextPatchIfUnchanged(live, remote, myDraft), ctx.contextPatch(myDraft));
  // Even if the text stayed the same but metadata/provenance advanced, that is still a new version.
  assert.equal(ctx.contextPatchIfUnchanged({ context: { ...initial, updatedAt: 21 } }, editBase, myDraft), null);
});

test("the client holds back a project with a context the server would refuse", () => {
  assert.equal(isSendable(project({ context: context() })), true);
  assert.equal(isSendable(project({})), true);
  assert.equal(isSendable(project({ context: context({ why: "x".repeat(601) }) })), false);
  const result = forServer([project({ context: context({ doneWhen: "x".repeat(301) }) })], [], null);
  assert.equal(result.reasons.get("p1"), "context");
  // Only projects carry a context.
  assert.equal(isSendable({ ...project({ context: "x".repeat(900) }), type: "task" }), true);
});

test("reading: an old project's goal is its doneWhen; a stored context wins; garbage does not throw", () => {
  assert.deepEqual(ctx.readProjectContext({ goal: "Spuštěno" }), { why: "", goals: [], doneWhen: "Spuštěno", provenance: "owner", updatedAt: 0 });
  assert.equal(ctx.readProjectContext({ goal: "Old", context: context({ doneWhen: "New" }) }).doneWhen, "New");
  assert.equal(ctx.readProjectContext({ context: { why: 5, goals: "x" } }).why, "");
  assert.deepEqual(ctx.readProjectContext(undefined).goals, []);
});

test("an owner edit is trimmed, drops empty goals and mirrors goal", () => {
  const next = ctx.ownerProjectContext({ why: "  Proč  ", goals: [" a ", "", "b", "c", "d", "e"], doneWhen: " Hotovo " }, 99);
  assert.deepEqual(next, { why: "Proč", goals: ["a", "b", "c", "d", "e"], doneWhen: "Hotovo", provenance: "owner", updatedAt: 99 });
  assert.equal(ctx.contextPatch(next).goal, "Hotovo");
  assert.ok(ctx.validProjectContext(next));
});

test("the first sentence of why", () => {
  assert.equal(ctx.firstSentence("Web neprodává. Brzdí nábor."), "Web neprodává.");
  assert.equal(ctx.firstSentence("Bez tečky"), "Bez tečky");
  assert.equal(ctx.firstSentence("  "), "");
  assert.equal(ctx.firstSentence("Verze 2.0 je venku. Další."), "Verze 2.0 je venku.");
  assert.ok(ctx.firstSentence("x".repeat(400)).length <= 160);
});

test("migration of one project keeps goal, copies it to doneWhen and leaves other records alone", () => {
  const migrated = ctx.migrateProjectGoal(project({ goal: "  Web běží  " }));
  assert.equal(migrated.properties.goal, "  Web běží  ");
  assert.deepEqual(migrated.properties.context, { why: "", goals: [], doneWhen: "Web běží", provenance: "owner", updatedAt: 5 });
  assert.equal(migrated.updatedAt, 5);
  assert.equal(ctx.migrateProjectGoal(project({ goal: "x", context: context() })), null);
  assert.equal(ctx.migrateProjectGoal(project({ goal: "   " })), null);
  assert.equal(ctx.migrateProjectGoal(project({})), null);
  assert.equal(ctx.migrateProjectGoal({ ...project({ goal: "x" }), type: "task" }), null);
  // A goal over the limit is never truncated: no context is made and the fallback read shows it in full.
  const long = project({ goal: "g".repeat(500) });
  assert.equal(ctx.migrateProjectGoal(long), null);
  assert.equal(ctx.readProjectContext(long.properties).doneWhen, "g".repeat(500));
});

test("the named migration moves goals in the database, bumps the revision once and runs once", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const put = (entity) => database.prepare("INSERT INTO entities VALUES (?, ?, ?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
  put(project({ goal: "Hotovo A" }, { id: "a", updatedAt: 7 }));
  put(project({ goal: "Hotovo B", context: context({ doneWhen: "Vlastní" }) }, { id: "b" }));
  put(project({}, { id: "c" }));
  put({ ...project({ goal: "úkol" }), id: "t", type: "task" });
  database.prepare("INSERT INTO metadata VALUES ('revision', '4')").run();
  const only = schemaMigrations.filter((migration) => migration.id === "2026-10-project-context-from-goal");
  assert.equal(only.length, 1);
  runSchemaMigrations(database, only);
  const read = (id) => JSON.parse(database.prepare("SELECT payload FROM entities WHERE id = ?").get(id).payload);
  assert.equal(read("a").properties.context.doneWhen, "Hotovo A");
  assert.equal(read("a").properties.goal, "Hotovo A");
  assert.equal(read("a").updatedAt, 7);
  assert.equal(database.prepare("SELECT updated_at AS value FROM entities WHERE id = 'a'").get().value, 7);
  assert.equal(read("b").properties.context.doneWhen, "Vlastní");
  assert.equal(read("c").properties.context, undefined);
  assert.equal(read("t").properties.context, undefined);
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, "5");
  runSchemaMigrations(database, only);
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get().value, "5");
});

test("the server refuses an over-long context and accepts a valid one", async () => {
  const store = await import("../lib/server-store.ts");
  const workspace = { id: "workspace:personal", type: "workspace", title: "Personal", status: "active", workspaceId: "personal", properties: { kind: "personal", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: 1, updatedAt: 1 };
  const withWorkspace = (properties) => ({ revision: 0, entities: [workspace, project(properties)], relations: [], tombstones: [], updatedAt: 1 });
  assert.doesNotThrow(() => store.validateSnapshot(withWorkspace({ context: context() })));
  assert.doesNotThrow(() => store.validateSnapshot(withWorkspace({ goal: "x".repeat(900) })));
  assert.throws(() => store.validateSnapshot(withWorkspace({ context: context({ why: "x".repeat(601) }) })), /invalid entity/);
  assert.throws(() => store.validateSnapshot(withWorkspace({ context: context({ goals: Array(6).fill("a") }) })), /invalid entity/);
  assert.throws(() => store.validateSnapshot(withWorkspace({ context: "text" })), /invalid entity/);
});

test("context merges as one object: the newer side wins whole and the replaced one is kept as a notice", () => {
  const base = project({ context: context() });
  const local = project({ context: context({ why: "Moje", updatedAt: 20 }) }, { updatedAt: 20 });
  const server = project({ context: context({ doneWhen: "Server", updatedAt: 30 }) }, { updatedAt: 30 });
  const merged = mergeEntity(base, local, server, 100);
  assert.equal(merged.properties.context.doneWhen, "Server");
  assert.equal(merged.properties.context.why, "Proč");
  const notice = merged.properties.syncConflicts.find((item) => item.field === "properties.context");
  assert.equal(notice.lostValue.why, "Moje");
  // One side only: taken without a notice.
  const onlyLocal = mergeEntity(base, local, base, 100);
  assert.equal(onlyLocal.properties.context.why, "Moje");
  assert.equal(onlyLocal.properties.syncConflicts, undefined);
});

test("summary: progress, next step, overdue and the single attention label", () => {
  const task = (id, properties = {}, status = "open", updatedAt = 3) => ({ id, type: "task", title: id, status, workspaceId: "personal", properties, createdAt: 1, updatedAt });
  const link = (id) => ({ id: `r-${id}`, sourceEntityId: id, targetEntityId: "p1", relationType: "belongs_to_project", workspaceId: "personal", createdAt: 1 });
  const items = [task("a"), task("b", { deadline: "2026-10-01" }), task("c", {}, "completed"), task("d", { inbox: true }), task("e", { when: "2099-01-01" }), task("x")];
  const relations = ["a", "b", "c", "d", "e"].map(link);
  const summary = summarizeProject(project({}), items, relations, "2026-10-23");
  assert.deepEqual([summary.total, summary.done, summary.open, summary.overdue], [5, 1, 4, 1]);
  assert.equal(summary.next.id, "a");
  assert.deepEqual(summary.attention, { kind: "overdue", count: 1 });
  const none = summarizeProject(project({}), [task("d", { inbox: true })], [link("d")], "2026-10-23");
  assert.deepEqual(none.attention, { kind: "noNext" });
  const empty = summarizeProject(project({}), [], [], "2026-10-23");
  assert.deepEqual([empty.total, empty.attention], [0, { kind: "noNext" }]);
  assert.equal(summarizeProject(project({}, { status: "completed" }), [], [], "2026-10-23").attention, null);
  // A relation from another workspace is not a member.
  const foreign = summarizeProject(project({}), items, [{ ...link("a"), workspaceId: "other" }], "2026-10-23");
  assert.equal(foreign.total, 0);
});

test("the 'all' scope sends no project context; the owner statement itself carries provenance", () => {
  const withContext = project({ context: context({ why: "Brzdí nábor", goals: ["Spustit"], provenance: "lumi-approved" }) });
  const goalOnly = project({ goal: "Web běží" }, { id: "p2" });
  const bare = project({}, { id: "p3" });
  const prompt = providerContext("all", [withContext, goalOnly, bare]);
  assert.ok(!prompt.includes("Brzdí nábor") && !prompt.includes("Web běží") && !prompt.includes("ownerContext\":"));
  assert.deepEqual(ctx.projectOwnerStatement(withContext), { why: "Brzdí nábor", goals: ["Spustit"], doneWhen: "Hotovo", provenance: "owner-approved Lumi proposal" });
  assert.equal(ctx.projectOwnerStatement(goalOnly).provenance, "owner statement");
  assert.equal(ctx.projectOwnerStatement(bare), null);
});

test("an older client editing only goal moves doneWhen with it; one notice at most", () => {
  const base = project({ goal: "Starý", context: context({ doneWhen: "Starý" }) });
  const oldClient = project({ goal: "Nový cíl", context: context({ doneWhen: "Starý" }) }, { updatedAt: 20 });
  const server = project({ goal: "Starý", context: context({ doneWhen: "Starý", why: "Jiné proč", updatedAt: 30 }) }, { updatedAt: 30 });
  const merged = mergeEntity(base, oldClient, server, 100);
  assert.equal(merged.properties.context.doneWhen, "Nový cíl");
  assert.equal(merged.properties.context.why, "Jiné proč");
  // Only goal changed on one side and the server is unchanged: still normalized (the early-return path).
  assert.equal(mergeEntity(base, oldClient, base, 100).properties.context.doneWhen, "Nový cíl");
  // Both sides changed goal: one notice at most, none for goal itself.
  const both = mergeEntity(base, project({ goal: "A", context: context({ doneWhen: "A", updatedAt: 20 }) }, { updatedAt: 20 }),
    project({ goal: "B", context: context({ doneWhen: "B", updatedAt: 30 }) }, { updatedAt: 30 }), 100);
  const fields = (both.properties.syncConflicts || []).map((item) => item.field);
  assert.ok(!fields.includes("properties.goal"));
  assert.equal(fields.filter((field) => field === "properties.context").length, 1);
  // doneWhen changed too: the context is not overwritten by the goal. A goal over 300 characters is not copied.
  const edited = mergeEntity(base, project({ goal: "G", context: context({ doneWhen: "D", updatedAt: 20 }) }, { updatedAt: 20 }), base, 100);
  assert.equal(edited.properties.context.doneWhen, "D");
  const long = mergeEntity(base, project({ goal: "g".repeat(400), context: context({ doneWhen: "Starý" }) }, { updatedAt: 20 }), base, 100);
  assert.equal(long.properties.context.doneWhen, "Starý");
  assert.equal(long.properties.goal.length, 400);
});

test("validator rejects unknown keys and an own __proto__; contextProblem refuses instead of cutting; null context migrates", () => {
  assert.ok(!ctx.validProjectContext({ ...context(), extra: 1 }));
  assert.ok(!ctx.validProjectContext(JSON.parse(`{"why":"","goals":[],"doneWhen":"","provenance":"owner","updatedAt":1,"__proto__":{"x":1}}`)));
  assert.deepEqual(ctx.contextProblem({ why: "", goals: Array(6).fill("a"), doneWhen: "" }), { field: "goals", limit: 5 });
  assert.deepEqual(ctx.contextProblem({ why: "", goals: ["x".repeat(201)], doneWhen: "" }), { field: "goal", limit: 200 });
  assert.equal(ctx.contextProblem({ why: "ok", goals: ["a", " "], doneWhen: "ok" }), null);
  assert.equal(ctx.ownerProjectContext({ why: "", goals: Array(6).fill("a"), doneWhen: "" }, 1).goals.length, 6);
  const fromNull = ctx.migrateProjectGoal(project({ goal: "Cíl", context: null }));
  assert.equal(fromNull.properties.context.doneWhen, "Cíl");
  assert.equal("context" in ctx.migrateProjectGoal(project({ context: null })).properties, false);
  assert.equal("context" in ctx.migrateProjectGoal(project({ goal: "g".repeat(500), context: null })).properties, false);
});

test("the editor's own earlier save is the same stored context, a change from elsewhere is not", async () => {
  const { sameStoredContext, ownerProjectContext } = await import("../lib/project-context.ts");
  const mine = ownerProjectContext({ why: "A", goals: ["x"], doneWhen: "D" }, 1000);
  assert.equal(sameStoredContext(mine, { ...mine, goals: [...mine.goals] }), true);
  assert.equal(sameStoredContext(mine, { ...mine, why: "B" }), false);
  assert.equal(sameStoredContext(mine, { ...mine, updatedAt: 2000 }), false, "the same text saved again elsewhere is another revision");
});


test("a project draft survives navigation, restores against a changed base, and clears on resolution", async () => {
  const drafts = await import("../lib/project-context-drafts.ts");
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const base = context({ why: "A old" });
  const A = { why: "A draft", goals: ["a"], doneWhen: "Hotovo" };
  const B = context({ why: "B remote", updatedAt: 22 });
  assert.equal(drafts.keepProjectContextDraft(storage, {
    page: "tab-a", workspaceId: "personal", projectId: "project-a", base, draft: A, at: 10,
  }), true);
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-a", "personal", "project-a").draft.why, "A draft");
  assert.equal(ctx.sameStoredContext(base, B), false);
  assert.equal(ctx.contextPatchIfUnchanged({ context: B }, base, ctx.ownerProjectContext(A, 50)), null);
  // A new browser document uses the same tab key (a different tab is free to edit independently).
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-b", "personal", "project-a").draft.why, "A draft");
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-b", "other-workspace", "project-a"), null);
  const saved = ctx.ownerProjectContext(A, 60);
  drafts.settleProjectContextDraft(storage, "tab-a", "personal", "project-a", A, saved);
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-a", "personal", "project-a"), null);
});

test("project draft storage is tab-scoped, preserves newer typing and is wiped on sign-out/restore", async () => {
  const drafts = await import("../lib/project-context-drafts.ts");
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  const base = context();
  const save = (page, why, at = 1) => drafts.keepProjectContextDraft(storage, {
    page, workspaceId: "personal", projectId: "p1", base, draft: { why, goals: [], doneWhen: "" }, at,
  });
  save("tab-a", "A"); save("tab-b", "B", 2);
  assert.equal(drafts.keptProjectContextDrafts(storage).length, 2);
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-a", "personal", "p1").draft.why, "A");
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-b", "personal", "p1").draft.why, "B");
  drafts.settleProjectContextDraft(storage, "tab-a", "personal", "p1", { why: "stale", goals: [], doneWhen: "" }, context({ why: "saved" }));
  assert.equal(drafts.recoverProjectContextDraft(storage, "tab-a", "personal", "p1").draft.why, "A");
  assert.equal(drafts.keptProjectContextDrafts(storage).length, 2);
  values.set("ai-executive-signed-out", "1");
  assert.equal(save("tab-c", "no"), false, "no new draft can be added once signed out");
  drafts.clearProjectContextDrafts(storage);
  assert.equal(drafts.keptProjectContextDrafts(storage).length, 0);
});


test("legacy goal conflict retains the actual losing goal when both clients also changed context", () => {
  const base = project({ goal: "Old", context: context({ why: "Original", doneWhen: "Old" }) }, { updatedAt: 10 });
  const oldClient = project({ goal: "A", context: context({ why: "Old client why", doneWhen: "Old", updatedAt: 21 }) }, { updatedAt: 20 });
  const modernClient = project({ goal: "B", context: context({ why: "New client why", doneWhen: "B", updatedAt: 31 }) }, { updatedAt: 30 });

  for (const [local, server, expected, losingGoal, losingWhy] of [
    [oldClient, modernClient, "B", "A", "Old client why"],
    [modernClient, oldClient, "B", "A", "Old client why"],
    [{ ...oldClient, updatedAt: 40 }, modernClient, "A", "B", "New client why"],
    [modernClient, { ...oldClient, updatedAt: 40 }, "A", "B", "New client why"],
  ]) {
    const merged = mergeEntity(base, local, server, 100);
    assert.equal(merged.properties.goal, expected);
    assert.equal(merged.properties.context.doneWhen, expected);
    const conflicts = (merged.properties.syncConflicts || []).filter((c) => c.field === "properties.context");
    assert.equal(conflicts.length, 1, "one context notice covers both the text and other context edits");
    assert.equal(conflicts[0].lostValue.doneWhen, losingGoal, "lost old-client goal must not revert to the obsolete context text");
    assert.equal(conflicts[0].lostValue.why, losingWhy, "the losing side's unrelated context edit must remain restorable");
  }
});

test("a stale context received by a legacy client does not disguise its own newer goal edit", () => {
  const base = project({ goal: "Old", context: context({ doneWhen: "Old" }) }, { updatedAt: 10 });
  const received = context({ doneWhen: "B", updatedAt: 20 });
  const oldClient = project({ goal: "A", context: received }, { updatedAt: 30 });
  const modernClient = project({ goal: "B", context: received }, { updatedAt: 20 });
  const merged = mergeEntity(base, oldClient, modernClient, 100);
  assert.equal(merged.properties.goal, "A");
  assert.equal(merged.properties.context.doneWhen, "A");
  const conflict = (merged.properties.syncConflicts || []).find((c) => c.field === "properties.context");
  assert.equal(conflict?.lostValue.doneWhen, "B");
});

test("an over-limit losing old goal remains readable when both contexts changed", () => {
  const long = "long legacy ".repeat(35);
  const base = project({ goal: "Old", context: context({ doneWhen: "Old", why: "before" }) }, { updatedAt: 10 });
  const legacy = project({ goal: long, context: context({ doneWhen: "Old", why: "old edit" }) }, { updatedAt: 20 });
  const modern = project({ goal: "B", context: context({ doneWhen: "B", why: "new edit", updatedAt: 30 }) }, { updatedAt: 30 });
  const merged = mergeEntity(base, legacy, modern, 100);
  assert.equal(merged.properties.goal, "B");
  assert.equal(merged.properties.context.doneWhen, "B");
  const notices = merged.properties.syncConflicts || [];
  assert.equal(notices.filter((c) => c.field === "properties.context").length, 1);
  const goalNotice = notices.find((c) => c.field === "properties.goal");
  assert.ok(goalNotice, "over-limit goal must survive despite the generic context conflict");
  assert.equal(goalNotice.lostValue, long);
});

// Owner review 2026-10-24: an older client edits `goal` while a current one edits `context.doneWhen`.
{
  const { readProjectContext: read } = await import("../lib/project-context.ts");
  const project = (properties, updatedAt) => ({ id: "p", type: "project", title: "P", status: "active", workspaceId: "w", properties, createdAt: 1, updatedAt });
  const ctx = (doneWhen) => ({ why: "W", goals: ["g"], doneWhen, provenance: "owner", updatedAt: 5 });
  const base = project({ goal: "Old", context: ctx("Old") }, 10);
  const oldClient = (at) => project({ goal: "A", context: ctx("Old") }, at);           // previous version: goal only
  const newClient = (at) => project({ goal: "B", context: { ...ctx("B"), updatedAt: 20 } }, at); // mirrors goal
  const notices = (entity) => (entity.properties.syncConflicts || []);

  for (const [name, local, server, expected, lostText] of [
    ["old local newer", oldClient(30), newClient(20), "A", "B"],
    ["old local older", oldClient(20), newClient(30), "B", "A"],
    ["new local newer", newClient(30), oldClient(20), "B", "A"],
    ["new local older", newClient(20), oldClient(30), "A", "B"],
  ]) {
    test(`goal vs doneWhen from an old and a new client is one text with a notice for the other (${name})`, () => {
      const merged = mergeEntity(base, local, server, 100);
      assert.equal(merged.properties.context.doneWhen, expected);
      assert.equal(merged.properties.goal, expected, "goal keeps mirroring doneWhen");
      assert.equal(read(merged.properties).doneWhen, expected);
      const notice = notices(merged).find((item) => item.field === "properties.context");
      assert.ok(notice, "the other text is kept as a restorable notice");
      assert.equal(notice.lostValue.doneWhen, lostText);
      assert.equal(notice.lostValue.why, "W", "the notice restores the whole context with the other text");
    });
  }

  test("only an old client changed goal: it becomes doneWhen with no notice", () => {
    const merged = mergeEntity(base, oldClient(30), project({ goal: "Old", context: ctx("Old"), other: 1 }, 25), 100);
    assert.equal(merged.properties.context.doneWhen, "A");
    assert.equal(merged.properties.goal, "A");
    assert.equal(notices(merged).length, 0);
  });

  test("both sides wrote the same text: no notice", () => {
    const merged = mergeEntity(base, project({ goal: "B", context: ctx("Old") }, 30), newClient(20), 100);
    assert.equal(merged.properties.context.doneWhen, "B");
    assert.equal(notices(merged).filter((item) => item.field === "properties.context" || item.field === "properties.goal").length, 0);
  });

  test("an old client's goal over the limit with an existing context is shown in full, not hidden", () => {
    const long = "x".repeat(400);
    const merged = mergeEntity(base, project({ goal: long, context: ctx("Old") }, 30), project({ goal: "Old", context: ctx("Old"), other: 1 }, 25), 100);
    assert.equal(merged.properties.goal, long);
    assert.equal(merged.properties.context.doneWhen, "Old", "context stays valid");
    assert.equal(read(merged.properties).doneWhen, long, "read as 'Hotovo, když' so the editor asks to shorten it");
  });

  test("a long old-client goal that loses to a newer doneWhen is kept as a goal notice", () => {
    const long = "y".repeat(400);
    const merged = mergeEntity(base, project({ goal: long, context: ctx("Old") }, 20), newClient(30), 100);
    assert.equal(merged.properties.context.doneWhen, "B");
    assert.equal(merged.properties.goal, "B");
    const notice = notices(merged).find((item) => item.field === "properties.goal");
    assert.ok(notice);
    assert.equal(notice.truncated ? true : notice.lostValue === long, true);
  });
}
