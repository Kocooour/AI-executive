/** Stable actor bucket for immutable CREATE cancellation fences.
 * Never expire a fence: a delayed POST with the same command UUID may still arrive.
 * The preceding v1 actor+command SHA remains readable for existing stores.
 */
import {createHash} from "node:crypto";

export function actorScopedCreateCancelPrefix(namespace:string,actor:string):string{
  return namespace+createHash("sha256")
    .update(JSON.stringify(["private-create-cancel-actor-v2",actor]))
    .digest("hex")+":";
}
