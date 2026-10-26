// D2b part 7: read-only, content-free comparison of effective Area routing.
// Even a complete-looking caller-provided graph is NOT an authenticated
// baseline, membership proof or server authorization. This must never unlock
// v1 recovery preferences, replay, hold release, invitations or partition.
import type { Entity, Relation } from "./db";

export type RecoveryScopeSnapshot = Readonly<{
  revision: number;
  restoreGeneration: number;
  entities: readonly Entity[];
  relations: readonly Relation[];
}>;

export type RecoveryScopeAudit = Readonly<{
  phase: "scope-graph-audit-only";
  completeness: "unverified";
  identity: "unverified";
  membership: "unverified";
  areaPermission: "unverified";
  consent: "not-requested";
  canApply: false;
  canReleaseHold: false;
  automaticReplayAllowed: false;
  summary: Readonly<{
    recordsCompared: number;
    sameScope: number;
    movedArea: number;
    movedWorkspace: number;
    absentOnOneSide: number;
    beforeCrossAreaRelations: number;
    currentCrossAreaRelations: number;
  }>;
}>;

export class RecoveryScopeGraphInvalid extends Error {
  constructor() {
    // Never include IDs, entity text, properties or the offending value.
    super("Invalid recovery scope graph");
    this.name = "RecoveryScopeGraphInvalid";
  }
}

type Scope = Readonly<{ workspaceId: string; areaId: string }>;
type Resolved = { scopes: Map<string, Scope>; crossAreaRelations: number };
type EntityRecord = Entity;

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim().length > 0;
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const invalid = (): never => { throw new RecoveryScopeGraphInvalid(); };

function ref(entity: Entity, key: "projectId" | "areaId"): string | undefined {
  const value = entity.properties[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (!validId(value)) invalid();
  return value as string;
}

/** Only use this for diagnostics. A local JSON object cannot attest its own completeness. */
function resolveScopeGraph(snapshot: RecoveryScopeSnapshot): Resolved {
  if (!snapshot || !validCount(snapshot.revision) || !validCount(snapshot.restoreGeneration) ||
      !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.relations) ||
      snapshot.entities.length > 20_000 || snapshot.relations.length > 50_000) invalid();

  const entities = new Map<string, EntityRecord>();
  const taken = new Set<string>();
  const kinds = new Map<string, "personal" | "shared">([["personal", "personal"]]);
  const explicitWorkspaces = new Set<string>();
  for (const item of snapshot.entities) {
    if (!item || !validId(item.id) || !validId(item.workspaceId) || taken.has(item.id) ||
        !["workspace", "area", "project", "task", "note"].includes(item.type) ||
        !item.properties || typeof item.properties !== "object" || Array.isArray(item.properties) ||
        typeof item.status !== "string") invalid();
    taken.add(item.id);
    entities.set(item.id, item);
    if (item.type === "workspace") {
      if (item.id !== "workspace:" + item.workspaceId || explicitWorkspaces.has(item.workspaceId) ||
          (item.workspaceId === "personal" ? item.properties.kind !== "personal"
            : item.properties.kind !== "shared")) invalid();
      explicitWorkspaces.add(item.workspaceId);
      kinds.set(item.workspaceId, item.workspaceId === "personal" ? "personal" : "shared");
    }
  }
  for (const item of snapshot.entities) {
    if (!kinds.has(item.workspaceId)) invalid();
    if (item.type === "area" &&
        item.properties.kind !== (kinds.get(item.workspaceId) === "personal" ? "private" : "shared"))
      invalid();
  }

  const directArea = new Map<string, string[]>();
  const directProject = new Map<string, string[]>();
  for (const edge of snapshot.relations) {
    if (!edge || !validId(edge.id) || !validId(edge.workspaceId) ||
        !validId(edge.sourceEntityId) || !validId(edge.targetEntityId) ||
        taken.has(edge.id) || typeof edge.relationType !== "string" || !edge.relationType)
      invalid();
    taken.add(edge.id);
    const source = entities.get(edge.sourceEntityId);
    const target = entities.get(edge.targetEntityId);
    if (!source || !target || source.workspaceId !== target.workspaceId ||
        edge.workspaceId !== source.workspaceId) invalid();
    if (edge.relationType === "belongs_to_area") {
      if (target.type !== "area" || !["project", "task", "note"].includes(source.type))
        invalid();
      const list = directArea.get(source.id) ?? [];
      list.push(target.id);
      directArea.set(source.id, list);
    } else if (edge.relationType === "belongs_to_project") {
      if (target.type !== "project" || !["task", "note"].includes(source.type))
        invalid();
      const list = directProject.get(source.id) ?? [];
      list.push(target.id);
      directProject.set(source.id, list);
    }
  }

  function oneTarget(item: Entity, type: "area" | "project"): string | undefined {
    const edges = (type === "area" ? directArea : directProject).get(item.id) ?? [];
    // Even two identical edges violate the single-parent graph contract.
    if (edges.length > 1) invalid();
    const legacy = ref(item, type === "area" ? "areaId" : "projectId");
    if (legacy && edges.length === 1 && legacy !== edges[0]) invalid();
    return legacy ?? edges[0];
  }
  function areaFor(item: Entity, id: string | undefined): string {
    if (!id) invalid();
    const area = entities.get(id as string);
    if (!area || area.type !== "area" || area.workspaceId !== item.workspaceId ||
        (item.status !== "archived" && area.status !== "active")) invalid();
    return area.id;
  }

  const scopes = new Map<string, Scope>();
  for (const item of snapshot.entities) {
    if (item.type === "area") scopes.set(item.id, { workspaceId: item.workspaceId, areaId: item.id });
    if (item.type === "project") {
      if (directProject.has(item.id) || ref(item, "projectId")) invalid();
      scopes.set(item.id, { workspaceId: item.workspaceId, areaId: areaFor(item, oneTarget(item, "area")) });
    }
  }
  for (const item of snapshot.entities) {
    if (item.type !== "task" && item.type !== "note") continue;
    const projectId = oneTarget(item, "project");
    const ownArea = oneTarget(item, "area");
    if (projectId) {
      const parent = entities.get(projectId);
      const inherited = scopes.get(projectId);
      if (!parent || parent.type !== "project" || parent.workspaceId !== item.workspaceId || !inherited ||
          ownArea) invalid();
      scopes.set(item.id, {
        workspaceId: item.workspaceId,
        areaId: areaFor(item, inherited.areaId),
      });
    } else {
      scopes.set(item.id, { workspaceId: item.workspaceId, areaId: areaFor(item, ownArea) });
    }
  }

  let crossAreaRelations = 0;
  for (const edge of snapshot.relations) {
    if (edge.relationType === "belongs_to_area" || edge.relationType === "belongs_to_project") continue;
    const a = scopes.get(edge.sourceEntityId);
    const b = scopes.get(edge.targetEntityId);
    if (a && b && (a.workspaceId !== b.workspaceId || a.areaId !== b.areaId))
      crossAreaRelations++;
  }
  return { scopes, crossAreaRelations };
}

/**
 * Compare two claimed full graphs. Detect inherited/project moves even when
 * the task/note and its own membership link did not change at all. Caller
 * input is NOT an authenticated before-state witness; equal graphs cannot
 * authorize recovery, sharing or releasing a persistent hold.
 *
 * No entity IDs, titles, properties, raw graphs, or private digests are emitted.
 */
export function auditOfflineRecoveryScopes(input: Readonly<{
  before: RecoveryScopeSnapshot;
  current: RecoveryScopeSnapshot;
}>): RecoveryScopeAudit {
  if (!input || !input.before || !input.current ||
      !validCount(input.before.restoreGeneration) || !validCount(input.current.restoreGeneration) ||
      input.current.restoreGeneration <= input.before.restoreGeneration) invalid();
  const before = resolveScopeGraph(input.before);
  const current = resolveScopeGraph(input.current);
  const ids = new Set([...before.scopes.keys(), ...current.scopes.keys()]);
  let sameScope = 0;
  let movedArea = 0;
  let movedWorkspace = 0;
  let absentOnOneSide = 0;
  for (const id of ids) {
    const a = before.scopes.get(id);
    const b = current.scopes.get(id);
    if (!a || !b) absentOnOneSide++;
    else if (a.workspaceId !== b.workspaceId) movedWorkspace++;
    else if (a.areaId !== b.areaId) movedArea++;
    else sameScope++;
  }
  return Object.freeze({
    phase: "scope-graph-audit-only",
    completeness: "unverified",
    identity: "unverified",
    membership: "unverified",
    areaPermission: "unverified",
    consent: "not-requested",
    canApply: false,
    canReleaseHold: false,
    automaticReplayAllowed: false,
    summary: Object.freeze({
      recordsCompared: ids.size, sameScope, movedArea, movedWorkspace,
      absentOnOneSide,
      beforeCrossAreaRelations: before.crossAreaRelations,
      currentCrossAreaRelations: current.crossAreaRelations,
    }),
  });
}
