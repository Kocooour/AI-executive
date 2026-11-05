/** UI-04d: one human-readable Calendar status in the opt-in Lumi v1 preview.
 * Selected non-today days have their own explicit completeness message; do not
 * claim today's free capacity for a different date. Connection state wins even
 * when a stale cached day was selected.
 */
export type CalendarV1SurfaceState = "disconnected" | "selected-day" | "fresh" | "stale";

export function calendarV1SurfaceState({
  connectedSources, fresh, selectedOtherDay,
}: {
  connectedSources: number;
  fresh: boolean;
  selectedOtherDay: boolean;
}): CalendarV1SurfaceState {
  if (!Number.isFinite(connectedSources) || connectedSources <= 0) return "disconnected";
  if (selectedOtherDay) return "selected-day";
  return fresh ? "fresh" : "stale";
}


/** A manual refresh error belongs to the exact workspace, screen visit and
 * load generation that produced it. A newer successful background load must
 * always suppress an older failure, even if its result data looks identical.
 */
export interface CalendarV1RefreshFailure {
  workspaceId: string;
  requestVersion: number;
  contextEpoch: number;
}

export function calendarV1RefreshFailureVisible(
  failure: CalendarV1RefreshFailure | null,
  current: {
    workspaceId: string;
    requestVersion: number;
    successVersion: number;
    contextEpoch: number;
    view: string;
    authenticated: boolean;
  },
): boolean {
  return failure !== null && current.authenticated && current.view === "Calendar" &&
    failure.workspaceId === current.workspaceId &&
    failure.contextEpoch === current.contextEpoch &&
    failure.requestVersion === current.requestVersion &&
    failure.requestVersion > current.successVersion;
}
