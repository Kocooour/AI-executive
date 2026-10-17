import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const { buildCss, cssPath, tokensPath } = await import("../scripts/design-tokens.mjs");
const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));
const componentsDir = path.join(path.dirname(tokensPath), "components");

test("docs/design-system/tokens.css matches tokens.json", () => {
  assert.equal(readFileSync(cssPath, "utf8"), buildCss(tokens), "run node scripts/design-tokens.mjs");
});

test("every preview loads tokens.css and uses only tokens that exist", () => {
  const defined = new Set([
    ...tokens.color.tokens, ...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.shadow.tokens,
  ].map((token) => token.name).concat(Object.keys(tokens.type.families).map((key) => `font-${key}`)));
  for (const name of readdirSync(componentsDir)) {
    const html = readFileSync(path.join(componentsDir, name, "preview.html"), "utf8");
    assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/tokens\.css">/, `${name} does not load tokens.css`);
    const own = new Set([...html.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((match) => match[1].slice(2)));
    for (const [, used] of html.matchAll(/var\(--([A-Za-z0-9-]+)\)/g)) {
      assert.ok(defined.has(used) || own.has(used), `${name} uses --${used}, which tokens.json does not define`);
    }
  }
});

// WCAG 2 contrast of two #rrggbb colors; aliases resolve to their target token.
function color(name, theme) {
  const token = tokens.color.tokens.find((entry) => entry.name === name);
  assert.ok(token, `missing color token ${name}`);
  const value = typeof token.value === "string" ? token.value : token.value[theme] ?? token.value[tokens.color.themes[0].id];
  const alias = /^\{(.+)\}$/.exec(value)?.[1];
  return alias ? color(alias, theme) : value;
}
function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("labels and controls keep their contrast in every theme", () => {
  const pairs = [
    // [foreground, background, minimum, what]
    ["on-accent-soft", "accent-soft", 4.5, "Návrh label"],
    ["on-success-soft", "success-soft", 4.5, "Provedeno label"],
    ["text", "app-bg", 4.5, "body text"],
    ["muted", "app-bg", 4.5, "row value"],
    ["muted-light", "sidebar-bg", 4.5, "sidebar count"],
    ["muted-light", "surface-subtle", 4.5, "search placeholder"],
    ["muted-light", "input-bg", 4.5, "field placeholder"],
    ["muted", "selected", 4.5, "row value on the selected row"],
    ["success", "app-bg", 4.5, "Synchronizováno"],
    ["success", "surface", 4.5, "Synchronizováno in a card"],
    ["success", "surface-subtle", 4.5, "Synchronizováno in settings"],
    ["text", "ws-personal-soft", 4.5, "active navigation, Osobní"],
    ["text", "ws-work-soft", 4.5, "active navigation, Pracovní"],
    ["text", "ws-family-soft", 4.5, "active navigation, Rodinný"],
    ["text", "ws-all-soft", 4.5, "active navigation, Všechna práce"],
    ["on-accent", "accent", 4.5, "primary button"],
    ["control-border", "surface", 3, "task ring"],
    ["control-border", "app-bg", 3, "task ring"],
    ["control-border", "selected", 3, "task ring on the selected row"],
    ["control-border", "input-bg", 3, "field border"],
    ["focus-ring", "app-bg", 3, "focus ring on the page"],
    ["focus-ring", "sidebar-bg", 3, "focus ring in the sidebar"],
    ["focus-ring", "surface-raised", 3, "focus ring in dialogs"],
    ["focus-ring", "input-bg", 3, "focus ring around a field"],
  ];
  for (const { id } of tokens.color.themes) {
    for (const [fg, bg, minimum, what] of pairs) {
      const ratio = contrast(color(fg, id), color(bg, id));
      assert.ok(ratio >= minimum, `${what} (${fg} on ${bg}, ${id}) is ${ratio.toFixed(2)}:1, below ${minimum}:1`);
    }
  }
});

test("color aliases point to existing color tokens", () => {
  const names = new Set(tokens.color.tokens.map((token) => token.name));
  for (const token of tokens.color.tokens) {
    for (const value of Object.values(typeof token.value === "string" ? { light: token.value } : token.value)) {
      const target = /^\{(.+)\}$/.exec(value)?.[1];
      if (target) assert.ok(names.has(target) && target !== token.name, `${token.name} aliases missing ${target}`);
    }
  }
});
