// In-memory restore preflight *rehearsal* using only tiny fictional event metadata.
// No actual witness, durable registry, secrets, import, release, deletion, or IO.
// Unkeyed hashes are valid here only to detect tampering in the toy example.
import { createHash } from "node:crypto";

const fail = reason => { throw new Error("Synthetic restore: " + reason); };
const GENESIS = "0".repeat(64);
const hash = value => createHash("sha256").update(value).digest("hex");
const digestFormat = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value, list) => plain(value) &&
  Reflect.ownKeys(value).length === list.length &&
  list.every(key => Object.hasOwn(value, key));
const actions = new Set(["request_erasure", "revoke_import_consent"]);
const sourceIds = new Set(["fictional-source-a", "fictional-source-b"]);
const eventDigest = event => hash(JSON.stringify([
  event.sequence, event.opaque_source_id, event.action, event.previous_digest,
]));

/** Deterministic fictional metadata; NOT a privacy-safe production registry or witness. */
export function makeSyntheticRestoreFixture() {
  const registry = [];
  for (const [opaque_source_id, action] of [
    ["fictional-source-a", "request_erasure"],
    ["fictional-source-b", "revoke_import_consent"],
  ]) {
    const event = {
      sequence: registry.length + 1,
      opaque_source_id,
      action,
      previous_digest: registry.at(-1)?.digest ?? GENESIS,
    };
    registry.push({ ...event, digest: eventDigest(event) });
  }
  return {
    snapshot: { applied_sequence: 0, applied_digest: GENESIS },
    registry,
    witness: { sequence: registry.length, digest: registry.at(-1).digest },
    toy_independent_witness_verified: true,
    toy_key_available: true,
  };
}

function block(reason) {
  return {
    synthetic_fixture_only: true,
    mode: "offline_restore_preflight_rehearsal",
    preflight_status: "blocked",
    reason,
    pending_replay_events: [],
    pending_replay_count: 0,
    replay_completed: false,
    actual_restore_applied: false,
    data_release_authorized: false,
    actual_witness_contacted: false,
    durable_events_written: 0,
    tombstones_written: 0,
    claims_created: 0,
    real_import_enabled: false,
  };
}

/**
 * Review a hypothetical restored snapshot, registry, and independent high-water
 * mark. A caller-supplied boolean here merely represents a test condition;
 * it cannot authenticate an actual witness or protect a real system.
 *
 * Fail-closed for old registry + old snapshot when newer witness is available,
 * missing/offline/unverified witness, missing key, broken hash chain and stale
 * snapshots. Even a passing preflight NEVER authorizes source data release.
 */
export function previewSyntheticRestorePreflight(state) {
  if (!keys(state, ["snapshot", "registry", "witness",
      "toy_independent_witness_verified", "toy_key_available"]) ||
      !keys(state.snapshot, ["applied_sequence", "applied_digest"]) ||
      !Number.isSafeInteger(state.snapshot.applied_sequence) ||
      state.snapshot.applied_sequence < 0 ||
      !digestFormat(state.snapshot.applied_digest) ||
      !Array.isArray(state.registry) || state.registry.length > 16 ||
      typeof state.toy_independent_witness_verified !== "boolean" ||
      typeof state.toy_key_available !== "boolean") {
    fail("invalid restore state");
  }
  // All events are accepted only in narrow, typed, synthetic, non-personal form.
  // This validation happens even if the witness is absent, preventing arbitrary
  // metadata entering either the simulated registry or diagnostic report.
  for (const event of state.registry) {
    if (!keys(event, ["sequence", "opaque_source_id", "action", "previous_digest", "digest"]) ||
        !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        typeof event.opaque_source_id !== "string" ||
        !sourceIds.has(event.opaque_source_id) ||
        typeof event.action !== "string" || !actions.has(event.action) ||
        !digestFormat(event.previous_digest) || !digestFormat(event.digest)) {
      fail("invalid synthetic registry event");
    }
  }

  if (!state.toy_key_available) return block("key_unavailable");
  if (!state.toy_independent_witness_verified) return block("witness_unverified");
  if (!keys(state.witness, ["sequence", "digest"]) ||
      !Number.isSafeInteger(state.witness.sequence) ||
      state.witness.sequence < 0 || !digestFormat(state.witness.digest)) {
    return block("witness_unavailable_or_invalid");
  }

  const bySequence = [GENESIS];
  let previous = GENESIS;
  for (let i = 0; i < state.registry.length; i++) {
    const event = state.registry[i];
    if (event.sequence !== i + 1) return block("registry_sequence_gap");
    if (event.previous_digest !== previous || event.digest !== eventDigest(event)) {
      return block("registry_chain_mismatch");
    }
    previous = event.digest;
    bySequence.push(previous);
  }

  // This intentionally stricter toy gate rejects registry tails not yet
  // attested by the "witness": no silent acceptance of new unanchored events.
  if (state.witness.sequence !== state.registry.length) {
    return block(state.witness.sequence > state.registry.length ?
      "registry_behind_external_witness" : "registry_has_unwitnessed_tail");
  }
  if (state.witness.digest !== previous) return block("external_witness_digest_mismatch");
  const seq = state.snapshot.applied_sequence;
  if (seq > state.registry.length) return block("restored_snapshot_ahead");
  if (state.snapshot.applied_digest !== bySequence[seq]) {
    return block("restored_snapshot_digest_mismatch");
  }

  const pending = state.registry.slice(seq).map(event => ({
    sequence: event.sequence,
    opaque_source_id: event.opaque_source_id,
    action: event.action,
  }));
  return {
    ...block(null),
    preflight_status: pending.length ? "requires_replay_and_revalidation" : "checks_passed_in_toy_only",
    pending_replay_events: pending,
    pending_replay_count: pending.length,
  };
}
