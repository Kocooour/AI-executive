// 2c, part 1: read-only, in-memory planning for existing owner-only
// legacy shared tasks. No write, migration, membership authorization, sync,
// My Plan activation, confirmation, or automatic assignment takes place here.
//
// WARNING: candidate IDs can reveal private work. Never log, persist, upload,
// publish, place in URLs, or pass to AI providers.
import type { Entity } from "./db";

export type LegacyAssigneeSource = Readonly<{
  revision: number;
  restoreGeneration: number;
  entities: readonly Entity[];
}>;

export type LegacyAssigneePreflightInput = Readonly<{
  source: LegacyAssigneeSource;
  // Must ultimately originate from the reviewed 2b migration provenance, not
  // a client-side choice or a guess from the current workspace kind. This
  // preparatory function cannot authenticate that provenance.
  legacySharedWorkspaceIds: readonly string[];
}>;

export type LegacyAssigneePreflight = Readonly<{
  phase: "legacy-assignee-preflight-only";
  ownerUserId: "owner";
  sourceRevision: number;
  sourceRestoreGeneration: number;
  membershipEvidence: "unverified";
  legacyOriginEvidence: "unverified";
  canApply: false;
  canActivateMyPlan: false;
  canEnableSharing: false;
  // PRIVATE canonical IDs for later owner review; proposed value is always
  // owner and no modified Entity is emitted.
  candidateTaskIds: readonly string[];
  counts: Readonly<{
    ownerOnlyLegacyWorkspaces: number;
    openLegacyTasks: number;
    candidates: number;
    alreadyAssignedOwner: number;
    nonOpenSkipped: number;
  }>;
}>;

export class LegacyAssigneePreflightBlocked extends Error {
  constructor() {
    super("Legacy assignee preflight blocked");
    this.name = "LegacyAssigneePreflightBlocked";
  }
}

const invalid = (): never => { throw new LegacyAssigneePreflightBlocked(); };
const validNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validId = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 512 && s.trim().length > 0;

/**
 * Deterministic diagnostic only. A client-supplied list of "legacy" workspaces
 * and mutable workspace.members records are NOT proof that the target was
 * historically owner-only. Do not use this plan as a migration instruction.
 */
export function planLegacyOwnerAssignees(input: LegacyAssigneePreflightInput): LegacyAssigneePreflight {
  if (!input || !input.source || !validNumber(input.source.revision) ||
      !validNumber(input.source.restoreGeneration) || !Array.isArray(input.source.entities) ||
      input.source.entities.length > 20_000 ||
      !Array.isArray(input.legacySharedWorkspaceIds) ||
      input.legacySharedWorkspaceIds.length === 0 ||
      input.legacySharedWorkspaceIds.length > 20_000) invalid();

  const selected = new Set<string>();
  for (const id of input.legacySharedWorkspaceIds) {
    if (!validId(id) || id === "personal" || id === "all" || selected.has(id)) invalid();
    selected.add(id);
  }

  const recordIds = new Set<string>();
  const workspaces = new Map<string, Entity>();
  for (const e of input.source.entities) {
    if (!e || !validId(e.id) || recordIds.has(e.id) || !validId(e.workspaceId) ||
        !["area", "project", "task", "note", "workspace"].includes(e.type) ||
        !e.properties || typeof e.properties !== "object" || Array.isArray(e.properties) ||
        typeof e.status !== "string") invalid();
    recordIds.add(e.id);
    if (e.type === "workspace") {
      if (e.id !== "workspace:" + e.workspaceId || workspaces.has(e.workspaceId)) invalid();
      workspaces.set(e.workspaceId, e);
    }
  }

  // A legacy designation alone is insufficient: the CURRENT workspace
  // must also be explicitly owner-only. Refuse missing, ambiguous or
  // multi-member metadata rather than assigning someone else's task.
  for (const id of selected) {
    const workspace = workspaces.get(id);
    if (!workspace || workspace.status !== "active" ||
        workspace.properties.kind !== "shared") invalid();
    const members = workspace.properties.members;
    if (!Array.isArray(members) || members.length !== 1 ||
        !members[0] || typeof members[0] !== "object" ||
        members[0].id !== "owner" || members[0].role !== "owner") invalid();
  }

  const candidates: string[] = [];
  let openLegacyTasks = 0;
  let alreadyAssignedOwner = 0;
  let nonOpenSkipped = 0;
  for (const e of input.source.entities) {
    if (e.type !== "task" || !selected.has(e.workspaceId)) continue;
    if (e.status !== "open") {
      nonOpenSkipped++;
      continue;
    }
    openLegacyTasks++;
    const assignee = e.properties.assigneeUserId;
    if (assignee === undefined || assignee === null) {
      candidates.push(e.id);
    } else if (assignee === "owner") {
      alreadyAssignedOwner++;
    } else {
      // Never replace an existing non-owner assignment or accept malformed
      // values, even if a workspace claims to have only one member.
      invalid();
    }
  }
  candidates.sort();
  return Object.freeze({
    phase: "legacy-assignee-preflight-only",
    ownerUserId: "owner",
    sourceRevision: input.source.revision,
    sourceRestoreGeneration: input.source.restoreGeneration,
    membershipEvidence: "unverified",
    legacyOriginEvidence: "unverified",
    canApply: false,
    canActivateMyPlan: false,
    canEnableSharing: false,
    candidateTaskIds: Object.freeze(candidates),
    counts: Object.freeze({
      ownerOnlyLegacyWorkspaces: selected.size,
      openLegacyTasks,
      candidates: candidates.length,
      alreadyAssignedOwner,
      nonOpenSkipped,
    }),
  });
}
