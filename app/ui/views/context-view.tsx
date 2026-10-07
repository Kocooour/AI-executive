"use client";
import { type ContextClaimItem, type ContextInboxProposal, type ContextInboxTaskDraft } from "../types";
import type { LumiApp } from "../use-lumi-app";

export function ContextView({ app }: { app: LumiApp }) {
  const {
    approveContextInbox,
    calendarWorkspaceSelection,
    claimBusyId,
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
    contextInboxBusy,
    contextInboxProposals,
    contextInboxReason,
    contextInboxStatus,
    contextInboxTasks,
    contextInboxText,
    contextPredicateLabel,
    contextSubjectTypeLabel,
    createSuggestedTarget,
    editContextClaim,
    editingClaim,
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
  return (
    <>
          {view === "Context" && (
            <div className="contextWorkspace">
              <section className="contextOverview">
                <div className="sectionHeading">
                  <div>
                    <p className="eyebrow">LUMI · CONTEXT V2</p>
                    <h2>{language === "cs" ? "Co Lumi ví" : "What Lumi knows"}</h2>
                    <p>{language === "cs" ? "Vlastníkem řízená tvrzení pro tento workspace. Do AI se dostanou pouze potvrzená, aktuální a běžná tvrzení." : "Owner-controlled claims for this workspace. Only confirmed, current and normal claims may reach AI."}</p>
                  </div>
                  <div className="contextHeaderActions"><button onClick={reloadContextClaims} disabled={Boolean(claimBusyId)}>{language === "cs" ? "Obnovit tvrzení" : "Reload claims"}</button><button className="primaryAction" onClick={resetClaimDraft}>{language === "cs" ? "Nové tvrzení" : "New claim"}</button></div>
                </div>
                <div className="contextStats">
                  <span><strong>{contextClaims.length}</strong>{language === "cs" ? " tvrzení" : " claims"}</span>
                  <span><strong>{contextClaims.filter((claim) => claim.reviewStatus === "proposed").length}</strong>{language === "cs" ? " ke kontrole" : " to review"}</span>
                  <span><strong>{contextClaims.filter((claim) => claim.eligibleForAI).length}</strong>{language === "cs" ? " pro Lumi" : " for Lumi"}</span>
                </div>
              </section>

              <section className="contextPeople" aria-labelledby="context-people-title">
                <div className="sectionHeading"><div><h2 id="context-people-title">{language === "cs" ? "Lidé a organizace" : "People and organizations"}</h2><p>{language === "cs" ? "Osoby a organizace jsou samostatné položky kontextu. Jejich vztahy k úkolům a projektům potvrzujete po jednotlivých tvrzeních." : "People and organizations are separate context items. Confirm each relationship to a task or project as its own claim."}</p></div></div>
                <div className="contextPeopleForm">
                  <label>{language === "cs" ? "Typ" : "Type"}<select value={newSubjectType} onChange={(event) => setNewSubjectType(event.target.value as "person" | "organization")}><option value="person">{language === "cs" ? "Osoba" : "Person"}</option><option value="organization">{language === "cs" ? "Organizace" : "Organization"}</option></select></label>
                  <label>{language === "cs" ? "Jméno / název" : "Name"}<input value={newSubjectTitle} maxLength={200} onChange={(event) => setNewSubjectTitle(event.target.value)} /></label>
                  <button className="primaryAction" disabled={subjectBusy || !newSubjectTitle.trim()} onClick={() => subjectAction("create")}>{language === "cs" ? "Přidat" : "Add"}</button>
                </div>
                <label className="contextPeopleSearch">{language === "cs" ? "Hledat osoby, organizace a jejich závazky" : "Search people, organizations and their commitments"}<input value={subjectSearch} onChange={(event) => setSubjectSearch(event.target.value)} /></label>
                {subjectStatus && <p role="status">{subjectStatus}</p>}
                <div className="contextPeopleList">{standaloneSubjects.filter((subject) => !subjectSearch.trim() || subject.title.toLocaleLowerCase("cs-CZ").includes(subjectSearch.toLocaleLowerCase("cs-CZ")) || contextClaims.some((claim) => (claim.subject.id === subject.id || claim.target?.id === subject.id) && `${claim.predicate} ${claim.subject.title} ${claim.target?.title || ""} ${String(claim.literal?.value || "")}`.toLocaleLowerCase("cs-CZ").includes(subjectSearch.toLocaleLowerCase("cs-CZ")))).map((subject) => <article key={subject.id}>
                  {subjectEditId === subject.id ? <div className="contextPeopleForm">
                    <input aria-label={language === "cs" ? "Upravit jméno" : "Edit name"} value={subjectEditTitle} maxLength={200} onChange={(event) => setSubjectEditTitle(event.target.value)} />
                    <button disabled={subjectBusy || !subjectEditTitle.trim()} onClick={() => subjectAction("rename", subject)}>{language === "cs" ? "Uložit" : "Save"}</button>
                    <button onClick={() => setSubjectEditId("")}>{language === "cs" ? "Zrušit" : "Cancel"}</button>
                  </div> : <>
                    <strong>{subject.title}</strong>
                    <small>{subject.type === "person" ? (language === "cs" ? "Osoba" : "Person") : (language === "cs" ? "Organizace" : "Organization")}{subject.archivedAt ? ` · ${language === "cs" ? "archivováno" : "archived"}` : ""}</small>
                    <div className="contextClaimActions">
                      <button onClick={() => setClaimFilterId(subject.id)}>{language === "cs" ? "Vztahy a závazky" : "Relationships and commitments"} ({contextClaims.filter((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)).length})</button>
                      {!subject.archivedAt && <button onClick={() => { setSubjectEditId(subject.id); setSubjectEditTitle(subject.title); }}>{language === "cs" ? "Přejmenovat" : "Rename"}</button>}
                      <button onClick={() => showSubjectHistory(subject)}>{language === "cs" ? "Historie" : "History"}</button>
                      {!subject.archivedAt && <button className="textAction danger" disabled={subjectBusy} onClick={() => subjectAction("archive", subject)}>{language === "cs" ? "Archivovat" : "Archive"}</button>}
                    </div>
                    {subjectHistory[subject.id] && <ol className="contextSubjectHistory">{subjectHistory[subject.id].map((event, index) => <li key={`${event.createdAt}:${index}`}>{contextPredicateLabel(event.operation.replace("subject.", ""))}{event.beforeTitle && event.afterTitle && event.beforeTitle !== event.afterTitle ? `: ${event.beforeTitle} → ${event.afterTitle}` : event.afterTitle ? `: ${event.afterTitle}` : ""} · rev. {event.afterRevision} · {new Date(event.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</li>)}</ol>}
                    <details className="contextPersonKnowledge"><summary>{language === "cs" ? "Co Lumi ví" : "What Lumi knows"}</summary>
                      {contextClaims.filter((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)).map((claim) => <p key={claim.id}>{claim.subject.title} · {contextPredicateLabel(claim.predicate)} → {String(claim.literal?.value ?? claim.target?.title ?? "—")} <small>({claim.reviewStatus === "confirmed" ? (language === "cs" ? "potvrzené tvrzení" : "confirmed claim") : claim.reviewStatus === "proposed" ? (language === "cs" ? "ke kontrole" : "to review") : (language === "cs" ? "odmítnuto" : "rejected")})</small></p>)}
                      {!contextClaims.some((claim) => !claim.archivedAt && (claim.subject.id === subject.id || claim.target?.id === subject.id)) && <p>{language === "cs" ? "Zatím žádná tvrzení." : "No claims yet."}</p>}
                    </details>
                  </>}
                </article>)}</div>
              </section>

              <section className="contextInbox" aria-labelledby="context-inbox-title">
                <div className="sectionHeading"><div><h2 id="context-inbox-title">{language === "cs" ? "Kontextová schránka" : "Context Inbox"}</h2><p>{language === "cs" ? "Vložte shrnutí schůzky, e-mailu nebo Copilota. Lumi připraví pouze náhled; text neukládá a bez vašeho schválení nic nezmění." : "Paste a meeting, email or Copilot summary. Lumi creates a preview only; it does not store the text or change anything without approval."}</p></div></div>
                <label className="contextInboxInput">{language === "cs" ? "Shrnutí nebo poznámky" : "Summary or notes"}<textarea value={contextInboxText} maxLength={20000} onChange={(event) => setContextInboxText(event.target.value)} placeholder={language === "cs" ? "Např. Projekt Lumi – priorita: vysoká\nNa výsledek čeká Jana\nTermín: 2026-10-10" : "E.g. Project Lumi – priority: high\nJana is waiting for the result\nDeadline: 2026-10-10"} /></label>
                <div className="contextInboxActions"><button className="primaryAction" disabled={Boolean(contextInboxBusy) || !contextInboxText.trim()} onClick={previewContextInbox}>{contextInboxBusy === "preview" ? (language === "cs" ? "Analyzuji…" : "Analysing…") : (language === "cs" ? "Připravit náhled" : "Prepare preview")}</button><button disabled={Boolean(contextInboxBusy) || (!contextInboxProposals.length && !contextInboxTasks.length)} onClick={() => { setContextInboxProposals([]); setContextInboxTasks([]); setContextInboxStatus(language === "cs" ? "Náhled byl zahozen." : "Preview discarded."); }}>{language === "cs" ? "Zahodit vše" : "Discard all"}</button></div>
                {contextInboxStatus && <p role="status">{contextInboxStatus}</p>}
                <div className="contextInboxList">
                  {contextInboxProposals.map((proposal) => <article key={proposal.id} className="contextInboxProposal">
                    <header><strong>{proposal.subject.title}</strong><small>{contextInboxReason(proposal.reason)}</small></header>
                    <label>{language === "cs" ? "Přiřadit k" : "Assign to"}<select value={proposal.subject.entityId} onChange={(event) => { const subject = items.find((item) => item.id === event.target.value && item.workspaceId === calendarWorkspaceSelection.current); if (subject) setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, subject: { entityId: subject.id, type: subject.type, title: subject.title } } : item)); }}>{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && ["workspace", "area", "project", "task", "note"].includes(item.type)).map((item) => <option key={item.id} value={item.id}>{tr(item.type)}: {item.title}</option>)}</select></label>
                    <div className="preferenceGrid"><label>{language === "cs" ? "Vlastnost" : "Predicate"}<input value={proposal.predicate} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, predicate: event.target.value } : item))} /></label>{!proposal.suggestedTarget && <label>{language === "cs" ? "Hodnota" : "Value"}<input type={proposal.literal.type === "date" ? "date" : proposal.literal.type === "number" ? "number" : "text"} value={String(proposal.literal.value)} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, literal: { ...item.literal, value: item.literal.type === "number" ? Number(event.target.value) : event.target.value } } : item))} /></label>}</div>
                    {proposal.suggestedTarget && <div className="contextTargetChoice">
                      <p>{language === "cs" ? `Lumi rozpoznala možnou osobu „${proposal.suggestedTarget.title}“. Vyberte existující osobu nebo ji výslovně vytvořte.` : `Lumi found a possible person “${proposal.suggestedTarget.title}”. Select an existing person or explicitly create one.`}</p>
                      <label>{language === "cs" ? "Osoba pro vztah" : "Person for relationship"}<select value={proposal.selectedTargetId || ""} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, selectedTargetId: event.target.value } : item))}><option value="">{language === "cs" ? "Vyberte osobu" : "Select a person"}</option>{standaloneSubjects.filter((subject) => subject.type === "person" && !subject.archivedAt).map((subject) => <option key={subject.id} value={subject.id}>{subject.title}{proposal.suggestedTarget?.matches.some((match) => match.id === subject.id) ? (language === "cs" ? " · možná shoda" : " · possible match") : ""}</option>)}</select></label>
                      <button disabled={Boolean(contextInboxBusy)} onClick={() => createSuggestedTarget(proposal)}>{language === "cs" ? `Výslovně vytvořit: ${proposal.suggestedTarget.title}` : `Explicitly create: ${proposal.suggestedTarget.title}`}</button>
                    </div>}
                    <div className="preferenceGrid"><label>{language === "cs" ? "Aktuálnost" : "Freshness"}<select value={proposal.freshness} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, freshness: event.target.value as ContextInboxProposal["freshness"] } : item))}><option value="current">{language === "cs" ? "Aktuální" : "Current"}</option><option value="needs_review">{language === "cs" ? "Prověřit" : "Needs review"}</option><option value="stale">{language === "cs" ? "Zastaralé" : "Stale"}</option></select></label><label>{language === "cs" ? "Platí do" : "Valid to"}<input type="date" value={proposal.validTo || ""} onChange={(event) => setContextInboxProposals((current) => current.map((item) => item.id === proposal.id ? { ...item, validTo: event.target.value || null } : item))} /></label></div><small>{language === "cs" ? "Návrh se uloží jako chráněný. Zpřístupnění externí AI vyžaduje pozdější samostatnou úpravu a potvrzení tvrzení." : "The proposal is saved as protected. Making it available to external AI requires a separate later edit and claim confirmation."}</small>
                    <blockquote>{proposal.evidenceExcerpt}</blockquote><div className="contextClaimActions"><button className="primaryAction" disabled={Boolean(contextInboxBusy) || !proposal.predicate.trim() || (proposal.suggestedTarget ? !proposal.selectedTargetId : String(proposal.literal.value) === "")} onClick={() => approveContextInbox(proposal)}>{language === "cs" ? "Uložit ke kontrole" : "Save for review"}</button><button disabled={Boolean(contextInboxBusy)} onClick={() => setContextInboxProposals((current) => current.filter((item) => item.id !== proposal.id))}>{language === "cs" ? "Odmítnout" : "Reject"}</button></div>
                  </article>)}
                  {contextInboxTasks.map((task) => <article key={task.id} className="contextInboxProposal taskDraft"><header><strong>{language === "cs" ? "Návrh úkolu" : "Task draft"}</strong><small>{contextInboxReason(task.reason)}</small></header><label>{language === "cs" ? "Název" : "Title"}<input value={task.title} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, title: event.target.value } : item))} /></label><div className="preferenceGrid"><label>{language === "cs" ? "Navržený termín" : "Suggested date"}<input type="date" value={task.suggestedDate || ""} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, suggestedDate: event.target.value || null } : item))} /></label><label>{language === "cs" ? "Navržená priorita" : "Suggested priority"}<select value={task.suggestedPriority} onChange={(event) => setContextInboxTasks((current) => current.map((item) => item.id === task.id ? { ...item, suggestedPriority: event.target.value as ContextInboxTaskDraft["suggestedPriority"] } : item))}>{(["none", "low", "medium", "high"] as const).map((priority) => <option key={priority} value={priority}>{tr(priority)}</option>)}</select></label></div><div className="contextClaimActions"><button disabled={!task.title.trim()} onClick={() => { openCapture("task", task.subject.type === "project" ? task.subject.entityId : ""); setDraft(taskDraftCaptureText(task)); setContextInboxTasks((current) => current.filter((item) => item.id !== task.id)); }}>{language === "cs" ? "Zkontrolovat v rychlém zadání" : "Review in quick capture"}</button><button onClick={() => setContextInboxTasks((current) => current.filter((item) => item.id !== task.id))}>{language === "cs" ? "Odmítnout" : "Reject"}</button></div></article>)}
                </div>
              </section>

              <section className="contextClaimEditor" id="context-claim-editor">
                <div className="sectionHeading"><div><h2>{editingClaim ? (language === "cs" ? "Upravit tvrzení" : "Edit claim") : (language === "cs" ? "Přidat tvrzení" : "Add claim")}</h2><p>{language === "cs" ? "Zdroj nechte prázdný, pokud žádný nemáte. Lumi jej nebude domýšlet." : "Leave source empty when none exists. Lumi will not invent one."}</p></div></div>
                <div className="contextClaimForm">
                  <label>{language === "cs" ? "O kom / čem" : "Subject"}<select value={claimSubjectId} disabled={Boolean(editingClaim)} onChange={(event) => setClaimSubjectId(event.target.value)}><option value="">—</option>{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && (item.type === "workspace" || item.type === "project" || item.type === "task")).map((item) => <option key={item.id} value={item.id}>{item.type === "project" ? `${tr("project")}: ` : ""}{item.title}</option>)}{standaloneSubjects.filter((subject) => !subject.archivedAt).map((subject) => <option key={subject.id} value={subject.id}>{subject.type === "person" ? (language === "cs" ? "Osoba" : "Person") : (language === "cs" ? "Organizace" : "Organization")}: {subject.title}</option>)}</select></label>
                  <label>{language === "cs" ? "Vztah nebo vlastnost" : "Relationship or property"}<input value={claimPredicate} maxLength={120} pattern="[a-z][a-z0-9_.-]*" list="context-predicates" onChange={(event) => setClaimPredicate(event.target.value)} placeholder="preference" /><datalist id="context-predicates">{["waiting_for", "responsible_for", "works_for", "participates_in", "assigned_to", "blocked_by", "related_to", "importance", "preference"].map((predicate) => <option key={predicate} value={predicate} label={contextPredicateLabel(predicate)} />)}</datalist></label>
                  <label>{language === "cs" ? "Cíl tvrzení" : "Claim value"}<select value={claimValueMode} onChange={(event) => setClaimValueMode(event.target.value as "literal" | "target")}><option value="literal">{language === "cs" ? "Text / číslo / datum" : "Text / number / date"}</option><option value="target">{language === "cs" ? "Vztah k osobě, organizaci nebo položce" : "Link to a person, organization or item"}</option></select></label>
                  {claimValueMode === "target" && <label>{language === "cs" ? "S kým / čím" : "Target"}<select value={claimTargetId} onChange={(event) => setClaimTargetId(event.target.value)}><option value="">—</option>{standaloneSubjects.filter((subject) => !subject.archivedAt && subject.id !== claimSubjectId).map((subject) => <option key={subject.id} value={subject.id}>{subject.title}</option>)}{items.filter((item) => item.workspaceId === calendarWorkspaceSelection.current && ["project", "task", "area"].includes(item.type) && item.id !== claimSubjectId).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
                  {claimValueMode === "literal" && <>
                  <div className="preferenceGrid">
                    <label>{language === "cs" ? "Typ hodnoty" : "Value type"}<select value={claimValueType} onChange={(event) => setClaimValueType(event.target.value as typeof claimValueType)}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">Date</option></select></label>
                    <label>{language === "cs" ? "Hodnota" : "Value"}{claimValueType === "boolean" ? <select value={claimValue} onChange={(event) => setClaimValue(event.target.value)}><option value="">—</option><option value="true">true</option><option value="false">false</option></select> : <input type={claimValueType === "number" ? "number" : claimValueType === "date" ? "date" : "text"} value={claimValue} maxLength={10000} onChange={(event) => setClaimValue(event.target.value)} />}</label>
                  </div>
                  </>}
                  <div className="preferenceGrid">
                    <label>{language === "cs" ? "Aktuálnost" : "Freshness"}<select value={claimFreshness} onChange={(event) => setClaimFreshness(event.target.value as ContextClaimItem["freshness"])}><option value="current">{language === "cs" ? "Aktuální" : "Current"}</option><option value="needs_review">{language === "cs" ? "Prověřit" : "Needs review"}</option><option value="stale">{language === "cs" ? "Zastaralé" : "Stale"}</option></select></label>
                    <label>{language === "cs" ? "Citlivost" : "Sensitivity"}<select value={claimSensitivity} onChange={(event) => setClaimSensitivity(event.target.value as ContextClaimItem["sensitivity"])}><option value="normal">{language === "cs" ? "Běžné" : "Normal"}</option><option value="sensitive">{language === "cs" ? "Citlivé" : "Sensitive"}</option></select></label>
                  </div>
                  <div className="preferenceGrid"><label>{language === "cs" ? "Platí od (volitelné)" : "Valid from (optional)"}<input type="date" value={claimValidFrom} onChange={(event) => setClaimValidFrom(event.target.value)} /></label><label>{language === "cs" ? "Platí do (volitelné)" : "Valid to (optional)"}<input type="date" value={claimValidTo} onChange={(event) => setClaimValidTo(event.target.value)} /></label></div>
                  <details><summary>{language === "cs" ? "Zdroj a důkaz (volitelné)" : "Source and evidence (optional)"}</summary><div className="preferenceGrid"><label>Provider<input value={claimSourceProvider} maxLength={80} onChange={(event) => setClaimSourceProvider(event.target.value)} /></label><label>{language === "cs" ? "Odkaz / lokátor" : "URL / locator"}<input value={claimSourceLocator} maxLength={2000} onChange={(event) => setClaimSourceLocator(event.target.value)} /></label></div><label>{language === "cs" ? "Výňatek důkazu" : "Evidence excerpt"}<textarea value={claimEvidence} maxLength={2000} onChange={(event) => setClaimEvidence(event.target.value)} /></label></details>
                  <div className="notificationActions"><button className="primaryAction" disabled={Boolean(claimBusyId) || !claimSubjectId || !claimPredicate.trim() || (claimValueMode === "target" ? !claimTargetId : claimValue === "" || (claimValueType === "number" && !Number.isFinite(Number(claimValue))))} onClick={saveContextClaim}>{claimBusyId ? (language === "cs" ? "Ukládám…" : "Saving…") : tr("save")}</button>{editingClaim && <button disabled={Boolean(claimBusyId)} onClick={resetClaimDraft}>{language === "cs" ? "Zrušit" : "Cancel"}</button>}</div>
                  {claimStatus && <p className={claimStatus.toLowerCase().includes("konflikt") || claimStatus.toLowerCase().includes("conflict") ? "contextConflict" : "saveConfirmation"} role="status">{claimStatus}</p>}
                </div>
              </section>

              <section className="contextReviewQueue">
                <div className="sectionHeading"><div><h2>{language === "cs" ? "Tvrzení a kontrola" : "Claims and review"}</h2><p>{language === "cs" ? "Potvrzení platí jen pro konkrétní tvrzení, nikoli pro celý projekt nebo související úkoly." : "Confirmation applies only to this claim, not the whole project or related tasks."}</p></div><label>{language === "cs" ? "Zobrazit" : "Show"}<select value={claimFilterId} onChange={(event) => setClaimFilterId(event.target.value)}><option value="all">{language === "cs" ? "Celý workspace" : "Whole workspace"}</option><option value="review">{language === "cs" ? "Ke kontrole" : "Review queue"}</option>{items.filter((item) => item.type === "project" && item.workspaceId === calendarWorkspaceSelection.current).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}{standaloneSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.title}</option>)}</select></label></div>
                <div className="contextClaimList">
                  {[...contextClaims].filter((claim) => claimFilterId === "all" || (claimFilterId === "review" ? claim.reviewStatus === "proposed" : claim.subject.canonicalEntityId === claimFilterId || claim.subject.id === claimFilterId || claim.target?.id === claimFilterId || claim.target?.canonicalEntityId === claimFilterId)).sort((a, b) => Number(a.reviewStatus !== "proposed") - Number(b.reviewStatus !== "proposed") || b.updatedAt - a.updatedAt).map((claim) => <article key={claim.id} className={`contextClaimCard ${claim.reviewStatus} ${claim.freshness}`}>
                    <header><div><strong>{claim.subject.title}</strong><small>{contextSubjectTypeLabel(claim.subject.type)} · rev. {claim.revision}</small></div><span className={`claimState ${claim.reviewStatus}`}>{claim.reviewStatus === "proposed" ? (language === "cs" ? "Ke kontrole" : "Proposed") : claim.reviewStatus === "confirmed" ? (language === "cs" ? "Potvrzeno" : "Confirmed") : (language === "cs" ? "Odmítnuto" : "Rejected")}</span></header>
                    <p><b>{contextPredicateLabel(claim.predicate)}</b> → {String(claim.literal?.value ?? claim.target?.title ?? "—")}{claim.target?.archivedAt ? (language === "cs" ? " (archivováno)" : " (archived)") : ""}</p>
                    <div className="claimMeta"><span>{claim.freshness === "current" ? (language === "cs" ? "aktuální" : "current") : claim.freshness === "needs_review" ? (language === "cs" ? "prověřit" : "needs review") : (language === "cs" ? "zastaralé" : "stale")}</span><span>{claim.sensitivity === "sensitive" ? (language === "cs" ? "citlivé" : "sensitive") : (language === "cs" ? "běžné" : "normal")}</span><span className={claim.source ? "hasSource" : "missingSource"}>{claim.source ? (claim.source.provider || claim.source.locator || (language === "cs" ? "zdroj uveden" : "source available")) : (language === "cs" ? "bez zdroje · tvrzení vlastníka" : "missing source · owner statement")}</span></div>
                    {claim.evidence?.excerpt && <blockquote>{claim.evidence.excerpt}</blockquote>}
                    {claimHistory[claim.id] && <ol className="contextSubjectHistory">{claimHistory[claim.id].map((event, index) => <li key={`${event.createdAt}:${index}`}>{contextPredicateLabel(event.operation)} · rev. {event.afterRevision} · {new Date(event.createdAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</li>)}</ol>}
                    <div className="contextClaimActions">{claim.reviewStatus !== "confirmed" && <button className="primaryAction" disabled={Boolean(claimBusyId)} onClick={() => contextClaimAction(claim, "review", "confirmed")}>{language === "cs" ? "Potvrdit" : "Confirm"}</button>}{claim.reviewStatus !== "rejected" && <button disabled={Boolean(claimBusyId)} onClick={() => contextClaimAction(claim, "review", "rejected")}>{language === "cs" ? "Odmítnout" : "Reject"}</button>}<button disabled={Boolean(claimBusyId)} onClick={() => editContextClaim(claim)}>{language === "cs" ? "Opravit" : "Edit"}</button><button onClick={() => showClaimHistory(claim)}>{language === "cs" ? "Historie" : "History"}</button><button className="textAction danger" disabled={Boolean(claimBusyId)} onClick={() => contextClaimAction(claim, "archive")}>{language === "cs" ? "Archivovat" : "Archive"}</button></div>
                  </article>)}
                  {!contextClaims.some((claim) => claimFilterId === "all" || (claimFilterId === "review" ? claim.reviewStatus === "proposed" : claim.subject.canonicalEntityId === claimFilterId || claim.subject.id === claimFilterId || claim.target?.id === claimFilterId || claim.target?.canonicalEntityId === claimFilterId)) && <p>{language === "cs" ? "V tomto výběru nejsou žádná strukturovaná tvrzení." : "No structured claims in this selection."}</p>}
                </div>
              </section>
            </div>
          )}
    </>
  );
}
