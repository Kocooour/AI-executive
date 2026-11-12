/** R3 private task UUID-only recovery; same live actor and Area ACL as create. */
import {postPrivateTaskCreateRecovery} from "../../../../../lib/target-private-task-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request: Request) {
  return postPrivateTaskCreateRecovery(request);
}
