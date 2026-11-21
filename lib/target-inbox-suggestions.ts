/**
 * C-3b pure, DEFAULT-OFF suggestion primitives. No database, network or write side effects.
 *
 * IMPORTANT: inputs are NOT authorization. A future pinned actor-scoped reader must
 * supply only the actor's currently authorized PRIVATE Areas and OPEN projects.
 * The eventual Accept writer must revalidate ACL, every candidate revision,
 * the signed displayed action, personal When CAS and restore generation under
 * one SQLite transaction. Never use a suggestion as a write capability.
 */
export type InboxPrivateArea = {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
};
export type InboxPrivateOpenProject = {
  readonly id: string;
  readonly name: string;
  readonly areaId: string;
  readonly revision: number;
};
export type InboxSuggestionSnapshot = {
  readonly taskTitle: string;
  readonly currentAreaId: string;
  readonly currentProjectId: string | null;
  readonly privateAreas: readonly InboxPrivateArea[];
  readonly privateOpenProjects: readonly InboxPrivateOpenProject[];
};
export type InboxSuggestedChanges = {
  /** No implicit scheduling; "today" requires a separately witnessed IANA local date. */
  readonly whenOn: "unchanged";
  /** A target project implies its current private Area (never a shared Area). */
  readonly projectId: "unchanged" | string;
  readonly areaId: "unchanged" | string;
};
export type InboxSuggestion = {
  readonly source: "rule" | "ai";
  readonly changes: InboxSuggestedChanges;
  readonly why: string;
};
export type InboxAIChoice = {
  readonly action: "keep" | "area" | "project";
  readonly targetName: string | null;
  readonly reason: string;
};
export type InboxAIAllowedInput = {
  readonly taskTitle: string;
  readonly privateAreaNames: readonly string[];
  readonly privateOpenProjectNames: readonly string[];
};

const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const NAME = /^[\p{L}\p{M}\p{N}]+(?:\s+[\p{L}\p{M}\p{N}]+)*$/u;
const MAX_CANDIDATES = 128;
const MAX_TITLE_BYTES = 4096;
const MAX_NAME_BYTES = 512;

/** Stable, locale-independent NFC + Unicode default lowercase; diacritics remain distinct. */
export function foldInboxMatchText(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}
const validName = (name: unknown): name is string =>
  typeof name === "string" && name.trim() === name && name.length > 0 &&
  Buffer.byteLength(name,"utf8") <= MAX_NAME_BYTES &&
  NAME.test(foldInboxMatchText(name));
const validRevision = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function validInboxSuggestionSnapshot(input: unknown): input is InboxSuggestionSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const s = input as Partial<InboxSuggestionSnapshot>;
  if (typeof s.taskTitle !== "string" || !s.taskTitle.trim() ||
      Buffer.byteLength(s.taskTitle,"utf8") > MAX_TITLE_BYTES ||
      typeof s.currentAreaId !== "string" || !SAFE_ID.test(s.currentAreaId) ||
      (s.currentProjectId !== null &&
        (typeof s.currentProjectId !== "string" || !SAFE_ID.test(s.currentProjectId))) ||
      !Array.isArray(s.privateAreas) || !Array.isArray(s.privateOpenProjects) ||
      s.privateAreas.length > MAX_CANDIDATES ||
      s.privateOpenProjects.length > MAX_CANDIDATES) return false;
  const areas = s.privateAreas as InboxPrivateArea[];
  const projects = s.privateOpenProjects as InboxPrivateOpenProject[];
  const areaIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const a of areas) {
    if (!a || !SAFE_ID.test(a.id) || !validName(a.name) ||
        !validRevision(a.revision) || areaIds.has(a.id)) return false;
    areaIds.add(a.id);
  }
  for (const p of projects) {
    if (!p || !SAFE_ID.test(p.id) || !validName(p.name) ||
        !validRevision(p.revision) || !SAFE_ID.test(p.areaId) ||
        !areaIds.has(p.areaId) || projectIds.has(p.id)) return false;
    projectIds.add(p.id);
  }
  // A caller must have supplied the source private Area, even for a project task.
  return areaIds.has(s.currentAreaId);
}

const keep = (source: "rule" | "ai" = "rule"): InboxSuggestion => ({
  source, changes: {whenOn:"unchanged",projectId:"unchanged",areaId:"unchanged"},
  why: "Ponechat úkol v aktuálním umístění; nebyl nalezen jednoznačný bezpečný cíl.",
});
const words = (value: string): string[] =>
  foldInboxMatchText(value).match(WORD) ?? [];
function matchesPhrase(titleWords: readonly string[], name: string): boolean {
  const candidate = words(name);
  if (!candidate.length) return false;
  for (let i = 0; i + candidate.length <= titleWords.length; i++) {
    if (candidate.every((word,j) => word === titleWords[i+j])) return true;
  }
  return false;
}

/** Zero or more than one matching destination: never choose one silently. */
export function suggestInboxByRules(input: InboxSuggestionSnapshot): InboxSuggestion {
  if (!validInboxSuggestionSnapshot(input)) return keep();
  const titleWords = words(input.taskTitle);
  const targets: Array<{kind:"area"|"project";id:string;name:string;areaId:string}> = [
    ...input.privateAreas.filter(a => matchesPhrase(titleWords,a.name))
      .map(a => ({kind:"area" as const,id:a.id,name:a.name,areaId:a.id})),
    ...input.privateOpenProjects.filter(p => matchesPhrase(titleWords,p.name))
      .map(p => ({kind:"project" as const,id:p.id,name:p.name,areaId:p.areaId})),
  ];
  if (targets.length !== 1) return keep();
  const target = targets[0];
  if (target.kind === "area") {
    // Removing a task from a project is not implicit in this first rules slice.
    if (input.currentProjectId !== null || input.currentAreaId === target.id) return keep();
    return {source:"rule",changes:{whenOn:"unchanged",projectId:"unchanged",areaId:target.id},
      why:"Přesný název soukromé Oblasti v názvu úkolu: „" + target.name + "“."};
  }
  if (input.currentProjectId === target.id) return keep();
  return {source:"rule",
    changes:{whenOn:"unchanged",projectId:target.id,areaId:target.areaId},
    why:"Přesný název otevřeného soukromého projektu v názvu úkolu: „" + target.name + "“."};
}

/** Data minimization: this is the ONLY user-data shape permitted in an AI prompt. */
export function inboxAIAllowedInput(snapshot: InboxSuggestionSnapshot): InboxAIAllowedInput | null {
  if (!validInboxSuggestionSnapshot(snapshot)) return null;
  return {
    taskTitle:snapshot.taskTitle,
    privateAreaNames:snapshot.privateAreas.map(a=>a.name),
    privateOpenProjectNames:snapshot.privateOpenProjects.map(p=>p.name),
  };
}

/**
 * AI supplies NAMES only; client/provider text can never provide internal IDs.
 * Duplicate names, unknown targets and moves into an implicit shared Area fail
 * to the deterministic rules. A future writer must still reauthorize the IDs.
 */
export function resolveInboxAIChoice(
  snapshot: InboxSuggestionSnapshot, choice: InboxAIChoice | null,
): InboxSuggestion {
  const fallback = suggestInboxByRules(snapshot);
  if (!validInboxSuggestionSnapshot(snapshot) || !choice ||
      typeof choice !== "object" ||
      !["keep","area","project"].includes(choice.action) ||
      typeof choice.reason !== "string" ||
      choice.reason.length > 240 || /[\u0000-\u001f\u007f]/u.test(choice.reason)) return fallback;
  if (choice.action === "keep")
    return choice.targetName === null ? keep("ai") : fallback;
  if (typeof choice.targetName !== "string" || !choice.targetName) return fallback;
  const selected = choice.action === "area"
    ? snapshot.privateAreas.filter(a=>a.name===choice.targetName)
    : snapshot.privateOpenProjects.filter(p=>p.name===choice.targetName);
  if (selected.length !== 1) return fallback;
  if (choice.action === "area") {
    const a = selected[0] as InboxPrivateArea;
    if (snapshot.currentProjectId !== null || snapshot.currentAreaId === a.id) return fallback;
    return {source:"ai",changes:{whenOn:"unchanged",projectId:"unchanged",areaId:a.id},
      why:"AI navrhla existující soukromou Oblast „" + a.name + "“."};
  }
  const p = selected[0] as InboxPrivateOpenProject;
  if (snapshot.currentProjectId === p.id ||
      !snapshot.privateAreas.some(a=>a.id===p.areaId)) return fallback;
  return {source:"ai",changes:{whenOn:"unchanged",projectId:p.id,areaId:p.areaId},
    why:"AI navrhla existující otevřený soukromý projekt „" + p.name + "“."};
}
