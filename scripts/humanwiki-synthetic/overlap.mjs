// Synthetic-only duplicate-text preview: no canonical claims or real-export entrypoint.
// SHA-256 is used only to compare fictional segments inside this offline laboratory.
import { parseSyntheticBundle, advanceSyntheticImport } from "./ingest.mjs";

const fail = detail => { throw new Error(`Synthetic overlap: ${detail}`); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const provenance = new Set([
  "owner_statement", "assistant_generated", "quoted_third_party", "unknown",
]);

/**
 * Compare exactly two synthetic bundles. Every occurrence remains a separate,
 * proposed, unclassified source segment; matching text is NOT independent proof.
 * This intentionally never returns raw text or content fingerprints.
 */
export function previewSyntheticOverlaps(bundles) {
  if (!Array.isArray(bundles) || bundles.length !== 2) fail("exactly two synthetic bundles required");
  const sources = bundles.map(bundle => parseSyntheticBundle(bundle))
    .sort((a, b) => compare(a.source_id, b.source_id));
  if (sources[0].source_id === sources[1].source_id) fail("duplicate source identity");

  const occurrences = new Map();
  const summaries = [];
  for (const source of sources) {
    const state = advanceSyntheticImport(source);
    summaries.push({
      source_id: source.source_id,
      format: source.format,
      messages: source.messages.length,
      segments: state.records.length,
    });
    for (const record of state.records) {
      if (!provenance.has(record.provenance) ||
          record.review !== "proposed" || record.sensitivity !== "unclassified" ||
          record.scope !== "owner_private_unassigned") {
        fail("unexpected synthetic provenance or review state");
      }
      const member = {
        locator: { ...record.locator },
        observed_at: record.observed_at,
        speaker: record.speaker,
        enclosing_message_speaker: record.enclosing_message_speaker,
        provenance: record.provenance,
        review: record.review,
        sensitivity: record.sensitivity,
      };
      const group = occurrences.get(record.content_sha256);
      if (group) group.push(member);
      else occurrences.set(record.content_sha256, [member]);
    }
  }

  const duplicates = [...occurrences.values()].filter(members => members.length > 1);
  const groups = duplicates.map((members, index) => ({
    id: `synthetic-duplicate-${index + 1}`, // Ephemeral preview ID; not a canonical graph key.
    match: "exact_segment_text_after_quote_marker_normalization",
    cross_source: new Set(members.map(m => m.locator.source_id)).size > 1,
    independent_evidence: false,
    review: "proposed",
    members,
  }));
  return {
    synthetic_fixture_only: true,
    sources: summaries,
    segments_total: summaries.reduce((sum, source) => sum + source.segments, 0),
    duplicate_groups: groups.length,
    cross_source_duplicate_groups: groups.filter(group => group.cross_source).length,
    repeated_segment_occurrences: groups.reduce((sum, group) => sum + group.members.length, 0),
    groups,
    claims_created: 0,
    real_import_enabled: false,
  };
}
