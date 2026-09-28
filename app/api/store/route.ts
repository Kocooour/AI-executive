import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { Entity, Relation } from "../../../lib/db";

interface Store {
  revision: number;
  entities: Entity[];
  relations: Relation[];
  updatedAt: number;
}

const dataDirectory =
  process.env.AI_EXECUTIVE_DATA_DIR || path.join(process.cwd(), ".data");
const storePath = path.join(dataDirectory, "store.json");
let writeQueue = Promise.resolve();

const emptyStore = (): Store => ({
  revision: 0,
  entities: [],
  relations: [],
  updatedAt: 0,
});

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return {
      revision: Number(parsed.revision) || 0,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: Store) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), "utf8");
  await rename(temporaryPath, storePath);
}

export async function GET() {
  return NextResponse.json(await readStore(), {
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

  let release: () => void = () => undefined;
  const previousWrite = writeQueue;
  writeQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousWrite;
  try {
    const current = await readStore();
    if (Number(body.baseRevision) !== current.revision) {
      return NextResponse.json(current, { status: 409 });
    }
    const next: Store = {
      revision: current.revision + 1,
      entities: body.entities,
      relations: body.relations,
      updatedAt: Date.now(),
    };
    await writeStore(next);
    return NextResponse.json(next, {
      headers: { "cache-control": "no-store" },
    });
  } finally {
    release();
  }
}

