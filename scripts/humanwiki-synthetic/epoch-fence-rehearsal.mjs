// Offline optimistic-fence rehearsal on fictional fixtures only.
// No mutable store, transaction, independent epoch service, real witness,
// persistence, API, graph release or actual deletion. NOT a production CAS.
import { makeSyntheticDerivativeFixture } from "./derivative-impact-preview.mjs";
import {
  bindSyntheticDerivativeRevision, recheckSyntheticDerivativeRevision,
} from "./derivative-revision.mjs";

const fail = why => { throw new Error("Synthetic epoch fence: " + why); };
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
   Object.getPrototypeOf(value) === null);
const exact = (value, keys) => plain(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const validEpoch = value => Number.isSafeInteger(value) && value >= 0;
const epochSchema = "fictional_dependency_epoch_fence_v1";
const revisionSchema = "fictional_dependency_revision_v1";
const common = Object.freeze({
  synthetic_fixture_only: true,
  mode: "offline_optimistic_epoch_fence_rehearsal_only",
  source_or_graph_details_disclosed: false,
  any_hash_disclosed: false,
  real_monotonic_epoch_authenticated: false,
  actual_compare_and_swap_performed: false,
  actual_witness_contacted: false,
  actual_deletions_performed: 0,
  actual_invalidation_performed: 0,
  actual_replay_performed: false,
  data_release_authorized: false,
  real_import_enabled: false,
});

function checkFrame(frame) {
  if (!exact(frame, ["toy_epoch", "restore_state", "graph"]) ||
      !validEpoch(frame.toy_epoch)) fail("malformed fictional frame");
}
function checkToken(token) {
  if (!exact(token, ["schema", "toy_epoch", "revision"]) ||
      token.schema !== epochSchema || !validEpoch(token.toy_epoch) ||
      !exact(token.revision, ["schema", "toy_restore_digest", "toy_graph_digest"]) ||
      token.revision.schema !== revisionSchema ||
      !hex(token.revision.toy_restore_digest) || !hex(token.revision.toy_graph_digest)) {
    fail("malformed fictional fence binding");
  }
}

/** Create a tiny toy binding after *fresh* restore/witness and graph checks. */
export function bindSyntheticEpochFence(frame) {
  checkFrame(frame);
  return {
    schema: epochSchema,
    toy_epoch: frame.toy_epoch,
    revision: bindSyntheticDerivativeRevision(frame.restore_state, frame.graph),
  };
}

/**
 * Recheck a complete current toy frame. A caller-controlled toy_epoch is only
 * a stand-in for an authoritative, atomic monotonic generation; it cannot
 * detect a real ABA if the counter is reverted or not incremented.
 */
export function recheckSyntheticEpochFence(frame, binding) {
  checkToken(binding);
  checkFrame(frame);
  const result = recheckSyntheticDerivativeRevision(
    frame.restore_state, frame.graph, binding.revision,
  );
  const revision_status = result.revision_status;
  const blocked = revision_status === "blocked_by_current_preflight_or_coverage";
  const matches = revision_status === "toy_revision_matches_no_release" &&
    frame.toy_epoch === binding.toy_epoch;
  return {
    ...common,
    fence_status: blocked ? "blocked_by_current_preflight_or_coverage" :
      matches ? "toy_fence_matches_no_release" : "stale_toy_epoch_or_revision",
    toy_binding_matches_current: matches,
  };
}

/**
 * Demonstrate a two-check window, including an *intervening* revision change.
 * The final check is NOT atomic with real use and this never commits anything.
 */
export function rehearseSyntheticFenceWindow(firstFrame, finalFrame, binding) {
  const first = recheckSyntheticEpochFence(firstFrame, binding);
  // We never look at the second frame after a rejected first-stage check:
  // blocked/stale data should not be inspected or disclosed.
  if (!first.toy_binding_matches_current) {
    return {
      ...common,
      window_status: "would_abort_at_first_check",
      first_check: first.fence_status,
      final_check: "not_evaluated",
    };
  }
  const final = recheckSyntheticEpochFence(finalFrame, binding);
  // A replayed older epoch is itself rejected, including when a digest
  // appears to match. This is a toy monotonic assumption only.
  const rollback = exact(finalFrame, ["toy_epoch", "restore_state", "graph"]) &&
    validEpoch(finalFrame.toy_epoch) && finalFrame.toy_epoch < firstFrame.toy_epoch;
  return {
    ...common,
    window_status: rollback ? "would_abort_epoch_rollback" :
      final.toy_binding_matches_current ? "toy_checks_match_no_commit" :
      "would_abort_at_final_check",
    first_check: first.fence_status,
    final_check: final.fence_status,
  };
}

/** Tiny fixed test frame (not an authorized store snapshot). */
export function makeSyntheticEpochFenceFixture(restoreState, epoch = 1) {
  if (!validEpoch(epoch)) fail("malformed fictional epoch");
  return {
    toy_epoch: epoch,
    restore_state: restoreState,
    graph: makeSyntheticDerivativeFixture(),
  };
}
