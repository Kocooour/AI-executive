// Test harness only (E-2 browser run): one scheduled target push tick through the
// real scheduler (lock, app-database vault, bounded pass child, pruning), so the
// browser test need not wait for the five-minute interval. It runs with the same
// isolated store, fixed clock preload and loopback fake push origin as the server.
import path from "node:path";
const run=process.env.LUMI_E2E_RUN_DIR||"";
if(process.env.AI_EXECUTIVE_E2E!=="true"||!path.basename(run).startsWith("lumi-e2e-")||
   process.env.AI_EXECUTIVE_DATA_DIR!==path.join(run,"data"))
  throw new Error("E-2 tick harness requires the isolated browser-test directory");
const {runTargetPushSchedulerTick}=await import("../lib/target-push-scheduler.ts");
const tick=await runTargetPushSchedulerTick();
process.stdout.write(JSON.stringify(tick.state==="done"
  ?{state:"done",sent:tick.result.summary.sent,pruned:tick.pruned}:{state:tick.state}));
