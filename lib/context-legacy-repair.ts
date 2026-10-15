import { createHash, randomUUID } from "node:crypto";
import { runContextCommand, stableStringify } from "./context-commands";
import { readOwnerClaim, type ClaimSensitivity } from "./context-claims";
import { activeEvidenceByClaim, legacyProjection, rebuildClaimEvidenceFromLegacy, reprojectClaimJson, type ClaimEvidenceMetadata, type ClaimSourceMetadata } from "./context-sources";
import { getDatabase } from "./server-store";

// A binary from before the evidence records keeps writing the JSON source/evidence of a claim, and bumps the claim's revision
// when it does. Every command of this release marks the claims it writes with `legacy_synced_revision = revision`, so a claim
// whose revision differs from that mark was edited by an older binary. At every start such a claim whose JSON no longer reads
// as its records is rebuilt from the JSON in one command: the claim returns to review with a new revision and a `system`
// change event `claim.legacy_reconcile` (which Undo can reverse). The command identity is claim + revision + JSON, and the
// revision only grows, so a cycle of edits (A, then B, then A again) is a new reconciliation each time and one start never
// repairs a claim twice. A claim whose JSON already reads like its records is just marked.

const sourceKeys = ["provider", "externalId", "locator", "author", "authorRole", "sourceAt", "ingestedAt", "coverage"] as const;
const evidenceKeys = ["locator", "excerpt", "stance"] as const;

function normalise(text: string | null, keys: readonly string[]) {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const key of keys) if (typeof value[key] === "string" && value[key] !== "") out[key] = value[key] as string;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export function reconcileLegacyClaimJson() {
  const database = getDatabase();
  const columns = new Set((database.prepare("PRAGMA table_info(context_claims)").all() as Array<{ name?: string }>).map((row) => String(row.name)));
  if (!columns.has("legacy_synced_revision")) return 0;
  const rows = database.prepare(`SELECT id, workspace_id, sensitivity, revision, source_metadata, evidence_metadata FROM context_claims
    WHERE archived_at IS NULL AND legacy_synced_revision IS NOT revision ORDER BY workspace_id, recorded_at, rowid`)
    .all() as Array<{ id: string; workspace_id: string; sensitivity: string; revision: number; source_metadata: string | null; evidence_metadata: string | null }>;
  const byWorkspace = new Map<string, ReturnType<typeof activeEvidenceByClaim>>();
  const mark = database.prepare("UPDATE context_claims SET legacy_synced_revision = revision WHERE id = ? AND revision = ?");
  let reconciled = 0;
  for (const row of rows) {
    // A claim that never had a record is the conversion's.
    if (!database.prepare("SELECT 1 FROM context_evidence WHERE claim_id = ? LIMIT 1").get(row.id)) continue;
    if (!byWorkspace.has(row.workspace_id)) byWorkspace.set(row.workspace_id, activeEvidenceByClaim(row.workspace_id));
    const projection = legacyProjection(byWorkspace.get(row.workspace_id)!.get(row.id) ?? []);
    const stored = { source: normalise(row.source_metadata, sourceKeys) as ClaimSourceMetadata | null, evidence: normalise(row.evidence_metadata, evidenceKeys) as ClaimEvidenceMetadata | null };
    const current = { source: normalise(JSON.stringify(projection.source), sourceKeys), evidence: normalise(JSON.stringify(projection.evidence), evidenceKeys) };
    if (stableStringify(stored) === stableStringify(current)) { mark.run(row.id, row.revision); continue; }
    try {
      runContextCommand({
        operation: "claim.legacy_reconcile", actor: "system", workspaceId: row.workspace_id,
        commandId: `legacy-reconcile:${row.id}:${row.revision}:${createHash("sha256").update(stableStringify(stored)).digest("hex").slice(0, 24)}`,
        request: { claimId: row.id, revision: row.revision, stored },
        mutate: () => {
          const before = readOwnerClaim(row.workspace_id, row.id)!;
          const now = Date.now();
          rebuildClaimEvidenceFromLegacy({ workspaceId: row.workspace_id, claimId: row.id,
            claimSensitivity: (row.sensitivity === "sensitive" ? "confidential" : row.sensitivity) as ClaimSensitivity, source: stored.source, evidence: stored.evidence });
          // The claim may already have moved to review through a coverage change of its source.
          const latest = readOwnerClaim(row.workspace_id, row.id)!;
          database.prepare("UPDATE context_claims SET review_status = 'proposed', revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?").run(now, row.id, row.workspace_id);
          if (latest.reviewStatus !== "proposed") {
            database.prepare(`INSERT INTO context_review_events (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
              VALUES (?, ?, ?, ?, 'system', 'proposed', 'legacy-reconcile', ?)`).run(randomUUID(), row.workspace_id, row.id, latest.revision + 1, now);
          }
          reprojectClaimJson(row.workspace_id, row.id);
          const claim = readOwnerClaim(row.workspace_id, row.id)!;
          return { result: { claim }, objectId: row.id, operation: "claim.legacy_reconcile", changed: true,
            before: { revision: before.revision, payload: before }, after: { revision: claim.revision, payload: claim } };
        },
      });
      reconciled += 1;
    } catch (error) {
      console.error(`Legacy source reconciliation skipped claim ${row.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return reconciled;
}
