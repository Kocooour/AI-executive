import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitUntilSynced } from "./helpers";
import { addCalendarDays } from "../lib/calendar-event-display";
import { zonedDateTimeToIso } from "../lib/local-dates";

const zone = "Europe/Prague";
const today = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
async function mockDays(page: Page, dates: string[]) {
  const now = Date.now();
  const events = dates.map((day, i) => ({
    id: `ui04a-${i}`, uid: `ui04a-${i}`, title: `Událost dne ${i}`,
    start: zonedDateTimeToIso(day, "10:00", zone), end: zonedDateTimeToIso(day, "11:00", zone),
    sourceId: "ui04a-source", workspaceId: "personal", occurrenceKey: `ui04a-${i}`,
    recurring: false, allDay: false, timezone: zone, status: "confirmed",
    transparency: "OPAQUE", busy: true, private: false,
  }));
  await page.route("**/api/calendar?**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      sources: [{ id: "ui04a-source", workspaceId: "personal", provider: "ics", accountId: null,
        label: "E2E", status: "ready", configured: true, lastSyncAt: now, lastSuccessAt: now,
        lastError: "", eventCount: events.length, revision: 1 }],
      events,
    }) });
  });
}

test("phone day bubbles select one civil day, mute earlier dates and never reuse today's capacity", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  const base = today(), past = addCalendarDays(base, -1), next = addCalendarDays(base, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDays(page, [past, base, next]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  const picker = page.locator(".mobileCalendarPicker");
  await expect(picker).toBeVisible();
  await expect(page.locator(".mobileCalendarDay")).toBeVisible();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", base);
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-0"]')).toHaveCount(0);
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toHaveCount(0);
  await expect(picker.locator(`[data-date="${past}"]`)).toHaveAttribute("data-past", "true");

  await picker.locator(`[data-date="${next}"]`).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", next);
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toHaveCount(0);
  await expect(page.getByText(/Jiný než dnešní den|Outside today/)).toBeVisible();
  await expect(page.locator(".calendarFreshness")).not.toContainText(/voln|free hours/i);

  await picker.locator(`[data-date="${past}"]`).click();
  const selectedPast = picker.locator(`[data-date="${past}"]`);
  await expect(selectedPast).toHaveAttribute("aria-pressed", "true");
  await expect(selectedPast).not.toHaveAttribute("data-past", "true");
  expect(await selectedPast.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(139, 92, 246)");
  await expect(page.locator('[data-timeline-item="event:ui04a-0"]')).toBeVisible();
  await expect(page.locator('[data-timeline-item="event:ui04a-2"]')).toHaveCount(0);

  await picker.getByRole("button", { name: /Dnes|Today/ }).click();
  await expect(page.locator('[data-mobile-calendar-day]')).toHaveAttribute("data-mobile-calendar-day", base);
  await expect(page.locator('[data-timeline-item="event:ui04a-1"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("the gated calendar keeps the desktop overview and future agenda intact", async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW !== "1", "Mobile design preview disabled");
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockDays(page, [today(), addCalendarDays(today(), 1)]);
  await page.goto("/?view=Calendar");
  await waitUntilSynced(page);
  await expect(page.locator(".mobileCalendarPicker")).toHaveCount(0);
  await expect(page.locator("#calendar-today-title")).toBeVisible();
  await expect(page.locator("#calendar-near-term-title")).toBeVisible();
});
