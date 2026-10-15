// The typed relation registry of the Context Graph (README, Context Graph v2). A relationship is a
// claim with a target; its predicate must be one of the entries below and the subject and target
// types must be allowed for it. The registry is static and versioned: adding an entry is a code
// change, never data. Literal claims (importance, preference, target_date, ...) are not relations
// and keep free-text predicates. The canonical belongs_to_project / belongs_to_area relations of the
// entity graph are a different mechanism and are not part of this registry.

export const RELATION_REGISTRY_VERSION = 1;

/** Everything that can stand at either end of a relationship today. There is no "tool" subject type yet. */
export type RelationEndpointType = "person" | "organization" | "workspace" | "area" | "project" | "task" | "note";

export const relationEndpointTypes: RelationEndpointType[] = ["person", "organization", "workspace", "area", "project", "task", "note"];

export interface RelationDefinition {
  predicate: string;
  labels: { cs: string; en: string };
  /** The label read from the target's side ("Acme — zaměstnává: Jana"). Symmetric relations read the same both ways. */
  inverse: { cs: string; en: string };
  subjectTypes: RelationEndpointType[];
  targetTypes: RelationEndpointType[];
  symmetric: boolean;
  /** Subject and target must be of the same type (supersedes). */
  sameType?: boolean;
}

const standalone: RelationEndpointType[] = ["person", "organization"];
const work: RelationEndpointType[] = ["task", "project"];

export const relationRegistry: readonly RelationDefinition[] = [
  { predicate: "uses", labels: { cs: "používá", en: "uses" }, inverse: { cs: "je používáno", en: "is used by" },
    subjectTypes: [...standalone, "project"], targetTypes: ["project", "note"], symmetric: false },
  { predicate: "responsible_for", labels: { cs: "odpovídá za", en: "is responsible for" }, inverse: { cs: "má odpovědnou osobu", en: "has responsible party" },
    subjectTypes: standalone, targetTypes: ["project", "task", "area"], symmetric: false },
  { predicate: "works_for", labels: { cs: "pracuje pro", en: "works for" }, inverse: { cs: "zaměstnává", en: "employs" },
    subjectTypes: ["person"], targetTypes: ["organization"], symmetric: false },
  { predicate: "participates_in", labels: { cs: "účastní se", en: "participates in" }, inverse: { cs: "má účastníka", en: "has participant" },
    subjectTypes: standalone, targetTypes: ["project", "area"], symmetric: false },
  { predicate: "assigned_to", labels: { cs: "přiřazeno", en: "assigned to" }, inverse: { cs: "má přiřazeno", en: "has assigned" },
    subjectTypes: ["task"], targetTypes: ["person"], symmetric: false },
  { predicate: "blocked_by", labels: { cs: "blokováno", en: "blocked by" }, inverse: { cs: "blokuje", en: "blocks" },
    subjectTypes: work, targetTypes: work, symmetric: false },
  { predicate: "arose_from", labels: { cs: "vzniklo z", en: "arose from" }, inverse: { cs: "dalo vzniknout", en: "gave rise to" },
    subjectTypes: [...work, "note"], targetTypes: [...work, "note"], symmetric: false },
  { predicate: "related_to", labels: { cs: "souvisí s", en: "is related to" }, inverse: { cs: "souvisí s", en: "is related to" },
    subjectTypes: relationEndpointTypes, targetTypes: relationEndpointTypes, symmetric: true },
  { predicate: "supersedes", labels: { cs: "nahrazuje", en: "supersedes" }, inverse: { cs: "je nahrazeno", en: "is superseded by" },
    subjectTypes: ["task", "project", "note", "area"], targetTypes: ["task", "project", "note", "area"], symmetric: false, sameType: true },
  // Continuity addition: existing claims, the Context Inbox and the Attention "waiting" rule already use
  // waiting_for as a relationship to a person or organization.
  { predicate: "waiting_for", labels: { cs: "čeká na", en: "is waiting for" }, inverse: { cs: "očekává se od", en: "is awaited from" },
    subjectTypes: relationEndpointTypes, targetTypes: standalone, symmetric: false },
];

const byPredicate = new Map(relationRegistry.map((entry) => [entry.predicate, entry]));

export function getRelationDefinition(predicate: string) {
  return byPredicate.get(predicate) ?? null;
}

export interface RelationCheck {
  ok: boolean;
  /** Set when !ok: the predicate is not in the registry, or its endpoints are not allowed. */
  reason?: "unregistered_predicate" | "invalid_endpoints";
  definition: RelationDefinition | null;
}

/** Whether `subjectType --predicate--> targetType` is a registered relation. */
export function checkRelation(predicate: string, subjectType: string, targetType: string): RelationCheck {
  const definition = getRelationDefinition(predicate);
  if (!definition) return { ok: false, reason: "unregistered_predicate", definition: null };
  const allowed = definition.subjectTypes.includes(subjectType as RelationEndpointType) &&
    definition.targetTypes.includes(targetType as RelationEndpointType) && (!definition.sameType || subjectType === targetType);
  return allowed ? { ok: true, definition } : { ok: false, reason: "invalid_endpoints", definition };
}

/** The registered predicates that may link a subject type to a target type, in registry order. */
export function relationsBetween(subjectType: string, targetType: string) {
  return relationRegistry.filter((entry) => checkRelation(entry.predicate, subjectType, targetType).ok);
}

export type RelationStatus = "registered" | "unregistered" | "invalid_endpoints";

export function relationStatusOf(predicate: string, subjectType: string, targetType: string): RelationStatus {
  const check = checkRelation(predicate, subjectType, targetType);
  return check.ok ? "registered" : check.reason === "unregistered_predicate" ? "unregistered" : "invalid_endpoints";
}
