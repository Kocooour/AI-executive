import { createHash } from "node:crypto";
import { runContextCommand, stableStringify } from "./context-commands";
import { readOwnerClaim, type ClaimSensitivity } from "./context-claims";
import { activeEvidenceByClaim, applyLegacySourceEvidence, legacyProjection, reprojectClaimJson, type ClaimEvidenceMetadata, type ClaimSourceMetadata } from "./context-sources";
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
// Coverage is left out of the comparison: a shared source keeps the strongest coverage of the claims that share it, which can
// differ from one claim's own JSON without anything having been edited.
const withoutCoverage = (value: ClaimSourceMetadata | null) => {
  if (!value) return null;
  const { coverage: _coverage, ...rest } = value;
  return normalise(JSON.stringify(rest), sourceKeys);
};

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
    if (!items.length) continue; // no records yet: the conversion handles it
    const projection = legacyProjection(items);
    const stored = { source: normalise(row.source_metadata, [...sourceKeys, "coverage"]) as ClaimSourceMetadata | null, evidence: normalise(row.evidence_metadata, evidenceKeys) as ClaimEvidenceMetadata | null };
    const same = stableStringify({ source: withoutCoverage(stored.source), evidence: stored.evidence }) ===
      stableStringify({ source: withoutCoverage(projection.source), evidence: normalise(JSON.stringify(projection.evidence), evidenceKeys) });
    if (same) continue;
    try {
      runContextCommand({
        operation: "claim.legacy_reconcile", actor: "system", workspaceId: row.workspace_id,
        commandId: `legacy-reconcile:${row.id}:${createHash("sha256").update(stableStringify(stored)).digest("hex").slice(0, 32)}`,
        request: { claimId: row.id, stored },
        mutate: () => {
          const before = readOwnerClaim(row.workspace_id, row.id)!;
          const now = Date.now();
          if (stored.source) {
            applyLegacySourceEvidence({ workspaceId: row.workspace_id, claimId: row.id, claimSensitivity: (row.sensitivity === "sensitive" ? "confidential" : row.sensitivity) as ClaimSensitivity,
              source: stored.source, evidence: stored.evidence });
          } else {
            database.prepare("UPDATE context_evidence SET archived_at = ?, revision = revision + 1, updated_at = ? WHERE claim_id = ? AND archived_at IS NULL").run(now, now, row.id);
          }
          database.prepare("UPDATE context_claims SET review_status = 'proposed', revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?").run(now, row.id, row.workspace_id);
          if (before.reviewStatus !== "proposed") {
            database.prepare(`INSERT INTO context_review_events (id, workspace_id, claim_id, claim_revision, actor, decision, reason, created_at)
              VALUES (?, ?, ?, ?, 'system', 'proposed', 'legacy-reconcile', ?)`).run(randomUUID(), row.workspace_id, row.id, before.revision + 1, now);
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
