"use client";
import type { LumiApp } from "../use-lumi-app";
import { mobileDesignV1Preview } from "../navigation";
import { WorkspaceTile, workspaceTone } from "../workspace-appearance";
import {TARGET_MAIN_SEARCH_SUBMIT_EVENT} from "../../../lib/target-main-title-search-ui";

export function Topbar({ app, targetSearch = false }: { app: LumiApp; targetSearch?: boolean }) {
  const {
    activeWorkspaceId,
    activeWorkspaceTone,
    query,
    resolvedTheme,
    saveTheme,
    selectWorkspace,
    setAssistantOpen,
    setQuery,
    setView,
    setWorkspaceMenuOpen,
    tr,
    workspaceMenuOpen,
    workspaceName,
    workspaces,
  } = app;
  return (
    <>
        <header className="topbar">
          <button
            className="mobileWorkspaceButton"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-label={tr("switchWorkspace")}
            aria-expanded={workspaceMenuOpen}
          >
            <WorkspaceTile tone={activeWorkspaceTone} label={workspaceName} />
            <b className="mobileWorkspaceName">{workspaceName}</b><span className="workspaceChevron" aria-hidden="true">⌄</span>
          </button>
          {workspaceMenuOpen && (
            <div className="mobileWorkspaceMenu workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={activeWorkspaceId === workspace.workspaceId ? "active" : ""}
                  data-workspace-id={workspace.workspaceId}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  <WorkspaceTile tone={workspaceTone(workspace.workspaceId, workspace)} label={workspace.title} />
                  <span className="workspaceOptionName">{workspace.title}</span>
                </button>
              ))}
              <button className={activeWorkspaceId === "all" ? "active" : ""} data-workspace-id="all" onClick={() => selectWorkspace("all")}><WorkspaceTile tone="all" label={tr("allWork")} /><span className="workspaceOptionName">{tr("allWork")}</span></button>
            </div>
          )}
          <label className="searchField">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setView("Search")}
              onKeyDown={(event) => {
                if(targetSearch && event.key==="Enter"){
                  event.preventDefault();
                  window.dispatchEvent(new Event(TARGET_MAIN_SEARCH_SUBMIT_EVENT));
                }
              }}
              placeholder={tr("search")}
              aria-label={tr("search")}
            />
            <kbd>⌘ K</kbd>
          </label>
          {!mobileDesignV1Preview && (
            <button
              className="themeToggle"
              type="button"
              aria-label={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
              title={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
              onClick={() => saveTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              <span aria-hidden="true">{resolvedTheme === "dark" ? "☀" : "☾"}</span>
            </button>
          )}
          <button
            className="aiButton"
            onClick={() => setAssistantOpen(true)}
            aria-label={tr("askAi")}
            title={`${tr("askAi")} · ⌘⇧L`}
          >
            <img className="aiButtonIcon" src="/icons/lumi-icon-v3-192.png" width="20" height="20" alt="" />
            <span className="aiButtonLabel">{tr("askAi")}</span>
          </button>
        </header>
    </>
  );
}
