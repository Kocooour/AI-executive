import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("UI-06e adds an unfilled decorative project circle without changing the legacy archive", () => {
  const source = read("../app/ui/views/project-icon.tsx");
  assert.match(source, /export function ProjectIcon\(\{ previewCircle = false \}/);
  assert.match(source, /data-project-shape=\{previewCircle \? "circle" : "archive"\}/);
  assert.match(source, /<circle cx="8" cy="8" r="5\.6" \/>/);
  assert.match(source, /<rect x="1\.75" y="2\.5"/, "legacy archive remains");
  assert.match(source, /aria-hidden="true" focusable="false"/, "identity glyph is not a checkbox");
  assert.match(source, /case "Projects": return <ProjectIcon \/>;/);
  assert.match(source, /case "ProjectsV1": return <ProjectIcon previewCircle \/>;/);
});

test("UI-06e restricts circle to preview navigation", () => {
  const sidebar = read("../app/ui/views/sidebar.tsx");
  const phone = read("../app/ui/views/mobile-nav.tsx");
  assert.match(sidebar, /mobileDesignV1Preview && x === "Projects" \? "ProjectsV1" : x/);
  assert.match(phone, /mobileDesignV1Preview && x === "Projects" \? "ProjectsV1" : x/);
  assert.match(sidebar, /<ProjectIcon previewCircle=\{mobileDesignV1Preview\} \/>/);
  assert.doesNotMatch(phone, /role="checkbox"/, "Projects tab is navigation only");
});
