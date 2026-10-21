"use client";

import { useEffect, useState } from "react";
import type { LumiApp } from "../use-lumi-app";

type BatchDecision = "today" | "tomorrow" | "someday" | "waiting" | "organize";
type BatchSnapshot = { id: string; workspaceId: string; updatedAt: number; title: string };
interface Review {
  selection: BatchSnapshot[];
  workspaceId: string;
  action: BatchDecision;
  projectId: string;
  areaId: string;
  summary: string;
}

// B5 uses the canonical Inbox list's checkboxes, not a second duplicate task list.
// "Review" freezes exactly which records and changes the user confirms.
export function InboxBatchTriage({ app }: { app: LumiApp }) {
  const { activeWorkspaceId, batchAllowed, batchCandidates, batchIds, setBatchIds,
    triageInboxBatch, projects, areas, tr, syncStatus } = app;
  const [action, setAction] = useState<BatchDecision>("today");
  const [projectId, setProjectId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choiceKey = batchIds.join("|");
  useEffect(() => { setReview(null); setError(""); }, [choiceKey, action, projectId, areaId, activeWorkspaceId]);

  if (app.view !== "Inbox") return null;
  if (!batchAllowed) return <p className="batchTriageReadOnly" role="status">{tr("batchReadOnly")}</p>;

  const projectChoices = projects.filter(x => x.workspaceId === activeWorkspaceId && x.status === "active");
  const areaChoices = areas.filter(x => x.workspaceId === activeWorkspaceId && x.status === "active");
  const project = projectChoices.find(x => x.id === projectId);
  const area = areaChoices.find(x => x.id === areaId);
  const readyToReview = batchIds.length > 0 && (action !== "organize" || Boolean(project || area));
  const actionLabel = action === "today" ? tr("triageToday") :
    action === "tomorrow" ? tr("triageTomorrow") :
    action === "someday" ? tr("triageSomeday") :
    action === "waiting" ? tr("triageWaiting") : tr("triageOrganizeTitle");
  const allSelected = batchCandidates.length > 0 &&
    batchCandidates.slice(0, 50).every(x => batchIds.includes(x.id));

  function prepare() {
    if (!readyToReview || busy) return;
    const chosen = batchIds.map(id => batchCandidates.find(item => item.id === id)).filter(
      (item): item is (typeof batchCandidates)[number] => Boolean(item));
    if (chosen.length !== batchIds.length || chosen.length === 0) return;
    setReview({
      workspaceId: activeWorkspaceId,
      selection: chosen.map(item => ({
        id: item.id, workspaceId: item.workspaceId, updatedAt: item.updatedAt, title: item.title,
      })),
      action, projectId: project?.id || "", areaId: area?.id || "",
      summary: [actionLabel, ...(action === "organize" ? [project?.title, area?.title] : [])]
        .filter(Boolean).join(" · "),
    });
  }

  async function apply() {
    if (!review || busy || review.workspaceId !== activeWorkspaceId ||
        review.selection.length !== batchIds.length ||
        review.selection.some(item => !batchIds.includes(item.id))) return;
    setBusy(true);
    setError("");
    try {
      await triageInboxBatch(review.selection, review.action, {
        projectId: review.projectId, areaId: review.areaId,
      });
      setReview(null);
      setBatchIds([]);
    } catch (failure) {
      console.error("Batch Inbox triage refused", failure);
      // No automatic retries: stale or inaccessible records require new review.
      setReview(null);
      setError(tr("batchFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="batchTriage" aria-label={tr("batchTitle")}>
    <div className="batchTriageHeading">
      <h2>{tr("batchTitle")}</h2>
      <span role="status" aria-live="polite">
        {tr("batchSelected").replace("{count}", String(batchIds.length))}
      </span>
    </div>
    <div className="batchTriageToolbar">
      <button type="button" disabled={busy || !batchCandidates.length}
        onClick={() => setBatchIds(allSelected ? [] : batchCandidates.slice(0, 50).map(x => x.id))}>
        {allSelected ? tr("batchClear") : tr("batchSelectAll")}
      </button>
      {batchCandidates.length > 50 && <small>{tr("batchMaxItems")}</small>}
      <span className="batchTriageSync" role="status">{tr(syncStatus === "offline" ? "offline" : syncStatus === "syncing" ? "syncing" : syncStatus === "synced" ? "synced" : "connecting")}</span>
    </div>
    {!review ? (
      <div className="batchTriageControls">
        <label>{tr("batchAction")}
          <select aria-label={tr("batchAction")} value={action} disabled={busy}
            onChange={e => setAction(e.target.value as BatchDecision)}>
            <option value="today">{tr("triageToday")}</option>
            <option value="tomorrow">{tr("triageTomorrow")}</option>
            <option value="someday">{tr("triageSomeday")}</option>
            <option value="waiting">{tr("triageWaiting")}</option>
            <option value="organize">{tr("triageOrganizeTitle")}</option>
          </select>
        </label>
        {action === "organize" && <div className="batchTriageDestinations">
          <label>{tr("triageProject")}
            <select aria-label={tr("triageProject")} value={projectId}
              disabled={busy || !projectChoices.length} onChange={e => setProjectId(e.target.value)}>
              <option value="">{tr("triageChooseProject")}</option>
              {projectChoices.map(p => <option value={p.id} key={p.id}>{p.title}</option>)}
            </select>
          </label>
          <label>{tr("triageArea")}
            <select aria-label={tr("triageArea")} value={areaId}
              disabled={busy || !areaChoices.length} onChange={e => setAreaId(e.target.value)}>
              <option value="">{tr("triageChooseArea")}</option>
              {areaChoices.map(a => <option value={a.id} key={a.id}>{a.title}</option>)}
            </select>
          </label>
        </div>}
        <button type="button" className="batchReview" disabled={!readyToReview || busy}
          onClick={prepare}>{tr("batchReview")}</button>
      </div>
    ) : <div className="batchTriageReview" role="group" aria-label={tr("batchReviewTitle")}>
      <h3>{tr("batchReviewTitle")}</h3>
      <p>{tr("batchReviewScope")}: <strong>{app.workspaceName}</strong></p>
      <p>{tr("batchReviewImpact").replace("{count}", String(review.selection.length))} — <strong>{review.summary}</strong></p>
      <ul>{review.selection.map(item =>
        <li key={item.id}><span>{item.title || tr("untitledItem")}</span>
          <small>{tr("Inbox")} → {review.summary}</small></li>)}</ul>
      <p className="batchTriageHint">{tr("batchAtomicNotice")}</p>
      <div className="batchTriageConfirm">
        <button type="button" onClick={() => setReview(null)} disabled={busy}>{tr("cancel")}</button>
        <button type="button" className="batchApply" onClick={() => void apply()} disabled={busy}>
          {busy ? tr("syncing") : tr("batchConfirm")}
        </button>
      </div>
    </div>}
    {error && <p role="alert" className="batchTriageError">{error}</p>}
  </section>;
}
