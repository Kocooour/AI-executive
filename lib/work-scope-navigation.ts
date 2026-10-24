// D3 UI contract: a work scope only changes what is read, never a write target.
// Do not activate the scoped UI until the migration and data-preservation gates
// in docs/ARCHITECTURE.md have passed. The current workspace switcher stays live.
import type { WorkReadScope } from "./work-read-scope";

export const DEFAULT_WORK_READ_SCOPE: WorkReadScope = "my-plan";
export const WORK_READ_SCOPE_ORDER = ["my-plan", "personal", "shared"] as const satisfies readonly WorkReadScope[];
export type WorkScopeLanguage = "cs" | "en";

export const WORK_READ_SCOPE_TEXT: Record<WorkScopeLanguage, {
  group: string;
  labels: Record<WorkReadScope, string>;
}> = {
  cs: {
    group: "Rozsah práce",
    labels: { "my-plan": "Můj plán", personal: "Osobní", shared: "Sdílené" },
  },
  en: {
    group: "Work scope",
    labels: { "my-plan": "My plan", personal: "Personal", shared: "Shared" },
  },
};

// Keep legacy internal workspace IDs (including "all") out of this UI contract.
export function parseWorkReadScope(value: unknown): WorkReadScope | null {
  return typeof value === "string" && WORK_READ_SCOPE_ORDER.some((scope) => scope === value)
    ? value as WorkReadScope
    : null;
}
