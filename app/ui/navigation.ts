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
// One source of truth for grouped mobile menu and active-view detection.
export const mobileMoreGroups: { title: string; views: string[] }[] = [
  { title: "mobileMorePlanning", views: ["Calendar", "Upcoming", "Areas", "Notes", "Search"] },
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
export const mobileViews = ["Home", "Inbox", "Today", "Projects", "More"];
