/** Final owner-cookie check after a private legacy response is serialized. */
import { NextResponse } from "next/server";
import { isAuthenticated } from "./auth";

export function releaseOwnerRead(request: Request, serialized: NextResponse): NextResponse {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Authentication required" }, {
      status: 401, headers: { "cache-control": "private, no-store" },
    });
  }
  serialized.headers.set("cache-control", "private, no-store");
  return serialized;
}
