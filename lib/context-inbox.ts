import { randomUUID } from "node:crypto";
import { createOwnerClaim, type ClaimFreshness, type ClaimLiteralType, type ClaimSensitivity } from "./context-claims";
import { readSnapshot } from "./server-store";
import { matchingStandaloneSubjects } from "./context-subjects";

export interface ContextInboxProposal {
  id: string;
  kind: "claim";
  subject: { entityId: string; type: string; title: string };
  predicate: string;
  literal: { type: ClaimLiteralType; value: string | number | boolean };
  freshness: ClaimFreshness;
  sensitivity: ClaimSensitivity;
  validFrom: string | null;
  validTo: string | null;
  evidenceExcerpt: string;
  reason: "waiting" | "importance" | "deadline" | "preference";
  suggestedTarget?: { type: "person" | "organization"; title: string; matches: Array<{ id: string; title: string }> };
}

export interface ContextInboxTaskDraft {
  id: string;
  title: string;
  subject: { entityId: string; type: string; title: string };
  suggestedDate: string | null;
  suggestedPriority: "none" | "low" | "medium" | "high";
  reason: "action_item";
}

const normalize = (value: string) => value.toLocaleLowerCase("cs-CZ").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

function semanticDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function matchedEntity(workspaceId: string, line: string) {
  const normalized = normalize(line);
  return readSnapshot().entities
    .filter((entity) => entity.workspaceId === workspaceId && ["workspace", "area", "project", "task", "note"].includes(entity.type))
    .filter((entity) => normalize(entity.title).length >= 2 && normalized.includes(normalize(entity.title)))
    .sort((a, b) => normalize(b.title).length - normalize(a.title).length || a.id.localeCompare(b.id))[0];
}

function valueAfterLabel(line: string) {
  return line.replace(/^\s*[-*•]?\s*[^:–—-]{1,40}\s*[:–—-]\s*/u, "").trim();
}

function actionTitle(line: string) {
  return line.replace(/^\s*[-*•]\s+/, "")
    .replace(/\b(?:term[ií]n|deadline|due)\s*:?\s*20\d{2}-\d{2}-\d{2}\b/giu, "")
    .replace(/\b(?:priorita|priority)\s*:?\s*(?:kritick[aá]|critical|vysok[aá]|high|st[rř]edn[ií]|medium|n[ií]zk[aá]|low)(?=\s|[,;]|$)/giu, "")
    .replace(/[\s,;–—-]+$/u, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function waitingPerson(line: string) {
  const czech = /(?:^|[–—;:]\s*|\s)na\s+(?:v[ýy]sledek|odpov[ěe][ďd]|rozhodnut[íi]|potvrzen[íi])\s+[čc]ek[áa]\s+([\p{L}'-]{2,60}(?:\s+[\p{L}'-]{2,60})?)(?=\s*[,.;]|\s*$)/iu.exec(line);
  const english = /^\s*([\p{L}'-]{2,60}(?:\s+[\p{L}'-]{2,60})?)\s+is\s+waiting\s+for\s+.+(?:result|reply|decision|confirmation)(?:\s*[,.])?\s*$/iu.exec(line);
  const name = czech?.[1] || english?.[1] || "";
  return /^\p{Lu}/u.test(name) && !/\s(?:a|and)\s/i.test(name) && !/,\s*\p{Lu}/u.test(line) ? name : null;
}

export function previewContextInbox(workspaceId: string, text: string) {
  const snapshot = readSnapshot();
  const workspace = snapshot.entities.find((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  if (!workspace || workspaceId === "all") throw new Error("Workspace not found");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 80);
  const proposals: ContextInboxProposal[] = [];
  const taskDrafts: ContextInboxTaskDraft[] = [];
  const seen = new Set<string>();
  let activeSubject = workspace;
  const add = (line: string, predicate: string, literal: ContextInboxProposal["literal"], reason: ContextInboxProposal["reason"], validTo: string | null = null) => {
    const explicit = matchedEntity(workspaceId, line);
    if (explicit) activeSubject = explicit;
    else if (/\b(project|projekt|area|oblast|task|ukol)\b/.test(normalize(line))) activeSubject = workspace;
    const subject = explicit || activeSubject;
    if (!subject) return;
    const key = `${subject.id}:${predicate}:${JSON.stringify(literal)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const person = reason === "waiting" ? waitingPerson(line) : null;
    proposals.push({ id: randomUUID(), kind: "claim", subject: { entityId: subject.id, type: subject.type, title: subject.title },
      predicate, literal, freshness: "needs_review", sensitivity: "confidential", validFrom: null, validTo,
      evidenceExcerpt: line.slice(0, 500), reason,
      ...(person ? { suggestedTarget: { type: "person" as const, title: person,
        matches: matchingStandaloneSubjects(workspaceId, "person", person).map((match) => ({ id: match.id, title: match.title })) } } : {}) });
  };
  for (const line of lines) {
    const plain = normalize(line);
    const explicitSubject = matchedEntity(workspaceId, line);
    if (explicitSubject) activeSubject = explicitSubject;
    else if (/\b(project|projekt|area|oblast|task|ukol)\b/.test(plain)) activeSubject = workspace;
    const date = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
    const actionItem = /^\s*[-*•]\s+/.test(line) && /\b(zavolat|napsat|poslat|pripravit|zkontrolovat|objednat|call|write|send|prepare|review|check|book)\b/.test(plain);
    if (actionItem) {
      const subject = explicitSubject || activeSubject || workspace;
      const priority = plain.match(/\b(kriticka|critical|vysoka|high)\b/) ? "high"
        : plain.match(/\b(stredni|medium)\b/) ? "medium" : plain.match(/\b(nizka|low)\b/) ? "low" : "none";
      taskDrafts.push({ id: randomUUID(), title: actionTitle(line),
        subject: { entityId: subject.id, type: subject.type, title: subject.title },
        suggestedDate: date && semanticDate(date) ? date : null, suggestedPriority: priority, reason: "action_item" });
    }
    if (/\b(ceka|cekaji|waiting|waits|stakeholder|ocekava|expects)\b/.test(plain)) {
      const value = valueAfterLabel(line);
      add(line, "waiting_for", { type: "string", value: value || line }, "waiting", date ? semanticDate(date) : null);
      continue;
    }
    if (/\b(priorita|priority|dulezitost|importance)\b/.test(plain)) {
      const match = plain.match(/\b(kriticka|critical|vysoka|high|stredni|medium|nizka|low)\b/);
      add(line, "importance", { type: "string", value: match?.[1] || valueAfterLabel(line) }, "importance");
      continue;
    }
    if (/\b(termin|deadline|due|do kdy)\b/.test(plain) && date && semanticDate(date)) {
      add(line, "target_date", { type: "date", value: date }, "deadline");
      continue;
    }
    if (/\b(preference|preferuji|preferuje|uprednostnuji|uprednostnuje|pravidlo|rule|omezeni|constraint)\b/.test(plain)) {
      add(line, "preference", { type: "string", value: valueAfterLabel(line) || line }, "preference");
      continue;
    }
  }
  return { proposals: proposals.slice(0, 40), taskDrafts: taskDrafts.slice(0, 20), truncated: lines.length >= 80 };
}

export function approveContextInboxClaim(input: {
  commandId: string; workspaceId: string; id: string; subjectId: string; predicate: string;
  literal?: { type: ClaimLiteralType; value: string | number | boolean }; targetSubjectId?: string; freshness: ClaimFreshness;
  validFrom?: string | null; validTo?: string | null; evidenceExcerpt?: string;
}) {
  // The retry fingerprint is what the client sent. The ingestion time is made here and must not
  // change it, or a retry after a lost response would be refused as a different command.
  const clientRequest = { commandId: input.commandId, workspaceId: input.workspaceId, id: input.id, subjectId: input.subjectId,
    predicate: input.predicate, literal: input.literal, targetSubjectId: input.targetSubjectId, freshness: input.freshness,
    validFrom: input.validFrom, validTo: input.validTo, evidenceExcerpt: input.evidenceExcerpt, origin: "context-inbox" };
  return createOwnerClaim({ commandId: input.commandId, workspaceId: input.workspaceId, id: input.id, expectedRevision: 0,
    subject: { entityId: input.subjectId }, predicate: input.predicate, literal: input.literal,
    target: input.targetSubjectId ? { subjectId: input.targetSubjectId } : undefined,
    freshness: input.freshness, sensitivity: "confidential", validFrom: input.validFrom, validTo: input.validTo,
    source: { provider: "manual-context-inbox", ingestedAt: new Date().toISOString(), coverage: "excerpt" },
    evidence: input.evidenceExcerpt ? { excerpt: input.evidenceExcerpt.slice(0, 500), stance: "supports" } : null },
    undefined, { clientRequest });
}
