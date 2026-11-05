/** UI-04b presentation policy only; not an authorization boundary. */
const v1EditableLists = new Set([
  "Today", "Inbox", "Upcoming", "Overdue", "Anytime", "Someday",
  "Completed", "Areas", "Notes", "Projects", "Search",
]);

/** Every legacy work-list reorder operation has a reachable v1 edit toggle. */
export function v1ReorderAvailable(view: string): boolean {
  return v1EditableLists.has(view);
}

export function v1DragHandleVisible(
  view: string, previewEnabled: boolean, editMode: boolean,
): boolean {
  if (!previewEnabled) return true; // Unchanged legacy behavior.
  if (view === "Home" || view === "Calendar") return false;
  return !v1ReorderAvailable(view) || editMode;
}
