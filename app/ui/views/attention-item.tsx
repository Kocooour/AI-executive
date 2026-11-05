"use client";
import { describeAttentionSources } from "../../../lib/attention-sources";
import { useId, useState } from "react";
import { attentionPrimaryAction } from "../../../lib/home-today";
import { attentionReason } from "../format";
import type { AttentionResponse } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { DeferChip } from "./defer-popover";
import { PopoverMenu } from "./popover-menu";

type Candidate = AttentionResponse["items"][number];

// One attention item on Home: title, human reason and one primary action.
// "Proč?" directly reveals the local source evidence and evaluation instant;
// Snooze and Dismiss remain in the item's "⋯" menu. No new authority or ACL.
export function AttentionItemRow({ app, candidate }: { app: LumiApp; candidate: Candidate }) {
  const { actOnAttention, activeWorkspaceId, attentionActionsBlocked, attentionBusyKey, attentionStale, inspect, items, language, scopedRelations, setAttentionError, tr, workspaces } = app;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const whyId = useId();
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  // Never display a raw workspace ID when the local label is unavailable.
  const workspaceTitle = workspaces.find((workspace) => workspace.workspaceId === candidate.workspaceId)?.title;
  const evaluationDate = new Date(candidate.evaluatedAt);
  // Format the instant in the viewer's local time, not a technical IANA time-zone name.
  const evaluatedTime = Number.isFinite(evaluationDate.getTime())
    ? evaluationDate.toLocaleString(locale, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : tr("attentionUnknown");
  const { records: sourceRecords, claims: sourceClaims, missing: sourceMissing } = describeAttentionSources(candidate.sourceIds, candidate.workspaceId, items, scopedRelations);
  const sourceTypeKey = (type: string) => ["task", "project", "note", "area"].includes(type) ? type : "attentionSourceRecord";
  const subject = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
  // A row evaluated before the user edited its subject on this device may no longer hold.
  const changedSince = attentionActionsBlocked && Boolean(subject && Number(subject.updatedAt) > candidate.evaluatedAt);
  // Never offer the quick date edit from an old Attention recommendation. A user
  // can still open the underlying task and review its current local data.
  const primary = attentionPrimaryAction(candidate, subject, activeWorkspaceId !== "all", attentionActionsBlocked);
  const open = () => {
    if (subject) void inspect(subject);
    else setAttentionError(tr("attentionDetailMissing"));
  };
  const busy = Boolean(attentionBusyKey) || attentionActionsBlocked;

  // The snoozed or dismissed item leaves the list; keyboard focus moves to the item now in its place
  // (or the one before it, or the section heading) instead of falling back to the page.
  async function actAndKeepFocus(button: HTMLElement, action: "snooze" | "dismiss") {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".attentionSection .attentionItem"));
    const index = rows.indexOf(button.closest(".attentionItem") as HTMLElement);
    await actOnAttention(candidate, action);
    // Let React remove the item first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (document.activeElement && document.activeElement !== document.body && document.contains(document.activeElement)) return;
    const opens = document.querySelectorAll<HTMLElement>(".attentionSection .attentionItem .attentionTitleButton");
    const target = opens[Math.min(Math.max(index, 0), opens.length - 1)] ?? document.getElementById("attention-title");
    target?.focus();
  }

  return (
    <article className="attentionItem" data-attention-rule={candidate.ruleId}>
      <div className="attentionBody">
        <strong><button type="button" className="attentionOpen attentionTitleButton" onClick={open}>{candidate.title}</button></strong>
        {/* Explain the source and time on demand, without overloading the ordinary row. */}
        <p className="attentionWhy">
          <span className="attentionReason">{attentionReason(candidate, language).replace(/\.$/, "")}</span>
          {candidate.confidence === "limited" && <> · <strong>{tr("attentionLimited")}</strong></>}
          {activeWorkspaceId === "all" && workspaceTitle && <> · {workspaceTitle}</>}
          {attentionStale && <> · <span className="attentionRowStale">{tr("attentionStale")}</span></>}
          {changedSince && <> · <strong>{tr("attentionChangedSince")}</strong></>}
          {" "}
          <button type="button" className="attentionWhyToggle"
            aria-label={tr("attentionWhyAction") + ": " + candidate.title}
            aria-controls={whyId} aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((value) => !value)}>{tr("attentionWhyAction")}</button>
        </p>
      </div>
      <div className="attentionRowActions">
        {primary === "defer" && subject
          ? <DeferChip app={app} task={subject} fromAttention />
          : <button type="button" className="attentionOpen attentionOpenAction" aria-label={`${tr("attentionOpen")}: ${candidate.title}`} onClick={open}>{tr("attentionOpen")}</button>}
        <PopoverMenu label={`${tr("attentionMoreActions")}: ${candidate.title}`} triggerLabel={`${tr("attentionMoreActions")}: ${candidate.title}`}
          triggerClassName="attentionMenuButton" triggerData={{ "data-attention-menu": "" }} triggerContent={<span aria-hidden="true">⋯</span>}>
          {(close) => <>
            {primary === "defer" && <button type="button" role="menuitem" onClick={() => { close(false); open(); }}>{tr("attentionOpen")}</button>}
            <button type="button" role="menuitem" aria-label={`${tr("attentionSnooze")}: ${candidate.title}`} disabled={busy}
              onClick={(event) => { void actAndKeepFocus(event.currentTarget, "snooze"); close(false); }}>{tr("attentionSnooze")}</button>
            <button type="button" role="menuitem" aria-label={`${tr("attentionDismiss")}: ${candidate.title}`} disabled={busy}
              onClick={(event) => { void actAndKeepFocus(event.currentTarget, "dismiss"); close(false); }}>{tr("attentionDismiss")}</button>
          </>}
        </PopoverMenu>
      </div>
      <div className="attentionMore" id={whyId} hidden={!sourcesOpen}>
          {/* Cached or outdated recommendations are evidence from an earlier evaluation,
              never a statement about the current task. */}
          {attentionStale && <p className="attentionMeta attentionExplanationStale">{tr("attentionStaleWhy")}</p>}
          {changedSince && <p className="attentionMeta attentionExplanationChanged">{tr("attentionChangedSinceWhy")}</p>}
          {/* Locally visible source names only: no internal IDs or time-zone keys. */}
          <p className="attentionMeta">{tr("attentionEvaluatedAt")}: <time>{evaluatedTime}</time>
            {activeWorkspaceId === "all" && workspaceTitle ? " · " + workspaceTitle : ""}</p>
          <ul className="attentionSources" aria-label={tr("attentionSourceDetails")}>
            {sourceRecords.map((source) => <li key={source.id}>{tr(sourceTypeKey(source.type))}: {source.title || tr("untitledItem")}</li>)}
            {sourceClaims > 0 && <li>{tr("attentionSourceContext").replace("{n}", String(sourceClaims))}</li>}
            {sourceMissing > 0 && <li>{tr("attentionSourceMissing")}{sourceMissing > 1 ? ` (${sourceMissing})` : ""}</li>}
            {sourceRecords.length === 0 && sourceClaims === 0 && sourceMissing === 0 && <li>{tr("attentionSourceUnknown")}</li>}
          </ul>
      </div>
    </article>
  );
}
