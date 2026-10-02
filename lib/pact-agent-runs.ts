import { listCalendarEvents } from "./calendar";
import { beginPACTRun, finishPACTRun, getPACTAgent, resolvePACTContext } from "./pact";
import { readSnapshot } from "./server-store";

export type ManualPACTAgentId = "project-manager" | "meeting-prep";

export interface ManualPACTAgentResult {
  agentId: ManualPACTAgentId;
  title: string;
  summary: string;
  recommendations: string[];
  createdAt: number;
}

const day = 24 * 60 * 60_000;
const dateKey = (value = Date.now()) => new Date(value).toISOString().slice(0, 10);

function projectManagerResult(workspaceId: string, language: "cs" | "en"): ManualPACTAgentResult {
  const snapshot = readSnapshot();
  const entities = snapshot.entities.filter((entity) => entity.workspaceId === workspaceId);
  const projects = entities.filter((entity) => entity.type === "project" && entity.status === "active");
  const tasks = entities.filter((entity) => entity.type === "task" && entity.status === "open");
  const today = dateKey();
  const projectStats = projects.map((project) => {
    const relatedIds = new Set(snapshot.relations.filter((relation) =>
      relation.workspaceId === workspaceId &&
      relation.targetEntityId === project.id &&
      relation.relationType === "belongs_to_project"
    ).map((relation) => relation.sourceEntityId));
    const projectTasks = tasks.filter((task) =>
      relatedIds.has(task.id) || task.properties.projectId === project.id
    );
    const overdue = projectTasks.filter((task) =>
      [task.properties.when, task.properties.deadline].some((value) => typeof value === "string" && value < today)
    ).length;
    return { project, open: projectTasks.length, overdue };
  }).sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.project.title.localeCompare(b.project.title));

  const atRisk = projectStats.filter((item) => item.overdue > 0);
  const withoutNextAction = projectStats.filter((item) => item.open === 0);
  const busiest = projectStats.find((item) => item.open > 0);
  const recommendations = language === "cs"
    ? [
        atRisk[0] ? `Nejdřív projděte projekt „${atRisk[0].project.title}“: má ${atRisk[0].overdue} úkolů po termínu.` : "Žádný aktivní projekt nyní nemá úkol po termínu.",
        withoutNextAction[0] ? `Doplňte další konkrétní krok do projektu „${withoutNextAction[0].project.title}“.` : projectStats.length ? "Všechny aktivní projekty mají alespoň jeden otevřený krok." : "Nejdřív vytvořte nebo aktivujte projekt, který má AIfréd sledovat.",
        busiest ? `Ověřte rozsah projektu „${busiest.project.title}“ (${busiest.open} otevřených úkolů).` : "Není evidován žádný otevřený projektový úkol.",
      ]
    : [
        atRisk[0] ? `Review “${atRisk[0].project.title}” first: it has ${atRisk[0].overdue} overdue tasks.` : "No active project currently has an overdue task.",
        withoutNextAction[0] ? `Add one concrete next action to “${withoutNextAction[0].project.title}”.` : projectStats.length ? "Every active project has at least one open next action." : "Create or activate a project for AIfréd to monitor first.",
        busiest ? `Check the scope of “${busiest.project.title}” (${busiest.open} open tasks).` : "There are no open project tasks.",
      ];
  return {
    agentId: "project-manager",
    title: language === "cs" ? "Kontrola portfolia projektů" : "Project portfolio review",
    summary: language === "cs"
      ? `${projects.length} aktivních projektů · ${tasks.length} otevřených úkolů · ${atRisk.length} rizikových projektů`
      : `${projects.length} active projects · ${tasks.length} open tasks · ${atRisk.length} at-risk projects`,
    recommendations,
    createdAt: Date.now(),
  };
}

function meetingPrepResult(workspaceId: string, language: "cs" | "en"): ManualPACTAgentResult {
  const now = Date.now();
  const agent = getPACTAgent("meeting-prep");
  if (!agent) throw new Error("Meeting Prep agent is unavailable");
  const resolved = resolvePACTContext({ agent, workspaceId, includeSensitive: false });
  const events = listCalendarEvents(workspaceId, now, now + 7 * day)
    .filter((event) => event.status !== "cancelled" && event.busy)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const next = events[0];
  const openTasks = resolved.entities.filter((entity) => entity.type === "task" && entity.status === "open").length;
  const recommendations = language === "cs"
    ? next
      ? [
          `Před událostí „${next.title}“ si vyhraďte 10 minut na cíl a očekávaný výsledek.`,
          `Zkontrolujte související otevřené závazky; ve workspace je jich nyní ${openTasks}.`,
          "Po schůzce zachyťte rozhodnutí a další kroky jako návrhy, nikoli automatické změny.",
        ]
      : ["V příštích sedmi dnech není v připojeném kalendáři žádná blokující událost."]
    : next
      ? [
          `Reserve ten minutes before “${next.title}” to define the objective and desired outcome.`,
          `Review related commitments; this workspace currently has ${openTasks} open tasks.`,
          "Capture decisions and next actions as proposals after the meeting, not automatic changes.",
        ]
      : ["There is no blocking event in the connected calendar during the next seven days."];
  return {
    agentId: "meeting-prep",
    title: language === "cs" ? "Příprava na nejbližší schůzku" : "Next meeting preparation",
    summary: next
      ? `${new Date(next.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")} · ${next.title}`
      : language === "cs" ? "Kalendář nemá nadcházející blokující událost." : "The calendar has no upcoming blocking event.",
    recommendations,
    createdAt: now,
  };
}

export function runManualPACTAgent(agentId: ManualPACTAgentId, workspaceId: string, language: "cs" | "en") {
  const agent = getPACTAgent(agentId);
  if (!agent || !agent.triggerModes.includes("manual")) throw new Error("Agent cannot be run manually");
  const runId = beginPACTRun(agent.id, workspaceId, "manual", `agent:${agent.id};source:owner-ui`);
  try {
    const result = agentId === "project-manager"
      ? projectManagerResult(workspaceId, language)
      : meetingPrepResult(workspaceId, language);
    finishPACTRun(runId, "completed", `agent:${agent.id};recommendations:${result.recommendations.length};result:available-to-owner`);
    return result;
  } catch (error) {
    finishPACTRun(runId, "failed", `agent:${agent.id};error:${error instanceof Error ? error.name : "unknown"}`);
    throw error;
  }
}
