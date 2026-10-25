import type { DBCore, DBCoreMutateRequest } from "dexie";
import { offlineRecoveryIsHeld } from "./d2b-recovery-hold";

// Adopting restored server data ends in a page reload (hooks/use-sync.ts). From the moment it starts, nothing of the
// replaced data may be written: the save paths check this flag and do nothing, so a blur or pagehide between the
// adoption and the reload cannot put a stale title, note or draft back over the restored record.
let adopting = false;
export const beginAdoption = () => { adopting = true; };
// A persistent recovery hold blocks writes across tabs and reloads, not just during adoption.
export const isAdopting = () => adopting || offlineRecoveryIsHeld();

// A save path checks the flag when it starts, then waits (a read, an earlier save). Its write may therefore come after
// adoption has replaced the local copy, and would put the replaced data back over the restored record, from where the
// next start-up would send it. So the local database itself refuses every write once adoption has begun
// (adoptionWriteGuard, registered in lib/db.ts), except the writes of adoption's own transactions.
export class AdoptionWriteRefused extends Error {
  constructor() {
    super("Restored data is being adopted: the local database accepts no other write");
    this.name = "AdoptionWriteRefused";
  }
}
const adoptionTransactions = new WeakSet<object>();
// The transaction (Dexie's `Transaction.idbtrans`) that replaces the local copy with the restored data.
export const allowAdoptionWrites = (transaction: object) => { adoptionTransactions.add(transaction); };
// A Dexie DBCore middleware: every write (add, put, delete, clear) goes through `mutate`.
export function adoptionWriteGuard(down: DBCore): DBCore {
  return {
    ...down,
    table(name) {
      const table = down.table(name);
      return {
        ...table,
        mutate(request: DBCoreMutateRequest) {
          // A sibling can engage the persistent hold after an adoption transaction began.
          // In that case even adoption-authorized writes must abort and roll back.
          if (offlineRecoveryIsHeld() || (adopting && !adoptionTransactions.has(request.trans))) return Promise.reject(new AdoptionWriteRefused());
          return table.mutate(request);
        },
      };
    },
  };
}

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
