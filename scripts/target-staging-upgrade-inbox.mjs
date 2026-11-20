#!/usr/bin/env node
/** Manual C-3a target Inbox schema upgrade. NEVER run on app startup. */
import path from "node:path";
import { inspectIsolatedTargetStore } from "../lib/target-store-preflight.ts";
import { TARGET_STORE_SCHEMA_VERSION } from "../lib/target-store-bootstrap.ts";
import { upgradeTargetStagingInboxV26 } from "../lib/target-inbox-schema-upgrade.ts";

const usage=[
  "usage: target-staging-upgrade-inbox.mjs --check|--apply",
  "  --directory <absolute isolated staging directory>",
  "  --generation <exact current restore generation>",
].join(" ");
try {
  const args=process.argv.slice(2);
  if(args.length===1 && args[0]==="--help"){
    process.stdout.write(usage+"\n");
  } else {
    const mode=args.filter(a=>a==="--check"||a==="--apply");
    if(mode.length!==1||args.length!==5)throw Error();
    const props=new Map();
    const other=args.filter(a=>a!=="--check"&&a!=="--apply");
    for(let i=0;i<other.length;i+=2){
      if(!["--directory","--generation"].includes(other[i])||props.has(other[i])||
          !other[i+1]||other[i+1].startsWith("--"))throw Error();
      props.set(other[i],other[i+1]);
    }
    const directory=props.get("--directory"),generation=props.get("--generation");
    if(!directory||!path.isAbsolute(directory)||!generation)throw Error();
    const store={stagingDirectory:directory,expectedRestoreGeneration:generation};
    if(mode[0]==="--check"){
      // No writer, DDL, journal append or writable SQLite handle.
      // Check means *ready/current v27*, not merely "safe to upgrade from v26".
      // Older canonical versions remain acceptable to the separate explicit --apply.
      const check=inspectIsolatedTargetStore({...store,mode:"r2-model",
        requiredSchemaVersion:TARGET_STORE_SCHEMA_VERSION});
      process.stdout.write(JSON.stringify({ok:check.ok,mode:"check",
        schemaVersionRequired:TARGET_STORE_SCHEMA_VERSION,issues:check.issues})+"\n");
      process.exitCode=check.ok?0:1;
    } else {
      const result=upgradeTargetStagingInboxV26(store);
      process.stdout.write(JSON.stringify(result)+"\n");
      process.exitCode=result.ok?0:result.reason==="confirm_untrusted"?2:1;
    }
  }
} catch {
  process.stderr.write(usage+"\n");
  process.exitCode=1;
}
