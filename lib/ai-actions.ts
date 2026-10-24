import { createHash, randomUUID } from "node:crypto";
import type { Entity, Relation } from "./db";
import { HttpInputError } from "./http-security";
import { getNotificationPreferences } from "./notifications";
import { ensureDailyBackup, getDatabase, readSnapshot } from "./server-store";
import { completeServerAI } from "./server-ai-provider";
import { buildCurrentPriorities } from "./current-priorities";
import { buildDayPlan, currentDayPlanDate } from "./day-plan";
import { matchesDayPlanCandidate, type DayPlanDecision } from "./day-plan-decision";
import { providerContext } from "./ai-provider-context";
import { enforceAreaWritesInTransaction, readAreaRows } from "./area-write-store";

type CreateOperation = {
  kind: "create";
  entity: Entity;
  relations: Relation[];
};

type UpdateOperation = {
  kind: "update";
  entityId: string;
  expectedUpdatedAt: number;
  patch: Pick<Entity, "title" | "status" | "content" | "properties">;
};

type ProjectOperation = {
  kind: "project";
  entityId: string;
  expectedUpdatedAt: number;
  expectedRelations: Relation[];
  relation: Relation;
};

type AIOperation = CreateOperation | UpdateOperation | ProjectOperation;

export interface PublicAIProposal {
  id: string;
  summary: string;
  changes: Array<{ label: string; value: string }>;
  expiresAt: number;
  workspaceId: string;
  review: {
    target: string;
    workspace: string;
    fields: Array<{ label: string; before: string; after: string }>;
    related: string[];
    sideEffects: string[];
  };
}

export interface AIPlanResponse {
  message: string;
  provider: "hermes" | "openai" | "local";
  proposal?: PublicAIProposal;
}

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

function datePartsInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addCalendarDays(ymd: string, days: number) {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseRequestedDate(input: string) {
  const timezone = getNotificationPreferences().timezone;
  const today = datePartsInTimezone(new Date(), timezone);
  const value = normalize(input);
  if (/\b(dnes|today)\b/.test(value)) return { ymd: today, token: "dnes" };
  if (/\b(zitra|tomorrow)\b/.test(value)) {
    return { ymd: addCalendarDays(today, 1), token: "zítra" };
  }
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return { ymd: iso[0], token: iso[0] };
  const czechDate = value.match(/\b(\d{1,2})\.(\d{1,2})\.(?:\s*(20\d{2}))?\b/);
  if (czechDate) {
    const year = czechDate[3] || today.slice(0, 4);
    const ymd = `${year}-${czechDate[2].padStart(2, "0")}-${czechDate[1].padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(`${ymd}T12:00:00Z`))) return { ymd, token: czechDate[0] };
  }
  const weekdays: Array<[RegExp, number, string]> = [
    [/\b(nedeli|sunday)\b/, 0, "neděli"],
    [/\b(pondeli|monday)\b/, 1, "pondělí"],
    [/\b(utery|tuesday)\b/, 2, "úterý"],
    [/\b(stredu|streda|wednesday)\b/, 3, "středu"],
    [/\b(ctvrtek|thursday)\b/, 4, "čtvrtek"],
    [/\b(patek|friday)\b/, 5, "pátek"],
    [/\b(sobotu|sobota|saturday)\b/, 6, "sobotu"],
  ];
  const currentDay = new Date(`${today}T12:00:00Z`).getUTCDay();
  for (const [pattern, day, label] of weekdays) {
    if (!pattern.test(value)) continue;
    let delta = (day - currentDay + 7) % 7;
    if (delta === 0) delta = 7;
    return { ymd: addCalendarDays(today, delta), token: label };
  }
  return null;
}

function scopedEntities(workspaceId: string) {
  const snapshot = readSnapshot();
  const knownWorkspace = snapshot.entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
  if (!knownWorkspace && workspaceId !== "all") throw new HttpInputError("Workspace not found", 404);
  return {
    snapshot,
    entities: snapshot.entities.filter(
      (entity) => entity.type !== "workspace" && (workspaceId === "all" || entity.workspaceId === workspaceId),
    ),
  };
}

function projectForRequest(input: string, workspaceId: string, entities: Entity[]) {
  const normalized = normalize(input);
  const projects = entities
    .filter((entity) => entity.type === "project" && entity.workspaceId === workspaceId)
    .sort((a, b) => b.title.length - a.title.length);
  return projects.find((project) => normalized.includes(normalize(project.title))) || null;
}

function stripSchedulingAndProject(text: string, project: Entity | null) {
  let title = text.trim().replace(/[.!?]+$/g, "");
  if (project) {
    title = title.replace(
      new RegExp(`\\s+(?:do|v)\\s+projektu\\s+${escapeRegExp(project.title)}`, "iu"),
      "",
    );
  }
  title = title
    .replace(/\s+na\s+(?:dnes|zítra|zitra|pondělí|pondeli|úterý|utery|středu|streda|čtvrtek|ctvrtek|pátek|patek|sobotu|sobota|neděli|nedeli|20\d{2}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.(?:\s*20\d{2})?)$/iu, "")
    .trim();
  return title;
}

function createTaskOperation(
  input: string,
  workspaceId: string,
  workspaceLabel: string,
  entities: Entity[],
) {
  const normalized = normalize(input);
  if (!/\b(pridej|vytvor|zapis|add|create)\b/.test(normalized) || !/\b(ukol|task)\b/.test(normalized)) {
    return null;
  }
  const project = projectForRequest(input, workspaceId, entities);
  const mentionsProject = /\b(do|v) projektu\b/.test(normalized);
  if (mentionsProject && !project) {
    return { clarification: "Projekt z požadavku jsem v tomto workspace nenašel. Upřesni jeho přesný název." };
  }
  const patterns = project
    ? [
        new RegExp(`(?:do|v)\\s+projektu\\s+${escapeRegExp(project.title)}\\s+(?:pridej|vytvor|zapis)\\s+(?:ukol|task)\\s+(.+)`, "iu"),
        new RegExp(`(?:přidej|pridej|vytvoř|vytvor|zapiš|zapis|add|create)\\s+(?:do|v)\\s+projektu\\s+${escapeRegExp(project.title)}\\s+(?:(?:úkol|ukol|task)\\s+)?(.+)`, "iu"),
        /(?:přidej|pridej|vytvoř|vytvor|zapiš|zapis|add|create)\s+(?:úkol|ukol|task)\s+(.+)/iu,
      ]
    : [/(?:přidej|pridej|vytvoř|vytvor|zapiš|zapis|add|create)\s+(?:úkol|ukol|task)\s+(.+)/iu];
  let rawTitle = "";
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match?.[1]) {
      rawTitle = match[1];
      break;
    }
  }
  const title = stripSchedulingAndProject(rawTitle, project);
  if (!title || title.length > 1000) {
    return { clarification: "Napiš prosím stručný název úkolu, který mám vytvořit." };
  }
  const date = parseRequestedDate(input);
  const timezone = getNotificationPreferences().timezone;
  const today = datePartsInTimezone(new Date(), timezone);
  const now = Date.now();
  const entity: Entity = {
    id: randomUUID(),
    type: "task",
    title,
    status: "open",
    workspaceId,
    properties: {
      inbox: !project,
      today: date?.ymd === today,
      ...(date ? { when: date.ymd } : {}),
      activity: [{ at: now, action: "created-by-ai" }],
    },
    createdAt: now,
    updatedAt: now,
  };
  const relations: Relation[] = project
    ? [{
        id: randomUUID(),
        workspaceId,
        sourceEntityId: entity.id,
        targetEntityId: project.id,
        relationType: "belongs_to_project",
        createdAt: now,
      }]
    : [];
  return {
    operation: { kind: "create", entity, relations } as CreateOperation,
    summary: `Vytvořit úkol „${title}“`,
    changes: [
      { label: "Workspace", value: workspaceLabel },
      ...(project ? [{ label: "Project", value: project.title }] : []),
      { label: "When", value: date?.ymd || "Anytime" },
    ],
  };
}

function updateTaskOperation(
  input: string,
  workspaceId: string,
  workspaceLabel: string,
  entities: Entity[],
  referencedEntity?: Entity,
) {
  const normalized = normalize(input);
  if (!/\b(presun|preplanuj|naplanuj|odloz|move|reschedule|snooze)\b/.test(normalized)) return null;
  const date = parseRequestedDate(input);
  if (!date) return { clarification: "Na jaké datum mám úkol přesunout?" };
  const pronounReference = /\b(ho|jej|to|it)\b/.test(normalized) &&
    referencedEntity?.type === "task" &&
    referencedEntity.workspaceId === workspaceId &&
    referencedEntity.status === "open"
    ? referencedEntity
    : undefined;
  const matches = entities
    .filter((entity) => entity.type === "task" && entity.workspaceId === workspaceId && entity.status === "open")
    .filter((entity) => normalized.includes(normalize(entity.title)))
    .sort((a, b) => b.title.length - a.title.length);
  if (!matches.length && !pronounReference) {
    return { clarification: "Otevřený úkol z požadavku jsem v tomto workspace nenašel. Otevři jeho detail nebo napiš přesný název." };
  }
  if (matches.length > 1 && matches[0].title.length === matches[1].title.length) {
    return { clarification: "Našel jsem více odpovídajících úkolů. Upřesni prosím jejich název." };
  }
  const entity = matches[0] || pronounReference!;
  const today = datePartsInTimezone(new Date(), getNotificationPreferences().timezone);
  const properties = {
    ...entity.properties,
    when: date.ymd,
    today: date.ymd === today,
    inbox: false,
    activity: [
      ...(Array.isArray(entity.properties.activity) ? entity.properties.activity : []),
      { at: Date.now(), action: "rescheduled-by-ai" },
    ].slice(-50),
  };
  return {
    operation: {
      kind: "update",
      entityId: entity.id,
      expectedUpdatedAt: entity.updatedAt,
      patch: {
        title: entity.title,
        content: entity.content || "",
        status: entity.status,
        properties,
      },
    } as UpdateOperation,
    summary: `Přesunout úkol „${entity.title}“`,
    changes: [
      { label: "Workspace", value: workspaceLabel },
      { label: "From", value: String(entity.properties.when || "Anytime") },
      { label: "To", value: date.ymd },
    ],
  };
}

function taskForRequest(
  input: string,
  workspaceId: string,
  entities: Entity[],
  referencedEntity?: Entity,
) {
  const normalized = normalize(input);
  const referenced = referencedEntity?.type === "task" &&
    referencedEntity.workspaceId === workspaceId ? referencedEntity : undefined;
  const matches = entities
    .filter((entity) => entity.type === "task" && entity.workspaceId === workspaceId)
    .filter((entity) => normalized.includes(normalize(entity.title)))
    .sort((a, b) => b.title.length - a.title.length);
  if (matches.length > 1 && matches[0].title.length === matches[1].title.length) return null;
  return matches[0] || referenced || null;
}

function completeTaskOperation(
  input: string,
  workspaceId: string,
  workspaceLabel: string,
  entities: Entity[],
  referencedEntity?: Entity,
) {
  const normalized = normalize(input);
  if (!/\b(dokonc|spln|oznac.*hotov|complete|finish|mark.*done)\w*/.test(normalized)) return null;
  const entity = taskForRequest(input, workspaceId, entities, referencedEntity);
  if (!entity || entity.status !== "open") return { clarification: "Otevřený úkol jsem nenašel. Otevři jeho detail nebo napiš přesný název." };
  const activity = [
    ...(Array.isArray(entity.properties.activity) ? entity.properties.activity : []),
    { at: Date.now(), action: "completed-by-ai" },
  ].slice(-50);
  return {
    operation: {
      kind: "update", entityId: entity.id, expectedUpdatedAt: entity.updatedAt,
      patch: { title: entity.title, content: entity.content || "", status: "completed", properties: { ...entity.properties, activity } },
    } as UpdateOperation,
    summary: `Dokončit úkol „${entity.title}“`,
    changes: [{ label: "Workspace", value: workspaceLabel }, { label: "Status", value: "Open → Completed" }],
  };
}

function prioritizeTaskOperation(
  input: string,
  workspaceId: string,
  workspaceLabel: string,
  entities: Entity[],
  referencedEntity?: Entity,
) {
  const normalized = normalize(input);
  if (!/\b(priorit|priority)\w*/.test(normalized)) return null;
  const priority = /\b(vysok|high)\w*/.test(normalized) ? "high" :
    /\b(stred|medium)\w*/.test(normalized) ? "medium" :
      /\b(nizk|low)\w*/.test(normalized) ? "low" :
        /\b(bez|none)\w*/.test(normalized) ? "none" : "";
  if (!priority) return { clarification: "Jakou prioritu mám nastavit: vysokou, střední, nízkou, nebo žádnou?" };
  const entity = taskForRequest(input, workspaceId, entities, referencedEntity);
  if (!entity || entity.status !== "open") return { clarification: "Otevřený úkol jsem nenašel. Otevři jeho detail nebo napiš přesný název." };
  return {
    operation: {
      kind: "update", entityId: entity.id, expectedUpdatedAt: entity.updatedAt,
      patch: { title: entity.title, content: entity.content || "", status: entity.status, properties: { ...entity.properties, priority } },
    } as UpdateOperation,
    summary: `Změnit prioritu úkolu „${entity.title}“`,
    changes: [
      { label: "Workspace", value: workspaceLabel },
      { label: "Priority", value: `${String(entity.properties.priority || "none")} → ${priority}` },
    ],
  };
}

function moveTaskToProjectOperation(
  input: string,
  workspaceId: string,
  workspaceLabel: string,
  entities: Entity[],
  relations: Relation[],
  referencedEntity?: Entity,
) {
  const normalized = normalize(input);
  if (!/\b(projekt|project)\w*/.test(normalized) || !/\b(presun|zarad|move)\w*/.test(normalized)) return null;
  const project = projectForRequest(input, workspaceId, entities);
  if (!project) return { clarification: "Cílový projekt jsem v tomto workspace nenašel. Napiš jeho přesný název." };
  const entity = taskForRequest(input, workspaceId, entities, referencedEntity);
  if (!entity || entity.status !== "open") return { clarification: "Otevřený úkol jsem nenašel. Otevři jeho detail nebo napiš přesný název." };
  const current = relations
    .filter((relation) => relation.workspaceId === workspaceId && relation.sourceEntityId === entity.id && relation.relationType === "belongs_to_project")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (current.some((relation) => relation.targetEntityId === project.id)) {
    return { clarification: `Úkol už je v projektu „${project.title}“.` };
  }
  const previous = current[0]
    ? entities.find((candidate) => candidate.id === current[0].targetEntityId)?.title || "jiný projekt"
    : "bez projektu";
  return {
    operation: {
      kind: "project", entityId: entity.id, expectedUpdatedAt: entity.updatedAt, expectedRelations: current,
      relation: { id: randomUUID(), workspaceId, sourceEntityId: entity.id, targetEntityId: project.id, relationType: "belongs_to_project", createdAt: Date.now() },
    } as ProjectOperation,
    summary: `Přesunout úkol „${entity.title}“ do projektu „${project.title}“`,
    changes: [
      { label: "Workspace", value: workspaceLabel },
      { label: "Project", value: `${previous} → ${project.title}` },
    ],
  };
}

function createProposal(
  sessionBinding: string,
  workspaceId: string,
  baseRevision: number,
  operation: AIOperation,
  summary: string,
  changes: Array<{ label: string; value: string }>,
): PublicAIProposal {
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;
  const snapshot = readSnapshot();
  const previous = operation.kind === "create" ? null : snapshot.entities.find((entity) => entity.id === operation.entityId && entity.workspaceId === workspaceId);
  const workspace = snapshot.entities.find((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId)?.title || workspaceId;
  const fields: PublicAIProposal["review"]["fields"] = [];
  const related: string[] = [];
  if (previous) {
    for (const relation of snapshot.relations) {
      if (relation.workspaceId !== workspaceId || relation.sourceEntityId !== previous.id && relation.targetEntityId !== previous.id) continue;
      const otherId = relation.sourceEntityId === previous.id ? relation.targetEntityId : relation.sourceEntityId;
      const other = snapshot.entities.find((entity) => entity.id === otherId && entity.workspaceId === workspaceId);
      if (other && !related.includes(other.title)) related.push(other.title);
    }
  }
  if (operation.kind === "create") {
    fields.push({ label: "Task", before: "Does not exist", after: operation.entity.title });
    fields.push({ label: "When", before: "—", after: String(operation.entity.properties.when || "Anytime") });
    for (const relation of operation.relations) {
      const target = snapshot.entities.find((entity) => entity.id === relation.targetEntityId && entity.workspaceId === workspaceId);
      if (target) related.push(target.title);
    }
  } else if (operation.kind === "project") {
    const oldProject = operation.expectedRelations[0] && snapshot.entities.find((entity) => entity.id === operation.expectedRelations[0].targetEntityId && entity.workspaceId === workspaceId);
    const newProject = snapshot.entities.find((entity) => entity.id === operation.relation.targetEntityId && entity.workspaceId === workspaceId);
    fields.push({ label: "Project", before: oldProject?.title || "No project", after: newProject?.title || "Unknown project" });
    if (newProject) related.push(newProject.title);
  } else if (previous) {
    const after = operation.patch;
    // Review the actual values that will be written, not just the requested date.
    // Even a same-date reschedule can remove a task from Inbox (true -> false).
    const addChange = (label: string, beforeValue: unknown, afterValue: unknown) => {
      const display = (value: unknown) => value === undefined || value === null || value === "" ? "—" : String(value);
      const before = display(beforeValue);
      const next = display(afterValue);
      if (before !== next) fields.push({ label, before, after: next });
    };
    addChange("Title", previous.title, after.title);
    addChange("Content", previous.content, after.content);
    addChange("Status", previous.status, after.status);
    for (const [label, key] of [["When", "when"], ["Priority", "priority"], ["Planned start", "plannedStart"], ["Planned end", "plannedEnd"]] as const) {
      addChange(label, previous.properties[key], after.properties[key]);
    }
    for (const [label, key] of [["Inbox", "inbox"], ["Today", "today"], ["Someday", "someday"]] as const) {
      // Missing legacy flags behave like false in list membership; do not hide false with ||.
      addChange(label, previous.properties[key] === true, after.properties[key] === true);
    }
    const oldDecision = (previous.properties.planningFeedback as { decision?: string } | undefined)?.decision;
    const newDecision = (after.properties.planningFeedback as { decision?: string } | undefined)?.decision;
    addChange("Planning decision", oldDecision, newDecision);
    // An empty diff means no displayed task field changes (for example, an activity-only write).
    // Do not manufacture a generic "Planning decision: No decision -> Updated" in that case.
  }
  const review = {
    target: operation.kind === "create" ? operation.entity.title : previous?.title || summary,
    workspace,
    fields,
    related,
    sideEffects: [
      "approvalTaskSync",
      ...(operation.kind === "update" && fields.some((field) => ["When", "Planned start", "Planned end"].includes(field.label)) ? ["approvalCalendarView"] : []),
      "approvalNoExternalWrite",
    ],
  };
  getDatabase()
    .prepare(`
      INSERT INTO ai_proposals
        (id, session_binding, workspace_id, base_revision, payload, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `)
    .run(id, sessionBinding, workspaceId, baseRevision, JSON.stringify({ operation, summary, changes }), now, expiresAt);
  getDatabase().prepare("DELETE FROM ai_proposals WHERE expires_at < ? AND status = 'pending'").run(now);
  return { id, summary, changes, expiresAt, workspaceId, review };
}

export function proposeDayPlanBlock(input: {
  sessionBinding: string;
  workspaceId: string;
  date: string;
  taskId: string;
  start: string;
  end: string;
  revision: number;
  decision: DayPlanDecision;
}) {
  if (input.date !== currentDayPlanDate()) throw new HttpInputError("Day plan date changed; review it again", 409);
  const plan = buildDayPlan(input.workspaceId, input.date);
  if (plan.revision !== input.revision || !matchesDayPlanCandidate(plan, input)) {
    throw new HttpInputError("Day plan changed; review it again", 409);
  }
  const snapshot = readSnapshot();
  const task = snapshot.entities.find((entity) => entity.id === input.taskId && entity.type === "task" && entity.status === "open" && entity.workspaceId === input.workspaceId);
  if (!task) throw new HttpInputError("Task changed; review the plan again", 409);
  const feedback = { source: "albert-day-plan", date: input.date, decision: input.decision, at: Date.now(), proposedStart: input.start,
    proposedEnd: input.end, ...(input.decision === "accepted" ? { plannedMinutes: Math.round((Date.parse(input.end) - Date.parse(input.start)) / 60_000) } : {}) };
  const history = Array.isArray(task.properties.planningHistory) ? task.properties.planningHistory : [];
  const properties = input.decision === "accepted"
    ? { ...task.properties, plannedStart: input.start, plannedEnd: input.end, planningSource: "albert-day-plan" }
    : input.decision === "tomorrow"
      ? { ...task.properties, when: addCalendarDays(input.date, 1), today: false, plannedStart: "", plannedEnd: "", inbox: false, someday: false }
      : { ...task.properties };
  return createProposal(input.sessionBinding, input.workspaceId, snapshot.revision, {
    kind: "update", entityId: task.id, expectedUpdatedAt: task.updatedAt,
    patch: {
      title: task.title, status: task.status, content: task.content || "",
      properties: { ...properties, planningFeedback: feedback, planningHistory: [...history, feedback].slice(-50) },
    },
  }, `${input.decision === "accepted" ? "Naplánovat" : input.decision === "tomorrow" ? "Přesunout na zítra" : "Dnes neplánovat"} úkol „${task.title}“`, [
    { label: "Úkol", value: task.title },
    { label: "Rozhodnutí", value: input.decision },
    ...(input.decision === "accepted" ? [{ label: "Čas", value: `${input.start} – ${input.end}` }] : []),
  ]);
}

function currentPrioritiesAnswer(workspaceId: string) {
  if (workspaceId === "all") return "Pro přehled priorit vyber konkrétní workspace; souhrn All my work zůstává jen čtecí agregace.";
  const priorities = buildCurrentPriorities(workspaceId);
  const tasks = priorities.topTasks.length
    ? priorities.topTasks.map((task, index) => `${index + 1}. ${task.title} — ${task.reason}`).join("\n")
    : "Žádné prioritní otevřené úkoly.";
  return `Co je teď důležité (${priorities.localDate}, ${priorities.timezone})\n${priorities.summary}\n${tasks}\nDoporučení: ${priorities.suggestions.join(" ")}`;
}

function referencedEntity(
  sessionBinding: string,
  workspaceId: string,
  entities: Entity[],
  focusEntityId?: string,
) {
  const focused = focusEntityId
    ? entities.find((entity) => entity.id === focusEntityId && entity.workspaceId === workspaceId)
    : undefined;
  if (focused) return focused;
  const latest = getDatabase().prepare(`
    SELECT entity_id FROM ai_action_history
    WHERE session_binding = ? AND workspace_id = ? AND status = 'applied'
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionBinding, workspaceId) as { entity_id?: string } | undefined;
  return latest?.entity_id
    ? entities.find((entity) => entity.id === latest.entity_id && entity.workspaceId === workspaceId)
    : undefined;
}

export async function planAIRequest(input: {
  message: string;
  readWorkspaceId: string;
  writeWorkspaceId: string;
  focusEntityId?: string;
  sessionBinding: string;
}): Promise<AIPlanResponse> {
  const { snapshot, entities } = scopedEntities(input.readWorkspaceId);
  const writeScope = scopedEntities(input.writeWorkspaceId);
  const writeWorkspaceLabel = writeScope.snapshot.entities.find(
    (entity) => entity.type === "workspace" && entity.workspaceId === input.writeWorkspaceId,
  )?.title || input.writeWorkspaceId;
  const normalized = normalize(input.message);
  if (/\b(co dnes hori|ranni prehled|dnes dulezite|morning brief|today brief)\b/.test(normalized)) {
    return { message: currentPrioritiesAnswer(input.readWorkspaceId), provider: "local" };
  }

  const reference = referencedEntity(
    input.sessionBinding,
    input.writeWorkspaceId,
    writeScope.entities,
    input.focusEntityId,
  );
  const writePlan =
    createTaskOperation(
      input.message,
      input.writeWorkspaceId,
      writeWorkspaceLabel,
      writeScope.entities,
    ) ||
    moveTaskToProjectOperation(input.message, input.writeWorkspaceId, writeWorkspaceLabel, writeScope.entities, writeScope.snapshot.relations, reference) ||
    updateTaskOperation(
      input.message,
      input.writeWorkspaceId,
      writeWorkspaceLabel,
      writeScope.entities,
      reference,
    ) ||
    completeTaskOperation(input.message, input.writeWorkspaceId, writeWorkspaceLabel, writeScope.entities, reference) ||
    prioritizeTaskOperation(input.message, input.writeWorkspaceId, writeWorkspaceLabel, writeScope.entities, reference);
  if (writePlan && "clarification" in writePlan) {
    return { message: writePlan.clarification, provider: "local" };
  }
  if (writePlan && "operation" in writePlan) {
    const proposal = createProposal(
      input.sessionBinding,
      input.writeWorkspaceId,
      snapshot.revision,
      writePlan.operation,
      writePlan.summary,
      writePlan.changes,
    );
    return {
      message: "Připravil jsem návrh. Data se změní až po tvém potvrzení.",
      provider: "local",
      proposal,
    };
  }

  const focus = input.focusEntityId
    ? entities.find((entity) => entity.id === input.focusEntityId)
    : undefined;
  const prompt = `${providerContext(input.readWorkspaceId, entities, focus?.id)}\nUser request: ${input.message}`;
  const result = await completeServerAI(prompt);
  if (result) return result;
  return {
    provider: "local",
    message:
      "Model zatím není připojený. Umím ale bezpečně připravit úkol, přesunout ho, dokončit ho, změnit prioritu nebo vytvořit dnešní přehled. Zkus například „Co dnes hoří?“.",
  };
}

function readRevision() {
  return Number(
    (getDatabase().prepare("SELECT value FROM metadata WHERE key = 'revision'").get() as { value?: string } | undefined)?.value || 0,
  );
}

function setRevision(revision: number, updatedAt: number) {
  const statement = getDatabase().prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  statement.run("revision", String(revision));
  statement.run("updatedAt", String(updatedAt));
}

function publicActionResult(row: { result?: string | null }) {
  if (!row.result) return null;
  return JSON.parse(row.result) as { actionId: string; message: string };
}

export function confirmAIProposal(proposalId: string, sessionBinding: string) {
  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT * FROM ai_proposals WHERE id = ?").get(proposalId) as any;
    if (!row || row.session_binding !== sessionBinding) throw new Error("Proposal not found");
    if (row.status === "applied") {
      database.exec("COMMIT");
      return publicActionResult(row);
    }
    if (row.status !== "pending" || Number(row.expires_at) <= Date.now()) {
      throw new Error("Proposal expired or is no longer pending");
    }
    if (readRevision() !== Number(row.base_revision)) {
      throw new Error("Data changed after this proposal was created. Ask the assistant again.");
    }
    const payload = JSON.parse(String(row.payload)) as {
      operation: AIOperation;
      summary: string;
    };
    const operation = payload.operation;
    if (operation.kind === "update" && (
        (operation.patch.properties.planningFeedback as { source?: string } | undefined)?.source === "albert-day-plan" ||
        (operation.patch.properties.planningFeedback as { decision?: string } | undefined)?.decision === "accepted" &&
          operation.patch.properties.planningSource === "albert-day-plan")) {
      const properties = operation.patch.properties;
      const feedback = properties.planningFeedback as { date?: string; decision?: string; proposedStart?: string; proposedEnd?: string };
      if (feedback.date !== currentDayPlanDate()) throw new Error("Day plan date changed; review it again");
      const plan = buildDayPlan(String(row.workspace_id), String(feedback.date || ""));
      const validDecision = feedback.decision === "accepted" || feedback.decision === "tomorrow" || feedback.decision === "dismissed";
      const valid = validDecision && matchesDayPlanCandidate(plan, {
        taskId: operation.entityId, start: feedback.proposedStart || "",
        end: feedback.proposedEnd || (feedback.decision === "accepted" ? String(properties.plannedEnd || "") : ""),
        decision: feedback.decision as DayPlanDecision,
      }) && (feedback.decision !== "accepted" || properties.plannedStart === feedback.proposedStart && properties.plannedEnd === (feedback.proposedEnd || properties.plannedEnd));
      if (!valid) throw new Error("Day plan changed; review it again");
      if (feedback.decision === "accepted") {
        const start = Date.parse(String(properties.plannedStart || ""));
        const end = Date.parse(String(properties.plannedEnd || ""));
        const overlap = readSnapshot().entities.some((entity) => {
          if (entity.id === operation.entityId || entity.type !== "task" || entity.status !== "open" || entity.workspaceId !== row.workspace_id) return false;
          const otherStart = Date.parse(String(entity.properties.plannedStart || ""));
          const otherEnd = Date.parse(String(entity.properties.plannedEnd || ""));
          return Number.isFinite(otherStart) && Number.isFinite(otherEnd) && start < otherEnd && end > otherStart;
        });
        if (overlap) throw new Error("Day plan changed; another task uses this time");
      }
    }
    const now = Date.now();
    // 2a part 4: the Area model is enforced for what this action changes (a created standalone task gets the
    // fallback Area, a task moved into a project drops its own Area links).
    const areaBefore = readAreaRows(database);
    let before: Entity | null = null;
    let after: Entity;
    let beforeRelations: Relation[] = [];
    let afterRelations: Relation[] = [];
    if (operation.kind === "create") {
      if (operation.entity.workspaceId !== row.workspace_id || operation.entity.type === "workspace") {
        throw new Error("Proposal workspace is invalid");
      }
      const workspace = database.prepare("SELECT payload FROM entities WHERE id = ?").get(`workspace:${row.workspace_id}`);
      if (!workspace) throw new Error("Workspace not found");
      for (const relation of operation.relations) {
        if (relation.workspaceId !== row.workspace_id || relation.sourceEntityId !== operation.entity.id) {
          throw new Error("Proposal relation is invalid");
        }
        const target = database.prepare("SELECT payload FROM entities WHERE id = ?").get(relation.targetEntityId) as { payload?: string } | undefined;
        if (!target || JSON.parse(String(target.payload)).workspaceId !== row.workspace_id) {
          throw new Error("Proposal target is invalid");
        }
      }
      after = { ...operation.entity, updatedAt: now };
      database.prepare("DELETE FROM tombstones WHERE id = ?").run(after.id);
      database.prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
        .run(after.id, JSON.stringify(after), after.updatedAt);
      for (const relation of operation.relations) {
        database.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)")
          .run(relation.id, JSON.stringify(relation), relation.createdAt);
      }
    } else {
      const stored = database.prepare("SELECT payload FROM entities WHERE id = ?").get(operation.entityId) as { payload?: string } | undefined;
      if (!stored) throw new Error("Entity no longer exists");
      before = JSON.parse(String(stored.payload)) as Entity;
      if (before.workspaceId !== row.workspace_id || before.updatedAt !== operation.expectedUpdatedAt) {
        throw new Error("Entity changed after this proposal was created. Ask the assistant again.");
      }
      if (operation.kind === "project") {
        const current = database.prepare("SELECT payload FROM relations").all()
          .map((item) => JSON.parse(String((item as { payload: string }).payload)) as Relation)
          .filter((relation) => relation.workspaceId === row.workspace_id && relation.sourceEntityId === before!.id && relation.relationType === "belongs_to_project")
          .sort((a, b) => a.id.localeCompare(b.id));
        if (stableJson(current) !== stableJson(operation.expectedRelations)) {
          throw new Error("Project relation changed after this proposal was created. Ask the assistant again.");
        }
        const targetRow = database.prepare("SELECT payload FROM entities WHERE id = ?").get(operation.relation.targetEntityId) as { payload?: string } | undefined;
        const target = targetRow?.payload ? JSON.parse(targetRow.payload) as Entity : null;
        if (!target || target.type !== "project" || target.workspaceId !== row.workspace_id ||
            operation.relation.workspaceId !== row.workspace_id || operation.relation.sourceEntityId !== before.id) {
          throw new Error("Proposal project is invalid");
        }
        beforeRelations = current;
        afterRelations = [operation.relation];
        for (const relation of current) database.prepare("DELETE FROM relations WHERE id = ?").run(relation.id);
        database.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)")
          .run(operation.relation.id, JSON.stringify(operation.relation), operation.relation.createdAt);
        after = { ...before, updatedAt: now };
      } else {
        after = {
          ...before,
          ...operation.patch,
          id: before.id,
          type: before.type,
          workspaceId: before.workspaceId,
          createdAt: before.createdAt,
          updatedAt: now,
        };
      }
      database.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(after), after.updatedAt, after.id);
    }
    let recordedRelations: Relation[] | null = null;
    if (enforceAreaWritesInTransaction(database, areaBefore, now).changed) {
      // The history must describe what is stored now, or the undo would refuse the changed record / relations.
      after = JSON.parse(String((database.prepare("SELECT payload FROM entities WHERE id = ?").get(after.id) as { payload: string }).payload)) as Entity;
      if (operation.kind === "create") {
        recordedRelations = database.prepare("SELECT payload FROM relations").all()
          .map((item) => JSON.parse(String((item as { payload: string }).payload)) as Relation)
          .filter((relation) => relation.sourceEntityId === after.id || relation.targetEntityId === after.id);
      }
    }
    const actionId = randomUUID();
    const result = { actionId, message: `${payload.summary} — hotovo.` };
    database.prepare(`
      INSERT INTO ai_action_history
        (id, proposal_id, session_binding, workspace_id, action, entity_id,
         before_payload, after_payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)
    `).run(
      actionId,
      proposalId,
      sessionBinding,
      row.workspace_id,
      operation.kind,
      after.id,
      before ? JSON.stringify({ entity: before, relations: beforeRelations }) : null,
      JSON.stringify({
        entity: after,
        relations: operation.kind === "create" ? recordedRelations ?? operation.relations : afterRelations,
      }),
      now,
    );
    database.prepare("UPDATE ai_proposals SET status = 'applied', result = ? WHERE id = ?")
      .run(JSON.stringify(result), proposalId);
    setRevision(readRevision() + 1, now);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function cancelAIProposal(proposalId: string, sessionBinding: string) {
  const result = getDatabase().prepare(`
    UPDATE ai_proposals SET status = 'cancelled'
    WHERE id = ? AND session_binding = ? AND status = 'pending'
  `).run(proposalId, sessionBinding);
  return Number(result.changes) === 1;
}

export function undoAIAction(actionId: string, sessionBinding: string) {
  ensureDailyBackup();
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT * FROM ai_action_history WHERE id = ?").get(actionId) as any;
    if (!row || row.session_binding !== sessionBinding) throw new Error("AI action not found");
    if (row.status === "undone") {
      database.exec("COMMIT");
      return { actionId, message: "Změna už byla vrácena." };
    }
    const afterRecord = JSON.parse(String(row.after_payload)) as {
      entity?: Entity;
      relationIds?: string[];
      relations?: Relation[];
    } | Entity;
    const after = "entity" in afterRecord && afterRecord.entity
      ? afterRecord.entity
      : afterRecord as Entity;
    const stored = database.prepare("SELECT payload FROM entities WHERE id = ?").get(row.entity_id) as { payload?: string } | undefined;
    if (!stored) throw new Error("Entity no longer exists");
    const current = JSON.parse(String(stored.payload)) as Entity;
    if (current.updatedAt !== after.updatedAt) {
      throw new Error("Entity was changed later, so this action cannot be safely undone.");
    }
    const now = Date.now();
    const areaBefore = readAreaRows(database);
    if (row.action === "create") {
      const expectedRelations = "relations" in afterRecord && Array.isArray(afterRecord.relations)
        ? afterRecord.relations
        : [];
      const expectedRelationIds = expectedRelations.length
        ? expectedRelations.map((relation) => relation.id).sort()
        : (
            "relationIds" in afterRecord && Array.isArray(afterRecord.relationIds)
              ? afterRecord.relationIds
              : []
          ).sort();
      const incidentRelations = database
        .prepare("SELECT id, payload FROM relations")
        .all()
        .map((item) => ({
          id: String((item as { id: string }).id),
          relation: JSON.parse(String((item as { payload: string }).payload)) as Relation,
        }))
        .filter(
          (item) =>
            item.relation.sourceEntityId === row.entity_id ||
            item.relation.targetEntityId === row.entity_id,
        );
      const currentRelationIds = incidentRelations.map((item) => item.id).sort();
      if (
        currentRelationIds.length !== expectedRelationIds.length ||
        currentRelationIds.some((id, index) => id !== expectedRelationIds[index])
      ) {
        throw new Error("Entity relations changed later, so this action cannot be safely undone.");
      }
      if (
        expectedRelations.length &&
        incidentRelations.some((item) => {
          const expected = expectedRelations.find((relation) => relation.id === item.id);
          return !expected || stableJson(expected) !== stableJson(item.relation);
        })
      ) {
        throw new Error("Entity relations changed later, so this action cannot be safely undone.");
      }
      const removeRelation = database.prepare("DELETE FROM relations WHERE id = ?");
      for (const relationId of expectedRelationIds) removeRelation.run(relationId);
      database.prepare("DELETE FROM entities WHERE id = ?").run(row.entity_id);
      database.prepare(`
        INSERT INTO tombstones (id, deleted_at) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at
      `).run(row.entity_id, now);
    } else {
      const beforeRecord = JSON.parse(String(row.before_payload)) as { entity?: Entity; relations?: Relation[] } | Entity;
      const before = "entity" in beforeRecord && beforeRecord.entity
        ? beforeRecord.entity
        : beforeRecord as Entity;
      if (row.action === "project") {
        const expected = "relations" in afterRecord && Array.isArray(afterRecord.relations)
          ? afterRecord.relations.sort((a, b) => a.id.localeCompare(b.id)) : [];
        const currentRelations = database.prepare("SELECT payload FROM relations").all()
          .map((item) => JSON.parse(String((item as { payload: string }).payload)) as Relation)
          .filter((relation) => relation.workspaceId === row.workspace_id && relation.sourceEntityId === row.entity_id && relation.relationType === "belongs_to_project")
          .sort((a, b) => a.id.localeCompare(b.id));
        if (stableJson(currentRelations) !== stableJson(expected)) {
          throw new Error("Project relation was changed later, so this action cannot be safely undone.");
        }
        for (const relation of currentRelations) database.prepare("DELETE FROM relations WHERE id = ?").run(relation.id);
        const previousRelations = "relations" in beforeRecord && Array.isArray(beforeRecord.relations) ? beforeRecord.relations : [];
        for (const relation of previousRelations) {
          database.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)")
            .run(relation.id, JSON.stringify(relation), relation.createdAt);
        }
      }
      const restored = { ...before, updatedAt: now };
      database.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(restored), restored.updatedAt, restored.id);
    }
    // A task taken out of a project again gets the fallback Area (lib/area-write-invariants.ts).
    enforceAreaWritesInTransaction(database, areaBefore, now);
    database.prepare("UPDATE ai_action_history SET status = 'undone', undone_at = ? WHERE id = ?")
      .run(now, actionId);
    setRevision(readRevision() + 1, now);
    database.exec("COMMIT");
    return { actionId, message: "AI změna byla bezpečně vrácena." };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function aiAuditDetails(proposalId: string, actionId?: string) {
  return {
    proposalIdHash: createHash("sha256").update(proposalId).digest("hex").slice(0, 16),
    ...(actionId ? { actionIdHash: createHash("sha256").update(actionId).digest("hex").slice(0, 16) } : {}),
  };
}
