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
