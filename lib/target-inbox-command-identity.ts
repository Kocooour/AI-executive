/** C-3a server-minted, actor-bound Inbox CAS and self-bound command UUID.
 * Issuance never persists a row: the signed CAS authenticates an actual
 * server-authorized snapshot, even after the task moves or is tombstoned.
 * The UUID commits to that exact original command, preventing a retired UUID
 * from being re-bound to a later CAS without an unbounded negative ledger.
 */
import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {targetTaskWriteRevision} from "./target-task-write-preflight";

export type InboxCommandFields={
  taskId:string;mode:"process"|"undo";undoOfCommandId:string|null;
  expectedRevision:string;expectedTriageRevision:number;
  writeAreaId:string;restoreGeneration:string;
};
const hex64=/^[a-f0-9]{64}$/;
/** Only a purpose-derived key enters the isolated Inbox read/write child.
 * The raw application session secret is never placed in worker environments. */
export function inboxWorkerProofKey():string|null{
  const secret=process.env.AI_EXECUTIVE_SESSION_SECRET;
  if(typeof secret!=="string"||secret.length<32)return null;
  return createHmac("sha256",secret)
    .update("lumi:c3a:inbox-worker-key:v1").digest("hex");
}
const secret=():Buffer|null=>{
  // A configured but malformed parent secret must never be bypassed by
  // a weaker worker key. Workers receive ONLY the derived proof key.
  const key=process.env.AI_EXECUTIVE_SESSION_SECRET===undefined
    ?process.env.AI_EXECUTIVE_TARGET_STAGING_INBOX_PROOF_KEY
    :inboxWorkerProofKey();
  return typeof key==="string"&&/^[a-f0-9]{64}$/.test(key)
    ?Buffer.from(key,"hex"):null;
};
const signature=(actor:string,fields:Omit<InboxCommandFields,"mode"|"undoOfCommandId">,
  rawPrefix:string):string|null=>{
  const key=secret();
  if(!key)return null;
  return createHmac("sha256",key).update(JSON.stringify([
    "lumi:c3a:issued-inbox-cas:v1",actor,fields.taskId,rawPrefix,
    fields.expectedTriageRevision,fields.writeAreaId,
    fields.restoreGeneration.toLowerCase(),
  ])).digest("hex").slice(0,32);
};
/** A 128-bit raw-CAS fingerprint and a 128-bit server-only actor HMAC.
 * Both halves live in the existing 64-hex expectedRevision field. */
export function issueTargetInboxRevision(
  db:DatabaseSync,actor:string,taskId:string,triageRevision:number,
  writeAreaId:string,restoreGeneration:string,
):string|null{
  const raw=targetTaskWriteRevision(db,taskId);
  if(!raw||!hex64.test(raw)||!Number.isSafeInteger(triageRevision)||triageRevision<0)
    return null;
  const fields={taskId,expectedRevision:"",expectedTriageRevision:triageRevision,
    writeAreaId,restoreGeneration};
  const prefix=raw.slice(0,32),mac=signature(actor,fields,prefix);
  return mac?prefix+mac:null;
}
/** Can verify an originally issued CAS after task move/delete, without
 * historical task snapshots or an actor-enumerating receipt oracle. */
export function verifyIssuedTargetInboxRevision(
  actor:string,fields:InboxCommandFields,
):boolean{
  if(!hex64.test(fields.expectedRevision))return false;
  const prefix=fields.expectedRevision.slice(0,32);
  const mac=signature(actor,fields,prefix);
  return Boolean(mac&&timingSafeEqual(
    Buffer.from(mac,"hex"),Buffer.from(fields.expectedRevision.slice(32),"hex")));
}
const identityData=(fields:InboxCommandFields)=>JSON.stringify([
  "lumi:c3a:self-bound-command:v1",fields.taskId,fields.mode,
  fields.undoOfCommandId?.toLowerCase()??null,fields.expectedRevision,
  fields.expectedTriageRevision,fields.writeAreaId,
  fields.restoreGeneration.toLowerCase(),
]);
/** Cryptographic UUIDv5-shaped digest of the *entire* command payload. */
export function issueTargetInboxCommandId(fields:InboxCommandFields):string{
  const h=createHash("sha256").update(identityData(fields)).digest("hex");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-5"+h.slice(13,16)+"-8"+
    h.slice(17,20)+"-"+h.slice(20,32);
}
export function verifyTargetInboxCommandId(
  fields:InboxCommandFields&{commandId:string},
):boolean{
  const expected=issueTargetInboxCommandId(fields);
  return fields.commandId.toLowerCase()===expected;
}
