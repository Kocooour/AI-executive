// A view-only address contains no record ID or search text. UI-01 adds typed
// opaque record targets below; neither view nor record IDs grant data access.

const parameter = "view";

export function viewFromSearch(search: string, known: readonly string[]): string | null {
  const requested = new URLSearchParams(search).get(parameter);
  return requested && known.includes(requested) ? requested : null;
}

export function searchForView(view: string, startView: string): string {
  return view === startView ? "" : `?${parameter}=${encodeURIComponent(view)}`;
}

// What to do with the address after the view or the start view changed.
// "push" adds a history step (the user navigated), "replace" corrects the current one.
export function addressUpdate(input: { currentSearch: string; view: string; startView: string; navigated: boolean }): { search: string; mode: "push" | "replace" } | null {
  const search = searchForView(input.view, input.startView);
  if (search === input.currentSearch) return null;
  return { search, mode: input.navigated ? "push" : "replace" };
}


// UI-01: a navigation URL identifies the *requested* target, never its permissions.
// A URL is not an authority: consumers must resolve every record in the active,
// authenticated scope and recheck server access when the target adapter is enabled.
export type NavigationTarget =
  | { kind: "view"; view: string }
  | { kind: "project"; id: string }
  | { kind: "task"; id: string; view: string; projectId?: string }
  | { kind: "note"; id: string; view: string; projectId?: string };

function isOpaqueId(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function targetFromSearch(search: string, knownViews: readonly string[], startView: string): NavigationTarget | null {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  const allowed = new Set(["view", "projectId", "taskId", "noteId"]);
  // Unknown/duplicate keys and ambiguous targets must not silently select another record.
  if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return null;
  const view = params.get("view") ?? startView;
  if (!knownViews.includes(view)) return null;
  const projectId = params.get("projectId");
  const taskId = params.get("taskId");
  const noteId = params.get("noteId");
  if ([projectId, taskId, noteId].filter((id) => id !== null).length > 1 && !(projectId && (taskId || noteId) && !(taskId && noteId))) return null;
  if ([projectId, taskId, noteId].some((id) => id !== null && !isOpaqueId(id))) return null;
  if (projectId !== null && view !== "Projects") return null;
  if (taskId !== null) return { kind: "task", id: taskId!, view, ...(projectId === null ? {} : { projectId }) };
  if (noteId !== null) return { kind: "note", id: noteId!, view, ...(projectId === null ? {} : { projectId }) };
  if (projectId !== null) return { kind: "project", id: projectId! };
  return { kind: "view", view };
}

export function searchForTarget(target: NavigationTarget, startView: string): string {
  if (target.kind === "view") return searchForView(target.view, startView);
  // The serializer must not emit an address the parser would reject. In
  // particular, project parent IDs are legal only in the Projects view.
  if (!isOpaqueId(target.id)) throw new TypeError("Invalid navigation target ID");
  const params = new URLSearchParams();
  if (target.kind === "project") {
    params.set("view", "Projects");
    params.set("projectId", target.id);
  } else {
    if (target.projectId !== undefined) {
      if (target.view !== "Projects" || !isOpaqueId(target.projectId))
        throw new TypeError("Project context requires the Projects view and a valid project ID");
      params.set("projectId", target.projectId);
    }
    params.set("view", target.view);
    params.set(target.kind === "task" ? "taskId" : "noteId", target.id);
  }
  return "?" + params.toString();
}


// An explicit view choice while viewing a project must be a *new* history entry.
// It is not a Back action: Back must return to the actual project the user left.
// Only call this for a visible project, never as an authorization decision.
export function viewExitFromProject(input: {
  currentSearch: string; currentProjectId: string | null; nextView: string;
  knownViews: readonly string[]; startView: string;
}): { search: string; mode: "push" } | null {
  if (!input.currentProjectId || !input.knownViews.includes(input.nextView)) return null;
  const current = targetFromSearch(input.currentSearch, input.knownViews, input.startView);
  if (current?.kind !== "project" || current.id !== input.currentProjectId) return null;
  return { search: searchForView(input.nextView, input.startView), mode: "push" };
}
