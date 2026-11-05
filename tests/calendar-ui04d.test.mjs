import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calendarV1SurfaceState } from "../lib/calendar-ui04d.ts";
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
  assert.match(src, /\{previewCalendar && previewRefreshFailed && <p role="alert" data-calendar-v1-refresh-failed>/);
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
