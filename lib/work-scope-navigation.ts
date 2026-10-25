// D3 UI contract: a work scope only changes what is read, never a write target.
// Do not activate the scoped UI until the migration and data-preservation gates
// in docs/ARCHITECTURE.md have passed. The current workspace switcher stays live.
import type { WorkReadScope } from "./work-read-scope";

export const DEFAULT_WORK_READ_SCOPE: WorkReadScope = "my-plan";
export const WORK_READ_SCOPE_ORDER = ["my-plan", "personal", "shared"] as const satisfies readonly WorkReadScope[];

// The labels are app copy (app/ui/copy.ts, both languages); these are their keys.
export const WORK_SCOPE_GROUP_COPY_KEY = "workScopeGroup";
const SCOPE_COPY_KEYS: Record<WorkReadScope, string> = {
  "my-plan": "workScopeMyPlan", personal: "workScopePersonal", shared: "workScopeShared",
};
export const workScopeCopyKey = (scope: WorkReadScope) => SCOPE_COPY_KEYS[scope];

// Keep legacy internal workspace IDs (including "all") out of this UI contract.
export function parseWorkReadScope(value: unknown): WorkReadScope | null {
  return typeof value === "string" && WORK_READ_SCOPE_ORDER.some((scope) => scope === value)
    ? value as WorkReadScope
    : null;
}
