import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "app/lumi-project-list-v1.css"), "utf8");
const globalCss = readFileSync(path.join(root, "app/globals.css"), "utf8");
const tokens = JSON.parse(readFileSync(path.join(root, "docs/design-system/tokens.json"), "utf8"));

function color(name, theme) {
  const item = tokens.color.tokens.find((token) => token.name === name);
  assert.ok(item, `Missing design token ${name}`);
  const result = typeof item.value === "string" ? item.value : item.value[theme];
  assert.match(result, /^#[a-f\d]{6}$/i, `Missing hex for ${name} (${theme})`);
  return result;
}

function channels(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

// CSS color-mix(in srgb, ...) interpolates the gamma-encoded sRGB channels.
function mix(first, second, fraction) {
  const a = channels(first);
  const b = channels(second);
  return a.map((part, index) => part * fraction + b[index] * (1 - fraction));
}

function contrast(first, second) {
  const luminance = (value) => {
    const [r, g, b] = typeof value === "string" ? channels(value) : value;
    const [red, green, blue] = [r, g, b].map((part) => {
      const v = part / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function rule(sheet, selector) {
  const start = sheet.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `Missing CSS selector: ${selector}`);
  const end = sheet.indexOf("}", start);
  assert.ok(end > start);
  return sheet.slice(start, end + 1);
}

const group = '.projectGroups[data-projects-preview="lumi-v1"] > .projectGroup';
const row = ".appShell .taskRowList .v1ProjectRow";
const circle = `${row} .v1ProjectCircle`;
const cases = [
  ["personal", "v1-area-personal"],
  ["work", "v1-area-work"],
  ["family", "v1-area-family"],
  ["extra-a", "v1-area-extra-a"],
  ["extra-b", "v1-area-extra-b"],
  ["extra-c", "v1-area-extra-c"],
];

test("all preview Area colors are semantic and preserve pastel light variants", () => {
  for (const [tone, name] of cases) {
    const selector = `${group}[data-preview-area-tone="${tone}"]`;
    assert.match(rule(css, selector), new RegExp(`--v1-area-color: var\\(--${name}\\);`));
  }
  assert.match(rule(css, group), /background: color-mix\(in srgb, var\(--v1-area-color\) 72%, var\(--surface\)\);/);
});

test("dark Area groups are visibly distinguishable, including system-theme fallback", () => {
  const darkSelector = `html[data-theme="dark"] ${group}`;
  const systemSelector = `html:not([data-theme]) ${group}`;
  const darkRule = rule(css, darkSelector);
  const systemRule = rule(css, systemSelector);
  const targetMix = /background: color-mix\(in srgb, var\(--v1-area-color\) 82%, var\(--v1-muted\) 18%\);/;
  assert.match(darkRule, targetMix);
  assert.match(systemRule, targetMix);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{[\s\S]*html:not\(\[data-theme\]\)/);
  for (const [tone, token] of cases) {
    const actual = mix(color(token, "dark"), color("v1-muted", "dark"), 0.82);
    const ratio = contrast(actual, color("surface", "dark"));
    assert.ok(ratio >= 1.4, `Dark ${tone} group is indistinguishable from surface: ${ratio.toFixed(2)}:1`);
    assert.ok(contrast(color("v1-text", "dark"), actual) >= 4.5, `Dark ${tone} title illegible`);
  }
});

test("Area grouping border meets non-text contrast on all six real pastel mixes", () => {
  assert.match(rule(css, group), /border: 1px solid var\(--v1-neutral-stroke\);/);
  const darkExplicit = rule(css, `html[data-theme="dark"] ${group}`);
  const darkSystem = rule(css, `html:not([data-theme]) ${group}`);
  assert.doesNotMatch(darkExplicit, /border-color:/, "dark theme must not override safe edge");
  assert.doesNotMatch(darkSystem, /border-color:/, "system dark theme must keep safe edge");
  for (const [tone, token] of cases) {
    for (const theme of ["light", "dark"]) {
      const background = theme === "light"
        ? mix(color(token, theme), color("surface", theme), 0.72)
        : mix(color(token, theme), color("v1-muted", theme), 0.82);
      const ratio = contrast(color("v1-neutral-stroke", theme), background);
      assert.ok(ratio >= 3, `${theme}/${tone} group boundary only ${ratio.toFixed(2)}:1 (minimum 3:1)`);
    }
  }
});

test("project controls use semantic outline/fill tokens with contrast on actual mixed group surfaces", () => {
  assert.match(rule(css, circle), /border: 2px solid var\(--v1-neutral-stroke\);/);
  assert.match(rule(css, `${row}[data-project-tone="warning"] .v1ProjectCircle`), /border-color: var\(--v1-attention-orange\);/);
  assert.match(rule(css, `${row}[data-project-tone="danger"] .v1ProjectCircle`), /border-color: var\(--v1-attention-red\);/);
  const completed = rule(css, `${row}[data-project-tone="complete"] .v1ProjectCircle`);
  assert.match(completed, /border-color: var\(--v1-completed-fill\);/);
  assert.match(completed, /background: var\(--v1-completed-fill\);/);
  assert.match(completed, /color: var\(--v1-on-accent\);/);
  assert.doesNotMatch(css, /box-shadow: inset 0 0 0 1px/);
  for (const [tone, areaName] of cases) {
    for (const theme of ["light", "dark"]) {
      const areaSurface = theme === "light"
        ? mix(color(areaName, theme), color("surface", theme), 0.72)
        : mix(color(areaName, theme), color("v1-muted", theme), 0.82);
      for (const stroke of ["v1-neutral-stroke", "v1-attention-orange", "v1-attention-red", "v1-completed-fill"]) {
        const ratio = contrast(color(stroke, theme), areaSurface);
        assert.ok(ratio >= 3, `${theme} ${tone}: ${stroke} contrast ${ratio.toFixed(2)}:1 below 3:1`);
      }
      const checkmark = contrast(color("v1-on-accent", theme), color("v1-completed-fill", theme));
      assert.ok(checkmark >= 4.5, `${theme} ${tone}: completed checkmark contrast ${checkmark.toFixed(2)}:1 below 4.5:1`);
    }
  }
});

test("mobile calendar selected day uses the contrast-safe theme-specific fill and text", () => {
  const selected = rule(globalCss, '.mobileCalendarDateBubble[data-selected="true"]');
  assert.match(selected, /color: var\(--v1-on-accent\);/);
  assert.match(selected, /background: var\(--v1-accent\);/);
  assert.match(selected, /border-color: var\(--v1-accent\);/);
  for (const theme of ["light", "dark"]) {
    assert.ok(contrast(color("v1-on-accent", theme), color("v1-accent", theme)) >= 4.5,
      `Selected day label must be readable in ${theme}`);
  }
});
