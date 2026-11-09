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

const targetV1 = JSON.parse(readFileSync(path.join(path.dirname(tokensPath), "lumi-v1-target-tokens.json"), "utf8"));

test("Lumi v1 light tokens track approved target", () => {
  const expected = {
    "v1-app-bg": targetV1.color.surface.background,
    "v1-text": targetV1.color.surface.textPrimary,
    "v1-muted": targetV1.color.surface.textSecondary,
    "v1-surface-subtle": targetV1.color.surface.neutralSurface,
    "v1-scope-all-base": targetV1.color.readScope.all.base,
    "v1-scope-personal-base": targetV1.color.readScope.personal.base,
    "v1-scope-shared-base": targetV1.color.readScope.shared.base,
    "v1-scope-all": targetV1.color.readScope.all.accessibleTextOnWhite,
    "v1-scope-personal": targetV1.color.readScope.personal.accessibleTextOnWhite,
    "v1-scope-shared": targetV1.color.readScope.shared.accessibleTextOnWhite,
    "v1-area-personal": targetV1.color.areaGroupLight.personal,
    "v1-area-work": targetV1.color.areaGroupLight.work,
    "v1-area-family": targetV1.color.areaGroupLight.family,
    "v1-attention-red": targetV1.color.attention.contrastSafeStrokeRedOnLight,
    "v1-attention-orange": targetV1.color.attention.contrastSafeStrokeOrangeOnLight,
    "v1-neutral-stroke": targetV1.color.attention.neutralStroke,
    "v1-completed-fill": targetV1.color.completed.accessibleFillOnLight,
    "v1-completed-text": targetV1.color.completed.text,
    "v1-proposal-stroke": targetV1.color.proposal.accent,
    "v1-proposal-surface": targetV1.color.proposal.surface,
    "v1-on-proposal": targetV1.color.readScope.all.accessibleTextOnWhite,
  };
  for (const [name, expectedColor] of Object.entries(expected)) {
    assert.equal(color(name, "light").toLowerCase(), expectedColor.toLowerCase(), name);
  }
  assert.equal(targetV1.shape.attention, "colored-outline-no-fill-no-check");
  assert.equal(targetV1.shape.completed, "gray-fill-with-check");
  const css = buildCss(tokens);
  assert.match(css, /\.lumi-v1-item-title \{[^}]*font-size: 17px;[^}]*font-weight: 650;/s);
  assert.match(css, /\.lumi-v1-section-title \{[^}]*font-size: 20px;[^}]*font-weight: 700;/s);
});

test("Lumi v1 typography and semantic colors keep accessible contrast in light and dark", () => {
  const textPairs = [
    ["v1-text", "v1-app-bg"],
    ["v1-muted", "v1-app-bg"],
    ["v1-accent", "v1-app-bg"],
    ["v1-scope-all", "v1-app-bg"],
    ["v1-scope-personal", "v1-app-bg"],
    ["v1-scope-shared", "v1-app-bg"],
    ["v1-on-accent", "v1-accent"],
    ["v1-on-accent-soft", "v1-accent-soft"],
    ["v1-on-proposal", "v1-proposal-surface"],
    ...["v1-area-personal", "v1-area-work", "v1-area-family"]
      .flatMap((background) => [["v1-text", background], ["v1-completed-text", background]]),
  ];
  const strokePairs = [
    ["v1-neutral-stroke", "v1-app-bg"],
    ["v1-neutral-stroke", "v1-surface-subtle"],
    ["v1-proposal-stroke", "v1-proposal-surface"],
    ...["v1-app-bg", "v1-area-personal", "v1-area-work", "v1-area-family"]
      .flatMap((background) => [
        ["v1-attention-red", background],
        ["v1-attention-orange", background],
        ["v1-neutral-stroke", background],
        ["v1-completed-fill", background],
      ]),
  ];
  for (const theme of ["light", "dark"]) {
    for (const [foreground, background] of textPairs) {
      const ratio = contrast(color(foreground, theme), color(background, theme));
      assert.ok(ratio >= 4.5, `${theme}: ${foreground} on ${background} is only ${ratio.toFixed(2)}:1`);
    }
    for (const [foreground, background] of strokePairs) {
      const ratio = contrast(color(foreground, theme), color(background, theme));
      assert.ok(ratio >= 3, `${theme}: ${foreground} on ${background} is only ${ratio.toFixed(2)}:1`);
    }
  }
});

test("Lumi v1 runtime palette remains behind the existing preview flag", () => {
  const root = path.join(path.dirname(tokensPath), "..", "..");
  const page = readFileSync(path.join(root, "app", "ui", "lumi-app-root.tsx"), "utf8");
  const css = readFileSync(path.join(root, "app", "lumi-v1-runtime.css"), "utf8");
  const layout = readFileSync(path.join(root, "app", "layout.tsx"), "utf8");
  assert.match(page, /data-design-system=\{mobileDesignV1Preview \? "lumi-v1" : undefined\}/);
  assert.match(css, /\.appShell\[data-design-system="lumi-v1"\] \{/);
  assert.doesNotMatch(css, /(^|\n)\s*(:root|body|\.appShell)\s*\{/);
  assert.match(layout, /import "\.\/lumi-v1-runtime\.css";/);
  assert.match(css, /--ws-personal:\s*var\(--v1-scope-personal\)/);
  assert.match(css, /--ws-all:\s*var\(--v1-scope-all\)/);
});
