"use client";

import { WorkScopeSwitcherControls, type WorkScopeSwitcherProps } from "./work-scope-switcher-controls";
import styles from "./work-scope-switcher.module.css";

/**
 * D3 prepared UI, deliberately not mounted by the current application.
 * A caller may mount this only after the 2a–2c migration, server-side
 * authorization, and legacy task-preservation gates have been verified.
 * The selected scope is a read selector; writes still require a concrete Area.
 * The enabled prop only controls presentation; it is NOT an ACL.
 */
export function WorkScopeSwitcher(props: WorkScopeSwitcherProps) {
  return <WorkScopeSwitcherControls {...props} classes={styles} />;
}
