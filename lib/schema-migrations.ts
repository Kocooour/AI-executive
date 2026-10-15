import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Named, additive schema/data migrations. Each one runs exactly once per database, inside its
// own transaction together with the row that records it, so an interrupted run leaves no trace
// and the next start simply tries again. The older ad-hoc migrations in server-store keep
// working as they are; new migrations are registered here.

export interface SchemaMigration {
  id: string;
  up: (database: DatabaseSync) => void;
}

export const schemaMigrations: SchemaMigration[] = [
  {
    // Context Graph v2: claim sensitivity has three levels. The two-level "sensitive" becomes
    // "confidential"; stricter values are kept. Revisions and timestamps are not touched.
    id: "2026-10-context-claims-three-level-sensitivity",
    up(database) {
      database.exec("UPDATE context_claims SET sensitivity = 'confidential' WHERE sensitivity = 'sensitive'");
    },
  },
  {
    // Context Graph v2: durable Undo/Redo. Change events get a deterministic order (`sequence`), the
    // type of the changed object, a kind (change, undo or redo) and the event a reversal reverses.
    // The columns are added; what was recorded (payloads, revisions, times) is never rewritten.
    id: "2026-10-context-change-events-undo-linkage",
    up(database) {
      const columns = new Set((database.prepare("PRAGMA table_info(context_change_events)").all() as Array<{ name?: string }>)
        .map((row) => String(row.name)));
      if (!columns.has("sequence")) database.exec("ALTER TABLE context_change_events ADD COLUMN sequence INTEGER");
      if (!columns.has("object_type")) database.exec("ALTER TABLE context_change_events ADD COLUMN object_type TEXT");
      if (!columns.has("kind")) database.exec("ALTER TABLE context_change_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'change'");
      if (!columns.has("reverts_event_id")) database.exec("ALTER TABLE context_change_events ADD COLUMN reverts_event_id TEXT");
      database.exec(`UPDATE context_change_events SET object_type =
        CASE WHEN operation LIKE 'subject.%' THEN 'subject' ELSE 'claim' END WHERE object_type IS NULL`);
      let next = Number((database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM context_change_events").get() as { value: number }).value);
      const pending = database.prepare("SELECT rowid AS row FROM context_change_events WHERE sequence IS NULL ORDER BY created_at, rowid").all() as Array<{ row: number }>;
      const assign = database.prepare("UPDATE context_change_events SET sequence = ? WHERE rowid = ?");
      for (const { row } of pending) assign.run(++next, row);
      database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS context_change_events_sequence_idx ON context_change_events(sequence);
        CREATE INDEX IF NOT EXISTS context_change_events_workspace_sequence_idx ON context_change_events(workspace_id, sequence)`);
    },
  },
  {
    // Context Graph v2: sources and evidence are records. The tables are created, the change events get the
    // claim they affect, and every claim's JSON source/evidence becomes a source record plus one evidence record
    // (the link between the claim and its source; the JSON evidence fields are copied when there are any). The
    // JSON columns stay as they are for older code. Nothing is invented: a missing field stays null, ingestedAt
    // is copied, never made up, and a legacy source is at least as sensitive as the claim it came from.
    id: "2026-10-context-sources-and-evidence-records",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS context_sources (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          account TEXT,
          provider TEXT,
          external_id TEXT,
          locator TEXT,
          author TEXT,
          author_role TEXT,
          source_at TEXT,
          ingested_at TEXT,
          coverage TEXT,
          sensitivity TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS context_sources_external_idx
          ON context_sources(workspace_id, COALESCE(provider, ''), COALESCE(account, ''), external_id)
          WHERE external_id IS NOT NULL AND archived_at IS NULL;
        CREATE INDEX IF NOT EXISTS context_sources_workspace_idx
          ON context_sources(workspace_id, archived_at, updated_at DESC);
        CREATE TABLE IF NOT EXISTS context_evidence (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          claim_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          locator TEXT,
          excerpt TEXT,
          stance TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS context_evidence_claim_idx
          ON context_evidence(workspace_id, claim_id, archived_at, created_at DESC);
        CREATE INDEX IF NOT EXISTS context_evidence_source_idx ON context_evidence(source_id, archived_at);
      `);
      const eventColumns = new Set((database.prepare("PRAGMA table_info(context_change_events)").all() as Array<{ name?: string }>)
        .map((row) => String(row.name)));
      if (!eventColumns.has("claim_id")) database.exec("ALTER TABLE context_change_events ADD COLUMN claim_id TEXT");
      if (!eventColumns.has("claim_revision")) database.exec("ALTER TABLE context_change_events ADD COLUMN claim_revision INTEGER");
      backfillEventClaimLinks(database);
      convertLegacySourcesAndEvidence(database);
    },
  },
];

export function runSchemaMigrations(database: DatabaseSync, migrations: SchemaMigration[] = schemaMigrations) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied: string[] = [];
  for (const migration of migrations) {
    database.exec("BEGIN IMMEDIATE");
    try {
      // Checked after the write lock is held, so two processes starting together run it once.
      if (!database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id)) {
        migration.up(database);
        database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
        applied.push(migration.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* the original error is the one that matters */ }
      throw error;
    }
  }
  return applied;
}

/**
 * Runs on every database initialisation, not once: a binary from before the undo-linkage migration (a
 * rollback) writes change events without `sequence` and `object_type`. They get the next sequence numbers
 * in insertion order, and the type their operation implies, before any new command runs.
 */
export function repairContextEventOrder(database: DatabaseSync) {
  const columns = new Set((database.prepare("PRAGMA table_info(context_change_events)").all() as Array<{ name?: string }>).map((row) => String(row.name)));
  if (!columns.has("sequence") || !columns.has("object_type")) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    let next = Number((database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM context_change_events").get() as { value: number }).value);
    const pending = database.prepare("SELECT rowid AS row FROM context_change_events WHERE sequence IS NULL ORDER BY rowid").all() as Array<{ row: number }>;
    const assign = database.prepare("UPDATE context_change_events SET sequence = ? WHERE rowid = ?");
    for (const { row } of pending) assign.run(++next, row);
    database.exec(`UPDATE context_change_events SET object_type =
      CASE WHEN operation LIKE 'subject.%' THEN 'subject' ELSE 'claim' END WHERE object_type IS NULL`);
    if (columns.has("claim_id") && columns.has("claim_revision")) backfillEventClaimLinks(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* the original error matters */ }
    throw error;
  }
}

/** A claim event links to its own claim: the revision that the claim reached is the one it recorded. */
function backfillEventClaimLinks(database: DatabaseSync) {
  database.exec(`UPDATE context_change_events SET claim_id = object_id, claim_revision = after_revision
    WHERE claim_id IS NULL AND COALESCE(object_type, 'claim') = 'claim' AND operation NOT LIKE 'subject.%'`);
}

const strictness: Record<string, number> = { normal: 0, confidential: 1, restricted: 2 };
const coverageRank: Record<string, number> = { metadata: 1, excerpt: 2, body: 3 };

function stricter(a: string, b: string) {
  return (strictness[a] ?? 2) >= (strictness[b] ?? 2) ? a : b;
}

function legacySensitivity(stored: string) {
  if (stored === "normal" || stored === "confidential" || stored === "restricted") return stored;
  return stored === "sensitive" ? "confidential" : "restricted"; // an unknown value fails closed
}

function parseObject(text: string | null) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const text = (value: unknown) => typeof value === "string" && value !== "" ? value : null;

/**
 * Converts each claim's JSON source/evidence into records. Sources that name the same external item
 * (workspace, provider, externalId) become one record, with the strictest sensitivity and the strongest
 * coverage of the claims that shared it. Deterministic ids and INSERT OR IGNORE make a second run a no-op.
 */
export function convertLegacySourcesAndEvidence(database: DatabaseSync) {
  const claims = database.prepare(`SELECT id, workspace_id, sensitivity, source_metadata, evidence_metadata, recorded_at, updated_at
    FROM context_claims WHERE source_metadata IS NOT NULL ORDER BY recorded_at, rowid`).all() as Array<{
      id: string; workspace_id: string; sensitivity: string; source_metadata: string; evidence_metadata: string | null;
      recorded_at: number; updated_at: number }>;
  type SourceDraft = { id: string; workspace: string; provider: string | null; externalId: string | null; locator: string | null;
    author: string | null; authorRole: string | null; sourceAt: string | null; ingestedAt: string | null; coverage: string | null;
    sensitivity: string; createdAt: number; updatedAt: number };
  const sources = new Map<string, SourceDraft>();
  const contentSources = new Set<string>();
  const evidence: Array<{ id: string; workspace: string; claimId: string; sourceId: string; locator: string | null; excerpt: string | null;
    stance: string | null; createdAt: number; updatedAt: number }> = [];
  for (const claim of claims) {
    if (database.prepare("SELECT 1 FROM context_evidence WHERE claim_id = ? LIMIT 1").get(claim.id)) continue;
    const source = parseObject(claim.source_metadata);
    if (!source) continue;
    const externalId = text(source.externalId);
    const provider = text(source.provider);
    const sourceId = externalId
      ? `src:${createHash("sha256").update(JSON.stringify([claim.workspace_id, provider ?? "", externalId])).digest("hex").slice(0, 32)}`
      : `src:claim:${claim.id}`;
    const coverage = typeof source.coverage === "string" && coverageRank[source.coverage] ? source.coverage : null;
    const sensitivity = legacySensitivity(claim.sensitivity);
    const existing = sources.get(sourceId);
    if (existing) {
      existing.sensitivity = stricter(existing.sensitivity, sensitivity);
      // The strongest coverage wins: the source is one external item, and a claim with an excerpt proves Lumi had content.
      if ((coverageRank[coverage ?? ""] ?? 0) > (coverageRank[existing.coverage ?? ""] ?? 0)) existing.coverage = coverage;
    } else {
      sources.set(sourceId, { id: sourceId, workspace: claim.workspace_id, provider, externalId, locator: text(source.locator),
        author: text(source.author), authorRole: text(source.authorRole), sourceAt: text(source.sourceAt),
        ingestedAt: text(source.ingestedAt), coverage, sensitivity, createdAt: Number(claim.recorded_at), updatedAt: Number(claim.updated_at) });
    }
    const detail = parseObject(claim.evidence_metadata);
    if (text(detail?.excerpt) || text(detail?.locator)) contentSources.add(sourceId);
    evidence.push({ id: `ev:${claim.id}`, workspace: claim.workspace_id, claimId: claim.id, sourceId,
      locator: text(detail?.locator), excerpt: text(detail?.excerpt),
      stance: detail?.stance === "supports" || detail?.stance === "contradicts" ? detail.stance : null,
      createdAt: Number(claim.recorded_at), updatedAt: Number(claim.updated_at) });
  }
  const insertSource = database.prepare(`INSERT OR IGNORE INTO context_sources
    (id, workspace_id, revision, account, provider, external_id, locator, author, author_role, source_at, ingested_at, coverage,
     sensitivity, created_at, updated_at, archived_at) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  // A source whose external item already has a record (a random id from the command, or an earlier conversion) is merged into
  // that record: the strictest sensitivity, and the strongest coverage when the legacy evidence carries content. Evidence
  // only ever points at a source that exists.
  const resolved = new Map<string, string>();
  const keyLookup = database.prepare(`SELECT id, sensitivity, coverage FROM context_sources WHERE workspace_id = ? AND COALESCE(provider, '') = ?
    AND COALESCE(account, '') = '' AND external_id = ? AND archived_at IS NULL`);
  for (const source of sources.values()) {
    const found = source.externalId ? keyLookup.get(source.workspace, source.provider ?? "", source.externalId) as
      { id: string; sensitivity: string; coverage: string | null } | undefined : undefined;
    if (found && found.id !== source.id) {
      resolved.set(source.id, found.id);
      const sensitivity = stricter(found.sensitivity, source.sensitivity);
      const raiseCoverage = contentSources.has(source.id) && (coverageRank[source.coverage ?? ""] ?? 0) > (coverageRank[found.coverage ?? ""] ?? 0);
      if (sensitivity !== found.sensitivity || raiseCoverage) {
        database.prepare("UPDATE context_sources SET sensitivity = ?, coverage = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(sensitivity, raiseCoverage ? source.coverage : found.coverage, Date.now(), found.id);
      }
      continue;
    }
    insertSource.run(source.id, source.workspace, source.provider, source.externalId, source.locator, source.author, source.authorRole,
      source.sourceAt, source.ingestedAt, source.coverage, source.sensitivity, source.createdAt, source.updatedAt);
  }
  const insertEvidence = database.prepare(`INSERT OR IGNORE INTO context_evidence
    (id, workspace_id, revision, claim_id, source_id, locator, excerpt, stance, created_at, updated_at, archived_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  const sourceExists = database.prepare("SELECT 1 FROM context_sources WHERE id = ?");
  for (const item of evidence) {
    const sourceId = resolved.get(item.sourceId) ?? item.sourceId;
    if (!sourceExists.get(sourceId)) continue;
    insertEvidence.run(item.id, item.workspace, item.claimId, sourceId, item.locator, item.excerpt, item.stance, item.createdAt, item.updatedAt);
  }
}

/** Runs at every start: claims written by an older binary after the migration (a rollback) get their records too. */
export function repairLegacySourceRecords(database: DatabaseSync) {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (!tables.has("context_sources") || !tables.has("context_evidence")) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    convertLegacySourcesAndEvidence(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* the original error matters */ }
    throw error;
  }
}
