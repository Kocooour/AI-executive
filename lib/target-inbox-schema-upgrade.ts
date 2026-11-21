/**
 * C-3a explicit staging-only v26 -> v27 Inbox migration.
 *
 * The existing target rows are historical: only this version-gated, pinned
 * operation marks them processed, without emitting any user action receipt.
 * A new task INSERT always retains unprocessed. No legacy import or reset.
 * This is NEVER called at startup or by an HTTP request.
 */
import { TARGET_INBOX_SCHEMA_SQL, TARGET_INBOX_BACKFILL_SQL } from "./target-inbox-schema";
import {
  TARGET_STORE_SCHEMA_VERSION, TARGET_STORE_PREVIOUS_SCHEMA_VERSION,
} from "./target-store-bootstrap";
import { inspectIsolatedTargetStore } from "./target-store-preflight";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";

export type TargetInboxSchemaUpgradeResult =
  | {ok:true; status:"upgraded"|"already_current"}
  | {ok:false; reason:"unavailable"|"write_failed"|"confirm_untrusted"};

export function upgradeTargetStagingInboxV26(
  store: TargetStagingReadStore,
): TargetInboxSchemaUpgradeResult {
  return withPinnedTargetStagingWrite<TargetInboxSchemaUpgradeResult>(
    store,context=>{
      const {db}=context;
      const version=(db.prepare("SELECT value FROM metadata WHERE key='schema_version'")
        .get() as {value:string}|undefined)?.value;
      if(version===String(TARGET_STORE_SCHEMA_VERSION))
        return {ok:true,status:"already_current"};
      if(version!==String(TARGET_STORE_PREVIOUS_SCHEMA_VERSION) ||
          !context.stillPinned() || !context.noSidecars())
        return {ok:false,reason:"unavailable"};
      // Transaction is already BEGIN IMMEDIATE, and preflight has validated the
      // exact v26 canonical DDL, data, restore chain and witness.
      db.exec(TARGET_INBOX_SCHEMA_SQL);
      db.exec(TARGET_INBOX_BACKFILL_SQL);
      const updated=db.prepare(
        "UPDATE metadata SET value=? WHERE key='schema_version' AND value=?",
      ).run(String(TARGET_STORE_SCHEMA_VERSION),String(TARGET_STORE_PREVIOUS_SCHEMA_VERSION));
      if(updated.changes!==1||!context.stillPinned())
        return {ok:false,reason:"write_failed"};
      const preflight=inspectIsolatedTargetStore({
        stagingDirectory:context.directory,
        expectedRestoreGeneration:store.expectedRestoreGeneration,
        mode:"r2-model",
      },{db,fd:context.databaseFd});
      if(!preflight.ok)return {ok:false,reason:"write_failed"};
      const confirmed=context.commit({kind:"schema_upgrade",payload:{from:26,to:27}});
      return confirmed?{ok:true,status:"upgraded"}:{ok:false,reason:"confirm_untrusted"};
    },
    ()=>({ok:false,reason:"unavailable"}),
    ()=>({ok:false,reason:"write_failed"}),
    5_000,
  );
}
