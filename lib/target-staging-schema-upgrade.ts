/**
 * Explicit, staging-only operator upgrade from exact canonical v25 to v26.
 * No reset, data import, automatic startup migration, or production cutover.
 * The trusted pinned writer serializes preflight, additive DDL and journal
 * witness with other writes. A prior v25 backup stays restorable; once restored,
 * this explicit operation must be run again before project title commands.
 */
import {
  TARGET_PROJECT_TITLE_SCHEMA_SQL, TARGET_STORE_LEGACY_SCHEMA_VERSION,
  TARGET_STORE_SCHEMA_VERSION,
} from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

export type TargetSchemaUpgradeResult =
  | {ok:true; status:"upgraded" | "already_current"}
  | {ok:false; reason:"unavailable" | "write_failed" | "confirm_untrusted"};

export function upgradeTargetStagingV25(store: TargetStagingReadStore): TargetSchemaUpgradeResult {
  return withPinnedTargetStagingWrite<TargetSchemaUpgradeResult>(store, context => {
    const {db} = context;
    const version = (db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as
      {value:string} | undefined)?.value;
    if (version === String(TARGET_STORE_SCHEMA_VERSION)) return {ok:true,status:"already_current"};
    // The pinned writer already checked the complete v25 DDL, all data,
    // generation, anchor and witness. No guessed or partially migrated schema.
    if (version !== String(TARGET_STORE_LEGACY_SCHEMA_VERSION) ||
        !context.stillPinned() || !context.noSidecars()) return {ok:false,reason:"unavailable"};
    db.exec(TARGET_PROJECT_TITLE_SCHEMA_SQL);
    const updated = db.prepare("UPDATE metadata SET value=? WHERE key='schema_version' AND value=?")
      .run(String(TARGET_STORE_SCHEMA_VERSION),String(TARGET_STORE_LEGACY_SCHEMA_VERSION));
    if (updated.changes !== 1 || !context.stillPinned()) return {ok:false,reason:"write_failed"};
    // Verify the complete v26 schema and every existing data invariant inside
    // the same transaction before the journal intent and commit.
    const preflight = inspectIsolatedTargetStore({stagingDirectory:context.directory,
      expectedRestoreGeneration:store.expectedRestoreGeneration,mode:"r2-model"},
      {db,fd:context.databaseFd});
    if (!preflight.ok) return {ok:false,reason:"write_failed"};
    const confirmed = context.commit({kind:"schema_upgrade",payload:{from:25,to:26}});
    return confirmed ? {ok:true,status:"upgraded"} : {ok:false,reason:"confirm_untrusted"};
  }, () => ({ok:false,reason:"unavailable"}), () => ({ok:false,reason:"write_failed"}), 5_000);
}
