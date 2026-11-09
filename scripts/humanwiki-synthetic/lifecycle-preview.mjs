// Synthetic fixture lifecycle policy preview. No IO, persisted audit, or real data access.
// This does NOT enact pause, disconnect, consent revocation, or erasure.
import { previewSyntheticReviewQueue } from "./review-preview.mjs";

const fail = detail => { throw new Error(`Synthetic lifecycle: ${detail}`); };
const plainObject = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => plainObject(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const flags = Object.freeze({
  active: Object.freeze({
    would_allow_new_source_reads: true, would_allow_pending_review: true,
    would_invalidate_source_derivatives: false, retention_recheck_required: false,
    reimport_blocked_pending_new_consent: false, independent_witness_required: false,
  }),
  pause_sync: Object.freeze({
    would_allow_new_source_reads: false, would_allow_pending_review: true,
    would_invalidate_source_derivatives: false, retention_recheck_required: false,
    reimport_blocked_pending_new_consent: false, independent_witness_required: false,
  }),
  disconnect_source: Object.freeze({
    would_allow_new_source_reads: false, would_allow_pending_review: false,
    would_invalidate_source_derivatives: true, retention_recheck_required: false,
    reimport_blocked_pending_new_consent: true, independent_witness_required: false,
  }),
  revoke_import_consent: Object.freeze({
    would_allow_new_source_reads: false, would_allow_pending_review: false,
    would_invalidate_source_derivatives: true, retention_recheck_required: true,
    reimport_blocked_pending_new_consent: true, independent_witness_required: true,
  }),
  request_erasure: Object.freeze({
    would_allow_new_source_reads: false, would_allow_pending_review: false,
    would_invalidate_source_derivatives: true, retention_recheck_required: false,
    reimport_blocked_pending_new_consent: true, independent_witness_required: true,
  }),
});

/**
 * Read-only hypothetical policy snapshot for two bundled fictional source shapes.
 * Requests are NOT applied, consent/revocation records are NOT stored, and the
 * report includes no source text, fingerprints, or hidden segment locators.
 */
export function previewSyntheticSourceLifecycle(bundles, scenarios = []) {
  const queue = previewSyntheticReviewQueue(bundles);
  if (!Array.isArray(scenarios) || scenarios.length > queue.sources.length) {
    fail("invalid lifecycle scenarios");
  }
  const sourceIds = new Set(queue.sources.map(source => source.source_id));
  const actions = new Map();
  for (const scenario of scenarios) {
    if (!exactKeys(scenario, ["source_id", "action"]) ||
        typeof scenario.source_id !== "string" ||
        !Object.hasOwn(flags, scenario.action)) {
      fail("invalid lifecycle scenario");
    }
    if (!sourceIds.has(scenario.source_id)) fail("unknown lifecycle source");
    if (actions.has(scenario.source_id)) fail("duplicate lifecycle source");
    actions.set(scenario.source_id, scenario.action);
  }

  const source_states = queue.sources.map(source => {
    const action = actions.get(source.source_id) ?? "active";
    const status = flags[action];
    const visible_segments = status.would_allow_pending_review ? source.segments : 0;
    return {
      source_id: source.source_id, action, ...status,
      visible_segments,
      suppressed_segments: source.segments - visible_segments,
      // A simulation is never a completed disconnect/revocation/erase operation.
      operation_completed: false,
      durable_lifecycle_event_written: false,
      witness_confirmed: false,
    };
  });
  const bySource = new Map(source_states.map(source => [source.source_id, source]));
  const visible_entries = queue.entries
    .filter(entry => bySource.get(entry.locator.source_id).would_allow_pending_review)
    .map(entry => ({ ...entry, locator: { ...entry.locator } }));
  const suppressed_segments = source_states.reduce((n, state) => n + state.suppressed_segments, 0);
  if (visible_entries.length + suppressed_segments !== queue.segments_total) {
    fail("segment availability count mismatch");
  }

  return {
    synthetic_fixture_only: true,
    mode: "hypothetical_source_lifecycle_policy_only",
    scenarios_applied: actions.size,
    source_states,
    visible_entries,
    visible_segments: visible_entries.length,
    suppressed_segments,
    segments_total: queue.segments_total,
    source_content_served: false,
    actual_source_reads_performed: 0,
    claims_created: 0,
    review_outcomes_written: 0,
    durable_lifecycle_events_written: 0,
    tombstones_written: 0,
    real_import_enabled: false,
  };
}
