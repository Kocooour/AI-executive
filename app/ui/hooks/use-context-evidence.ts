"use client";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { ContextClaimItem, ContextEvidenceItem, ContextSourceItem } from "../types";
import { localizeServerError } from "../../../lib/server-errors";

// Sources and the evidence of a claim in the Context view: the list of sources, the "add evidence" form (an
// existing source or a new one), archiving evidence, and editing or archiving a source. Every write is a context
// command with an idempotency key kept by the same intent helpers as claims and people; the values it needs from
// the rest of the app are passed in.

export type SourceCoverageChoice = "" | "metadata" | "excerpt" | "body";
export interface SourceFields {
  provider: string; account: string; externalId: string; locator: string; author: string; authorRole: string; sourceAt: string;
  ingestedAt: string; coverage: SourceCoverageChoice; sensitivity: "normal" | "confidential" | "restricted";
}
export const emptySourceFields: SourceFields = { provider: "", account: "", externalId: "", locator: "", author: "", authorRole: "",
  sourceAt: "", ingestedAt: "", coverage: "", sensitivity: "normal" };
export interface EvidenceDraft {
  claimId: string; mode: "existing" | "new"; sourceId: string; locator: string; excerpt: string; stance: "supports" | "contradicts"; source: SourceFields;
}
export interface SourceEdit { id: string; revision: number; fields: SourceFields; /** The sensitivity the source has now; lowering it asks for a reason. */ original: SourceFields["sensitivity"]; reason: string }

const content = (coverage: string | null | undefined) => coverage === "excerpt" || coverage === "body";
const sourceFieldsOf = (source: ContextSourceItem): SourceFields => ({ provider: source.provider ?? "", account: source.account ?? "", externalId: source.externalId ?? "",
  locator: source.locator ?? "", author: source.author ?? "", authorRole: source.authorRole ?? "", sourceAt: source.sourceAt ?? "", ingestedAt: source.ingestedAt ?? "",
  coverage: source.coverage ?? "", sensitivity: source.sensitivity });
/** What the server gets: trimmed text, nothing for what was left empty (the server never fills anything in). */
const sourceBody = (fields: SourceFields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? value.trim() || null : value]));

export function useContextEvidence({ authState, activeWorkspaceId, writeWorkspaceId, tr, calendarWorkspaceSelection, contextIntent, finishContextIntent,
  contextInFlight, commandFailureMessage, refreshAfterCommand, offerContextUndo, loadContextClaims, syncEditedClaim }: {
  authState: string;
  activeWorkspaceId: string;
  writeWorkspaceId: string;
  tr: (key: string) => string;
  calendarWorkspaceSelection: MutableRefObject<string>;
  contextIntent: (scope: string, signature: string) => { commandKey: string; objectId: string };
  finishContextIntent: (scope: string) => void;
  contextInFlight: MutableRefObject<Set<string>>;
  commandFailureMessage: (error: unknown, fallback: string) => string;
  refreshAfterCommand: (...loads: Array<() => Promise<void>>) => Promise<boolean>;
  offerContextUndo: (area: "evidence" | "source", workspaceId: string, historyEventId: unknown) => void;
  loadContextClaims: (workspaceId?: string) => Promise<void>;
  /** The claim editor follows a claim whose revision moved because its evidence changed. */
  syncEditedClaim: (claim: ContextClaimItem) => void;
}) {
  const [contextSources, setContextSources] = useState<ContextSourceItem[]>([]),
    [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft | null>(null),
    [evidenceStatus, setEvidenceStatus] = useState(""),
    [evidenceBusy, setEvidenceBusy] = useState(false),
    [sourceEdit, setSourceEdit] = useState<SourceEdit | null>(null),
    [sourceStatus, setSourceStatus] = useState(""),
    [sourceBusy, setSourceBusy] = useState(false);
  const sourceLoadVersion = useRef(0);

  async function loadContextSources(workspaceId = calendarWorkspaceSelection.current) {
    const loadVersion = ++sourceLoadVersion.current;
    const response = await fetch(`/api/context/sources?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(localizeServerError(data.error, tr) || tr("sourcesUnavailable"));
    if (loadVersion !== sourceLoadVersion.current || calendarWorkspaceSelection.current !== workspaceId) return;
    setContextSources(Array.isArray(data.sources) ? data.sources : []);
  }

  // A workspace has its own sources and drafts.
  useEffect(() => {
    if (authState !== "ready") return;
    const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
    setContextSources([]); setEvidenceDraft(null); setEvidenceStatus(""); setSourceEdit(null); setSourceStatus("");
    loadContextSources(workspaceId).catch(() => setSourceStatus(tr("sourcesUnavailable")));
  }, [authState, activeWorkspaceId, writeWorkspaceId]);

  const errorText = (data: { code?: string; error?: string }, fallback: string) => {
    const byCode: Record<string, string> = { metadata_only_source: "evidenceMetadataOnlyHint", revision_conflict: "evidenceConflict",
      source_in_use: "sourceInUseError", coverage_in_use: "sourceCoverageInUseError", duplicate_source: "sourceDuplicateError",
      duplicate_evidence: "evidenceDuplicateError", evidence_limit: "evidenceLimitError", archived_source: "sourceArchivedError",
      evidence_too_long: "evidenceTooLongError", reason_required: "sourceReasonRequired", coverage_required: "sourceCoverageRequired" };
    return data.code && byCode[data.code] ? tr(byCode[data.code]) : localizeServerError(data.error, tr) || fallback;
  };
  async function post(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  }

  function openEvidenceForm(claim: ContextClaimItem) {
    setEvidenceStatus("");
    setEvidenceDraft({ claimId: claim.id, mode: contextSources.some((source) => !source.archivedAt) ? "existing" : "new", sourceId: "", locator: "", excerpt: "",
      stance: "supports", source: { ...emptySourceFields } });
  }
  const closeEvidenceForm = () => setEvidenceDraft(null);
  const patchEvidenceDraft = (patch: Partial<EvidenceDraft>) => setEvidenceDraft((current) => current ? { ...current, ...patch } : current);
  const patchDraftSource = (patch: Partial<SourceFields>) => setEvidenceDraft((current) => current ? { ...current, source: { ...current.source, ...patch } } : current);

  /** The coverage of the source the draft would cite: only content coverage may carry an excerpt or a location. */
  const draftCoverage = (draft: EvidenceDraft) => draft.mode === "new" ? draft.source.coverage || null : contextSources.find((source) => source.id === draft.sourceId)?.coverage ?? null;

  async function submitEvidence(claim: ContextClaimItem) {
    const draft = evidenceDraft;
    if (!draft || draft.claimId !== claim.id) return;
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `evidence:add:${claim.id}`;
    if (contextInFlight.current.has(busyKey)) return;
    const hasContent = Boolean(draft.excerpt.trim() || draft.locator.trim());
    if (hasContent && !content(draftCoverage(draft))) { setEvidenceStatus(tr("evidenceMetadataOnlyHint")); return; }
    contextInFlight.current.add(busyKey);
    setEvidenceBusy(true); setEvidenceStatus("");
    try {
      let sourceId = draft.sourceId;
      if (draft.mode === "new") {
        const body = sourceBody(draft.source);
        const scope = `source:create:${claim.id}`;
        const intent = contextIntent(scope, JSON.stringify([workspaceId, body]));
        const created = await post("/api/context/sources", { action: "create", idempotencyKey: intent.commandKey, workspaceId, id: intent.objectId, expectedRevision: 0, ...body });
        if (!created.ok) throw new Error(errorText(created.data, tr("sourceFailed")));
        finishContextIntent(scope);
        sourceId = String(created.data.source?.id || intent.objectId);
        // The source exists now: a retry of the evidence must cite it, not create it again.
        setEvidenceDraft((current) => current && current.claimId === claim.id ? { ...current, mode: "existing", sourceId } : current);
        await refreshAfterCommand(() => loadContextSources(workspaceId));
        // The source already existed with less coverage than the draft's content needs: nothing is submitted, the draft now
        // cites that source, and the person chooses between raising its coverage and saving without the excerpt.
        if (hasContent && !content(created.data.source?.coverage)) { setEvidenceStatus(tr("evidenceDedupMetadataOnly")); return; }
      }
      if (!sourceId) throw new Error(tr("evidenceChooseSource"));
      const fields = { locator: draft.locator.trim() || null, excerpt: draft.excerpt.trim() || null, stance: draft.stance };
      const scope = `evidence:add:${claim.id}`;
      const intent = contextIntent(scope, JSON.stringify([workspaceId, claim.revision, sourceId, fields]));
      const added = await post("/api/context/evidence", { action: "add", idempotencyKey: intent.commandKey, workspaceId, id: intent.objectId, claimId: claim.id,
        expectedClaimRevision: claim.revision, expectedRevision: 0, sourceId, ...fields });
      if (!added.ok) throw new Error(errorText(added.data, tr("evidenceFailed")));
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setEvidenceDraft((current) => current && current.claimId === claim.id ? null : current);
      if (added.data.claim) syncEditedClaim(added.data.claim as ContextClaimItem);
      setEvidenceStatus(tr("saved"));
      offerContextUndo("evidence", workspaceId, added.data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextClaims(workspaceId), () => loadContextSources(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) setEvidenceStatus(tr("savedListNotRefreshed"));
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setEvidenceStatus(commandFailureMessage(error, tr("evidenceFailed")));
    } finally {
      contextInFlight.current.delete(busyKey);
      setEvidenceBusy([...contextInFlight.current].some((key) => key.startsWith("evidence:")));
    }
  }

  async function archiveEvidence(item: ContextEvidenceItem) {
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `evidence:archive:${item.id}`;
    if (contextInFlight.current.has(busyKey)) return;
    const scope = busyKey;
    const intent = contextIntent(scope, JSON.stringify([workspaceId, item.revision]));
    contextInFlight.current.add(busyKey);
    setEvidenceBusy(true); setEvidenceStatus("");
    try {
      const archived = await post("/api/context/evidence", { action: "archive", idempotencyKey: intent.commandKey, workspaceId, id: item.id, expectedRevision: item.revision });
      if (!archived.ok) throw new Error(errorText(archived.data, tr("evidenceFailed")));
      finishContextIntent(scope);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      if (archived.data.claim) syncEditedClaim(archived.data.claim as ContextClaimItem);
      setEvidenceStatus(tr("saved"));
      offerContextUndo("evidence", workspaceId, archived.data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextClaims(workspaceId), () => loadContextSources(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) setEvidenceStatus(tr("savedListNotRefreshed"));
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setEvidenceStatus(commandFailureMessage(error, tr("evidenceFailed")));
    } finally {
      contextInFlight.current.delete(busyKey);
      setEvidenceBusy([...contextInFlight.current].some((key) => key.startsWith("evidence:")));
    }
  }

  const startSourceEdit = (source: ContextSourceItem) => { setSourceStatus(""); setSourceEdit({ id: source.id, revision: source.revision, fields: sourceFieldsOf(source), original: source.sensitivity, reason: "" }); };
  const cancelSourceEdit = () => setSourceEdit(null);
  const setSourceReason = (reason: string) => setSourceEdit((current) => current ? { ...current, reason } : current);
  const patchSourceEdit = (patch: Partial<SourceFields>) => setSourceEdit((current) => current ? { ...current, fields: { ...current.fields, ...patch } } : current);

  async function sourceCommand(action: "update" | "archive", source: ContextSourceItem, fields?: SourceFields, reason?: string) {
    const workspaceId = calendarWorkspaceSelection.current;
    const busyKey = `source:${action}:${source.id}`;
    if (contextInFlight.current.has(busyKey)) return;
    const body = fields ? sourceBody(fields) : {};
    const intent = contextIntent(busyKey, JSON.stringify([workspaceId, source.revision, body, reason || null]));
    contextInFlight.current.add(busyKey);
    setSourceBusy(true); setSourceStatus("");
    try {
      const done = await post("/api/context/sources", { action, idempotencyKey: intent.commandKey, workspaceId, id: source.id, expectedRevision: source.revision, ...body, ...(reason ? { reason } : {}) });
      if (!done.ok) throw new Error(errorText(done.data, tr("sourceFailed")));
      finishContextIntent(busyKey);
      if (calendarWorkspaceSelection.current !== workspaceId) return;
      setSourceEdit((current) => current && current.id === source.id ? null : current);
      setSourceStatus(tr("saved"));
      offerContextUndo("source", workspaceId, done.data.historyEventId);
      if (!(await refreshAfterCommand(() => loadContextSources(workspaceId), () => loadContextClaims(workspaceId))) && calendarWorkspaceSelection.current === workspaceId) setSourceStatus(tr("savedListNotRefreshed"));
    } catch (error) {
      if (calendarWorkspaceSelection.current === workspaceId) setSourceStatus(commandFailureMessage(error, tr("sourceFailed")));
    } finally {
      contextInFlight.current.delete(busyKey);
      setSourceBusy([...contextInFlight.current].some((key) => key.startsWith("source:")));
    }
  }
  const saveSourceEdit = () => {
    if (!sourceEdit) return;
    const source = contextSources.find((candidate) => candidate.id === sourceEdit.id);
    if (source) void sourceCommand("update", { ...source, revision: sourceEdit.revision }, sourceEdit.fields, sourceEdit.reason.trim());
  };
  const archiveSource = (source: ContextSourceItem) => sourceCommand("archive", source);

  return { archiveEvidence, archiveSource, cancelSourceEdit, closeEvidenceForm, contextSources, draftCoverage, evidenceBusy, evidenceDraft, evidenceStatus,
    loadContextSources, openEvidenceForm, patchDraftSource, patchEvidenceDraft, patchSourceEdit, saveSourceEdit, setSourceReason, setEvidenceStatus, sourceBusy, sourceEdit,
    sourceStatus, startSourceEdit, submitEvidence };
}
