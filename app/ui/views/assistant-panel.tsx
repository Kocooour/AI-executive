"use client";
import { useEffect, useRef, useState } from "react";
import type { LumiApp } from "../use-lumi-app";
import type { AIProposal } from "../types";

function ProposalImpact({ proposal, tr }: { proposal: AIProposal; tr: (key: string) => string }) {
  const reviewFields = proposal.review?.fields || proposal.changes.map((item) => ({ label: item.label, before: "—", after: item.value }));
  const fieldLabel = (label: string) => {
    if (label === "Inbox") return tr("approvalFlagInbox");
    if (label === "Today") return tr("approvalFlagToday");
    if (label === "Someday") return tr("approvalFlagSomeday");
    return label;
  };
  const fieldValue = (value: string) => value === "true" ? tr("approvalYes") : value === "false" ? tr("approvalNo") : value;
  return <div className="proposalImpact">
    <div className="proposalCritical">
      <p><b>{tr("approvalTarget")}</b><span>{proposal.review?.target || proposal.summary}</span></p>
      <p><b>{tr("workspace")}</b><span>{proposal.review?.workspace || proposal.changes.find((item) => item.label === "Workspace")?.value || "—"}</span></p>
      <div className="proposalBeforeAfter">
        <b>{tr("approvalBeforeAfter")}</b>
        {reviewFields.length ? reviewFields.map((field) =>
          <p key={field.label}><span>{fieldLabel(field.label)}</span><span>{fieldValue(field.before)} → {fieldValue(field.after)}</span></p>)
          : <p><span>—</span><span>{tr("approvalNoFieldChanges")}</span></p>}
      </div>
      <p><b>{tr("approvalRelated")}</b><span>{proposal.review?.related.length ? proposal.review.related.join(", ") : tr("approvalNone")}</span></p>
      <div className="proposalSideEffects"><b>{tr("approvalSideEffects")}</b><ul>{proposal.review?.sideEffects.length ? proposal.review.sideEffects.map((effect) => <li key={effect}>{tr(effect)}</li>) : <li>{tr("approvalLocalOnly")}</li>}</ul></div>
    </div>
    <details className="proposalMore">
      <summary>{tr("approvalMoreImpact")}</summary>
      <ul>
        <li>{tr("approvalRevisionCheck")}</li>
      </ul>
    </details>
  </div>;
}

export function AssistantPanel({ app }: { app: LumiApp }) {
  const {
    aiBusy,
    aiText,
    askAI,
    assistantOpen,
    context,
    messages,
    resolveAIProposal,
    setAiText,
    setAssistantOpen,
    tr,
    undoAIAction,
    writeWorkspaceId,
    workspaceName,
  } = app;
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const review = messages.find((message) => message.proposal?.id === reviewId);
  const proposal = review?.proposal;
  const closeRef = useRef<HTMLButtonElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!assistantOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [assistantOpen]);
  useEffect(() => {
    if (!reviewId) return;
    closeRef.current?.focus();
    return () => { if (reviewTriggerRef.current?.isConnected) reviewTriggerRef.current.focus(); };
  }, [reviewId]);
  useEffect(() => { if (!assistantOpen || review?.resolved) setReviewId(null); }, [assistantOpen, review?.resolved]);
  useEffect(() => {
    if (!reviewId) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setReviewId(null);
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".mobileApprovalSheet");
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), summary, a[href]") || []);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [reviewId]);
  const unavailable = proposal ? review?.blocked || (now >= proposal.expiresAt ? tr("approvalExpired") : proposal.workspaceId !== writeWorkspaceId ? tr("approvalWorkspaceChanged") : "") : "";
  return (
    <>
      {assistantOpen && (
        <div className="assistantPanel">
          <div className="assistantHead">
            <b>{tr("assistant")}</b>
            <button aria-label={tr("close")} onClick={() => setAssistantOpen(false)}>×</button>
          </div>
          <div className="assistantContext">
            {context
              ? tr("assistantContextFocus").replace("{workspace}", workspaceName).replace("{focus}", context.focus.title)
              : tr("assistantContextServer").replace("{workspace}", workspaceName)}
          </div>
          <div className="assistantMessages">
            {messages.length === 0 && (
              <div className="assistantWelcome">
                <p>{tr("assistantWelcome")}</p>
                <button onClick={() => askAI(tr("todayBriefPrompt"))} disabled={aiBusy}>
                  {tr("todayBrief")}
                </button>
                <small>{tr("assistantWritesConfirm")}</small>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={"assistantTurn " + m.role}>
                <div className={"msg " + m.role}>{m.content}</div>
                {m.proposal && (
                  <div className={`aiProposal ${m.resolved ? "resolved" : ""}`}>
                    <strong>{m.proposal.summary}</strong>
                    <div className="desktopProposalImpact"><ProposalImpact proposal={m.proposal} tr={tr} /></div>
                    {m.blocked && <p className="proposalConflict" role="alert">{m.blocked}</p>}
                    {!m.resolved && (
                      <>
                        <button className="mobileProposalReview" onClick={(event) => { reviewTriggerRef.current = event.currentTarget; setReviewId(m.proposal!.id); }}>{tr("approvalReview")}</button>
                        <div className="aiProposalActions">
                          <button className="primaryAction" disabled={aiBusy || Boolean(m.blocked) || now >= m.proposal.expiresAt || m.proposal.workspaceId !== writeWorkspaceId} onClick={() => resolveAIProposal(m.proposal!.id, "confirm")}>{tr("confirm")}</button>
                          <button disabled={aiBusy} onClick={() => resolveAIProposal(m.proposal!.id, "cancel")}>{tr("reject")}</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {m.actionId && !m.resolved && (
                  <button className="aiUndo" disabled={aiBusy} onClick={() => undoAIAction(m.actionId!)}>
                    {tr("undoAi")}
                  </button>
                )}
              </div>
            ))}
            {aiBusy && <p className="assistantThinking">{tr("working")}</p>}
          </div>
          <div className="assistantComposer">
            <input
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") askAI();
              }}
              placeholder={`${tr("askAi")}…`}
              disabled={aiBusy}
            />
            <button onClick={() => askAI()} disabled={aiBusy || !aiText.trim()}>{tr("send")}</button>
          </div>
          {proposal && review && !review.resolved && <div className="mobileApprovalBackdrop" onClick={() => setReviewId(null)}>
            <section className="mobileApprovalSheet" role="dialog" aria-modal="true" aria-label={tr("approvalReview")} onClick={(event) => event.stopPropagation()}>
              <header><h2>{tr("approvalReview")}</h2><button ref={closeRef} aria-label={tr("close")} onClick={() => setReviewId(null)}>×</button></header>
              <div className="mobileApprovalBody">
                <strong>{proposal.summary}</strong>
                <ProposalImpact proposal={proposal} tr={tr} />
                {unavailable && <p className="proposalConflict" role="alert">{unavailable} {tr("approvalAskAgain")}</p>}
              </div>
              <div className="mobileApprovalActions">
                <button className="primaryAction" disabled={aiBusy || Boolean(unavailable)} onClick={() => resolveAIProposal(proposal.id, "confirm")}>{tr("approvalApprove")}</button>
                <button disabled={aiBusy} onClick={() => resolveAIProposal(proposal.id, "cancel")}>{tr("reject")}</button>
              </div>
            </section>
          </div>}
        </div>
      )}
    </>
  );
}
