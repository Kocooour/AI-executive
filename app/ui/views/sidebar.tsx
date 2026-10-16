"use client";
import { primaryViews, secondaryViews } from "../navigation";
import type { LumiApp } from "../use-lumi-app";
import { ViewIcon } from "./project-icon";
import { WorkspaceTile, workspaceTone } from "../workspace-appearance";

export function Sidebar({ app }: { app: LumiApp }) {
  const {
    setSettingsSection,
    acceptNativeDrop,
    activeWorkspaceId,
    activeWorkspaceTone,
    closeDetail,
    dragTarget,
    draggableSectionNames,
    language,
    openCapture,
    selectWorkspace,
    setActiveDragTarget,
    setView,
    setWorkspaceMenuOpen,
    sidebarCounts,
    tr,
    view,
    workspaceMenuOpen,
    workspaceName,
    workspaces,
  } = app;
  return (
    <>
      <aside>
        <div className="appIdentity" aria-label="Lumi">
          <span className="brandMark" aria-hidden="true" />
          <span><strong>Lumi</strong><small>{tr("appTagline")}</small></span>
        </div>
        <div className="workspaceSwitcher">
          <button
            className="workspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label={tr("switchWorkspace")}
            aria-expanded={workspaceMenuOpen}
          >
            <WorkspaceTile tone={activeWorkspaceTone} label={workspaceName} />
            <b>{workspaceName}</b>
            <span className="workspaceChevron" aria-hidden="true">⌄</span>
          </button>
          {workspaceMenuOpen && (
            <div className="workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={activeWorkspaceId === workspace.workspaceId ? "active" : ""}
                  data-workspace-id={workspace.workspaceId}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  <WorkspaceTile tone={workspaceTone(workspace.workspaceId, workspace)} label={workspace.title} />
                  <span className="workspaceOptionName">{workspace.title}</span>
                  <small>{tr(workspace.properties.kind === "personal" ? "workspaceKindPersonalShort" : "workspaceKindSharedShort")}</small>
                </button>
              ))}
              <button
                className={activeWorkspaceId === "all" ? "active" : ""}
                data-workspace-id="all"
                onClick={() => selectWorkspace("all")}
              >
                <WorkspaceTile tone="all" label={tr("allWork")} />
                <span className="workspaceOptionName">{tr("allWork")}</span>
                <small>{tr("workspaceAggregate")}</small>
              </button>
              <button
                onClick={() => {
                  setSettingsSection("workspace");
                  setView("Settings");
                  setWorkspaceMenuOpen(false);
                  closeDetail();
                }}
              >
                <span>{tr("manageWorkspaces")}</span>
                <small>{tr("settingsShort")}</small>
              </button>
            </div>
          )}
        </div>
        <nav aria-label={tr("mainNavigation")}>
          {primaryViews.map((x) => (
            <button
              className={`${view === x ? "active" : ""} ${dragTarget === `section:${x}` ? "dropActive" : ""}`.trim()}
              aria-current={view === x ? "page" : undefined}
              data-nav-view={x}
              data-drop-section={draggableSectionNames.includes(x) ? x : undefined}
              onDragEnter={() => draggableSectionNames.includes(x) && setActiveDragTarget(`section:${x}`)}
              onDragOver={(event) => {
                if (!draggableSectionNames.includes(x)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => acceptNativeDrop(event, `section:${x}`)}
              onClick={() => {
                setView(x);
                closeDetail();
              }}
              key={x}
            >
              <span className="navLabel"><span aria-hidden="true"><ViewIcon name={x} /></span>{tr(x)}</span>
              {sidebarCounts[x] !== undefined ? (
                <span className="navCount">{sidebarCounts[x]}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <footer className="sidebarActions">
          <button onClick={() => openCapture()} aria-label={tr("addTask")}>
            ＋ {tr("new")}
          </button>
          <details className="secondaryNav">
            <summary>{tr("moreViews")}</summary>
            {secondaryViews.map((x) => <button key={x} className={view === x ? "active" : ""} onClick={() => { setView(x); closeDetail(); }}>{tr(x)}</button>)}
          </details>
          <button
            className={view === "Settings" ? "active" : ""}
            onClick={() => {
              setView("Settings");
              closeDetail();
            }}
          >
            ⚙ {tr("Settings")}
          </button>
        </footer>
      </aside>
    </>
  );
}
