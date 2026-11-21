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
  readonly projectId: "unchanged" | string;
  /**
   * PHYSICAL tasks.area_id value, not the inherited/effective Area.
   * Project assignments MUST write SQL NULL to tasks.area_id.
   */
  readonly taskAreaId: "unchanged" | string | null;
  /** Derived ACL/CAS witness; never directly persisted to tasks.area_id. */
  readonly effectiveAreaId: "unchanged" | string;
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

/**
 * Unicode 15.1.0 full default casefold exceptions to Unicode lowercase.
 * Source: UCD CaseFolding.txt, statuses C/F. JS lacks a native casefold API.
 * Applied after locale-independent lowercasing; do not strip diacritics.
 * Entries cover multi-codepoint expansions, final sigma, Cherokee and
 * compatibility folds that lowercasing alone misses.
 */
const FULL_FOLD_AFTER_LOWER: Readonly<Record<string,string>> = {"µ":"μ","ß":"ss","ŉ":"ʼn","ſ":"s","ǰ":"ǰ","ͅ":"ι","ΐ":"ΐ","ΰ":"ΰ","ς":"σ","ϐ":"β","ϑ":"θ","ϕ":"φ","ϖ":"π","ϰ":"κ","ϱ":"ρ","ϵ":"ε","և":"եւ","ꭰ":"Ꭰ","ꭱ":"Ꭱ","ꭲ":"Ꭲ","ꭳ":"Ꭳ","ꭴ":"Ꭴ","ꭵ":"Ꭵ","ꭶ":"Ꭶ","ꭷ":"Ꭷ","ꭸ":"Ꭸ","ꭹ":"Ꭹ","ꭺ":"Ꭺ","ꭻ":"Ꭻ","ꭼ":"Ꭼ","ꭽ":"Ꭽ","ꭾ":"Ꭾ","ꭿ":"Ꭿ","ꮀ":"Ꮀ","ꮁ":"Ꮁ","ꮂ":"Ꮂ","ꮃ":"Ꮃ","ꮄ":"Ꮄ","ꮅ":"Ꮅ","ꮆ":"Ꮆ","ꮇ":"Ꮇ","ꮈ":"Ꮈ","ꮉ":"Ꮉ","ꮊ":"Ꮊ","ꮋ":"Ꮋ","ꮌ":"Ꮌ","ꮍ":"Ꮍ","ꮎ":"Ꮎ","ꮏ":"Ꮏ","ꮐ":"Ꮐ","ꮑ":"Ꮑ","ꮒ":"Ꮒ","ꮓ":"Ꮓ","ꮔ":"Ꮔ","ꮕ":"Ꮕ","ꮖ":"Ꮖ","ꮗ":"Ꮗ","ꮘ":"Ꮘ","ꮙ":"Ꮙ","ꮚ":"Ꮚ","ꮛ":"Ꮛ","ꮜ":"Ꮜ","ꮝ":"Ꮝ","ꮞ":"Ꮞ","ꮟ":"Ꮟ","ꮠ":"Ꮠ","ꮡ":"Ꮡ","ꮢ":"Ꮢ","ꮣ":"Ꮣ","ꮤ":"Ꮤ","ꮥ":"Ꮥ","ꮦ":"Ꮦ","ꮧ":"Ꮧ","ꮨ":"Ꮨ","ꮩ":"Ꮩ","ꮪ":"Ꮪ","ꮫ":"Ꮫ","ꮬ":"Ꮬ","ꮭ":"Ꮭ","ꮮ":"Ꮮ","ꮯ":"Ꮯ","ꮰ":"Ꮰ","ꮱ":"Ꮱ","ꮲ":"Ꮲ","ꮳ":"Ꮳ","ꮴ":"Ꮴ","ꮵ":"Ꮵ","ꮶ":"Ꮶ","ꮷ":"Ꮷ","ꮸ":"Ꮸ","ꮹ":"Ꮹ","ꮺ":"Ꮺ","ꮻ":"Ꮻ","ꮼ":"Ꮼ","ꮽ":"Ꮽ","ꮾ":"Ꮾ","ꮿ":"Ꮿ","ᏸ":"Ᏸ","ᏹ":"Ᏹ","ᏺ":"Ᏺ","ᏻ":"Ᏻ","ᏼ":"Ᏼ","ᏽ":"Ᏽ","ᲀ":"в","ᲁ":"д","ᲂ":"о","ᲃ":"с","ᲄ":"т","ᲅ":"т","ᲆ":"ъ","ᲇ":"ѣ","ᲈ":"ꙋ","ẖ":"ẖ","ẗ":"ẗ","ẘ":"ẘ","ẙ":"ẙ","ẚ":"aʾ","ẛ":"ṡ","ὐ":"ὐ","ὒ":"ὒ","ὔ":"ὔ","ὖ":"ὖ","ᾀ":"ἀι","ᾁ":"ἁι","ᾂ":"ἂι","ᾃ":"ἃι","ᾄ":"ἄι","ᾅ":"ἅι","ᾆ":"ἆι","ᾇ":"ἇι","ᾐ":"ἠι","ᾑ":"ἡι","ᾒ":"ἢι","ᾓ":"ἣι","ᾔ":"ἤι","ᾕ":"ἥι","ᾖ":"ἦι","ᾗ":"ἧι","ᾠ":"ὠι","ᾡ":"ὡι","ᾢ":"ὢι","ᾣ":"ὣι","ᾤ":"ὤι","ᾥ":"ὥι","ᾦ":"ὦι","ᾧ":"ὧι","ᾲ":"ὰι","ᾳ":"αι","ᾴ":"άι","ᾶ":"ᾶ","ᾷ":"ᾶι","ι":"ι","ῂ":"ὴι","ῃ":"ηι","ῄ":"ήι","ῆ":"ῆ","ῇ":"ῆι","ῒ":"ῒ","ΐ":"ΐ","ῖ":"ῖ","ῗ":"ῗ","ῢ":"ῢ","ΰ":"ΰ","ῤ":"ῤ","ῦ":"ῦ","ῧ":"ῧ","ῲ":"ὼι","ῳ":"ωι","ῴ":"ώι","ῶ":"ῶ","ῷ":"ῶι","ﬀ":"ff","ﬁ":"fi","ﬂ":"fl","ﬃ":"ffi","ﬄ":"ffl","ﬅ":"st","ﬆ":"st","ﬓ":"մն","ﬔ":"մե","ﬕ":"մի","ﬖ":"վն","ﬗ":"մխ"};
export function foldInboxMatchText(value: string): string {
  const lower = value.normalize("NFC").toLowerCase();
  return Array.from(lower, c => FULL_FOLD_AFTER_LOWER[c] ?? c).join("").normalize("NFC");
}
const validName = (name: unknown): name is string =>
  typeof name === "string" && name.trim() === name && name.length > 0 &&
  Buffer.byteLength(name,"utf8") <= MAX_NAME_BYTES &&
  !/[\u0000-\u001f\u007f]/u.test(name);
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
  source, changes: {whenOn:"unchanged",projectId:"unchanged",
    taskAreaId:"unchanged",effectiveAreaId:"unchanged"},
  why: source === "ai"
    ? "AI doporučila ponechat úkol v aktuálním umístění."
    : "Ponechat úkol v aktuálním umístění; nebyl nalezen jednoznačný bezpečný cíl.",
});
const words = (value: string): string[] =>
  foldInboxMatchText(value).match(WORD) ?? [];
function matchesPhrase(titleWords: readonly string[], name: string): boolean {
  // Punctuated or emoji-bearing names are allowed AI candidates, but rule
  // matching abstains unless the complete name is an unambiguous word phrase.
  if (!NAME.test(foldInboxMatchText(name))) return false;
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
    return {source:"rule",changes:{whenOn:"unchanged",projectId:"unchanged",
      taskAreaId:target.id,effectiveAreaId:target.id},
      why:"Přesný název soukromé Oblasti v názvu úkolu: „" + target.name + "“."};
  }
  if (input.currentProjectId === target.id) return keep();
  return {source:"rule",
    changes:{whenOn:"unchanged",projectId:target.id,
      taskAreaId:null,effectiveAreaId:target.areaId},
    why:"Přesný název otevřeného soukromého projektu v názvu úkolu: „" + target.name + "“."};
}

/**
 * The only AI user-data payload and one shared validator for both provider and
 * resolver. No IDs/ACL/metadata/notes/emails are included in the remote prompt.
 */
export function validInboxAIAllowedInput(value: unknown): value is InboxAIAllowedInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string,unknown>;
  if (Object.keys(o).sort().join(",") !==
      "privateAreaNames,privateOpenProjectNames,taskTitle") return false;
  if (typeof o.taskTitle !== "string" || !o.taskTitle.trim() ||
      Buffer.byteLength(o.taskTitle,"utf8") > MAX_TITLE_BYTES ||
      !Array.isArray(o.privateAreaNames) || !Array.isArray(o.privateOpenProjectNames) ||
      o.privateAreaNames.length > MAX_CANDIDATES ||
      o.privateOpenProjectNames.length > MAX_CANDIDATES) return false;
  return [...o.privateAreaNames,...o.privateOpenProjectNames].every(validName);
}

export function validInboxAIChoice(input: InboxAIAllowedInput, value: unknown): value is InboxAIChoice {
  if (!validInboxAIAllowedInput(input) || !value ||
      typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string,unknown>;
  if (Object.keys(o).sort().join(",") !== "action,reason,targetName" ||
      (o.action !== "keep" && o.action !== "area" && o.action !== "project") ||
      typeof o.reason !== "string" || o.reason.length > 240 ||
      /[\u0000-\u001f\u007f]/u.test(o.reason)) return false;
  if (o.action === "keep") return o.targetName === null;
  if (typeof o.targetName !== "string") return false;
  const allowed = o.action === "area" ? input.privateAreaNames
    : input.privateOpenProjectNames;
  if (!allowed.includes(o.targetName)) return false;
  // Compare every label, including across Area/project kinds. Unicode NFC and
  // full casefold collisions are intentionally ambiguous even if IDs differ.
  const targetFold = foldInboxMatchText(o.targetName);
  return [...input.privateAreaNames,...input.privateOpenProjectNames]
    .filter(name => foldInboxMatchText(name) === targetFold).length === 1;
}

export function parseInboxAIChoice(
  text: string, input: InboxAIAllowedInput,
): InboxAIChoice | null {
  if (typeof text !== "string" || !text ||
      Buffer.byteLength(text,"utf8") > 8192) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return validInboxAIChoice(input,value) ? value : null;
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
  if (!validInboxSuggestionSnapshot(snapshot) ||
      !validInboxAIChoice(inboxAIAllowedInput(snapshot)!,choice)) return fallback;
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
    return {source:"ai",changes:{whenOn:"unchanged",projectId:"unchanged",
      taskAreaId:a.id,effectiveAreaId:a.id},
      why:"AI navrhla existující soukromou Oblast „" + a.name + "“."};
  }
  const p = selected[0] as InboxPrivateOpenProject;
  if (snapshot.currentProjectId === p.id ||
      !snapshot.privateAreas.some(a=>a.id===p.areaId)) return fallback;
  return {source:"ai",changes:{whenOn:"unchanged",projectId:p.id,
      taskAreaId:null,effectiveAreaId:p.areaId},
    why:"AI navrhla existující otevřený soukromý projekt „" + p.name + "“."};
}
