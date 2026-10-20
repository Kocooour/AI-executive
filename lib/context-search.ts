import { assertCommandWorkspace, contextIdPattern, ContextCommandError } from "./context-commands";
import { currentContextDate, isEligibleClaim, listClaimHistory, listClaimReviewEvents, readOwnerClaim, type ContextClaim } from "./context-claims";
import { getDatabase, readSnapshot } from "./server-store";
import { relationStatusOf } from "./context-relations";
import type { Entity } from "./db";

// v1 is canonical, lexical-only retrieval. Neither a client-provided role nor a cached index
// is an authorization authority. External callers are admitted only by the server tool adapter.
export const CONTEXT_SEARCH_SCHEMA_VERSION = 1;
const maxScan = 5000;
const maxPage = 30;
// People, projects and claims each contribute at most maxScan results.
const maxOffset = maxScan * 3;
const allowedKinds = ["person", "project", "claim", "relation"] as const;
export type ContextSearchKind = (typeof allowedKinds)[number];
export type ContextSearchActor = "owner" | "integration";

export interface ContextSearchInput {
  workspaceId: string;
  query: string;
  actor: ContextSearchActor;
  kinds?: string[];
  limit?: number;
  cursor?: string;
}

export interface ContextSearchHit {
  kind: ContextSearchKind;
  id: string;
  title: string;
  workspaceId: string;
  canonicalEntityId: string | null;
  predicate?: string;
  value?: string | number | boolean | null;
  subject?: string;
  target?: string | null;
  revision?: number;
  reviewStatus?: string;
  freshness?: string;
  sensitivity?: string;
  provenance?: string;
  validFrom?: string | null;
  validTo?: string | null;
  updatedAt: number;
  matchType: "exact" | "prefix" | "text";
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("cs-CZ").replace(/\s+/g, " ").trim();
}
function bounded(value: string, count: number) {
  return value.length <= count ? value : value.slice(0, count) + "…";
}
function integer(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ContextCommandError("Invalid search pagination");
  }
  return value;
}
function pageOffset(cursor: string | undefined) {
  if (!cursor) return 0;
  if (!/^(0|[1-9][0-9]{0,4})$/.test(cursor) || Number(cursor) > maxOffset) {
    throw new ContextCommandError("Invalid search cursor");
  }
  return Number(cursor);
}
function match(title: string, details: string, query: string): ContextSearchHit["matchType"] | null {
  const name = normalize(title);
  if (name === query) return "exact";
  if (name.startsWith(query)) return "prefix";
  if (name.includes(query) || normalize(details).includes(query)) return "text";
  return null;
}
function rank(hit: ContextSearchHit) {
  return hit.matchType === "exact" ? 3 : hit.matchType === "prefix" ? 2 : 1;
}
function claimKind(claim: ContextClaim): "claim" | "relation" {
  return claim.target ? "relation" : "claim";
}
function claimValue(claim: ContextClaim): string | number | boolean | null {
  const value = claim.literal?.value;
  return typeof value === "string" ? bounded(value, 280) : (value ?? null);
}
function claimHit(claim: ContextClaim, query: string, actor: ContextSearchActor): ContextSearchHit | null {
  const title = claim.target
    ? claim.subject.title + " " + claim.predicate + " " + claim.target.title
    : claim.subject.title + " · " + claim.predicate;
  const matchType = match(title, String(claim.literal?.value ?? ""), query);
  if (!matchType) return null;
  return {
    kind: claimKind(claim), id: claim.id, title: bounded(title, 320),
    workspaceId: claim.workspaceId, canonicalEntityId: claim.subject.canonicalEntityId,
    predicate: claim.predicate, value: claimValue(claim),
    subject: bounded(claim.subject.title, 200), target: claim.target ? bounded(claim.target.title, 200) : null,
    revision: claim.revision, reviewStatus: claim.reviewStatus, freshness: claim.freshness,
    // External clients already know these are confirmed/current/normal; no owner-only metadata.
    ...(actor === "owner" ? { sensitivity: claim.sensitivity } : {}),
    provenance: claim.provenance, validFrom: claim.validFrom, validTo: claim.validTo,
    updatedAt: claim.updatedAt, matchType,
  };
}

// Share the same fail-closed evidence predicate between integration retrieval and owner Explain.
// Do not read only claim.evidenceItems here: the owner projection omits missing or foreign-workspace
// sources and may cap valid evidence, while any unsafe active link must deny external access.
const unsafeActiveEvidenceSql = [
  "SELECT 1 FROM context_evidence e",
  "LEFT JOIN context_sources src ON src.id = e.source_id AND src.workspace_id = c.workspace_id",
  "WHERE e.claim_id = c.id AND e.archived_at IS NULL AND",
  "(e.workspace_id <> c.workspace_id OR src.id IS NULL OR src.sensitivity <> 'normal' OR src.archived_at IS NOT NULL)",
].join(" ");

function hasUnsafeActiveEvidence(workspaceId: string, claimId: string) {
  const row = getDatabase().prepare(
    "SELECT EXISTS (" + unsafeActiveEvidenceSql + ") AS blocked FROM context_claims c WHERE c.id = ? AND c.workspace_id = ?"
  ).get(claimId, workspaceId) as { blocked: number } | undefined;
  return !row || Boolean(row.blocked);
}

/** Only owner-confirmed live normal claims, with no unsafe active evidence, can leave this boundary. */
export function externallySearchableClaim(claim: ContextClaim, today = currentContextDate()) {
  return isEligibleClaim(claim, undefined, today) && !hasUnsafeActiveEvidence(claim.workspaceId, claim.id);
}


type SearchClaimRow = {
  id: string; predicate: string; literalType: string | null; literalValue: string | null;
  targetId: string | null; reviewStatus: string; freshness: string; sensitivity: string;
  provenance: string; validFrom: string | null; validTo: string | null; revision: number; updatedAt: number;
  subjectType: string; subjectTitle: string; subjectCanonicalId: string | null; subjectArchivedAt: number | null;
  targetType: string | null; targetTitle: string | null; targetCanonicalId: string | null; targetArchivedAt: number | null;
};

function liveEndpoint(type: string | null, id: string | null, archivedAt: number | null, workspaceId: string, byId: Map<string, Entity>) {
  if (archivedAt != null) return false;
  if (!id) return type === "person" || type === "organization"; // Only live standalone types are eligible.
  const entity = byId.get(id);
  return Boolean(entity && entity.workspaceId === workspaceId && entity.status !== "archived" &&
    entity.type === type && ["workspace", "area", "project", "task", "note"].includes(entity.type));
}

/** Exact query used for retrieval, exported for EXPLAIN QUERY PLAN regression tests only. */
export function contextSearchClaimSql(actor: ContextSearchActor) {
  const restrictions = actor !== "integration" ? "" : [
    "AND c.review_status = 'confirmed' AND c.freshness = 'current' AND c.sensitivity = 'normal'",
    "AND NOT EXISTS (" + unsafeActiveEvidenceSql + ")",
  ].join(" ");
  const sql = [
    "SELECT c.id, c.predicate, c.literal_type AS literalType, c.literal_value AS literalValue,",
    "c.target_subject_id AS targetId, c.review_status AS reviewStatus, c.freshness, c.sensitivity,",
    "c.provenance, c.valid_from AS validFrom, c.valid_to AS validTo, c.revision, c.updated_at AS updatedAt,",
    "s.subject_type AS subjectType, s.display_title AS subjectTitle,",
    "s.canonical_entity_id AS subjectCanonicalId, s.archived_at AS subjectArchivedAt,",
    "t.subject_type AS targetType, t.display_title AS targetTitle,",
    "t.canonical_entity_id AS targetCanonicalId, t.archived_at AS targetArchivedAt",
    "FROM context_claims c",
    "JOIN context_subjects s ON s.id = c.subject_id AND s.workspace_id = c.workspace_id",
    "LEFT JOIN context_subjects t ON t.id = c.target_subject_id AND t.workspace_id = c.workspace_id",
    "WHERE c.workspace_id = ? AND c.archived_at IS NULL",
    "AND (c.target_subject_id IS NULL OR t.id IS NOT NULL)", restrictions,
    "ORDER BY c.updated_at DESC, c.id ASC LIMIT ?",
  ].join(" ");
  return sql;
}

function searchClaimRows(workspaceId: string, actor: ContextSearchActor) {
  return getDatabase().prepare(contextSearchClaimSql(actor)).all(workspaceId, maxScan + 1) as unknown as SearchClaimRow[];
}

export function searchContext(input: ContextSearchInput) {
  if (input.actor !== "owner" && input.actor !== "integration") throw new ContextCommandError("Unknown search actor", 403);
  const query = normalize(String(input.query || ""));
  if (query.length < 2 || query.length > 120) throw new ContextCommandError("Search query must contain 2–120 characters");
  const kinds = input.kinds === undefined ? [...allowedKinds] : input.kinds;
  if (!Array.isArray(kinds) || !kinds.length || kinds.some((kind) => !allowedKinds.includes(kind as ContextSearchKind))) {
    throw new ContextCommandError("Invalid search kinds");
  }
  const accepted = new Set(kinds);
  const limit = integer(input.limit, 15, maxPage);
  if (limit === 0) throw new ContextCommandError("Search page size must be positive");
  const offset = pageOffset(input.cursor);

  // Reuse one canonical snapshot and one lookup map for the full request, not one parse per claim.
  const workspaceId = input.workspaceId;
  if (!workspaceId || workspaceId === "all") throw new ContextCommandError("One explicit workspace is required");
  const entities = readSnapshot().entities;
  if (!entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId)) {
    throw new ContextCommandError("Workspace not found", 404, "workspace_not_found");
  }
  if (input.actor === "integration") {
    const allowed = (process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES || "").split(",").map((id) => id.trim());
    if (!allowed.includes(workspaceId)) {
      throw new ContextCommandError("Context search tool is not allowed in this workspace", 403, "tool_forbidden");
    }
  }
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const hits: ContextSearchHit[] = [];
  let partial = false;
  if (input.actor === "owner") {
    if (accepted.has("person")) {
      const rows = getDatabase().prepare("SELECT id, display_title AS title, updated_at AS updatedAt FROM context_subjects WHERE workspace_id = ? AND canonical_entity_id IS NULL AND subject_type = 'person' AND archived_at IS NULL ORDER BY updated_at DESC, id ASC LIMIT ?")
        .all(workspaceId, maxScan + 1) as Array<{ id: string; title: string; updatedAt: number }>;
      partial ||= rows.length > maxScan;
      for (const row of rows.slice(0, maxScan)) {
        const matchType = match(row.title, "", query);
        if (matchType) hits.push({ kind: "person", id: row.id, title: bounded(row.title, 200), workspaceId, canonicalEntityId: null,
          updatedAt: Number(row.updatedAt), matchType });
      }
    }
    if (accepted.has("project")) {
      const projects = entities.filter((entity) => entity.workspaceId === workspaceId &&
        entity.type === "project" && entity.status !== "archived")
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      partial ||= projects.length > maxScan;
      for (const entity of projects.slice(0, maxScan)) {
        const matchType = match(entity.title, "", query);
        if (matchType) hits.push({ kind: "project", id: entity.id, title: bounded(entity.title, 200), workspaceId,
          canonicalEntityId: entity.id, updatedAt: entity.updatedAt, matchType });
      }
    }
  }
  if (accepted.has("claim") || accepted.has("relation")) {
    const rows = searchClaimRows(workspaceId, input.actor);
    partial ||= rows.length > maxScan;
    const today = input.actor === "integration" ? currentContextDate() : "";
    for (const row of rows.slice(0, maxScan)) {
      const kind = row.targetId ? "relation" : "claim";
      if (!accepted.has(kind)) continue;
      if (input.actor === "integration") {
        if ((row.validFrom && row.validFrom > today) || (row.validTo && row.validTo < today)) continue;
        if (!liveEndpoint(row.subjectType, row.subjectCanonicalId, row.subjectArchivedAt, workspaceId, byId)) continue;
        if (row.targetId && (!liveEndpoint(row.targetType, row.targetCanonicalId, row.targetArchivedAt, workspaceId, byId) ||
          relationStatusOf(row.predicate, row.subjectType, row.targetType || "") !== "registered")) continue;
      }
      const subject = (row.subjectCanonicalId && byId.get(row.subjectCanonicalId)?.workspaceId === workspaceId
        ? byId.get(row.subjectCanonicalId)?.title : row.subjectTitle) || row.subjectTitle;
      const target = row.targetId
        ? ((row.targetCanonicalId && byId.get(row.targetCanonicalId)?.workspaceId === workspaceId
          ? byId.get(row.targetCanonicalId)?.title : row.targetTitle) || row.targetTitle || "")
        : null;
      let value: string | number | boolean | null = null;
      if (row.literalType) {
        try {
          const parsed: unknown = JSON.parse(row.literalValue || "null");
          if (typeof parsed !== "string" && typeof parsed !== "number" && typeof parsed !== "boolean") continue;
          value = parsed;
        } catch { continue; }
      }
      const title = target === null ? subject + " · " + row.predicate : subject + " " + row.predicate + " " + target;
      const matchType = match(title, String(value ?? ""), query);
      if (!matchType) continue;
      hits.push({
        kind, id: row.id, title: bounded(title, 320), workspaceId, canonicalEntityId: row.subjectCanonicalId,
        predicate: row.predicate, value: typeof value === "string" ? bounded(value, 280) : value,
        subject: bounded(subject, 200), target: target === null ? null : bounded(target, 200),
        revision: row.revision, reviewStatus: row.reviewStatus, freshness: row.freshness,
        ...(input.actor === "owner" ? { sensitivity: row.sensitivity } : {}),
        provenance: row.provenance, validFrom: row.validFrom, validTo: row.validTo,
        updatedAt: Number(row.updatedAt), matchType,
      });
    }
  }
  hits.sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt ||
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return {
    schemaVersion: CONTEXT_SEARCH_SCHEMA_VERSION, workspaceId, mode: "lexical" as const,
    results: hits.slice(offset, offset + limit),
    nextCursor: offset + limit < hits.length ? String(offset + limit) : null,
    // Do not leak protected candidate counts in the external API.
    ...(input.actor === "owner" ? { partial } : {}),
  };
}

function ownerClaimSummary(claim: ContextClaim) {
  return {
    id: claim.id, workspaceId: claim.workspaceId, subject: claim.subject, predicate: claim.predicate,
    literal: claim.literal && { type: claim.literal.type, value: claimValue(claim) }, target: claim.target,
    revision: claim.revision, provenance: claim.provenance, reviewStatus: claim.reviewStatus,
    freshness: claim.freshness, sensitivity: claim.sensitivity, relationStatus: claim.relationStatus,
    validFrom: claim.validFrom, validTo: claim.validTo, recordedAt: claim.recordedAt,
    updatedAt: claim.updatedAt, archivedAt: claim.archivedAt,
  };
}

/** Detailed explanation is intentionally owner-only; never wire it into the bearer-token Tool Registry. */
export function explainOwnerClaim(workspaceId: string, claimId: string) {
  assertCommandWorkspace(workspaceId);
  if (!contextIdPattern.test(claimId)) throw new ContextCommandError("Invalid claim identifier");
  const claim = readOwnerClaim(workspaceId, claimId);
  if (!claim) throw new ContextCommandError("Claim not found", 404, "not_found");
  const today = currentContextDate();
  const eligibleForInternalAI = isEligibleClaim(claim, undefined, today);
  const unsafeActiveEvidence = hasUnsafeActiveEvidence(workspaceId, claimId);
  const eligibleForExternalSearch = eligibleForInternalAI && !unsafeActiveEvidence;
  const internalBlockers: string[] = [];
  const blockers = internalBlockers;
  if (claim.archivedAt) blockers.push("archived");
  if (claim.reviewStatus !== "confirmed") blockers.push("unconfirmed");
  if (claim.freshness !== "current") blockers.push("not_current");
  if (claim.sensitivity !== "normal") blockers.push("sensitive");
  if (claim.relationStatus && claim.relationStatus !== "registered") blockers.push("unregistered_relation");
  if (claim.validFrom && claim.validFrom > today) blockers.push("not_yet_valid");
  if (claim.validTo && claim.validTo < today) blockers.push("expired");
  if (!eligibleForInternalAI && !internalBlockers.length) internalBlockers.push("unavailable_reference");
  const externalBlockers = [...internalBlockers];
  if (unsafeActiveEvidence) externalBlockers.push("protected_source");
  if (!eligibleForExternalSearch && !externalBlockers.length) externalBlockers.push("unavailable_reference");
  const relatedIds = getDatabase().prepare("SELECT id FROM context_claims WHERE workspace_id = ? AND archived_at IS NULL AND id != ? AND (subject_id = ? OR target_subject_id = ? OR subject_id = ? OR target_subject_id = ?) ORDER BY updated_at DESC LIMIT 16")
    .all(workspaceId, claimId, claim.subject.id, claim.subject.id, claim.target?.id ?? "", claim.target?.id ?? "") as Array<{ id: string }>;
  const related = relatedIds.slice(0, 15).map((row) => readOwnerClaim(workspaceId, row.id))
    .filter((item): item is ContextClaim => Boolean(item)).map(ownerClaimSummary);
  // All content-bearing fields remain behind owner cookie authentication. Existing source and history
  // readers are workspace-scoped; records are bounded for mobile responses.
  return {
    schemaVersion: CONTEXT_SEARCH_SCHEMA_VERSION, workspaceId,
    claim: ownerClaimSummary(claim),
    why: { eligibleForInternalAI, eligibleForExternalSearch, internalBlockers, externalBlockers,
      reviewed: claim.reviewStatus, freshness: claim.freshness,
      validNow: (!claim.validFrom || claim.validFrom <= today) && (!claim.validTo || claim.validTo >= today),
      checkedAt: today, sourceCoverage: claim.sourceCoverage, evidenceCount: claim.evidenceCount },
    evidence: claim.evidenceItems.filter((item) => item.workspaceId === workspaceId && item.source.workspaceId === workspaceId).slice(0, 10),
    evidenceTruncated: claim.evidenceCount > 10,
    reviewEvents: listClaimReviewEvents(workspaceId, claimId).slice(0, 20),
    history: listClaimHistory(workspaceId, claimId).slice(0, 20),
    relations: related,
  };
}
