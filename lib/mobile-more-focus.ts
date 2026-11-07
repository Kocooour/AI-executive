// A mobile More dismissal returns to its opener; choosing a destination instead
// focuses that view. No stale selection may move focus across another navigation.
export type MobileMoreExitFocus = "trigger" | "destination" | "none";

export function mobileMoreExitFocus(
  selectedDestination: string | null,
  currentView: string,
  dialogStillOpen: boolean,
  isMobile: boolean,
): MobileMoreExitFocus {
  if (selectedDestination === null) return "trigger";
  if (dialogStillOpen || !isMobile || selectedDestination !== currentView) return "none";
  return "destination";
}
