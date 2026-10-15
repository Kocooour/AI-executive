import { randomUUID } from "node:crypto";
import { ContextCommandError, assertCommandWorkspace, contextIdPattern, requireChanged, runContextCommand, stableStringify, type CommandHooks } from "./context-commands";
import { getDatabase } from "./server-store";

// Sources and evidence as records (README, Context Graph v2). A source says where something came from
// (a message, a document, a meeting, the owner); evidence ties one claim to one source and may carry an
// excerpt or a locator inside it. The server never fills in an author, a date, an external id or a quote:
// what is not supplied stays null, and a missing source stays explicitly missing.
//
// Metadata-only rule: evidence with an excerpt, or with a locator that points into content, needs a source
// whose coverage is "excerpt" or "body". Evidence that cites a source known only by its metadata (or whose
// coverage is unknown) can only reference the source and is reported as metadataOnly.

export type SourceCoverage = "metadata" | "excerpt" | "body";
export type SourceSensitivity = "normal" | "confidential" | "restricted";
export type EvidenceStance = "supports" | "contradicts";
export type ClaimSourceCoverage = "missing" | "metadata_only" | "content";

export class ContextSourceError extends ContextCommandError {}

export interface ContextSource {
  id: string;
  workspaceId: string;
  revision: number;
  account: string | null;
  provider: string | null;
  externalId: string | null;
  locator: string | null;
  author: string | null;
  authorRole: string | null;
  sourceAt: string | null;
  ingestedAt: string | null;
  coverage: SourceCoverage | null;
  sensitivity: SourceSensitivity;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** How many active evidence records cite it (lists only). */
  evidenceCount?: number;
}

export interface ClaimEvidenceItem {
  id: string;
  workspaceId: string;
  claimId: string;
  revision: number;
  sourceId: string;
  locator: string | null;
  excerpt: string | null;
  stance: EvidenceStance | null;
  /** The cited source has no content coverage: this evidence does not support a content claim. */
  metadataOnly: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  source: ContextSource;
}

/** The legacy single-source/single-evidence shape, still accepted on claims and kept in the claim's JSON columns. */
export interface ClaimSourceMetadata {
  provider?: string;
  externalId?: string;
  locator?: string;
  author?: string;
  authorRole?: string;
  sourceAt?: string;
  ingestedAt?: string;
  coverage?: SourceCoverage;
}
export interface ClaimEvidenceMetadata {
  locator?: string;
  excerpt?: string;
  stance?: EvidenceStance;
}

export const evidenceExcerptLimit = 500;
/**
 * How many active evidence records a claim may hold, and so how many its response carries (the newest first). The two
 * are one number on purpose: a claim response, and the history payload built from it, is then always the whole set,
 * which is what Undo/Redo compares and restores.
 */
export const claimEvidenceResponseLimit = 20;
export const claimEvidenceStoredLimit = claimEvidenceResponseLimit;

const sensitivityLevels = new Set<string>(["normal", "confidential", "restricted"]);
const coverageLevels = new Set<string>(["metadata", "excerpt", "body"]);
const idPattern = contextIdPattern;

export const hasContentCoverage = (coverage: string | null | undefined) => coverage === "excerpt" || coverage === "body";

// ---------------------------------------------------------------------------------------------
// Validation

function validIsoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** A calendar date or a full ISO timestamp with a zone; anything else (or a date that does not exist) is refused. */
export function validateSourceTimestamp(value: string, label: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!validIsoDate(value)) throw new ContextSourceError(`${label} is invalid`);
    return;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !validIsoDate(`${match[1]}-${match[2]}-${match[3]}`) || Number.isNaN(Date.parse(value))) {
    throw new ContextSourceError(`${label} is invalid`);
  }
}

const sourceTextLimits = { provider: 80, account: 200, externalId: 240, locator: 2000, author: 200, authorRole: 120, sourceAt: 40, ingestedAt: 40 } as const;

export interface SourceFieldsInput {
  provider?: string | null;
  account?: string | null;
  externalId?: string | null;
  locator?: string | null;
  author?: string | null;
  authorRole?: string | null;
  sourceAt?: string | null;
  ingestedAt?: string | null;
  coverage?: SourceCoverage | null;
  sensitivity?: SourceSensitivity | null;
}

export interface CleanSourceFields {
  provider: string | null; account: string | null; externalId: string | null; locator: string | null; author: string | null;
  authorRole: string | null; sourceAt: string | null; ingestedAt: string | null; coverage: SourceCoverage | null; sensitivity: SourceSensitivity;
}

/** Trims, turns empty values into null and checks limits. Nothing is ever filled in. */
export function cleanSourceFields(input: SourceFieldsInput | null | undefined, options: { sensitivity?: SourceSensitivity; requireCoverage?: boolean } = {}): CleanSourceFields {
  if (!input || typeof input !== "object") throw new ContextSourceError("Source is invalid");
  const out: Record<string, string | null> = {};
  for (const [key, limit] of Object.entries(sourceTextLimits)) {
    const value = (input as Record<string, unknown>)[key];
    if (value == null || value === "") { out[key] = null; continue; }
    if (typeof value !== "string" || value.trim().length > limit) throw new ContextSourceError(`${key} is invalid`);
    out[key] = value.trim() || null;
  }
  for (const key of ["sourceAt", "ingestedAt"] as const) if (out[key]) validateSourceTimestamp(out[key]!, key);
  const coverage = input.coverage == null || (input.coverage as unknown) === "" ? null : input.coverage;
  if (coverage !== null && !coverageLevels.has(coverage)) throw new ContextSourceError("Source coverage is invalid");
  if (coverage === null && options.requireCoverage) throw new ContextSourceError("Source coverage is required", 400, "coverage_required");
  const sensitivity = input.sensitivity ?? options.sensitivity;
  if (!sensitivity || !sensitivityLevels.has(sensitivity)) throw new ContextSourceError("Source sensitivity is required and must be normal, confidential or restricted");
  if (!out.provider && !out.externalId && !out.locator && !out.author) {
    throw new ContextSourceError("A source needs at least a provider, an external ID, a locator or an author");
  }
  return { provider: out.provider, account: out.account, externalId: out.externalId, locator: out.locator, author: out.author,
    authorRole: out.authorRole, sourceAt: out.sourceAt, ingestedAt: out.ingestedAt, coverage: coverage as SourceCoverage | null, sensitivity };
}

export interface CleanEvidenceFields { locator: string | null; excerpt: string | null; stance: EvidenceStance | null }

export function cleanEvidenceFields(input: { locator?: string | null; excerpt?: string | null; stance?: string | null } | null | undefined): CleanEvidenceFields {
  if (!input || typeof input !== "object") throw new ContextSourceError("Evidence is invalid");
  const text = (value: unknown, limit: number, label: string) => {
    if (value == null || value === "") return null;
    if (typeof value !== "string") throw new ContextSourceError(`${label} is invalid`);
    const trimmed = value.trim();
    if (trimmed.length > limit) throw new ContextSourceError(`${label} is too long (at most ${limit} characters)`, 400, "evidence_too_long");
    return trimmed || null;
  };
  const stance = input.stance == null || input.stance === "" ? null : input.stance;
  if (stance !== null && stance !== "supports" && stance !== "contradicts") throw new ContextSourceError("Evidence stance is invalid");
  return { locator: text(input.locator, 1000, "Evidence locator"), excerpt: text(input.excerpt, evidenceExcerptLimit, "Evidence excerpt"), stance: stance as EvidenceStance | null };
}

/** The metadata-only rule. */
export function assertEvidenceFitsSource(source: { coverage: string | null }, evidence: { excerpt: string | null; locator: string | null }) {
  if ((evidence.excerpt || evidence.locator) && !hasContentCoverage(source.coverage)) {
    throw new ContextSourceError(
      "This source is known only by its metadata, so evidence can reference it but cannot carry an excerpt or a location inside it",
      400, "metadata_only_source");
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

type SourceRow = {
  id: string; workspace_id: string; revision: number; account: string | null; provider: string | null; external_id: string | null;
  locator: string | null; author: string | null; author_role: string | null; source_at: string | null; ingested_at: string | null;
  coverage: string | null; sensitivity: string; created_at: number; updated_at: number; archived_at: number | null;
};

/** Anything not recognised fails closed as "restricted". */
function readSourceSensitivity(stored: string): SourceSensitivity {
  return sensitivityLevels.has(stored) ? stored as SourceSensitivity : "restricted";
}

function deserializeSource(row: SourceRow, evidenceCount?: number): ContextSource {
  return { id: row.id, workspaceId: row.workspace_id, revision: Number(row.revision), account: row.account, provider: row.provider,
    externalId: row.external_id, locator: row.locator, author: row.author, authorRole: row.author_role, sourceAt: row.source_at,
    ingestedAt: row.ingested_at, coverage: coverageLevels.has(String(row.coverage)) ? row.coverage as SourceCoverage : null,
    sensitivity: readSourceSensitivity(row.sensitivity), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at), ...(evidenceCount === undefined ? {} : { evidenceCount }) };
}

function sourceRow(id: string, workspaceId: string) {
  return getDatabase().prepare("SELECT * FROM context_sources WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as SourceRow | undefined;
}

export function getContextSource(workspaceId: string, id: string) {
  assertCommandWorkspace(workspaceId);
  if (!idPattern.test(id)) throw new ContextSourceError("Source identifier is invalid");
  const row = sourceRow(id, workspaceId);
  if (!row) throw new ContextSourceError("Source not found", 404, "not_found");
  return readSourceWithCount(row);
}

function readSourceWithCount(row: SourceRow) {
  const count = getDatabase().prepare("SELECT COUNT(*) AS count FROM context_evidence WHERE source_id = ? AND archived_at IS NULL").get(row.id) as { count: number };
  return deserializeSource(row, Number(count.count));
}

export function listContextSources(workspaceId: string, options: { includeArchived?: boolean } = {}) {
  assertCommandWorkspace(workspaceId);
  const rows = getDatabase().prepare(`SELECT s.*, (SELECT COUNT(*) FROM context_evidence e WHERE e.source_id = s.id AND e.archived_at IS NULL) AS evidence_count
    FROM context_sources s WHERE s.workspace_id = ? ${options.includeArchived ? "" : "AND s.archived_at IS NULL"}
    ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 500`).all(workspaceId) as unknown as Array<SourceRow & { evidence_count: number }>;
  return rows.map((row) => deserializeSource(row, Number(row.evidence_count)));
}

type EvidenceRow = {
  id: string; workspace_id: string; revision: number; claim_id: string; source_id: string; locator: string | null; excerpt: string | null;
  stance: string | null; created_at: number; updated_at: number; archived_at: number | null;
  s_id: string; s_revision: number; s_account: string | null; s_provider: string | null; s_external_id: string | null; s_locator: string | null;
  s_author: string | null; s_author_role: string | null; s_source_at: string | null; s_ingested_at: string | null; s_coverage: string | null;
  s_sensitivity: string; s_created_at: number; s_updated_at: number; s_archived_at: number | null;
};

const evidenceSelect = `SELECT e.id, e.workspace_id, e.revision, e.claim_id, e.source_id, e.locator, e.excerpt, e.stance, e.created_at, e.updated_at, e.archived_at,
  s.id AS s_id, s.revision AS s_revision, s.account AS s_account, s.provider AS s_provider, s.external_id AS s_external_id, s.locator AS s_locator,
  s.author AS s_author, s.author_role AS s_author_role, s.source_at AS s_source_at, s.ingested_at AS s_ingested_at, s.coverage AS s_coverage,
  s.sensitivity AS s_sensitivity, s.created_at AS s_created_at, s.updated_at AS s_updated_at, s.archived_at AS s_archived_at
  FROM context_evidence e JOIN context_sources s ON s.id = e.source_id AND s.workspace_id = e.workspace_id`;

function deserializeEvidence(row: EvidenceRow): ClaimEvidenceItem {
  const source = deserializeSource({ id: row.s_id, workspace_id: row.workspace_id, revision: row.s_revision, account: row.s_account,
    provider: row.s_provider, external_id: row.s_external_id, locator: row.s_locator, author: row.s_author, author_role: row.s_author_role,
    source_at: row.s_source_at, ingested_at: row.s_ingested_at, coverage: row.s_coverage, sensitivity: row.s_sensitivity,
    created_at: row.s_created_at, updated_at: row.s_updated_at, archived_at: row.s_archived_at });
  return { id: row.id, workspaceId: row.workspace_id, claimId: row.claim_id, revision: Number(row.revision), sourceId: row.source_id,
    locator: row.locator, excerpt: row.excerpt, stance: row.stance === "supports" || row.stance === "contradicts" ? row.stance : null,
    metadataOnly: !hasContentCoverage(source.coverage), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at), source };
}

export function readEvidence(workspaceId: string, id: string) {
  const row = getDatabase().prepare(`${evidenceSelect} WHERE e.id = ? AND e.workspace_id = ?`).get(id, workspaceId) as EvidenceRow | undefined;
  return row ? deserializeEvidence(row) : null;
}

/** Active evidence of the given claims, newest first per claim. With no ids, every active evidence of the workspace. */
export function activeEvidenceByClaim(workspaceId: string, claimIds?: string[]) {
  const ids = claimIds ?? [];
  const rows = getDatabase().prepare(`${evidenceSelect} WHERE e.workspace_id = ? AND e.archived_at IS NULL
    ${claimIds ? `AND e.claim_id IN (${ids.map(() => "?").join(",") || "NULL"})` : ""}
    ORDER BY e.created_at DESC, e.rowid DESC`).all(workspaceId, ...ids) as unknown as EvidenceRow[];
  const grouped = new Map<string, ClaimEvidenceItem[]>();
  for (const row of rows) {
    const item = deserializeEvidence(row);
    const list = grouped.get(item.claimId);
    if (list) list.push(item); else grouped.set(item.claimId, [item]);
  }
  return grouped;
}

export function claimEvidence(workspaceId: string, claimId: string) {
  return activeEvidenceByClaim(workspaceId, [claimId]).get(claimId) ?? [];
}

/** missing: no evidence; content: some evidence carries an excerpt or a location inside a source with content; else metadata_only. */
export function summarizeCoverage(items: ClaimEvidenceItem[]): ClaimSourceCoverage {
  if (!items.length) return "missing";
  return items.some((item) => !item.metadataOnly && Boolean(item.excerpt || item.locator)) ? "content" : "metadata_only";
}

/** The legacy single-source/single-evidence view of a claim: its newest evidence record. */
export function legacyProjection(items: ClaimEvidenceItem[]): { source: ClaimSourceMetadata | null; evidence: ClaimEvidenceMetadata | null } {
  const primary = items[0];
  if (!primary) return { source: null, evidence: null };
  const pick = <T extends object>(entries: Array<[string, unknown]>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) if (value != null) out[key] = value;
    return Object.keys(out).length ? out as T : null;
  };
  const s = primary.source;
  return {
    source: pick<ClaimSourceMetadata>([["provider", s.provider], ["externalId", s.externalId], ["locator", s.locator], ["author", s.author],
      ["authorRole", s.authorRole], ["sourceAt", s.sourceAt], ["ingestedAt", s.ingestedAt], ["coverage", s.coverage]]),
    evidence: pick<ClaimEvidenceMetadata>([["locator", primary.locator], ["excerpt", primary.excerpt], ["stance", primary.stance]]),
  };
}

/** Writes the legacy JSON columns of a claim from its active evidence, so code from before the records still reads them. */
export function reprojectClaimJson(workspaceId: string, claimId: string) {
  const { source, evidence } = legacyProjection(claimEvidence(workspaceId, claimId));
  getDatabase().prepare("UPDATE context_claims SET source_metadata = ?, evidence_metadata = ? WHERE id = ? AND workspace_id = ?")
    .run(source ? JSON.stringify(source) : null, evidence ? JSON.stringify(evidence) : null, claimId, workspaceId);
}

/** The part of an evidence record that Undo/Redo restores and compares. */
export function evidenceFingerprint(item: Pick<ClaimEvidenceItem, "sourceId" | "locator" | "excerpt" | "stance" | "archivedAt">) {
  return { sourceId: item.sourceId, locator: item.locator ?? null, excerpt: item.excerpt ?? null, stance: item.stance ?? null, archived: item.archivedAt != null };
}

/** The part of a source that Undo/Redo restores and compares. */
export function sourceFingerprint(source: ContextSource) {
  return { account: source.account, provider: source.provider, externalId: source.externalId, locator: source.locator, author: source.author,
    authorRole: source.authorRole, sourceAt: source.sourceAt, ingestedAt: source.ingestedAt, coverage: source.coverage,
    sensitivity: source.sensitivity, archived: source.archivedAt != null };
}

export function sourceLabel(source: Pick<ContextSource, "provider" | "externalId" | "locator" | "author">) {
  return source.provider || source.externalId || source.locator || source.author || "";
}

// ---------------------------------------------------------------------------------------------
// Writing (inside a command transaction)

const strictness: Record<SourceSensitivity, number> = { normal: 0, confidential: 1, restricted: 2 };

/**
 * A change to a source that alters what its evidence rests on (anything but a stricter sensitivity) returns every
 * active claim citing it to "proposed", with a review event, and rewrites those claims' legacy JSON view. Lowering the
 * sensitivity therefore never exposes confirmed evidence to agents until the owner confirms the claims again.
 */
function reviewClaimsCiting(workspaceId: string, sourceId: string, reason: string) {
  const database = getDatabase();
  const claims = database.prepare(`SELECT DISTINCT c.id, c.review_status, c.revision FROM context_claims c JOIN context_evidence e ON e.claim_id = c.id
    WHERE e.source_id = ? AND e.archived_at IS NULL AND c.workspace_id = ? AND c.archived_at IS NULL`).all(sourceId, workspaceId) as
    Array<{ id: string; review_status: string; revision: number }>;
  const now = Date.now();
  for (const claim of claims) {
    // Every citing claim gets a new revision, so a client holding the old one cannot confirm without seeing the change;
    // a review event is written only when the claim was not already in review.
    requireChanged(database.prepare(`UPDATE context_claims SET review_status = 'proposed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND revision = ?`).run(now, claim.id, workspaceId, claim.revision), "Claim changed on another device");
    if (claim.review_status !== "proposed") {
      database.prepare(`INSERT INTO context_review_events (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
        VALUES (?, ?, ?, ?, 'owner', 'proposed', ?, ?)`).run(randomUUID(), workspaceId, claim.id, claim.revision + 1, reason, now);
    }
    reprojectClaimJson(workspaceId, claim.id);
  }
}

/** Whether a change from one source state to another touches what evidence rests on (everything but a stricter sensitivity). */
function changesBasis(before: CleanSourceFields | ContextSource, after: CleanSourceFields | ContextSource) {
  const keys = ["account", "provider", "externalId", "locator", "author", "authorRole", "sourceAt", "ingestedAt", "coverage"] as const;
  return keys.some((key) => (before[key] ?? null) !== (after[key] ?? null)) || strictness[after.sensitivity] < strictness[before.sensitivity];
}

function findDuplicateSource(workspaceId: string, fields: Pick<CleanSourceFields, "provider" | "account" | "externalId">, exceptId?: string) {
  if (!fields.externalId) return null;
  const row = getDatabase().prepare(`SELECT * FROM context_sources WHERE workspace_id = ? AND COALESCE(provider, '') = ? AND COALESCE(account, '') = ?
    AND external_id = ? AND archived_at IS NULL AND id != ?`)
    .get(workspaceId, fields.provider ?? "", fields.account ?? "", fields.externalId, exceptId ?? "") as SourceRow | undefined;
  return row ?? null;
}

function insertSource(workspaceId: string, id: string, fields: CleanSourceFields) {
  const now = Date.now();
  getDatabase().prepare(`INSERT INTO context_sources
    (id, workspace_id, revision, account, provider, external_id, locator, author, author_role, source_at, ingested_at, coverage, sensitivity,
     created_at, updated_at, archived_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, workspaceId, fields.account, fields.provider, fields.externalId, fields.locator, fields.author, fields.authorRole,
      fields.sourceAt, fields.ingestedAt, fields.coverage, fields.sensitivity, now, now);
}

/** Active evidence that carries an excerpt or a location, so the source must keep content coverage. */
function contentEvidenceCount(sourceId: string) {
  const row = getDatabase().prepare(`SELECT COUNT(*) AS count FROM context_evidence WHERE source_id = ? AND archived_at IS NULL
    AND (excerpt IS NOT NULL OR locator IS NOT NULL)`).get(sourceId) as { count: number };
  return Number(row.count);
}

/** Changes a source in place (a revision bump): the caller is a source command, an Undo of one, or a stricter-sensitivity raise. */
function writeSource(workspaceId: string, id: string, fields: CleanSourceFields, archivedAt: number | null, expectedRevision: number) {
  const now = Date.now();
  requireChanged(getDatabase().prepare(`UPDATE context_sources SET account=?, provider=?, external_id=?, locator=?, author=?, author_role=?,
    source_at=?, ingested_at=?, coverage=?, sensitivity=?, archived_at=?, revision=revision+1, updated_at=?
    WHERE id=? AND workspace_id=? AND revision=?`).run(fields.account, fields.provider, fields.externalId, fields.locator, fields.author,
    fields.authorRole, fields.sourceAt, fields.ingestedAt, fields.coverage, fields.sensitivity, archivedAt, now, id, workspaceId, expectedRevision),
    "Source changed on another device");
}

function fieldsOf(source: ContextSource): CleanSourceFields {
  return { provider: source.provider, account: source.account, externalId: source.externalId, locator: source.locator, author: source.author,
    authorRole: source.authorRole, sourceAt: source.sourceAt, ingestedAt: source.ingestedAt, coverage: source.coverage, sensitivity: source.sensitivity };
}

// ---------------------------------------------------------------------------------------------
// Source commands

export interface SourceCommandInput { commandId: string; workspaceId: string; id: string; expectedRevision: number; /** Required when an update lowers the sensitivity. */ reason?: string | null }
export type CreateSourceInput = SourceCommandInput & SourceFieldsInput & { expectedRevision: 0 };
export type UpdateSourceInput = SourceCommandInput & SourceFieldsInput;

type SourceOperation = "create" | "update" | "archive";

function runSourceCommand(operation: SourceOperation, input: SourceCommandInput & SourceFieldsInput, hooks?: CommandHooks) {
  if (!idPattern.test(input.commandId) || !idPattern.test(String(input.id))) throw new ContextSourceError("Invalid command or source identifier");
  assertCommandWorkspace(input.workspaceId);
  const clean = operation === "archive" ? null : cleanSourceFields(input, { requireCoverage: operation === "create" });
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 500) throw new ContextSourceError("The reason is too long", 400, "reason_invalid");
  const request = { commandId: input.commandId, workspaceId: input.workspaceId, id: input.id, expectedRevision: input.expectedRevision, ...(clean ?? {}),
    ...(operation === "update" && reason ? { reason } : {}) };
  return runContextCommand({
    operation: `source.${operation}`, commandId: input.commandId, workspaceId: input.workspaceId, request, hooks,
    mutate: () => {
      const existing = sourceRow(input.id, input.workspaceId);
      const before = existing ? readSourceWithCount(existing) : null;
      let changed = true;
      if (operation === "create") {
        if (Number(input.expectedRevision) !== 0) throw new ContextSourceError("New sources require revision 0", 409, "revision_conflict");
        if (existing || getDatabase().prepare("SELECT 1 FROM context_sources WHERE id = ?").get(input.id)) throw new ContextSourceError("Source ID already exists", 409, "source_exists");
        const duplicate = findDuplicateSource(input.workspaceId, clean!);
        if (duplicate) {
          // The same external item is one source: the existing record is returned. A stricter requested sensitivity
          // raises it (recorded as this command's change event); it is never silently ignored.
          const existingSource = readSourceWithCount(duplicate);
          if (strictness[clean!.sensitivity] > strictness[existingSource.sensitivity]) {
            writeSource(input.workspaceId, existingSource.id, { ...fieldsOf(existingSource), sensitivity: clean!.sensitivity }, null, existingSource.revision);
            const raised = readSourceWithCount(sourceRow(existingSource.id, input.workspaceId)!);
            return { result: { source: raised, deduplicated: true }, objectId: raised.id, operation: "source.update", objectType: "source" as const, changed: true,
              before: { revision: existingSource.revision, payload: existingSource }, after: { revision: raised.revision, payload: raised } };
          }
          return { result: { source: existingSource, deduplicated: true }, objectId: existingSource.id, operation: "source.create", objectType: "source" as const, changed: false,
            before: null, after: { revision: existingSource.revision, payload: existingSource } };
        }
        insertSource(input.workspaceId, input.id, clean!);
      } else {
        if (!before) throw new ContextSourceError("Source not found", 404, "not_found");
        if (before.revision !== Number(input.expectedRevision)) throw new ContextSourceError("Source changed on another device", 409, "revision_conflict");
        if (operation === "archive") {
          if (before.archivedAt) changed = false;
          else if (before.evidenceCount) throw new ContextSourceError("Evidence still cites this source; archive that evidence first", 409, "source_in_use");
          else writeSource(input.workspaceId, input.id, fieldsOf(before), Date.now(), before.revision);
        } else {
          if (before.archivedAt) throw new ContextSourceError("Archived sources cannot be edited", 409, "archived");
          changed = stableStringify(sourceFingerprint({ ...before, ...clean!, archivedAt: null })) !== stableStringify(sourceFingerprint(before));
          if (changed) {
            if (findDuplicateSource(input.workspaceId, clean!, input.id)) throw new ContextSourceError("Another source already has this external ID", 409, "duplicate_source");
            if (!hasContentCoverage(clean!.coverage) && contentEvidenceCount(input.id)) {
              throw new ContextSourceError("Evidence with an excerpt or a location cites this source, so it needs excerpt or body coverage", 409, "coverage_in_use");
            }
            const lowered = strictness[clean!.sensitivity] < strictness[before.sensitivity];
            if (lowered && !reason) throw new ContextSourceError("Lowering a source's sensitivity needs a reason", 400, "reason_required");
            writeSource(input.workspaceId, input.id, clean!, null, before.revision);
            if (changesBasis(before, clean!)) reviewClaimsCiting(input.workspaceId, input.id, lowered ? reason : "source");
          }
        }
      }
      const source = readSourceWithCount(sourceRow(input.id, input.workspaceId)!);
      // A reviewed downgrade keeps its reason in the change event.
      const lowerReason = operation === "update" && changed && before && strictness[source.sensitivity] < strictness[before.sensitivity] ? { reason } : {};
      return { result: { source, deduplicated: false }, objectId: input.id, operation: `source.${operation}`, objectType: "source" as const, changed,
        before: before ? { revision: before.revision, payload: before } : null, after: { revision: source.revision, payload: { ...source, ...lowerReason } } };
    },
  });
}

export const createContextSource = (input: CreateSourceInput, hooks?: CommandHooks) => runSourceCommand("create", input, hooks);
export const updateContextSource = (input: UpdateSourceInput, hooks?: CommandHooks) => runSourceCommand("update", input, hooks);
export const archiveContextSource = (input: SourceCommandInput, hooks?: CommandHooks) => runSourceCommand("archive", input, hooks);

/**
 * Undo/Redo of one source step, as a new revision. `after` is the state the reversed step left the source in
 * (it must still be exactly there), `before` the state the step started from; a step that created the source is
 * reversed by archiving it. Must run inside a context command.
 */
export function compensateSource(input: { workspaceId: string; id: string; before: ContextSource | null; after: ContextSource }) {
  const row = sourceRow(input.id, input.workspaceId);
  if (!row) throw new ContextSourceError("The source no longer exists", 409, "undo_conflict");
  const current = readSourceWithCount(row);
  if (stableStringify(sourceFingerprint(current)) !== stableStringify(sourceFingerprint(input.after))) {
    throw new ContextSourceError("The source was changed after this step", 409, "undo_conflict");
  }
  const target = input.before ?? { ...input.after, archivedAt: input.after.archivedAt ?? Date.now() };
  const fields = fieldsOf(target);
  if (target.archivedAt == null) {
    // The source comes back: it must not collide with another active source of the same external item.
    if (findDuplicateSource(input.workspaceId, fields, input.id)) throw new ContextSourceError("Another source already has this external ID", 409, "duplicate_source");
  } else if (current.evidenceCount) {
    throw new ContextSourceError("Evidence cites this source, so it cannot be archived", 409, "undo_conflict");
  }
  if (!hasContentCoverage(fields.coverage) && contentEvidenceCount(input.id)) {
    throw new ContextSourceError("Evidence with an excerpt or a location cites this source", 409, "undo_conflict");
  }
  writeSource(input.workspaceId, input.id, fields, target.archivedAt == null ? null : (current.archivedAt ?? Date.now()), current.revision);
  if (changesBasis(current, fields)) reviewClaimsCiting(input.workspaceId, input.id, "history");
  return { source: readSourceWithCount(sourceRow(input.id, input.workspaceId)!), before: current };
}

// ---------------------------------------------------------------------------------------------
// Legacy shape: a claim carrying one source and one evidence

const sameJson = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

/**
 * Makes a claim's evidence records match the legacy `source`/`evidence` input: when the newest evidence already
 * reads exactly that, nothing changes; otherwise it is archived and replaced (the source is reused when it is the
 * same external item, or has identical fields; else it is created). A new source is at least as sensitive as the
 * claim. Must run inside a claim command (one transaction). Returns whether any record changed.
 */
export function applyLegacySourceEvidence(input: { workspaceId: string; claimId: string; claimSensitivity: SourceSensitivity;
  source: ClaimSourceMetadata | null; evidence: ClaimEvidenceMetadata | null; /** Add as one more record instead of replacing the newest. */ append?: boolean }) {
  if (!input.source) return false;
  const items = claimEvidence(input.workspaceId, input.claimId);
  const projection = legacyProjection(items);
  if (!input.append && sameJson(projection.source, input.source) && sameJson(projection.evidence, input.evidence)) return false;
  const evidence = cleanEvidenceFields(input.evidence ?? {});
  const fields = cleanSourceFields({ ...input.source }, { sensitivity: input.claimSensitivity });
  assertEvidenceFitsSource(fields, evidence);
  // Replacing the newest evidence is net zero; only an addition can exceed the limit.
  if (items.length - (!input.append && items[0] ? 1 : 0) >= claimEvidenceStoredLimit) throw new ContextSourceError("This claim already has the most evidence it can hold", 409, "evidence_limit");
  const database = getDatabase();
  const now = Date.now();
  const primary = input.append ? undefined : items[0];
  if (primary) {
    database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, now, primary.id, input.workspaceId);
  }
  let sourceId: string | null = null;
  if (primary && sameJson(legacyProjection([primary]).source, input.source)) sourceId = primary.sourceId;
  if (!sourceId) {
    const duplicate = findDuplicateSource(input.workspaceId, fields);
    if (duplicate) {
      sourceId = duplicate.id;
      // A source shared with a stricter claim only ever gets stricter; coverage is the weaker of the two.
      const current = deserializeSource(duplicate);
      const sensitivity = strictness[fields.sensitivity] > strictness[current.sensitivity] ? fields.sensitivity : current.sensitivity;
      if (sensitivity !== current.sensitivity) writeSource(input.workspaceId, duplicate.id, { ...fieldsOf(current), sensitivity }, null, current.revision);
      if (evidence.excerpt || evidence.locator) assertEvidenceFitsSource(current, evidence);
    }
  }
  if (!sourceId) {
    sourceId = `src:${randomUUID()}`;
    insertSource(input.workspaceId, sourceId, fields);
  }
  database.prepare(`INSERT INTO context_evidence (id, workspace_id, revision, claim_id, source_id, locator, excerpt, stance, created_at, updated_at, archived_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(`ev:${randomUUID()}`, input.workspaceId, input.claimId, sourceId, evidence.locator, evidence.excerpt, evidence.stance, now, now);
  return true;
}

/**
 * Brings a claim's active evidence to the recorded set (Undo/Redo of a claim step). Evidence not in the set
 * is archived, evidence in it is restored with its recorded fields. Sources are only referenced: each must be
 * live in the workspace, or the whole step is a conflict.
 */
export function restoreClaimEvidence(input: { workspaceId: string; claimId: string; target: Array<Pick<ClaimEvidenceItem, "id" | "sourceId" | "locator" | "excerpt" | "stance">> }) {
  const database = getDatabase();
  const now = Date.now();
  const wanted = new Map(input.target.map((item) => [item.id, item]));
  const rows = database.prepare("SELECT id, archived_at, source_id, locator, excerpt, stance FROM context_evidence WHERE workspace_id = ? AND claim_id = ?").all(input.workspaceId, input.claimId) as
    Array<{ id: string; archived_at: number | null; source_id: string; locator: string | null; excerpt: string | null; stance: string | null }>;
  const known = new Set(rows.map((row) => row.id));
  for (const item of input.target) {
    if (!known.has(item.id)) throw new ContextSourceError("Evidence of this step no longer exists", 409, "undo_conflict");
    const source = sourceRow(item.sourceId, input.workspaceId);
    if (!source || source.archived_at != null) throw new ContextSourceError("A source of this step is archived or gone", 409, "undo_conflict");
    if ((item.excerpt || item.locator) && !hasContentCoverage(source.coverage)) {
      throw new ContextSourceError("A source of this step no longer has content coverage", 409, "undo_conflict");
    }
  }
  for (const row of rows) {
    const item = wanted.get(row.id);
    if (!item) {
      if (row.archived_at == null) database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(now, now, row.id);
      continue;
    }
    // Evidence whose content is already as recorded keeps its revision.
    if (row.archived_at == null && row.source_id === item.sourceId && row.locator === item.locator && row.excerpt === item.excerpt && row.stance === item.stance) continue;
    database.prepare(`UPDATE context_evidence SET source_id=?, locator=?, excerpt=?, stance=?, archived_at=NULL, revision=revision+1, updated_at=? WHERE id=?`)
      .run(item.sourceId, item.locator, item.excerpt, item.stance, now, row.id);
  }
}

/** The evidence part of a claim fingerprint: the records when the payload has them, else the legacy projection. */
export function evidenceSetFingerprint(items: Array<Pick<ClaimEvidenceItem, "id" | "sourceId" | "locator" | "excerpt" | "stance">>) {
  return items.map((item) => ({ id: item.id, sourceId: item.sourceId, locator: item.locator ?? null, excerpt: item.excerpt ?? null, stance: item.stance ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Rebuild from the legacy JSON (start-up reconciliation of an edit made by an older binary)

const coverageRank: Record<string, number> = { metadata: 1, excerpt: 2, body: 3 };
const rankOf = (coverage: string | null | undefined) => coverageRank[coverage ?? ""] ?? 0;

/**
 * Rebuilds a claim's evidence from its legacy JSON source/evidence: its active evidence is archived, the source is resolved
 * (the one it already cites when the fields match, else the one with the same external item, else a new one) and the evidence
 * is created from the JSON. The JSON is the whole truth about coverage: absent means unknown. Coverage is raised to what the
 * rebuilt evidence needs (an excerpt or a location implies at least `excerpt`) before the evidence is validated; it is lowered
 * only on a source that no other claim cites. Sensitivity only gets stricter. Must run inside a command (one transaction).
 */
export function rebuildClaimEvidenceFromLegacy(input: { workspaceId: string; claimId: string; claimSensitivity: SourceSensitivity;
  source: ClaimSourceMetadata | null; evidence: ClaimEvidenceMetadata | null }) {
  const database = getDatabase();
  const now = Date.now();
  const items = claimEvidence(input.workspaceId, input.claimId);
  const oldPrimary = items[0];
  database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND claim_id = ? AND archived_at IS NULL")
    .run(now, now, input.workspaceId, input.claimId);
  if (!input.source) return;
  const evidence = cleanEvidenceFields(input.evidence ?? {});
  const fields = cleanSourceFields({ ...input.source }, { sensitivity: input.claimSensitivity });
  const needsContent = Boolean(evidence.excerpt || evidence.locator);
  let wanted: SourceCoverage | null = fields.coverage;
  if (needsContent && rankOf(wanted) < rankOf("excerpt")) wanted = "excerpt";
  const withoutCoverage = (value: ClaimSourceMetadata | null) => { if (!value) return null; const { coverage: _c, ...rest } = value; return rest; };
  let target: ContextSource | null = null;
  const duplicate = findDuplicateSource(input.workspaceId, fields);
  if (duplicate) target = deserializeSource(duplicate);
  else if (oldPrimary && !oldPrimary.source.archivedAt && sameJson(withoutCoverage(legacyProjection([oldPrimary]).source), withoutCoverage(input.source))) target = oldPrimary.source;
  let sourceId: string;
  if (target) {
    sourceId = target.id;
    const cited = Boolean(database.prepare("SELECT 1 FROM context_evidence WHERE workspace_id = ? AND source_id = ? AND archived_at IS NULL LIMIT 1").get(input.workspaceId, target.id));
    const sensitivity = strictness[fields.sensitivity] > strictness[target.sensitivity] ? fields.sensitivity : target.sensitivity;
    const coverage = rankOf(wanted) > rankOf(target.coverage) || (rankOf(wanted) < rankOf(target.coverage) && !cited) ? wanted : target.coverage;
    if (sensitivity !== target.sensitivity || coverage !== target.coverage) {
      const current = deserializeSource(sourceRow(target.id, input.workspaceId)!);
      writeSource(input.workspaceId, target.id, { ...fieldsOf(current), sensitivity, coverage }, null, current.revision);
      if (coverage !== target.coverage) reviewClaimsCiting(input.workspaceId, target.id, "legacy-reconcile");
    }
  } else {
    sourceId = `src:${randomUUID()}`;
    insertSource(input.workspaceId, sourceId, { ...fields, coverage: wanted });
  }
  const live = sourceRow(sourceId, input.workspaceId)!;
  assertEvidenceFitsSource({ coverage: live.coverage }, evidence);
  database.prepare(`INSERT INTO context_evidence (id, workspace_id, revision, claim_id, source_id, locator, excerpt, stance, created_at, updated_at, archived_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(`ev:${randomUUID()}`, input.workspaceId, input.claimId, sourceId, evidence.locator, evidence.excerpt, evidence.stance, now, now);
}
