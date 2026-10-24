"use client";

import type { WorkReadScope } from "../../../lib/work-read-scope";
import { WORK_READ_SCOPE_ORDER, WORK_READ_SCOPE_TEXT, type WorkScopeLanguage } from "../../../lib/work-scope-navigation";
import styles from "./work-scope-switcher.module.css";

/**
 * D3 prepared UI, deliberately not mounted by the current application.
 * A caller may mount this only after the 2a–2c migration, server-side
 * authorization, and legacy task-preservation gates have been verified.
 * The selected scope is a read selector; writes still require a concrete Area.
 */
export function WorkScopeSwitcher({
  value,
  onChange,
  language,
  enabled,
}: {
  value: WorkReadScope;
  onChange: (scope: WorkReadScope) => void;
  language: WorkScopeLanguage;
  enabled: boolean;
}) {
  // Do not expose an interactive selector that the legacy read model cannot honor.
  if (!enabled) return null;

  const text = WORK_READ_SCOPE_TEXT[language];
  return (
    <div className={styles.group} role="group" aria-label={text.group} data-work-scope-switcher>
      {WORK_READ_SCOPE_ORDER.map((scope) => (
        <button
          type="button"
          key={scope}
          className={scope === value ? styles.active : styles.option}
          data-work-read-scope={scope}
          aria-pressed={scope === value}
          onClick={() => { if (scope !== value) onChange(scope); }}
        >
          {text.labels[scope]}
        </button>
      ))}
    </div>
  );
}
