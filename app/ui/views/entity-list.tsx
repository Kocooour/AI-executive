"use client";
import { Fragment } from "react";
import { byManualOrder, isEveningTask, taskDueTone } from "../../../lib/task-views";
import { taskRowValue } from "../task-row-value";
import { openTaskCountsByProject } from "../open-task-counts";
import type { LumiApp } from "../use-lumi-app";
import { RecordMarks } from "./held-back";
import { ProjectIcon, ViewIcon } from "./project-icon";
import { InboxBatchTriage } from "./inbox-batch-triage";
import { DeferChip } from "./defer-popover";

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
    unsent,
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
  // Only Projects shows this metadata. The relation graph, not a legacy projectId property,
  // owns membership; aggregate rows still count tasks in their own workspace only.
  const batchEligibleIds = new Set(batchCandidates.map(item => item.id));
  const openTasksByProject = view === "Projects"
    ? openTaskCountsByProject(items, projects, scopedRelations)
    : new Map<string, number>();

  // The Calendar page shows its own planned work; it does not repeat every open task as a list.
  if (view === "Calendar") return null;
  return (
    <>
          {view !== "Settings" && view !== "Agents" && view !== "Context" && (
            <>
              {!["Home", "Calendar", "Search", "Projects", "Areas", "Notes"].includes(view) && (
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
                {collection.map((x, index) => {
                  const meta = taskRowValue(x, language, today, {
                    held: heldReasons.has(x.id),
                    unsent: unsent.has(x.id),
                    openTaskCount: openTasksByProject.get(x.id) || 0,
                  });
                  // Today lists evening tasks last, under their own heading (the collection is already ordered that way).
                  const startsEvening = view === "Today" && isEveningTask(x, today) && (index === 0 || !isEveningTask(collection[index - 1], today));
                  return (
                    <Fragment key={x.id}>
                    {startsEvening && <h2 className="eveningHeading" id="today-evening-heading">{tr("deferEveningGroup")}</h2>}
                    <article
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
                      {dragHandle(x, x.type === "task" ? `task:${view}` : `${x.type}:all`)}
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
                        <span className="taskRowMarks"><RecordMarks app={app} entity={x} hideSync /></span>
                        {activeWorkspaceId === "all" && (
                          <span className="workspaceBadge">
                            {workspaces.find((workspace) => workspace.workspaceId === x.workspaceId)?.title || x.workspaceId}
                          </span>
                        )}
                      </div>
                      {x.type === "task" && x.status === "open" && activeWorkspaceId !== "all" && meta.kind !== "sync" ? (
                        <DeferChip app={app} task={x} meta={meta} />
                      ) : meta.text && (
                        <span className={`taskRowMeta ${meta.tone === "danger" ? "danger" : meta.tone === "warning" ? "pending" : ""}`.trim()} data-meta-kind={meta.kind}>
                          {meta.kind === "sync" && <span aria-hidden="true">{heldReasons.has(x.id) ? "⚠ " : "↻ "}</span>}{meta.text}
                        </span>
                      )}
                    </article>
                    </Fragment>
                  );
                })}
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
  );
}
