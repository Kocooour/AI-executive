import { createHash, randomUUID } from "node:crypto";
import { getNotificationPreferences } from "./notifications";
import { getDatabase, readSnapshot } from "./server-store";
import { getStandaloneSubject } from "./context-subjects";

export type ClaimReviewStatus = "proposed" | "confirmed" | "rejected";
export type ClaimFreshness = "current" | "needs_review" | "stale";
export type ClaimSensitivity = "normal" | "sensitive";
export type ClaimLiteralType = "string" | "number" | "boolean" | "date";

export interface ClaimSubjectRef {
  id: string;
  type: string;
  canonicalEntityId: string | null;
  title: string;
  revision?: number;
  archivedAt?: number | null;
}

export interface ClaimSourceMetadata {
  provider?: string;
  externalId?: string;
  locator?: string;
  author?: string;
  authorRole?: string;
  sourceAt?: string;
  ingestedAt?: string;
  coverage?: "metadata" | "excerpt" | "body";
}

export interface ClaimEvidenceMetadata {
  locator?: string;
  excerpt?: string;
  stance?: "supports" | "contradicts";
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
  sensitivity: ClaimSensitivity;
  provenance: "owner";
  validFrom: string | null;
  validTo: string | null;
  source: ClaimSourceMetadata | null;
  evidence: ClaimEvidenceMetadata | null;
  revision: number;
  archivedAt: number | null;
  recordedAt: number;
  updatedAt: number;
}

export class ContextClaimError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
  sensitivity: ClaimSensitivity;
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
  sensitivity: ClaimSensitivity;
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

const idPattern = /^[A-Za-z0-9:_-]{1,240}$/;
const predicatePattern = /^[a-z][a-z0-9_.-]{0,119}$/;
const allowedCanonicalTypes = new Set(["workspace", "area", "project", "task", "note"]);
const reviewStatuses = new Set<ClaimReviewStatus>(["proposed", "confirmed", "rejected"]);
const freshnessStates = new Set<ClaimFreshness>(["current", "needs_review", "stale"]);
const sensitivities = new Set<ClaimSensitivity>(["normal", "sensitive"]);
const literalTypes = new Set<ClaimLiteralType>(["string", "number", "boolean", "date"]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function commandHash(operation: string, input: unknown) {
  return createHash("sha256").update(`${operation}:${stable(input)}`).digest("hex");
}

function assertWorkspace(workspaceId: string) {
  if (!workspaceId || workspaceId === "all") throw new ContextClaimError("One explicit workspace is required");
  const exists = readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  if (!exists) throw new ContextClaimError("Workspace not found", 404, "workspace_not_found");
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

function validateSourceTimestamp(value: string, label: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    validateDate(value, label);
    return;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) throw new ContextClaimError(`${label} is invalid`);
  const [, year, month, day] = match;
  validateDate(`${year}-${month}-${day}`, label);
  if (Number.isNaN(Date.parse(value))) throw new ContextClaimError(`${label} is invalid`);
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
    locator: 1000, excerpt: 2000, stance: 20,
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

function deserialize(row: ClaimRow): ContextClaim {
  const literal = row.literal_type ? {
    type: row.literal_type as ClaimLiteralType,
    value: JSON.parse(String(row.literal_value)),
  } : null;
  return {
    id: row.id, workspaceId: row.workspace_id, subject: readSubject(row.subject_id), predicate: row.predicate,
    literal, target: row.target_subject_id ? readSubject(row.target_subject_id) : null,
    reviewStatus: row.review_status as ClaimReviewStatus, freshness: row.freshness as ClaimFreshness,
    sensitivity: row.sensitivity as ClaimSensitivity, provenance: "owner",
    validFrom: row.valid_from, validTo: row.valid_to,
    source: row.source_metadata ? JSON.parse(row.source_metadata) : null,
    evidence: row.evidence_metadata ? JSON.parse(row.evidence_metadata) : null,
    revision: Number(row.revision), archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    recordedAt: Number(row.recorded_at), updatedAt: Number(row.updated_at),
  };
}

function rowForClaim(id: string, workspaceId: string) {
  return getDatabase().prepare("SELECT * FROM context_claims WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as ClaimRow | undefined;
}

function checkedCommand<T>(operation: string, input: { commandId: string; workspaceId: string }, mutate: () => { result: T; before: ContextClaim | null; after: ContextClaim; changed: boolean }) {
  if (!idPattern.test(input.commandId)) throw new ContextClaimError("Idempotency key is invalid");
  assertWorkspace(input.workspaceId);
  const database = getDatabase();
  const hash = commandHash(operation, input);
  database.exec("BEGIN IMMEDIATE");
  try {
    const prior = database.prepare(`SELECT request_hash, result_payload FROM context_commands
      WHERE workspace_id = ? AND idempotency_key = ?`).get(input.workspaceId, input.commandId) as
      { request_hash: string; result_payload: string } | undefined;
    if (prior) {
      if (prior.request_hash !== hash) throw new ContextClaimError("Idempotency key was already used for another command", 409, "idempotency_conflict");
      database.exec("COMMIT");
      const replay = JSON.parse(prior.result_payload) as T;
      return replay && typeof replay === "object" ? { ...replay, replayed: true } as T : replay;
    }
    const mutation = mutate();
    if (mutation.changed) {
      database.prepare(`INSERT INTO context_change_events
        (id, command_id, workspace_id, actor, object_id, operation, before_revision, after_revision,
         before_payload, after_payload, created_at) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), input.commandId, input.workspaceId, mutation.after.id, operation,
          mutation.before?.revision ?? null, mutation.after.revision,
          mutation.before ? JSON.stringify(mutation.before) : null, JSON.stringify(mutation.after), Date.now());
    }
    const payload = JSON.stringify(mutation.result);
    database.prepare(`INSERT INTO context_commands
      (workspace_id, idempotency_key, request_hash, result_payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.workspaceId, input.commandId, hash, payload, Date.now());
    database.exec("COMMIT");
    return mutation.result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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
  const source = cleanSource(input.source);
  const evidence = cleanEvidence(input.evidence, source);
  const validFrom = validateDate(input.validFrom, "validFrom");
  const validTo = validateDate(input.validTo, "validTo");
  if (validFrom && validTo && Date.parse(validFrom) > Date.parse(validTo)) throw new ContextClaimError("Validity interval is invalid");
  return { subject, literal, target, source, evidence, validFrom, validTo };
}

export function createOwnerClaim(input: CreateClaimInput) {
  return checkedCommand("create", input, () => {
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
        input.sensitivity, clean.validFrom, clean.validTo, clean.source ? JSON.stringify(clean.source) : null,
        clean.evidence ? JSON.stringify(clean.evidence) : null, now, now);
    const after = deserialize(rowForClaim(input.id, input.workspaceId)!);
    return { result: { claim: after, replayed: false }, before: null, after, changed: true };
  });
}

export function updateOwnerClaim(input: UpdateClaimInput) {
  return checkedCommand("update", input, () => {
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
      freshness: input.freshness, sensitivity: input.sensitivity, validFrom: clean.validFrom, validTo: clean.validTo,
      source: clean.source, evidence: clean.evidence };
    const existing = { predicate: before.predicate, literal: before.literal, targetId: before.target?.id || null,
      freshness: before.freshness, sensitivity: before.sensitivity, validFrom: before.validFrom, validTo: before.validTo,
      source: before.source, evidence: before.evidence };
    if (stable(comparable) === stable(existing)) return { result: { claim: before, replayed: false }, before, after: before, changed: false };
    const now = Date.now();
    getDatabase().prepare(`UPDATE context_claims SET predicate=?, literal_type=?, literal_value=?, target_subject_id=?,
      freshness=?, sensitivity=?, valid_from=?, valid_to=?, source_metadata=?, evidence_metadata=?, revision=revision+1,
      review_status='proposed', updated_at=? WHERE id=? AND workspace_id=? AND revision=?`)
      .run(input.predicate, clean.literal?.type || null, clean.literal ? JSON.stringify(clean.literal.value) : null,
        clean.target?.id || null, input.freshness, input.sensitivity, clean.validFrom, clean.validTo,
        clean.source ? JSON.stringify(clean.source) : null, clean.evidence ? JSON.stringify(clean.evidence) : null,
        now, input.id, input.workspaceId, input.expectedRevision);
    const after = deserialize(rowForClaim(input.id, input.workspaceId)!);
    return { result: { claim: after, replayed: false }, before, after, changed: true };
  });
}

export function reviewOwnerClaim(input: ReviewClaimInput) {
  if (!reviewStatuses.has(input.decision)) throw new ContextClaimError("Review decision is invalid");
  if (input.reason && input.reason.length > 1000) throw new ContextClaimError("Review reason is too long");
  return checkedCommand("review", input, () => {
    const row = rowForClaim(input.id, input.workspaceId);
    if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
    const before = deserialize(row);
    if (before.revision !== input.expectedRevision) throw new ContextClaimError("Claim changed on another device", 409, "revision_conflict");
    if (before.archivedAt) throw new ContextClaimError("Archived claims cannot be reviewed", 409, "archived");
    if (before.reviewStatus === input.decision) return { result: { claim: before, replayed: false }, before, after: before, changed: false };
    const now = Date.now();
    getDatabase().prepare(`UPDATE context_claims SET review_status=?, revision=revision+1, updated_at=?
      WHERE id=? AND workspace_id=? AND revision=?`).run(input.decision, now, input.id, input.workspaceId, input.expectedRevision);
    const after = deserialize(rowForClaim(input.id, input.workspaceId)!);
    getDatabase().prepare(`INSERT INTO context_review_events
      (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
      VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`)
      .run(randomUUID(), input.workspaceId, input.id, after.revision, input.decision, input.reason?.trim() || null, now);
    return { result: { claim: after, replayed: false }, before, after, changed: true };
  });
}

export function archiveOwnerClaim(input: ArchiveClaimInput) {
  return checkedCommand("archive", input, () => {
    const row = rowForClaim(input.id, input.workspaceId);
    if (!row) throw new ContextClaimError("Claim not found", 404, "not_found");
    const before = deserialize(row);
    if (before.revision !== input.expectedRevision) throw new ContextClaimError("Claim changed on another device", 409, "revision_conflict");
    if (before.archivedAt) return { result: { claim: before, replayed: false }, before, after: before, changed: false };
    const now = Date.now();
    getDatabase().prepare(`UPDATE context_claims SET archived_at=?, revision=revision+1, updated_at=?
      WHERE id=? AND workspace_id=? AND revision=?`).run(now, now, input.id, input.workspaceId, input.expectedRevision);
    const after = deserialize(rowForClaim(input.id, input.workspaceId)!);
    return { result: { claim: after, replayed: false }, before, after, changed: true };
  });
}

export function listOwnerClaims(workspaceId: string, options: { includeArchived?: boolean; projectId?: string } = {}) {
  assertWorkspace(workspaceId);
  if (options.projectId && canonicalSubject(workspaceId, { entityId: options.projectId }).type !== "project") {
    throw new ContextClaimError("Project filter is invalid");
  }
  const rows = getDatabase().prepare(`SELECT * FROM context_claims WHERE workspace_id = ?
    ${options.includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY updated_at DESC LIMIT 500`)
    .all(workspaceId) as unknown as ClaimRow[];
  return rows.map(deserialize).filter((claim) => !options.projectId ||
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
    claim.sensitivity === "normal" && (!claim.validFrom || claim.validFrom <= today) &&
    (!claim.validTo || claim.validTo >= today) && liveCanonicalReference(claim.workspaceId, claim.subject) &&
    (!claim.target || liveCanonicalReference(claim.workspaceId, claim.target)) &&
    (!projectId || claim.subject.type === "workspace" || claim.subject.canonicalEntityId === projectId || claim.target?.canonicalEntityId === projectId);
}

export function listClaimHistory(workspaceId: string, claimId: string) {
  assertWorkspace(workspaceId);
  if (!idPattern.test(claimId)) throw new ContextClaimError("Claim identifier is invalid");
  return getDatabase().prepare(`SELECT operation, before_revision AS beforeRevision, after_revision AS afterRevision,
    created_at AS createdAt FROM context_change_events WHERE workspace_id = ? AND object_id = ?
    ORDER BY created_at DESC LIMIT 100`).all(workspaceId, claimId);
}
