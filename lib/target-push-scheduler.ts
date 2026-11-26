/** E-2: the single owner of scheduled target attention push.
 *
 * Runs inside the existing always-on Node.js service (lib/schedulers.ts); no new
 * systemd unit, timer or writable path. One pass at a time: an in-process guard
 * plus an exclusive lock file in the already approved data StateDirectory, so a
 * second process (for example an overlapping restart) cannot run a parallel pass.
 * A stale lock (older than any possible pass) is recovered. The pass itself is
 * crash-safe: deliveries are claimed `pending` per device before sending, so a
 * restart never sends a duplicate (lib/target-attention-push-pass.ts). */
import {closeSync,linkSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeSync} from "node:fs";
import path from "node:path";
import {resolveDataDirectory} from "./data-dir";
import {TARGET_PUSH_PASS_CHILD_TIMEOUT_MS,runTargetPushPassInChild,targetPushFlagsEnabled}
  from "./target-push-process";
import type {TargetPushPassChildResult} from "./target-push-process";
import {listTargetPushSubscriptions,pruneTargetPushSubscriptions}
  from "./target-push-subscription-vault";
import {targetVapidConfig} from "./target-push-vapid";

export const TARGET_PUSH_SCHEDULER_INTERVAL_MS=5*60_000;
export const TARGET_PUSH_LOCK_FILENAME="target-push-pass.lock";
/** Longer than the child's hard timeout, so a live pass is never treated as stale. */
export const TARGET_PUSH_LOCK_STALE_MS=TARGET_PUSH_PASS_CHILD_TIMEOUT_MS+60_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TargetPushEnv=Record<string,string|undefined>;

export function targetPushStore(env:TargetPushEnv=process.env):
  {stagingDirectory:string;expectedRestoreGeneration:string}|null {
  const stagingDirectory=env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!UUID.test(expectedRestoreGeneration))return null;
  return {stagingDirectory,expectedRestoreGeneration};
}

/** Target push owns attention notifications: flags on and a bound target store.
 * Then the legacy attention push must stay silent (no double notification), even
 * while VAPID keys are still missing (push is then truthfully unavailable). */
export const targetPushOwnsAttention=(env:TargetPushEnv=process.env):boolean=>
  targetPushFlagsEnabled(env)&&targetPushStore(env)!==null;

/** Everything a scheduled pass needs, including a valid VAPID identity. */
export const targetPushDeliveryConfigured=(env:TargetPushEnv=process.env):boolean=>
  targetPushOwnsAttention(env)&&targetVapidConfig(env)!==null;

export type TargetPushLock={release():void};

/** Exclusive cross-process lock; null when another live pass holds it. */
export function acquireTargetPushLock(directory:string,nowMs=Date.now()):TargetPushLock|null {
  const file=path.join(directory,TARGET_PUSH_LOCK_FILENAME);
  for(let attempt=0;attempt<2;attempt++){
    try{
      const fd=openSync(file,"wx",0o600);
      const token=String(process.pid)+":"+String(nowMs)+":"+Math.random().toString(36).slice(2);
      try{writeSync(fd,token);}finally{closeSync(fd);}
      return {release(){
        try{if(readFileSync(file,"utf8")===token)unlinkSync(file);}catch{/* already gone */}
      }};
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")return null;
      try{
        const seen=statSync(file);
        if(nowMs-seen.mtimeMs<TARGET_PUSH_LOCK_STALE_MS)return null;
        // A crashed pass left its lock. Take it over atomically: move it aside
        // first, and only if what moved is that same stale file (inode) delete
        // it. A concurrent taker that already replaced it gets its lock back.
        const aside=file+".stale-"+String(process.pid)+"-"+Math.random().toString(36).slice(2);
        renameSync(file,aside);
        const moved=statSync(aside);
        if(moved.ino!==seen.ino||moved.dev!==seen.dev){
          try{linkSync(aside,file);}catch{/* another holder exists already */}
          unlinkSync(aside);
          return null;
        }
        unlinkSync(aside);
      }catch{return null;}
    }
  }
  return null;
}

export interface TargetPushTickDeps {
  readonly env?:TargetPushEnv;
  readonly directory?:string;
  readonly database?:()=>import("node:sqlite").DatabaseSync;
  readonly runPass?:typeof runTargetPushPassInChild;
  readonly now?:()=>number;
}

let tickRunning=false;

export type TargetPushTickResult=
  |{state:"off"|"busy"|"locked"|"failed"}
  |{state:"done";result:TargetPushPassChildResult;pruned:number};

/** One scheduled tick. Never throws and never logs device data. */
export async function runTargetPushSchedulerTick(deps:TargetPushTickDeps={}):Promise<TargetPushTickResult> {
  const env=deps.env??process.env;
  // Flags off: nothing runs. Flags on without VAPID keys: a prune-only pass.
  if(!targetPushOwnsAttention(env))return {state:"off"};
  const deliver=targetVapidConfig(env)!==null;
  if(tickRunning)return {state:"busy"};
  tickRunning=true;
  let lock:TargetPushLock|null=null;
  try{
    const directory=deps.directory??resolveDataDirectory(env);
    lock=acquireTargetPushLock(directory,(deps.now??Date.now)());
    if(!lock)return {state:"locked"};
    const database=deps.database??(await import("./server-store")).getDatabase;
    const db=database();
    const result=await (deps.runPass??runTargetPushPassInChild)(targetPushStore(env)!,
      deliver?listTargetPushSubscriptions(db):[],deliver);
    if(!result)return {state:"failed"};
    const pruned=result.liveHashes
      ? pruneTargetPushSubscriptions(db,new Set(result.liveHashes),(deps.now??Date.now)()):0;
    return {state:"done",result,pruned};
  }catch{
    return {state:"failed"};
  }finally{
    lock?.release();
    tickRunning=false;
  }
}
