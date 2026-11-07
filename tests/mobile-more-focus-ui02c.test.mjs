import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mobileMoreExitFocus, mobileMoreHeadingRevealDelta } from "../lib/mobile-more-focus.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("UI-02c: dismissing More returns focus to the opener", () => {
  assert.equal(mobileMoreExitFocus(null, "Projects", false, true), "trigger");
  assert.equal(mobileMoreExitFocus(null, "Today", true, true), "trigger");
});

test("UI-02c: only the chosen live mobile destination may receive focus", () => {
  assert.equal(mobileMoreExitFocus("Settings", "Settings", false, true), "destination");
  assert.equal(mobileMoreExitFocus("Today", "Today", false, true), "destination");
  assert.equal(mobileMoreExitFocus("Settings", "Projects", false, true), "none");
  assert.equal(mobileMoreExitFocus("Settings", "Settings", true, true), "none");
  assert.equal(mobileMoreExitFocus("Settings", "Settings", false, false), "none");
});

test("UI-02c: focus reveal respects sticky toolbar and bottom navigation", () => {
  const reveal = mobileMoreHeadingRevealDelta;
  assert.equal(reveal(135, 176, 112, 750), 0, "already visible: no scroll");
  assert.equal(reveal(-420, -370, 112, 750), -532, "scrolled page above topbar");
  assert.equal(reveal(790, 830, 112, 750), 678, "heading below bottom navigation");
  assert.equal(reveal(95, 140, 112, 750), -17, "partially covered by toolbar");
  assert.equal(reveal(NaN, 200, 112, 750), 0, "invalid geometry never scrolls");
  assert.equal(reveal(900, 950, 780, 750), 0, "non-visible viewport never scrolls");
});

test("UI-02c: preview-only More selection and modal cleanup use the same decision", () => {
  const app = read("../app/ui/use-lumi-app.tsx");
  const nav = read("../app/ui/views/mobile-nav.tsx");
  const page = read("../app/page.tsx");
  assert.match(app, /function markMobileMoreNavigation\(destination: string\)/);
  assert.match(app, /if \(mobileDesignV1Preview\) moreFocusDestinationRef\.current = destination/);
  assert.match(app, /mobileMoreExitFocus\(destination, currentViewForMoreFocusRef\.current,/);
  assert.match(app, /mobileMoreHeadingRevealDelta\(rect\.top, rect\.bottom,/);
  assert.match(app, /window\.scrollBy\(\{ top: delta, behavior: "instant" \}\)/);
  assert.match(app, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /moreTriggerRef\.current\?\.focus\(\)/);
  assert.match(nav, /markMobileMoreNavigation\(item\);[\s\S]*?setView\(item\);[\s\S]*?setMoreOpen\(false\)/);
  assert.match(page, /<h1 tabIndex=\{mobileDesignV1Preview \? -1 : undefined\}>/);
  assert.match(app, /activeElement !== document\.body && activeElement !== moreTriggerRef\.current/);
});
