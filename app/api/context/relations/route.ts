import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { relationRegistryForClient } from "../../../../lib/context-relations";

// The relation registry, so the editor offers exactly the relations the server accepts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return NextResponse.json(relationRegistryForClient(), { headers: { "cache-control": "no-store" } });
}
