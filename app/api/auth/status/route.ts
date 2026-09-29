import { NextResponse } from "next/server";
import { getAuthState } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(getAuthState(request), {
    headers: { "cache-control": "no-store" },
  });
}
