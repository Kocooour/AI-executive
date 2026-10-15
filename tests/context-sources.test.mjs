import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-sources-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const sources = await import("../lib/context-sources.ts");
const evidence = await import("../lib/context-evidence.ts");
const history = await import("../lib/context-history.ts");
const inbox = await import("../lib/context-inbox.ts");
const migrations = await import("../lib/schema-migrations.ts");
const store = await import("../lib/server-store.ts");

const db = () => store.getDatabase();
const count = (sql, ...args) => Number(db().prepare(sql).get(...args).count);

function newWorkspace() {
  const id = `ws${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const workspace = { id: `workspace:${id}`, type: "workspace", title: id, status: "active", workspaceId: id,
    properties: { kind: "personal", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now };
  db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)").run(workspace.id, JSON.stringify(workspace), now);
  return id;
}
const makeClaim = (ws, overrides = {}) => claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  subject: { entityId: `workspace:${ws}` }, predicate: "preference", literal: { type: "string", value: "Quiet mornings" },
  freshness: "current", sensitivity: "normal", ...overrides }).claim;
const getClaim = (ws, id) => claims.listOwnerClaims(ws, { includeArchived: true }).find((claim) => claim.id === id);
const review = (ws, claim, decision) => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id,
  expectedRevision: claim.revision, decision }).claim;
const makeSource = (ws, overrides = {}) => sources.createContextSource({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  provider: "email", coverage: "excerpt", sensitivity: "normal", ...overrides });
const editSource = (ws, source, overrides = {}) => sources.updateContextSource({ commandId: randomUUID(), workspaceId: ws, id: source.id, expectedRevision: source.revision,
  provider: source.provider, account: source.account, externalId: source.externalId, locator: source.locator, author: source.author, authorRole: source.authorRole,
  sourceAt: source.sourceAt, ingestedAt: source.ingestedAt, coverage: source.coverage, sensitivity: source.sensitivity, ...overrides });
const archiveSource = (ws, source) => sources.archiveContextSource({ commandId: randomUUID(), workspaceId: ws, id: source.id, expectedRevision: source.revision });
const addEvidence = (ws, claim, source, overrides = {}) => evidence.addClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  claimId: claim.id, expectedClaimRevision: claim.revision, sourceId: source.id, stance: "supports", ...overrides });
const editEvidence = (ws, item, overrides = {}) => evidence.updateClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: item.id, expectedRevision: item.revision,
  sourceId: item.sourceId, locator: item.locator, excerpt: item.excerpt, stance: item.stance, ...overrides });
const archiveEvidence = (ws, item) => evidence.archiveClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: item.id, expectedRevision: item.revision });
const events = (ws) => db().prepare("SELECT * FROM context_change_events WHERE workspace_id = ? ORDER BY sequence").all(ws);

function step(ws, action, overrides = {}) {
  const state = history.getContextHistory(ws);
  const expectedEventId = (action === "undo" ? state.undo : state.redo)?.eventId;
  return history.runHistoryCommand({ action, commandId: randomUUID(), workspaceId: ws, expectedEventId, ...overrides });
}
const undo = (ws, overrides) => step(ws, "undo", overrides);
const redo = (ws, overrides) => step(ws, "redo", overrides);

// --- the migration ------------------------------------------------------------------------------

function legacyDatabase() {
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE context_claims (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_id TEXT NOT NULL, predicate TEXT NOT NULL,
    literal_type TEXT, literal_value TEXT, target_subject_id TEXT, review_status TEXT NOT NULL, freshness TEXT NOT NULL, sensitivity TEXT NOT NULL,
    provenance TEXT NOT NULL, valid_from TEXT, valid_to TEXT, source_metadata TEXT, evidence_metadata TEXT, revision INTEGER NOT NULL,
    archived_at INTEGER, recorded_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE context_change_events (id TEXT PRIMARY KEY, command_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor TEXT NOT NULL,
    object_id TEXT NOT NULL, operation TEXT NOT NULL, before_revision INTEGER, after_revision INTEGER, before_payload TEXT, after_payload TEXT,
    created_at INTEGER NOT NULL)`);
  const insert = old.prepare(`INSERT INTO context_claims VALUES (?, ?, 'workspace:x', 'preference', 'string', '"v"', NULL, 'confirmed', 'current', ?, 'owner',
    NULL, NULL, ?, ?, 3, NULL, 1000, 2000)`);
  const json = (value) => value === null ? null : JSON.stringify(value);
  insert.run("c-full", "personal", "normal", json({ provider: "email", externalId: "msg-1", locator: "https://example.test/m/1", author: "Alex",
    authorRole: "sender", sourceAt: "2026-05-01T10:00:00Z", ingestedAt: "2026-05-02T08:00:00Z", coverage: "excerpt" }), json({ excerpt: "Quoted line", stance: "supports", locator: "line 3" }));
  insert.run("c-source-only", "personal", "confidential", json({ provider: "owner" }), null);
  insert.run("c-shared-a", "personal", "sensitive", json({ provider: "email", externalId: "shared-1", coverage: "body" }), json({ excerpt: "A", stance: "supports" }));
  insert.run("c-shared-b", "personal", "normal", json({ provider: "email", externalId: "shared-1", coverage: "excerpt" }), json({ excerpt: "B" }));
  insert.run("c-none", "personal", "normal", null, null);
  insert.run("c-weird", "personal", "top-secret", json({ locator: "https://example.test/x" }), null);
  insert.run("c-other-ws", "other", "normal", json({ provider: "email", externalId: "shared-1" }), null);
  return old;
}
const migrationList = () => ["2026-10-context-change-events-undo-linkage", "2026-10-context-sources-and-evidence-records"]
  .map((id) => migrations.schemaMigrations.find((item) => item.id === id));
const rows = (database, table) => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));

test("the migration turns legacy JSON source/evidence into records, invents nothing and is idempotent", () => {
  const old = legacyDatabase();
  const claimsBefore = rows(old, "context_claims");
  assert.deepEqual(migrations.runSchemaMigrations(old, migrationList()).length, 2);
  assert.deepEqual(rows(old, "context_claims"), claimsBefore, "the JSON columns and every claim field are untouched");

  const source = (id) => old.prepare("SELECT * FROM context_sources WHERE id = ?").get(id);
  const evidenceOf = (claimId) => old.prepare("SELECT * FROM context_evidence WHERE claim_id = ?").all(claimId).map((row) => ({ ...row }));

  const full = evidenceOf("c-full");
  assert.equal(full.length, 1);
  const fullSource = source(full[0].source_id);
  assert.deepEqual({ provider: fullSource.provider, external_id: fullSource.external_id, author: fullSource.author, author_role: fullSource.author_role,
    source_at: fullSource.source_at, ingested_at: fullSource.ingested_at, coverage: fullSource.coverage, sensitivity: fullSource.sensitivity, account: fullSource.account },
  { provider: "email", external_id: "msg-1", author: "Alex", author_role: "sender", source_at: "2026-05-01T10:00:00Z", ingested_at: "2026-05-02T08:00:00Z",
    coverage: "excerpt", sensitivity: "normal", account: null });
  assert.deepEqual([full[0].excerpt, full[0].stance, full[0].locator], ["Quoted line", "supports", "line 3"]);

  // A source without evidence is still linked to its claim by a bare evidence record: no excerpt, no locator, no stance invented.
  const sourceOnly = evidenceOf("c-source-only");
  assert.equal(sourceOnly.length, 1);
  assert.deepEqual([sourceOnly[0].excerpt, sourceOnly[0].locator, sourceOnly[0].stance], [null, null, null]);
  const bare = source(sourceOnly[0].source_id);
  assert.deepEqual([bare.provider, bare.external_id, bare.author, bare.source_at, bare.ingested_at, bare.coverage, bare.sensitivity],
    ["owner", null, null, null, null, null, "confidential"]);

  // Two claims naming the same external item share one source: the strictest sensitivity, the weakest coverage.
  const [sharedA, sharedB] = [evidenceOf("c-shared-a")[0], evidenceOf("c-shared-b")[0]];
  assert.equal(sharedA.source_id, sharedB.source_id);
  const shared = source(sharedA.source_id);
  assert.deepEqual([shared.sensitivity, shared.coverage], ["confidential", "excerpt"]);
  assert.notEqual(source(evidenceOf("c-other-ws")[0].source_id).id, shared.id, "another workspace gets its own source");
  assert.equal(source(evidenceOf("c-other-ws")[0].source_id).workspace_id, "other");

  assert.deepEqual(evidenceOf("c-none"), []);
  assert.equal(source(evidenceOf("c-weird")[0].source_id).sensitivity, "restricted", "an unknown level fails closed");
  assert.equal(source(evidenceOf("c-weird")[0].source_id).ingested_at, null, "ingestedAt is copied, never made up");

  // Never weaker than the claim.
  const rank = { normal: 0, confidential: 1, restricted: 2 };
  const level = (stored) => stored in rank ? stored : stored === "sensitive" ? "confidential" : "restricted";
  for (const claim of claimsBefore) for (const item of evidenceOf(claim.id)) {
    assert.ok(rank[source(item.source_id).sensitivity] >= rank[level(claim.sensitivity)], claim.id);
  }

  // A second run (the registry row lost) neither duplicates nor rewrites anything.
  const snapshot = { sources: rows(old, "context_sources"), evidence: rows(old, "context_evidence") };
  old.prepare("DELETE FROM schema_migrations").run();
  migrations.runSchemaMigrations(old, migrationList());
  assert.deepEqual({ sources: rows(old, "context_sources"), evidence: rows(old, "context_evidence") }, snapshot);
  // The external-id dedup index exists and is partial.
  assert.throws(() => old.prepare(`INSERT INTO context_sources (id, workspace_id, provider, external_id, sensitivity, created_at, updated_at)
    VALUES ('dup', 'personal', 'email', 'msg-1', 'normal', 1, 1)`).run(), /UNIQUE/);
  old.prepare(`INSERT INTO context_sources (id, workspace_id, provider, sensitivity, created_at, updated_at) VALUES ('n1', 'personal', 'owner', 'normal', 1, 1)`).run();
  old.prepare(`INSERT INTO context_sources (id, workspace_id, provider, sensitivity, created_at, updated_at) VALUES ('n2', 'personal', 'owner', 'normal', 1, 1)`).run();
});

test("the live database has the record tables and a claim read reports its sources from them", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws, { source: { provider: "email", externalId: "live-1", coverage: "excerpt", ingestedAt: "2026-05-02T08:00:00Z" }, evidence: { excerpt: "Hello", stance: "supports" } });
  assert.equal(claim.evidenceCount, 1);
  assert.equal(claim.evidenceItems[0].source.externalId, "live-1");
  assert.equal(claim.sourceCoverage, "content");
  // The legacy JSON columns are written back from the records for older code.
  const raw = db().prepare("SELECT source_metadata, evidence_metadata FROM context_claims WHERE id = ?").get(claim.id);
  assert.deepEqual(JSON.parse(raw.source_metadata), claim.source);
  assert.deepEqual(JSON.parse(raw.evidence_metadata), claim.evidence);
  // Re-running the conversion on the live database is a no-op.
  const before = count("SELECT COUNT(*) AS count FROM context_evidence");
  migrations.convertLegacySourcesAndEvidence(db());
  assert.equal(count("SELECT COUNT(*) AS count FROM context_evidence"), before);
});

// --- source commands -----------------------------------------------------------------------------

test("a source is created, retried, edited and archived through idempotent commands", () => {
  const ws = newWorkspace();
  const input = { commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, provider: "email", author: "Alex", coverage: "excerpt", sensitivity: "confidential" };
  const created = sources.createContextSource(input);
  assert.equal(created.changed, true);
  assert.equal(created.source.sensitivity, "confidential");
  assert.equal(created.historyEventId !== null, true);
  const retry = sources.createContextSource(input);
  assert.equal(retry.replayed, true);
  assert.equal(retry.historyEventId, created.historyEventId);
  assert.equal(events(ws).length, 1);
  assert.equal(events(ws)[0].object_type, "source");
  assert.throws(() => sources.createContextSource({ ...input, provider: "chat" }), (error) => error.code === "idempotency_conflict");

  // Nothing is filled in by the server.
  assert.deepEqual([created.source.sourceAt, created.source.ingestedAt, created.source.externalId, created.source.account, created.source.authorRole],
    [null, null, null, null, null]);

  const noOp = editSource(ws, created.source);
  assert.equal(noOp.changed, false);
  assert.equal(noOp.historyEventId, null);
  assert.equal(events(ws).length, 1);
  const updated = editSource(ws, created.source, { author: "Sam", coverage: "body" });
  assert.equal(updated.source.revision, created.source.revision + 1);
  assert.throws(() => editSource(ws, created.source, { author: "Stale" }), (error) => error.code === "revision_conflict");
  const archived = archiveSource(ws, updated.source);
  assert.notEqual(archived.source.archivedAt, null);
  assert.equal(archiveSource(ws, archived.source).changed, false);
  assert.throws(() => editSource(ws, archived.source, { author: "Late" }), (error) => error.code === "archived");
});

test("source input is validated and never completed by the server", () => {
  const ws = newWorkspace();
  const bad = (overrides, pattern) => assert.throws(() => makeSource(ws, overrides), pattern);
  bad({ sensitivity: undefined }, /sensitivity is required/);
  bad({ sensitivity: "secret" }, /sensitivity/);
  bad({ coverage: "full" }, /coverage/);
  bad({ sourceAt: "2026-02-30" }, /sourceAt is invalid/);
  bad({ ingestedAt: "next week" }, /ingestedAt is invalid/);
  bad({ provider: null, externalId: null, locator: null, author: null }, /at least/);
  bad({ provider: "x".repeat(81) }, /provider is invalid/);
  const loose = makeSource(ws, { coverage: undefined, provider: "owner" });
  assert.equal(loose.source.coverage, null, "a missing coverage stays missing");
});

test("a source is one record per external item, per provider and account", () => {
  const ws = newWorkspace();
  const first = makeSource(ws, { externalId: "msg-9", account: "me@example.test" });
  const again = makeSource(ws, { externalId: "msg-9", account: "me@example.test", locator: "https://example.test/other" });
  assert.equal(again.deduplicated, true);
  assert.equal(again.changed, false);
  assert.equal(again.source.id, first.source.id);
  assert.equal(count("SELECT COUNT(*) AS count FROM context_sources WHERE workspace_id = ?", ws), 1);
  const otherAccount = makeSource(ws, { externalId: "msg-9", account: "work@example.test" });
  assert.notEqual(otherAccount.source.id, first.source.id);
  const otherWorkspace = newWorkspace();
  assert.notEqual(makeSource(otherWorkspace, { externalId: "msg-9", account: "me@example.test" }).source.id, first.source.id);
  // Editing into another source's identity is refused.
  assert.throws(() => editSource(ws, otherAccount.source, { account: "me@example.test" }), (error) => error.code === "duplicate_source");
  // An archived source no longer blocks the identity.
  const archived = archiveSource(ws, first.source);
  assert.equal(makeSource(ws, { externalId: "msg-9", account: "me@example.test" }).deduplicated, false);
  assert.notEqual(archived.source.archivedAt, null);
});

test("sources are scoped to a workspace", () => {
  const a = newWorkspace();
  const b = newWorkspace();
  const source = makeSource(a).source;
  assert.equal(sources.listContextSources(b).length, 0);
  assert.throws(() => sources.getContextSource(b, source.id), (error) => error.status === 404);
  assert.throws(() => sources.updateContextSource({ commandId: randomUUID(), workspaceId: b, id: source.id, expectedRevision: 1, provider: "x", sensitivity: "normal" }),
    (error) => error.status === 404);
  const claimInB = makeClaim(b);
  assert.throws(() => addEvidence(b, claimInB, source), (error) => error.code === "invalid_source");
  assert.equal(count("SELECT COUNT(*) AS count FROM context_evidence WHERE workspace_id = ?", b), 0);
});

// --- evidence commands --------------------------------------------------------------------------

test("adding evidence returns a confirmed claim to review and reports its coverage", () => {
  const ws = newWorkspace();
  let claim = review(ws, makeClaim(ws), "confirmed");
  assert.equal(claim.sourceCoverage, "missing");
  const metadataSource = makeSource(ws, { coverage: "metadata", provider: "calendar" }).source;
  const bodySource = makeSource(ws, { coverage: "body", provider: "document" }).source;

  const bare = addEvidence(ws, claim, metadataSource, { stance: undefined });
  assert.equal(bare.evidence.metadataOnly, true);
  assert.equal(bare.claim.reviewStatus, "proposed");
  assert.equal(bare.claim.revision, claim.revision + 1);
  assert.equal(bare.claim.sourceCoverage, "metadata_only");
  assert.equal(bare.evidence.stance, null, "a stance nobody gave stays missing");
  assert.equal(claims.listClaimReviewEvents(ws, claim.id)[0].decision, "proposed");

  claim = review(ws, bare.claim, "confirmed");
  const content = addEvidence(ws, claim, bodySource, { excerpt: "Quoted", locator: "page 2" });
  assert.equal(content.evidence.metadataOnly, false);
  assert.equal(content.claim.reviewStatus, "proposed");
  assert.equal(content.claim.sourceCoverage, "content");
  assert.equal(content.claim.evidenceCount, 2);
  assert.equal(content.claim.evidenceItems[0].id, content.evidence.id, "newest first");
  assert.equal(content.claim.evidence.excerpt, "Quoted", "the legacy view follows the newest evidence");

  const event = events(ws).at(-1);
  assert.deepEqual([event.object_type, event.object_id, event.claim_id, event.claim_revision, event.operation], ["evidence", content.evidence.id, claim.id, content.claim.revision, "evidence.add"]);
});

test("metadata-only: an excerpt or a location needs a source with content coverage", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const metadataSource = makeSource(ws, { coverage: "metadata" }).source;
  const unknownSource = makeSource(ws, { coverage: undefined, provider: "owner" }).source;
  for (const source of [metadataSource, unknownSource]) {
    assert.throws(() => addEvidence(ws, claim, source, { excerpt: "A quote" }), (error) => error.status === 400 && error.code === "metadata_only_source");
    assert.throws(() => addEvidence(ws, claim, source, { locator: "line 4" }), (error) => error.code === "metadata_only_source");
  }
  assert.equal(count("SELECT COUNT(*) AS count FROM context_evidence WHERE workspace_id = ?", ws), 0);
  assert.equal(events(ws).length, 3, "only the claim and the two sources");
  // Excerpt length is capped.
  const body = makeSource(ws, { coverage: "body" }).source;
  assert.throws(() => addEvidence(ws, claim, body, { excerpt: "x".repeat(501) }), (error) => error.code === "evidence_too_long");
  assert.equal(addEvidence(ws, claim, body, { excerpt: "x".repeat(500) }).evidence.excerpt.length, 500);
  // An existing source cannot lose the coverage its evidence relies on, nor an update smuggle an excerpt in.
  assert.throws(() => editSource(ws, body, { coverage: "metadata" }), (error) => error.code === "coverage_in_use");
  const bareEvidence = addEvidence(ws, getClaim(ws, claim.id), metadataSource).evidence;
  assert.throws(() => editEvidence(ws, bareEvidence, { excerpt: "late quote" }), (error) => error.code === "metadata_only_source");
  assert.equal(editSource(ws, metadataSource, { coverage: "excerpt" }).changed, true);
});

test("legacy source and evidence on a claim become records, with the same metadata-only rule", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws, { source: { provider: "manual", locator: "https://example.test/a", coverage: "excerpt" }, evidence: { excerpt: "Quoted", stance: "supports" } });
  assert.equal(claim.evidenceItems.length, 1);
  assert.equal(claim.evidenceItems[0].source.sensitivity, "normal");
  assert.throws(() => makeClaim(ws, { source: { provider: "manual" }, evidence: { excerpt: "Quoted" } }), (error) => error.code === "metadata_only_source");
  assert.throws(() => makeClaim(ws, { evidence: { excerpt: "no source" } }), /requires source/);
  // A confidential claim's legacy source is at least confidential.
  const confidential = makeClaim(ws, { sensitivity: "confidential", source: { provider: "manual", coverage: "excerpt" } });
  assert.equal(confidential.evidenceItems[0].source.sensitivity, "confidential");
  // An update that changes the legacy evidence replaces the newest evidence; an absent source leaves the records alone.
  const edited = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision, predicate: claim.predicate,
    literal: claim.literal, freshness: "current", sensitivity: "normal", source: claim.source, evidence: { excerpt: "Quoted again", stance: "supports" } }).claim;
  assert.equal(edited.evidenceCount, 1);
  assert.equal(edited.evidence.excerpt, "Quoted again");
  const kept = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: edited.revision, predicate: claim.predicate,
    literal: { type: "string", value: "Changed" }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(kept.evidenceCount, 1);
  assert.equal(kept.evidence.excerpt, "Quoted again");
  // Sending back what the claim already reads is no change.
  assert.equal(claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: kept.revision, predicate: kept.predicate,
    literal: kept.literal, freshness: "current", sensitivity: "normal", source: kept.source, evidence: kept.evidence }).changed, false);
});

test("evidence commands retry, refuse stale revisions and write nothing on a conflict", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const source = makeSource(ws).source;
  const input = { commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, claimId: claim.id, expectedClaimRevision: claim.revision, sourceId: source.id, excerpt: "A", stance: "supports" };
  const first = evidence.addClaimEvidence(input);
  const retry = evidence.addClaimEvidence(input);
  assert.equal(retry.replayed, true);
  assert.equal(retry.historyEventId, first.historyEventId);
  assert.equal(count("SELECT COUNT(*) AS count FROM context_evidence WHERE claim_id = ?", claim.id), 1);
  assert.equal(getClaim(ws, claim.id).revision, claim.revision + 1, "a retry does not bump the claim again");

  const eventsBefore = events(ws).length;
  assert.throws(() => addEvidence(ws, claim, source, { excerpt: "B" }), (error) => error.code === "revision_conflict", "the claim moved on");
  assert.throws(() => evidence.addClaimEvidence({ ...input, commandId: randomUUID(), id: randomUUID() }), (error) => error.code === "revision_conflict");
  assert.throws(() => addEvidence(ws, first.claim, source, { excerpt: "A" }), (error) => error.code === "duplicate_evidence");
  assert.throws(() => editEvidence(ws, { ...first.evidence, revision: 99 }, { excerpt: "C" }), (error) => error.code === "revision_conflict");
  assert.throws(() => addEvidence(ws, { ...first.claim, id: "missing-claim" }, source), (error) => error.status === 404);
  assert.equal(events(ws).length, eventsBefore);

  const noOp = editEvidence(ws, first.evidence);
  assert.equal(noOp.changed, false);
  assert.equal(getClaim(ws, claim.id).revision, first.claim.revision);
  const edited = editEvidence(ws, first.evidence, { excerpt: "A, corrected" });
  assert.equal(edited.evidence.excerpt, "A, corrected");
  assert.equal(edited.claim.revision, first.claim.revision + 1);
  const archived = archiveEvidence(ws, edited.evidence);
  assert.notEqual(archived.evidence.archivedAt, null);
  assert.equal(archived.claim.evidenceCount, 0);
  assert.equal(archived.claim.sourceCoverage, "missing");
  assert.equal(archiveEvidence(ws, archived.evidence).changed, false);
  assert.throws(() => editEvidence(ws, archived.evidence, { excerpt: "late" }), (error) => error.code === "archived");
});

test("evidence cannot cite an archived source, and a source in use cannot be archived", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const source = makeSource(ws).source;
  const added = addEvidence(ws, claim, source, { excerpt: "A" });
  assert.throws(() => archiveSource(ws, sources.getContextSource(ws, source.id)), (error) => error.code === "source_in_use");
  assert.equal(sources.getContextSource(ws, source.id).evidenceCount, 1);
  archiveEvidence(ws, added.evidence);
  const archived = archiveSource(ws, sources.getContextSource(ws, source.id)).source;
  assert.throws(() => addEvidence(ws, getClaim(ws, claim.id), archived), (error) => error.code === "archived_source");
  const archivedClaim = claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: getClaim(ws, claim.id).revision }).claim;
  assert.throws(() => addEvidence(ws, archivedClaim, makeSource(ws).source), (error) => error.code === "archived");
});

test("a claim holds at most twenty active evidence records", () => {
  const ws = newWorkspace();
  let claim = makeClaim(ws);
  const source = makeSource(ws).source;
  for (let index = 0; index < 20; index += 1) claim = addEvidence(ws, claim, source, { excerpt: `Quote ${index}` }).claim;
  assert.equal(claim.evidenceItems.length, 20);
  assert.throws(() => addEvidence(ws, claim, source, { excerpt: "One too many" }), (error) => error.code === "evidence_limit");
});

// --- Undo / Redo / Skip -------------------------------------------------------------------------

test("source steps undo and redo: create, update and archive", () => {
  const ws = newWorkspace();
  const created = makeSource(ws, { author: "Alex" }).source;
  const updated = editSource(ws, created, { author: "Sam" }).source;
  archiveSource(ws, updated);
  assert.equal(history.getContextHistory(ws).undo.objectType, "source");
  assert.equal(undo(ws).object.archivedAt, null);
  assert.equal(sources.getContextSource(ws, created.id).author, "Sam");
  assert.equal(undo(ws).object.author, "Alex");
  assert.notEqual(undo(ws).object.archivedAt, null, "undoing a create archives the source");
  assert.equal(history.getContextHistory(ws).undo, null);
  assert.equal(redo(ws).object.archivedAt, null);
  assert.equal(redo(ws).object.author, "Sam");
  assert.notEqual(redo(ws).object.archivedAt, null);
  assert.equal(count("SELECT COUNT(*) AS count FROM context_change_events WHERE workspace_id = ? AND kind = 'undo'", ws), 3);
});

test("evidence steps undo and redo together with the claim's review state", () => {
  const ws = newWorkspace();
  const source = makeSource(ws, { coverage: "excerpt" }).source;
  let claim = review(ws, makeClaim(ws), "confirmed");
  const added = addEvidence(ws, claim, source, { excerpt: "Quoted" });
  const step = history.getContextHistory(ws).undo;
  assert.deepEqual([step.objectType, step.label, step.operation, step.sourceTitle], ["evidence", "preference", "evidence.add", "email"]);

  const undone = undo(ws);
  assert.equal(undone.object.evidence.archivedAt !== null, true);
  assert.equal(undone.object.claim.reviewStatus, "confirmed", "the review state the claim had comes back");
  assert.equal(getClaim(ws, claim.id).evidenceCount, 0);
  const redone = redo(ws);
  assert.equal(redone.object.evidence.archivedAt, null);
  assert.equal(getClaim(ws, claim.id).reviewStatus, "proposed");
  assert.equal(getClaim(ws, claim.id).evidenceCount, 1);

  // update and archive
  claim = getClaim(ws, claim.id);
  const edited = editEvidence(ws, readEvidence(ws, added.evidence.id), { excerpt: "Quoted, corrected" });
  assert.equal(undo(ws).object.evidence.excerpt, "Quoted");
  assert.equal(redo(ws).object.evidence.excerpt, "Quoted, corrected");
  archiveEvidence(ws, readEvidence(ws, edited.evidence.id));
  assert.equal(undo(ws).object.evidence.archivedAt, null);
  assert.equal(getClaim(ws, claim.id).evidenceItems[0].excerpt, "Quoted, corrected");
  assert.deepEqual(JSON.parse(db().prepare("SELECT evidence_metadata FROM context_claims WHERE id = ?").get(claim.id).evidence_metadata), { excerpt: "Quoted, corrected", stance: "supports" });
});
const readEvidence = (ws, id) => sources.readEvidence(ws, id);

test("steps interleave with ordinary claim steps in order, and claim steps still find the claim at its revision", () => {
  const ws = newWorkspace();
  const source = makeSource(ws, { coverage: "body" }).source;
  let claim = makeClaim(ws);
  claim = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision, predicate: claim.predicate,
    literal: { type: "string", value: "Second" }, freshness: "current", sensitivity: "normal" }).claim;
  const withEvidence = addEvidence(ws, claim, source, { excerpt: "Quoted" });
  undo(ws); // the evidence
  assert.equal(undo(ws).object.literal.value, "Quiet mornings", "the claim edit before it undoes cleanly");
  assert.equal(redo(ws).object.literal.value, "Second");
  assert.equal(redo(ws).object.evidence.archivedAt, null);
  assert.equal(getClaim(ws, claim.id).evidenceCount, 1);
  assert.equal(withEvidence.evidence.id, getClaim(ws, claim.id).evidenceItems[0].id);
});

test("Undo is refused as undo_conflict when the source or the evidence changed outside the stack, and writes nothing", () => {
  const ws = newWorkspace();
  const created = makeSource(ws, { author: "Alex" }).source;
  db().prepare("UPDATE context_sources SET author = 'Someone else', revision = revision + 1 WHERE id = ?").run(created.id);
  const before = events(ws).length;
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
  assert.equal(events(ws).length, before);

  const claim = makeClaim(ws);
  const source = makeSource(ws, { coverage: "body" }).source;
  const added = addEvidence(ws, claim, source, { excerpt: "Quoted" });
  db().prepare("UPDATE context_evidence SET excerpt = 'Tampered' WHERE id = ?").run(added.evidence.id);
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
  db().prepare("UPDATE context_evidence SET excerpt = 'Quoted' WHERE id = ?").run(added.evidence.id);
  // The claim moved on outside the history: also a conflict.
  db().prepare("UPDATE context_claims SET revision = revision + 1 WHERE id = ?").run(claim.id);
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
});

test("a step that can never succeed can be skipped, and the one under it becomes the top", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const body = makeSource(ws, { coverage: "body" }).source;
  const added = addEvidence(ws, claim, body, { excerpt: "Quoted" });
  archiveEvidence(ws, added.evidence);
  // The cited source disappears, so the archived evidence cannot come back.
  db().prepare("UPDATE context_sources SET archived_at = 1 WHERE id = ?").run(body.id);
  const top = history.getContextHistory(ws).undo;
  assert.equal(top.operation, "evidence.archive");
  assert.throws(() => undo(ws), (error) => error.code === "undo_conflict");
  const objectsBefore = JSON.stringify(db().prepare("SELECT * FROM context_evidence WHERE workspace_id = ?").all(ws));
  step(ws, "skip", { stack: "undo", expectedEventId: top.eventId });
  assert.equal(JSON.stringify(db().prepare("SELECT * FROM context_evidence WHERE workspace_id = ?").all(ws)), objectsBefore, "a skip changes no object");
  assert.notEqual(history.getContextHistory(ws).undo.eventId, top.eventId);
  assert.equal(history.getContextHistory(ws).undo.operation, "evidence.add");
});

test("legacy-shape claim steps undo and redo their evidence records", () => {
  const ws = newWorkspace();
  const claim = makeClaim(ws);
  const edited = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision, predicate: claim.predicate,
    literal: claim.literal, freshness: "current", sensitivity: "normal", source: { provider: "manual", coverage: "excerpt" }, evidence: { excerpt: "Quoted", stance: "supports" } }).claim;
  assert.equal(edited.evidenceCount, 1);
  assert.equal(undo(ws).object.evidenceCount, 0);
  assert.equal(getClaim(ws, claim.id).source, null);
  assert.equal(redo(ws).object.evidence.excerpt, "Quoted");
  assert.equal(getClaim(ws, claim.id).evidenceCount, 1);
  // Replacing the legacy evidence and undoing brings the earlier evidence back.
  const replaced = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: getClaim(ws, claim.id).revision, predicate: claim.predicate,
    literal: claim.literal, freshness: "current", sensitivity: "normal", source: { provider: "manual", coverage: "excerpt" }, evidence: { excerpt: "Another", stance: "supports" } }).claim;
  assert.equal(replaced.evidence.excerpt, "Another");
  assert.equal(undo(ws).object.evidence.excerpt, "Quoted");
  assert.equal(getClaim(ws, claim.id).evidenceCount, 1);
});

// --- Context Inbox ------------------------------------------------------------------------------

test("a Context Inbox approval records a confidential excerpt source and stays retry-safe", async () => {
  const ws = "personal";
  const proposal = inbox.previewContextInbox(ws, "Apollo – priorita: vysoká").proposals[0];
  const input = { commandId: randomUUID(), workspaceId: ws, id: proposal.id, subjectId: proposal.subject.entityId, predicate: proposal.predicate,
    literal: { ...proposal.literal, value: "critical" }, freshness: "needs_review", evidenceExcerpt: proposal.evidenceExcerpt };
  const first = inbox.approveContextInboxClaim(input);
  assert.equal(first.claim.evidenceItems.length, 1);
  const item = first.claim.evidenceItems[0];
  assert.deepEqual([item.source.provider, item.source.sensitivity, item.source.coverage, item.metadataOnly, item.excerpt],
    ["manual-context-inbox", "confidential", "excerpt", false, proposal.evidenceExcerpt]);
  assert.match(item.source.ingestedAt, /^\d{4}-\d{2}-\d{2}T/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const retry = inbox.approveContextInboxClaim(input);
  assert.equal(retry.replayed, true);
  assert.equal(retry.claim.evidenceItems[0].source.ingestedAt, item.source.ingestedAt);
  assert.equal(count("SELECT COUNT(*) AS count FROM context_evidence WHERE claim_id = ?", proposal.id), 1);
  assert.equal(count("SELECT COUNT(*) AS count FROM context_sources WHERE provider = 'manual-context-inbox' AND id IN (SELECT source_id FROM context_evidence WHERE claim_id = ?)", proposal.id), 1);
  assert.equal(undo(ws).object.archivedAt !== null, true, "an approval is one undoable claim step");
});
