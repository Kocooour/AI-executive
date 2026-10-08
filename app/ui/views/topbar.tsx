"use client";
import type { LumiApp } from "../use-lumi-app";

export function Topbar({ app }: { app: LumiApp }) {
  const {
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
          >
            {workspaceName}⌄
          </button>
          {workspaceMenuOpen && (
            <div className="mobileWorkspaceMenu workspaceMenu">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => selectWorkspace(workspace.workspaceId)}
                >
                  {workspace.title}
                </button>
              ))}
              <button onClick={() => selectWorkspace("all")}>{tr("allWork")}</button>
            </div>
          )}
          <label className="searchField">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setView("Search")}
              placeholder={tr("search")}
              aria-label={tr("search")}
            />
            <kbd>⌘ K</kbd>
          </label>
          <button
            className="themeToggle"
            type="button"
            aria-label={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
            title={resolvedTheme === "dark" ? tr("switchLight") : tr("switchDark")}
            onClick={() => saveTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            <span aria-hidden="true">{resolvedTheme === "dark" ? "☀" : "☾"}</span>
          </button>
          <button
            className="aiButton"
            onClick={() => setAssistantOpen(true)}
            aria-label={tr("askAi")}
            title={`${tr("askAi")} · ⌘⇧L`}
          >
            ◇ {tr("askAi")}
          </button>
        </header>
    </>
  );
}
