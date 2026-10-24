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
    // A "Hotovo, když" over the limit (written by the previous version into `goal`) cannot be in `context`; it is shown from
    // `goal` so it is never hidden, and the editor asks for it to be shortened before saving.
    const doneWhen = typeof stored.doneWhen === "string" ? stored.doneWhen : "";
    const legacy = typeof properties?.goal === "string" && properties.goal.trim().length > contextLimits.doneWhen && properties.goal !== doneWhen
      ? properties.goal : null;
    return {
      why: typeof stored.why === "string" ? stored.why : "",
      goals: Array.isArray(stored.goals) ? stored.goals.filter((goal): goal is string => typeof goal === "string") : [],
      doneWhen: legacy ?? doneWhen,
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

// "Hotovo, když" as each side of a merge wrote it. A current client edits `context.doneWhen` and mirrors it into
// `goal`; an old client edits `goal` alone, even if a newer context was already received through sync.
// A changed goal that disagrees with the side's context therefore represents the legacy edit, not a stale mirror.
function doneWhenChange(base: Entity, side: Entity): string | null {
  const baseContext = isObject(base.properties?.context) ? base.properties.context as Record<string, unknown> : null;
  const baseGoal = typeof base.properties?.goal === "string" ? base.properties.goal : "";
  const baseDone = baseContext && typeof baseContext.doneWhen === "string" ? baseContext.doneWhen : baseGoal;
  const context = isObject(side.properties?.context) ? side.properties.context as Record<string, unknown> : null;
  const contextDone = context && typeof context.doneWhen === "string" ? context.doneWhen : null;
  const goal = side.properties?.goal;
  const goalChanged = typeof goal === "string" && goal !== baseGoal;
  if (goalChanged && goal !== contextDone) return goal;
  if (contextDone !== null && contextDone !== baseDone) return contextDone;
  return goalChanged ? goal : null;
}

export interface DoneWhenReconciled {
  merged: Entity;
  /** The other side's text when both sides changed "Hotovo, když" differently: a restorable notice for it. */
  lost: { field: "properties.context" | "properties.goal"; value: unknown } | null;
}

// After a three-way merge of a project: `goal` and `context` are merged as separate fields, so an older client's `goal`
// edit and a current client's `doneWhen` edit would both "win" in their own field and the two clients would show
// different texts. This settles one "Hotovo, když": the side that changed it (or, when both did differently, the side
// whose version wins, with the other's text kept as a restorable notice), written to `context.doneWhen` when it fits
// and always mirrored into `goal`. A text over the limit stays in `goal` only; it is read as "Hotovo, když" (see
// readProjectContext) so the editor shows it in full and asks for it to be shortened.
export function reconcileDoneWhen(base: Entity, local: Entity, server: Entity, merged: Entity, localWins: boolean): DoneWhenReconciled {
  if (merged.type !== "project") return { merged, lost: null };
  const fromLocal = doneWhenChange(base, local), fromServer = doneWhenChange(base, server);
  if (fromLocal === null && fromServer === null) return { merged, lost: null };
  const both = fromLocal !== null && fromServer !== null && fromLocal.trim() !== fromServer.trim();
  const winner = both ? (localWins ? fromLocal : fromServer) as string : (fromLocal ?? fromServer) as string;
  const loser = both ? (localWins ? fromServer : fromLocal) as string : null;
  const properties: Record<string, unknown> = { ...merged.properties, goal: winner };
  const context = isObject(merged.properties.context) ? merged.properties.context as Record<string, unknown> : null;
  const fits = winner.trim().length <= contextLimits.doneWhen;
  if (context && fits) properties.context = { ...context, doneWhen: winner.trim() };
  let lost: DoneWhenReconciled["lost"] = null;
  if (loser !== null) {
    // Preserve the losing side's other context fields as well, not the winner's. An older client
    // may have changed a different field while editing goal; restoring the notice must recover both.
    const loserSide = localWins ? server : local;
    const loserContext = isObject(loserSide.properties?.context) ? loserSide.properties.context : context;
    lost = loser.trim().length <= contextLimits.doneWhen && loserContext
      ? { field: "properties.context", value: { ...loserContext, doneWhen: loser.trim() } }
      : { field: "properties.goal", value: loser };
  }
  return { merged: { ...merged, properties }, lost };
}

// After a merge where only one side changed the record (no three-way merge ran): the same settling, with no conflict.
export function syncGoalIntoContext(base: Entity, merged: Entity): Entity {
  return reconcileDoneWhen(base, merged, base, merged, true).merged;
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
  return sameStoredContext(readProjectContext(currentProperties), expected) ? contextPatch(proposed) : null;
}

/** The same stored context: text, provenance and revision. */
export function sameStoredContext(a: ProjectContext, b: ProjectContext) {
  return a.why === b.why && a.doneWhen === b.doneWhen && a.provenance === b.provenance && a.updatedAt === b.updatedAt
    && a.proposalId === b.proposalId && a.goals.length === b.goals.length && a.goals.every((goal, index) => goal === b.goals[index]);
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
