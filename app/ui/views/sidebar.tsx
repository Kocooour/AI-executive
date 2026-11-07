"use client";
import { useEffect, useRef, useState } from "react";
import { desktopV1PrimaryViews, mobileDesignV1Preview, primaryViews, secondaryViews } from "../navigation";
import { desktopSidebarCanFocusDestination } from "../../../lib/desktop-sidebar-focus";
import { mobileMoreHeadingRevealDelta } from "../../../lib/mobile-more-focus";
import type { LumiApp } from "../use-lumi-app";
import { ProjectIcon, ViewIcon } from "./project-icon";
import { WorkspaceTile, workspaceTone } from "../workspace-appearance";

export function Sidebar({ app }: { app: LumiApp }) {
  const {
    setSettingsSection,
    setInboxTab,
    acceptNativeDrop,
    activeWorkspaceId,
    activeWorkspaceTone,
    closeDetail,
    dragTarget,
    inspect,
    projectsAttention,
    sidebarProjects,
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
  // "More views" opens a list in the scrolling area under the projects; its toggle stays in the footer.
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const pendingDesktopNavigationRef = useRef<{ destination: string; opener: HTMLButtonElement; planPreview: boolean } | null>(null);
  const latestViewRef = useRef(view);
  latestViewRef.current = view;

  const navViews = mobileDesignV1Preview ? desktopV1PrimaryViews : primaryViews;

  function navigateToView(destination: string, opener: HTMLButtonElement, planPreview = false) {
    const routeChanged = destination !== view ||
      (destination === "Today" && planPreview !== app.mobilePlanPreviewActive);
    pendingDesktopNavigationRef.current = mobileDesignV1Preview &&
      window.matchMedia("(min-width: 701px)").matches && routeChanged
      ? { destination, opener, planPreview } : null;
    setView(destination, planPreview ? { previewMyPlan: true } : undefined);
    closeDetail();
  }

  // View commits before focus moves. Back/Forward, search focus and project
  // inspection never record a sidebar focus intent.
  useEffect(() => {
    const intent = pendingDesktopNavigationRef.current;
    if (!intent) return;
    if (intent.destination !== view ||
      (view === "Today" && intent.planPreview !== app.mobilePlanPreviewActive)) {
      pendingDesktopNavigationRef.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (pendingDesktopNavigationRef.current !== intent) return;
      pendingDesktopNavigationRef.current = null;
      const active = document.activeElement;
      if (!desktopSidebarCanFocusDestination(intent.destination, latestViewRef.current,
        mobileDesignV1Preview, window.matchMedia("(min-width: 701px)").matches,
        active === intent.opener || active === document.body)) return;
      const heading = document.querySelector<HTMLElement>(".appPane .pageTitleRow h1");
      if (!heading?.isConnected || !heading.getClientRects().length) return;
      // A long source view may leave the new heading behind the sticky topbar.
      const toolbarBottom = document.querySelector<HTMLElement>(".appPane .topbar")
        ?.getBoundingClientRect().bottom ?? 0;
      const rect = heading.getBoundingClientRect();
      const delta = mobileMoreHeadingRevealDelta(rect.top, rect.bottom,
        Math.max(0, toolbarBottom) + 12, window.innerHeight - 12);
      if (delta !== 0) window.scrollBy({ top: delta, behavior: "instant" });
      heading.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, app.mobilePlanPreviewActive]);
  useEffect(() => {
    if (secondaryOpen) secondaryRef.current?.scrollIntoView({ block: "nearest" });
  }, [secondaryOpen]);
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
          {navViews.map((x) => {
            const planPreview = mobileDesignV1Preview && x === "MyPlanPreview";
            const destination = planPreview ? "Today" : x;
            const active = planPreview ? view === "Today" && app.mobilePlanPreviewActive :
              view === x && !(x === "Today" && app.mobilePlanPreviewActive);
            const draggable = !planPreview && draggableSectionNames.includes(x);
            return (
            <button
              className={`${active ? "active" : ""} ${dragTarget === `section:${x}` ? "dropActive" : ""}`.trim()}
              aria-current={active ? "page" : undefined}
              data-nav-view={destination}
              data-nav-tab={planPreview ? "my-plan-preview" : undefined}
              data-drop-section={draggable ? x : undefined}
              onDragEnter={() => draggable && setActiveDragTarget(`section:${x}`)}
              onDragOver={(event) => {
                if (!draggable) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => { if (draggable) acceptNativeDrop(event, `section:${x}`); }}
              onClick={(event) => {
                // The Inbox entry always opens the task list, also while the mail tab is shown.
                if (x === "Inbox") setInboxTab("tasks");
                navigateToView(destination, event.currentTarget, planPreview);
              }}
              key={x}
            >
              <span className="navLabel"><span aria-hidden="true"><ViewIcon name={planPreview ? "MyPlanPreview" : mobileDesignV1Preview && x === "Today" ? "TodayV1" : x} /></span>{planPreview ? (language === "cs" ? "Můj plán" : "My Plan") : tr(x)}</span>
              {x === "Inbox" || x === "Today" ? (
                <span className="navCount">{sidebarCounts[x]}</span>
              ) : null}
              {x === "Projects" && projectsAttention ? (
                <><span className="navDot" data-nav-attention="Projects" aria-hidden="true" /><span className="srOnly">{tr("projectsNeedAttention")}</span></>
              ) : null}
            </button>
          );})}
        </nav>
        {/* Legacy aggregate has no direct project list: this preview never infers target ACL or cross-workspace permissions. */}
        {/* In v1, direct destinations come BEFORE the unbounded projects so that
            Areas/Notes/filters remain reachable without crossing 25+ project
            rows. Legacy keeps its old order and collapsed More control. */}
        <div className="sidebarScroll">
        {mobileDesignV1Preview && (
          <div className="secondaryNav" id="sidebar-secondary-views" role="navigation"
            aria-label={tr("moreViews")} data-desktop-v1-direct-views>
            {secondaryViews.map((x) => <button key={x} type="button" className={view === x ? "active" : ""}
              data-nav-view={x} aria-current={view === x ? "page" : undefined}
              onClick={(event) => navigateToView(x, event.currentTarget)}>{tr(x)}</button>)}
          </div>
        )}
        {sidebarProjects.length > 0 && (
          <section className="sidebarProjects" aria-label={tr("sidebarProjects")}>
            {sidebarProjects.map((project) => (
              <button
                type="button"
                key={project.id}
                className={`${dragTarget === `entity:${project.id}` ? "dropActive" : ""} ${mobileDesignV1Preview && app.openProject?.id === project.id ? "active" : ""}`.trim()}
                aria-current={mobileDesignV1Preview && app.openProject?.id === project.id ? "page" : undefined}
                data-current-project={mobileDesignV1Preview && app.openProject?.id === project.id ? "true" : undefined}
                data-sidebar-project={project.id}
                data-project-open={project.id}
                title={project.title || tr("untitledItem")}
                data-drop-entity={project.id}
                onDragEnter={() => setActiveDragTarget(`entity:${project.id}`)}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
                onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}
                onClick={() => void inspect(project)}
              >
                <span aria-hidden="true"><ProjectIcon /></span>
                <span className="sidebarProjectTitle">{project.title || tr("untitledItem")}</span>
              </button>
            ))}
          </section>
        )}
        {!mobileDesignV1Preview && secondaryOpen && (
          <div className="secondaryNav" id="sidebar-secondary-views" ref={secondaryRef}>
            {secondaryViews.map((x) => <button key={x} className={view === x ? "active" : ""} onClick={() => { setView(x); closeDetail(); }}>{tr(x)}</button>)}
          </div>
        )}
        </div>
        <footer className="sidebarActions">
          {/* The FAB is the normal desktop entry point. With a nonmodal
              inspector open it is hidden to keep the inspector unobstructed,
              so provide a fixed, keyboard-accessible sidebar entry instead.
              Legacy sidebar controls remain unchanged when preview is off. */}
          {mobileDesignV1Preview && app.selected && (
            <button type="button" className="desktopInspectorCapture"
              data-desktop-inspector-capture
              aria-label={tr("quickCapture")}
              disabled={Boolean(app.capture || app.assistantOpen || app.moreOpen || app.confirmRequest)}
              onClick={() => openCapture()}>
              ＋ {tr("new")}
            </button>
          )}
          {!mobileDesignV1Preview && (
            <>
              <button onClick={() => openCapture()} aria-label={tr("addTask")}>
                ＋ {tr("new")}
              </button>
              <button type="button" className="secondaryNavToggle" aria-expanded={secondaryOpen} aria-controls="sidebar-secondary-views" onClick={() => setSecondaryOpen((open) => !open)}>
                <span aria-hidden="true">{secondaryOpen ? "▾" : "▸"}</span> {tr("moreViews")}
              </button>
            </>
          )}
          <button
            className={view === "Settings" ? "active" : ""}
            onClick={(event) => navigateToView("Settings", event.currentTarget)}
          >
            ⚙ {tr("Settings")}
          </button>
        </footer>
      </aside>
    </>
  );
}
