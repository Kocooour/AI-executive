/** Actor-scoped, durable no-commit fence for a private task CREATE. */
import {postPrivateTaskCreateCancel} from "../../../../../lib/target-private-task-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request):Promise<Response>{
  return postPrivateTaskCreateCancel(request);
}
