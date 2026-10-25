import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement, Children } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkScopeSwitcherControls } from "../app/ui/views/work-scope-switcher-controls.ts";
import { copy } from "../app/ui/copy.ts";

// The app's tr() looks keys up in app/ui/copy.ts the same way.
const trFor = (language) => (key) => copy[language][key] ?? key;
const props = (overrides = {}) => ({
  enabled: true, tr: trFor("cs"), value: "my-plan", onChange: () => {}, ...overrides,
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
    value: "shared", tr: trFor("en"),
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

  assert.ok(options.every((option) => option.props.className === "workScopeOption"));

  // Styles live with the rest of the navigation (the repository has no CSS modules).
  const css = readFileSync("app/lumi-navigation.css", "utf8");
  const rule = (selector) => css.match(new RegExp(selector.replace(/[.[\]"=]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
  assert.match(rule(".appShell .workScopeSwitcher"), /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(rule(".appShell .workScopeOption"), /min-height:\s*44px/);
  assert.match(rule(".appShell .workScopeOption"), /overflow-wrap:\s*anywhere/);
  // The selected option is told apart by weight too, not by color alone.
  assert.match(rule('.appShell .workScopeOption[aria-pressed="true"]'), /font-weight:\s*700/);
  const focus = css.match(/\.appShell \.workScopeOption:focus-visible,[^{]*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(focus, /outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(css, /@media \(max-width: 359px\)\s*\{\s*\.appShell \.workScopeSwitcher/);
});

test("activation gate: prepared switcher stays disconnected from the app and lib source", () => {
  // This is a temporary, deliberately strict safeguard. Replace it with real
  // authorization and legacy-preservation integration tests *after* 2a–2c.
  const own = new Set([
    path.join("app", "ui", "views", "work-scope-switcher.tsx"),
    path.join("app", "ui", "views", "work-scope-switcher-controls.ts"),
  ]);
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [full] : [];
  });
  // The identifier, or any module specifier naming the switcher files (with or without an extension:
  // static, side-effect, re-export or dynamic import).
  const use = /\b(?:WorkScopeSwitcher|WorkScopeSwitcherControls)\b|["'`][^"'`\n]*work-scope-switcher(?:-controls)?(?:\.[cm]?[jt]sx?)?["'`]/;
  for (const file of [...files("app"), ...files("lib")]) {
    if (own.has(file)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), use, `premature D3 activation from ${file}`);
  }
  // The pattern itself catches the forms that bypassed an earlier version.
  for (const sample of ['import "./work-scope-switcher.tsx";', 'export * from "./views/work-scope-switcher.js";',
    'await import("../ui/views/work-scope-switcher-controls.ts")']) assert.match(sample, use);
});
