import { evaluateAttention, ongoingConditions, type AttentionClaimActivity } from "./attention";
import { reconcileAttention } from "./attention-lifecycle";
import { listOwnerClaims } from "./context-claims";
import { getDatabase, type StoreSnapshot } from "./server-store";

// Shared by the attention API and the attention notification scheduler so both evaluate the same way.

export function activeWorkspaces(snapshot: StoreSnapshot): string[] {
  return [...new Set(snapshot.entities.filter((entity) => entity.type === "workspace" && entity.status === "active").map((entity) => entity.workspaceId))];
}

export function evaluateWorkspace(snapshot: StoreSnapshot, workspaceId: string, timezone: string, evaluatedAt: number) {
  const claims: AttentionClaimActivity[] = listOwnerClaims(workspaceId).filter((claim) => claim.reviewStatus === "confirmed" && claim.archivedAt === null && claim.subject.canonicalEntityId)
    .map((claim) => ({ id: claim.id, workspaceId, projectId: claim.subject.canonicalEntityId!, predicate: claim.predicate,
      revision: claim.revision, updatedAt: claim.updatedAt, confirmed: true, current: claim.freshness === "current" }));
  return evaluateAttention({ entities: snapshot.entities, relations: snapshot.relations, claims, workspaceId, timezone, evaluatedAt, dataRevision: snapshot.revision });
}

// Evaluates a workspace and brings the stored states up to date.
export function reconcileWorkspace(snapshot: StoreSnapshot, workspaceId: string, timezone: string, evaluatedAt: number) {
  const candidates = evaluateWorkspace(snapshot, workspaceId, timezone, evaluatedAt);
  return { candidates, ...reconcileAttention(workspaceId, candidates, evaluatedAt, ongoingConditions(snapshot.entities, workspaceId)) };
}

export function withAttentionTransaction<T>(work: () => T): T {
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
