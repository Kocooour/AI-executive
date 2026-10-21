import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { baselineNoteRevisions } from "./note-revisions";

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
  {
    // Context Graph v2: the revision at which a claim's evidence records last matched its legacy JSON source/evidence. Every
    // command of this release marks the claims it wrote; an older binary bumps the revision without marking it, so the
    // start-up reconciliation can tell a claim it edited from one it did not touch.
    id: "2026-10-context-claims-legacy-synced-revision",
    up(database) {
      const columns = new Set((database.prepare("PRAGMA table_info(context_claims)").all() as Array<{ name?: string }>).map((row) => String(row.name)));
      if (!columns.has("legacy_synced_revision")) database.exec("ALTER TABLE context_claims ADD COLUMN legacy_synced_revision INTEGER");
      database.exec("UPDATE context_claims SET legacy_synced_revision = revision WHERE legacy_synced_revision IS NULL");
    },
  },
  {
    // Context Search v1: the external eligibility NOT EXISTS must find *all* active evidence
    // of a claim, including corrupt cross-workspace links, without scanning the evidence table
    // once per claim. The existing (workspace_id, claim_id, ...) index cannot serve that predicate
    // because e.workspace_id is intentionally not restricted in the privacy check.
    id: "2026-10-context-search-evidence-guard-index",
    up(database) {
      database.exec(`CREATE INDEX IF NOT EXISTS context_evidence_claim_guard_idx
        ON context_evidence(claim_id, archived_at, workspace_id)`);
    },
  },
  {
    // Notes: the server keeps the history of a note's title and text. Every existing note gets revision 1 (baseline);
    // later revisions are written by the transaction that stores a change (lib/note-revisions.ts).
    id: "2026-10-note-revisions",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS note_revisions (
          id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          origin TEXT NOT NULL,
          store_revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(note_id, revision)
        );
        CREATE INDEX IF NOT EXISTS note_revisions_note_idx ON note_revisions(note_id)
      `);
      const row = database.prepare("SELECT value FROM metadata WHERE key = 'revision'").get() as { value?: string } | undefined;
      baselineNoteRevisions(database, Number(row?.value) || 0);
    },
  },
  {
    // iCloud calendar over CalDAV (read-only). One account row holds the Apple ID and app-specific password encrypted with
    // the calendar key (`encrypted_credentials`), the account's principal and calendar-home addresses (encrypted too: they
    // contain iCloud's account number) and only a masked Apple ID as its label. A selected iCloud calendar is a calendar
    // source with provider 'caldav' and the account it belongs to; existing ICS sources are not touched.
    id: "2026-10-calendar-accounts-caldav",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS calendar_accounts (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT NOT NULL,
          encrypted_credentials TEXT NOT NULL,
          principal_url TEXT,
          home_url TEXT,
          status TEXT NOT NULL,
          last_error TEXT,
          last_success_at INTEGER,
          revision INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      const columns = new Set((database.prepare("PRAGMA table_info(calendar_sources)").all() as Array<{ name?: string }>).map((row) => String(row.name)));
      if (!columns.has("account_id")) database.exec("ALTER TABLE calendar_sources ADD COLUMN account_id TEXT");
      database.exec("CREATE INDEX IF NOT EXISTS calendar_sources_account_idx ON calendar_sources(account_id)");
    },
  },
  {
    // Semantic memory stage 1. Triggers put a content-free invalidation into the same transaction as
    // every canonical mutation. The queue is deliberately outside backups: a restore enqueues a full
    // rebuild through the restoreGeneration metadata trigger below.
    id: "2026-10-semantic-memory-outbox-v1",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS semantic_index_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX IF NOT EXISTS semantic_index_outbox_workspace_idx
          ON semantic_index_outbox(workspace_id, id);
      `);
      for (const [table, type, workspace] of [
        ["entities", "entity", "COALESCE(json_extract(NEW.payload, '$.workspaceId'), '')"],
        ["context_claims", "claim", "NEW.workspace_id"],
        ["context_subjects", "subject", "NEW.workspace_id"],
        ["context_sources", "source", "NEW.workspace_id"],
        ["context_evidence", "evidence", "NEW.workspace_id"],
      ]) {
        const oldWorkspace = workspace.replaceAll("NEW.", "OLD.");
        for (const [operation, alias, workspaceExpr] of [
          ["insert", "NEW", workspace],
          ["update", "NEW", workspace],
          ["delete", "OLD", oldWorkspace],
        ]) {
          database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_${table}_${operation}
            AFTER ${operation.toUpperCase()} ON ${table}
            BEGIN
              INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
              VALUES ('${type}', ${alias}.id, ${workspaceExpr}, '${operation}');
              ${operation === "update" ? `INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
              SELECT '${type}', OLD.id, ${oldWorkspace}, 'move_from'
              WHERE ${oldWorkspace} != ${workspaceExpr};` : ""}
            END`);
        }
      }
      database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_restore_generation
        AFTER UPDATE OF value ON metadata
        WHEN NEW.key = 'restoreGeneration' AND NEW.value != OLD.value
        BEGIN
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'restore');
        END`);
      database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_first_restore_generation
        AFTER INSERT ON metadata
        WHEN NEW.key = 'restoreGeneration'
        BEGIN
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'restore');
        END`);
      database.exec(`INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
        VALUES ('rebuild', '*', '*', 'migration')`);
    },
  },
  {
    // Upgrade for installations that already applied semantic-memory-outbox-v1 before the
    // first-restore INSERT trigger was added. A new ID is required: applied migrations never rerun.
    id: "2026-10-semantic-memory-first-restore-trigger",
    up(database) {
      database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_first_restore_generation
        AFTER INSERT ON metadata
        WHEN NEW.key = 'restoreGeneration'
        BEGIN
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'restore');
        END`);
    },
  },

  {
    // Follow-up for installations where stage 1 outbox migrations were already applied.
    // The effective sensitivity of a claim also depends on evidence and source records
    // *outside* the claim workspace. Queue its canonical workspace for every such change.
    id: "2026-10-semantic-memory-cross-workspace-invalidation",
    up(database) {
      for (const [operation, alias] of [
        ["insert", "NEW"], ["update", "NEW"], ["delete", "OLD"],
      ]) {
        database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_evidence_claim_${operation}
          AFTER ${operation.toUpperCase()} ON context_evidence
          BEGIN
            INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
            SELECT 'claim', c.id, c.workspace_id, 'evidence_${operation}'
            FROM context_claims c WHERE c.id = ${alias}.claim_id;
            ${operation === "update" ? `INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
            SELECT 'claim', c.id, c.workspace_id, 'evidence_previous'
            FROM context_claims c WHERE c.id = OLD.claim_id AND OLD.claim_id != NEW.claim_id;` : ""}
          END`);
        database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_source_claim_${operation}
          AFTER ${operation.toUpperCase()} ON context_sources
          BEGIN
            INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
            SELECT DISTINCT 'claim', c.id, c.workspace_id, 'source_${operation}'
            FROM context_evidence e JOIN context_claims c ON c.id = e.claim_id
            WHERE e.source_id = ${alias}.id;
            ${operation === "update" ? `INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
            SELECT DISTINCT 'claim', c.id, c.workspace_id, 'source_previous'
            FROM context_evidence e JOIN context_claims c ON c.id = e.claim_id
            WHERE e.source_id = OLD.id AND OLD.id != NEW.id;` : ""}
          END`);
      }
      // No stage-1 worker runs on production. Bound disk growth without dropping
      // invalidation: atomically replace an overflowing queue with a global rebuild
      // marker. Subsequent writes stay queued and a future worker must rebuild all
      // canonical workspaces before acknowledging that marker.
      database.exec(`CREATE TRIGGER IF NOT EXISTS semantic_outbox_bound_queue
        AFTER INSERT ON semantic_index_outbox
        WHEN (SELECT COUNT(*) FROM semantic_index_outbox) > 1000
        BEGIN
          DELETE FROM semantic_index_outbox;
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'queue_compacted');
        END`);
      // Upgrade safety: cap any rows accumulated before this migration.
      const queued = (database.prepare("SELECT COUNT(*) AS count FROM semantic_index_outbox").get() as { count: number }).count;
      if (queued > 1000) {
        database.exec(`DELETE FROM semantic_index_outbox;
          INSERT INTO semantic_index_outbox(object_type, object_id, workspace_id, operation)
          VALUES ('rebuild', '*', '*', 'queue_compacted')`);
      }
    },
  },
  {
    // Mail: owner-scoped encrypted OAuth credentials; no mail content is cached.
    id: "2026-10-mail-gmail-readonly-v1",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          email TEXT NOT NULL,
          encrypted_refresh_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(workspace_id, provider, email)
        );
        CREATE INDEX IF NOT EXISTS mail_accounts_workspace_idx ON mail_accounts(workspace_id, provider);
        CREATE TABLE IF NOT EXISTS mail_oauth_pending (
          state_hash TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_binding TEXT NOT NULL,
          encrypted_verifier TEXT NOT NULL,
          restore_generation INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mail_oauth_pending_expiry_idx ON mail_oauth_pending(expires_at);
      `);
    },
  },
  {
    // A removed or repurposed workspace must not leave a decryptable Gmail refresh
    // token or pending authorization behind. Full-snapshot writes update 'entities'
    // inside the same transaction; delete/update triggers join that transaction.
    id: "2026-10-mail-account-workspace-lifecycle",
    up(database) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS mail_workspace_deleted
        AFTER DELETE ON entities
        WHEN json_extract(OLD.payload, '$.type') = 'workspace'
        BEGIN
          DELETE FROM mail_accounts WHERE workspace_id = json_extract(OLD.payload, '$.workspaceId');
          DELETE FROM mail_oauth_pending WHERE workspace_id = json_extract(OLD.payload, '$.workspaceId');
        END;
        CREATE TRIGGER IF NOT EXISTS mail_workspace_identity_changed
        AFTER UPDATE OF payload ON entities
        WHEN json_extract(OLD.payload, '$.type') = 'workspace'
          AND (json_extract(NEW.payload, '$.type') != 'workspace'
            OR json_extract(NEW.payload, '$.workspaceId') != json_extract(OLD.payload, '$.workspaceId'))
        BEGIN
          DELETE FROM mail_accounts WHERE workspace_id = json_extract(OLD.payload, '$.workspaceId');
          DELETE FROM mail_oauth_pending WHERE workspace_id = json_extract(OLD.payload, '$.workspaceId');
        END;
        DELETE FROM mail_accounts
        WHERE NOT EXISTS (SELECT 1 FROM entities e
          WHERE json_extract(e.payload, '$.type') = 'workspace'
          AND json_extract(e.payload, '$.workspaceId') = mail_accounts.workspace_id);
        DELETE FROM mail_oauth_pending
        WHERE NOT EXISTS (SELECT 1 FROM entities e
          WHERE json_extract(e.payload, '$.type') = 'workspace'
          AND json_extract(e.payload, '$.workspaceId') = mail_oauth_pending.workspace_id);
      `);
    },
  },
  {
    // Keep an OAuth claim visible until token exchange finishes: disconnect can revoke
    // both unclaimed and in-flight authorizations without relying on in-memory locks.
    id: "2026-10-mail-oauth-claim-through-completion",
    up(database) {
      const columns = new Set((database.prepare("PRAGMA table_info(mail_oauth_pending)").all() as Array<{ name: string }>).map((row) => row.name));
      if (!columns.has("claimed_at")) database.exec("ALTER TABLE mail_oauth_pending ADD COLUMN claimed_at INTEGER");
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
    const detail = parseObject(claim.evidence_metadata);
    const carriesContent = Boolean(text(detail?.excerpt) || text(detail?.locator));
    let coverage = typeof source.coverage === "string" && coverageRank[source.coverage] ? source.coverage : null;
    // An excerpt or a location in the evidence proves Lumi had content: never a metadata-only source carrying excerpt evidence.
    if (carriesContent && (coverageRank[coverage ?? ""] ?? 0) < coverageRank.excerpt) coverage = "excerpt";
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
    if (carriesContent) contentSources.add(sourceId);
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
  const converted: string[] = [];
  const sourceExists = database.prepare("SELECT 1 FROM context_sources WHERE id = ?");
  for (const item of evidence) {
    const sourceId = resolved.get(item.sourceId) ?? item.sourceId;
    if (!sourceExists.get(sourceId)) continue;
    insertEvidence.run(item.id, item.workspace, item.claimId, sourceId, item.locator, item.excerpt, item.stance, item.createdAt, item.updatedAt);
    converted.push(item.claimId);
  }
  // The converted claims have their records in line with their JSON (where the column already exists).
  if ((database.prepare("PRAGMA table_info(context_claims)").all() as Array<{ name?: string }>).some((column) => column.name === "legacy_synced_revision")) {
    for (const id of converted) database.prepare("UPDATE context_claims SET legacy_synced_revision = revision WHERE id = ?").run(id);
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
