import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-dir";
import { getDatabase } from "./server-store";

/** Stage 1 contract only: no content, excerpts, vectors or search access live here. */
export const semanticIndexVersion = 1;
export interface SemanticIndexEntry {
  indexVersion: 1;
  modelVersion: null;
  workspaceId: string;
  objectType: "entity" | "claim" | "subject";
  objectId: string;
  sectionId: string | null;
  canonicalRevision: number;
  sensitivity: "normal" | "confidential" | "restricted";
  policyFingerprint: string;
  contentType: string;
  language: null;
  indexedAt: number;
}

type Row = { id: string; workspace_id: string; revision: number; sensitivity: string;
  review_status: string; freshness: string; archived_at: number | null; updated_at: number;
  source_sensitivity?: string | null; };

const sensitivityRank = { normal: 0, confidential: 1, restricted: 2 } as const;
function sensitivity(value: unknown): keyof typeof sensitivityRank {
  if (value === "normal") return "normal";
  if (value === "sensitive" || value === "confidential") return "confidential";
  return "restricted";
}
function strictest(a: keyof typeof sensitivityRank, b: keyof typeof sensitivityRank) {
  return sensitivityRank[a] >= sensitivityRank[b] ? a : b;
}
function fingerprint(fields: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function openManifest() {
  // The canonical store creates and protects the parent directory first.
  const filename = path.join(resolveDataDirectory(), "semantic-index-v1.sqlite");
  const derived = new DatabaseSync(filename);
  protectManifestFiles(filename);
  derived.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS manifest_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_entries (
      workspace_id TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
      section_id TEXT, canonical_revision INTEGER NOT NULL, sensitivity TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL, content_type TEXT NOT NULL,
      index_version INTEGER NOT NULL, model_version TEXT, language TEXT,
      indexed_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, object_type, object_id)
    );
    CREATE INDEX IF NOT EXISTS semantic_entries_workspace_idx ON semantic_entries(workspace_id);
  `);
  protectManifestFiles(filename);
  return derived;
}

function protectManifestFiles(filename: string) {
  for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

function appendEntries(canonical: DatabaseSync, derived: DatabaseSync, workspaceId: string, now: number) {
  const insert = derived.prepare(`INSERT INTO semantic_entries
    (workspace_id, object_type, object_id, section_id, canonical_revision, sensitivity,
     policy_fingerprint, content_type, index_version, model_version, language, indexed_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, NULL, NULL, ?)`);
  const entities = canonical.prepare("SELECT id, payload, updated_at FROM entities").all() as
    Array<{ id: string; payload: string; updated_at: number }>;
  for (const row of entities) {
    // A malformed or unknown policy fails closed. The manifest is metadata only, not an ACL.
    const entity = JSON.parse(row.payload) as { workspaceId?: string; type?: string; status?: string;
      properties?: { sensitivity?: string } };
    if (entity.workspaceId !== workspaceId || entity.status === "archived") continue;
    const level = sensitivity(entity.properties?.sensitivity ?? "normal");
    insert.run(workspaceId, "entity", row.id, row.updated_at, level,
      fingerprint([workspaceId, row.id, row.updated_at, level, entity.status]), entity.type ?? "unknown", now);
  }
  const subjects = canonical.prepare(`SELECT id, workspace_id, revision, subject_type, archived_at
    FROM context_subjects WHERE workspace_id = ? AND archived_at IS NULL`).all(workspaceId) as
    Array<{ id: string; workspace_id: string; revision: number; subject_type: string; archived_at: number | null }>;
  for (const row of subjects) {
    insert.run(workspaceId, "subject", row.id, row.revision, "restricted",
      fingerprint([workspaceId, row.id, row.revision, row.archived_at]), row.subject_type, now);
  }
  const claims = canonical.prepare(`SELECT c.id, c.workspace_id, c.revision, c.sensitivity, c.review_status,
      c.freshness, c.archived_at, c.updated_at,
      (SELECT GROUP_CONCAT(CASE WHEN s.id IS NULL OR s.workspace_id != c.workspace_id
        OR s.archived_at IS NOT NULL OR e.workspace_id != c.workspace_id
        THEN 'restricted' ELSE s.sensitivity END, ',')
       FROM context_evidence e LEFT JOIN context_sources s ON s.id = e.source_id
       WHERE e.claim_id = c.id AND e.archived_at IS NULL) AS source_sensitivity
    FROM context_claims c WHERE c.workspace_id = ? AND c.archived_at IS NULL`).all(workspaceId) as Row[];
  for (const row of claims) {
    let level = sensitivity(row.sensitivity);
    for (const sourceLevel of row.source_sensitivity?.split(",") ?? []) level = strictest(level, sensitivity(sourceLevel));
    insert.run(workspaceId, "claim", row.id, row.revision, level,
      fingerprint([workspaceId, row.id, row.revision, level, row.review_status, row.freshness, row.archived_at]),
      "context_claim", now);
  }
}

/**
 * Rebuilds metadata for affected workspaces from canonical rows. Safe to retry after a crash:
 * publish the derived transaction first, then acknowledge the canonical queue. A new mutation
 * after the queue snapshot retains its newer outbox row for the next pass.
 */
let beforeAcknowledgeForTests: (() => void) | null = null;
export function setSemanticBeforeAcknowledgeForTests(hook: (() => void) | null) {
  if (hook !== null && !process.env.NODE_TEST_CONTEXT) throw new Error("Only available to tests");
  beforeAcknowledgeForTests = hook;
}

export function reconcileSemanticManifest() {
  const canonical = getDatabase();
  // Capture exact IDs before reading canonical rows. A mutation committed during rebuild must
  // leave its new outbox row intact, even if its workspace was not in this batch.
  const pending = canonical.prepare("SELECT id, workspace_id FROM semantic_index_outbox ORDER BY id LIMIT 1000").all() as
    Array<{ id: number; workspace_id: string }>;
  const derived = openManifest();
  const filename = path.join(resolveDataDirectory(), "semantic-index-v1.sqlite");
  try {
    const initialized = derived.prepare("SELECT value FROM manifest_state WHERE key = 'initialized'").get();
    if (!pending.length && initialized) return { rebuiltWorkspaces: 0, processedEvents: 0 };
    const all = !initialized || pending.some((row) => row.workspace_id === "*");
    const workspaces = all
      ? new Set((canonical.prepare("SELECT payload FROM entities").all() as Array<{ payload: string }>)
        .map((row) => (JSON.parse(row.payload) as { type?: string; workspaceId?: string }))
        .filter((entity) => entity.type === "workspace" && entity.workspaceId).map((entity) => entity.workspaceId!))
      : new Set(pending.map((row) => row.workspace_id));
    derived.exec("BEGIN IMMEDIATE");
    protectManifestFiles(filename);
    try {
      if (all) derived.exec("DELETE FROM semantic_entries");
      const clear = derived.prepare("DELETE FROM semantic_entries WHERE workspace_id = ?");
      for (const workspaceId of workspaces) {
        if (!all) clear.run(workspaceId);
        appendEntries(canonical, derived, workspaceId, Date.now());
      }
      derived.prepare(`INSERT INTO manifest_state(key, value) VALUES ('initialized', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
      derived.exec("COMMIT");
      protectManifestFiles(filename);
    } catch (error) {
      derived.exec("ROLLBACK");
      throw error;
    }
    beforeAcknowledgeForTests?.();
    if (pending.length) {
      canonical.exec("BEGIN IMMEDIATE");
      try {
        const acknowledge = canonical.prepare("DELETE FROM semantic_index_outbox WHERE id = ?");
        for (const event of pending) acknowledge.run(event.id);
        canonical.exec("COMMIT");
      } catch (error) { canonical.exec("ROLLBACK"); throw error; }
    }
    return { rebuiltWorkspaces: workspaces.size, processedEvents: pending.length };
  } finally { protectManifestFiles(filename); derived.close(); }
}
