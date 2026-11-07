// Preview-only desktop sidebar route transitions use their own focus intent.
// Never move keyboard focus after a stale route, a breakpoint switch, a
// production/legacy navigation, or when the user focused another control.
export function desktopSidebarCanFocusDestination(
  destination: string,
  currentView: string,
  designPreview: boolean,
  desktopViewport: boolean,
  openerStillOwnsFocus: boolean,
): boolean {
  return Boolean(destination && destination === currentView &&
    designPreview && desktopViewport && openerStillOwnsFocus);
}
