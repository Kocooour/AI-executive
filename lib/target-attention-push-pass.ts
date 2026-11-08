/**
 * R2d.5d.2: identity-bound Attention push pass (staging only).
 *
 * Library only: NO web-push client, network, timer/scheduler or HTTP route. The
 * sender is injected. Identities come exclusively from the verified store (the
 * session authority passes a credential minter bound to its private key); no
 * client input selects a user or a target. Algorithm (docs/R2D5-PUSH-PASS.md):
 *  1. per enabled, unpaused identity read its ACTIVE candidates with the
 *     actor-bound preflighted selector in the identity's STORED time zone;
 *  2. ONE pinned write transaction re-verifies settings/epoch, closes stale
 *     `pending`, records the baseline on first enable (send nothing) or plans
 *     and claims deliveries as `pending` (the insert guard plus an explicit SQL
 *     re-check cover ACL, open status, current deadline and snooze/dismiss);
 *  3. outside any transaction each claimed delivery goes to the user's own live
 *     devices; immediately before EVERY send a short read confirms the delivery
 *     row still exists in the expected state and the target is still live;
 *  4. each device result is committed at once (a crash cannot forget a sent
 *     device); `gone` revokes that target; the delivery is finalised like legacy.
 */
import type {AttentionCandidate} from "./target-attention-read-model";
import {attentionEvaluationWindow,currentAttentionRule}
  from "./target-attention-read-model";
import {announceableTargetAttentionCandidate,inTargetQuietHours,
  planTargetAttentionPushes,targetAttentionDeliveryKey,
  targetAttentionPushPayload,targetAttentionWindowStartMs,
  TARGET_ATTENTION_PUSH_MAX_ATTEMPTS} from "./target-attention-push-planner";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import type {TargetStagingPinnedWriteContext} from "./target-staging-pinned-write";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import {readPreflightedAttentionCandidatePage,readPreflightedStoreSnapshot}
  from "./target-task-staging-reader";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {readNotificationSettingsInSnapshot,targetPushBaselineKey,
  targetPushBaselineValue} from "./target-notification-writer";
import type {TargetNotificationSettingsView} from "./target-notification-writer";

export type TargetPushSendResult="sent"|"failed"|"gone";
export interface TargetPushPayload{title:string;body:string;url:string;tag:string}
/** Injected transport. Called only for the recipient's own live target. */
export interface TargetPushSender{
  sendTo(userId:string,targetId:string,payload:TargetPushPayload):Promise<TargetPushSendResult>;
}
export interface TargetAttentionPushPassSummary{
  users:number;sent:number;
  held:{quiet_hours:number;daily_limit:number;disabled:number};
  /** Enabled identities left for later passes because of the per-pass cap. */
  deferred?:number;
  /** True when another pass was already running in this process (nothing done). */
  busy?:true;
}

export const TARGET_PUSH_PASS_STALE_PENDING_MS=15*60_000;
export const TARGET_PUSH_PASS_MAX_USERS=256;
/** A send that does not settle in time counts as failed (retried later, at most 3x). */
export const TARGET_PUSH_SEND_TIMEOUT_MS=30_000;
function withTimeout<T>(promise:Promise<T>,ms:number):Promise<T|"timeout"> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<"timeout">(resolve=>{timer=setTimeout(()=>resolve("timeout"),ms);});
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>{if(timer)clearTimeout(timer);});
}
export const TARGET_PUSH_PASS_MAX_CANDIDATES=500;
const PAGE=100;
const DAY=24*3_600_000;
const MAX=TARGET_ATTENTION_PUSH_MAX_ATTEMPTS;
const OP_PASS=3,OP_DEVICE=4,OP_FINAL=5;

let passRunning=false;

type Ctx=TargetStagingPinnedWriteContext;
/** Pinned write transaction; null when denied/failed. Body commits only if it changed something. */
function writeTxn<T>(store:TargetStagingReadStore,body:(ctx:Ctx)=>T):T|null {
  return withPinnedTargetStagingWrite<T|null>(store,ctx=>{
    try{return body(ctx);}catch{return null;}
  },()=>null,()=>null);
}
const journal=(ctx:Ctx,db:Ctx["db"],user:string,op:number,n:number)=>{
  const e=db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id=?")
    .get(user) as {revision:number};
  // Content-free: no user, task, key, target or time.
  ctx.commit({kind:"personal_notification",payload:{epoch:e.revision,op,n}});
};

const sameSettings=(a:TargetNotificationSettingsView,b:TargetNotificationSettingsView)=>
  a.timeZone===b.timeZone&&a.attentionPush===b.attentionPush&&a.paused===b.paused&&
  a.quietStart===b.quietStart&&a.quietEnd===b.quietEnd&&a.dailyLimit===b.dailyLimit&&
  a.settingsRevision===b.settingsRevision&&a.notificationEpoch===b.notificationEpoch;

/** Same eligibility as the delivery insert guard plus the current rule and the actor's lifecycle. */
function eligible(db:Ctx["db"],user:string,c:AttentionCandidate,nowMs:number,tz:string):boolean {
  const row=db.prepare(`SELECT t.due_on AS dueOn FROM tasks t
    LEFT JOIN projects p ON p.id=t.project_id
    JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
    LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=?
    WHERE t.id=? AND t.status='open' AND t.due_on=? AND
      ((a.kind='private' AND a.owner_user_id=?) OR
       (a.kind='shared' AND t.assignee_user_id=? AND m.role IN ('editor','admin')))`)
    .get(user,c.taskId,c.relevantOn,user,user) as {dueOn:string}|undefined;
  if(!row)return false;
  const hidden=db.prepare(`SELECT 1 FROM personal_attention_states WHERE user_id=? AND task_id=?
    AND rule_id=? AND occurrence_on=? AND (state='dismissed' OR
      (state='snoozed' AND snoozed_until_ms>?))`)
    .get(user,c.taskId,c.ruleId,c.relevantOn,nowMs);
  if(hidden)return false;
  const window=attentionEvaluationWindow(nowMs,tz);
  return !!window&&currentAttentionRule(row.dueOn,null,window)===c.ruleId;
}

interface Work{
  key:string;candidate:AttentionCandidate;mode:"claimed"|"retry";
  /** Revision pinned at plan time. Changed notification preferences invalidate unsent claims. */
  settingsRevision:number;
}
type Phase1=
  | {kind:"skip"}
  | {kind:"baseline"}
  | {kind:"plan";work:Work[];held:"quiet_hours"|"daily_limit"|"disabled"|null};

function readCandidates(store:TargetStagingReadStore,cred:TargetStagingReadCredential,
  view:TargetNotificationSettingsView,nowMs:number):{items:AttentionCandidate[];attentionEpoch:number}|null {
  const items:AttentionCandidate[]=[];
  let epoch:number|null=null,revision:string|null=null,offset=0;
  for(;;){
    const page=readPreflightedAttentionCandidatePage(store,cred,{
      areaFilter:"all",view:"active",evaluatedAtMs:nowMs,
      limit:PAGE,offset});
    // R2d.4k: the page is evaluated in the profile zone of ITS snapshot; a
    // settings change since `view` was read abandons this user for this pass.
    if(!page||page.timeZone!==view.timeZone)return null;
    // A change between pages (epoch/revision) abandons this user for this pass.
    if(epoch===null){epoch=page.attentionEpoch;revision=page.revision;}
    else if(page.attentionEpoch!==epoch||page.revision!==revision)return null;
    items.push(...page.items);
    if(items.length>TARGET_PUSH_PASS_MAX_CANDIDATES)return null;
    if(!page.hasMore)break;
    if(page.items.length===0)return null;
    offset+=page.items.length;
  }
  return {items,attentionEpoch:epoch as number};
}

function phase1(store:TargetStagingReadStore,user:string,view:TargetNotificationSettingsView,
  items:AttentionCandidate[],attentionEpoch:number,nowMs:number):Phase1|null {
  return writeTxn<Phase1>(store,ctx=>{
    const {db}=ctx;
    const current=readNotificationSettingsInSnapshot(db,user);
    if(!current||!sameSettings(current,view)||!current.attentionPush||current.paused)
      return {kind:"skip"};
    const att=db.prepare("SELECT revision FROM personal_attention_epochs WHERE user_id=?")
      .get(user) as {revision:number}|undefined;
    if(!att||att.revision!==attentionEpoch)return {kind:"skip"};
    let changes=0;
    // Only durable failed sends are safe to retry after a crash. A reserved
    // target may have been in flight and is therefore abandoned on recovery;
    // committed sent timestamps still count against the rolling 24h limit.
    const stale=db.prepare(`SELECT delivery_key AS k FROM personal_attention_deliveries
      WHERE user_id=? AND status='pending' AND last_attempt_at_ms<?`)
      .all(user,nowMs-TARGET_PUSH_PASS_STALE_PENDING_MS) as {k:string}[];
    for(const {k} of stale){
      const devices=db.prepare(`SELECT x.status,x.attempts,
        x.last_attempt_at_ms AS at,(t.revoked_at_ms IS NULL) AS live
        FROM personal_attention_device_deliveries x JOIN personal_push_targets t
        ON t.user_id=x.user_id AND t.target_id=x.target_id
        WHERE x.user_id=? AND x.delivery_key=?`)
        .all(user,k) as {status:string;attempts:number;at:number;live:number}[];
      const sentAt=devices.filter(d=>d.status==="sent")
        .reduce<number|null>((at,d)=>at===null?d.at:Math.min(at,d.at),null);
      const retryable=devices.some(d=>d.live===1&&(d.status==="reserved"||
        (d.status==="failed"&&d.attempts<MAX)));
      const attempted=devices.some(d=>d.status==="failed"||d.status==="gone");
      // A durable reserved row has NOT started a send and remains retryable.
      // Only a persistently marked in-flight send can have an unrecorded outcome.
      changes+=Number(db.prepare(`UPDATE personal_attention_device_deliveries
        SET status='unknown' WHERE user_id=? AND delivery_key=? AND status='inflight'`)
        .run(user,k).changes);
      const result=sentAt!==null?(retryable?"partial":"sent"):
        (retryable||attempted)?"failed":"undelivered";
      const change=db.prepare(`UPDATE personal_attention_deliveries SET status=?,
        sent_at_ms=?,last_attempt_at_ms=max(last_attempt_at_ms,?)
        WHERE user_id=? AND delivery_key=? AND status='pending'`)
        .run(result,sentAt,nowMs,user,k).changes;
      if(change!==1)return null;
      changes++;
    }
    const announceable=items.filter(announceableTargetAttentionCandidate);
    const keyOf=(c:AttentionCandidate)=>targetAttentionDeliveryKey(c.ruleId,c.taskId,c.relevantOn);
    // Pin the live target cohort atomically with its parent claim. Targets
    // registered later have no row and never receive a historical retry.
    const reserveTargets=(key:string):number=>{
      const ids=db.prepare(`SELECT target_id AS id FROM personal_push_targets
        WHERE user_id=? AND revoked_at_ms IS NULL ORDER BY created_at_ms,target_id`)
        .all(user) as {id:string}[];
      const stmt=db.prepare(`INSERT INTO personal_attention_device_deliveries
        (user_id,delivery_key,target_id,status,attempts,last_attempt_at_ms)
        VALUES (?,?,?,'reserved',0,?)`);
      for(const {id} of ids)if(stmt.run(user,key,id,nowMs).changes!==1)
        throw new Error();
      return ids.length;
    };
    const insert=(c:AttentionCandidate,status:"baseline"|"pending")=>{
      const run=()=>db.prepare(`INSERT INTO personal_attention_deliveries
        (user_id,delivery_key,task_id,rule_id,occurrence_on,status,attempts,last_attempt_at_ms)
        VALUES (?,?,?,?,?,?,?,?)`).run(user,keyOf(c),c.taskId,c.ruleId,c.relevantOn,
        status,0,nowMs).changes===1;
      try{return run();}
      catch(error){
        // A candidate that lost access (or its deadline) between read and claim is
        // simply not claimed; any other failure aborts the whole user.
        if(!eligible(db,user,c,nowMs,view.timeZone))return false;
        throw error;
      }
    };
    const marker=db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(targetPushBaselineKey(user)) as {value:string}|undefined;
    if(!marker){
      // First enable: everything already announceable is known; nothing is sent.
      const known=new Set((db.prepare(
        "SELECT delivery_key AS k FROM personal_attention_deliveries WHERE user_id=?"
      ).all(user) as {k:string}[]).map(r=>r.k));
      for(const c of announceable){
        if(known.has(keyOf(c)))continue;
        known.add(keyOf(c));
        if(insert(c,"baseline"))changes++;
      }
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
        .run(targetPushBaselineKey(user),targetPushBaselineValue(user));
      changes++;
      journal(ctx,db,user,OP_PASS,changes);
      return {kind:"baseline"};
    }
    if(marker.value!==targetPushBaselineValue(user))return null; // corrupt marker: fail closed (preflight rejects it too)
    // A failed parent is retryable as long as an ORIGINAL live target has an
    // untouched reservation or has fewer than MAX actual device attempts.
    // Parent attempts are diagnostic; never discard reserved devices because
    // other targets exhausted their individual retry budgets.
    const rows=db.prepare(`SELECT d.delivery_key AS k,d.status,d.attempts,
      EXISTS(SELECT 1 FROM personal_attention_device_deliveries x
        JOIN personal_push_targets t ON t.user_id=x.user_id AND t.target_id=x.target_id
        WHERE x.user_id=d.user_id AND x.delivery_key=d.delivery_key
          AND t.revoked_at_ms IS NULL AND
          (x.status='reserved' OR (x.status='failed' AND x.attempts<?))) AS retryable
      FROM personal_attention_deliveries d WHERE d.user_id=?`
    ).all(MAX,user) as {k:string;status:string;attempts:number;retryable:number}[];
    const handled=new Set(rows.filter(r=>!(r.status==="failed"&&r.retryable===1)).map(r=>r.k));
    const partial=new Set(rows.filter(r=>r.status==="partial").map(r=>r.k));
    const since=targetAttentionWindowStartMs(nowMs);
    const sent=db.prepare(`SELECT COUNT(*) AS n FROM personal_attention_deliveries
      WHERE user_id=? AND ((status IN ('sent','partial') AND sent_at_ms>?) OR
        (status='pending' AND last_attempt_at_ms>?))`).get(user,since,since) as {n:number};
    const decision=planTargetAttentionPushes({candidates:items,
      settings:{timeZone:current.timeZone,attentionPush:current.attentionPush,
        quietStart:current.quietStart,quietEnd:current.quietEnd,
        dailyLimit:current.dailyLimit,paused:current.paused},
      handled,sentInLast24h:sent.n,nowMs});
    const byKey=new Map(announceable.map(c=>[keyOf(c),c]));
    const work:Work[]=[];
    for(const planned of decision.send){
      const c=byKey.get(planned.deliveryKey);
      if(!c||!eligible(db,user,c,nowMs,view.timeZone))continue;
      const prior=rows.find(r=>r.k===planned.deliveryKey);
      if(prior){
        // Re-claiming a failed parent is not a send. Keep its attempt count;
        // only markDeviceInflight increments it when a real send can begin.
        const upd=db.prepare(`UPDATE personal_attention_deliveries SET status='pending',
          last_attempt_at_ms=max(last_attempt_at_ms,?)
          WHERE user_id=? AND delivery_key=? AND status='failed' AND EXISTS (
            SELECT 1 FROM personal_attention_device_deliveries x
            JOIN personal_push_targets t ON t.user_id=x.user_id AND t.target_id=x.target_id
            WHERE x.user_id=? AND x.delivery_key=? AND t.revoked_at_ms IS NULL
              AND (x.status='reserved' OR (x.status='failed' AND x.attempts<?)))`)
          .run(nowMs,user,planned.deliveryKey,user,planned.deliveryKey,MAX).changes;
        if(upd!==1)continue;
        changes++;
      }else{
        if(!insert(c,"pending"))continue;
        changes++;
        changes+=reserveTargets(planned.deliveryKey);
      }
      work.push({key:planned.deliveryKey,candidate:c,mode:"claimed",
        settingsRevision:current.settingsRevision});
    }
    // Finishing a partial delivery is no new announcement: no daily limit, but
    // never in the user's quiet hours.
    let quiet=true;
    try{quiet=inTargetQuietHours(nowMs,current.timeZone,current.quietStart,current.quietEnd);}
    catch{quiet=true;}
    if(!quiet)for(const c of announceable){
      const key=keyOf(c);
      if(partial.has(key)&&eligible(db,user,c,nowMs,view.timeZone))
        work.push({key,candidate:c,mode:"retry",settingsRevision:current.settingsRevision});
    }
    if(changes>0)journal(ctx,db,user,OP_PASS,changes);
    return {kind:"plan",work,held:decision.held};
  });
}

interface DeliveryState{
  status:string;sentAt:number|null;settingsOn:boolean;quiet:boolean;
  settingsRevision:number;
  /** The actor snoozed (unexpired) or dismissed this occurrence meanwhile. */
  hidden:"snoozed"|"dismissed"|null;
  targets:string[];devices:Map<string,{status:string;attempts:number}>;
}
/** Short snapshot read: delivery row, own live targets, own device rows, settings still on. */
function readDeliveryState(store:TargetStagingReadStore,user:string,key:string,
  nowMs:number):DeliveryState|null {
  return readPreflightedStoreSnapshot<DeliveryState|null>(store,db=>{
    const d=db.prepare(`SELECT status,sent_at_ms AS sentAt,task_id AS taskId,rule_id AS ruleId,
      occurrence_on AS occurrenceOn FROM personal_attention_deliveries
      WHERE user_id=? AND delivery_key=?`).get(user,key) as {status:string;sentAt:number|null;
        taskId:string;ruleId:string;occurrenceOn:string}|undefined;
    if(!d)return null;
    // A snooze/dismiss made during the pass must stop further devices too.
    const hiddenRow=db.prepare(`SELECT state FROM personal_attention_states WHERE user_id=?
      AND task_id=? AND rule_id=? AND occurrence_on=? AND
      (state='dismissed' OR (state='snoozed' AND snoozed_until_ms > ?))`)
      .get(user,d.taskId,d.ruleId,d.occurrenceOn,nowMs) as
        {state:"snoozed"|"dismissed"}|undefined;
    const hidden=hiddenRow?.state??null;
    const s=readNotificationSettingsInSnapshot(db,user);
    const targets=(db.prepare(`SELECT target_id AS id FROM personal_push_targets
      WHERE user_id=? AND revoked_at_ms IS NULL ORDER BY created_at_ms,target_id`)
      .all(user) as {id:string}[]).map(r=>r.id);
    const devices=new Map((db.prepare(`SELECT target_id AS id,status,attempts
      FROM personal_attention_device_deliveries WHERE user_id=? AND delivery_key=?`)
      .all(user,key) as {id:string;status:string;attempts:number}[])
      .map(r=>[r.id,{status:r.status,attempts:r.attempts}]));
    // Always use the latest stored zone/window, never only the pass-start check.
    let quiet=true;
    try{if(s)quiet=inTargetQuietHours(nowMs,s.timeZone,s.quietStart,s.quietEnd);}
    catch{quiet=true;}
    return {status:d.status,sentAt:d.sentAt,settingsOn:!!s&&s.attentionPush&&!s.paused,
      settingsRevision:s?.settingsRevision??-1,quiet,hidden,targets,devices};
  });
}

/** Commit the send-start marker BEFORE calling the external sender. A crash can
 * only abandon this specific target; other reserved devices remain safe to resume. */
function markDeviceInflight(store:TargetStagingReadStore,user:string,key:string,
  target:string,expected:"pending"|"partial",nowMs:number):boolean {
  return writeTxn<boolean>(store,ctx=>{
    const {db}=ctx;
    const changed=db.prepare(`UPDATE personal_attention_device_deliveries
      SET status='inflight',last_attempt_at_ms=max(last_attempt_at_ms,?)
      WHERE user_id=? AND delivery_key=? AND target_id=?
      AND (status='reserved' OR (status='failed' AND attempts<?))
      AND EXISTS (SELECT 1 FROM personal_attention_deliveries d
        WHERE d.user_id=? AND d.delivery_key=? AND d.status=?)
      AND EXISTS (SELECT 1 FROM personal_push_targets t
        WHERE t.user_id=? AND t.target_id=? AND t.revoked_at_ms IS NULL)`)
      .run(nowMs,user,key,target,MAX,user,key,expected,user,target).changes;
    if(changed!==1)return false;
    const device=db.prepare(`SELECT attempts FROM personal_attention_device_deliveries
      WHERE user_id=? AND delivery_key=? AND target_id=? AND status='inflight'`)
      .get(user,key,target) as {attempts:number}|undefined;
    if(!device)return false;
    // Count only started sends, not claims or crash-recovery passes. The
    // highest device attempt is a bounded diagnostic parent attempt counter.
    // Refresh the parent heartbeat so a long multi-device pass is not stale.
    if(db.prepare(`UPDATE personal_attention_deliveries SET
      attempts=max(attempts,?),last_attempt_at_ms=max(last_attempt_at_ms,?)
      WHERE user_id=? AND delivery_key=? AND status=?`)
      .run(device.attempts+1,nowMs,user,key,expected).changes!==1)return false;
    journal(ctx,db,user,OP_DEVICE,2);
    return true;
  })===true;
}

function recordDevice(store:TargetStagingReadStore,user:string,key:string,target:string,
  result:TargetPushSendResult,nowMs:number):boolean {
  return writeTxn<boolean>(store,ctx=>{
    const {db}=ctx;
    const row=db.prepare(`SELECT status,attempts FROM personal_attention_device_deliveries
      WHERE user_id=? AND delivery_key=? AND target_id=?`)
      .get(user,key,target) as {status:string;attempts:number}|undefined;
    if(!row||row.status!=="inflight"||row.attempts>=MAX)return false;
    if(db.prepare(`UPDATE personal_attention_device_deliveries SET status=?,attempts=attempts+1,
      last_attempt_at_ms=max(last_attempt_at_ms,?) WHERE user_id=? AND delivery_key=? AND target_id=?
      AND status='inflight'`).run(result,nowMs,user,key,target).changes!==1)
      return false;
    let n=1;
    if(result==="gone"){
      // Endpoint expired: revoke exactly this target through the guarded UPDATE.
      const t=db.prepare(`SELECT created_at_ms AS c FROM personal_push_targets
        WHERE user_id=? AND target_id=? AND revoked_at_ms IS NULL`)
        .get(user,target) as {c:number}|undefined;
      if(t&&db.prepare(`UPDATE personal_push_targets SET revoked_at_ms=? WHERE user_id=? AND
        target_id=? AND revoked_at_ms IS NULL`).run(Math.max(nowMs,t.c),user,target).changes===1)n++;
    }
    journal(ctx,db,user,OP_DEVICE,n);
    return true;
  })===true;
}

/** Release only a claim whose original targets are all still unattempted.
 * Parent deletion atomically cascades the reserved rows. */
function releaseUnsentClaim(store:TargetStagingReadStore,user:string,work:Work):boolean {
  if(work.mode!=="claimed")return false;
  return writeTxn<boolean>(store,ctx=>{
    const {db}=ctx;
    const removed=db.prepare(`DELETE FROM personal_attention_deliveries
      WHERE user_id=? AND delivery_key=? AND status='pending'
        AND EXISTS(SELECT 1 FROM personal_attention_device_deliveries
          WHERE user_id=? AND delivery_key=? AND status='reserved')
        AND NOT EXISTS(SELECT 1 FROM personal_attention_device_deliveries
          WHERE user_id=? AND delivery_key=? AND status<>'reserved')`)
      .run(user,work.key,user,work.key,user,work.key).changes;
    if(removed!==1)return false;
    journal(ctx,db,user,OP_FINAL,1);
    return true;
  })===true;
}

/** Finalisation preserves the originally reserved targets until the quiet
 * window ends. Later registrations have no reserved row. */
function finalize(store:TargetStagingReadStore,user:string,work:Work,nowMs:number,
  hidden=false):boolean {
  return writeTxn<boolean>(store,ctx=>{
    const {db}=ctx;
    const d=db.prepare(`SELECT status,sent_at_ms AS sentAt FROM personal_attention_deliveries
      WHERE user_id=? AND delivery_key=?`).get(user,work.key) as
      {status:string;sentAt:number|null}|undefined;
    const expected=work.mode==="claimed"?"pending":"partial";
    if(!d||d.status!==expected)return false;
    const devices=db.prepare(`SELECT x.status AS status,x.attempts AS attempts,
      (t.revoked_at_ms IS NULL) AS live FROM personal_attention_device_deliveries x
      JOIN personal_push_targets t ON t.user_id=x.user_id AND t.target_id=x.target_id
      WHERE x.user_id=? AND x.delivery_key=?`).all(user,work.key) as
      {status:string;attempts:number;live:number}[];
    // Another pass/process may still have an active send for this occurrence.
    // Never finalise it as failed/sent while that device is in flight.
    if(devices.some(r=>r.status==="inflight"))return false;
    const delivered=devices.some(r=>r.status==="sent");
    // A user-hidden occurrence is settled, not queued again after restore.
    const retryable=!hidden&&devices.some(r=>r.live===1&&(r.status==="reserved"||
      (r.status==="failed"&&r.attempts<MAX)));
    let sql:string;let args:unknown[];
    if(delivered){
      sql=`UPDATE personal_attention_deliveries SET status=?,sent_at_ms=COALESCE(sent_at_ms,?),
        last_attempt_at_ms=max(last_attempt_at_ms,?) WHERE user_id=? AND delivery_key=? AND status=?`;
      args=[retryable?"partial":"sent",nowMs,nowMs,user,work.key,expected];
    }else if(hidden||devices.length===0){
      // No subscribed device: not delivered and never retried (no backlog for later devices).
      sql=`UPDATE personal_attention_deliveries SET status='undelivered',
        last_attempt_at_ms=max(last_attempt_at_ms,?) WHERE user_id=? AND delivery_key=? AND status=?`;
      args=[nowMs,user,work.key,expected];
    }else{
      sql=`UPDATE personal_attention_deliveries SET status='failed',
        last_attempt_at_ms=max(last_attempt_at_ms,?)
        WHERE user_id=? AND delivery_key=? AND status=?`;
      args=[nowMs,user,work.key,expected];
    }
    if(db.prepare(sql).run(...(args as never[])).changes!==1)return false;
    journal(ctx,db,user,OP_FINAL,1);
    return delivered&&d.sentAt===null;
  })===true;
}

async function deliver(store:TargetStagingReadStore,sender:TargetPushSender,user:string,
  work:Work,clock:()=>number):Promise<boolean> {
  const at=()=>{const n=clock();return Number.isSafeInteger(n)&&n>0?n:null;};
  const initial=at();
  if(initial===null)return false;
  const first=readDeliveryState(store,user,work.key,initial);
  const expected=work.mode==="claimed"?"pending":"partial";
  if(!first||first.status!==expected)return false;
  const stop=(state:DeliveryState,nowMs:number):boolean=>{
    if((state.hidden==="snoozed"||state.quiet||
      (state.hidden===null&&state.settingsRevision!==work.settingsRevision))&&
      releaseUnsentClaim(store,user,work))return false;
    // Dismissed means finished; a quiet boundary means the unsent devices
    // remain eligible after the window. No already-sent device is retried.
    return finalize(store,user,work,nowMs,state.hidden!==null);
  };
  if(first.hidden||first.quiet||!first.settingsOn||
      first.settingsRevision!==work.settingsRevision)return stop(first,initial);
  const payload=targetAttentionPushPayload(work.candidate);
  if(!payload)return false;
  for(const target of first.targets){
    const known=first.devices.get(target);
    if(!known||(known.status!=="reserved"&&
      (known.status!=="failed"||known.attempts>=MAX)))continue;
    // Pre-send live check after *every* previous sender: identity, target,
    // lifecycle and quiet window all use a fresh snapshot and a fresh clock.
    const current=at();
    if(current===null)return false;
    const state=readDeliveryState(store,user,work.key,current);
    if(!state||state.status!==expected)return false;
    if(!state.settingsOn||state.hidden||state.quiet||
        state.settingsRevision!==work.settingsRevision)return stop(state,current);
    if(!state.targets.includes(target))continue;
    const device=state.devices.get(target);
    if(!device||(device.status!=="reserved"&&
      (device.status!=="failed"||device.attempts>=MAX)))continue;
    // Never leave an ambiguous reserved row on crash: mark precisely the
    // device whose send is about to start in a separate durable transaction.
    if(!markDeviceInflight(store,user,work.key,target,expected,current))return false;
    let result:TargetPushSendResult;
    try{
      // A hung push service must not wedge the single-flight pass forever.
      const r=await withTimeout(sender.sendTo(user,target,{...payload}),TARGET_PUSH_SEND_TIMEOUT_MS);
      result=r==="sent"||r==="gone"?r:"failed";
    }catch{result="failed";}
    const finished=at();
    if(finished===null||!recordDevice(store,user,work.key,target,result,finished))return false;
  }
  const completed=at();
  return completed===null?false:finalize(store,user,work,completed);
}

/**
 * One pass over all enabled, unpaused identities. `credentialFor` mints a
 * server-side read credential for an identity of the VERIFIED store (the
 * session authority provides it; clients never do). Single-flight per process.
 */
export async function runTargetAttentionPushPass(
  store:TargetStagingReadStore,input:{
    nowMs:number;sender:TargetPushSender;
    credentialFor:(userId:string)=>TargetStagingReadCredential|null;
    /** Injectable monotonic pass clock for deterministic boundary tests. */
    clock?:()=>number;
  },
):Promise<TargetAttentionPushPassSummary> {
  const summary:TargetAttentionPushPassSummary={users:0,sent:0,
    held:{quiet_hours:0,daily_limit:0,disabled:0}};
  if(passRunning)return {...summary,busy:true};
  passRunning=true;
  try{
    const {nowMs,sender}=input;
    const started=Date.now();
    // Anchor elapsed wall-clock time to the injected pass instant. Existing
    // callers can still use a simulated nowMs; real passes track elapsed time.
    const clock=input.clock??(()=>nowMs+Math.max(0,Date.now()-started));
    if(!Number.isSafeInteger(nowMs)||nowMs<=0||!sender||
        typeof sender.sendTo!=="function")return summary;
    const listing=readPreflightedStoreSnapshot<{views:[string,TargetNotificationSettingsView][];off:number;deferred:number}>(
      store,db=>{
        const ids=(db.prepare("SELECT user_id AS id FROM personal_notification_settings ORDER BY user_id COLLATE BINARY")
          .all() as {id:string}[]).map(r=>r.id);
        const enabled:[string,TargetNotificationSettingsView][]=[];
        let off=0;
        for(const id of ids){
          const v=readNotificationSettingsInSnapshot(db,id);
          if(v&&v.attentionPush&&!v.paused)enabled.push([id,v]);
          else off++;
        }
        // Bounded work per pass with a rotating start (one step per minute),
        // so identities beyond the cap are served on later passes, never starved.
        const n=enabled.length,cap=Math.min(n,TARGET_PUSH_PASS_MAX_USERS);
        const start=n===0?0:Math.floor(nowMs/60_000)%n;
        const views=Array.from({length:cap},(_,i)=>enabled[(start+i)%n]);
        return {views,off,deferred:n-cap};
      });
    if(!listing)return summary;
    summary.held.disabled+=listing.off;
    if(listing.deferred)summary.deferred=listing.deferred;
    for(const [user,view] of listing.views){
      summary.users++;
      try{
        const cred=input.credentialFor(user);
        if(!cred){summary.held.disabled++;continue;}
        const read=readCandidates(store,cred,view,nowMs);
        if(!read)continue;
        const plan=phase1(store,user,view,read.items,read.attentionEpoch,nowMs);
        if(!plan||plan.kind==="skip")continue;
        if(plan.kind==="baseline")continue;
        if(plan.held)summary.held[plan.held]++;
        for(const work of plan.work){
          if(await deliver(store,sender,user,work,clock))summary.sent++;
        }
      }catch{/* one identity never stops the others; nothing is leaked */}
    }
    return summary;
  }finally{passRunning=false;}
}
