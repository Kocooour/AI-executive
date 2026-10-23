"use client";
import { describeAttentionSources } from "../../../lib/attention-sources";
import { useState } from "react";
import { attentionPrimaryAction } from "../../../lib/home-today";
import { attentionReason } from "../format";
import type { AttentionResponse } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { DeferChip } from "./defer-popover";
import { PopoverMenu } from "./popover-menu";

type Candidate = AttentionResponse["items"][number];

// One attention item on Home: the title, one line saying why, and one primary action on the right
// (the task's date chip, or "Open"). Snooze, Dismiss, Sources and (when the chip is primary) Open are
// in the item's "⋯" menu. The reason, source and evaluation time stay available: the evaluation time
// is in the section header once and in the expanded sources.
export function AttentionItemRow({ app, candidate }: { app: LumiApp; candidate: Candidate }) {
  const { actOnAttention, activeWorkspaceId, attentionActionsBlocked, attentionBusyKey, inspect, items, language, scopedRelations, setAttentionError, tr, workspaces } = app;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const workspaceTitle = (workspaceId: string) => workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.title || workspaceId;
  const shortTime = (value: number, timeZone?: string) =>
    new Date(value).toLocaleString(locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { records: sourceRecords, claims: sourceClaims, missing: sourceMissing } = describeAttentionSources(candidate.sourceIds, candidate.workspaceId, items, scopedRelations);
  const sourceTypeKey = (type: string) => ["task", "project", "note", "area"].includes(type) ? type : "attentionSourceRecord";
  const subject = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
  // A row evaluated before the user edited its subject on this device may no longer hold.
  const changedSince = attentionActionsBlocked && Boolean(subject && Number(subject.updatedAt) > candidate.evaluatedAt);
  const primary = attentionPrimaryAction(candidate, subject, activeWorkspaceId !== "all");
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
        {/* One line: why, from what (the time of the evaluation is in the section header). */}
        <p className="attentionWhy"><span className="attentionReason">{attentionReason(candidate, language).replace(/\.$/, "")}</span> · {candidate.confidence === "limited" ? tr("attentionLimited") : candidate.ruleId === "waiting_follow_up" ? tr("attentionRecordedWaiting") : candidate.ruleId === "planned_date_passed" ? tr("attentionRecordedPlanned") : tr("attentionRecorded")}{activeWorkspaceId === "all" && <> · {workspaceTitle(candidate.workspaceId)}</>}{changedSince && <> · <b>{tr("attentionChangedSince")}</b></>}</p>
      </div>
      <div className="attentionRowActions">
        {primary === "defer" && subject
          ? <DeferChip app={app} task={subject} />
          : <button type="button" className="attentionOpen attentionOpenAction" aria-label={`${tr("attentionOpen")}: ${candidate.title}`} onClick={open}>{tr("attentionOpen")}</button>}
        <PopoverMenu label={`${tr("attentionMoreActions")}: ${candidate.title}`} triggerLabel={`${tr("attentionMoreActions")}: ${candidate.title}`}
          triggerClassName="attentionMenuButton" triggerData={{ "data-attention-menu": "" }} triggerContent={<span aria-hidden="true">⋯</span>}>
          {(close) => <>
            {primary === "defer" && <button type="button" role="menuitem" onClick={() => { close(false); open(); }}>{tr("attentionOpen")}</button>}
            <button type="button" role="menuitem" aria-label={`${tr("attentionSnooze")}: ${candidate.title}`} disabled={busy}
              onClick={(event) => { void actAndKeepFocus(event.currentTarget, "snooze"); close(false); }}>{tr("attentionSnooze")}</button>
            <button type="button" role="menuitem" aria-label={`${tr("attentionDismiss")}: ${candidate.title}`} disabled={busy}
              onClick={(event) => { void actAndKeepFocus(event.currentTarget, "dismiss"); close(false); }}>{tr("attentionDismiss")}</button>
            <button type="button" role="menuitem" aria-expanded={sourcesOpen} onClick={() => { setSourcesOpen((current) => !current); close(true); }}>{tr("attentionSourceDetails")}</button>
          </>}
        </PopoverMenu>
      </div>
      {sourcesOpen && (
        <div className="attentionMore">
          {/* What a person can act on: when it was evaluated and which records it rests on, by name.
              Internal IDs and revision numbers stay out of the view. */}
          <p className="attentionMeta">{tr("attentionEvaluatedAt")} {shortTime(candidate.evaluatedAt, candidate.timezone)}
            {activeWorkspaceId === "all" ? ` · ${workspaceTitle(candidate.workspaceId)}` : ""}
            {candidate.timezone && candidate.timezone !== deviceTimeZone ? ` (${candidate.timezone})` : ""}</p>
          <ul className="attentionSources" aria-label={tr("attentionSourceDetails")}>
            {sourceRecords.map((source) => <li key={source.id}>{tr(sourceTypeKey(source.type))}: {source.title || tr("untitledItem")}</li>)}
            {sourceClaims > 0 && <li>{tr("attentionSourceContext").replace("{n}", String(sourceClaims))}</li>}
            {sourceMissing > 0 && <li>{tr("attentionSourceMissing")}{sourceMissing > 1 ? ` (${sourceMissing})` : ""}</li>}
          </ul>
        </div>
      )}
    </article>
  );
}
