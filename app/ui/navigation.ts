export const views = [
    "Home",
    "Inbox",
    "Today",
    "Upcoming",
    "Projects",
    "Areas",
    "Notes",
    "Calendar",
    "Search",
    "Overdue",
    "Anytime",
    "Someday",
    "Completed",
    "Context",
    "Agents",
  ];
// Owner decision 2026-10-22: Areas, Notes and Search leave the primary list (Areas are groups of Projects,
// Search is the topbar field and ⌘K); they stay one click away under "More views".
export const primaryViews = ["Home", "Inbox", "Today", "Upcoming", "Projects", "Calendar"];
export const secondaryViews = ["Areas", "Notes", "Overdue", "Anytime", "Someday", "Completed", "Context", "Agents"];
// UI-03f: opt-in desktop navigation treats My Plan as a preview-only presentation,
// not a third data scope or the legacy Today list. Production keeps primaryViews.
export const desktopV1PrimaryViews = ["MyPlanPreview", ...primaryViews] as const;
// One source of truth for grouped mobile menu and active-view detection.
export const mobileMoreGroups: { title: string; views: string[] }[] = [
  // Owner decision 2026-10-23: Search is the field at the top of every screen, not a menu item.
  { title: "mobileMorePlanning", views: ["Calendar", "Upcoming", "Areas", "Notes"] },
  { title: "mobileMoreFilters", views: ["Overdue", "Anytime", "Someday", "Completed"] },
  { title: "mobileMoreSystem", views: ["Context", "Agents", "Settings"] },
];
export const moreViews = mobileMoreGroups.flatMap((group) => group.views);
export const viewIcons: Record<string, string> = {
  Home: "⌂",
  Inbox: "↓",
  Today: "○",
  Overdue: "!",
  Upcoming: "→",
  Anytime: "•",
  Someday: "☾",
  Completed: "✓",
  Areas: "◎",
  Notes: "▤",
  Calendar: "▦",
  Search: "⌕",
  Context: "◫",
  Agents: "◇",
  Settings: "⚙",
  More: "•••",
};
// Owner decision 2026-10-22: the mobile bar swaps Calendar for Projects; Calendar moves to the "More" sheet.
export const mobileViews = ["Home", "Inbox", "Today", "Projects", "More"];

// UI-02a: opt-in visual/navigation preview of the approved 2026-11-04
// four-tab mobile shell. This is NOT the authorized My Plan data scope:
// until UI-09/R3 the first tab explicitly previews the legacy Today list.
// Production stays on the existing navigation when the flag is absent.
export const mobileDesignV1Preview = process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW === "1";
export const mobileV1Tabs = ["MyPlanPreview", "Calendar", "Projects", "More"] as const;
export const mobileV1MoreGroups: { title: string; views: string[] }[] = [
  { title: "mobileMorePlanning", views: ["Home", "Inbox", "Today", "Upcoming", "Notes", "Areas"] },
  { title: "mobileMoreFilters", views: ["Overdue", "Anytime", "Someday", "Completed"] },
  { title: "mobileMoreSystem", views: ["Context", "Agents", "Settings"] },
];
export const mobileV1MoreViews = mobileV1MoreGroups.flatMap((group) => group.views);
export function mobileV1Destination(tab: (typeof mobileV1Tabs)[number]): string | null {
  return tab === "More" ? null : tab === "MyPlanPreview" ? "Today" : tab;
}

/** A development-only view URL, not a new data scope or a record locator. */
export function mobileV1IsPlanPreviewRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  return [...params.keys()].length === 1 && params.get("view") === "MyPlanPreview";
}
