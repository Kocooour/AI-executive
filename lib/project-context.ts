// The context of a project (B1, owner decisions 2026-10-22): why it matters, its main goals and when it is done.
// Stored as `properties.context`. Pure: no React, storage or network access, so the client (lib/sendable.ts), the
// server (lib/server-store.ts), the migration (lib/schema-migrations.ts) and the assistant context share one definition.
import type { Entity } from "./db";

export const contextLimits = { why: 600, goals: 5, goal: 200, doneWhen: 300 } as const;

export type ProjectContext = {
  why: string;
  goals: string[];
  doneWhen: string;
  // "owner": written by the owner. "lumi-approved": proposed by Lumi and approved by the owner (a PACT proposal; B2).
  provenance: "owner" | "lumi-approved";
  proposalId?: string;
  updatedAt: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// What the server and the client accept as `properties.context`: every field present and within its limit. A record
// with anything else is refused (server) or held back (client), never silently cut.
export function validProjectContext(value: unknown): value is ProjectContext {
  if (!isObject(value)) return false;
  // Only the six fields; an unknown key (or an own __proto__) makes the record invalid, never silently kept.
  const allowed = new Set(["why", "goals", "doneWhen", "provenance", "proposalId", "updatedAt"]);
  if (Object.getOwnPropertyNames(value).some((key) => !allowed.has(key))) return false;
  const { why, goals, doneWhen, provenance, proposalId, updatedAt } = value;
  if (typeof why !== "string" || why.length > contextLimits.why) return false;
  if (!Array.isArray(goals) || goals.length > contextLimits.goals) return false;
  if (!goals.every((goal) => typeof goal === "string" && goal.length <= contextLimits.goal)) return false;
  if (typeof doneWhen !== "string" || doneWhen.length > contextLimits.doneWhen) return false;
  if (provenance !== "owner" && provenance !== "lumi-approved") return false;
  if (proposalId !== undefined && (typeof proposalId !== "string" || proposalId.length === 0 || proposalId.length > 240)) return false;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return false;
  return true;
}

// Does the (valid or not) stored value carry any text?
export const contextIsEmpty = (context: Pick<ProjectContext, "why" | "goals" | "doneWhen">) =>
  !context.why.trim() && !context.doneWhen.trim() && !context.goals.some((goal) => goal.trim());

// The context of a project as it is read. An old project has only `properties.goal`, which is read as "Hotovo, když"
// (kept readable for one version; the migration copies it into `context`). A stored `context` that is not valid
// (written by something else) reads field by field, so a screen never crashes on it.
export function readProjectContext(properties: Record<string, unknown> | undefined): ProjectContext {
  const stored = properties?.context;
  if (isObject(stored)) {
    return {
      why: typeof stored.why === "string" ? stored.why : "",
      goals: Array.isArray(stored.goals) ? stored.goals.filter((goal): goal is string => typeof goal === "string") : [],
      doneWhen: typeof stored.doneWhen === "string" ? stored.doneWhen : "",
      provenance: stored.provenance === "lumi-approved" ? "lumi-approved" : "owner",
      ...(typeof stored.proposalId === "string" && stored.proposalId ? { proposalId: stored.proposalId } : {}),
      updatedAt: typeof stored.updatedAt === "number" && Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0,
    };
  }
  const goal = typeof properties?.goal === "string" ? properties.goal : "";
  return { why: "", goals: [], doneWhen: goal, provenance: "owner", updatedAt: 0 };
}

// The owner's edit of the context: trimmed, empty goals dropped, provenance "owner". An edit by the owner always ends as
// owner-written text, also over an approved proposal. Nothing is cut: `contextProblem` says first whether the text fits.
export function ownerProjectContext(input: { why: string; goals: string[]; doneWhen: string }, now: number): ProjectContext {
  return {
    why: input.why.trim(),
    goals: input.goals.map((goal) => goal.trim()).filter(Boolean),
    doneWhen: input.doneWhen.trim(),
    provenance: "owner",
    updatedAt: now,
  };
}

// What stops a text from being saved, or null. The editor refuses the save with this instead of cutting the text.
export function contextProblem(input: { why: string; goals: string[]; doneWhen: string }): { field: "why" | "goals" | "goal" | "doneWhen"; limit: number } | null {
  const goals = input.goals.map((goal) => goal.trim()).filter(Boolean);
  if (input.why.trim().length > contextLimits.why) return { field: "why", limit: contextLimits.why };
  if (goals.length > contextLimits.goals) return { field: "goals", limit: contextLimits.goals };
  if (goals.some((goal) => goal.length > contextLimits.goal)) return { field: "goal", limit: contextLimits.goal };
  if (input.doneWhen.trim().length > contextLimits.doneWhen) return { field: "doneWhen", limit: contextLimits.doneWhen };
  return null;
}

// After a merge: an older client edits only `goal`. When `goal` changed against the common version and "Hotovo, když" did not,
// the new goal is the new doneWhen (when it fits; a longer one is left to the fallback read and the editor's refusal).
export function syncGoalIntoContext(base: Entity, merged: Entity): Entity {
  if (merged.type !== "project" || !isObject(merged.properties.context)) return merged;
  const goal = merged.properties.goal;
  if (typeof goal !== "string" || goal === base.properties?.goal) return merged;
  const context = merged.properties.context as Record<string, unknown>;
  const baseContext = isObject(base.properties?.context) ? base.properties.context as Record<string, unknown> : null;
  const baseDone = baseContext ? baseContext.doneWhen : (typeof base.properties?.goal === "string" ? base.properties.goal : "");
  if (context.doneWhen !== baseDone || context.doneWhen === goal) return merged;
  if (goal.trim().length > contextLimits.doneWhen) return merged;
  return { ...merged, properties: { ...merged.properties, context: { ...context, doneWhen: goal.trim() } } };
}

// `properties` patch that saves the context. `goal` mirrors "Hotovo, když" so a device that still runs the previous version
// reads the same text (one version of backward compatibility); it is dropped in the version after.
export function contextPatch(context: ProjectContext) {
  return { context, goal: context.doneWhen };
}

// Compare with the snapshot the editor started from inside the caller's IndexedDB write transaction.
// A server pull or another tab may change context after a field receives focus; refusing this patch
// preserves the incoming version until the owner explicitly resolves the conflict.
export function contextPatchIfUnchanged(
  currentProperties: Record<string, unknown>, expected: ProjectContext, proposed: ProjectContext,
): ReturnType<typeof contextPatch> | null {
  const current = readProjectContext(currentProperties);
  const same = current.why === expected.why && current.doneWhen === expected.doneWhen
    && current.provenance === expected.provenance && current.updatedAt === expected.updatedAt
    && current.proposalId === expected.proposalId && current.goals.length === expected.goals.length
    && current.goals.every((goal, index) => goal === expected.goals[index]);
  return same ? contextPatch(proposed) : null;
}

// The first sentence of a text, for the project list. A sentence ends with . ! or ? followed by a space or the end.
export function firstSentence(text: string, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const match = /^.*?[.!?](?=\s|$)/.exec(flat);
  const sentence = match ? match[0] : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// Migration of one stored project payload: `properties.goal` becomes `context.doneWhen`. `goal` stays. Returns the new
// payload, or null when there is nothing to do (not a project, already has a context, no goal text). A goal longer than the
// "Hotovo, když" limit is left alone (no context): nothing is truncated.
export function migrateProjectGoal(entity: Entity): Entity | null {
  if (!entity || entity.type !== "project" || !isObject(entity.properties)) return null;
  if (entity.properties.context !== undefined && entity.properties.context !== null) return null;
  const goal = typeof entity.properties.goal === "string" ? entity.properties.goal.trim() : "";
  // A null context is treated as missing: without a usable goal it is simply removed, so the record is not held back forever.
  if (!goal) {
    if (entity.properties.context !== null) return null;
    const { context: _removed, ...rest } = entity.properties;
    return { ...entity, properties: rest };
  }
  // Nothing is ever cut: a goal over the limit stays as it is, without a context, and is read in full as "Hotovo, když".
  if (goal.length > contextLimits.doneWhen) {
    if (entity.properties.context !== null) return null;
    const { context: _removed, ...rest } = entity.properties;
    return { ...entity, properties: rest };
  }
  const context: ProjectContext = {
    why: "",
    goals: [],
    doneWhen: goal,
    provenance: "owner",
    updatedAt: Number.isFinite(entity.updatedAt) ? entity.updatedAt : 0,
  };
  return { ...entity, properties: { ...entity.properties, context } };
}

// What the assistant and planners are told about a project: an owner statement (with its provenance), never a guess.
// Null when the owner wrote nothing.
export function projectOwnerStatement(entity: Pick<Entity, "type" | "properties">) {
  if (entity.type !== "project") return null;
  const context = readProjectContext(entity.properties);
  if (contextIsEmpty(context)) return null;
  return {
    why: context.why,
    goals: context.goals,
    doneWhen: context.doneWhen,
    provenance: context.provenance === "lumi-approved" ? "owner-approved Lumi proposal" : "owner statement",
  };
}
