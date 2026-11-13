/** Default-off Milestone A/2, owner-private only. */
import {postPrivateProjectCreateRecovery} from "../../../../../lib/target-private-structure-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{
  return postPrivateProjectCreateRecovery(request);
}
