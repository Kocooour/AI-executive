import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { desktopSidebarCanFocusDestination } from "../lib/desktop-sidebar-focus.ts";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("UI-03e only a committed preview desktop sidebar destination owns focus", () => {
  const can = desktopSidebarCanFocusDestination;
  assert.equal(can("Calendar", "Calendar", true, true, true), true);
  assert.equal(can("Settings", "Settings", true, true, true), true);
  assert.equal(can("Notes", "Today", true, true, true), false, "stale route");
  assert.equal(can("Notes", "Notes", false, true, true), false, "legacy unchanged");
  assert.equal(can("Notes", "Notes", true, false, true), false, "mobile unchanged");
  assert.equal(can("Notes", "Notes", true, true, false), false, "user owns new focus");
  assert.equal(can("", "", true, true, true), false, "missing destination");
});

test("UI-03e route intent is limited to explicit sidebar navigation", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const page = read("../app/page.tsx");
  assert.match(sidebar, /desktopSidebarCanFocusDestination\(/);
  assert.match(sidebar, /pendingDesktopNavigationRef\.current/);
  assert.match(sidebar, /window\.requestAnimationFrame\(/);
  assert.match(sidebar, /window\.cancelAnimationFrame\(/);
  assert.match(sidebar, /mobileMoreHeadingRevealDelta\(/);
  assert.match(sidebar, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sidebar, /navigateToView\(x, event\.currentTarget\)/);
  assert.match(sidebar, /navigateToView\("Settings", event\.currentTarget\)/);
  assert.match(page, /<h1 tabIndex=\{mobileDesignV1Preview \? -1 : undefined\}>/);
});
