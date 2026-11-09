// Offline rehearsal of source-segment triage intent, over fictional fixtures only.
// This is not an approval workflow, persistent audit, or authorization boundary.
import { previewSyntheticReviewQueue } from "./review-preview.mjs";

const fail = message => { throw new Error(`Synthetic triage: ${message}`); };
const plainObject = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const locatorKey = locator => JSON.stringify([
  locator.source_id, locator.conversation_id, locator.message_id, locator.segment,
]);
const choices = new Set(["consider", "skip", "defer"]);
const locatorKeys = "conversation_id,message_id,segment,source_id";

/**
 * Simulate explicit per-segment triage choices WITHOUT changing review status.
 * "consider" only means "consider for later claim review"; "skip" does not delete
 * sources, and "defer" does not grant permission. No source text or digest returned.
 */
export function rehearseSyntheticTriage(bundles, intents = []) {
  const queue = previewSyntheticReviewQueue(bundles);
  if (!Array.isArray(intents) || intents.length > queue.entries.length) {
    fail("invalid intent list");
  }
  const byLocator = new Map(queue.entries.map(entry =>
    [locatorKey(entry.locator), entry]));
  const byDecision = new Map();
  const rehearsal_events = [];
  for (const intent of intents) {
    if (!plainObject(intent) || Object.keys(intent).sort().join(",") !== "choice,locator" ||
        !plainObject(intent.locator) ||
        Object.keys(intent.locator).sort().join(",") !== locatorKeys ||
        !choices.has(intent.choice)) {
      fail("invalid triage intent");
    }
    const loc = intent.locator;
    if (typeof loc.source_id !== "string" || typeof loc.conversation_id !== "string" ||
        typeof loc.message_id !== "string" || !Number.isSafeInteger(loc.segment) ||
        loc.segment < 0) {
      fail("invalid triage locator");
    }
    const key = locatorKey(loc);
    const entry = byLocator.get(key);
    if (!entry) fail("unknown triage locator");
    if (byDecision.has(key)) fail("duplicate triage locator");
    byDecision.set(key, intent.choice);
    rehearsal_events.push({
      step: rehearsal_events.length + 1,
      locator: { ...entry.locator },
      intent: intent.choice,
      kind: "synthetic_rehearsal_only",
    });
  }
  const disposition_counts = { pending: 0, consider: 0, skip: 0, defer: 0 };
  const entries = queue.entries.map(entry => {
    const triage_disposition = byDecision.get(locatorKey(entry.locator)) ?? "pending";
    disposition_counts[triage_disposition]++;
    return { ...entry, triage_disposition };
  });
  return {
    ...queue,
    workflow: "fictional_source_segment_triage_rehearsal",
    entries,
    disposition_counts,
    rehearsal_events,
    triage_intents_applied: rehearsal_events.length,
    // Triage choices never change review, evidence independence, sensitivity,
    // consent, or claim status; these counters are deliberately zero.
    claims_created: 0,
    review_outcomes_written: 0,
    real_import_enabled: false,
  };
}
