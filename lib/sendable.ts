import type { Entity, Relation } from "./db";

// What the server accepts as a record (validateSnapshot in lib/server-store.ts). A record it would
// refuse makes the server refuse the whole save, so such a record is held back on this device
// instead: everything else is sent, and the record is shown to be fixed or removed.

const entityTypes = new Set(["area", "project", "task", "note", "workspace"]);

export type HeldBackReason = "noTitle" | "longTitle" | "longContent" | "longNotes" | "tooLarge" | "invalid" | "workspace";

// Why the server would refuse this record on its own, or null when it would accept it.
function ownProblem(entity: Entity): HeldBackReason | null {
  if (!entity || typeof entity.id !== "string" || entity.id.length === 0 || entity.id.length > 240) return "invalid";
  if (typeof entity.type !== "string" || !entityTypes.has(entity.type)) return "invalid";
  if (typeof entity.title !== "string" || entity.title.length === 0) return "noTitle";
  if (entity.title.length > 1000) return "longTitle";
  if (entity.content !== undefined && (typeof entity.content !== "string" || entity.content.length > 100_000)) return "longContent";
  if (typeof entity.status !== "string" || entity.status.length > 40) return "invalid";
  if (typeof entity.workspaceId !== "string" || entity.workspaceId.length > 120) return "invalid";
  if (!entity.properties || typeof entity.properties !== "object" || Array.isArray(entity.properties)) return "invalid";
  if (!Number.isFinite(entity.createdAt) || !Number.isFinite(entity.updatedAt)) return "invalid";
  if (JSON.stringify(entity.properties).length > 250_000) {
    return typeof entity.properties.notes === "string" && entity.properties.notes.length > 200_000 ? "longNotes" : "tooLarge";
  }
  if (entity.type === "workspace") {
    const { kind, role, members } = entity.properties as { kind?: unknown; role?: unknown; members?: unknown };
    if (entity.id !== `workspace:${entity.workspaceId}` || entity.title.trim().length === 0) return "invalid";
    if (entity.title.length > 120) return "longTitle";
    if (!["personal", "shared"].includes(String(kind)) || role !== "owner" || !Array.isArray(members)) return "invalid";
  }
  return null;
}

// The answer for a record object is kept while that object lives (one read of the local copy is
// checked several times: for saving, for the screen, for sign-out). A merged record can keep the
// timestamp of another version, so the answer is never shared between different objects.
const checked = new WeakMap<object, HeldBackReason | null>();
function problemOf(entity: Entity) {
  if (!entity || typeof entity !== "object") return "invalid" as const;
  const cached = checked.get(entity);
  if (cached !== undefined) return cached;
  const problem = ownProblem(entity);
  checked.set(entity, problem);
  return problem;
}

export function isSendable(entity: Entity) {
  return problemOf(entity) === null;
}

// Splits the local copy into what can be sent and what is held back, with the reason per held
// record. A record in a workspace that cannot be sent is held back too (the server refuses
// records of unknown workspaces). A held-back record that the server already knows (it is in
// `base`, the common version) is sent in that known form, with its known relations, so the save
// neither removes nor changes it; one the server never had is left out with its relations.
export function forServer(entities: Entity[], relations: Relation[], base: { entities: Entity[]; relations?: Relation[] } | null) {
  const reasons = new Map<string, HeldBackReason>();
  for (const entity of entities) {
    const problem = problemOf(entity);
    if (problem) reasons.set(entity.id, problem);
  }
  const known = new Map((base?.entities || []).map((entity) => [entity.id, entity]));
  // Workspaces the server will have after this save: those sent as they are, and held ones it
  // already knows (sent in that known form).
  const workspaces = new Set(["personal"]);
  for (const entity of entities) {
    if (entity.type !== "workspace") continue;
    const previous = known.get(entity.id);
    if (!reasons.has(entity.id) || (previous && problemOf(previous) === null)) workspaces.add(entity.workspaceId);
  }
  for (const entity of entities) {
    if (entity.type !== "workspace" && !reasons.has(entity.id) && !workspaces.has(entity.workspaceId)) reasons.set(entity.id, "workspace");
  }
  // A relation to a record that is not there, or across workspaces, makes the server refuse the
  // whole save; it is not sent (it disappears here when the server copy is taken over).
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const sameWorkspace = (relation: Relation) => {
    const source = byId.get(relation.sourceEntityId), target = byId.get(relation.targetEntityId);
    return Boolean(source && target && source.workspaceId === target.workspaceId && relation.workspaceId === source.workspaceId);
  };
  if (!reasons.size) return { entities, relations: relations.every(sameWorkspace) ? relations : relations.filter(sameWorkspace), heldBack: [] as Entity[], reasons };
  const heldBack: Entity[] = [];
  const sent: Entity[] = [];
  const sentAsKnown = new Set<string>();
  for (const entity of entities) {
    if (!reasons.has(entity.id)) { sent.push(entity); continue; }
    heldBack.push(entity);
    const previous = known.get(entity.id);
    if (previous && problemOf(previous) === null && (previous.type === "workspace" || workspaces.has(previous.workspaceId))) {
      sent.push(previous);
      sentAsKnown.add(previous.id);
    }
  }
  const touchesKnown = (relation: Relation) => sentAsKnown.has(relation.sourceEntityId) || sentAsKnown.has(relation.targetEntityId);
  // Every link is checked against the records as they are sent (a known version may sit in
  // another workspace than the local one).
  const sentById = new Map(sent.map((entity) => [entity.id, entity]));
  const fitsSent = (relation: Relation) => {
    const source = sentById.get(relation.sourceEntityId), target = sentById.get(relation.targetEntityId);
    return Boolean(source && target && source.workspaceId === target.workspaceId && relation.workspaceId === source.workspaceId);
  };
  const outgoingRelations = [
    ...relations.filter((relation) => !touchesKnown(relation)),
    ...(base?.relations || []).filter(touchesKnown),
  ].filter(fitsSent);
  return { entities: sent, relations: outgoingRelations, heldBack, reasons };
}

// The records of the local copy that are not in `base` as they are here: changes not sent yet.
export function unsentIds(entities: Entity[], base: { entities: Entity[] } | null) {
  if (!base) return new Set<string>();
  const known = new Map(base.entities.map((entity) => [entity.id, entity.updatedAt]));
  return new Set(entities.filter((entity) => entity.type !== "workspace" && known.get(entity.id) !== entity.updatedAt).map((entity) => entity.id));
}
