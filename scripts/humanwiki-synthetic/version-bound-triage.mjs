// Fictional fixtures ONLY: rehearses stale-source rejection without any durable state.
// SHA-256 here is an unkeyed digest of toy fixture JSON and MUST NOT be reused
// as a privacy-safe fingerprint, consent token, or production authorization.
import { parseSyntheticBundle } from "./ingest.mjs";
import { rehearseSyntheticTriage } from "./triage-rehearsal.mjs";

const fail = message => { throw new Error(`Synthetic versioned triage: ${message}`); };
const plainObject = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => plainObject(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const parsedSources = bundles => {
  // Parsing is limited to the existing narrow, fictional ChatGPT/Claude formats.
  const parsed = bundles.map(bundle => parseSyntheticBundle(bundle));
  const byId = new Map(parsed.map(source => [source.source_id, source]));
  if (byId.size !== parsed.length) fail("duplicate source identity");
  return byId;
};

/**
 * Capture the source bundle's exact version at the time a toy choice is made.
 * First validate choices against the canonical synthetic review queue.
 * The returned digest-bearing toy intents are NOT suitable for real content.
 */
export function bindSyntheticTriageIntents(bundles, selections) {
  const validated = rehearseSyntheticTriage(bundles, selections);
  const sources = parsedSources(bundles);
  return validated.rehearsal_events.map(event => ({
    locator: { ...event.locator },
    choice: event.intent,
    bundle_digest: sources.get(event.locator.source_id).digest,
  }));
}

/**
 * Reject any decision prepared against a different source version, including
 * changes to another message's text, role or time in that same source.
 * The other source may change without invalidating choices on this source.
 */
export function rehearseVersionBoundSyntheticTriage(bundles, boundIntents = []) {
  if (!Array.isArray(boundIntents)) fail("invalid bound intent list");
  const sources = parsedSources(bundles);
  const selections = [];
  for (const intent of boundIntents) {
    if (!exactKeys(intent, ["locator", "choice", "bundle_digest"]) ||
        !plainObject(intent.locator) ||
        typeof intent.locator.source_id !== "string" ||
        typeof intent.bundle_digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(intent.bundle_digest)) {
      fail("invalid bound triage intent");
    }
    const current = sources.get(intent.locator.source_id);
    if (!current || current.digest !== intent.bundle_digest) {
      fail("stale or missing synthetic source version");
    }
    // Existing triage validates exact locator fields, allowed dispositions,
    // duplicate decisions and member identity; it never confirms claims.
    selections.push({ locator: intent.locator, choice: intent.choice });
  }
  const result = rehearseSyntheticTriage(bundles, selections);
  return {
    ...result,
    source_version_binding: "toy_bundle_sha256_only",
    source_version_checks: selections.length,
    claims_created: 0,
    review_outcomes_written: 0,
    real_import_enabled: false,
  };
}
