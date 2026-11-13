/** Reauth-stable, store-generation-scoped ACTOR witness for uncertain
 * structure-create markers. Not a bearer credential, not a write authority.
 * Never emit actor IDs, raw session hashes or the signing secret.
 *
 * A user switching from actor A to B in the same tab must NOT be able to
 * cancel a never-recorded command by writing a no-commit fence for B and then
 * incorrectly releasing A's marker. The scope is HMAC-derived for the LIVE
 * authenticated actor and compared before cancellation dispatch.
 */
import {createHmac} from "node:crypto";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {verifyDurableTargetStagingSessionLiveCoded} from "./target-staging-durable-session";

const actorPattern=/^[A-Za-z0-9_.:@-]{1,120}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function privateStructureActorScope(actor:string,restoreGeneration:string):string|null{
  const secret=process.env.AI_EXECUTIVE_SESSION_SECRET;
  if(!secret||!actorPattern.test(actor)||!uuid.test(restoreGeneration))return null;
  return createHmac("sha256",secret)
    .update(JSON.stringify(["lumi:private-structure-owner-scope:v1",actor,
      restoreGeneration.toLowerCase()])).digest("base64url");
}
/** Resolves the actor against the LIVE staging session, never an HTTP field. */
export function structureOwnerScopeForIdentity(
  identity:StagingHttpIdentity,
  store:TargetStagingReadStore&{ownerUserId:string},
):string|null{
  const actor=identity.kind==="owner"?store.ownerUserId:
    (()=>{const live=verifyDurableTargetStagingSessionLiveCoded(
      store,identity.tokenHash);return live.ok?live.userId:null;})();
  return actor?privateStructureActorScope(actor,store.expectedRestoreGeneration):null;
}
