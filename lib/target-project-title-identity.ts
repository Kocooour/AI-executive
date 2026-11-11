/** Server-only, non-authorizing actor proof for a single project and restore era.
 * A matching value from two independently authenticated previews proves the
 * CURRENT server-recognized actor is unchanged; on write it is a comparison
 * proof only, never a substitute for live identity, Area ACL and CAS.
 * Rotates with the operator's signing secret or staging restore generation.
 */
import {createHmac} from "node:crypto";
import {isReadableStagingProjectId} from "./target-project-id";

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function projectTitlePrincipalBinding(actorUserId:string,projectId:string,restoreGeneration:string):string|null {
 const secret=process.env.AI_EXECUTIVE_SESSION_SECRET;
 if(typeof secret!=="string"||secret.length<32||!ACTOR.test(actorUserId)||
    !isReadableStagingProjectId(projectId)||!UUID.test(restoreGeneration))return null;
 return createHmac("sha256",secret).update(JSON.stringify([
   "lumi:r3:project-title-principal:v1",actorUserId,projectId,restoreGeneration.toLowerCase(),
 ])).digest("base64url");
}
