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

test("an owner edit is trimmed, drops empty goals, keeps at most five and mirrors goal", () => {
  const next = ctx.ownerProjectContext({ why: "  Proč  ", goals: [" a ", "", "b", "c", "d", "e", "f"], doneWhen: " Hotovo " }, 99);
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
  // A goal longer than the limit is cut in the context only; the full text stays in goal.
  const long = ctx.migrateProjectGoal(project({ goal: "g".repeat(500) }));
  assert.equal(long.properties.context.doneWhen.length, 300);
  assert.equal(long.properties.goal.length, 500);
  assert.ok(ctx.validProjectContext(long.properties.context));
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

test("the assistant gets the owner's context as a statement with provenance, only when there is one", () => {
  const withContext = project({ context: context({ why: "Brzdí nábor", goals: ["Spustit"], provenance: "lumi-approved" }) });
  const goalOnly = project({ goal: "Web běží" }, { id: "p2" });
  const bare = project({}, { id: "p3" });
  const prompt = providerContext("all", [withContext, goalOnly, bare]);
  const line = prompt.split("\n").find((entry) => entry.startsWith("Canonical entities:"));
  const entities = JSON.parse(line.slice("Canonical entities: ".length));
  assert.deepEqual(entities[0].ownerContext, { why: "Brzdí nábor", goals: ["Spustit"], doneWhen: "Hotovo", provenance: "owner-approved Lumi proposal" });
  assert.equal(entities[1].ownerContext.doneWhen, "Web běží");
  assert.equal(entities[1].ownerContext.provenance, "owner statement");
  assert.equal(entities[2].ownerContext, undefined);
});
