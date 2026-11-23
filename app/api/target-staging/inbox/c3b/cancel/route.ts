/** Default-off authenticated recovery for an uncertain compound Accept. */
import {postC3b} from "../../../../../../lib/target-inbox-c3b-http";
export async function POST(request:Request):Promise<Response>{
  return postC3b(request,"cancel");
}
export const runtime="nodejs";
export const dynamic="force-dynamic";
