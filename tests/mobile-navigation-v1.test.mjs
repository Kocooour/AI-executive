import assert from "node:assert/strict";
import test from "node:test";

const { mobileViews, mobileMoreGroups, mobileV1Tabs, mobileV1MoreGroups,
  mobileV1MoreViews, mobileV1Destination, mobileV1IsPlanPreviewRoute,
  primaryViews, desktopV1PrimaryViews } = await import("../app/ui/navigation.ts");

test("approved v1 preview has exactly four mobile tabs in the agreed order", () => {
  assert.deepEqual([...mobileV1Tabs], ["MyPlanPreview", "Calendar", "Projects", "More"]);
  assert.deepEqual(mobileV1Tabs.map(mobileV1Destination), ["Today", "Calendar", "Projects", null]);
  assert.equal(new Set(mobileV1Tabs).size, 4);
  assert.equal(mobileV1Tabs.includes("Search"), false);
});

test("secondary destinations are accessible in More; search stays topbar-only", () => {
  assert.deepEqual(mobileV1MoreGroups.map((group) => group.title),
    ["mobileMorePlanning", "mobileMoreFilters", "mobileMoreSystem"]);
  for (const item of ["Home", "Inbox", "Today", "Upcoming", "Notes", "Areas",
    "Overdue", "Anytime", "Someday", "Completed", "Context", "Agents", "Settings"]) {
    assert.ok(mobileV1MoreViews.includes(item), item);
  }
  assert.equal(mobileV1MoreViews.includes("Search"), false);
  assert.equal(new Set(mobileV1MoreViews).size, mobileV1MoreViews.length);
});

test("existing production navigation remains unchanged when preview is not enabled", () => {
  assert.deepEqual(mobileViews, ["Home", "Inbox", "Today", "Projects", "More"]);
  assert.equal(mobileMoreGroups.flatMap((group) => group.views).includes("Calendar"), true);
});

test("the preview-only route cannot be confused with Today or record URLs", () => {
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview"), true);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=Today"), false);
  assert.equal(mobileV1IsPlanPreviewRoute(""), false);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview&taskId=id"), false);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview&view=Today"), false);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview&other=1"), false);
});

test("UI-03f desktop preview adds My Plan as a distinct first destination without changing legacy", () => {
  assert.deepEqual([...desktopV1PrimaryViews], ["MyPlanPreview", ...primaryViews]);
  assert.equal(desktopV1PrimaryViews[0], "MyPlanPreview");
  assert.equal(desktopV1PrimaryViews.filter((view) => view === "Today").length, 1);
  assert.equal(primaryViews.includes("MyPlanPreview"), false);
  assert.equal(new Set(desktopV1PrimaryViews).size, desktopV1PrimaryViews.length);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=MyPlanPreview"), true);
  assert.equal(mobileV1IsPlanPreviewRoute("?view=Today"), false);
});
