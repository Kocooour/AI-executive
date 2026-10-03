import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-context-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const pact = await import("../lib/pact.ts");
const store = await import("../lib/server-store.ts");

function create(overrides = {}) {
  return claims.createOwnerClaim({
    commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "preference",
    literal: { type: "string", value: "Quiet mornings" }, freshness: "current", sensitivity: "normal",
    ...overrides,
  }).claim;
}

test("create is transactional and an exact retry is idempotent", () => {
  const input = { commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "preference",
    literal: { type: "string", value: "Quiet mornings" }, freshness: "current", sensitivity: "normal" };
  const first = claims.createOwnerClaim(input);
  const retry = claims.createOwnerClaim(input);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.claim, first.claim);
  assert.equal(claims.listOwnerClaims("personal").filter((item) => item.id === input.id).length, 1);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_change_events WHERE object_id=?").get(input.id).count), 1);
});

test("no-op update consumes no history step and stale revision is refused", () => {
  const created = create();
  const beforeCount = Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_change_events WHERE object_id=?").get(created.id).count);
  const noOp = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, predicate: created.predicate, literal: created.literal,
    freshness: created.freshness, sensitivity: created.sensitivity });
  assert.equal(noOp.claim.revision, created.revision);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_change_events WHERE object_id=?").get(created.id).count), beforeCount);
  const updated = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, predicate: created.predicate,
    literal: { type: "string", value: "Deep work mornings" }, freshness: created.freshness, sensitivity: created.sensitivity }).claim;
  assert.equal(updated.revision, created.revision + 1);
  assert.throws(() => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" }), (error) => error.code === "revision_conflict");
});

test("editing reviewed content atomically returns it to the review queue", () => {
  const created = create();
  const confirmed = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" }).claim;
  assert.equal(claims.listEligibleClaims("personal").some((item) => item.id === created.id), true);
  const noOp = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: confirmed.revision, predicate: confirmed.predicate, literal: confirmed.literal,
    freshness: confirmed.freshness, sensitivity: confirmed.sensitivity }).claim;
  assert.equal(noOp.reviewStatus, "confirmed");
  const changed = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: confirmed.revision, predicate: confirmed.predicate,
    literal: { type: "string", value: "Changed after confirmation" }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(changed.reviewStatus, "proposed");
  assert.equal(claims.listEligibleClaims("personal").some((item) => item.id === created.id), false);
});

test("resolver admits only confirmed current normal live claims and preserves legacy context", () => {
  const eligible = create({ literal: { type: "string", value: "Eligible" } });
  const confirmed = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: eligible.id,
    expectedRevision: eligible.revision, decision: "confirmed" }).claim;
  const sensitive = create({ literal: { type: "string", value: "Secret" }, sensitivity: "sensitive" });
  claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: sensitive.id,
    expectedRevision: sensitive.revision, decision: "confirmed" });
  const stale = create({ literal: { type: "string", value: "Old" }, freshness: "stale" });
  claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: stale.id,
    expectedRevision: stale.revision, decision: "confirmed" });
  const archived = create({ literal: { type: "string", value: "Archived" } });
  const reviewedArchived = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: archived.id,
    expectedRevision: archived.revision, decision: "confirmed" }).claim;
  claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: archived.id,
    expectedRevision: reviewedArchived.revision });
  pact.saveOwnerContext({ workspaceId: "personal", scope: "workspace", sensitivity: "normal", title: "Legacy", content: "Preserved" });
  const resolved = pact.resolvePACTContext({ workspaceId: "personal" });
  assert.deepEqual(resolved.claims.map((item) => item.id), [confirmed.id]);
  assert.equal(resolved.context.some((item) => item.title === "Legacy"), true);
});

test("cross-workspace or missing canonical subjects fail before writing history", () => {
  const historyBefore = Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_change_events").get().count);
  assert.throws(() => create({ subject: { entityId: "missing-project" } }), (error) => error.code === "invalid_subject");
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_change_events").get().count), historyBefore);
});

test("source and evidence stay explicitly absent unless supplied", () => {
  const claim = create();
  assert.equal(claim.source, null);
  assert.equal(claim.evidence, null);
  assert.throws(() => create({ evidence: { excerpt: "unsupported", stance: "supports" } }), /requires source/);
  assert.throws(() => create({ source: { provider: "owner", sourceAt: "2026-02-30T12:00:00Z" } }), /invalid/);
  assert.throws(() => create({ source: { provider: "owner", sourceAt: "next Tuesday" } }), /invalid/);
  assert.equal(create({ source: { provider: "owner", sourceAt: "2026-02-28T12:00:00+01:00" } }).source.sourceAt,
    "2026-02-28T12:00:00+01:00");
});

test("resolver withholds Graph v2 claims from agents without context.read", () => {
  const created = create({ literal: { type: "string", value: "Tool gated" } });
  claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" });
  const agent = { id: "no-context", name: "No context", version: 1, instructions: "test",
    contextScopes: ["workspace"], tools: ["task.read"], triggerModes: ["manual"] };
  assert.deepEqual(pact.resolvePACTContext({ workspaceId: "personal", agent }).claims, []);
});

test("calendar dates are semantic and validTo includes the selected local day", () => {
  assert.throws(() => create({ validFrom: "2026-02-30" }), /invalid/);
  assert.throws(() => create({ literal: { type: "date", value: "2026-02-30" } }), /invalid/);
  const created = create({ validFrom: "2026-03-01", validTo: "2026-03-10" });
  const confirmed = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" }).claim;
  assert.equal(claims.isEligibleClaim(confirmed, undefined, "2026-03-10"), true);
  assert.equal(claims.isEligibleClaim(confirmed, undefined, "2026-03-11"), false);
});

test("command identifiers and histories are scoped by workspace", () => {
  const now = Date.now();
  const workspace = { id: "workspace:team", type: "workspace", title: "Team", status: "active", workspaceId: "team",
    properties: { kind: "shared", role: "owner", members: [{ id: "owner", role: "owner" }] }, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(workspace.id, JSON.stringify(workspace), now);
  const commandId = randomUUID();
  const personal = claims.createOwnerClaim({ commandId, workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "preference",
    literal: { type: "string", value: "Personal" }, freshness: "current", sensitivity: "normal" }).claim;
  const team = claims.createOwnerClaim({ commandId, workspaceId: "team", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:team" }, predicate: "preference",
    literal: { type: "string", value: "Team" }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(claims.listClaimHistory("personal", personal.id).length, 1);
  assert.equal(claims.listClaimHistory("team", team.id).length, 1);
});

test("resolver excludes a claim when its live canonical target disappears", () => {
  const now = Date.now();
  const target = { id: "project:orphan-test", type: "project", title: "Temporary", status: "active", workspaceId: "personal",
    properties: {}, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(target.id, JSON.stringify(target), now);
  const created = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: randomUUID(), expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "related_to", target: { entityId: target.id },
    freshness: "current", sensitivity: "normal" }).claim;
  const confirmed = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: created.id,
    expectedRevision: created.revision, decision: "confirmed" }).claim;
  assert.equal(claims.isEligibleClaim(confirmed), true);
  store.getDatabase().prepare("DELETE FROM entities WHERE id = ?").run(target.id);
  assert.equal(claims.isEligibleClaim(confirmed), false);
  assert.equal(claims.listEligibleClaims("personal").some((item) => item.id === confirmed.id), false);
});
