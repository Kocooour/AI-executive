import { calendarAvailability } from "./calendar";
import { getNotificationPreferences } from "./notifications";
import { listPACTContext } from "./pact";
import { readSnapshot } from "./server-store";
import { clampTaskMinutes } from "./task-duration";

export interface TaskSuggestion {
  projectId: string;
  projectTitle: string;
  areaId: string;
  areaTitle: string;
  priority: "none" | "low" | "medium" | "high";
  estimatedMinutes: number;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledDate: string;
  scheduledOptions: Array<{ start: string; end: string; date: string }>;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  constraints: string[];
  newProjectSuggestion: {
    title: string;
    areaId: string;
    areaTitle: string;
    confidence: "medium" | "high";
    reason: string;
  } | null;
}

const normalize = (value: string) => value.toLocaleLowerCase("cs-CZ")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

const stopWords = new Set(["a", "an", "and", "at", "do", "for", "i", "in", "na", "o", "of", "pro", "s", "se", "the", "to", "u", "v", "ve", "z", "za"]);
const tokens = (value: string) => normalize(value).split(/\s+/).filter((token) => token.length > 1 && !stopWords.has(token));
const overlap = (left: string[], right: string[]) => left.reduce((score, token) => score + (right.includes(token) ? Math.max(1, token.length - 2) : 0), 0);

const projectIntentPatterns = [
  /\b(?:projekt\w*|rekonstruk\w*|stehov\w*|svatb\w*|dovolen\w*|kampan\w*|implement\w*|migra\w*|spust\w*|zavest\w*|vybud\w*|zorganiz\w*|naplan\w*)\b/,
  /\b(?:project\w*|renovat\w*|remodel\w*|relocat\w*|wedding\w*|campaign\w*|implement\w*|migrat\w*|launch\w*|rollout\w*|build\w*|organiz\w*|plan\w*)\b/,
];
const strongProjectIntent = /\b(?:projekt\w*|project\w*|rekonstruk\w*|renovat\w*|remodel\w*|stehov\w*|relocat\w*|svatb\w*|wedding\w*|dovolen\w*|kampan\w*|campaign\w*|implement\w*|migra\w*|spust\w*|launch\w*|rollout\w*|vybud\w*|build\w*)\b/;
const projectScopePatterns = [
  /\b(?:vcetne|rozpoc\w*|dodavatel\w*|harmonogram\w*|etap\w*|vice kroku|od .* do)\b/,
  /\b(?:including|budget\w*|vendor\w*|timeline\w*|milestone\w*|multiple steps|from .* to)\b/,
];

function proposedProjectTitle(input: string) {
  const cleaned = input.trim()
    .replace(/^(?:projekt|project)\s*[:\-]?\s*/i, "")
    .replace(/^(?:naplánovat|naplanovat|zorganizovat|spustit|zavést|zavest|vybudovat|plan|organize|launch|roll out|build)\s+(?:projekt\s+|project\s+)?/i, "")
    .replace(/\s+(?:včetně|vcetne|including)(?=\s|$).*$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  const title = cleaned || input.trim();
  const concise = title.length > 120 ? title.slice(0, 117).trimEnd() + "…" : title;
  return concise ? concise[0].toLocaleUpperCase("cs-CZ") + concise.slice(1) : concise;
}

export function inferNewProjectSuggestion(input: {
  title: string;
  existingProjectScore: number;
  areaId?: string;
  areaTitle?: string;
  language?: "cs" | "en";
}): TaskSuggestion["newProjectSuggestion"] {
  // A meaningful existing match wins. This prevents duplicate projects even when
  // the input itself contains project-like wording.
  if (input.existingProjectScore >= 4) return null;
  const text = normalize(input.title);
  const intentSignals = projectIntentPatterns.filter((pattern) => pattern.test(text)).length;
  const scopeSignals = projectScopePatterns.filter((pattern) => pattern.test(text)).length;
  if ((!strongProjectIntent.test(text) && !(intentSignals && scopeSignals)) || (tokens(input.title).length < 3 && !scopeSignals)) return null;
  const highConfidence = intentSignals + scopeSignals >= 2;
  const english = input.language === "en";
  return {
    title: proposedProjectTitle(input.title),
    areaId: input.areaId || "",
    areaTitle: input.areaTitle || "",
    confidence: highConfidence ? "high" : "medium",
    reason: english
      ? highConfidence
        ? "The request describes a multi-step outcome and no sufficiently relevant active project exists."
        : "The request looks broader than a single action and no sufficiently relevant active project exists."
      : highConfidence
        ? "Zadání popisuje vícekrokový výsledek a neexistuje dostatečně relevantní aktivní projekt."
        : "Zadání působí širší než jednotlivý úkol a neexistuje dostatečně relevantní aktivní projekt.",
  };
}

function relationTargets(snapshot: ReturnType<typeof readSnapshot>, sourceId: string, relationType: string, workspaceId: string) {
  return snapshot.relations.filter((relation) =>
    relation.workspaceId === workspaceId && relation.sourceEntityId === sourceId && relation.relationType === relationType
  ).map((relation) => relation.targetEntityId);
}

function inferredEntity(input: string, workspaceId: string, type: "project" | "area") {
  const snapshot = readSnapshot();
  const inputTokens = tokens(input);
  const candidates = snapshot.entities.filter((entity) =>
    entity.workspaceId === workspaceId && entity.type === type && entity.status === "active"
  );
  const tasks = snapshot.entities.filter((entity) =>
    entity.workspaceId === workspaceId && entity.type === "task"
  );
  const scored = candidates.map((candidate) => {
    let score = overlap(inputTokens, tokens(candidate.title)) * 5;
    const relatedProjectIds = type === "project"
      ? [candidate.id]
      : snapshot.relations.filter((relation) =>
          relation.workspaceId === workspaceId && relation.targetEntityId === candidate.id && relation.relationType === "belongs_to_area"
        ).map((relation) => relation.sourceEntityId);
    for (const task of tasks) {
      const projectIds = relationTargets(snapshot, task.id, "belongs_to_project", workspaceId);
      const areaIds = relationTargets(snapshot, task.id, "belongs_to_area", workspaceId);
      const related = type === "project"
        ? projectIds.includes(candidate.id) || task.properties.projectId === candidate.id
        : areaIds.includes(candidate.id) || task.properties.areaId === candidate.id || projectIds.some((id) => relatedProjectIds.includes(id));
      if (related) score += overlap(inputTokens, tokens(`${task.title} ${task.content || ""}`));
    }
    return { entity: candidate, score };
  }).sort((a, b) => b.score - a.score || a.entity.title.localeCompare(b.entity.title));
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

function estimateMinutes(input: string) {
  const text = normalize(input);
  const explicit = text.match(/\b(\d{1,3})\s*(min|minut|minutes?)\b/) || text.match(/\b(\d{1,2})\s*(h|hod|hodin|hours?)\b/);
  if (explicit) {
    const value = Number(explicit[1]);
    return clampTaskMinutes(/\b(h|hod|hodin|hours?)\b/.test(explicit[0]) ? value * 60 : value) ?? 30;
  }
  if (/\b(zavolat|volat|call|email|mail|odpovedet|reply)\b/.test(text)) return 15;
  if (/\b(objednat|rezervovat|koupit|book|buy|order)\b/.test(text)) return 20;
  if (/\b(projit|zkontrolovat|precist|review|check|read)\b/.test(text)) return 45;
  if (/\b(napsat|pripravit|prezentace|write|prepare|presentation|workout|cviceni)\b/.test(text)) return 60;
  if (/\b(analyz|vyzkum|navrhnout|research|design|strategie|strategy)\b/.test(text)) return 90;
  if (/\b(opravit|servis|implementovat|migrace|repair|service|implement|migration)\b/.test(text)) return 120;
  return tokens(input).length >= 9 ? 60 : 30;
}

function inferredPriority(input: string): TaskSuggestion["priority"] {
  const text = normalize(input);
  if (/\b(urgent|urgentni|ihned|kritick|asap|dnes|today)\b/.test(text)) return "high";
  if (/\b(dulezit|important|deadline|termin|this week|tento tyden)\b/.test(text)) return "medium";
  if (/\b(az bude cas|nekdy|someday|maybe)\b/.test(text)) return "low";
  return "none";
}

function localDateParts(now: number, timezone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, weekday: String(values.weekday) };
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekday(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function suggestedWindows(workspaceId: string, estimatedMinutes: number, requestedDate?: string) {
  const preferences = getNotificationPreferences();
  const today = localDateParts(Date.now(), preferences.timezone).date;
  const dates = requestedDate
    ? [requestedDate]
    : Array.from({ length: 14 }, (_, index) => addDays(today, index));
  const options: Array<{ start: string; end: string; date: string }> = [];
  let configured = false;
  let fresh = false;
  for (const date of dates) {
    if (!preferences.workdays.includes(weekday(date))) continue;
    const availability = calendarAvailability(workspaceId, date, preferences.timezone, preferences.workdayStart, preferences.workdayEnd);
    configured ||= availability.configured;
    fresh ||= availability.fresh;
    if (!availability.configured || !availability.fresh) continue;
    for (const candidate of availability.windows) {
      const start = Math.max(Date.parse(candidate.start), Date.now() + 15 * 60_000);
      const roundedStart = Math.ceil(start / (15 * 60_000)) * 15 * 60_000;
      if (Date.parse(candidate.end) - roundedStart >= estimatedMinutes * 60_000) {
        options.push({
          start: new Date(roundedStart).toISOString(),
          end: new Date(roundedStart + estimatedMinutes * 60_000).toISOString(),
          date,
        });
        if (options.length >= 3) return { options, configured, fresh };
      }
    }
  }
  return { options, configured, fresh };
}

export function suggestTask(input: { title: string; workspaceId: string; requestedDate?: string; explicitPriority?: string; language?: "cs" | "en" }) {
  const snapshot = readSnapshot();
  const workspace = snapshot.entities.find((entity) => entity.type === "workspace" && entity.workspaceId === input.workspaceId);
  if (input.workspaceId === "all") throw new Error("A concrete workspace is required");
  const projectMatch = inferredEntity(input.title, input.workspaceId, "project");
  let areaMatch = inferredEntity(input.title, input.workspaceId, "area");
  if (projectMatch) {
    const areaId = relationTargets(snapshot, projectMatch.entity.id, "belongs_to_area", input.workspaceId)[0] || String(projectMatch.entity.properties.areaId || "");
    const projectArea = snapshot.entities.find((entity) => entity.id === areaId && entity.type === "area" && entity.workspaceId === input.workspaceId);
    if (projectArea) areaMatch = { entity: projectArea, score: Math.max(1, projectMatch.score) };
  }
  const estimatedMinutes = estimateMinutes(input.title);
  const windows = suggestedWindows(input.workspaceId, estimatedMinutes, input.requestedDate);
  const window = windows.options[0];
  const priority = (["none", "low", "medium", "high"].includes(input.explicitPriority || "")
    ? input.explicitPriority
    : inferredPriority(input.title)) as TaskSuggestion["priority"];
  const bestScore = Math.max(projectMatch?.score || 0, areaMatch?.score || 0);
  const english = input.language === "en";
  const newProjectSuggestion = inferNewProjectSuggestion({
    title: input.title,
    existingProjectScore: projectMatch?.score || 0,
    areaId: areaMatch?.entity.id,
    areaTitle: areaMatch?.entity.title,
    language: input.language,
  });
  const reasons: string[] = [];
  if (projectMatch) reasons.push(english
    ? `Similarity to earlier tasks and the “${projectMatch.entity.title}” project`
    : `Podobnost s dřívějšími úkoly a projektem „${projectMatch.entity.title}“`);
  if (areaMatch) reasons.push(english
    ? `The most likely area is “${areaMatch.entity.title}”`
    : `Nejpravděpodobnější oblast je „${areaMatch.entity.title}“`);
  reasons.push(english
    ? `Estimate based on the task type and scope: ${estimatedMinutes} min`
    : `Odhad podle typu a rozsahu zadání: ${estimatedMinutes} min`);
  if (window?.start) reasons.push(english
    ? "First sufficiently long free block in the work calendar"
    : "První dostatečně dlouhý volný blok v pracovním kalendáři");
  const constraints = [
    `${english ? "Working days" : "Pracovní dny"}: ${getNotificationPreferences().workdays.join(", ")}`,
    `${english ? "Working hours" : "Pracovní doba"}: ${getNotificationPreferences().workdayStart}–${getNotificationPreferences().workdayEnd}`,
  ];
  const rules = workspace
    ? listPACTContext(input.workspaceId, ["rules", "workspace"])
      .filter((item) => item.sensitivity !== "sensitive")
      .slice(0, 3)
    : [];
  if (rules.length) constraints.push(english
    ? `${rules.length} workspace rules were included as context; only structured working hours were applied automatically.`
    : `${rules.length} pravidla workspace byla zahrnuta do kontextu; automaticky se použila pouze strukturovaná pracovní doba.`);
  if (!windows.configured) constraints.push(english
    ? "The calendar is not connected; no exact time was suggested."
    : "Kalendář není připojený; přesný čas nebyl navržen.");
  else if (!windows.fresh) constraints.push(english
    ? "The calendar is stale; no exact time was suggested."
    : "Kalendář není aktuální; přesný čas nebyl navržen.");
  else if (!window?.start) constraints.push(english
    ? "No sufficiently long free block was found in the checked period."
    : "V kontrolovaném období není dostatečně dlouhý volný blok.");
  return {
    projectId: projectMatch?.entity.id || "",
    projectTitle: projectMatch?.entity.title || "",
    areaId: areaMatch?.entity.id || "",
    areaTitle: areaMatch?.entity.title || "",
    priority,
    estimatedMinutes,
    scheduledStart: window?.start || "",
    scheduledEnd: window?.end || "",
    scheduledDate: window?.date || input.requestedDate || "",
    scheduledOptions: windows.options,
    confidence: bestScore >= 12 ? "high" : bestScore >= 4 ? "medium" : "low",
    reasons,
    constraints,
    newProjectSuggestion,
  } satisfies TaskSuggestion;
}
