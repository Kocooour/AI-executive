"use client";
import { Fragment, useEffect, useState } from "react";
import { mobileDesignV1Preview } from "../navigation";
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
  const [mobileViewport, setMobileViewport] = useState(false);
  useEffect(() => {
    if (!mobileDesignV1Preview) return;
    const media = window.matchMedia("(max-width: 700px)");
    const sync = () => setMobileViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const mobileProjectPreview = mobileDesignV1Preview && mobileViewport && view === "Projects" && !app.openProject;
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
  // `dragScope`: the ordering a drag changes, when it is not the one of the view (the tasks and notes of a project page).
  const renderRow = (x: Entity, index: number, rows: Entity[], dragScope?: string) => {
      const projectSummary = x.type === "project" ? projectSummaries.get(x.id) : undefined;
      if (mobileProjectPreview && x.type === "project" && projectSummary) {
        return <MobileProjectRowV1 key={x.id} app={app} project={x} summary={projectSummary}
          dragScope={dragScope ?? "project:all"} />;
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
      const startsEvening = view === "Today" && isEveningTask(x, today) && (index === 0 || !isEveningTask(rows[index - 1], today));
      return (
        <Fragment key={x.id}>
        {startsEvening && <h2 className="eveningHeading" id="today-evening-heading">{tr("deferEveningGroup")}</h2>}
        <article
          style={view === "Today" && x.type === "task" ? { minHeight: untimedRowHeight(typeof x.properties.estimatedMinutes === "number" ? x.properties.estimatedMinutes : null) } : undefined}
          className={`taskRow ${draggingId === x.id ? "isDragging" : ""} ${dragTarget === `entity:${x.id}` ? "dropActive" : ""} ${taskDueTone(x, today)}`.trim()}
          data-drop-entity={x.id}
          data-entity-type={x.type}
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
          {dragHandle(x, dragScope ?? (x.type === "task" ? `task:${view}` : `${x.type}:all`))}
          {x.type === "task" ? (
            <button
              type="button"
              className="check"
              aria-label={`${tr("complete")} ${x.title || tr("untitledItem")}`}
              onClick={(event) => {
                event.stopPropagation();
                done(x.id);
              }}
            >○</button>
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
            {view === "Today" && x.type === "task" && (
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
          {planSlots && x.type === "task" && <TodayTimeCell app={app} task={x} slot={planSlots.get(x.id)} />}
          {x.type === "task" && x.status === "open" && activeWorkspaceId !== "all" && meta.kind !== "sync" ? (
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
  if (view === "Projects" && app.openProject) return <ProjectPage key={app.openProject.id} app={app} project={app.openProject} renderRow={renderRow} />;
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
              <div
                className={
                  "list taskRowList " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {view === "Projects" ? null : listed.map((x, index) => renderRow(x, index, listed))}
                {view === "Projects" && projectGroups.length > 0 && (
                  <div className="projectGroups" aria-label={tr("projectsByArea")}
                    data-projects-preview={mobileProjectPreview ? "lumi-v1" : undefined}>
                    {projectGroups.map((group) => (
                      <section key={group.key} className="projectGroup" data-project-group={group.area ? group.area.id : "none"}
                        data-preview-area-tone={mobileProjectPreview ? projectAreaPreviewTone(group.area) : undefined}
                        aria-labelledby={`project-group-${group.key}`}>
                        <h2 id={`project-group-${group.key}`} className={`projectGroupHeading${mobileProjectPreview ? " v1ProjectA11yOnly" : ""}`}>
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
                {collection.length === 0 && view !== "Home" && view !== "Search" && (
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
