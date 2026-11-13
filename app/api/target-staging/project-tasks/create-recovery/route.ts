/** Default-off Milestone A/2, owner-private only. */
import {postPrivateProjectTaskCreateRecovery} from "../../../../../lib/target-private-structure-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{
  return postPrivateProjectTaskCreateRecovery(request);
}
