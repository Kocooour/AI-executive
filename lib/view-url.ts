// A view-only address contains no record ID or search text. UI-01 adds typed
// opaque record targets below; neither view nor record IDs grant data access.

const parameter = "view";

// R3-FE-3: the one global reading scope (Vše / Osobní / Sdílené) lives in the
// address as `scope`. It only selects which server query is made; it is never an
// authorization claim. Default (all) is omitted, invalid values read as default.
export type UrlScope = "all" | "personal" | "shared";
const scopeParameter = "scope";
export const urlScopes: readonly UrlScope[] = ["all", "personal", "shared"];
export const defaultUrlScope: UrlScope = "all";

export function scopeFromSearch(search: string): UrlScope {
  const values = new URLSearchParams(search).getAll(scopeParameter);
  // A duplicated or unknown value is ambiguous: read it as the default.
  return values.length === 1 && urlScopes.includes(values[0] as UrlScope) ? (values[0] as UrlScope) : defaultUrlScope;
}

/** The same address with `scope` replaced (default removed); all other keys keep their order. */
export function searchWithScope(search: string, scope: UrlScope): string {
  const params = new URLSearchParams(search);
  const wanted = scope !== defaultUrlScope && urlScopes.includes(scope);
  // Untouched when nothing changes, so other keys keep their exact spelling.
  if (!params.has(scopeParameter)) {
    if (!wanted) return search;
    return `${search.startsWith("?") && search.length > 1 ? search + "&" : "?"}${scopeParameter}=${scope}`;
  }
  params.delete(scopeParameter);
  if (wanted) params.set(scopeParameter, scope);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Address without the scope key: scope is orthogonal to view and record targets. */
export function searchWithoutScope(search: string): string {
  return searchWithScope(search, defaultUrlScope);
}

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
  // R3-FE-3: a view change keeps the shared reading scope of the current address.
  const search = searchWithScope(searchForView(input.view, input.startView), scopeFromSearch(input.currentSearch));
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
  // The scope key is orthogonal to the navigation target (R3-FE-3).
  const params = new URLSearchParams(searchWithoutScope(search));
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

export function searchForTarget(target: NavigationTarget, startView: string, knownViews: readonly string[]): string {
  // The serializer and parser must use the same route vocabulary. Unknown
  // views, malformed IDs and impossible parent/view combinations are errors,
  // not links that silently fail when later opened.
  if (!knownViews.includes(startView)) throw new TypeError("Invalid startup view");
  if (target.kind === "view") {
    if (!knownViews.includes(target.view)) throw new TypeError("Unknown navigation view");
    return searchForView(target.view, startView);
  }
  if (!isOpaqueId(target.id)) throw new TypeError("Invalid navigation target ID");
  if (target.kind === "project" && !knownViews.includes("Projects")) throw new TypeError("Unknown Projects view");
  if (target.kind !== "project" && !knownViews.includes(target.view)) throw new TypeError("Unknown navigation view");
  const params = new URLSearchParams();
  if (target.kind === "project") {
    params.set("view", "Projects");
    params.set("projectId", target.id);
  } else {
    if (target.projectId !== undefined &&
        (target.view !== "Projects" || !isOpaqueId(target.projectId)))
      throw new TypeError("Project context requires the Projects view and a valid project ID");
    // Keep the canonical order stable for copyable URLs and browser history:
    // view first, optional project parent, then the selected record.
    params.set("view", target.view);
    if (target.projectId !== undefined) params.set("projectId", target.projectId);
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
  return { search: searchWithScope(searchForView(input.nextView, input.startView), scopeFromSearch(input.currentSearch)), mode: "push" };
}
