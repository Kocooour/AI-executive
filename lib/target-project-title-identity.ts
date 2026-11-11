/** Server-only, non-authorizing actor proof for one project/restore era.
 * The bounded title-write child has no access to the application session
 * secret. It receives only a domain-separated HMAC key, which cannot sign
 * application sessions and does not grant project write access.
 */
import {createHmac} from "node:crypto";
import {isReadableStagingProjectId} from "./target-project-id";

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[0-9a-f]{64}$/;
const DERIVE_DOMAIN="lumi:r3:project-title-signing-key:v1";

/** Parent-only: derive a least-privilege key for project-title bindings. */
export function projectTitleWorkerProofKey():string|null {
 const secret=process.env.AI_EXECUTIVE_SESSION_SECRET;
 if(typeof secret!=="string"||secret.length<32)return null;
 return createHmac("sha256",secret).update(DERIVE_DOMAIN).digest("hex");
}

export function projectTitlePrincipalBinding(actorUserId:string,projectId:string,restoreGeneration:string):string|null {
 if(!ACTOR.test(actorUserId)||!isReadableStagingProjectId(projectId)||!UUID.test(restoreGeneration))
   return null;
 // If the main secret is set, it is authoritative (even when malformed).
 // Only an isolated child WITHOUT it may use the purpose-scoped worker key.
 const key=process.env.AI_EXECUTIVE_SESSION_SECRET===undefined
   ?process.env.AI_EXECUTIVE_TARGET_STAGING_PROJECT_TITLE_PROOF_KEY
   :projectTitleWorkerProofKey();
 if(typeof key!=="string"||!KEY.test(key))return null;
 return createHmac("sha256",Buffer.from(key,"hex")).update(JSON.stringify([
   "lumi:r3:project-title-principal:v1",actorUserId,projectId,restoreGeneration.toLowerCase(),
 ])).digest("base64url");
}
