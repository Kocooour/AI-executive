import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { auditAreaPartition } from "../lib/area-partition-audit.ts";

const workspace = (id, kind) => ({
  id: "workspace:" + id, workspaceId: id, type: "workspace", title: id,
  status: "active", properties: { kind, role: "owner", members: [{ id: "owner", role: "owner" }] },
  createdAt: 1, updatedAt: 1,
});
const entity = (id, type, props = {}) => ({
  id, type, workspaceId: "legacy-shared", title: "SENSITIVE-" + id,
  status: type === "task" ? "open" : "active",
  properties: props, createdAt: 1, updatedAt: 1,
});
const link = (id, source, target, type) => ({
  id, sourceEntityId: source, targetEntityId: target,
  workspaceId: "legacy-shared", relationType: type, createdAt: 1,
});
const input = () => ({
  entities: [workspace("personal", "personal"), workspace("legacy-shared", "shared"),
    entity("a-one", "area", { kind: "shared" }),
    entity("a-two", "area", { kind: "shared" }),
    entity("p-one", "project"), entity("t-in", "task"),
    entity("t-standalone", "task"), entity("n-project", "note"),
    entity("n-standalone", "note")],
  relations: [
    link("r-p", "p-one", "a-one", "belongs_to_area"),
    link("r-t", "t-in", "p-one", "belongs_to_project"),
    link("r-st", "t-standalone", "a-two", "belongs_to_area"),
    link("r-np", "n-project", "p-one", "belongs_to_project"),
    link("r-ns", "n-standalone", "a-two", "belongs_to_area"),
  ],
});
const identity = { revision: 17, restoreGeneration: 3, tombstones: [] };
const audit = (s, t = []) => auditAreaPartition(s, identity, 1, t);
const issue = (report, code) => report.findings.find(f => f.code === code)?.count ?? 0;

test("2b audit: normalized legacy shared workspaces are counted without exposing titles or IDs", () => {
  const s = input(), result = audit(s);
  assert.equal(result.status, "audit-only");
  assert.equal(result.executable, false);
  assert.equal(result.sharingEnabled, false);
  assert.deepEqual(result.summary, {
    sharedWorkspaces: 1, sharedAreas: 2, sharedProjects: 1, sharedTasks: 2,
    sharedNotes: 2, crossAreaRelations: 0, unknownScopeEntities: 0,
  });
  assert.deepEqual(result.findings, []);
  assert.ok(result.outstandingGates.includes("restore-generation-partition-barrier-not-implemented"));
  assert.ok(result.outstandingGates.includes("offline-device-queue-export-and-reconciliation-not-implemented"));
  assert.equal(result.sourceSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE-|legacy-shared|p-one|a-one|t-in/);
});

test("2b audit: cross-area linked tasks/notes block partition instead of deleting edges", () => {
  const s = input();
  s.relations.push(link("cross", "t-in", "n-standalone", "related"));
  const r = audit(s);
  assert.equal(issue(r, "cross-area-relation"), 1);
  assert.equal(r.summary.crossAreaRelations, 1);
  assert.equal(r.executable, false);
  assert.equal(s.relations.length, 6, "audit does not mutate source");
});

test("2b audit: unassigned standalone note and dangling relation are flagged", () => {
  const s = input();
  s.relations = s.relations.filter(x => x.id !== "r-ns");
  s.relations.push(link("bad", "n-project", "missing-id", "related"));
  const r = audit(s);
  assert.equal(issue(r, "unassigned-standalone-note"), 1);
  assert.ok(issue(r, "unroutable-shared-relation") > 0);
  assert.ok(issue(r, "2a-preflight-blocked") > 0);
});

test("2b audit: pending 2a and occupied ancillary tables remain explicit blockers", () => {
  const s = input();
  s.relations = s.relations.filter(x => x.id !== "r-p");
  const result = audit(s, [
    { table: "work_sessions", rows: 2 }, { table: "entities", rows: 9 },
    { table: "attention_states", rows: 1 },
  ]);
  assert.equal(issue(result, "2a-not-normalized"), 1);
  assert.equal(issue(result, "project-without-unique-area"), 1);
  assert.equal(issue(result, "unroutable-project-member"), 2);
  assert.equal(issue(result, "unmapped-side-table-rows"), 3);
  assert.deepEqual(result.tableInventory.map(x => x.table), ["attention_states", "entities", "work_sessions"]);
});

test("2b audit: input order does not affect source fingerprint or decisions", () => {
  const s = input();
  const r1 = audit(s);
  const r2 = audit({ entities: [...s.entities].reverse(), relations: [...s.relations].reverse() });
  assert.deepEqual(r1, r2);
});

test("2b offline CLI reads a copied database and leaves the source file untouched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumi-d2b-audit-"));
  const filename = path.join(dir, "store.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(`
      CREATE TABLE entities (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE relations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE tombstones (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE custom_workspace_extension (workspace_id TEXT);
      INSERT INTO metadata VALUES ('revision', '17'), ('restoreGeneration', '3');
      INSERT INTO custom_workspace_extension VALUES ('legacy-shared');
    `);
    const s = input();
    const ein = db.prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)");
    const rin = db.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)");
    for (const e of s.entities) ein.run(e.id, JSON.stringify(e), e.updatedAt);
    for (const r of s.relations) rin.run(r.id, JSON.stringify(r), r.createdAt);
    db.close();
    const before = createHash("sha256").update(readFileSync(filename)).digest("hex");
    const command = spawnSync(process.execPath, [
      "--experimental-loader", "./tests/ts-loader.mjs",
      "scripts/audit-area-partition.mjs", "--offline-copy", filename,
    ], { encoding: "utf8", cwd: process.cwd(), timeout: 25000 });
    assert.equal(command.status, 0, command.stderr);
    const out = JSON.parse(command.stdout);
    assert.equal(out.status, "audit-only");
    assert.equal(out.executable, false);
    assert.equal(issue(out, "unclassified-schema-table"), 1);
    assert.equal(issue(out, "unmapped-side-table-rows"), 1);
    const after = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(after, before, "offline audit must never change store.sqlite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
