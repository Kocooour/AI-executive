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
  const directProjectLinks = (e: Entity) => (relsBySource.get(e.id) ?? [])
    .filter((r) => r.relationType === "belongs_to_project")
    .map((r) => r.targetEntityId);
  const directAreaLinks = (e: Entity) => (relsBySource.get(e.id) ?? [])
    .filter((r) => r.relationType === "belongs_to_area")
    .map((r) => r.targetEntityId);

  // D2a normalizes projects and tasks, but intentionally leaves notes alone.
  // Older clients also store note ownership in these two properties. Resolve
  // them here rather than incorrectly treating the notes as standalone.
  const noteReference = (note: Entity, key: "projectId" | "areaId"): string | undefined => {
    const raw = note.properties[key];
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string" || !raw.trim()) {
      add(key === "projectId" ? "invalid-note-project-reference" : "invalid-note-area-reference");
      return undefined;
    }
    return raw;
  };
  const noteProject = (note: Entity) => {
    const links = directProjectLinks(note);
    const legacy = noteReference(note, "projectId");
    const choices = new Set([...links, ...(legacy ? [legacy] : [])]);
    if (links.length > 1 || choices.size > 1) {
      add("ambiguous-note-project-membership");
      return { blocked: true, target: undefined as string | undefined };
    }
    if (note.properties.projectId != null && note.properties.projectId !== "" && !legacy)
      return { blocked: true, target: undefined as string | undefined };
    return { blocked: false, target: [...choices][0] };
  };
  const noteOwnArea = (note: Entity) => {
    const links = directAreaLinks(note);
    const legacy = noteReference(note, "areaId");
    const choices = new Set([...links, ...(legacy ? [legacy] : [])]);
    if (links.length > 1 || choices.size > 1) {
      add("ambiguous-note-area-membership");
      return { blocked: true, target: undefined as string | undefined };
    }
    if (note.properties.areaId != null && note.properties.areaId !== "" && !legacy)
      return { blocked: true, target: undefined as string | undefined };
    return { blocked: false, target: [...choices][0] };
  };
  const validArea = (item: Entity, id: string): boolean => {
    const target = entities.get(id);
    if (target?.type !== "area" || target.workspaceId !== item.workspaceId) {
      add("invalid-area-target");
      return false;
    }
    if (item.status !== "archived" && target.status !== "active") {
      add("inactive-area-for-active-item");
      return false;
    }
    return true;
  };

  const oneArea = (e: Entity, code: string): string | undefined => {
    const links = directAreaLinks(e);
    if (links.length !== 1) { add(code); return; }
    return validArea(e, links[0]) ? links[0] : undefined;
  };
  for (const project of sharedProjects) {
    const area = oneArea(project, "project-without-unique-area");
    if (area) areaOf.set(project.id, area);
  }
  // Project members inherit their parent's Area. A direct note membership
  // and its legacy property must agree; otherwise partitioning is blocked.
  for (const item of [...sharedTasks, ...sharedNotes]) {
    const isNote = item.type === "note";
    const noteProjectRef = isNote ? noteProject(item) : undefined;
    const noteAreaRef = isNote ? noteOwnArea(item) : undefined;
    if (noteProjectRef?.blocked || noteAreaRef?.blocked) continue;
    const memberships = isNote
      ? (noteProjectRef?.target ? [noteProjectRef.target] : [])
      : directProjectLinks(item);
    if (memberships.length > 1) { add("ambiguous-project-membership"); continue; }
    if (memberships.length === 1) {
      const parent = entities.get(memberships[0]);
      if (!parent || parent.type !== "project" || parent.workspaceId !== item.workspaceId) {
        add("invalid-project-membership"); continue;
      }
      const inherited = areaOf.get(parent.id);
      if (!inherited) { add("unroutable-project-member"); continue; }
      const own = isNote ? noteAreaRef?.target : directAreaLinks(item)[0];
      if (isNote) {
        if (own && own !== inherited) { add("project-note-area-disagrees"); continue; }
        if (own && !validArea(item, own)) continue;
        if (own) { add("project-member-has-own-area"); continue; }
      } else if (directAreaLinks(item).length) {
        add("project-member-has-own-area"); continue;
      }
      if (!validArea(item, inherited)) continue;
      areaOf.set(item.id, inherited);
    } else if (isNote) {
      const chosen = noteAreaRef?.target;
      if (!chosen) { add("unassigned-standalone-note"); continue; }
      if (validArea(item, chosen)) areaOf.set(item.id, chosen);
    } else {
      const area = oneArea(item, "unassigned-standalone-task");
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
