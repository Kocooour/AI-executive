// D2b part 1: read-only inventory of legacy shared workspace partition risks.
// No IDs, titles, note bodies or row payloads leave this module. No DB access or writes.
// This audit is NOT a migration manifest or authorization to partition/enable shared access.
import type { Entity, Relation } from "./db";
import { createAreaPreflight, areaSnapshotSha256, type AreaSourceIdentity } from "./area-normalization-preflight";
import { AreaNormalizationBlocked } from "./area-normalization";
import { workspaceKinds } from "./area-write-invariants";

export type PartitionAuditFinding = { code: string; count: number };
export type PartitionTableCount = { table: string; rows: number };
export type PartitionAudit = {
  status: "audit-only";
  schemaVersion: 1;
  executable: false;
  sharingEnabled: false;
  sourceSha256: string;
  revision: number;
  restoreGeneration: number;
  summary: {
    sharedWorkspaces: number;
    sharedAreas: number;
    sharedProjects: number;
    sharedTasks: number;
    sharedNotes: number;
    crossAreaRelations: number;
    unknownScopeEntities: number;
  };
  tableInventory: PartitionTableCount[];
  findings: PartitionAuditFinding[];
  outstandingGates: readonly string[];
};

const gates = [
  "2a-live-application-unverified",
  "workspace-bound-table-routing-not-implemented",
  "offline-device-queue-export-and-reconciliation-not-implemented",
  "restore-generation-partition-barrier-not-implemented",
  "2b-transactional-partition-and-rollback-not-implemented",
  "multi-user-acl-disabled",
] as const;

export function auditAreaPartition(
  source: { entities: readonly Entity[]; relations: readonly Relation[] },
  identity: AreaSourceIdentity,
  at: number,
  tables: readonly PartitionTableCount[] = [],
): PartitionAudit {
  const findings = new Map<string, number>();
  const add = (code: string, count = 1) => findings.set(code, (findings.get(code) ?? 0) + count);
  // Hash content, but never emit raw data, record IDs, workspace names, or labels.
  const sourceSha256 = areaSnapshotSha256(source, identity.tombstones);
  try {
    if (!createAreaPreflight(source, identity, at).noChanges) add("2a-not-normalized");
  } catch (error) {
    if (!(error instanceof AreaNormalizationBlocked)) throw error;
    add("2a-preflight-blocked");
  }

  const entities = new Map(source.entities.map((e) => [e.id, e]));
  const kinds = workspaceKinds(source.entities);
  const sharedIds = new Set([...kinds].filter(([,kind]) => kind === "shared").map(([id]) => id));
  const shared = source.entities.filter((e) => sharedIds.has(e.workspaceId) && e.type !== "workspace");
  const sharedAreas = shared.filter((e) => e.type === "area");
  const sharedProjects = shared.filter((e) => e.type === "project");
  const sharedTasks = shared.filter((e) => e.type === "task");
  const sharedNotes = shared.filter((e) => e.type === "note");
  const areaOf = new Map<string, string>();

  for (const area of sharedAreas) areaOf.set(area.id, area.id);
  const relsBySource = new Map<string, Relation[]>();
  for (const r of source.relations) {
    const list = relsBySource.get(r.sourceEntityId) ?? [];
    list.push(r);
    relsBySource.set(r.sourceEntityId, list);
  }
  const projectMembership = (e: Entity) => (relsBySource.get(e.id) ?? [])
    .filter((r) => r.relationType === "belongs_to_project")
    .map((r) => r.targetEntityId);
  const ownArea = (e: Entity) => (relsBySource.get(e.id) ?? [])
    .filter((r) => r.relationType === "belongs_to_area")
    .map((r) => r.targetEntityId);

  const oneArea = (e: Entity, code: string): string | undefined => {
    const links = ownArea(e);
    if (links.length !== 1) { add(code); return; }
    const target = entities.get(links[0]);
    if (target?.type !== "area" || target.workspaceId !== e.workspaceId) {
      add("invalid-area-target"); return;
    }
    return target.id;
  };
  for (const project of sharedProjects) {
    const area = oneArea(project, "project-without-unique-area");
    if (area) areaOf.set(project.id, area);
  }
  // Both tasks and notes directly inside a project inherit its single Area.
  for (const item of [...sharedTasks, ...sharedNotes]) {
    const memberships = projectMembership(item);
    if (memberships.length > 1) { add("ambiguous-project-membership"); continue; }
    if (memberships.length === 1) {
      const parent = entities.get(memberships[0]);
      if (!parent || parent.type !== "project" || parent.workspaceId !== item.workspaceId) {
        add("invalid-project-membership"); continue;
      }
      const inherited = areaOf.get(parent.id);
      if (!inherited) { add("unroutable-project-member"); continue; }
      if (ownArea(item).length) { add("project-member-has-own-area"); continue; }
      areaOf.set(item.id, inherited);
    } else {
      const area = oneArea(item, item.type === "note" ? "unassigned-standalone-note" : "unassigned-standalone-task");
      if (area) areaOf.set(item.id, area);
    }
  }
  let unknownScopeEntities = 0;
  for (const entity of source.entities) {
    if (entity.type === "workspace") continue;
    if (entity.workspaceId !== "personal" && !kinds.has(entity.workspaceId)) {
      unknownScopeEntities += 1;
      add("unknown-workspace-entity");
    }
  }
  let crossAreaRelations = 0;
  for (const relation of source.relations) {
    if (!sharedIds.has(relation.workspaceId)) continue;
    const sourceArea = areaOf.get(relation.sourceEntityId);
    const targetArea = areaOf.get(relation.targetEntityId);
    if (!sourceArea || !targetArea) {
      add("unroutable-shared-relation");
    } else if (sourceArea !== targetArea) {
      crossAreaRelations += 1;
      add("cross-area-relation");
    }
  }
  // No routing of side tables is implemented. Counts are inventory ONLY, not
  // evidence that any row is safe to migrate, invalidate or leave behind.
  const inventory = [...tables].sort((a, b) => a.table.localeCompare(b.table, "en"));
  for (const item of inventory) {
    if (!/^[a-z_][a-z_0-9]*$/i.test(item.table) || !Number.isSafeInteger(item.rows) || item.rows < 0)
      throw new AreaNormalizationBlocked(["invalid-partition-table-inventory"]);
    if (sharedIds.size > 0 && item.rows > 0 && !["entities", "relations", "tombstones", "metadata", "schema_migrations"].includes(item.table))
      add("unmapped-side-table-rows", item.rows);
  }
  return {
    status: "audit-only", schemaVersion: 1, executable: false, sharingEnabled: false,
    sourceSha256, revision: identity.revision, restoreGeneration: identity.restoreGeneration,
    summary: {
      sharedWorkspaces: sharedIds.size, sharedAreas: sharedAreas.length, sharedProjects: sharedProjects.length,
      sharedTasks: sharedTasks.length, sharedNotes: sharedNotes.length,
      crossAreaRelations, unknownScopeEntities,
    },
    tableInventory: inventory,
    findings: [...findings].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code, "en")),
    outstandingGates: gates,
  };
}
