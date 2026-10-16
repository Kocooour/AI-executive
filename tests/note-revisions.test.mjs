import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-note-rev-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_SESSION_SECRET = "s".repeat(40);
process.env.AI_EXECUTIVE_INTEGRATION_TOKEN = "i".repeat(40);
process.env.AI_EXECUTIVE_PASSWORD_HASH = `scrypt:${Buffer.alloc(16, 1).toString("base64url")}:${Buffer.alloc(64, 2).toString("base64url")}`;
after(() => rmSync(dataDir, { recursive: true, force: true }));

// A note exists before the revision table does: the migration must give it a baseline.
{
  const legacy = new DatabaseSync(path.join(dataDir, "store.sqlite"));
  legacy.exec("CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const old = { id: "note:old", type: "note", title: "Old note", content: "old text", status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 5 };
  legacy.prepare("INSERT INTO entities VALUES (?, ?, ?)").run(old.id, JSON.stringify(old), 5);
  legacy.close();
}

const store = await import("../lib/server-store.ts");
const revisions = await import("../lib/note-revisions.ts");
const migrations = await import("../lib/schema-migrations.ts");
const auth = await import("../lib/auth.ts");

const db = () => store.getDatabase();
const note = (id, title, content, extra = {}) => ({ id, type: "note", title, content, status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1, ...extra });
const task = (id) => ({ id, type: "task", title: id, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 });
const others = () => store.readSnapshot().entities.filter((entity) => entity.id !== "workspace:personal" && !entity.id.startsWith("note:"));
const save = (notes, deletedIds = [], keep = true) => {
  const current = store.readSnapshot();
  const kept = keep ? current.entities.filter((entity) => entity.type !== "note" && entity.id !== "workspace:personal") : [];
  return store.replaceSnapshot(current.revision, [...current.entities.filter((entity) => entity.id === "workspace:personal"), ...kept, ...notes], [], deletedIds);
};
const rows = (id) => db().prepare("SELECT revision, origin, title, content FROM note_revisions WHERE note_id = ? ORDER BY revision").all(id);
const current = (id) => store.readSnapshot().entities.find((entity) => entity.id === id);

test("the migration gives every existing note a baseline revision, once", () => {
  assert.deepEqual(rows("note:old").map((row) => [row.revision, row.origin, row.content]), [[1, "baseline", "old text"]]);
  const applied = migrations.runSchemaMigrations(db());
  assert.deepEqual(applied, []);
  revisions.baselineNoteRevisions(db());
  assert.equal(rows("note:old").length, 1);
});

test("a new note gets revision 1, a text or title change the next, anything else nothing", () => {
  assert.equal(save([current("note:old"), note("note:a", "A", "one")]).conflict, false);
  assert.deepEqual(rows("note:a").map((row) => [row.revision, row.origin]), [[1, "created"]]);
  save([current("note:old"), note("note:a", "A", "two")]);
  save([current("note:old"), note("note:a", "A2", "two")]);
  assert.deepEqual(rows("note:a").map((row) => [row.revision, row.origin, row.title, row.content]), [
    [1, "created", "A", "one"], [2, "edited", "A", "two"], [3, "edited", "A2", "two"]]);
  // Properties, status, updatedAt and identical text: nothing.
  save([current("note:old"), note("note:a", "A2", "two", { properties: { projectId: "p" }, status: "archived", updatedAt: 99 })]);
  save([current("note:old"), note("note:a", "A2", "two", { updatedAt: 100 })]);
  assert.equal(rows("note:a").length, 3);
  assert.equal(rows("note:old").length, 1);
});

test("a note without content is an empty text", () => {
  save([current("note:old"), current("note:a"), { ...note("note:empty", "Empty"), content: undefined }]);
  assert.equal(rows("note:empty")[0].content, "");
});

test("a conflict or refused write records nothing", () => {
  const before = rows("note:a").length;
  const snapshot = store.readSnapshot();
  const result = store.replaceSnapshot(snapshot.revision - 1, [...snapshot.entities.filter((e) => e.id !== "note:a"), note("note:a", "A2", "stale")], []);
  assert.equal(result.conflict, true);
  assert.equal(rows("note:a").length, before);
  assert.equal(current("note:a").content, "two");
  // A failure part-way (an entity that cannot be stored) leaves no revision either.
  const circular = { ...note("note:a", "A2", "boom") }; circular.properties.self = circular;
  assert.throws(() => store.replaceSnapshot(store.readSnapshot().revision, [...store.readSnapshot().entities.filter((e) => e.id !== "note:a"), circular], []));
  assert.equal(rows("note:a").length, before);
});

test("deleting a note, or a note that stops being a note, deletes its revisions", () => {
  save([current("note:old"), current("note:a"), current("note:empty"), note("note:b", "B", "b"), note("note:c", "C", "c")]);
  assert.equal(rows("note:b").length, 1);
  assert.equal(save([current("note:old"), current("note:a"), current("note:empty"), note("note:c", "C", "c")], ["note:b"]).conflict, false);
  assert.equal(rows("note:b").length, 0);
  save([current("note:old"), current("note:a"), current("note:empty"), task("note:c")]);
  assert.equal(rows("note:c").length, 0);
  assert.ok(rows("note:a").length > 0);
});

test("restoring a backup records backup_restore and purges notes absent from it", () => {
  save([current("note:old"), current("note:a"), current("note:empty")]);
  const backup = store.createBackup("c1d");
  save([current("note:old"), note("note:a", "A2", "changed after the backup"), note("note:later", "Later", "x")]);
  assert.ok(rows("note:later").length === 1);
  store.restoreBackup(backup.name);
  assert.equal(rows("note:later").length, 0);
  const last = rows("note:a").at(-1);
  assert.equal(last.origin, "backup_restore");
  assert.equal(last.content, "two");
  assert.equal(rows("note:old").length, 1, "a note whose text did not change gets nothing");
});

test("at most 20 revisions are kept; the oldest go and numbers are never reused", () => {
  save([note("note:cap", "Cap", "v0")]);
  for (let index = 1; index <= 24; index += 1) save([current("note:cap") && { ...current("note:cap"), content: `v${index}` }], [], false);
  const kept = rows("note:cap");
  assert.equal(kept.length, 20);
  assert.deepEqual([kept[0].revision, kept.at(-1).revision], [6, 25]);
  assert.equal(kept.at(-1).content, "v24");
  save([{ ...current("note:cap"), content: "v25" }], [], false);
  assert.deepEqual([rows("note:cap")[0].revision, rows("note:cap").at(-1).revision], [7, 26]);
});

test("listing marks identical text with the newest earlier revision that has it", () => {
  save([note("note:same", "S", "first")], [], false);
  save([{ ...current("note:same"), content: "second" }], [], false);
  save([{ ...current("note:same"), content: "first" }], [], false);
  save([{ ...current("note:same"), content: "second" }], [], false);
  const list = revisions.listNoteRevisions(db(), "note:same");
  assert.deepEqual(list.map((item) => [item.revision, item.sameAsRevision]), [[4, 2], [3, 1], [2, null], [1, null]]);
  assert.equal(list[0].contentLength, 6);
  assert.equal("content" in list[0], false);
  // A title-only edit records a revision and reads as the same text as the one before it.
  save([{ ...current("note:same"), title: "S renamed" }], [], false);
  assert.deepEqual(revisions.listNoteRevisions(db(), "note:same").slice(0, 1).map((item) => [item.revision, item.sameAsRevision]), [[5, 4]]);
  const detail = revisions.getNoteRevision(db(), "note:same", 3);
  assert.equal(detail.content, "first");
  assert.equal(revisions.getNoteRevision(db(), "note:same", 99), null);
  assert.equal(revisions.listNoteRevisions(db(), "note:missing"), null);
  assert.equal(revisions.listNoteRevisions(db(), "task-id"), null);
});

test("the route accepts only the owner session: no cookie and the integration token are refused", () => {
  const url = "http://localhost/api/notes/revisions?noteId=note:a";
  assert.equal(auth.isAuthenticated(new Request(url)), false);
  const bearer = new Request(url, { headers: { authorization: `Bearer ${process.env.AI_EXECUTIVE_INTEGRATION_TOKEN}` } });
  assert.equal(auth.isIntegrationAuthenticated(bearer), true, "the token is valid for the integration API");
  assert.equal(auth.isAuthenticated(bearer), false, "but it is not an owner session");
  const owner = new Request(url, { headers: { cookie: `${auth.sessionCookieName}=${auth.createSessionToken()}` } });
  assert.equal(auth.isAuthenticated(owner), true);
  const source = readFileSync("app/api/notes/revisions/route.ts", "utf8");
  assert.match(source, /isAuthenticated\(request\)/);
  assert.match(source, /status: 401/);
  assert.match(source, /no-store/);
  assert.doesNotMatch(source, /isIntegrationAuthenticated/);
});

test("the revisions answer: list without content, one revision with it, 404 and 400", () => {
  save([note("note:a", "A", "one")], [], false);
  save([{ ...current("note:a"), content: "two" }], [], false);
  const ask = (noteId, revision = null) => revisions.answerRevisionQuery(db(), noteId, revision);
  const list = ask("note:a");
  assert.equal(list.status, 200);
  assert.ok(list.body.revisions.length >= 1 && list.body.revisions.every((item) => !("content" in item)));
  assert.equal(ask("note:a", "1").body.revision.content, "one");
  assert.equal(ask("note:missing").status, 404);
  assert.equal(ask("note:a", "9999").status, 404);
  assert.equal(ask("note:a", "zero").status, 400);
  assert.equal(ask("note:a", "0").status, 400);
  for (const bad of ["0x1", "1.0", "+1", " 1", "01", "1e0", "99999999999"]) assert.equal(ask("note:a", bad).status, 400, bad);
  assert.equal(ask("").status, 400);
  save([], ["note:a"], false);
  assert.equal(ask("note:a").status, 404, "a deleted note");
});

test("nothing from revisions reaches agents, PACT tools, the AI provider, attention, the day plan or the client snapshot", async () => {
  const pact = await import("../lib/pact.ts");
  const pactTools = await import("../lib/pact-tools.ts");
  const aiContext = await import("../lib/ai-provider-context.ts");
  const plan = await import("../lib/day-plan.ts");
  const attention = await import("../lib/attention-service.ts");
  save([note("note:secret", "Secret title", "FIRST-SECRET-TEXT")], [], false);
  save([{ ...current("note:secret"), content: "LATEST-VISIBLE-TEXT" }], [], false);
  // The earlier text lives only in the revisions.
  assert.equal(JSON.stringify(store.readSnapshot()).includes("FIRST-SECRET-TEXT"), false);
  const outputs = [
    JSON.stringify(pact.resolvePACTContext({ workspaceId: "personal", includeSensitive: true })),
    ...["task.read", "project.read", "note.read", "context.read"].map((tool) => JSON.stringify(pactTools.executePACTReadTool(tool, "personal", {}))),
    aiContext.providerContext("personal", []),
    JSON.stringify(plan.buildDayPlan("personal", plan.currentDayPlanDate(Date.now()))),
    JSON.stringify(attention.evaluateWorkspace(store.readSnapshot(), "personal", "Europe/Prague", Date.now())),
    JSON.stringify(db().prepare("SELECT details FROM security_events").all()),
  ];
  for (const output of outputs) assert.equal(output.includes("FIRST-SECRET-TEXT"), false);
  const files = (dir) => readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); return statSync(file).isDirectory() ? files(file) : [file]; });
  for (const file of [...files("app/api/integrations"), "lib/pact.ts", "lib/pact-tools.ts", "lib/pact-agent-runs.ts", "lib/day-plan.ts", "lib/attention-service.ts", "lib/ai-actions.ts", "lib/ai-provider-context.ts"]) {
    assert.equal(/note_revisions|note-revisions/.test(readFileSync(file, "utf8")), false, file);
  }
});

test("notes imported from a legacy store.json get a baseline revision", async () => {
  const { mkdtempSync: make, writeFileSync } = await import("node:fs");
  const dir = make(path.join(os.tmpdir(), "lumi-note-legacy-"));
  writeFileSync(path.join(dir, "store.json"), JSON.stringify({ revision: 3, updatedAt: 1, entities: [note("note:legacy", "Legacy", "from json")], relations: [] }));
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings", "--input-type=module", "-e",
    `const store = await import("./lib/server-store.ts"); console.log(JSON.stringify(store.getDatabase().prepare("SELECT revision, origin, content FROM note_revisions WHERE note_id = 'note:legacy'").all()));`],
    { env: { ...process.env, AI_EXECUTIVE_DATA_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), [{ revision: 1, origin: "baseline", content: "from json" }]);
});
