import { randomUUID } from "node:crypto";
import { calendarAvailability, listCalendarEvents } from "./calendar";
import type { Entity } from "./db";
import { getDatabase, readSnapshot } from "./server-store";

export type PACTPermission = "read" | "propose" | "write" | "send";
export type ContextScope = "me" | "work" | "family" | "rules" | "project" | "workspace";
export type ContextSensitivity = "normal" | "sensitive";
export type ContextProvenance = "owner" | "imported" | "ai-suggested";

export interface PACTAgentDefinition {
  id: string;
  name: string;
  version: number;
  instructions: string;
  contextScopes: ContextScope[];
  tools: string[];
  triggerModes: Array<"manual" | "scheduled" | "event">;
}

export interface PACTContextItem {
  id: string;
  workspaceId: string;
  scope: ContextScope;
  sensitivity: ContextSensitivity;
  provenance: ContextProvenance;
  status: "active" | "archived" | "pending";
  title: string;
  content: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedPACTContext {
  workspaceId: string;
  agent: PACTAgentDefinition;
  entities: Entity[];
  context: PACTContextItem[];
  calendar: {
    configured: boolean;
    fresh: boolean;
    freeHours: number;
    busyHours: number;
    events: Array<{ title: string; start: string; end: string; private: boolean }>;
  } | null;
}

export const alfredAgent: PACTAgentDefinition = {
  id: "aifred",
  name: "AIfréd",
  version: 1,
  instructions: "Act as a calm proactive personal chief of staff. Prefer concise recommendations. Never claim that a mutation happened unless the server confirms it.",
  contextScopes: ["me", "work", "family", "rules", "project", "workspace"],
  tools: ["task.read", "project.read", "note.read", "calendar.read", "calendar.free_time", "context.read", "task.propose"],
  triggerModes: ["manual", "scheduled"],
};

function assertWorkspace(workspaceId: string) {
  if (workspaceId === "all") throw new Error("PACT agent runs require one explicit workspace");
  const exists = readSnapshot().entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
  if (!exists) throw new Error("Workspace not found");
}

export function ensurePACTDefaults() {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO pact_agents (id, payload, version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, version=excluded.version, updated_at=excluded.updated_at`)
    .run(alfredAgent.id, JSON.stringify(alfredAgent), alfredAgent.version, now, now);
  const insertPermission = db.prepare(`INSERT OR IGNORE INTO pact_tool_permissions
    (agent_id, tool_name, permission, workspace_id) VALUES (?, ?, ?, '*')`);
  for (const tool of alfredAgent.tools) {
    insertPermission.run(alfredAgent.id, tool, tool.endsWith(".propose") ? "propose" : "read");
  }
}

export function listPACTContext(workspaceId: string, scopes: ContextScope[]) {
  assertWorkspace(workspaceId);
  if (!scopes.length) return [];
  const placeholders = scopes.map(() => "?").join(",");
  return getDatabase().prepare(`SELECT payload FROM pact_context
    WHERE workspace_id = ? AND status = 'active' AND scope IN (${placeholders})
    ORDER BY updated_at DESC LIMIT 100`)
    .all(workspaceId, ...scopes)
    .map((row) => JSON.parse(String((row as { payload: string }).payload)) as PACTContextItem);
}

export function saveOwnerContext(input: Omit<PACTContextItem, "id" | "provenance" | "status" | "createdAt" | "updatedAt">) {
  assertWorkspace(input.workspaceId);
  const now = Date.now();
  const item: PACTContextItem = {
    ...input,
    id: randomUUID(),
    provenance: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  getDatabase().prepare(`INSERT INTO pact_context
    (id, workspace_id, scope, sensitivity, provenance, payload, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.id, item.workspaceId, item.scope, item.sensitivity, item.provenance, JSON.stringify(item), item.status, now, now);
  return item;
}

export function resolvePACTContext(input: {
  agent?: PACTAgentDefinition;
  workspaceId: string;
  projectId?: string;
  includeSensitive?: boolean;
  calendarRange?: { from: number; to: number; localDate: string; timezone: string; workdayStart: string; workdayEnd: string };
}): ResolvedPACTContext {
  const agent = input.agent || alfredAgent;
  assertWorkspace(input.workspaceId);
  ensurePACTDefaults();
  const snapshot = readSnapshot();
  const entities = snapshot.entities.filter((entity) =>
    entity.type !== "workspace" &&
    entity.workspaceId === input.workspaceId &&
    (!input.projectId || entity.id === input.projectId || snapshot.relations.some((relation) =>
      relation.workspaceId === input.workspaceId &&
      relation.sourceEntityId === entity.id &&
      relation.targetEntityId === input.projectId
    ))
  );
  const context = listPACTContext(input.workspaceId, agent.contextScopes)
    .filter((item) => input.includeSensitive || item.sensitivity !== "sensitive")
    .filter((item) => !item.projectId || !input.projectId || item.projectId === input.projectId);
  let calendar: ResolvedPACTContext["calendar"] = null;
  if (input.calendarRange && agent.tools.includes("calendar.read")) {
    const availability = calendarAvailability(
      input.workspaceId,
      input.calendarRange.localDate,
      input.calendarRange.timezone,
      input.calendarRange.workdayStart,
      input.calendarRange.workdayEnd,
    );
    const events = listCalendarEvents(input.workspaceId, input.calendarRange.from, input.calendarRange.to)
      .slice(0, 50)
      .map((event) => ({ title: event.title, start: event.start, end: event.end, private: event.private }));
    calendar = { ...availability, events };
  }
  return { workspaceId: input.workspaceId, agent, entities, context, calendar };
}

export function beginPACTRun(agentId: string, workspaceId: string, triggerMode: string, inputSummary: string) {
  assertWorkspace(workspaceId);
  const id = randomUUID();
  getDatabase().prepare(`INSERT INTO pact_agent_runs
    (id, agent_id, workspace_id, trigger_mode, status, input_summary, created_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, agentId, workspaceId, triggerMode, inputSummary.slice(0, 500), Date.now());
  return id;
}

export function finishPACTRun(id: string, status: "completed" | "failed", outputSummary: string) {
  getDatabase().prepare(`UPDATE pact_agent_runs
    SET status = ?, output_summary = ?, completed_at = ? WHERE id = ?`)
    .run(status, outputSummary.slice(0, 1000), Date.now(), id);
}
