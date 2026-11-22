/** C-3b actor-private endpoint: disabled unless explicitly enabled. */
import {getC3bConsent,postC3b} from "../../../../../../lib/target-inbox-c3b-http";
export const GET=getC3bConsent;
export async function POST(request:Request):Promise<Response>{
  return postC3b(request,"consent");
}
export const runtime="nodejs";
export const dynamic="force-dynamic";
