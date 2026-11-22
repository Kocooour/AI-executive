/** C-3b actor-private endpoint: disabled unless explicitly enabled. */
import {postC3b} from "../../../../../../lib/target-inbox-c3b-http";
export const POST=(request:Request)=>postC3b(request,"accept");
export const runtime="nodejs";
export const dynamic="force-dynamic";
