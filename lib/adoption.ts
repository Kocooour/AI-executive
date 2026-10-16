// Adopting restored server data ends in a page reload (hooks/use-sync.ts). From the moment it starts, nothing of the
// replaced data may be written: the save paths check this flag and do nothing, so a blur or pagehide between the
// adoption and the reload cannot put a stale title, note or draft back over the restored record.
let adopting = false;
export const beginAdoption = () => { adopting = true; };
export const isAdopting = () => adopting;

// Per tab (sessionStorage), read after the reload: what to tell the owner. `restore` and `import`: this tab ran it (the
// success message of Settings); `remote`: it happened on another device; `sibling`: in another tab of this browser.
export const afterRestoreFlagKey = "ai-executive-after-restore";
export type AfterRestoreKind = "restore" | "import" | "remote" | "sibling";
export function setAfterRestoreFlag(kind: AfterRestoreKind, overwrite = false) {
  try {
    if (!overwrite && sessionStorage.getItem(afterRestoreFlagKey)) return;
    sessionStorage.setItem(afterRestoreFlagKey, kind);
  } catch { /* storage unavailable: the page still reloads, without the message */ }
}
export function takeAfterRestoreFlag(): AfterRestoreKind | null {
  try {
    const value = sessionStorage.getItem(afterRestoreFlagKey);
    sessionStorage.removeItem(afterRestoreFlagKey);
    return value === "restore" || value === "import" || value === "remote" || value === "sibling" ? value : null;
  } catch {
    return null;
  }
}
