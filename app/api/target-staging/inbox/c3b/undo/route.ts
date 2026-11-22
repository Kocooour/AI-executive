/** C-3b actor-private endpoint: disabled unless explicitly enabled. */
import {postC3b} from "../../../../../../lib/target-inbox-c3b-http";
export async function POST(request:Request):Promise<Response>{
  return postC3b(request,"undo");
}
export const runtime="nodejs";
export const dynamic="force-dynamic";
