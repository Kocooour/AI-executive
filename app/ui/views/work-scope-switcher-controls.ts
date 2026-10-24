"use client";

import { createElement } from "react";
import type { WorkReadScope } from "../../../lib/work-read-scope";
import { WORK_READ_SCOPE_ORDER, WORK_READ_SCOPE_TEXT, type WorkScopeLanguage } from "../../../lib/work-scope-navigation";

export interface WorkScopeSwitcherProps {
  value: WorkReadScope;
  onChange: (scope: WorkReadScope) => void;
  language: WorkScopeLanguage;
  /** Presentation-only guard. Data access MUST be checked on the server. */
  enabled: boolean;
}

// Next.js types CSS modules as a readonly string-indexed map, not as an
// object with known required class keys.
type WorkScopeClasses = Readonly<Record<string, string>>;

/**
 * DOM semantics and behavior shared by the styled switcher and isolated unit
 * tests. No workspace IDs, permission claims or write destinations are accepted.
 * Native buttons support Enter/Space, Tab focus and assistive technologies.
 */
export function WorkScopeSwitcherControls({
  value,
  onChange,
  language,
  enabled,
  classes,
}: WorkScopeSwitcherProps & { classes: WorkScopeClasses }) {
  // The D3 switcher must not be interactive before the migration gates pass.
  if (!enabled) return null;

  const text = WORK_READ_SCOPE_TEXT[language];
  return createElement(
    "div",
    { className: classes.group, role: "group", "aria-label": text.group, "data-work-scope-switcher": "" },
    WORK_READ_SCOPE_ORDER.map((scope) =>
      createElement(
        "button",
        {
          key: scope,
          type: "button",
          className: scope === value ? classes.active : classes.option,
          "data-work-read-scope": scope,
          "aria-pressed": scope === value,
          onClick: () => { if (scope !== value) onChange(scope); },
        },
        text.labels[scope],
      ),
    ),
  );
}
