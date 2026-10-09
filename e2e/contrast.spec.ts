import { expect, test } from "./fixtures";
import { visitScreens } from "./screens";

// Text must stay readable in both themes. For every visible piece of text on the main screens the
// contrast between its colour and the background it actually sits on is measured (WCAG 2.x):
// at least 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold). Disabled controls are exempt.
type Failure = { view: string; theme: string; text: string; ratio: number; required: number; color: string; background: string; selector: string };

async function audit(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    // Computed colours come as rgb()/rgba(), or as color(srgb r g b / a) for color-mix() results.
    const parse = (value: string) => {
      const rgb = value.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = "1"] = rgb[1].split(/[ ,/]+/).filter(Boolean);
        return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
      }
      const srgb = value.match(/color\(srgb ([^)]+)\)/);
      if (srgb) {
        const [r, g, b, a = "1"] = srgb[1].split(/[ /]+/).filter(Boolean);
        return { r: Number(r) * 255, g: Number(g) * 255, b: Number(b) * 255, a: Number(a) };
      }
      return null;
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
    // Typed text and placeholders are not text nodes; check form fields separately.
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea")) {
      const rect = field.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || field.disabled || field.closest("[hidden]")) continue;
      const base = background(field);
      const style = getComputedStyle(field);
      for (const [kind, colorValue, text] of [["value", style.color, field.value || "Ab"], ["placeholder", getComputedStyle(field, "::placeholder").color, field.placeholder]] as const) {
        if (!text) continue;
        const color = parse(colorValue);
        if (!color) continue;
        const shown = blend(color, base);
        const [light, dark] = [luminance(shown), luminance(base)].sort((a, b) => b - a);
        const ratio = (light + 0.05) / (dark + 0.05);
        if (ratio + 0.005 < 4.5) out.push({ text: `${kind}: ${text.slice(0, 30)}`, ratio: Math.round(ratio * 100) / 100, required: 4.5, color: colorValue, background: `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`, selector: describe(field) });
      }
    }
    return out;
  });
}

// Screens and states to check: every main view, every Settings section, and the overlays.
async function collect(page: import("@playwright/test").Page, theme: string) {
  const failures: Failure[] = [];
  // The pointer is moved out of the way first: the audit checks resting colours, and a row left
  // under the pointer after a click would be measured in its hover colour.
  const record = async (where: string) => {
    await page.mouse.move(0, 0);
    for (const failure of await audit(page)) failures.push({ view: where, theme, ...failure });
  };
  await visitScreens(page, record, theme as "light" | "dark");
  return failures;
}

for (const theme of ["light", "dark"]) {
  test(`text is readable in the ${theme} theme`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.addInitScript((mode) => localStorage.setItem("ai-executive-theme", mode), theme);
    const failures = await collect(page, theme);
    // The sign-in screen, without a session.
    // No session: the project's saved session would otherwise be inherited.
    const signedOut = await browser.newContext({ locale: "cs-CZ", storageState: { cookies: [], origins: [] } });
    const signIn = await signedOut.newPage();
    await signIn.addInitScript((mode) => localStorage.setItem("ai-executive-theme", mode), theme);
    await signIn.goto("/");
    await expect(signIn.locator(".authCard input[type=password]")).toBeVisible();
    for (const failure of await audit(signIn)) failures.push({ view: "Sign-in", theme, ...failure });
    await signedOut.close();
    console.log(JSON.stringify(failures));
    expect(failures).toEqual([]);
  });
}
