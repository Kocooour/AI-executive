/** Terminal actor-scoped no-commit fence for uncertain project create. */
import {postPrivateProjectCreateCancel} from "../../../../../lib/target-private-structure-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{
  return postPrivateProjectCreateCancel(request);
}
