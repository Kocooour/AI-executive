/** Terminal actor-scoped no-commit fence for uncertain project child create. */
import {postPrivateProjectTaskCreateCancel} from "../../../../../lib/target-private-structure-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{
  return postPrivateProjectTaskCreateCancel(request);
}
