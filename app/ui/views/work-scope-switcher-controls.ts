"use client";

import { createElement } from "react";
import type { WorkReadScope } from "../../../lib/work-read-scope";
import { WORK_READ_SCOPE_ORDER, workScopeCopyKey, WORK_SCOPE_GROUP_COPY_KEY } from "../../../lib/work-scope-navigation";

export interface WorkScopeSwitcherProps {
  value: WorkReadScope;
  onChange: (scope: WorkReadScope) => void;
  /** The app's translation function (app/ui/copy.ts). */
  tr: (key: string) => string;
  /** Presentation-only guard. Data access MUST be checked on the server. */
  enabled: boolean;
}

/**
 * DOM semantics and behavior of the switcher, testable without the app. No workspace IDs, permission
 * claims or write destinations are accepted. Native buttons support Enter/Space, Tab focus and assistive
 * technologies. Styles: `.workScopeSwitcher` / `.workScopeOption` in app/lumi-navigation.css.
 */
export function WorkScopeSwitcherControls({ value, onChange, tr, enabled }: WorkScopeSwitcherProps) {
  // The D3 switcher must not be interactive before the migration gates pass.
  if (!enabled) return null;

  return createElement(
    "div",
    { className: "workScopeSwitcher", role: "group", "aria-label": tr(WORK_SCOPE_GROUP_COPY_KEY), "data-work-scope-switcher": "" },
    WORK_READ_SCOPE_ORDER.map((scope) =>
      createElement(
        "button",
        {
          key: scope,
          type: "button",
          className: "workScopeOption",
          "data-work-read-scope": scope,
          "aria-pressed": scope === value,
          onClick: () => { if (scope !== value) onChange(scope); },
        },
        tr(workScopeCopyKey(scope)),
      ),
    ),
  );
}
