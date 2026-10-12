"use client";
import { type ContextClaimItem, type ContextInboxProposal, type ContextInboxTaskDraft } from "../types";
import type { LumiApp } from "../use-lumi-app";

export function ContextView({ app }: { app: LumiApp }) {
  const {
    approveContextInbox,
    calendarWorkspaceSelection,
    claimBusyIds,
    claimEvidence,
    claimFilterId,
    claimFreshness,
    claimHistory,
    claimPredicate,
    claimSensitivity,
    claimSourceLocator,
    claimSourceProvider,
    claimStatus,
    claimSubjectId,
    claimTargetId,
    claimValidFrom,
    claimValidTo,
    claimValue,
    claimValueMode,
    claimValueType,
    contextClaimAction,
    contextClaims,
    contextHistory,
    contextHistoryAction,
    contextInboxBusy,
    contextInboxProposals,
    contextInboxReason,
    contextInboxStatus,
    contextInboxTasks,
    contextInboxText,
    contextPredicateLabel,
    contextStepText,
    contextSubjectTypeLabel,
    createSuggestedTarget,
    editContextClaim,
    editingClaim,
    historyBusy,
    historyOffer,
    historySkip,
    historyStatus,
    items,
    language,
    newSubjectTitle,
    newSubjectType,
    openCapture,
    previewContextInbox,
    reloadContextClaims,
    resetClaimDraft,
    saveContextClaim,
    setClaimEvidence,
    setClaimFilterId,
    setClaimFreshness,
    setClaimPredicate,
    setClaimSensitivity,
    setClaimSourceLocator,
    setClaimSourceProvider,
    setClaimSubjectId,
    setClaimTargetId,
    setClaimValidFrom,
    setClaimValidTo,
    setClaimValue,
    setClaimValueMode,
    setClaimValueType,
    setContextInboxProposals,
    setContextInboxStatus,
    setContextInboxTasks,
    setContextInboxText,
    setDraft,
    setNewSubjectTitle,
    setNewSubjectType,
    setSubjectEditId,
    setSubjectEditTitle,
    setSubjectSearch,
    showClaimHistory,
    showSubjectHistory,
    standaloneSubjects,
    subjectAction,
    subjectBusy,
    subjectEditId,
    subjectEditTitle,
    subjectHistory,
    subjectSearch,
    subjectStatus,
    taskDraftCaptureText,
    tr,
    view,
  } = app;
  const providerLabel = (provider: string) => {
    const key = `sourceProvider_${provider.replace(/[^A-Za-z0-9]+/g, "_")}`;
    const label = tr(key);
    return label === key ? provider : label;
  };
  const stepLabel = (step: NonNullable<typeof contextHistory.undo>) => {
    const text = contextStepText(step);
    return <>{text.action} <span data-user-content>{text.target}</span></>;
  };
  // Offered right after a saved edit, next to its confirmation: the concrete step and the same Undo as the bar.
  const undoOffer = (area: "claim" | "subject" | "inbox", status: string) => historyOffer === area && status && contextHistory.undo
    ? <button type="button" className="contextUndoOffer" disabled={historyBusy} onClick={() => contextHistoryAction("undo")}>{tr("contextUndo")}: {stepLabel(contextHistory.undo)}</button> : null;
  return (
    <>
          {view === "Context" && (
            <div className="contextWorkspace">
              <section className="contextOverview">
                <div className="sectionHeading">
                  <div>
                    <p className="eyebrow">{tr("contextEyebrow")}</p>
                    <h2>{tr("whatLumiKnows")}</h2>
                    <p>{tr("ownerControlledClaimsFor")}</p>
                  </div>
                  <div className="contextHeaderActions"><button onClick={reloadContextClaims}>{tr("reloadClaims")}</button><button className="primaryAction" onClick={resetClaimDraft}>{tr("newClaim")}</button></div>
                </div>
                <div className="contextHistoryBar" role="group" aria-label={tr("contextHistoryBar")}>
                  <button type="button" disabled={!contextHistory.undo || historyBusy} aria-keyshortcuts="Control+Z Meta+Z" onClick={() => contextHistoryAction("undo")}>
                    <strong>{tr("contextUndo")}</strong>{" "}<span>{contextHistory.undo ? stepLabel(contextHistory.undo) : tr("contextNothingToUndo")}</span>
                  </button>
                  <button type="button" disabled={!contextHistory.redo || historyBusy} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onClick={() => contextHistoryAction("redo")}>
                    <strong>{tr("contextRedo")}</strong>{" "}<span>{contextHistory.redo ? stepLabel(contextHistory.redo) : tr("contextNothingToRedo")}</span>
                  </button>
                  {historyStatus && <p role="status" className="contextHistoryStatus">{historyStatus}</p>}
                  {historySkip && <div className="contextHistorySkip"><p>{tr("contextSkipExplain")}</p><button type="button" disabled={historyBusy} onClick={() => contextHistoryAction("skip")}>{tr("contextSkipStep")}</button></div>}
                </div>
                <div className="contextStats">
                  <span><strong>{contextClaims.length}</strong>{tr("claims")}</span>
                  <span><strong>{contextClaims.filter((claim) => claim.reviewStatus === "proposed").length}</strong>{tr("toReview")}</span>
                  <span><strong>{contextClaims.filter((claim) => claim.eligibleForAI).length}</strong>{tr("forLumi")}</span>
                </div>
              </section>

              <section className="contextPeople" aria-labelledby="context-people-title">
                <div className="sectionHeading"><div><h2 id="context-people-title">{tr("peopleAndOrganizations")}</h2><p>{tr("peopleAndOrganizationsAre2")}</p></div></div>
                <div className="contextPeopleForm">
                  <label>{tr("type")}<select value={newSubjectType} onChange={(event) => setNewSubjectType(event.target.value as "person" | "organization")}><option value="person">{tr("person")}</option><option value="organization">{tr("organization")}</option></select></label>
                  <label>{tr("name")}<input value={newSubjectTitle} maxLength={200} onChange={(event) => setNewSubjectTitle(event.target.value)} /></label>
                  <button className="primaryAction" disabled={subjectBusy || !newSubjectTitle.trim()} onClick={() => subjectAction("create")}>{tr("add")}</button>
                </div>
                <label className="contextPeopleSearch">{tr("searchPeopleOrganizationsAnd")}<input value={subjectSearch} onChange={(event) => setSubjectSearch(event.target.value)} /></label>
                {subjectStatus && <p role="status">{subjectStatus}</p>}
                {undoOffer("subject", subjectStatus)}
                <div className="contextPeopleList">{standaloneSubjects.filter((subject) => !subjectSearch.trim() || subject.title.toLocaleLowerCase("cs-CZ").includes(subjectSearch.toLocaleLowerCase("cs-CZ")) || contextClaims.some((claim) => (claim.subject.id === subject.id || claim.target?.id === subject.id) && `${claim.predicate} ${claim.subject.title} ${claim.target?.title || ""} ${String(claim.literal?.value || "")}`.toLocaleLowerCase("cs-CZ").includes(subjectSearch.toLocaleLowerCase("cs-CZ")))).map((subject) => <article key={subject.id}>
                  {subjectEditId === subject.id ? <div className="contextPeopleForm">
                    <input aria-label={tr("editName")} value={subjectEditTitle} maxLength={200} onChange={(event) => setSubjectEditTitle(event.target.value)} />
                    <button disabled={subjectBusy || !subjectEditTitle.trim()} onClick={() => subjectAction("rename", subject)}>{tr("save")}</button>
                    <button onClick={() => setSubjectEditId("")}>{tr("cancel")}</button>
                  </div> : <>
                    <strong>{subject.title}</strong>
                    <small>{subject.type === "person" ? (tr("person")) : (tr("organization"))}{subject.archivedAt ? ` · ${tr("archived")}` : ""}</small>
                    <div className="contextClaimActions">
                      <button onClick={() => setClaimFilterId(subject.id)}>{tr("relationshipsAndCommitments")} ({contextClaims.filter((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)).length})</button>
                      {!subject.archivedAt && <button onClick={() => { setSubjectEditId(subject.id); setSubjectEditTitle(subject.title); }}>{tr("rename")}</button>}
                      <button onClick={() => showSubjectHistory(subject)}>{tr("history")}</button>
                      {!subject.archivedAt && <button className="textAction danger" disabled={subjectBusy} onClick={() => subjectAction("archive", subject)}>{tr("archive")}</button>}
                    </div>
                    {subjectHistory[subject.id] && <ol className="contextSubjectHistory">{subjectHistory[subject.id].map((event, index) => <li key={`${event.createdAt}:${index}`}>{event.kind && event.kind !== "change" ? `${tr(`historyEvent_${event.kind}`)}: ${tr(`historyStep_${event.operation.replace(".", "_")}_${subject.type}`)}` : contextPredicateLabel(event.operation.replace("subject.", ""))}{event.beforeTitle && event.afterTitle && event.beforeTitle !== event.afterTitle ? `: ${event.beforeTitle} → ${event.afterTitle}` : event.afterTitle ? `: ${event.afterTitle}` : ""} · rev. {event.afterRevision} · {new Date(event.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</li>)}</ol>}
                    <details className="contextPersonKnowledge"><summary>{tr("whatLumiKnows")}</summary>
                      {contextClaims.filter((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)).map((claim) => <p key={claim.id}>{claim.subject.title} · {contextPredicateLabel(claim.predicate)} → {String(claim.literal?.value ?? claim.target?.title ?? "—")} <small>({claim.reviewStatus === "confirmed" ? (tr("confirmedClaim")) : claim.reviewStatus === "proposed" ? (tr("toReview2")) : (tr("rejected"))})</small></p>)}
                      {!contextClaims.some((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)) && <p>{tr("noClaimsYet")}</p>}
                    </details>
                  </>}
                </article>)}</div>
              </section>

              <section className="contextInbox" aria-labelledby="context-inbox-title">
                <div className="sectionHeading"><div><h2 id="context-inbox-title">{tr("contextInbox")}</h2><p>{tr("pasteAMeetingEmail")}</p></div></div>
                <label className="contextInboxInput">{tr("summaryOrNotes")}<textarea value={contextInboxText} maxLength={20000} onChange={(event) => setContextInboxText(event.target.value)} placeholder={tr("eGProjectLumi")} /></label>
                <div className="contextInboxActions"><button className="primaryAction" disabled={Boolean(contextInboxBusy) || !contextInboxText.trim()} onClick={previewContextInbox}>{contextInboxBusy === "preview" ? (tr("analysing")) : (tr("preparePreview"))}</button><button disabled={Boolean(contextInboxBusy) || (!contextInboxProposals.length && !contextInboxTasks.length)} onClick={() => { setContextInboxProposals([]); setContextInboxTasks([]); setContextInboxStatus(tr("previewDiscarded")); }}>{tr("discardAll")}</button></div>
                {contextInboxStatus && <p role="status">{contextInboxStatus}</p>}
                {undoOffer("inbox", contextInboxStatus)}
                <div className="contextInboxList">
                  {contextInboxProposals.map((proposal) => <article key={proposal.id} className="contextInboxProposal">
                    <header><strong>{proposal.subject.title}</strong><small>{contextInboxReason(proposal.reason)}</small></header>
                    <label>{tr("assignTo")}<select value={proposal.subject.entityId} onChange={(event) => { const subject = items.find((item) => item.id === event.target.value && item.workspaceId === calendarWorkspaceSelection.current); if (subject) setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, subject: { entityId: subject.id, type: subject.type, title: subject.title } } : item)); }}>{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && ["workspace", "area", "project", "task", "note"].includes(item.type)).map((item) => <option key={item.id} value={item.id}>{tr(item.type)}: {item.title}</option>)}</select></label>
                    <div className="preferenceGrid"><label>{tr("predicate")}<input value={proposal.predicate} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, predicate: event.target.value } : item))} /></label>{!proposal.suggestedTarget && <label>{tr("value")}<input type={proposal.literal.type === "date" ? "date" : proposal.literal.type === "number" ? "number" : "text"} value={String(proposal.literal.value)} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, literal: { ...item.literal, value: item.literal.type === "number" ? Number(event.target.value) : event.target.value } } : item))} /></label>}</div>
                    {proposal.suggestedTarget && <div className="contextTargetChoice">
                      <p>{tr("contextSuggestedPerson").replace("{title}", () => proposal.suggestedTarget.title)}</p>
                      <label>{tr("personForRelationship")}<select value={proposal.selectedTargetId || ""} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, selectedTargetId: event.target.value } : item))}><option value="">{tr("selectAPerson")}</option>{standaloneSubjects.filter((subject) => subject.type === "person" && !subject.archivedAt).map((subject) => <option key={subject.id} value={subject.id}>{subject.title}{proposal.suggestedTarget?.matches.some((match) => match.id === subject.id) ? (tr("possibleMatch")) : ""}</option>)}</select></label>
                      <button disabled={Boolean(contextInboxBusy)} onClick={() => createSuggestedTarget(proposal)}>{tr("contextCreateExplicitly").replace("{title}", () => proposal.suggestedTarget.title)}</button>
                    </div>}
                    <div className="preferenceGrid"><label>{tr("freshness")}<select value={proposal.freshness} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, freshness: event.target.value as ContextInboxProposal["freshness"] } : item))}><option value="current">{tr("current")}</option><option value="needs_review">{tr("needsReview")}</option><option value="stale">{tr("stale")}</option></select></label><label>{tr("validTo")}<input type="date" value={proposal.validTo || ""} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, validTo: event.target.value || null } : item))} /></label></div><small>{tr("theProposalIsSaved")}</small>
                    <blockquote>{proposal.evidenceExcerpt}</blockquote><div className="contextClaimActions"><button className="primaryAction" disabled={Boolean(contextInboxBusy) || !proposal.predicate.trim() || (proposal.suggestedTarget ? !proposal.selectedTargetId : String(proposal.literal.value) === "")} onClick={() => approveContextInbox(proposal)}>{tr("saveForReview")}</button><button disabled={Boolean(contextInboxBusy)} onClick={() => setContextInboxProposals((current) => current.filter((item) => item.id !== proposal.id))}>{tr("reject")}</button></div>
                  </article>)}
                  {contextInboxTasks.map((task) => <article key={task.id} className="contextInboxProposal taskDraft"><header><strong>{tr("taskDraft")}</strong><small>{contextInboxReason(task.reason)}</small></header><label>{tr("title")}<input value={task.title} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, title: event.target.value } : item))} /></label><div className="preferenceGrid"><label>{tr("suggestedDate")}<input type="date" value={task.suggestedDate || ""} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, suggestedDate: event.target.value || null } : item))} /></label><label>{tr("suggestedPriority")}<select value={task.suggestedPriority} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, suggestedPriority: event.target.value as ContextInboxTaskDraft["suggestedPriority"] } : item))}>{(["none", "low", "medium", "high"] as const).map((priority) => <option key={priority} value={priority}>{tr(priority)}</option>)}</select></label></div><div className="contextClaimActions"><button disabled={!task.title.trim()} onClick={() => { openCapture("task", task.subject.type === "project" ? task.subject.entityId : ""); setDraft(taskDraftCaptureText(task)); setContextInboxTasks((current) => current.filter((item) => item.id !== task.id)); }}>{tr("reviewInQuickCapture")}</button><button onClick={() => setContextInboxTasks((current) => current.filter((item) => item.id !== task.id))}>{tr("reject")}</button></div></article>)}
                </div>
              </section>

              <section className="contextClaimEditor" id="context-claim-editor">
                <div className="sectionHeading"><div><h2>{editingClaim ? (tr("editClaim")) : (tr("addClaim"))}</h2><p>{tr("leaveSourceEmptyWhen")}</p></div></div>
                <div className="contextClaimForm">
                  <label>{tr("subject")}<select value={claimSubjectId} disabled={Boolean(editingClaim)} onChange={(event) => setClaimSubjectId(event.target.value)}><option value="">—</option>{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && (item.type === "workspace" || item.type === "project" || item.type === "task")).map((item) => <option key={item.id} value={item.id}>{item.type === "project" ? `${tr("project")}: ` : ""}{item.title}</option>)}{standaloneSubjects.filter((subject) => !subject.archivedAt).map((subject) => <option key={subject.id} value={subject.id}>{subject.type === "person" ? (tr("person")) : (tr("organization"))}: {subject.title}</option>)}</select></label>
                  <label>{tr("relationshipOrProperty")}<input value={claimPredicate} maxLength={120} pattern="[a-z][a-z0-9_.-]*" list="context-predicates" onChange={(event) => setClaimPredicate(event.target.value)} placeholder="preference" /><datalist id="context-predicates">{["waiting_for", "responsible_for", "works_for", "participates_in", "assigned_to", "blocked_by", "related_to", "importance", "preference"].map((predicate) => <option key={predicate} value={predicate} label={contextPredicateLabel(predicate)} />)}</datalist></label>
                  <label>{tr("claimValue")}<select value={claimValueMode} onChange={(event) => setClaimValueMode(event.target.value as "literal" | "target")}><option value="literal">{tr("textNumberDate")}</option><option value="target">{tr("linkToAPerson")}</option></select></label>
                  {claimValueMode === "target" && <label>{tr("target")}<select value={claimTargetId} onChange={(event) => setClaimTargetId(event.target.value)}><option value="">—</option>{standaloneSubjects.filter((subject) => !subject.archivedAt && subject.id !== claimSubjectId).map((subject) => <option key={subject.id} value={subject.id}>{subject.title}</option>)}{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && ["project", "task", "area"].includes(item.type) && item.id !== claimSubjectId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
                  {claimValueMode === "literal" && <>
                  <div className="preferenceGrid">
                    <label>{tr("valueType")}<select value={claimValueType} onChange={(event) => setClaimValueType(event.target.value as typeof claimValueType)}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">Date</option></select></label>
                    <label>{tr("value")}{claimValueType === "boolean" ? <select value={claimValue} onChange={(event) => setClaimValue(event.target.value)}><option value="">—</option><option value="true">true</option><option value="false">false</option></select> : <input type={claimValueType === "number" ? "number" : claimValueType === "date" ? "date" : "text"} value={claimValue} maxLength={10000} onChange={(event) => setClaimValue(event.target.value)} />}</label>
                  </div>
                  </>}
                  <div className="preferenceGrid">
                    <label>{tr("freshness")}<select value={claimFreshness} onChange={(event) => setClaimFreshness(event.target.value as ContextClaimItem["freshness"])}><option value="current">{tr("current")}</option><option value="needs_review">{tr("needsReview")}</option><option value="stale">{tr("stale")}</option></select></label>
                    <label>{tr("sensitivity")}<select value={claimSensitivity} onChange={(event) => setClaimSensitivity(event.target.value as ContextClaimItem["sensitivity"])}><option value="normal">{tr("normal")}</option><option value="confidential">{tr("confidential")}</option><option value="restricted">{tr("restricted")}</option></select></label>
                  </div>
                  <div className="preferenceGrid"><label>{tr("validFromOptional")}<input type="date" value={claimValidFrom} onChange={(event) => setClaimValidFrom(event.target.value)} /></label><label>{tr("validToOptional")}<input type="date" value={claimValidTo} onChange={(event) => setClaimValidTo(event.target.value)} /></label></div>
                  <details><summary>{tr("sourceAndEvidenceOptional")}</summary><div className="preferenceGrid"><label>{tr("sourceProvider")}<input value={claimSourceProvider} maxLength={80} onChange={(event) => setClaimSourceProvider(event.target.value)} /></label><label>{tr("urlLocator")}<input value={claimSourceLocator} maxLength={2000} onChange={(event) => setClaimSourceLocator(event.target.value)} /></label></div><label>{tr("evidenceExcerpt")}<textarea value={claimEvidence} maxLength={2000} onChange={(event) => setClaimEvidence(event.target.value)} /></label></details>
                  <div className="notificationActions"><button className="primaryAction" disabled={claimBusyIds.includes(editingClaim?.id || `new:${calendarWorkspaceSelection.current}`) || !claimSubjectId || !claimPredicate.trim() || (claimValueMode === "target" ? !claimTargetId : claimValue === "" || (claimValueType === "number" && !Number.isFinite(Number(claimValue))))} onClick={saveContextClaim}>{claimBusyIds.includes(editingClaim?.id || `new:${calendarWorkspaceSelection.current}`) ? (tr("saving")) : tr("save")}</button>{editingClaim && <button onClick={resetClaimDraft}>{tr("cancel")}</button>}</div>
                  {claimStatus && <p className={claimStatus.toLowerCase().includes("konflikt") || claimStatus.toLowerCase().includes("conflict") ? "contextConflict" : "saveConfirmation"} role="status">{claimStatus}</p>}
                  {undoOffer("claim", claimStatus)}
                </div>
              </section>

              <section className="contextReviewQueue">
                <div className="sectionHeading"><div><h2>{tr("claimsAndReview")}</h2><p>{tr("confirmationAppliesOnlyTo")}</p></div><label>{tr("show")}<select value={claimFilterId} onChange={(event) => setClaimFilterId(event.target.value)}><option value="all">{tr("wholeWorkspace")}</option><option value="review">{tr("reviewQueue")}</option>{items.filter((item) => item.type === "project" && item.workspaceId === calendarWorkspaceSelection.current).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}{standaloneSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.title}</option>)}</select></label></div>
                <div className="contextClaimList">
                  {[...contextClaims].filter((claim) => claimFilterId === "all" || (claimFilterId === "review" ? claim.reviewStatus === "proposed" : claim.subject.canonicalEntityId === claimFilterId || claim.subject.id === claimFilterId || claim.target?.id === claimFilterId || claim.target?.canonicalEntityId === claimFilterId)).sort((a, b) => Number(a.reviewStatus !== "proposed") - Number(b.reviewStatus !== "proposed") || b.updatedAt - a.updatedAt).map((claim) => <article key={claim.id} className={`contextClaimCard ${claim.reviewStatus} ${claim.freshness}`}>
                    <header><div><strong>{claim.subject.title}</strong><small>{contextSubjectTypeLabel(claim.subject.type)} · rev. {claim.revision}</small></div><span className={`claimState ${claim.reviewStatus}`}>{claim.reviewStatus === "proposed" ? (tr("proposed")) : claim.reviewStatus === "confirmed" ? (tr("confirmed")) : (tr("rejected2"))}</span></header>
                    <p><b>{contextPredicateLabel(claim.predicate)}</b> → {String(claim.literal?.value ?? claim.target?.title ?? "—")}{claim.target?.archivedAt ? (tr("archived2")) : ""}</p>
                    <div className="claimMeta"><span>{claim.freshness === "current" ? (tr("current2")) : claim.freshness === "needs_review" ? (tr("needsReview2")) : (tr("stale2"))}</span><span>{claim.sensitivity === "restricted" ? tr("restricted2") : claim.sensitivity === "confidential" ? tr("confidential2") : tr("normal2")}</span><span className={claim.source ? "hasSource" : "missingSource"}>{claim.source ? (claim.source.provider ? providerLabel(claim.source.provider) : claim.source.locator || (tr("sourceAvailable"))) : (tr("missingSourceOwnerStatement"))}</span></div>
                    {claim.evidence?.excerpt && <blockquote>{claim.evidence.excerpt}</blockquote>}
                    {claimHistory[claim.id] && <ol className="contextSubjectHistory">{claimHistory[claim.id].map((event, index) => <li key={`${event.createdAt}:${index}`}>{event.kind && event.kind !== "change" ? `${tr(`historyEvent_${event.kind}`)}: ${event.operation === "review" ? tr(`historyStepReview_${event.reviewStatus || "proposed"}`) : tr(`historyStep_${event.operation}`)}` : event.operation === "review" && event.decision ? tr(`claimReview_${event.decision}`) : contextPredicateLabel(event.operation)} · rev. {event.afterRevision} · {new Date(event.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</li>)}</ol>}
                    <div className="contextClaimActions">{claim.reviewStatus !== "confirmed" && <button className="primaryAction" disabled={claimBusyIds.includes(claim.id)} onClick={() => contextClaimAction(claim, "review", "confirmed")}>{tr("confirm")}</button>}{claim.reviewStatus !== "rejected" && <button disabled={claimBusyIds.includes(claim.id)} onClick={() => contextClaimAction(claim, "review", "rejected")}>{tr("reject")}</button>}{claim.reviewStatus !== "proposed" && <button disabled={claimBusyIds.includes(claim.id)} onClick={() => contextClaimAction(claim, "review", "proposed")}>{tr("returnToReview")}</button>}<button onClick={() => editContextClaim(claim)}>{tr("edit")}</button><button onClick={() => showClaimHistory(claim)}>{tr("history")}</button><button className="textAction danger" disabled={claimBusyIds.includes(claim.id)} onClick={() => contextClaimAction(claim, "archive")}>{tr("archive")}</button></div>
                  </article>)}
                  {!contextClaims.some((claim) => claimFilterId === "all" || (claimFilterId === "review" ? claim.reviewStatus === "proposed" : claim.subject.canonicalEntityId === claimFilterId || claim.subject.id === claimFilterId || claim.target?.id === claimFilterId || claim.target?.canonicalEntityId === claimFilterId)) && <p>{tr("noStructuredClaimsIn")}</p>}
                </div>
              </section>
            </div>
          )}
    </>
  );
}
