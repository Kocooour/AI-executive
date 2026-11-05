import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calendarV1RefreshFailureVisible, calendarV1SurfaceState } from "../lib/calendar-ui04d.ts";
import { mobileCalendarStripDays } from "../lib/mobile-calendar-day.ts";

const textOf = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("UI-04d: source disconnection overrides all cached freshness and selected-day states", () => {
  assert.equal(calendarV1SurfaceState({ connectedSources: 0, fresh: true, selectedOtherDay: false }), "disconnected");
  assert.equal(calendarV1SurfaceState({ connectedSources: 0, fresh: true, selectedOtherDay: true }), "disconnected");
  assert.equal(calendarV1SurfaceState({ connectedSources: -1, fresh: false, selectedOtherDay: true }), "disconnected");
  assert.equal(calendarV1SurfaceState({ connectedSources: NaN, fresh: false, selectedOtherDay: false }), "disconnected");
});

test("UI-04d: remote day never claims today's capacity, stale source never claims fresh hours", () => {
  assert.equal(calendarV1SurfaceState({ connectedSources: 1, fresh: true, selectedOtherDay: true }), "selected-day");
  assert.equal(calendarV1SurfaceState({ connectedSources: 1, fresh: false, selectedOtherDay: true }), "selected-day");
  assert.equal(calendarV1SurfaceState({ connectedSources: 1, fresh: true, selectedOtherDay: false }), "fresh");
  assert.equal(calendarV1SurfaceState({ connectedSources: 2, fresh: false, selectedOtherDay: false }), "stale");
});

test("UI-04d: v1 calendar has a single human status, no raw timezone or duplicate stale source diagnostics", () => {
  const src = textOf("../app/ui/views/calendar-view.tsx");
  assert.match(src, /const previewCalendar = mobileDesignV1Preview/);
  assert.match(src, /const v1Status = calendarV1SurfaceState\(\{/);
  assert.match(src, /selectedOtherDay: remoteDay/);
  assert.match(src, /data-calendar-v1-status=\{v1Status\}/);
  assert.match(src, /v1Status === "selected-day" \? null/);
  assert.match(src, /v1Status === "stale" \? `\$\{tr\("calendarStale"\)\} \$\{tr\("freeWindowsAreHidden"\)\}`/);
  assert.match(src, /\{previewCalendar \? \([\s\S]*?\) : \(\s*<>\s*<p className="attentionMeta">\{tr\("sourceConnectedReadOnly"\)\} · \{calendarTimezone\}/);
  assert.match(src, /\{!previewCalendar && calendarStatus && <p role="status">\{calendarStatus\}<\/p>\}/);
  assert.match(src, /\{previewCalendar && showPreviewRefreshFailure && <p role="alert" data-calendar-v1-refresh-failed>/);
  assert.match(src, /shownDay !== calendarToday && <p role="status" className="attentionMeta">/);
  // The legacy fallback still shows the historical connection diagnostics.
  assert.match(src, /\{calendarSources\.map\(\(source\) => <p className="attentionMeta"/);
});

test("UI-04d: one Today button and accessible swipeable day bubbles replace week arrows", () => {
  const strip = textOf("../app/ui/views/mobile-calendar-date-strip.tsx");
  assert.doesNotMatch(strip, /mobileCalendarWeekJump|Předchozí týden|Následující týden/);
  assert.match(strip, /data-calendar-v1-today-jump/);
  assert.match(strip, /aria-label=\{cs \? "Přejít na dnešek" : "Go to today"\}/);
  assert.match(strip, /className="mobileCalendarDateStrip" ref=\{stripRef\}/);
  assert.match(strip, /aria-pressed=\{active\}/);
  assert.match(strip, /data-past=\{past && !active \? "true" : undefined\}/);
  // Recentered strip expands the scrollable dates as edge dates are selected.
  const first = mobileCalendarStripDays("2026-11-05");
  const edge = first.at(-1);
  assert.ok(first.includes("2026-11-05"));
  assert.ok(mobileCalendarStripDays(edge).some(day => day > edge));
});

test("UI-04d: opt-in mobile Calendar reserves clear space and focus scroll around Quick Capture", () => {
  const css = textOf("../app/lumi-calendar-v1.css");
  const layout = textOf("../app/layout.tsx");
  assert.match(layout, /import "\.\/lumi-calendar-v1\.css"/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\]\.view-calendar \.calendarView/);
  assert.match(css, /padding-block-end: calc\(116px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /scroll-margin-block-end: calc\(152px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.mobileCalendarPickerHead\s*\{\s*justify-content: flex-end/);
});


test("UI-04d: A refresh failure cannot follow the user into B after B loads successfully", () => {
  const failureA = { workspaceId: "personal-A", requestVersion: 7, contextEpoch: 2 };
  const current = {
    workspaceId: "personal-A", requestVersion: 7, successVersion: 6,
    contextEpoch: 2, view: "Calendar", authenticated: true,
  };
  assert.equal(calendarV1RefreshFailureVisible(failureA, current), true);
  assert.equal(calendarV1RefreshFailureVisible(failureA, {
    ...current, workspaceId: "shared-B", contextEpoch: 3, requestVersion: 8, successVersion: 8,
  }), false);
  assert.equal(calendarV1RefreshFailureVisible(failureA, {
    ...current, workspaceId: "personal-A", contextEpoch: 4, requestVersion: 9, successVersion: 9,
  }), false, "even returning to A must not revive the old error");
});

test("UI-04d: older overlapping refresh failure cannot overwrite newer successful fetch", () => {
  const earlier = { workspaceId: "personal", requestVersion: 11, contextEpoch: 3 };
  const newest = { workspaceId: "personal", requestVersion: 12, contextEpoch: 3 };
  const current = {
    workspaceId: "personal", requestVersion: 12, successVersion: 12,
    contextEpoch: 3, view: "Calendar", authenticated: true,
  };
  assert.equal(calendarV1RefreshFailureVisible(earlier, current), false);
  assert.equal(calendarV1RefreshFailureVisible(newest, current), false);
  assert.equal(calendarV1RefreshFailureVisible(newest, {
    ...current, successVersion: 10,
  }), true, "only a failed latest request may appear");
  assert.equal(calendarV1RefreshFailureVisible(earlier, {
    ...current, successVersion: 10,
  }), false);
});

test("UI-04d: successful background reload clears error; navigation and auth changes invalidate it", () => {
  const failure = { workspaceId: "personal", requestVersion: 6, contextEpoch: 5 };
  const current = {
    workspaceId: "personal", requestVersion: 6, successVersion: 4,
    contextEpoch: 5, view: "Calendar", authenticated: true,
  };
  assert.equal(calendarV1RefreshFailureVisible(failure, current), true);
  assert.equal(calendarV1RefreshFailureVisible(failure, {
    ...current, requestVersion: 7, successVersion: 7,
  }), false);
  assert.equal(calendarV1RefreshFailureVisible(failure, { ...current, view: "Settings" }), false);
  assert.equal(calendarV1RefreshFailureVisible(failure, { ...current, contextEpoch: 6 }), false);
  assert.equal(calendarV1RefreshFailureVisible(failure, { ...current, authenticated: false }), false);
  assert.equal(calendarV1RefreshFailureVisible(null, current), false);
});

test("UI-04d: generation tracking follows accepted app reads, not stale responses", () => {
  const app = textOf("../app/ui/use-lumi-app.tsx");
  const ui = textOf("../app/ui/views/calendar-view.tsx");
  assert.match(app, /const loadVersion = \+\+calendarLoadVersion\.current/);
  assert.match(app, /if \(loadVersion !== calendarLoadVersion\.current \|\| calendarWorkspaceSelection\.current !== workspaceId\) return/);
  assert.match(app, /setCalendarLoadSucceededVersion\(loadVersion\)/);
  assert.match(app, /getCalendarLoadGeneration: \(\) => calendarLoadVersion\.current/);
  assert.match(ui, /const \[previewRefreshFailure, setPreviewRefreshFailure\]/);
  assert.match(ui, /refreshContextEpoch\.current \+= 1/);
  assert.match(ui, /\}, \[workspaceId, view, authState\]\)/);
  assert.match(ui, /calendarV1RefreshFailureVisible\(previewRefreshFailure, \{/);
  assert.match(ui, /const request = loadCalendar\(workspaceId\)/);
  assert.match(ui, /const requestVersion = getCalendarLoadGeneration\(\)/);
  assert.match(ui, /refreshContextEpoch\.current !== contextEpoch/);
  assert.match(ui, /calendarWorkspaceSelection\.current !== workspaceId/);
  assert.match(ui, /getCalendarLoadGeneration\(\) !== requestVersion/);
  assert.match(ui, /setPreviewRefreshFailure\(\{ workspaceId, requestVersion, contextEpoch \}\)/);
  assert.doesNotMatch(ui, /setPreviewRefreshFailed\(true\)/);
});
