/** C15 / #425: actual navigation, not an injected PageTransitionEvent.
 * Every request (except one explicitly failed-response test below) reaches real
 * target route handlers backed by the isolated personal-v1 SQLite store.
 * This opt-in spec never runs against live data or a fixture-only HTTP mock. */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(process.env.LUMI_TARGET_PERSONAL_ACCEPTANCE_E2E !== "true",
  "Requires the isolated personal-v1 real-store acceptance instance");

type Store = { seed: { areaTitle: string } };
const store = JSON.parse(process.env.LUMI_E2E_TARGET_STORE || "null") as Store | null;
const strictRealHit = process.env.LUMI_REAL_BFCACHE_E2E === "true";
const fab = (page: Page, width: number) =>
  page.locator('[data-target-private-capture-fab="' + (width === 390 ? "mobile" : "desktop") + '"]');
const taskForm = (page: Page) => page.getByTestId("target-private-task-form");
const titleBox = (page: Page) => taskForm(page).getByRole("textbox", { name: "Název úkolu" });

async function openTask(page: Page, width: number) {
  if (!store) throw new Error("Missing real isolated personal-v1 store");
  await fab(page, width).click();
  await page.getByTestId("target-capture-task-kind").click();
  await expect(page.getByTestId("target-private-task-area")).toBeVisible();
  return page.getByTestId("target-private-task-capture");
}
async function draft(page: Page, width: number, title: string) {
  await openTask(page, width);
  await page.getByTestId("target-private-task-area").selectOption({ label: store!.seed.areaTitle });
  await titleBox(page).fill(title);
}
const storageSnapshot = (page: Page) => page.evaluate(() =>
  JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
const privateDOM = (page: Page, needle: string) => page.evaluate(secret => {
  const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"));
  const selectedArea = document.querySelector<HTMLSelectElement>('[data-testid="target-private-task-area"]');
  return {
    titleExposed: fields.some(field => field.value.includes(secret)) ||
      (document.body.textContent || "").includes(secret),
    selectedArea: selectedArea?.value ?? null,
  };
}, needle);
function observeTarget(page: Page) {
  const responses: string[] = [];
  let creates = 0;
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/target-staging/tasks" && request.method() === "POST") creates++;
  });
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path === "/api/target-staging/session" ||
        path === "/api/target-staging/notes/create-targets") {
      responses.push(response.request().method() + " " + path + " " + response.status());
    }
  });
  return { responses, get creates() { return creates; } };
}
async function assertEmptyDraft(page: Page, title: string, observedCreates: () => number) {
  const snapshot = await privateDOM(page, title);
  expect(snapshot.titleExposed, "private text must not survive navigation").toBe(false);
  expect(["", null], "old private Area must not survive navigation").toContain(snapshot.selectedArea);
  expect(await storageSnapshot(page)).not.toContain(title);
  // On full reload the dialog has unmounted; on a BFCache restoration it may
  // remain mounted with its private state synchronously flushed on pagehide.
  if (await page.getByTestId("target-private-task-capture").count() === 0) {
    const width = (await page.viewportSize())?.width ?? 390;
    await openTask(page, width);
  }
  await expect(page.getByTestId("target-private-task-area")).toHaveValue("");
  await page.getByTestId("target-private-task-area").selectOption({ label: store!.seed.areaTitle });
  await expect(titleBox(page)).toHaveValue("");
  // Even if someone presses Save, the former title cannot be submitted.
  await page.getByTestId("target-private-task-save").click();
  await expect(page.getByRole("alert").filter({ hasText: /platný název úkolu/ })).toBeVisible();
  expect(observedCreates(), "an abandoned draft must never submit CREATE").toBe(0);
}

for (const width of [390, 1280]) {
  test("real-store BFCache/back privacy and fresh authorized wake at " + width + "px", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const trace = observeTarget(page);
    // Capture the browser's OWN pageshow events. No synthetic event is dispatched.
    await page.addInitScript(() => {
      const state = { pageShows: [] as boolean[] };
      (window as Window & { __lumiRealBfcache?: typeof state }).__lumiRealBfcache = state;
      window.addEventListener("pageshow", event => state.pageShows.push(event.persisted));
    });
    const documentResponse = await page.goto("/?view=Calendar&scope=personal");
    const cacheControl = documentResponse?.headers()["cache-control"] ?? "(none)";
    const secret = "BFCache soukromý draft " + width + " " + randomUUID();
    await draft(page, width, secret);
    expect(trace.creates).toBe(0);
    await page.goto("/robots.txt"); // cross-document navigation, not SPA routing
    const mark = trace.responses.length;
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/view=Calendar/);

    // Inspect the restored document BEFORE waiting for session/Area revalidation.
    const immediate = await privateDOM(page, secret);
    const browser = await page.evaluate(() => {
      const state = (window as Window & {
        __lumiRealBfcache?: { pageShows: boolean[] }
      }).__lumiRealBfcache;
      const navigation = performance.getEntriesByType("navigation")[0] as
        (PerformanceNavigationTiming & { notRestoredReasons?: unknown }) | undefined;
      return {
        pageShows: state?.pageShows ?? [],
        persisted: state?.pageShows.includes(true) === true,
        navigationType: navigation?.type ?? "unavailable",
        notRestoredReasons: navigation?.notRestoredReasons ?? null,
      };
    });
    const evidence = { width, cacheControl, immediate, browser, head: process.env.GITHUB_SHA ?? null };
    console.log("REAL_BFCACHE_EVIDENCE " + JSON.stringify(evidence));
    await test.info().attach("real-bfcache-" + width + ".json", {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: "application/json",
    });
    expect(immediate.titleExposed, "private draft visible immediately after Back").toBe(false);
    expect(["", null], "Area retained immediately after Back").toContain(immediate.selectedArea);
    // The manual release gate cannot pass on a fallback reload. Never simulate
    // persisted=true, turn a miss into a skip, or claim a BFCache hit from Back alone.
    if (strictRealHit) {
      expect(browser.persisted,
        "No real pageshow.persisted=true; browser notRestoredReasons=" +
        JSON.stringify(browser.notRestoredReasons) + ", Cache-Control=" + cacheControl).toBe(true);
    }
    await expect.poll(() => trace.responses.slice(mark).some(value =>
      value === "GET /api/target-staging/session 200"
    ), { message: "Fresh authorized session GET must precede post-Back action", timeout: 15_000 }).toBe(true);
    // A full reload necessarily loses the open dialog. Opening it only AFTER
    // the new authorized session is verified causes the fresh Area GET.
    if (await page.getByTestId("target-private-task-capture").count() === 0) {
      await openTask(page, width);
    }
    await expect.poll(() => trace.responses.slice(mark).some(value =>
      value === "GET /api/target-staging/notes/create-targets 200"
    ), { message: "Private Area choices must be read again after wake", timeout: 15_000 }).toBe(true);
    const sinceBack = trace.responses.slice(mark);
    expect(sinceBack.indexOf("GET /api/target-staging/session 200")).toBeLessThan(
      sinceBack.indexOf("GET /api/target-staging/notes/create-targets 200"));
    await assertEmptyDraft(page, secret, () => trace.creates);
  });
}

test("full reload is a distinct no-draft/no-POST fallback on the real store", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trace = observeTarget(page);
  await page.goto("/?view=Calendar&scope=personal");
  const secret = "Reload secret " + randomUUID();
  await draft(page, 390, secret);
  const mark = trace.responses.length;
  await page.reload();
  await expect.poll(() => trace.responses.slice(mark).some(value =>
    value === "GET /api/target-staging/session 200")).toBe(true);
  await assertEmptyDraft(page, secret, () => trace.creates);
});

test("uncertain real-store POST keeps one UUID command barrier after reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/?view=Calendar&scope=personal");
  const secret = "Uncertain private task " + randomUUID();
  let forwarded: { commandId: string; taskId: string; title: string } | null = null;
  let writeCount = 0;
  // This is NOT the BFCache test. Forward the exact CREATE to the REAL store,
  // observe its 201 COMMIT, then deliberately lose only its response. The UI
  // cannot infer whether it committed, and must retain the original UUID fence.
  await page.route("**/api/target-staging/tasks", async route => {
    writeCount++;
    const command = route.request().postDataJSON() as
      { commandId: string; taskId: string; title: string };
    forwarded = command;
    const reply = await route.fetch();
    expect(reply.status(), "real SQLite-backed CREATE must commit").toBe(201);
    await route.abort("failed");
  });
  await draft(page, 1280, secret);
  await page.getByTestId("target-private-task-save").click();
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  expect(writeCount).toBe(1);
  if (!forwarded) throw new Error("No real CREATE reached the server");
  const command = forwarded as { commandId: string; taskId: string; title: string };
  expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
  expect(command.taskId).toMatch(/^[0-9a-f-]{36}$/);
  const marker = await page.evaluate(() =>
    sessionStorage.getItem("lumi-private-task-create-unresolved-v1"));
  expect(marker).toContain(command.commandId);
  expect(marker).not.toContain(secret);
  await page.reload();
  await openTask(page, 1280);
  await expect(page.getByTestId("target-private-task-unresolved")).toBeVisible();
  await expect(taskForm(page)).toHaveCount(0);
  expect(await storageSnapshot(page)).not.toContain(secret);
  expect(writeCount, "no automatic second CREATE after reload").toBe(1);
  await page.getByTestId("target-private-task-receipt").click();
  await expect(page.getByTestId("target-private-task-created")).toBeVisible();
  expect(writeCount, "receipt recovery is read-only; never retry CREATE").toBe(1);
  await expect.poll(() => page.evaluate(() =>
    sessionStorage.getItem("lumi-private-task-create-unresolved-v1"))).toBeNull();
});
