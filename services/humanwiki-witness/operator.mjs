#!/usr/bin/env node
/**
 * Privileged OFFLINE operator commands for an independent witness host.
 * No network write endpoint exists. Running these commands on Lumi's
 * application VPS would violate the separate-recovery-domain requirement.
 *
 * Syntax: node services/humanwiki-witness/operator.mjs bootstrap
 *         node services/humanwiki-witness/operator.mjs publish SEQ PREV_DIGEST DIGEST
 */
import { randomBytes } from "node:crypto";
import { loadWitnessSigningKey } from "./server.mjs";
import {
  bootstrapWitnessStore, publishWitnessCheckpoint, witnessChallengeReceipt,
} from "./store.mjs";

const directory=process.env.HUMANWIKI_WITNESS_STORAGE_DIRECTORY;
const registryId=process.env.HUMANWIKI_WITNESS_REGISTRY_ID;
const privateKey=loadWitnessSigningKey(
  process.env.HUMANWIKI_WITNESS_SIGNING_KEY_FILE);
const [command,...args]=process.argv.slice(2);
if(command==="bootstrap"&&args.length===0){
  const result=bootstrapWitnessStore(directory,registryId,privateKey);
  if(!result.ok||result.importAuthorized!==false)throw Error("witness bootstrap unavailable");
  process.stdout.write("Witness initialized: sequence 0; no real consent authority.\n");
} else if(command==="publish"&&args.length===3){
  const [seq,previousDigest,digest]=args;
  if(!/^(?:0|[1-9]\d*)$/.test(seq))throw Error("invalid sequence");
  const result=publishWitnessCheckpoint(directory,registryId,privateKey,{
    sequence:Number(seq),previousDigest,digest,
  });
  if(!result.ok||result.importAuthorized!==false||result.withdrawalComplete!==false)
    throw Error("witness publication unavailable");

  // Sign a FRESH read of the durable head *after* the write/replay
  // transaction committed. If another operator advanced it meanwhile,
  // refuse rather than reporting an acknowledgement for the wrong event.
  // A lost stdout can be recovered by repeating the exact same latest
  // triple: the SQLite publisher returns replayed:true without a new write.
  const receipt=witnessChallengeReceipt(directory,registryId,privateKey,
    randomBytes(32).toString("base64url"));
  if(receipt.sequence!==result.sequence || receipt.digest!==result.digest)
    throw Error("witness publication unavailable");
  process.stdout.write(JSON.stringify({
    schema:"humanwiki_witness_operator_handoff_v1",
    replayed:result.replayed===true,
    receipt,
    importAuthorized:false,independentWitnessVerified:false,
    withdrawalComplete:false,consentVerified:false,
  })+"\n");
} else {
  throw Error("Use bootstrap or publish SEQUENCE PREVIOUS_DIGEST DIGEST");
}
