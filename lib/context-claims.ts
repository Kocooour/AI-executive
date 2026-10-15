import { randomUUID } from "node:crypto";
import { assertCommandWorkspace, contextIdPattern, ContextCommandError, requireChanged, runContextCommand, stableStringify, type CommandHooks } from "./context-commands";
import { getNotificationPreferences } from "./notifications";
import { getDatabase, readSnapshot } from "./server-store";
import { getStandaloneSubject } from "./context-subjects";
import {
  activeEvidenceByClaim, applyLegacySourceEvidence, claimEvidence, claimEvidenceResponseLimit, evidenceSetFingerprint, legacyProjection,
  reprojectClaimJson, restoreClaimEvidence, summarizeCoverage, validateSourceTimestamp,
  type ClaimEvidenceItem, type ClaimEvidenceMetadata, type ClaimSourceCoverage, type ClaimSourceMetadata,
} from "./context-sources";
import { checkRelation, relationStatusOf, type RelationStatus } from "./context-relations";

export type { ClaimEvidenceMetadata, ClaimSourceMetadata } from "./context-sources";

export type ClaimReviewStatus = "proposed" | "confirmed" | "rejected";
export type ClaimFreshness = "current" | "needs_review" | "stale";
// Three levels (README, Context Graph v2). Only "normal" may reach agents, external tools or AI
// providers; "confidential" and "restricted" never do by default. The two-level "sensitive" of
// earlier clients is still accepted as input and stored as "confidential".
export type ClaimSensitivity = "normal" | "confidential" | "restricted";
export type ClaimSensitivityInput = ClaimSensitivity | "sensitive";
export type ClaimLiteralType = "string" | "number" | "boolean" | "date";

export interface ClaimSubjectRef {
  id: string;
  type: string;
  canonicalEntityId: string | null;
  title: string;
  revision?: number;
  archivedAt?: number | null;
}

export interface ContextClaim {
  id: string;
  workspaceId: string;
  subject: ClaimSubjectRef;
  predicate: string;
  literal: { type: ClaimLiteralType; value: string | number | boolean } | null;
  target: ClaimSubjectRef | null;
  reviewStatus: ClaimReviewStatus;
  freshness: ClaimFreshness;
  sensitivity: ClaimSensitivityInput;
  provenance: "owner";
  validFrom: string | null;
  validTo: string | null;
  /** The newest evidence's source and the evidence itself, in the shape claims had before the records; kept for older clients. */
  source: ClaimSourceMetadata | null;
  evidence: ClaimEvidenceMetadata | null;
  /** Active evidence records with their source, newest first, capped. */
  evidenceItems: ClaimEvidenceItem[];
  /** How many active evidence records the claim has (the list above is capped). */
  evidenceCount: number;
  sourceCoverage: ClaimSourceCoverage;
  /** Relationship claims only: whether the predicate and the endpoint types are in the relation registry. */
  relationStatus: RelationStatus | null;
  revision: number;
  archivedAt: number | null;
  recordedAt: number;
  updatedAt: number;
}

export class ContextClaimError extends ContextCommandError {}

type CanonicalRefInput = { entityId?: string; subjectId?: string };

type ClaimValueInput = {
  literal?: { type: ClaimLiteralType; value: string | number | boolean };
  target?: CanonicalRefInput;
};

export type CreateClaimInput = ClaimValueInput & {
  commandId: string;
  workspaceId: string;
  id: string;
  expectedRevision: 0;
  subject: CanonicalRefInput;
  predicate: string;
  freshness: ClaimFreshness;
  sensitivity: ClaimSensitivityInput;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ClaimSourceMetadata | null;
  evidence?: ClaimEvidenceMetadata | null;
};

export type UpdateClaimInput = ClaimValueInput & {
  commandId: string;
  workspaceId: string;
  id: string;
  expectedRevision: number;
  predicate: string;
  freshness: ClaimFreshness;
  sensitivity: ClaimSensitivityInput;
  validFrom?: string | null;
  validTo?: string | null;
  source?: ClaimSourceMetadata | null;
  evidence?: ClaimEvidenceMetadata | null;
};

export interface ReviewClaimInput {
  commandId: string;
  workspaceId: string;
  id: string;
  expectedRevision: number;
  decision: ClaimReviewStatus;
  reason?: string;
}

export interface ArchiveClaimInput {
  commandId: string;
  workspaceId: string;
  id: string;
  expectedRevision: number;
}

const idPattern = contextIdPattern;
const predicatePattern = /^[a-z][a-z0-9_.-]{0,119}$/;
const allowedCanonicalTypes = new Set(["workspace", "area", "project", "task", "note"]);
const reviewStatuses = new Set<ClaimReviewStatus>(["proposed", "confirmed", "rejected"]);
const freshnessStates = new Set<ClaimFreshness>(["current", "needs_review", "stale"]);
const sensitivities = new Set<string>(["normal", "confidential", "restricted"]);
const literalTypes = new Set<ClaimLiteralType>(["string", "number", "boolean", "date"]);

const stable = stableStringify;
const assertWorkspace = assertCommandWorkspace;

/** Maps request input to the stored vocabulary; unknown values pass through and fail validation. */
function normalizeSensitivityInput<T extends { sensitivity: unknown }>(input: T): T {
  return input.sensitivity === "sensitive" ? { ...input, sensitivity: "confidential" } : input;
}

/** Maps a stored value to the vocabulary. Anything unknown fails closed as "restricted". */
function readSensitivity(stored: string): { sensitivity: ClaimSensitivity; unknown: boolean } {
  if (sensitivities.has(stored)) return { sensitivity: stored as ClaimSensitivity, unknown: false };
  if (stored === "sensitive") return { sensitivity: "confidential", unknown: false };
  return { sensitivity: "restricted", unknown: true };
}

function canonicalSubject(workspaceId: string, input: CanonicalRefInput): ClaimSubjectRef {
  if (!input || Boolean(input.entityId) === Boolean(input.subjectId)) throw new ContextClaimError("Subject reference is invalid");
  if (input.subjectId) {
    if (!idPattern.test(input.subjectId)) throw new ContextClaimError("Subject reference is invalid");
    try {
      const subject = getStandaloneSubject(workspaceId, input.subjectId);
      if (subject.archivedAt) throw new ContextClaimError("Archived people or organizations cannot receive new claims", 409, "archived_subject");
      return { id: subject.id, type: subject.type, canonicalEntityId: null, title: subject.title,
        revision: subject.revision, archivedAt: subject.archivedAt };
    } catch (error) {
      if (error instanceof ContextClaimError) throw error;
      throw new ContextClaimError("Subject must exist in the same workspace", 400, "invalid_subject");
    }
  }
  if (!idPattern.test(String(input.entityId || ""))) throw new ContextClaimError("Subject reference is invalid");
  const entity = readSnapshot().entities.find((candidate) => candidate.id === input.entityId);
  if (!entity || entity.workspaceId !== workspaceId || !allowedCanonicalTypes.has(entity.type)) {
    throw new ContextClaimError("Subject must reference an entity in the same workspace", 400, "invalid_subject");
  }
  return { id: `canonical:${entity.id}`, type: entity.type, canonicalEntityId: entity.id, title: entity.title };
}

function validateDate(value: string | null | undefined, label: string) {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ContextClaimError(`${label} is invalid`);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ContextClaimError(`${label} is invalid`);
  }
  return value;
}

function cleanMetadata<T extends Record<string, unknown>>(value: T | null | undefined, limits: Record<string, number>): T | null {
  if (!value) return null;
  const output: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(limits)) {
    const item = value[key];
    if (item == null || item === "") continue;
    if (typeof item !== "string" || item.length > limit) throw new ContextClaimError(`${key} is invalid`);
    output[key] = item;
  }
  return Object.keys(output).length ? output as T : null;
}

function cleanSource(value: ClaimSourceMetadata | null | undefined) {
  const source = cleanMetadata(value as Record<string, unknown> | null | undefined, {
    provider: 80, externalId: 240, locator: 2000, author: 200, authorRole: 120,
    sourceAt: 40, ingestedAt: 40, coverage: 20,
  }) as ClaimSourceMetadata | null;
  if (source?.coverage && !new Set(["metadata", "excerpt", "body"]).has(source.coverage)) {
    throw new ContextClaimError("Source coverage is invalid");
  }
  for (const key of ["sourceAt", "ingestedAt"] as const) {
    if (source?.[key]) validateSourceTimestamp(source[key]!, key);
  }
  return source;
}

function cleanEvidence(value: ClaimEvidenceMetadata | null | undefined, source: ClaimSourceMetadata | null) {
  const evidence = cleanMetadata(value as Record<string, unknown> | null | undefined, {
    locator: 1000, excerpt: 500, stance: 20,
  }) as ClaimEvidenceMetadata | null;
  if (evidence && !source) throw new ContextClaimError("Evidence requires source metadata");
  if (evidence?.stance && !new Set(["supports", "contradicts"]).has(evidence.stance)) {
    throw new ContextClaimError("Evidence stance is invalid");
  }
  return evidence;
}

function cleanLiteral(value: { type: ClaimLiteralType; value: string | number | boolean } | undefined) {
  if (!value || !literalTypes.has(value.type)) return null;
  if (value.type === "string" && (typeof value.value !== "string" || !value.value.trim() || value.value.length > 10000)) {
    throw new ContextClaimError("Claim value is invalid");
  }
  if (value.type === "number" && (typeof value.value !== "number" || !Number.isFinite(value.value))) {
    throw new ContextClaimError("Claim number is invalid");
  }
  if (value.type === "boolean" && typeof value.value !== "boolean") throw new ContextClaimError("Claim boolean is invalid");
  if (value.type === "date") {
    if (typeof value.value !== "string") throw new ContextClaimError("Claim date is invalid");
    validateDate(value.value, "Claim date");
  }
  return { type: value.type, value: typeof value.value === "string" ? value.value.trim() : value.value };
}

function ensureSubject(workspaceId: string, subject: ClaimSubjectRef) {
  const database = getDatabase();
  const existing = database.prepare(`SELECT workspace_id, subject_type, canonical_entity_id
    FROM context_subjects WHERE id = ?`).get(subject.id) as
    { workspace_id: string; subject_type: string; canonical_entity_id: string | null } | undefined;
  if (existing) {
    if (existing.workspace_id !== workspaceId || existing.subject_type !== subject.type ||
      existing.canonical_entity_id !== subject.canonicalEntityId) {
      throw new ContextClaimError("Subject identifier conflicts with another context item", 409, "subject_identity_conflict");
    }
    return;
  }
  database.prepare(`INSERT INTO context_subjects
    (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
      subject.id, workspaceId,
      subject.type, subject.canonicalEntityId, subject.title, Date.now(), Date.now(),
    );
}

type ClaimRow = {
  id: string; workspace_id: string; subject_id: string; predicate: string; literal_type: string | null;
  literal_value: string | null; target_subject_id: string | null; review_status: string; freshness: string;
  sensitivity: string; provenance: string; valid_from: string | null; valid_to: string | null;
  source_metadata: string | null; evidence_metadata: string | null; revision: number; archived_at: number | null;
  recorded_at: number; updated_at: number;
};

function readSubject(id: string): ClaimSubjectRef {
  const row = getDatabase().prepare(`SELECT id, subject_type, canonical_entity_id, display_title, revision, archived_at
    FROM context_subjects WHERE id = ?`).get(id) as {
      id: string; subject_type: string; canonical_entity_id: string | null; display_title: string;
      revision: number; archived_at: number | null;
    } | undefined;
  if (!row) throw new ContextClaimError("Claim subject is missing", 500, "missing_subject");
  const canonical = readSnapshot().entities.find((entity) => entity.id === row.canonical_entity_id);
  return { id: row.id, type: row.subject_type, canonicalEntityId: row.canonical_entity_id, title: canonical?.title || row.display_title,
    revision: Number(row.revision), archivedAt: row.archived_at == null ? null : Number(row.archived_at) };
}

function deserialize(row: ClaimRow, preloaded?: ClaimEvidenceItem[]): ContextClaim {
  const level = readSensitivity(row.sensitivity);
  const evidenceAll = preloaded ?? claimEvidence(row.workspace_id, row.id);
  const projection = legacyProjection(evidenceAll);
  const subject = readSubject(row.subject_id);
  const target = row.target_subject_id ? readSubject(row.target_subject_id) : null;
  // A relationship outside the registry is not rewritten; it reads as needing review (and so is never eligible).
  const relationStatus = target ? relationStatusOf(row.predicate, subject.type, target.type) : null;
  const unregistered = relationStatus != null && relationStatus !== "registered";
  const literal = row.literal_type ? {
    type: row.literal_type as ClaimLiteralType,
    value: JSON.parse(String(row.literal_value)),
  } : null;
  return {
    id: row.id, workspaceId: row.workspace_id, subject, predicate: row.predicate,
    literal, target,
    reviewStatus: row.review_status as ClaimReviewStatus, freshness: level.unknown || unregistered ? "needs_review" : row.freshness as ClaimFreshness,
    sensitivity: level.sensitivity, provenance: "owner",
    validFrom: row.valid_from, validTo: row.valid_to,
    source: projection.source, evidence: projection.evidence,
    evidenceItems: evidenceAll.slice(0, claimEvidenceResponseLimit), evidenceCount: evidenceAll.length,
    sourceCoverage: summarizeCoverage(evidenceAll), relationStatus,
    revision: Number(row.revision), archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    recordedAt: Number(row.recorded_at), updatedAt: Number(row.updated_at),
  };
}

function rowForClaim(id: string, workspaceId: string) {
  return getDatabase().prepare("SELECT * FROM context_claims WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as ClaimRow | undefined;
}

type ClaimMutation = { claim: ContextClaim; before: ContextClaim | null; changed: boolean };

/** What the client asked for, with absent and empty optional fields written one way, so a retry hashes equal. */
function requestOf<T extends object>(input: T): object {
  const value = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...value };
  if ("predicate" in out) {
    for (const key of ["validFrom", "validTo"]) out[key] = out[key] || null;
    for (const key of ["source", "evidence", "literal", "target"]) out[key] = out[key] ?? null;
  }
  if ("decision" in out) out.reason = typeof out.reason === "string" ? out.reason.trim() || null : null;
  return out;
}

/** Server-generated values (such as an ingestion time) must not be part of the request that is hashed. */
export interface ClaimCommandMeta { clientRequest?: object }

function claimCommand(operation: string, input: { commandId: string; workspaceId: string }, hooks: CommandHooks | undefined,
  mutate: () => ClaimMutation, meta?: ClaimCommandMeta) {
  return runContextCommand({
    operation, commandId: input.commandId, workspaceId: input.workspaceId, request: requestOf(meta?.clientRequest ?? input), hooks,
    mutate: () => {
      const { claim, before, changed } = mutate();
      return { result: { claim }, objectId: claim.id, operation, changed,
        before: before ? { revision: before.revision, payload: before } : null,
        after: { revision: claim.revision, payload: claim } };
    },
  });
}

/** On an update the subject is the claim's own, which the request does not repeat. */
function subjectOfExistingClaim(input: UpdateClaimInput) {
  const row = rowForClaim(input.id, input.workspaceId);
  if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
  return readSubject(row.subject_id);
}

function validateCommon(input: CreateClaimInput | UpdateClaimInput, subject?: ClaimSubjectRef) {
  if (!idPattern.test(input.id)) throw new ContextClaimError("Claim identifier is invalid");
  if (!predicatePattern.test(input.predicate)) throw new ContextClaimError("Predicate is invalid");
  if (!freshnessStates.has(input.freshness) || !sensitivities.has(input.sensitivity)) {
    throw new ContextClaimError("Claim state is invalid");
  }
  const literal = cleanLiteral(input.literal);
  const target = input.target ? canonicalSubject(input.workspaceId, input.target) : null;
  if (Boolean(literal) === Boolean(target)) throw new ContextClaimError("Claim requires exactly one literal or target");
  if (target) {
    // A relationship claim must be a registered relation between allowed endpoint types; literal claims keep free predicates.
    const subjectType = (subject ?? subjectOfExistingClaim(input as UpdateClaimInput)).type;
    const check = checkRelation(input.predicate, subjectType, target.type);
    if (!check.ok) {
      throw new ContextClaimError(check.reason === "unregistered_predicate"
        ? `"${input.predicate}" is not a known relation. Choose one from the relation registry.`
        : `The relation "${input.predicate}" does not link a ${subjectType} to a ${target.type}`, 400, "invalid_relation");
    }
  }
  const source = cleanSource(input.source);
  const evidence = cleanEvidence(input.evidence, source);
  const validFrom = validateDate(input.validFrom, "validFrom");
  const validTo = validateDate(input.validTo, "validTo");
  if (validFrom && validTo && Date.parse(validFrom) > Date.parse(validTo)) throw new ContextClaimError("Validity interval is invalid");
  return { subject, literal, target, source, evidence, validFrom, validTo };
}

export function createOwnerClaim(raw: CreateClaimInput, hooks?: CommandHooks, meta?: ClaimCommandMeta) {
  const input = normalizeSensitivityInput(raw);
  return claimCommand("create", input, hooks, () => {
    const subject = canonicalSubject(input.workspaceId, input.subject);
    const clean = validateCommon(input, subject);
    if (Number(input.expectedRevision) !== 0) throw new ContextClaimError("New claims require revision 0", 409, "revision_conflict");
    if (rowForClaim(input.id, input.workspaceId)) throw new ContextClaimError("Claim already exists", 409, "claim_exists");
    ensureSubject(input.workspaceId, subject);
    if (clean.target) ensureSubject(input.workspaceId, clean.target);
    const now = Date.now();
    getDatabase().prepare(`INSERT INTO context_claims
      (id, workspace_id, subject_id, predicate, literal_type, literal_value, target_subject_id,
       review_status, freshness, sensitivity, provenance, valid_from, valid_to, source_metadata,
       evidence_metadata, revision, archived_at, recorded_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, 'owner', ?, ?, ?, ?, 1, NULL, ?, ?)`)
      .run(input.id, input.workspaceId, subject.id, input.predicate, clean.literal?.type || null,
        clean.literal ? JSON.stringify(clean.literal.value) : null, clean.target?.id || null, input.freshness,
        input.sensitivity, clean.validFrom, clean.validTo, null, null, now, now);
    // The legacy source/evidence input becomes records (and the JSON columns are written back from them).
    if (applyLegacySourceEvidence({ workspaceId: input.workspaceId, claimId: input.id, claimSensitivity: input.sensitivity as ClaimSensitivity,
      source: clean.source, evidence: clean.evidence })) reprojectClaimJson(input.workspaceId, input.id);
    return { claim: deserialize(rowForClaim(input.id, input.workspaceId)!), before: null, changed: true };
  }, meta);
}

export function updateOwnerClaim(raw: UpdateClaimInput, hooks?: CommandHooks) {
  const input = normalizeSensitivityInput(raw);
  return claimCommand("update", input, hooks, () => {
    const clean = validateCommon(input);
    const row = rowForClaim(input.id, input.workspaceId);
    if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
    const before = deserialize(row);
    canonicalSubject(input.workspaceId, before.subject.canonicalEntityId
      ? { entityId: before.subject.canonicalEntityId } : { subjectId: before.subject.id });
    if (before.revision !== input.expectedRevision) throw new ContextClaimError("Claim changed on another device", 409, "revision_conflict");
    if (before.archivedAt) throw new ContextClaimError("Archived claims cannot be edited", 409, "archived");
    if (clean.target) ensureSubject(input.workspaceId, clean.target);
    const comparable = { predicate: input.predicate, literal: clean.literal, targetId: clean.target?.id || null,
      freshness: input.freshness, sensitivity: input.sensitivity, validFrom: clean.validFrom, validTo: clean.validTo };
    const existing = { predicate: before.predicate, literal: before.literal, targetId: before.target?.id || null,
      freshness: before.freshness, sensitivity: before.sensitivity, validFrom: before.validFrom, validTo: before.validTo };
    // A legacy `source` in the request sets the claim's newest evidence; an absent or null one leaves the records alone
    // (evidence is removed by archiving it). Changing the records changes the claim's support, so it is an edit too.
    const evidenceChanged = applyLegacySourceEvidence({ workspaceId: input.workspaceId, claimId: input.id,
      claimSensitivity: input.sensitivity as ClaimSensitivity, source: clean.source, evidence: clean.evidence });
    // A stored level nobody recognises is repaired by any save with a valid level, even an identical one.
    const unrecognisedLevel = !sensitivities.has(row.sensitivity);
    if (!unrecognisedLevel && !evidenceChanged && stable(comparable) === stable(existing)) return { claim: before, before, changed: false };
    const now = Date.now();
    requireChanged(getDatabase().prepare(`UPDATE context_claims SET predicate=?, literal_type=?, literal_value=?, target_subject_id=?,
      freshness=?, sensitivity=?, valid_from=?, valid_to=?, revision=revision+1,
      review_status='proposed', updated_at=? WHERE id=? AND workspace_id=? AND revision=?`)
      .run(input.predicate, clean.literal?.type || null, clean.literal ? JSON.stringify(clean.literal.value) : null,
        clean.target?.id || null, input.freshness, input.sensitivity, clean.validFrom, clean.validTo,
        now, input.id, input.workspaceId, input.expectedRevision), "Claim changed on another device");
    if (evidenceChanged) reprojectClaimJson(input.workspaceId, input.id);
    return { claim: deserialize(rowForClaim(input.id, input.workspaceId)!), before, changed: true };
  });
}

// Every transition among proposed, confirmed and rejected is allowed and leaves a review event,
// including the way back to "proposed". Editing a claim also returns it to "proposed".
export function reviewOwnerClaim(input: ReviewClaimInput, hooks?: CommandHooks) {
  if (!reviewStatuses.has(input.decision)) throw new ContextClaimError("Review decision is invalid");
  if (input.reason && input.reason.length > 1000) throw new ContextClaimError("Review reason is too long");
  return claimCommand("review", input, hooks, () => {
    const row = rowForClaim(input.id, input.workspaceId);
    if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
    const before = deserialize(row);
    if (before.revision !== input.expectedRevision) throw new ContextClaimError("Claim changed on another device", 409, "revision_conflict");
    if (before.archivedAt) throw new ContextClaimError("Archived claims cannot be reviewed", 409, "archived");
    if (before.reviewStatus === input.decision) return { claim: before, before, changed: false };
    const now = Date.now();
    requireChanged(getDatabase().prepare(`UPDATE context_claims SET review_status=?, revision=revision+1, updated_at=?
      WHERE id=? AND workspace_id=? AND revision=?`).run(input.decision, now, input.id, input.workspaceId, input.expectedRevision),
      "Claim changed on another device");
    const after = deserialize(rowForClaim(input.id, input.workspaceId)!);
    getDatabase().prepare(`INSERT INTO context_review_events
      (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`)
      .run(randomUUID(), input.workspaceId, input.id, after.revision, input.decision, input.reason?.trim() || null, now);
    return { claim: after, before, changed: true };
  });
}

export function archiveOwnerClaim(input: ArchiveClaimInput, hooks?: CommandHooks) {
  return claimCommand("archive", input, hooks, () => {
    const row = rowForClaim(input.id, input.workspaceId);
    if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
    const before = deserialize(row);
    if (before.revision !== input.expectedRevision) throw new ContextClaimError("Claim changed on another device", 409, "revision_conflict");
    if (before.archivedAt) return { claim: before, before, changed: false };
    const now = Date.now();
    requireChanged(getDatabase().prepare(`UPDATE context_claims SET archived_at=?, revision=revision+1, updated_at=?
      WHERE id=? AND workspace_id=? AND revision=?`).run(now, now, input.id, input.workspaceId, input.expectedRevision),
      "Claim changed on another device");
    return { claim: deserialize(rowForClaim(input.id, input.workspaceId)!), before, changed: true };
  });
}

export function listClaimReviewEvents(workspaceId: string, claimId: string) {
  assertWorkspace(workspaceId);
  if (!idPattern.test(claimId)) throw new ContextClaimError("Claim identifier is invalid");
  return getDatabase().prepare(`SELECT claim_revision AS claimRevision, decision, reason, created_at AS createdAt
    FROM context_review_events WHERE workspace_id = ? AND claim_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`)
    .all(workspaceId, claimId);
}

export function listOwnerClaims(workspaceId: string, options: { includeArchived?: boolean; projectId?: string } = {}) {
  assertWorkspace(workspaceId);
  if (options.projectId && canonicalSubject(workspaceId, { entityId: options.projectId }).type !== "project") {
    throw new ContextClaimError("Project filter is invalid");
  }
  const rows = getDatabase().prepare(`SELECT * FROM context_claims WHERE workspace_id = ?
    ${options.includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY updated_at DESC LIMIT 500`)
    .all(workspaceId) as unknown as ClaimRow[];
  const evidence = activeEvidenceByClaim(workspaceId);
  return rows.map((row) => deserialize(row, evidence.get(row.id) ?? [])).filter((claim) => !options.projectId ||
    claim.subject.canonicalEntityId === options.projectId || claim.target?.canonicalEntityId === options.projectId);
}

export function listEligibleClaims(workspaceId: string, projectId?: string) {
  const today = currentContextDate();
  return listOwnerClaims(workspaceId).filter((claim) => isEligibleClaim(claim, projectId, today));
}

function localDate(timezone: string, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function liveCanonicalReference(workspaceId: string, reference: ClaimSubjectRef) {
  if (!reference.canonicalEntityId) {
    try { return !getStandaloneSubject(workspaceId, reference.id).archivedAt; } catch { return false; }
  }
  return readSnapshot().entities.some((entity) => entity.id === reference.canonicalEntityId &&
    entity.workspaceId === workspaceId && entity.type === reference.type && entity.status !== "archived" &&
    allowedCanonicalTypes.has(entity.type));
}

export function currentContextDate() {
  return localDate(getNotificationPreferences().timezone);
}

export function isEligibleClaim(claim: ContextClaim, projectId?: string, today = currentContextDate()) {
  return !claim.archivedAt && claim.reviewStatus === "confirmed" && claim.freshness === "current" &&
    claim.sensitivity === "normal" && // confidential and restricted never reach agents or AI
    (claim.relationStatus == null || claim.relationStatus === "registered") &&
    (!claim.validFrom || claim.validFrom <= today) &&
    (!claim.validTo || claim.validTo >= today) && liveCanonicalReference(claim.workspaceId, claim.subject) &&
    (!claim.target || liveCanonicalReference(claim.workspaceId, claim.target)) &&
    (!projectId || claim.subject.type === "workspace" || claim.subject.canonicalEntityId === projectId || claim.target?.canonicalEntityId === projectId);
}

export function listClaimHistory(workspaceId: string, claimId: string) {
  assertWorkspace(workspaceId);
  if (!idPattern.test(claimId)) throw new ContextClaimError("Claim identifier is invalid");
  const rows = getDatabase().prepare(`SELECT e.id, e.operation, e.before_revision AS beforeRevision, e.after_revision AS afterRevision,
    e.created_at AS createdAt, e.kind, e.reverts_event_id AS revertsEventId, e.before_payload AS beforePayload, e.after_payload AS afterPayload,
    (SELECT r.decision FROM context_review_events r WHERE r.workspace_id = e.workspace_id AND r.claim_id = e.object_id
      AND r.claim_revision = e.after_revision ORDER BY r.created_at DESC LIMIT 1) AS decision
    FROM context_change_events e WHERE e.workspace_id = ? AND e.object_id = ?
    ORDER BY e.created_at DESC, e.rowid DESC LIMIT 100`).all(workspaceId, claimId) as Array<Record<string, unknown>>;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const status = (payload: unknown) => { try { return (JSON.parse(String(payload)) as { reviewStatus?: string } | null)?.reviewStatus ?? null; } catch { return null; } };
  // The review state the action itself leads to: what an Undo took away, or what a Redo brought back.
  const resultOf = (row: Record<string, unknown>): string | null => {
    if (row.kind === "undo") return status(row.beforePayload);
    if (row.kind === "skip") { const target = byId.get(String(row.revertsEventId)); return target ? resultOf(target) : null; }
    return status(row.afterPayload);
  };
  return rows.map((row) => ({ operation: row.operation, beforeRevision: row.beforeRevision, afterRevision: row.afterRevision,
    createdAt: row.createdAt, kind: row.kind, decision: row.decision, reviewStatus: resultOf(row) }));
}

/** The part of a claim that Undo/Redo restores and compares; revisions and timestamps are not part of it. */
export function claimFingerprint(claim: ContextClaim, legacyEvidence = false) {
  return { predicate: claim.predicate, literal: claim.literal, targetId: claim.target?.id ?? null, freshness: claim.freshness,
    sensitivity: readSensitivity(claim.sensitivity).sensitivity, validFrom: claim.validFrom ?? null, validTo: claim.validTo ?? null,
    // Steps recorded before evidence became records only know the single legacy source/evidence; newer ones compare the records.
    ...(legacyEvidence || !claim.evidenceItems ? { source: claim.source ?? null, evidence: claim.evidence ?? null }
      : { evidenceSet: evidenceSetFingerprint(claim.evidenceItems) }),
    reviewStatus: claim.reviewStatus, archived: claim.archivedAt != null };
}

/** A claim as it is read inside a command (the same shape the API returns). */
export function readOwnerClaim(workspaceId: string, id: string) {
  const row = rowForClaim(id, workspaceId);
  return row ? deserialize(row) : null;
}

/**
 * What an agent, an external tool or an AI provider may see of a claim. Only eligible claims get here, and of their
 * evidence only the records whose source is "normal" survive: a confidential or restricted source (and every
 * excerpt, locator, author or external id of it) is not mentioned at all, not even by count. The owner-only
 * fields (the legacy source/evidence JSON, account, external id, source locator, author) are dropped.
 */
export interface AgentClaimEvidence {
  stance: "supports" | "contradicts" | null;
  excerpt: string | null;
  metadataOnly: boolean;
  source: { provider: string | null; sourceAt: string | null; coverage: "metadata" | "excerpt" | "body" | null };
}
export type AgentClaim = Omit<ContextClaim, "source" | "evidence" | "evidenceItems" | "evidenceCount" | "sourceCoverage"> & {
  evidence: AgentClaimEvidence[];
  sourceCoverage: ClaimSourceCoverage;
};

export function toAgentClaim(claim: ContextClaim): AgentClaim {
  const { source: _source, evidence: _evidence, evidenceItems, evidenceCount: _count, sourceCoverage: _coverage, ...rest } = claim;
  const visible = evidenceItems.filter((item) => item.source.sensitivity === "normal" && !item.source.archivedAt);
  return { ...rest, sourceCoverage: summarizeCoverage(visible),
    evidence: visible.map((item) => ({ stance: item.stance, excerpt: item.excerpt, metadataOnly: item.metadataOnly,
      source: { provider: item.source.provider, sourceAt: item.source.sourceAt, coverage: item.source.coverage } })) };
}

function undoConflict(message: string) {
  return new ContextClaimError(message, 409, "undo_conflict");
}

/**
 * Undo/Redo of one claim step, as a new revision. `after` is the state the step being reversed left the
 * claim in; the claim must still be exactly there (and at `expectedRevision`, the revision of the newest
 * event for it), otherwise something changed it since and nothing is written. The claim then goes to the
 * state the step started from (`before`); a step that created the claim is reversed by archiving it.
 * Must run inside a context command (one transaction).
 */
export function compensateClaim(input: { workspaceId: string; id: string; mode: "undo" | "redo"; expectedRevision: number;
  before: ContextClaim | null; after: ContextClaim }) {
  const row = rowForClaim(input.id, input.workspaceId);
  if (!row) throw undoConflict("The claim no longer exists");
  const current = deserialize(row);
  const legacyEvidence = !input.after.evidenceItems || (input.before != null && !input.before.evidenceItems);
  if (current.revision !== input.expectedRevision || stable(claimFingerprint(current, legacyEvidence)) !== stable(claimFingerprint(input.after, legacyEvidence))) {
    throw undoConflict("The claim was changed after this step");
  }
  const target = input.before ? claimFingerprint(input.before, legacyEvidence) : { ...claimFingerprint(input.after, legacyEvidence), archived: true };
  const targetClaim = input.before ?? input.after;
  if (!target.archived) {
    // A claim that comes back must still have a valid subject and target (neither archived nor gone).
    const refOf = (ref: ClaimSubjectRef): CanonicalRefInput => ref.canonicalEntityId ? { entityId: ref.canonicalEntityId } : { subjectId: ref.id };
    try {
      canonicalSubject(input.workspaceId, refOf(current.subject));
      if (targetClaim.target) canonicalSubject(input.workspaceId, refOf(targetClaim.target));
    } catch (error) {
      if (error instanceof ContextCommandError && error.status < 409) throw new ContextClaimError(error.message, 409, error.code);
      throw error;
    }
  }
  const now = Date.now();
  const archivedAt = target.archived ? (current.archivedAt ?? now) : null;
  // Evidence goes back with the claim: the recorded set when the step has one, else the single legacy evidence.
  if (!target.archived && input.before) {
    if (input.before.evidenceItems && !legacyEvidence) {
      restoreClaimEvidence({ workspaceId: input.workspaceId, claimId: input.id, target: input.before.evidenceItems });
    } else if (stable(legacyProjection(current.evidenceItems)) !== stable({ source: input.before.source ?? null, evidence: input.before.evidence ?? null })) {
      // Recorded before evidence became records: the newest evidence is replaced by the one the step started from.
      restoreClaimEvidence({ workspaceId: input.workspaceId, claimId: input.id, target: current.evidenceItems.slice(1) });
      applyLegacySourceEvidence({ workspaceId: input.workspaceId, claimId: input.id, claimSensitivity: target.sensitivity as ClaimSensitivity,
        source: input.before.source ?? null, evidence: input.before.evidence ?? null, append: true });
    }
  }
  requireChanged(getDatabase().prepare(`UPDATE context_claims SET predicate=?, literal_type=?, literal_value=?, target_subject_id=?,
    freshness=?, sensitivity=?, valid_from=?, valid_to=?, review_status=?, archived_at=?,
    revision=revision+1, updated_at=? WHERE id=? AND workspace_id=? AND revision=?`)
    .run(target.predicate, target.literal?.type || null, target.literal ? JSON.stringify(target.literal.value) : null, target.targetId,
      target.freshness, target.sensitivity, target.validFrom, target.validTo,
      target.reviewStatus, archivedAt, now, input.id, input.workspaceId, input.expectedRevision), "Claim changed on another device");
  if (!target.archived) reprojectClaimJson(input.workspaceId, input.id);
  const claim = deserialize(rowForClaim(input.id, input.workspaceId)!);
  if (target.reviewStatus !== current.reviewStatus) {
    getDatabase().prepare(`INSERT INTO context_review_events
      (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`)
      .run(randomUUID(), input.workspaceId, input.id, claim.revision, target.reviewStatus, input.mode, now);
  }
  return { claim, before: current };
}
