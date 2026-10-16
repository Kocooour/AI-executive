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

test("color aliases point to existing color tokens", () => {
  const names = new Set(tokens.color.tokens.map((token) => token.name));
  for (const token of tokens.color.tokens) {
    for (const value of Object.values(typeof token.value === "string" ? { light: token.value } : token.value)) {
      const target = /^\{(.+)\}$/.exec(value)?.[1];
      if (target) assert.ok(names.has(target) && target !== token.name, `${token.name} aliases missing ${target}`);
    }
  }
});
