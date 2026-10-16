// Builds docs/design-system/tokens.css from docs/design-system/tokens.json, so the component
// previews in that folder open styled straight from a checkout.
//   node scripts/design-tokens.mjs          writes the file
//   node scripts/design-tokens.mjs --check  fails when the file is out of date
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "design-system");
export const tokensPath = path.join(dir, "tokens.json");
export const cssPath = path.join(dir, "tokens.css");

const alias = (value) => value.replace(/\{([A-Za-z0-9_.-]+)\}/g, "var(--$1)");
const themed = (value, theme, first) => alias(typeof value === "string" ? value : value[theme] ?? value[first]);
const block = (selector, lines) => `${selector} {\n${lines.map((line) => `  ${line}`).join("\n")}\n}\n`;

export function buildCss(tokens) {
  const themes = tokens.color.themes.map((theme) => theme.id);
  const [first, ...others] = themes;
  const themedFamilies = [tokens.color, tokens.shadow].filter(Boolean);
  const themedLines = (theme) => themedFamilies.flatMap((family) => family.tokens.map((token) => `--${token.name}: ${themed(token.value, theme, first)};`));
  const plainLines = ["spacing", "radius"].flatMap((key) => (tokens[key]?.tokens ?? []).map((token) => `--${token.name}: ${token.value};`));
  const fontLines = Object.entries(tokens.type.families).map(([key, stack]) => `--font-${key}: ${stack};`);
  const styles = tokens.type.groups.flatMap((group) => group.styles.map((style) => block(`.${style.name}`, [
    `font-family: var(--font-${style.family ?? group.family});`,
    `font-size: ${style.fontSize};`,
    `line-height: ${style.lineHeight};`,
    `font-weight: ${style.fontWeight};`,
    ...(style.letterSpacing ? [`letter-spacing: ${style.letterSpacing};`] : []),
  ])));
  return [
    `/* ${tokens.name} — generated from tokens.json by scripts/design-tokens.mjs; do not edit */\n`,
    block(`:root, [data-theme="${first}"]`, [...themedLines(first), ...plainLines, ...fontLines, `color-scheme: ${first};`]),
    ...others.map((theme) => block(`[data-theme="${theme}"]`, [...themedLines(theme), `color-scheme: ${theme};`])),
    ...(others.includes("dark") ? [`@media (prefers-color-scheme: dark) {\n${block(":root:not([data-theme])", [...themedLines("dark"), "color-scheme: dark;"]).replace(/^/gm, "  ").trimEnd()}\n}\n`] : []),
    ...styles,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = buildCss(JSON.parse(readFileSync(tokensPath, "utf8")));
  if (process.argv.includes("--check")) {
    if (readFileSync(cssPath, "utf8") !== css) {
      console.error("docs/design-system/tokens.css is out of date: run node scripts/design-tokens.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(cssPath, css);
  }
}
