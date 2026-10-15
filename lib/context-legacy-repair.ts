import { createHash } from "node:crypto";
import { runContextCommand, stableStringify } from "./context-commands";
import { readOwnerClaim, type ClaimSensitivity } from "./context-claims";
import { activeEvidenceByClaim, applyLegacySourceEvidence, claimEvidence, legacyProjection, reprojectClaimJson, setSourceCoverageForRepair, sourceSharedWithOtherClaims, type ClaimEvidenceMetadata, type ClaimSourceMetadata } from "./context-sources";
import { getDatabase } from "./server-store";
import { randomUUID } from "node:crypto";

// A binary from before the evidence records keeps writing the JSON source/evidence of a claim. At every start the
// records are brought in line with a JSON that no longer reads as the records project: the newest evidence is replaced
// (or, when the older binary cleared the source, the active evidence is archived), the claim returns to review with a new
// revision, and the change is recorded as a system event so history and Undo stay consistent. Once reconciled the JSON
// is rewritten from the records, so a second start changes nothing.

const sourceKeys = ["provider", "externalId", "locator", "author", "authorRole", "sourceAt", "ingestedAt"] as const;
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
const coverageRank: Record<string, number> = { metadata: 1, excerpt: 2, body: 3 };
const rank = (coverage: string | null | undefined) => coverageRank[coverage ?? ""] ?? 0;
const withoutCoverage = (value: ClaimSourceMetadata | null) => {
  if (!value) return null;
  const { coverage: _coverage, ...rest } = value;
  return normalise(JSON.stringify(rest), sourceKeys);
};

/**
 * The coverage a JSON edit asks for, or undefined when there is nothing to change. A source cited only by this claim follows the
 * JSON (raise or lower); a shared source is only ever raised, because one claim's JSON must not weaken what others rest on.
 */
function wantedCoverage(stored: ClaimSourceMetadata | null, projection: ClaimSourceMetadata | null, shared: boolean) {
  const wanted = stored?.coverage;
  if (!wanted || !projection || wanted === projection.coverage) return undefined;
  return shared ? (rank(wanted) > rank(projection.coverage) ? wanted : undefined) : wanted;
}

export function reconcileLegacyClaimJson() {
  const database = getDatabase();
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (!tables.has("context_evidence")) return 0;
  const rows = database.prepare(`SELECT id, workspace_id, sensitivity, source_metadata, evidence_metadata FROM context_claims WHERE archived_at IS NULL ORDER BY workspace_id, recorded_at, rowid`)
    .all() as Array<{ id: string; workspace_id: string; sensitivity: string; source_metadata: string | null; evidence_metadata: string | null }>;
  const byWorkspace = new Map<string, ReturnType<typeof activeEvidenceByClaim>>();
  let reconciled = 0;
  for (const row of rows) {
    if (!byWorkspace.has(row.workspace_id)) byWorkspace.set(row.workspace_id, activeEvidenceByClaim(row.workspace_id));
    const items = byWorkspace.get(row.workspace_id)!.get(row.id) ?? [];
    // No active evidence reads as a null projection, but a claim that never had a record is left to the conversion.
    if (!items.length && !database.prepare("SELECT 1 FROM context_evidence WHERE claim_id = ? LIMIT 1").get(row.id)) continue;
    const projection = legacyProjection(items);
    const stored = { source: normalise(row.source_metadata, [...sourceKeys, "coverage"]) as ClaimSourceMetadata | null, evidence: normalise(row.evidence_metadata, evidenceKeys) as ClaimEvidenceMetadata | null };
    const primary = items[0];
    const shared = primary ? sourceSharedWithOtherClaims(row.workspace_id, primary.sourceId, row.id) : false;
    const coverageWanted = wantedCoverage(stored.source, projection.source, shared);
    const same = coverageWanted === undefined && stableStringify({ source: withoutCoverage(stored.source), evidence: stored.evidence }) ===
      stableStringify({ source: withoutCoverage(projection.source), evidence: normalise(JSON.stringify(projection.evidence), evidenceKeys) });
    if (same) continue;
    try {
      runContextCommand({
        operation: "claim.legacy_reconcile", actor: "system", workspaceId: row.workspace_id,
        // The identity names the JSON and what the records read now, so every new divergence is repaired, also one that
        // returns to an earlier JSON after the records moved on.
        commandId: `legacy-reconcile:${row.id}:${createHash("sha256").update(stableStringify({ stored, projection })).digest("hex").slice(0, 32)}`,
        request: { claimId: row.id, stored },
        mutate: () => {
          const before = readOwnerClaim(row.workspace_id, row.id)!;
          const now = Date.now();
          // Raising coverage comes before the evidence (an excerpt may rely on it); lowering after (the excerpt may be gone).
          const wanted = coverageWanted as "metadata" | "excerpt" | "body" | undefined;
          const raising = Boolean(stored.source && primary && wanted && rank(wanted) > rank(projection.source?.coverage));
          if (raising) setSourceCoverageForRepair(row.workspace_id, primary!.sourceId, wanted!);
          if (stored.source) {
            applyLegacySourceEvidence({ workspaceId: row.workspace_id, claimId: row.id, claimSensitivity: (row.sensitivity === "sensitive" ? "confidential" : row.sensitivity) as ClaimSensitivity,
              // Coverage is settled separately; the rest of the edit is applied against the source as it reads at this point.
              source: { ...stored.source, ...(raising ? { coverage: wanted } : projection.source?.coverage ? { coverage: projection.source.coverage } : {}) } as ClaimSourceMetadata, evidence: stored.evidence });
            const newest = claimEvidence(row.workspace_id, row.id)[0];
            if (newest && wanted && !raising && newest.source.coverage !== wanted) setSourceCoverageForRepair(row.workspace_id, newest.sourceId, wanted);
          } else {
            database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE claim_id = ? AND archived_at IS NULL").run(now, now, row.id);
          }
          // The claim may already have moved to review through a coverage change of its source.
          const current = readOwnerClaim(row.workspace_id, row.id)!;
          database.prepare("UPDATE context_claims SET review_status = 'proposed', revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?").run(now, row.id, row.workspace_id);
          if (current.reviewStatus !== "proposed") {
            database.prepare(`INSERT INTO context_review_events (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
              VALUES (?, ?, ?, ?, 'system', 'proposed', 'legacy-reconcile', ?)`).run(randomUUID(), row.workspace_id, row.id, current.revision + 1, now);
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
