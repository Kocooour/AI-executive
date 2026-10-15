import { randomUUID } from "node:crypto";
import { assertCommandWorkspace, contextIdPattern, ContextCommandError, requireChanged, runContextCommand, stableStringify, type CommandHooks } from "./context-commands";
import { readOwnerClaim, type ClaimReviewStatus, type ContextClaim } from "./context-claims";
import {
  assertEvidenceFitsSource, claimEvidenceStoredLimit, cleanEvidenceFields, ContextSourceError, evidenceFingerprint, getContextSource,
  hasContentCoverage, readEvidence, reprojectClaimJson, type ClaimEvidenceItem,
} from "./context-sources";
import { getDatabase } from "./server-store";

// Evidence commands: add, update and archive one evidence record of a claim. Evidence is what a claim stands on, so
// any change to it returns the claim to "proposed" (a new claim revision and a review event) in the same transaction.
// The change event belongs to the evidence (object type "evidence") and also names the claim and the revision the
// claim reached, which is how Undo of a later claim step still finds the claim at the revision it expects.

export interface ClaimSummary {
  id: string;
  revision: number;
  reviewStatus: ClaimReviewStatus;
  predicate: string;
  subjectTitle: string;
  subjectType: string;
}

/** What an evidence event records on each side: the evidence (null before it was added) and the claim it belongs to. */
export interface EvidenceStepPayload {
  evidence: ClaimEvidenceItem | null;
  claim: ClaimSummary;
}

export function summarizeClaim(claim: ContextClaim): ClaimSummary {
  return { id: claim.id, revision: claim.revision, reviewStatus: claim.reviewStatus, predicate: claim.predicate,
    subjectTitle: claim.subject.title, subjectType: claim.subject.type };
}

const idPattern = contextIdPattern;

export interface AddEvidenceInput {
  commandId: string; workspaceId: string; id: string; claimId: string; expectedClaimRevision: number; expectedRevision: 0;
  sourceId: string; locator?: string | null; excerpt?: string | null; stance?: string | null;
}
export interface UpdateEvidenceInput {
  commandId: string; workspaceId: string; id: string; expectedRevision: number;
  sourceId: string; locator?: string | null; excerpt?: string | null; stance?: string | null;
}
export interface ArchiveEvidenceInput { commandId: string; workspaceId: string; id: string; expectedRevision: number }

/** The claim goes back to "proposed" with a new revision; a review event is left when its review state changed. */
function returnClaimToReview(workspaceId: string, claim: ContextClaim, target: ClaimReviewStatus, reason: string) {
  const database = getDatabase();
  const now = Date.now();
  requireChanged(database.prepare(`UPDATE context_claims SET review_status = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND revision = ?`).run(target, now, claim.id, workspaceId, claim.revision), "Claim changed on another device");
  reprojectClaimJson(workspaceId, claim.id);
  if (target !== claim.reviewStatus) {
    database.prepare(`INSERT INTO context_review_events
      (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`)
      .run(randomUUID(), workspaceId, claim.id, claim.revision + 1, target, reason, now);
  }
}

function liveClaim(workspaceId: string, claimId: string) {
  if (!idPattern.test(String(claimId))) throw new ContextSourceError("Claim identifier is invalid");
  const claim = readOwnerClaim(workspaceId, claimId);
  if (!claim) throw new ContextSourceError("Claim not found", 404, "not_found");
  if (claim.archivedAt) throw new ContextSourceError("Archived claims cannot change their evidence", 409, "archived");
  return claim;
}

function liveSource(workspaceId: string, sourceId: string) {
  if (!idPattern.test(String(sourceId))) throw new ContextSourceError("Source identifier is invalid", 400, "invalid_source");
  let source;
  try { source = getContextSource(workspaceId, sourceId); } catch {
    throw new ContextSourceError("Evidence must cite a source in the same workspace", 400, "invalid_source");
  }
  if (source.archivedAt) throw new ContextSourceError("Archived sources cannot be cited", 409, "archived_source");
  return source;
}

function activeCount(workspaceId: string, claimId: string, exceptId?: string) {
  const row = getDatabase().prepare(`SELECT COUNT(*) AS count FROM context_evidence WHERE workspace_id = ? AND claim_id = ?
    AND archived_at IS NULL AND id != ?`).get(workspaceId, claimId, exceptId ?? "") as { count: number };
  return Number(row.count);
}

function assertNoDuplicate(workspaceId: string, claimId: string, exceptId: string, fields: { sourceId: string; locator: string | null; excerpt: string | null }) {
  const duplicate = getDatabase().prepare(`SELECT 1 FROM context_evidence WHERE workspace_id = ? AND claim_id = ? AND source_id = ?
    AND COALESCE(locator, '') = ? AND COALESCE(excerpt, '') = ? AND archived_at IS NULL AND id != ?`)
    .get(workspaceId, claimId, fields.sourceId, fields.locator ?? "", fields.excerpt ?? "", exceptId);
  if (duplicate) throw new ContextSourceError("This claim already has this evidence", 409, "duplicate_evidence");
}

type EvidenceOperation = "add" | "update" | "archive";

function runEvidenceCommand(operation: EvidenceOperation, input: AddEvidenceInput | UpdateEvidenceInput | ArchiveEvidenceInput, hooks?: CommandHooks) {
  if (!idPattern.test(input.commandId) || !idPattern.test(String(input.id))) throw new ContextSourceError("Invalid command or evidence identifier");
  assertCommandWorkspace(input.workspaceId);
  const fields = operation === "archive" ? null : cleanEvidenceFields(input as AddEvidenceInput);
  const request = { ...input, ...(fields ?? {}) };
  return runContextCommand({
    operation: `evidence.${operation}`, commandId: input.commandId, workspaceId: input.workspaceId, request, hooks,
    mutate: () => {
      const database = getDatabase();
      const now = Date.now();
      let before: ClaimEvidenceItem | null = null;
      let claimBefore: ContextClaim;
      let changed = true;
      if (operation === "add") {
        const add = input as AddEvidenceInput;
        claimBefore = liveClaim(input.workspaceId, add.claimId);
        if (claimBefore.revision !== Number(add.expectedClaimRevision)) throw new ContextSourceError("Claim changed on another device", 409, "revision_conflict");
        if (Number(add.expectedRevision) !== 0) throw new ContextSourceError("New evidence requires revision 0", 409, "revision_conflict");
        if (database.prepare("SELECT 1 FROM context_evidence WHERE id = ?").get(add.id)) throw new ContextSourceError("Evidence ID already exists", 409, "evidence_exists");
        const source = liveSource(input.workspaceId, add.sourceId);
        assertEvidenceFitsSource(source, fields!);
        if (activeCount(input.workspaceId, add.claimId) >= claimEvidenceStoredLimit) throw new ContextSourceError("This claim already has the most evidence it can hold", 409, "evidence_limit");
        assertNoDuplicate(input.workspaceId, add.claimId, add.id, { sourceId: add.sourceId, ...fields! });
        database.prepare(`INSERT INTO context_evidence (id, workspace_id, revision, claim_id, source_id, locator, excerpt, stance, created_at, updated_at, archived_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(add.id, input.workspaceId, add.claimId, add.sourceId, fields!.locator, fields!.excerpt, fields!.stance, now, now);
      } else {
        before = readEvidence(input.workspaceId, input.id);
        if (!before) throw new ContextSourceError("Evidence not found", 404, "not_found");
        claimBefore = liveClaim(input.workspaceId, before.claimId);
        if (before.revision !== Number(input.expectedRevision)) throw new ContextSourceError("Evidence changed on another device", 409, "revision_conflict");
        if (operation === "archive") {
          if (before.archivedAt) changed = false;
          else database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?").run(now, now, input.id, input.workspaceId);
        } else {
          const update = input as UpdateEvidenceInput;
          if (before.archivedAt) throw new ContextSourceError("Archived evidence cannot be edited", 409, "archived");
          const source = liveSource(input.workspaceId, update.sourceId);
          const next = { sourceId: update.sourceId, locator: fields!.locator, excerpt: fields!.excerpt, stance: fields!.stance, archivedAt: null };
          changed = stableStringify(evidenceFingerprint(next)) !== stableStringify(evidenceFingerprint(before));
          if (changed) {
            assertEvidenceFitsSource(source, fields!);
            assertNoDuplicate(input.workspaceId, before.claimId, input.id, { sourceId: update.sourceId, ...fields! });
            requireChanged(database.prepare(`UPDATE context_evidence SET source_id = ?, locator = ?, excerpt = ?, stance = ?, revision = revision + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND revision = ?`).run(update.sourceId, fields!.locator, fields!.excerpt, fields!.stance, now, input.id, input.workspaceId, before.revision),
              "Evidence changed on another device");
          }
        }
      }
      const evidence = readEvidence(input.workspaceId, input.id)!;
      if (!changed) {
        return { result: { evidence, claim: claimBefore }, objectId: input.id, operation: `evidence.${operation}`, objectType: "evidence" as const, changed: false,
          before: null, after: { revision: evidence.revision, payload: { evidence, claim: summarizeClaim(claimBefore) } } };
      }
      returnClaimToReview(input.workspaceId, claimBefore, "proposed", "evidence");
      const claim = readOwnerClaim(input.workspaceId, claimBefore.id)!;
      return { result: { evidence, claim }, objectId: input.id, operation: `evidence.${operation}`, objectType: "evidence" as const, changed: true,
        claimId: claim.id, claimRevision: claim.revision,
        before: { revision: before?.revision ?? 0, payload: { evidence: before, claim: summarizeClaim(claimBefore) } satisfies EvidenceStepPayload },
        after: { revision: evidence.revision, payload: { evidence, claim: summarizeClaim(claim) } satisfies EvidenceStepPayload } };
    },
  });
}

export const addClaimEvidence = (input: AddEvidenceInput, hooks?: CommandHooks) => runEvidenceCommand("add", input, hooks);
export const updateClaimEvidence = (input: UpdateEvidenceInput, hooks?: CommandHooks) => runEvidenceCommand("update", input, hooks);
export const archiveClaimEvidence = (input: ArchiveEvidenceInput, hooks?: CommandHooks) => runEvidenceCommand("archive", input, hooks);

/**
 * Undo/Redo of one evidence step, as new revisions of the evidence and its claim. `after` is the state the reversed
 * step left behind: the evidence must still read exactly so, and the claim must be at `expectedClaimRevision`
 * (the newest revision any event recorded for it) with the review state the step left it in. The evidence then goes
 * to the state the step started from (a step that added it is reversed by archiving it) and the claim to the review
 * state it had before. Must run inside a context command.
 */
export function compensateEvidence(input: { workspaceId: string; id: string; mode: "undo" | "redo"; expectedClaimRevision: number;
  before: EvidenceStepPayload; after: EvidenceStepPayload }) {
  const conflict = (message: string) => new ContextCommandError(message, 409, "undo_conflict");
  const current = readEvidence(input.workspaceId, input.id);
  if (!current || !input.after.evidence) throw conflict("The evidence no longer exists");
  if (stableStringify(evidenceFingerprint(current)) !== stableStringify(evidenceFingerprint(input.after.evidence))) {
    throw conflict("The evidence was changed after this step");
  }
  const claim = readOwnerClaim(input.workspaceId, current.claimId);
  if (!claim || claim.archivedAt) throw conflict("The claim of this evidence is archived or gone");
  if (claim.revision !== input.expectedClaimRevision || claim.reviewStatus !== input.after.claim.reviewStatus) {
    throw conflict("The claim was changed after this step");
  }
  const target = input.before.evidence ?? { ...input.after.evidence, archivedAt: current.archivedAt ?? Date.now() };
  if (target.archivedAt == null) {
    // The evidence comes back: its source must still be live and still allow what the evidence carries.
    const source = getDatabase().prepare("SELECT coverage, archived_at FROM context_sources WHERE id = ? AND workspace_id = ?")
      .get(target.sourceId, input.workspaceId) as { coverage: string | null; archived_at: number | null } | undefined;
    if (!source || source.archived_at != null) throw conflict("The source of this evidence is archived or gone");
    if ((target.excerpt || target.locator) && !hasContentCoverage(source.coverage)) throw conflict("The source of this evidence no longer has content coverage");
    if (current.archivedAt != null && activeCount(input.workspaceId, current.claimId) >= claimEvidenceStoredLimit) throw conflict("The claim already has the most evidence it can hold");
  }
  const now = Date.now();
  getDatabase().prepare(`UPDATE context_evidence SET source_id = ?, locator = ?, excerpt = ?, stance = ?, archived_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(target.sourceId, target.locator, target.excerpt, target.stance, target.archivedAt == null ? null : (current.archivedAt ?? now), now, input.id, input.workspaceId);
  returnClaimToReview(input.workspaceId, claim, input.before.claim.reviewStatus, input.mode);
  return { evidence: readEvidence(input.workspaceId, input.id)!, claim: readOwnerClaim(input.workspaceId, claim.id)!,
    before: { evidence: current, claim: summarizeClaim(claim) } satisfies EvidenceStepPayload };
}
