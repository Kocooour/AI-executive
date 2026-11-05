"use client";
import { Fragment, useEffect, useState } from "react";
import { mobileDesignV1Preview } from "../navigation";
import { taskPreviewCompletionTone, taskPreviewStateText } from "../../../lib/lumi-completion-state";
import { v1DragHandleVisible, v1ReorderAvailable } from "../../../lib/lumi-reorder-preview";
import { buildMyPlanPreview } from "../../../lib/my-plan-preview";
import { LumiCompletionControl } from "./lumi-completion-control";
import { projectAreaPreviewTone } from "../../../lib/project-list-preview";
import { MobileProjectRowV1 } from "./mobile-project-row-v1";
import { byManualOrder, isEveningTask, taskDueTone } from "../../../lib/task-views";
import { taskRowValue } from "../task-row-value";
import { summarizeProject, type ProjectSummary } from "../../../lib/project-summary";
import { firstSentence, readProjectContext } from "../../../lib/project-context";
import { attentionText, labelsFor } from "../project-labels";
import { ProjectPage } from "./project-page";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";
import { RecordMarks } from "./held-back";
import { ProjectIcon, ViewIcon } from "./project-icon";
import { InboxBatchTriage } from "./inbox-batch-triage";
import { DeferChip } from "./defer-popover";
import { TodayTimeCell } from "./today-time-cell";
import { planSlotsByTask } from "../../../lib/today-plan";
import { untimedRowHeight } from "../../../lib/day-timeline";
import { GmailReader } from "./gmail-reader";

export function EntityList({ app }: { app: LumiApp }) {
  const {
    acceptNativeDrop,
    activeWorkspaceId,
    batchAllowed,
    batchCandidates,
    batchIds,
    setBatchIds,
    areas,
    collection,
    createFromRow,
    rowError,
    setRowError,
    done,
    dragHandle,
    dragTarget,
    draggableSectionNames,
    draggedEntity,
    draggingId,
    inspect,
    items,
    heldReasons,
    inboxTab,
    setInboxTab,
    closeDetail,
    projectGroups,
    unsent,
    visibleDayPlan,
    language,
    priorityFilter,
    projects,
    scopedRelations,
    setActiveDragTarget,
    setPriorityFilter,
    setSortBy,
    setText,
    sortBy,
    text,
    today,
    tr,
    type,
    view,
    workspaces,
  } = app;
  const [reorderPreview, setReorderPreview] = useState(false);
  // The same edit state also controls both task and note handles on ProjectPage.
  const reorderableView = v1ReorderAvailable(view);
  // The edit affordance is per list, not shared across Today/My Plan or a project detail.
  useEffect(() => { setReorderPreview(false); app.setPlanReorderError(false); },
    [view, activeWorkspaceId, app.mobilePlanPreviewActive, app.openProject?.id]);
  // Shared project rows render identically on desktop and phone.
  const projectListPreview = mobileDesignV1Preview && view === "Projects" && !app.openProject;
  const myPlanPreview = mobileDesignV1Preview && app.mobilePlanPreviewActive && view === "Today";
  // When the user changes the sort option while editing, remove handles before
  // another pointer or keyboard gesture can persist a rank against that order.
  useEffect(() => { if (myPlanPreview && sortBy !== "manual") setReorderPreview(false); },
    [myPlanPreview, sortBy]);
  // Only Projects shows this metadata. The relation graph, not a legacy projectId property,
  // owns membership; aggregate rows still count tasks in their own workspace only.
  const batchEligibleIds = new Set(batchCandidates.map(item => item.id));
  const projectText = labelsFor(language);
  const projectSummaries = new Map<string, ProjectSummary>();
  if (view === "Projects" && !app.openProject) {
    for (const project of projects) projectSummaries.set(project.id, summarizeProject(project, items, scopedRelations, today));
  }

  // Today folds the day plan into its rows: a time cell per task instead of a separate plan list.
  // Tasks made from today's events are rows of the day timeline, not of this list (the header still counts them).
  const listed = view === "Today" ? collection.filter((x) => !app.todayTimelineTaskIds.has(x.id)) : collection;
  const planSlots = view === "Today" ? planSlotsByTask(visibleDayPlan) : null;
  // Presentation-only legacy workspace rows. The server-authorized multi-space
  // My Plan is a separate R3-slice integration, not this selection.
  const previewDays = myPlanPreview ? buildMyPlanPreview({
    entities: items, relations: scopedRelations, workspaceId: activeWorkspaceId,
    today, priorityFilter, sortBy, excludeTimelineIds: app.todayTimelineTaskIds,
  }) : [];
  // `dragScope`: the ordering a drag changes, when it is not the one of the view (the tasks and notes of a project page).
  const renderRow = (x: Entity, index: number, rows: Entity[], dragScope?: string,
    previewDay?: "today" | "tomorrow") => {
      const projectSummary = x.type === "project" ? projectSummaries.get(x.id) : undefined;
      if (projectListPreview && x.type === "project" && projectSummary) {
        return <MobileProjectRowV1 key={x.id} app={app} project={x} summary={projectSummary}
          dragScope={dragScope ?? "project:all"} reorderEnabled={reorderPreview} />;
      }
      let meta = taskRowValue(x, language, today, {
        held: heldReasons.has(x.id),
        unsent: unsent.has(x.id),
        openTaskCount: projectSummary?.open ?? 0,
      });
      // A project row says where it stands: progress on the right (a failed or pending save still wins).
      if (projectSummary && meta.kind === "count") meta = { text: projectText.progressText(projectSummary.done, projectSummary.total), kind: "count", tone: "default" };
      const projectContext = projectSummary ? readProjectContext(x.properties) : null;
      const projectWhy = projectContext ? firstSentence(projectContext.why) : "";
      const projectAttention = projectSummary ? attentionText(language, projectSummary.attention) : "";
      // Today lists evening tasks last, under their own heading (the collection is already ordered that way).
      const startsEvening = view === "Today" && !myPlanPreview && isEveningTask(x, today) && (index === 0 || !isEveningTask(rows[index - 1], today));
      return (
        <Fragment key={x.id}>
        {startsEvening && <h2 className="eveningHeading" id="today-evening-heading">{tr("deferEveningGroup")}</h2>}
        <article
          style={view === "Today" && x.type === "task" && !mobileDesignV1Preview ? { minHeight: untimedRowHeight(typeof x.properties.estimatedMinutes === "number" ? x.properties.estimatedMinutes : null) } : undefined}
          className={`taskRow ${draggingId === x.id ? "isDragging" : ""} ${dragTarget === `entity:${x.id}` ? "dropActive" : ""} ${taskDueTone(x, today)}`.trim()}
          data-drop-entity={x.id}
          data-entity-type={x.type}
          data-v1-reorder={mobileDesignV1Preview && view === "Today" ? String(reorderPreview) : undefined}
          onDragEnter={() => setActiveDragTarget(`entity:${x.id}`)}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
          onDrop={(event) => acceptNativeDrop(event, `entity:${x.id}`)}
          onClick={() => inspect(x)}
        >
          {view === "Inbox" && batchAllowed && x.type === "task" && (
            <label className="batchRowSelect" title={!batchEligibleIds.has(x.id) ? tr("batchUnavailable") : undefined}
              onClick={event => event.stopPropagation()}>
              <input type="checkbox"
                aria-label={tr("batchSelectItem").replace("{title}", x.title || tr("untitledItem"))}
                disabled={!batchEligibleIds.has(x.id) || (!batchIds.includes(x.id) && batchIds.length >= 50)}
                checked={batchIds.includes(x.id)}
                onChange={event => setBatchIds(event.target.checked
                  ? [...batchIds, x.id] : batchIds.filter(id => id !== x.id))}/>
            </label>
          )}
          {v1DragHandleVisible(view, mobileDesignV1Preview, reorderPreview) &&
            (!myPlanPreview || sortBy === "manual") &&
            dragHandle(x, dragScope ?? (x.type === "task" ? `task:${view}` : `${x.type}:all`))}
          {x.type === "task" ? (
            mobileDesignV1Preview ? (
              <LumiCompletionControl className="check" kind="task"
                tone={taskPreviewCompletionTone(x, today)}
                complete={x.status === "completed"}
                stateLabel={taskPreviewStateText(taskPreviewCompletionTone(x, today), language)}
                actionLabel={`${tr(x.status === "completed" ? "reopen" : "complete")} ${x.title || tr("untitledItem")}`}
                blockedReason={language === "cs" ? "Zvolte konkrétní prostor a vyčkejte na synchronizaci." : "Select a workspace and finish synchronization."}
                disabled={activeWorkspaceId === "all" || heldReasons.has(x.id) || unsent.has(x.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (x.status === "completed") void app.reopenTask(x);
                  else void done(x.id);
                }} />
            ) : (
              <button type="button" className="check"
                aria-label={`${tr("complete")} ${x.title || tr("untitledItem")}`}
                onClick={(event) => { event.stopPropagation(); void done(x.id); }}>○</button>
            )
          ) : (
            <span className={`entityIcon ${x.type}Icon`} aria-hidden="true">
              {x.type === "project" ? <ProjectIcon /> : x.type === "area" ? "●" : <ViewIcon name="Notes" />}
            </span>
          )}
          <div className="taskRowMain">
            <strong><button
              type="button"
              className="taskRowOpen"
              onClick={(event) => { event.stopPropagation(); void inspect(x); }}
            >{x.title || tr("untitledItem")}</button></strong>
            {view === "Today" && x.type === "task" && previewDay !== "tomorrow" &&
              (!mobileDesignV1Preview || (typeof x.properties.estimatedMinutes === "number" && x.properties.estimatedMinutes > 0)) && (
              <small className="taskRowEstimate" data-row-estimate>{typeof x.properties.estimatedMinutes === "number" && x.properties.estimatedMinutes > 0 ? tr("timelineMinutes").replace("{n}", String(x.properties.estimatedMinutes)) : tr("timelineNoEstimate")}</small>
            )}
            {projectSummary && (
              <>
                <small className={`projectRowWhy${projectWhy ? "" : " isEmpty"}`} data-project-why>{projectWhy || projectText.whyHint}</small>
                {(projectSummary.next || projectAttention) && (
                  <small className="projectRowNext" data-project-next>
                    {projectSummary.next && <>{projectText.nextStep}: <span>{projectSummary.next.title || tr("untitledItem")}</span></>}
                    {projectAttention && <span className={`projectAttention${projectSummary.attention?.kind === "overdue" ? " danger" : ""}`} data-project-attention>{projectAttention}</span>}
                  </small>
                )}
              </>
            )}
            <span className="taskRowMarks"><RecordMarks app={app} entity={x} hideSync /></span>
            {activeWorkspaceId === "all" && (
              <span className="workspaceBadge">
                {workspaces.find((workspace) => workspace.workspaceId === x.workspaceId)?.title || x.workspaceId}
              </span>
            )}
          </div>
          {planSlots && x.type === "task" && previewDay !== "tomorrow" && <TodayTimeCell app={app} task={x} slot={planSlots.get(x.id)} />}
          {x.type === "task" && x.status === "open" && activeWorkspaceId !== "all" && meta.kind !== "sync" && previewDay !== "tomorrow" ? (
            <DeferChip app={app} task={x} />
          ) : meta.text && (
            <span className={`taskRowMeta ${meta.tone === "danger" ? "danger" : meta.tone === "warning" ? "pending" : ""}`.trim()} data-meta-kind={meta.kind}>
              {meta.kind === "sync" && <span aria-hidden="true">{heldReasons.has(x.id) ? "⚠ " : "↻ "}</span>}{meta.text}
            </span>
          )}
        </article>
        </Fragment>
      );
  };

  // The Calendar page shows its own planned work; it does not repeat every open task as a list.
  if (view === "Calendar") return null;
  // A project opened from the list or the sidebar is the main view of Projects (B1); its rows are these same rows.
  if (view === "Projects" && app.openProject) return <ProjectPage key={app.openProject.id}
    app={app} project={app.openProject} renderRow={renderRow}
    reorderPreview={reorderPreview} onToggleReorder={() => setReorderPreview((value) => !value)} />;
  return (
    <>
          {view !== "Settings" && view !== "Agents" && view !== "Context" && (
            <>
              {view === "Inbox" && (
                <div className="inboxTabs" role="group" aria-label={tr("inboxSource")}>
                  {(["tasks", "mail"] as const).map((tab) => (
                    <button key={tab} type="button" data-inbox-tab={tab} aria-pressed={inboxTab === tab}
                      onClick={() => { if (inboxTab !== tab) { closeDetail(); setInboxTab(tab); } }}>
                      {tr(tab === "tasks" ? "inboxTabTasks" : "inboxTabMail")}
                    </button>
                  ))}
                </div>
              )}
              {view === "Inbox" && inboxTab === "mail" ? <GmailReader key={`${activeWorkspaceId}:${app.offlineView}`} app={app} /> : (
              <>
              {!["Home", "Today", "Calendar", "Search", "Projects", "Areas", "Notes"].includes(view) && (
                <div className="listControls">
                  <label>
                    {tr("priority")}
                    <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
                      <option value="all">{tr("all")}</option>
                      <option value="high">{tr("high")}</option>
                      <option value="medium">{tr("medium")}</option>
                      <option value="low">{tr("low")}</option>
                      <option value="none">{tr("none")}</option>
                    </select>
                  </label>
                  <label>
                    {tr("sort")}
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                      <option value="manual">{tr("manual")}</option>
                      <option value="date">{tr("date")}</option>
                      <option value="priority">{tr("priority")}</option>
                      <option value="created">{tr("newest")}</option>
                    </select>
                  </label>
                </div>
              )}
              {draggedEntity && (
                <div className="sectionDropZones" aria-label={tr("moveToSection")}>
                  {draggedEntity.type === "task" && draggableSectionNames.map((section) => (
                    <button
                      key={section}
                      className={dragTarget === `section:${section}` ? "dropActive" : ""}
                      data-drop-section={section}
                      onDragEnter={() => setActiveDragTarget(`section:${section}`)}
                      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                      onDrop={(event) => acceptNativeDrop(event, `section:${section}`)}
                    >
                      <ViewIcon name={section} /> {tr(section)}
                    </button>
                  ))}
                  {(draggedEntity.type === "task" || draggedEntity.type === "note") && projects
                    .filter((project) => project.workspaceId === draggedEntity.workspaceId && project.status === "active")
                    .sort(byManualOrder("project:all"))
                    .map((project) => (
                      <button
                        key={project.id}
                        className={dragTarget === `entity:${project.id}` ? "dropActive" : ""}
                        data-drop-entity={project.id}
                        onDragEnter={() => setActiveDragTarget(`entity:${project.id}`)}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                        onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}
                      >
                        <ProjectIcon /> {project.title}
                      </button>
                    ))}
                  {draggedEntity.type === "project" && areas
                    .filter((area) => area.workspaceId === draggedEntity.workspaceId && area.status === "active")
                    .sort(byManualOrder("area:all"))
                    .map((area) => (
                      <button
                        key={area.id}
                        className={dragTarget === `entity:${area.id}` ? "dropActive" : ""}
                        data-drop-entity={area.id}
                        onDragEnter={() => setActiveDragTarget(`entity:${area.id}`)}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                        onDrop={(event) => acceptNativeDrop(event, `entity:${area.id}`)}
                      >
                        ◎ {area.title}
                      </button>
                    ))}
                </div>
              )}
              <InboxBatchTriage app={app} />
              {mobileDesignV1Preview && reorderableView && !app.openProject && (
                <button type="button" className="v1ReorderToggle"
                  aria-pressed={reorderPreview} data-v1-reorder-toggle=""
                  onClick={() => {
                    // Explicitly enter manual sorting before exposing reorder
                    // handles. The list redraws in its actual persisted order,
                    // rather than interpolating ranks from a priority/date view.
                    if (myPlanPreview && !reorderPreview && sortBy !== "manual") setSortBy("manual");
                    setReorderPreview((value) => !value);
                  }}>
                  {reorderPreview ? (language === "cs" ? "Hotovo s řazením" : "Finish reordering")
                    : myPlanPreview && sortBy !== "manual"
                      ? (language === "cs" ? "Upravit pořadí ručně" : "Reorder manually")
                      : (language === "cs" ? "Upravit pořadí" : "Reorder")}
                </button>
              )}
              {myPlanPreview && app.planReorderError && (
                <p className="myPlanV1ScopeNotice" role="alert" data-plan-reorder-refused>
                  {language === "cs"
                    ? "Pořadí nebylo změněno. Některý dotčený úkol čeká na synchronizaci, je blokovaný nebo má konflikt. Nejprve dokončete synchronizaci či vyřešte konflikt."
                    : "Order was not changed. An affected task is pending sync, blocked, or conflicted. Complete synchronization or resolve the conflict first."}
                </p>
              )}
              <div
                className={
                  "list taskRowList " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {myPlanPreview ? (
                  <div className="myPlanV1Sections" data-my-plan-days="legacy-preview">
                    {activeWorkspaceId === "all" && (
                      <p className="myPlanV1ScopeNotice" role="status" data-my-plan-aggregate-blocked>
                        {language === "cs"
                          ? "Pro tento vývojový náhled vyberte konkrétní prostor. Autorizovaný plán napříč prostory zatím není zapnutý."
                          : "Select a single workspace for this development preview. Actor-authorized combined My Plan is not enabled."}
                      </p>
                    )}
                    {activeWorkspaceId !== "all" && previewDays.map((section) => (
                      <section key={section.day} className="myPlanV1Day" data-plan-day={section.day}
                        aria-labelledby={`my-plan-day-${section.day}`}>
                        <h2 id={`my-plan-day-${section.day}`} className="myPlanV1DayTitle">
                          {section.day === "today" ? (language === "cs" ? "Dnes" : "Today")
                            : (language === "cs" ? "Zítra" : "Tomorrow")}
                          <span className="myPlanV1DayCount">{section.count}</span>
                        </h2>
                        {section.count === 0 ? (
                          <p className="myPlanV1Empty">
                            {language === "cs" ? "Žádné naplánované úkoly" : "No scheduled tasks"}
                          </p>
                        ) : (
                          <div className="myPlanV1Areas">
                            {section.groups.map((group) => (
                              <div key={group.key} role="group" aria-label={group.accessibleLabel}
                                className="myPlanV1Area" data-plan-area={group.areaId ?? "unassigned"}
                                data-preview-area-tone={group.tone}>
                                <div className="list taskRowList">
                                  {group.tasks.map((task, index) => renderRow(task, index, group.tasks,
                                    section.day === "today" ? "task:Today" : "task:Upcoming", section.day))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                ) : view === "Projects" ? null : listed.map((x, index) => renderRow(x, index, listed))}
                {view === "Projects" && projectGroups.length > 0 && (
                  <div className="projectGroups" aria-label={tr("projectsByArea")}
                    data-projects-preview={projectListPreview ? "lumi-v1" : undefined}>
                    {projectGroups.map((group) => (
                      <section key={group.key} className="projectGroup" data-project-group={group.area ? group.area.id : "none"}
                        data-preview-area-tone={projectListPreview ? projectAreaPreviewTone(group.area) : undefined}
                        aria-labelledby={`project-group-${group.key}`}>
                        <h2 id={`project-group-${group.key}`} className={`projectGroupHeading${projectListPreview ? " v1ProjectA11yOnly" : ""}`}>
                          {group.area ? (group.area.title || tr("untitledItem")) : tr("noAreaGroup")}
                          {activeWorkspaceId === "all" && group.area && (
                            <span className="workspaceBadge">{workspaces.find((workspace) => workspace.workspaceId === group.area?.workspaceId)?.title || group.area.workspaceId}</span>
                          )}
                        </h2>
                        <div className="list taskRowList">
                          {group.projects.map((project, index) => renderRow(project, index, group.projects))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
                {!myPlanPreview && collection.length === 0 && view !== "Home" && view !== "Search" && (
                  <div className="empty">{tr("nothingHere")}</div>
                )}
              </div>
              {!['Home', 'Search'].includes(view) && (
                <div className="capture">
                  <input
                    value={text}
                    onChange={(e) => { setText(e.target.value); setRowError(false); }}
                    onKeyDown={(e) => e.key === "Enter" && createFromRow(type, text)}
                    placeholder={`+ ${tr(type === "project" ? "addProject" : type === "area" ? "addArea" : type === "note" ? "addNote" : "addTask")}`}
                  />
                  <button onClick={() => createFromRow(type, text)}>{tr("add")}</button>
                  {rowError && <small role="alert" className="captureRowError">{tr("addFailed")}</small>}
                </div>
              )}
              </>
              )}
            </>
          )}
    </>
  );
}
