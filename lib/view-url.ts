// The address carries the open view and nothing else: never a workspace, a record id or a search
// text. The view the app starts on is left out, so the plain address keeps meaning "start".

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
