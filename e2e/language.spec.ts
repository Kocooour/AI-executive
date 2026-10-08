import { expect, test } from "@playwright/test";
import { visitScreens } from "./screens";
import { waitUntilSynced } from "./helpers";

// The Czech interface must not show English. Every visible text, placeholder, accessible name and
// tooltip on the main screens is checked for common English words. Names that are the same in
// both languages (Lumi, AI, passkey, Face ID…) are allowed, and so is "workspace", which the Czech
// interface uses as its term (owner decision).
const english = new Set(("the and or of for with without your you our is are was be been not yes can could " +
  "will would should this that these those from by at as an it its all any more less new add added remove removed save saved " +
  "failed failure error unavailable available loading loaded load please try again open close back next previous done enable " +
  "enabled disable disabled settings notification notifications backup backups restore restored create created delete deleted " +
  "task tasks project projects area areas note notes today tomorrow week day days hour hours minute minutes time " +
  "offline online sync synced syncing device devices sign signed out permission " +
  "granted denied browser address secure connection check registered sending reminder reminders when where what why who " +
  "how about here there work working plan planned search inbox upcoming anytime someday completed " +
  "overdue home more less show hide edit cancel confirm write writes require requires always safely propose change ask executive manual scheduled " +
  "personal family switch name monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun").split(" "));
const allowed = /\b(workspace|workspaces|Workspace|Lumi|AI|passkey|passkeys|Passkey|Passkeys|Face ID|Touch ID|iPhone|Android|PWA|HTTPS|URL|ICS|iCal|Google|Outlook|PACT|ID|OK|e2e)\b/g;

type Finding = { where: string; text: string; words: string[] };

async function texts(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = (element as HTMLElement).getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent?.trim();
      const parent = node.parentElement;
      if (!value || !parent || !visible(parent) || parent.closest("script, style, code, [data-user-content]")) continue;
      out.push(value);
    }
    for (const element of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
      if (!visible(element)) continue;
      for (const name of ["placeholder", "aria-label", "title"]) {
        const value = element.getAttribute(name);
        if (value) out.push(value);
      }
    }
    for (const option of document.querySelectorAll("select option")) {
      if (option.parentElement && visible(option.parentElement) && option.textContent?.trim()) out.push(option.textContent.trim());
    }
    return out;
  });
}

// Walks the screens and returns the texts that `foreign` flags. Records the user created (task and
// project titles, notes) are their content, not the interface; technical identifiers shown in
// `code` (record ids in the attention details) are skipped too.
async function audit(page: import("@playwright/test").Page, language: "cs" | "en", foreign: (text: string) => string[] | null) {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const userTexts = new Set<string>();
  const addUserContent = async () => {
    const content = await page.evaluate(() => fetch("/api/store", { cache: "no-store" }).then((response) => response.json())
      .then((snapshot) => (snapshot.entities as Array<{ title: string; properties?: { notes?: string } }>)
        .flatMap((entity) => [entity.title, entity.properties?.notes || ""])).catch(() => [] as string[]));
    for (const text of content) if (text) userTexts.add(text);
  };
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await visitScreens(page, async (where) => {
    // Records created during the walk are user content too.
    await addUserContent();
    for (const text of await texts(page)) {
      if (seen.has(text) || userTexts.has(text) || [...userTexts].some((title) => title.length >= 3 && text.includes(title))) continue;
      seen.add(text);
      const words = foreign(text);
      if (words) findings.push({ where, text: text.slice(0, 120), words });
    }
  });
  return findings;
}

test("the Czech interface shows no English text", async ({ page }) => {
  test.setTimeout(120_000);
  const findings = await audit(page, "cs", (text) => {
    const words = text.replace(allowed, " ").toLowerCase().match(/[a-z]+/g) || [];
    const hits = [...new Set(words.filter((word) => word.length > 1 && english.has(word)))];
    // A single short word could be Czech too; two English words, or a longer one, make it English.
    return hits.length >= 2 || hits.some((word) => word.length > 3) ? hits : null;
  });
  console.log(JSON.stringify(findings, null, 1));
  expect(findings).toEqual([]);
});

// The English interface must not show Czech: no letters with Czech diacritics, and none of the
// common Czech interface words that have none, outside user content.
const czech = new Set(("kontext kontextu projekt projekty projektu osoba osoby organizace typ archivovat zdroj zdroje stav " +
  "oblast oblasti hledat dnes nebo podle nelze osobni workspacu").split(" "));
test("the English interface shows no Czech text", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("ai-executive-language", "en"));
  const findings = await audit(page, "en", (text) => {
    const letters = text.match(/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ]/g) || [];
    const words = (text.toLowerCase().match(/[a-z]+/g) || []).filter((word) => czech.has(word));
    const hits = [...new Set([...letters, ...words])];
    return hits.length ? hits : null;
  });
  console.log(JSON.stringify(findings, null, 1));
  expect(findings).toEqual([]);
});

test("a wrong password is reported in Czech", async ({ browser }) => {
  const context = await browser.newContext({ locale: "cs-CZ", storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await page.locator('.authCard input[type="password"]').fill("tohle-neni-heslo");
  await page.keyboard.press("Enter");
  await expect(page.locator(".authCard")).toContainText("Nesprávné heslo.");
  await context.close();
});

test("a lasting failure is reported again in the new language after a language change", async ({ page }) => {
  await page.route("**/api/backups", (route) => route.abort());
  await page.goto("/?view=Settings");
  await waitUntilSynced(page);
  await page.locator(".settingsTabs button").filter({ hasText: "Data" }).first().click();
  await expect(page.getByText("Nastavení serveru není bez připojení dostupné.")).toBeVisible();
  await page.locator(".settingsTabs button").first().click();
  await page.locator("select").filter({ has: page.locator('option[value="en"]') }).selectOption("en");
  await page.locator(".settingsTabs button").filter({ hasText: "Data" }).first().click();
  await expect(page.getByText("Server settings are unavailable while offline.")).toBeVisible();
});
