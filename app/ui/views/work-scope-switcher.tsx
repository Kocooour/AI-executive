"use client";

/**
 * D3 prepared UI, deliberately not mounted by the current application.
 * A caller may mount this only after the 2a–2c migration, server-side
 * authorization, and legacy task-preservation gates have been verified.
 * The selected scope is a read selector; writes still require a concrete Area.
 * The enabled prop only controls presentation; it is NOT an ACL.
 * Labels come from app/ui/copy.ts (the caller passes its `tr`); styles live in app/lumi-navigation.css.
 */
export { WorkScopeSwitcherControls as WorkScopeSwitcher, type WorkScopeSwitcherProps } from "./work-scope-switcher-controls";
