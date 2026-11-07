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

// The focus target may retain the previous view's document scroll position.
// Reveal it below the sticky topbar without relying on focus to scroll, so a
// later focus change cannot hide the heading again.
export function mobileMoreHeadingRevealDelta(
  headingTop: number,
  headingBottom: number,
  safeTop: number,
  safeBottom: number,
): number {
  if (![headingTop, headingBottom, safeTop, safeBottom].every(Number.isFinite) ||
      safeBottom <= safeTop) return 0;
  return headingTop < safeTop || headingBottom > safeBottom ? headingTop - safeTop : 0;
}
