import { expect, test } from "@playwright/test";
import { waitUntilSynced } from "./helpers";

// Text must stay readable in both themes. For every visible piece of text on the main screens the
// contrast between its colour and the background it actually sits on is measured (WCAG 2.x):
// at least 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold). Disabled controls are exempt.
const views = ["Home", "Inbox", "Today", "Upcoming", "Anytime", "Someday", "Overdue", "Completed", "Projects", "Areas", "Notes", "Calendar", "Search", "Context", "Agents", "Settings"];

type Failure = { view: string; theme: string; text: string; ratio: number; required: number; color: string; background: string; selector: string };

async function audit(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const [r, g, b, a = "1"] = match[1].split(/[ ,/]+/).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const blend = (top: { r: number; g: number; b: number; a: number }, bottom: { r: number; g: number; b: number }) => ({
      r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const background = (element: Element): { r: number; g: number; b: number } => {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) { layers.push(color); if (color.a >= 1) break; }
      }
      let result = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      if (result.a < 1) result = blend(result, { r: 255, g: 255, b: 255 });
      for (const layer of layers.reverse()) result = blend(layer, result);
      return result;
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const describe = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && parts.length < 3; node = node.parentElement) {
        parts.unshift(node.tagName.toLowerCase() + (node.classList.length ? "." + [...node.classList].slice(0, 2).join(".") : ""));
      }
      return parts.join(" > ");
    };
    const out: Array<{ text: string; ratio: number; required: number; color: string; background: string; selector: string }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || seen.has(element) || !node.textContent?.trim()) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || element.closest("[hidden], [aria-hidden='true'], option, script, style")) continue;
      if (element.closest(":disabled, [aria-disabled='true']")) continue;
      let opacity = 1;
      for (let parent: Element | null = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
      if (opacity < 0.1) continue;
      const base = background(element);
      const textColor = parse(style.color);
      if (!textColor) continue;
      const shown = blend({ ...textColor, a: textColor.a * opacity }, base);
      const [light, dark] = [luminance(shown), luminance(base)].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio + 0.005 < required) out.push({ text: node.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, required, color: style.color, background: `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`, selector: describe(element) });
    }
    return out;
  });
}

// Screens and states to check: every main view, every Settings section, and the overlays.
async function collect(page: import("@playwright/test").Page, theme: string) {
  const failures: Failure[] = [];
  const record = async (where: string) => { for (const failure of await audit(page)) failures.push({ view: where, theme, ...failure }); };
  for (const view of views) {
    await page.goto(`/?view=${view}`);
    await waitUntilSynced(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await record(view);
  }
  await page.goto("/");
  await waitUntilSynced(page);
  await page.locator(".attentionMore summary").first().click();
  await page.locator(".attentionLimits summary").first().click();
  await record("Home, attention details");
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  const sections = page.getByRole("navigation", { name: "Sekce nastavení" }).getByRole("button");
  for (let index = 0; index < await sections.count(); index += 1) {
    await sections.nth(index).click();
    await record(`Settings: ${await sections.nth(index).innerText()}`);
  }
  await page.goto("/?task=e2e-plain");
  await expect(page.locator("input.titleEdit")).toBeVisible();
  await record("Task detail");
  // Its own project: other scenarios may have deleted the seeded one.
  await page.evaluate(async () => {
    const snapshot = await fetch("/api/store", { cache: "no-store" }).then((response) => response.json());
    if (snapshot.entities.some((entity: { id: string }) => entity.id === "e2e-contrast-project")) return;
    const now = Date.now();
    await fetch("/api/store", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: snapshot.revision,
      entities: [...snapshot.entities, { id: "e2e-contrast-project", type: "project", title: "Projekt pro kontrolu kontrastu", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now }],
      relations: snapshot.relations, deletedIds: [], revivedIds: [] }) });
  });
  await page.goto("/?view=Projects");
  await waitUntilSynced(page);
  await page.getByText("Projekt pro kontrolu kontrastu").first().click();
  await record("Project detail");
  await page.locator(".projectActions button.danger").click();
  await expect(page.locator("dialog.confirmDialog")).toBeVisible();
  await record("Confirmation dialog");
  await page.keyboard.press("Escape");
  await page.goto("/?view=Inbox");
  await waitUntilSynced(page);
  await page.locator("button", { hasText: "＋" }).first().click();
  await page.locator(".captureModal").locator("input, textarea").first().fill("Kontrola kontrastu 25. 10. !");
  await page.waitForTimeout(800);
  await record("Capture dialog");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitUntilSynced(page);
  await record("Phone: Home");
  await page.locator(".mobileNav button").last().click();
  await record("Phone: More");
  return failures;
}

for (const theme of ["light", "dark"]) {
  test(`text is readable in the ${theme} theme`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.addInitScript((mode) => localStorage.setItem("ai-executive-theme", mode), theme);
    const failures = await collect(page, theme);
    // The sign-in screen, without a session.
    const signedOut = await browser.newContext({ locale: "cs-CZ" });
    const signIn = await signedOut.newPage();
    await signIn.addInitScript((mode) => localStorage.setItem("ai-executive-theme", mode), theme);
    await signIn.goto("/");
    await expect(signIn.locator(".authCard")).toBeVisible();
    for (const failure of await audit(signIn)) failures.push({ view: "Sign-in", theme, ...failure });
    await signedOut.close();
    console.log(JSON.stringify(failures));
    expect(failures).toEqual([]);
  });
}
