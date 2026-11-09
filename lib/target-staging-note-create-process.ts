/** Bounded, content-free result adapter for the private note create HTTP worker. */
import { runStagingWriteChild } from "./target-staging-title-http-process";
import type { StagingPersonalReadConfig } from "./target-staging-read-process";
import type { TargetStagingNoteLifecycleRequest } from "./target-note-lifecycle-writer";

type Reason = "unavailable" | "session_revoked" | "resync_required" |
  "idempotency_conflict" | "write_failed";
export type NoteCreateReply = { ok: true; replayed?: true } |
  { ok: false; reason: Reason };
const reasons = new Set<string>([
  "unavailable", "session_revoked", "resync_required",
  "idempotency_conflict", "write_failed",
]);

export function parseNoteCreateReply(value: unknown): NoteCreateReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (r.ok === true && keys === "ok") return { ok: true };
  if (r.ok === true && keys === "ok,replayed" && r.replayed === true)
    return { ok: true, replayed: true };
  if (r.ok === false && keys === "ok,reason" &&
      typeof r.reason === "string" && reasons.has(r.reason))
    return { ok: false, reason: r.reason as Reason };
  return null;
}

export async function createPrivateStagingNoteInChild(
  config: StagingPersonalReadConfig,
  request: Extract<TargetStagingNoteLifecycleRequest, { kind: "create" }>,
): Promise<NoteCreateReply | null> {
  const value = await runStagingWriteChild(
    config, "target-staging-note-create-child.mjs", JSON.stringify(request),
  );
  return parseNoteCreateReply(value);
}
