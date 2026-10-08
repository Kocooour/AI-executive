"use client";
import { entityConflicts } from "../../../lib/field-merge";
import { byManualOrder, taskDueTone } from "../../../lib/task-views";
import { friendlyDate } from "../format";
import type { LumiApp } from "../use-lumi-app";
import { ProjectIcon, ViewIcon } from "./project-icon";

export function EntityList({ app }: { app: LumiApp }) {
  const {
    acceptNativeDrop,
    activeWorkspaceId,
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
    language,
    priorityFilter,
    projects,
    setActiveDragTarget,
    setPriorityFilter,
    setSortBy,
    setText,
    sortBy,
    targets,
    text,
    today,
    tr,
    type,
    view,
    workspaces,
  } = app;
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
              <div
                className={
                  "list " +
                  (view === "Home" || view === "Search" ? "secondary" : "")
                }
              >
                {collection.map((x) => (
              <article
                key={x.id}
                className={`${draggingId === x.id ? "isDragging" : ""} ${dragTarget === `entity:${x.id}` ? "dropActive" : ""} ${taskDueTone(x, today)}`.trim()}
                data-drop-entity={x.id}
                onDragEnter={() => setActiveDragTarget(`entity:${x.id}`)}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                onDrop={(event) => acceptNativeDrop(event, `entity:${x.id}`)}
                onClick={() => inspect(x)}
              >
                {dragHandle(x, x.type === "task" ? `task:${view}` : `${x.type}:all`)}
                {x.type === "task" ? (
                  <button
                    className="check"
                    onClick={(e) => {
                      e.stopPropagation();
                      done(x.id);
                    }}
                  >
                    ○
                  </button>
                ) : (
                  <div className={`entityIcon ${x.type}Icon`}>
                    {x.type === "project" ? <ProjectIcon /> : x.type === "area" ? "●" : "▤"}
                  </div>
                )}
                <div>
                  <strong>{x.title}{entityConflicts(x).length > 0 && <span className="conflictMark" role="img" aria-label={tr("conflictBadge")} title={tr("conflictBadge")}> ⇄</span>}</strong>
                  <small>
                    {x.type === "task"
                      ? [
                          x.properties.priority &&
                          x.properties.priority !== "none"
                            ? "● " + tr(String(x.properties.priority))
                            : null,
                          taskDueTone(x, today) === "dueOverdue"
                            ? tr("Overdue")
                            : null,
                          taskDueTone(x, today) === "dueSoon"
                            ? tr("dueSoon")
                            : null,
                          typeof x.properties.when === "string"
                            ? friendlyDate(x.properties.when, language)
                            : null,
                          x.properties.deadline &&
                            tr("deadline") + " " + friendlyDate(x.properties.deadline, language),
                          (() => {
                            const areaId = targets(x.id, "belongs_to_area")[0];
                            const area = areas.find((candidate) => candidate.id === areaId);
                            return area ? `${tr("area")}: ${area.title}` : null;
                          })(),
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        (x.properties.today === true
                          ? tr("Today")
                          : x.properties.someday === true
                            ? tr("Someday")
                            : x.properties.inbox === true
                              ? tr("Inbox")
                              : tr("Anytime"))
                      : x.type === "project" && x.properties.deadline
                        ? `${tr("Projects")} · ${tr("deadline")} ${friendlyDate(x.properties.deadline, language)}`
                        : tr(x.type === "project" ? "Projects" : x.type === "area" ? "Areas" : "Notes")}
                  </small>
                  {activeWorkspaceId === "all" && (
                    <span className="workspaceBadge">
                      {workspaces.find(
                        (workspace) => workspace.workspaceId === x.workspaceId,
                      )?.title || "Workspace"}
                    </span>
                  )}
                </div>
                  </article>
                ))}
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
                    placeholder={`+ ${tr("add")} ${tr(type === "project" ? "Projects" : type === "area" ? "Areas" : type === "note" ? "Notes" : "Today").toLowerCase()}`}
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
