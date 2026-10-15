"use client";
import { useState } from "react";
import type { ContextClaimItem, ContextEvidenceItem, ContextSourceItem } from "../types";
import type { LumiApp } from "../use-lumi-app";
import type { SourceFields } from "../hooks/use-context-evidence";

// The evidence of a claim (list, add, archive) and the compact list of sources (edit, archive, how many evidence
// items use each). User-entered text is marked `data-user-content`.

const coverageKey = { missing: "coverageMissing", metadata_only: "coverageMetadataOnly", content: "coverageContent" } as const;

export function CoverageBadge({ app, coverage }: { app: LumiApp; coverage: ContextClaimItem["sourceCoverage"] }) {
  return <span className={`coverageBadge coverage-${coverage}`}>{app.tr(coverageKey[coverage])}</span>;
}

function SourceFieldsForm({ app, fields, onChange, idPrefix, requireChoice }: { app: LumiApp; fields: SourceFields; onChange: (patch: Partial<SourceFields>) => void; idPrefix: string; requireChoice?: boolean }) {
  const { tr } = app;
  const text = (key: keyof SourceFields, label: string, maxLength: number, placeholder?: string) => <label key={key}>{label}<input data-user-content value={fields[key]} maxLength={maxLength} placeholder={placeholder}
    onChange={(event) => onChange({ [key]: event.target.value } as Partial<SourceFields>)} /></label>;
  return <div className="contextSourceFields" id={idPrefix}>
    <div className="preferenceGrid">{text("provider", tr("srcProvider"), 80)}{text("author", tr("srcAuthor"), 200)}</div>
    <div className="preferenceGrid">{text("authorRole", tr("srcAuthorRole"), 120)}{text("sourceAt", tr("srcSourceAt"), 40, "2026-05-01")}</div>
    <div className="preferenceGrid">{text("account", tr("srcAccount"), 200)}{text("externalId", tr("srcExternalId"), 240)}</div>
    {text("ingestedAt", tr("srcIngestedAt"), 40, "2026-05-02")}
    {text("locator", tr("srcLocator"), 2000)}
    <div className="preferenceGrid">
      <label>{tr("srcCoverage")}<select data-testid="source-coverage" value={fields.coverage} onChange={(event) => onChange({ coverage: event.target.value as SourceFields["coverage"] })}>
        <option value="">{requireChoice ? tr("srcCoverageChoose") : tr("srcCoverageUnknown")}</option><option value="metadata">{tr("srcCoverageMetadata")}</option><option value="excerpt">{tr("srcCoverageExcerpt")}</option><option value="body">{tr("srcCoverageBody")}</option></select></label>
      <label>{tr("sensitivity")}<select value={fields.sensitivity} onChange={(event) => onChange({ sensitivity: event.target.value as SourceFields["sensitivity"] })}>
        <option value="normal">{tr("normal")}</option><option value="confidential">{tr("confidential")}</option><option value="restricted">{tr("restricted")}</option></select></label>
    </div>
  </div>;
}

const short = (value: string, length = 40) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
/** One label per source, each different from the others: a short id suffix only when everything else is equal. */
function pickerLabels(app: LumiApp, sources: ContextSourceItem[]) {
  const base = sources.map((source) => [sourceName(app, source), source.author, source.account, source.externalId && `#${source.externalId}`, source.locator && short(source.locator),
    source.coverage && app.tr(`srcCoverage${source.coverage[0].toUpperCase()}${source.coverage.slice(1)}`)].filter(Boolean).map((part) => short(String(part), 40)).join(" · "));
  return sources.map((source, index) => base.filter((label) => label === base[index]).length > 1 ? `${base[index]} · ${source.id.slice(-4)}` : base[index]);
}

const sourceName = (app: LumiApp, source: ContextSourceItem) => source.provider ? app.providerLabel(source.provider) : source.externalId || source.locator || source.author || "—";

function SourceSummary({ app, source, showName = true }: { app: LumiApp; source: ContextSourceItem; showName?: boolean }) {
  const { tr, language } = app;
  const coverage = source.coverage ? tr(`srcCoverage${source.coverage[0].toUpperCase()}${source.coverage.slice(1)}`) : tr("srcCoverageUnknown");
  return <small className="evidenceSource">
    {showName && <span data-user-content>{sourceName(app, source)}</span>}
    {source.author ? <>{showName ? " · " : ""}<span data-user-content>{source.author}{source.authorRole ? ` (${source.authorRole})` : ""}</span></> : null}
    {source.sourceAt ? <> · <time data-user-content dateTime={source.sourceAt}>{/^\d{4}-\d{2}-\d{2}$/.test(source.sourceAt) ? source.sourceAt : new Date(source.sourceAt).toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB")}</time></> : null}
    {source.ingestedAt ? <> · {tr("srcIngestedShort")} <span data-user-content>{/^\d{4}-\d{2}-\d{2}$/.test(source.ingestedAt) ? source.ingestedAt : new Date(source.ingestedAt).toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB")}</span></> : null}
    {" "}<span className={`coverageBadge srcCoverageBadge-${source.coverage || "unknown"}`}>{coverage}</span>
    {source.sensitivity !== "normal" ? <> <span className="sensitivityBadge">{source.sensitivity === "restricted" ? tr("restricted2") : tr("confidential2")}</span></> : null}
  </small>;
}

function EvidenceRow({ app, item, identity }: { app: LumiApp; item: ContextEvidenceItem; identity: string }) {
  const { tr, archiveEvidence, evidenceBusy } = app;
  return <li className="evidenceItem" data-metadata-only={item.metadataOnly ? "true" : "false"}>
    <span className={`evidenceStance stance-${item.stance || "none"}`}>{tr(item.stance === "supports" ? "evidenceStanceSupports" : item.stance === "contradicts" ? "evidenceStanceContradicts" : "evidenceStanceNone")}</span>
    {item.excerpt && <blockquote data-user-content>{item.excerpt}</blockquote>}
    {item.locator && <small>{tr("evidenceLocator")}: <span data-user-content>{item.locator}</span></small>}
    <small className="evidenceIdentity" data-user-content>{identity}</small>
    <SourceSummary app={app} source={item.source} showName={false} />
    {item.metadataOnly && <small className="metadataOnlyNote">{tr("evidenceMetadataOnly")}</small>}
    <button type="button" className="textAction danger" disabled={evidenceBusy} onClick={() => archiveEvidence(item)}
      aria-label={`${tr("evidenceArchive")}: ${item.excerpt || item.locator || sourceName(app, item.source)}`.slice(0, 160)}>{tr("evidenceArchive")}</button>
  </li>;
}

export function ClaimEvidence({ app, claim }: { app: LumiApp; claim: ContextClaimItem }) {
  // Stays open while the person works with this claim's evidence (saving, archiving or undoing does not collapse it).
  const [open, setOpen] = useState(false);
  const { tr, evidenceDraft, evidenceBusy, contextSources, openEvidenceForm, closeEvidenceForm, patchEvidenceDraft, patchDraftSource, submitEvidence, draftCoverage } = app;
  const draft = evidenceDraft && evidenceDraft.claimId === claim.id ? evidenceDraft : null;
  const liveSources = contextSources.filter((source) => !source.archivedAt);
  const coverage = draft ? draftCoverage(draft) : null;
  const contentAllowed = coverage === "excerpt" || coverage === "body";
  const hasContent = Boolean(draft && (draft.excerpt.trim() || draft.locator.trim()));
  const canSave = Boolean(draft) && !evidenceBusy && (draft!.mode === "existing" ? Boolean(draft!.sourceId) : Boolean(draft!.source.coverage && (draft!.source.provider.trim() || draft!.source.externalId.trim() || draft!.source.locator.trim() || draft!.source.author.trim()))) && (!hasContent || contentAllowed);
  return <details className="claimEvidence" open={open || Boolean(draft)} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{tr("evidenceSection")} ({claim.evidenceCount})</summary>
    {claim.evidenceItems.length ? <ul className="evidenceList">{pickerLabels(app, claim.evidenceItems.map((item) => item.source)).map((identity, index) => <EvidenceRow key={claim.evidenceItems[index].id} app={app} item={claim.evidenceItems[index]} identity={identity} />)}</ul> : <p>{tr("evidenceNone")}</p>}
    {!draft && !claim.archivedAt && <button type="button" onClick={() => { setOpen(true); openEvidenceForm(claim); }}>{tr("evidenceAdd")}</button>}
    {draft && <form className="contextEvidenceForm" onSubmit={(event) => { event.preventDefault(); if (canSave) void submitEvidence(claim); }}>
      <label>{tr("evidenceSourceChoice")}<select data-testid="evidence-source-mode" value={draft.mode} onChange={(event) => patchEvidenceDraft({ mode: event.target.value as "existing" | "new" })}>
        <option value="existing" disabled={!liveSources.length}>{tr("evidenceSourceExisting")}</option><option value="new">{tr("evidenceSourceNew")}</option></select></label>
      {draft.mode === "existing"
        ? <label>{tr("sourceSection")}<select data-testid="evidence-source-pick" value={draft.sourceId} onChange={(event) => patchEvidenceDraft({ sourceId: event.target.value })}>
          <option value="">{tr("evidenceChooseSource")}</option>{pickerLabels(app, liveSources).map((label, index) => <option key={liveSources[index].id} value={liveSources[index].id}>{label}</option>)}</select></label>
        : <SourceFieldsForm app={app} fields={draft.source} onChange={patchDraftSource} idPrefix={`new-source-${claim.id}`} requireChoice />}
      <label>{tr("evidenceStance")}<select value={draft.stance} onChange={(event) => patchEvidenceDraft({ stance: event.target.value as "supports" | "contradicts" })}>
        <option value="supports">{tr("evidenceStanceSupports")}</option><option value="contradicts">{tr("evidenceStanceContradicts")}</option></select></label>
      {!contentAllowed && (draft.mode === "new" || draft.sourceId) && <p className="metadataOnlyNote" role="note">{tr("evidenceMetadataOnlyHint")}</p>}
      <label>{tr("evidenceLocator")}<input data-user-content value={draft.locator} maxLength={1000} disabled={!contentAllowed && !hasContent} onChange={(event) => patchEvidenceDraft({ locator: event.target.value })} /></label>
      <label>{tr("evidenceExcerptLabel")}<textarea data-user-content value={draft.excerpt} maxLength={500} disabled={!contentAllowed && !hasContent} onChange={(event) => patchEvidenceDraft({ excerpt: event.target.value })} /></label>
      {app.evidenceStatus && <p className="metadataOnlyNote" role="alert">{app.evidenceStatus}</p>}
      <div className="contextClaimActions"><button type="submit" className="primaryAction" disabled={!canSave}>{evidenceBusy ? tr("saving") : tr("evidenceSave")}</button><button type="button" onClick={closeEvidenceForm}>{tr("cancel")}</button></div>
    </form>}
  </details>;
}

export function ContextSources({ app }: { app: LumiApp }) {
  const { tr, contextSources, sourceEdit, setSourceReason, sourceBusy, sourceStatus, startSourceEdit, cancelSourceEdit, patchSourceEdit, saveSourceEdit, archiveSource, historyOffer, contextHistory, historyBusy, contextHistoryAction } = app;
  const rank = { normal: 0, confidential: 1, restricted: 2 };
  const lowered = Boolean(sourceEdit && rank[sourceEdit.fields.sensitivity] < rank[sourceEdit.original]);
  const undoStep = historyOffer === "source" && sourceStatus && contextHistory.undo ? contextHistory.undo : null;
  const stepText = undoStep ? app.contextStepText(undoStep) : null;
  return <section className="contextSources" aria-labelledby="context-sources-title">
    <div className="sectionHeading"><div><h2 id="context-sources-title">{tr("sourceSection")}</h2><p>{tr("sourceSectionHelp")}</p></div></div>
    {sourceStatus && <p role="status">{sourceStatus}</p>}
    {stepText && <button type="button" className="contextUndoOffer" disabled={historyBusy} onClick={() => contextHistoryAction("undo")}>{tr("contextUndo")}: {stepText.action} <span data-user-content>{stepText.target}</span></button>}
    <div className="contextSourceList">
      {contextSources.filter((source) => !source.archivedAt).map((source) => <article key={source.id} className="contextSourceCard">
        {sourceEdit?.id === source.id
          ? <form onSubmit={(event) => { event.preventDefault(); saveSourceEdit(); }}>
            <SourceFieldsForm app={app} fields={sourceEdit.fields} onChange={patchSourceEdit} idPrefix={`edit-source-${source.id}`} />
            {lowered && <label className="sourceReason">{tr("sourceReasonLabel")}<input data-testid="source-reason" data-user-content value={sourceEdit.reason} maxLength={500} onChange={(event) => setSourceReason(event.target.value)} /></label>}
            {lowered && <small role="note">{tr("sourceLowerExplain")}</small>}
            <div className="contextClaimActions"><button type="submit" className="primaryAction" disabled={sourceBusy || (lowered && !sourceEdit.reason.trim())}>{tr("save")}</button><button type="button" onClick={cancelSourceEdit}>{tr("cancel")}</button></div>
          </form>
          : <>
            <strong data-user-content>{sourceName(app, source)}</strong>
            <SourceSummary app={app} source={source} showName={false} />
            {(source.account || source.externalId || source.locator) && <small className="sourceIdentity" data-user-content>{[source.account, source.externalId, source.locator].filter(Boolean).join(" · ")}</small>}
            <small>{tr("sourceUsedBy").replace("{count}", String(source.evidenceCount ?? 0))}</small>
            <div className="contextClaimActions">
              <button type="button" onClick={() => startSourceEdit(source)}>{tr("edit")}</button>
              <button type="button" className="textAction danger" disabled={sourceBusy} onClick={() => archiveSource(source)}>{tr("archive")}</button>
            </div>
          </>}
      </article>)}
      {!contextSources.some((source) => !source.archivedAt) && <p>{tr("sourceNone")}</p>}
    </div>
  </section>;
}
