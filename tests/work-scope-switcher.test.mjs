import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement, Children } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkScopeSwitcherControls } from "../app/ui/views/work-scope-switcher-controls.ts";

const classes = { group: "group", option: "option", active: "active" };
const props = (overrides = {}) => ({
  enabled: true, language: "cs", value: "my-plan", onChange: () => {}, classes, ...overrides,
});
const buttons = (rendered) => Children.toArray(rendered.props.children);

test("rendered control presents exactly three labeled native buttons and their selected state", () => {
  const markup = renderToStaticMarkup(createElement(WorkScopeSwitcherControls, props()));
  assert.match(markup, /role="group" aria-label="Rozsah práce"/);
  assert.match(markup, /data-work-scope-switcher/);
  assert.equal((markup.match(/type="button"/g) || []).length, 3);
  assert.equal((markup.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(markup, /data-work-read-scope="my-plan" aria-pressed="true"/);
  assert.match(markup, /data-work-read-scope="personal" aria-pressed="false"/);
  assert.match(markup, /data-work-read-scope="shared" aria-pressed="false"/);
  assert.match(markup, /Můj plán/);
  assert.match(markup, /Osobní/);
  assert.match(markup, /Sdílené/);
  assert.ok(!markup.includes("workspace:personal"), "do not show internal workspaces");

  const english = renderToStaticMarkup(createElement(WorkScopeSwitcherControls, props({
    value: "shared", language: "en",
  })));
  assert.match(english, /aria-label="Work scope"/);
  assert.match(english, /data-work-read-scope="shared" aria-pressed="true"/);
  assert.match(english, /My plan/);
  assert.match(english, /Personal/);
  assert.match(english, /Shared/);
});

test("clicking a different scope calls onChange once, selecting the active scope is a no-op", () => {
  const calls = [];
  const rendered = WorkScopeSwitcherControls(props({ onChange: (scope) => calls.push(scope) }));
  assert.equal(rendered.type, "div");
  const options = buttons(rendered);
  assert.deepEqual(options.map((option) => option.props["data-work-read-scope"]), [
    "my-plan", "personal", "shared",
  ]);
  assert.ok(options.every((option) => option.type === "button" && option.props.type === "button"));
  assert.deepEqual(options.map((option) => option.props["aria-pressed"]), [true, false, false]);
  options[0].props.onClick();
  options[1].props.onClick();
  options[2].props.onClick();
  assert.deepEqual(calls, ["personal", "shared"]);
  // Controlled component: parent supplies the new selected state.
  const changed = buttons(WorkScopeSwitcherControls(props({ value: "shared" })));
  assert.deepEqual(changed.map((option) => option.props["aria-pressed"]), [false, false, true]);
});

test("the disabled-by-gate switcher renders nothing and cannot invoke callbacks", () => {
  let calls = 0;
  const input = props({ enabled: false, onChange: () => { calls++; } });
  assert.equal(WorkScopeSwitcherControls(input), null);
  assert.equal(renderToStaticMarkup(createElement(WorkScopeSwitcherControls, input)), "");
  assert.equal(calls, 0);
});

test("scope controls use browser-native accessible keyboard controls and narrow-screen-safe styling", () => {
  // Native <button> handles Tab focus, Enter and Space. Avoid custom key handlers
  // that could double-activate a button or interfere with assistive technologies.
  const options = buttons(WorkScopeSwitcherControls(props()));
  for (const option of options) {
    assert.equal(option.type, "button");
    assert.equal(option.props.type, "button");
    assert.equal(option.props.onKeyDown, undefined);
    assert.equal(option.props.disabled, undefined);
  }

  const css = readFileSync("app/ui/views/work-scope-switcher.module.css", "utf8");
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width:\s*359px/);
});

test("activation gate: prepared switcher stays disconnected from all app entrypoints", () => {
  // This is a temporary, deliberately strict safeguard. Replace it with real
  // authorization and legacy-preservation integration tests *after* 2a–2c.
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(?:tsx?|jsx?)$/.test(entry.name) ? [full] : [];
  });
  for (const file of files("app")) {
    if (file.endsWith("work-scope-switcher.tsx") || file.endsWith("work-scope-switcher-controls.ts")) continue;
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\b(?:WorkScopeSwitcher|WorkScopeSwitcherControls)\b|["']\S*work-scope-switcher(?:-controls)?["']/,
      `premature D3 activation from ${file}`);
  }
});
