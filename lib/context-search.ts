import { assertCommandWorkspace, contextIdPattern, ContextCommandError } from "./context-commands";
import { currentContextDate, isEligibleClaim, listClaimHistory, listClaimReviewEvents, readOwnerClaim, type ContextClaim } from "./context-claims";
import { getDatabase, readSnapshot } from "./server-store";

// v1 is canonical, lexical-only retrieval. Neither a client-provided role nor a cached index
// is an authorization authority. External callers are admitted only by the server tool adapter.
export const CONTEXT_SEARCH_SCHEMA_VERSION = 1;
const maxScan = 5000;
const maxPage = 30;
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
  if (!/^(0|[1-9][0-9]{0,4})$/.test(cursor) || Number(cursor) > maxScan) {
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

/**
 * Explicit opt-in for a bearer-token client to use context.search in one workspace.
 * A token alone, "*" and "all" never grant access. Only exact workspace IDs count.
 */
export function assertIntegrationContextSearchPermission(workspaceId: string) {
  assertCommandWorkspace(workspaceId);
  const allowed = (process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES || "").split(",").map((item) => item.trim());
  if (!allowed.includes(workspaceId)) {
    throw new ContextCommandError("Context search tool is not allowed in this workspace", 403, "tool_forbidden");
  }
}

/** Only owner-confirmed live normal claims, with no protected/archived source, can leave this boundary. */
export function externallySearchableClaim(claim: ContextClaim, today = currentContextDate()) {
  return isEligibleClaim(claim, undefined, today) &&
    claim.evidenceItems.every((item) => item.workspaceId === claim.workspaceId &&
      item.source.workspaceId === claim.workspaceId && item.source.sensitivity === "normal" && !item.source.archivedAt);
}

export function searchContext(input: ContextSearchInput) {
  assertCommandWorkspace(input.workspaceId);
  if (input.actor !== "owner" && input.actor !== "integration") throw new ContextCommandError("Unknown search actor", 403);
  if (input.actor === "integration") assertIntegrationContextSearchPermission(input.workspaceId);
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
  const hits: ContextSearchHit[] = [];
  let partial = false;
  const workspaceId = input.workspaceId;
  if (input.actor === "owner") {
    if (accepted.has("person")) {
      const rows = getDatabase().prepare("SELECT id, display_title AS title, updated_at AS updatedAt FROM context_subjects WHERE workspace_id = ? AND canonical_entity_id IS NULL AND subject_type = 'person' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?")
        .all(workspaceId, maxScan + 1) as Array<{ id: string; title: string; updatedAt: number }>;
      partial ||= rows.length > maxScan;
      for (const row of rows.slice(0, maxScan)) {
        const matchType = match(row.title, "", query);
        if (matchType) hits.push({ kind: "person", id: row.id, title: bounded(row.title, 200), workspaceId, canonicalEntityId: null,
          updatedAt: Number(row.updatedAt), matchType });
      }
    }
    if (accepted.has("project")) {
      const entities = readSnapshot().entities.filter((entity) => entity.workspaceId === workspaceId &&
        entity.type === "project" && entity.status !== "archived");
      partial ||= entities.length > maxScan;
      for (const entity of entities.slice(0, maxScan)) {
        const matchType = match(entity.title, "", query);
        if (matchType) hits.push({ kind: "project", id: entity.id, title: bounded(entity.title, 200), workspaceId,
          canonicalEntityId: entity.id, updatedAt: entity.updatedAt, matchType });
      }
    }
  }
  if (accepted.has("claim") || accepted.has("relation")) {
    const eligibleSql = input.actor === "integration"
      ? " AND archived_at IS NULL AND review_status = 'confirmed' AND freshness = 'current' AND sensitivity = 'normal'"
      : " AND archived_at IS NULL";
    const rows = getDatabase().prepare("SELECT id FROM context_claims WHERE workspace_id = ?" + eligibleSql +
      " ORDER BY updated_at DESC, id ASC LIMIT ?").all(workspaceId, maxScan + 1) as Array<{ id: string }>;
    partial ||= rows.length > maxScan;
    const today = input.actor === "integration" ? currentContextDate() : "";
    for (const row of rows.slice(0, maxScan)) {
      const claim = readOwnerClaim(workspaceId, row.id);
      if (!claim || !accepted.has(claimKind(claim))) continue;
      // Revalidate current canonical state and the effective sensitivity of *every* evidence source,
      // after candidate selection and before serializing. Unreviewed claims never influence counts.
      if (input.actor === "integration" && !externallySearchableClaim(claim, today)) continue;
      const hit = claimHit(claim, query, input.actor);
      if (hit) hits.push(hit);
    }
  }
  hits.sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt ||
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const page = hits.slice(offset, offset + limit);
  return {
    schemaVersion: CONTEXT_SEARCH_SCHEMA_VERSION, workspaceId, mode: "lexical" as const,
    results: page, nextCursor: offset + limit < hits.length ? String(offset + limit) : null,
    // Do not reveal the number of protected candidates through a scan-completeness side channel.
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
  const eligibleForAI = externallySearchableClaim(claim, today);
  const blockers: string[] = [];
  if (claim.archivedAt) blockers.push("archived");
  if (claim.reviewStatus !== "confirmed") blockers.push("unconfirmed");
  if (claim.freshness !== "current") blockers.push("not_current");
  if (claim.sensitivity !== "normal") blockers.push("sensitive");
  if (claim.relationStatus && claim.relationStatus !== "registered") blockers.push("unregistered_relation");
  if (claim.validFrom && claim.validFrom > today) blockers.push("not_yet_valid");
  if (claim.validTo && claim.validTo < today) blockers.push("expired");
  if (claim.evidenceItems.some((item) => item.source.sensitivity !== "normal" || item.source.archivedAt)) blockers.push("protected_source");
  if (!eligibleForAI && !blockers.length) blockers.push("unavailable_reference");
  const relatedIds = getDatabase().prepare("SELECT id FROM context_claims WHERE workspace_id = ? AND archived_at IS NULL AND id != ? AND (subject_id = ? OR target_subject_id = ? OR subject_id = ? OR target_subject_id = ?) ORDER BY updated_at DESC LIMIT 16")
    .all(workspaceId, claimId, claim.subject.id, claim.subject.id, claim.target?.id ?? "", claim.target?.id ?? "") as Array<{ id: string }>;
  const related = relatedIds.slice(0, 15).map((row) => readOwnerClaim(workspaceId, row.id))
    .filter((item): item is ContextClaim => Boolean(item)).map(ownerClaimSummary);
  // All content-bearing fields remain behind owner cookie authentication. Existing source and history
  // readers are workspace-scoped; records are bounded for mobile responses.
  return {
    schemaVersion: CONTEXT_SEARCH_SCHEMA_VERSION, workspaceId,
    claim: ownerClaimSummary(claim),
    why: { eligibleForAI, blockers, reviewed: claim.reviewStatus, freshness: claim.freshness,
      validNow: (!claim.validFrom || claim.validFrom <= today) && (!claim.validTo || claim.validTo >= today),
      checkedAt: today, sourceCoverage: claim.sourceCoverage, evidenceCount: claim.evidenceCount },
    evidence: claim.evidenceItems.filter((item) => item.workspaceId === workspaceId && item.source.workspaceId === workspaceId).slice(0, 10),
    evidenceTruncated: claim.evidenceCount > 10,
    reviewEvents: listClaimReviewEvents(workspaceId, claimId).slice(0, 20),
    history: listClaimHistory(workspaceId, claimId).slice(0, 20),
    relations: related,
  };
}
