/** Bounded, short-lived staging membership worker. Command enters over stdin only. */
import { runStagingWriteChild } from "./target-staging-title-http-process";
import type { StagingPersonalReadConfig } from "./target-staging-read-process";
import type { TargetStagingMembershipCommand, TargetStagingMembershipResult } from "./target-staging-membership-command";

const REASONS = ["unauthorized", "unauthenticated", "unavailable", "stale_policy_revision", "idempotency_conflict", "already_member",
  "last_admin", "write_failed", "session_revoked"];

function parse(value: unknown): TargetStagingMembershipResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.ok === true && (keys === "ok,outcome,policyRevision,unassignedTasks" ||
      keys === "ok,outcome,policyRevision,replayed,unassignedTasks") &&
      (v.outcome === "applied" || v.outcome === "noop") &&
      Number.isSafeInteger(v.policyRevision) && (v.policyRevision as number) >= 0 &&
      Number.isSafeInteger(v.unassignedTasks) && (v.unassignedTasks as number) >= 0 &&
      (v.replayed === undefined || v.replayed === true)) {
    return { ok: true, outcome: v.outcome, policyRevision: v.policyRevision as number,
      unassignedTasks: v.unassignedTasks as number, ...(v.replayed ? { replayed: true as const } : {}) };
  }
  if (v.ok === false && keys === "ok,reason" && typeof v.reason === "string" &&
      REASONS.includes(v.reason)) {
    return { ok: false, reason: v.reason as Extract<TargetStagingMembershipResult, { ok: false }>["reason"] };
  }
  return null;
}

export async function applyMembershipCommandInChild(
  config: StagingPersonalReadConfig, command: TargetStagingMembershipCommand,
): Promise<TargetStagingMembershipResult | null> {
  return parse(await runStagingWriteChild(config, "target-staging-membership-write-child.mjs",
    JSON.stringify(command)));
}
