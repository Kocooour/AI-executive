import { NextResponse } from "next/server";
import {
  createBackup,
  listBackups,
  restoreBackup,
} from "../../../lib/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { backups: listBackups() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.action === "create") {
    return NextResponse.json({ backup: createBackup() });
  }
  if (body.action === "restore" && typeof body.name === "string") {
    try {
      return NextResponse.json({ snapshot: restoreBackup(body.name) });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Restore failed" },
        { status: 400 },
      );
    }
  }
  return NextResponse.json({ error: "Invalid backup action" }, { status: 400 });
}
