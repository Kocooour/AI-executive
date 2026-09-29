import { NextResponse } from "next/server";
import {
  readSnapshot,
  replaceSnapshot,
  validateSnapshot,
} from "../../../lib/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readSnapshot(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function PUT(request: Request) {
  const body = await request.json();
  if (!Array.isArray(body.entities) || !Array.isArray(body.relations)) {
    return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
  }
  if (body.entities.length > 100000 || body.relations.length > 200000) {
    return NextResponse.json({ error: "Snapshot is too large" }, { status: 413 });
  }
  const baseRevision = Number(body.baseRevision);
  const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds : [];
  try {
    validateSnapshot(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid snapshot" },
      { status: 400 },
    );
  }
  const result = replaceSnapshot(
    baseRevision,
    body.entities,
    body.relations,
    deletedIds,
  );
  return NextResponse.json(result.snapshot, {
    status: result.conflict ? 409 : 200,
    headers: { "cache-control": "no-store" },
  });
}
