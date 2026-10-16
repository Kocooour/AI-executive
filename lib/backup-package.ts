import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Unzip, UnzipInflate, Zip, ZipDeflate, type UnzipFile } from "fflate";
import { includedTables } from "./backup-scope";
import { HttpInputError } from "./http-security";
import type { Entity } from "./db";

// The export package: a ZIP with `manifest.json` (format, versions, row counts and a sha256 for every other file),
// `database.sqlite` (a full backup copy, the only part an import reads) and readable copies of the same data (notes
// as Markdown, every included table as JSON, the Context change history and the note versions as JSON lines).
// An import checks the package completely before anything is restored.

export const exportFormat = "lumi-export";
export const exportVersion = 1;
export const databaseEntry = "database.sqlite";
export const manifestEntry = "manifest.json";

export interface PackageManifest {
  format: typeof exportFormat;
  version: typeof exportVersion;
  createdAt: string;
  migrations: string[];
  counts: Record<string, number>;
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface PackageLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxDatabaseBytes: number;
}
export const defaultPackageLimits: PackageLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxEntryBytes: 64 * 1024 ** 2,
  maxDatabaseBytes: 1024 ** 3,
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const encoder = new TextEncoder();

function safeFileName(id: string) {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 80) || "note";
  return cleaned;
}

const yamlString = (value: string) => JSON.stringify(value);

export function noteMarkdown(note: Entity) {
  const projectId = typeof note.properties?.projectId === "string" ? note.properties.projectId : "";
  const lines = [
    "---",
    `id: ${yamlString(note.id)}`,
    `title: ${yamlString(note.title ?? "")}`,
    `workspace: ${yamlString(note.workspaceId ?? "")}`,
    ...(projectId ? [`project: ${yamlString(projectId)}`] : []),
    `updatedAt: ${new Date(Number(note.updatedAt) || 0).toISOString()}`,
    "---",
    "",
    typeof note.content === "string" ? note.content : "",
    "",
  ];
  return lines.join("\n");
}

interface Part {
  name: string;
  bytes?: Uint8Array;
  file?: string;
  size: number;
  sha256: string;
}

function hashFile(file: string) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, "r");
  let size = 0;
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, read)); size += read; }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), size };
}

/** Everything of the package except the manifest, built from a cleaned database copy. */
export function buildPackageParts(copyPath: string) {
  const database = new DatabaseSync(copyPath, { readOnly: true });
  const parts: Part[] = [];
  const text = (name: string, content: string) => {
    const bytes = encoder.encode(content);
    parts.push({ name, bytes, size: bytes.length, sha256: sha256(bytes) });
  };
  try {
    const taken = new Set<string>();
    const notes = (database.prepare("SELECT payload FROM entities ORDER BY updated_at, id").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(String(row.payload)) as Entity)
      .filter((entity) => entity.type === "note");
    for (const note of notes) {
      let base = safeFileName(note.id);
      for (let index = 2; taken.has(base); index += 1) base = `${safeFileName(note.id)}-${index}`;
      taken.add(base);
      text(`notes/${base}.md`, noteMarkdown(note));
    }
    for (const table of includedTables) {
      const rows = database.prepare(`SELECT * FROM ${quote(table)}`).all();
      text(`data/${table}.json`, JSON.stringify(rows, null, 1));
    }
    const lines = (table: string, order: string) =>
      (database.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${order}`).all() as object[]).map((row) => JSON.stringify(row)).join("\n");
    text("history/context-changes.jsonl", lines("context_change_events", "sequence, rowid") + "\n");
    text("history/note-revisions.jsonl", lines("note_revisions", "note_id, revision") + "\n");
  } finally {
    database.close();
  }
  const { sha256: databaseHash, size } = hashFile(copyPath);
  parts.push({ name: databaseEntry, file: copyPath, size, sha256: databaseHash });
  return parts;
}

export function buildManifest(parts: Part[], info: { counts: Record<string, number>; migrations: string[]; createdAt?: Date }): PackageManifest {
  return {
    format: exportFormat,
    version: exportVersion,
    createdAt: (info.createdAt ?? new Date()).toISOString(),
    migrations: info.migrations,
    counts: info.counts,
    files: Object.fromEntries(parts.map((part) => [part.name, { sha256: part.sha256, bytes: part.size }])),
  };
}

/** The ZIP as a stream: the manifest first, then the files; the database is read in pieces. */
export function packageStream(parts: Part[], manifest: PackageManifest, onEnd: () => void) {
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  let zip: Zip;
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const steps = (function* () {
    const entries: Array<{ name: string; bytes?: Uint8Array; file?: string }> = [{ name: manifestEntry, bytes: manifestBytes }, ...parts];
    for (const entry of entries) {
      const deflate = new ZipDeflate(entry.name, { level: 6 });
      zip.add(deflate);
      if (entry.bytes) {
        deflate.push(entry.bytes, true);
        yield;
      } else if (entry.file) {
        const fd = openSync(entry.file, "r");
        try {
          const buffer = Buffer.allocUnsafe(256 * 1024);
          let read = readSync(fd, buffer, 0, buffer.length, null);
          if (read === 0) deflate.push(new Uint8Array(0), true);
          while (read > 0) {
            const chunk = Uint8Array.prototype.slice.call(buffer, 0, read);
            const next = readSync(fd, buffer, 0, buffer.length, null);
            deflate.push(chunk, next === 0);
            read = next;
            yield;
          }
        } finally {
          closeSync(fd);
        }
      }
    }
    zip.end();
  })();
  let finished = false;
  const finish = () => { if (!finished) { finished = true; onEnd(); } };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      zip = new Zip((error, chunk, final) => {
        if (error) { controller.error(error); finish(); return; }
        if (chunk.length) controller.enqueue(chunk);
        if (final) { controller.close(); finish(); }
      });
    },
    pull() {
      try {
        // Produce until the consumer has enough queued; the next pull continues.
        while ((controllerRef.desiredSize ?? 0) > 0) {
          if (steps.next().done) return;
        }
      } catch (error) {
        controllerRef.error(error);
        finish();
      }
    },
    cancel() { finish(); },
  });
}

export const badNameChecks = (name: string) =>
  name.length === 0 || name.length > 200 || name.startsWith("/") || name.endsWith("/") || name.includes("\\") ||
  name.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(name) || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f]/.test(name);

/**
 * Reads the ZIP at `zipPath` in pieces and checks it: sane names, bounded counts and sizes (also while inflating, not only
 * as declared), a manifest, and every file present, listed and matching its sha256. The package's database is written to
 * `databasePath` (a temporary file the caller owns and deletes); nothing else is kept.
 */
export function verifyPackage(zipPath: string, databasePath: string, limits: PackageLimits = defaultPackageLimits) {
  const seen = new Map<string, { hash: ReturnType<typeof createHash>; bytes: number }>();
  let manifestText = Buffer.alloc(0);
  let totalBytes = 0;
  let failure: HttpInputError | null = null;
  let databaseFd: number | null = null;
  const fail = (error: HttpInputError) => { if (!failure) failure = error; };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file: UnzipFile) => {
    if (failure) return;
    const name = file.name;
    if (badNameChecks(name)) { fail(new HttpInputError("Invalid export package")); return; }
    if (seen.has(name)) { fail(new HttpInputError("Invalid export package")); return; }
    if (seen.size + 1 > limits.maxEntries) { fail(new HttpInputError("Export package is too large")); return; }
    const entryLimit = name === databaseEntry ? limits.maxDatabaseBytes : limits.maxEntryBytes;
    if (typeof file.originalSize === "number" && file.originalSize > entryLimit) { fail(new HttpInputError("Export package is too large")); return; }
    const state = { hash: createHash("sha256"), bytes: 0 };
    seen.set(name, state);
    if (name === databaseEntry) databaseFd = openSync(databasePath, "w", 0o600);
    file.ondata = (error, data) => {
      if (failure) return;
      if (error) { fail(new HttpInputError("Invalid export package")); return; }
      state.bytes += data.length;
      totalBytes += data.length;
      if (state.bytes > entryLimit || totalBytes > limits.maxTotalBytes) { fail(new HttpInputError("Export package is too large")); file.terminate(); return; }
      state.hash.update(data);
      if (name === manifestEntry) manifestText = Buffer.concat([manifestText, data]);
      if (name === databaseEntry && databaseFd !== null) writeSync(databaseFd, data);
    };
    file.start();
  };

  const fd = openSync(zipPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let ended = false;
    while (!failure && !ended) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      ended = read === 0;
      try {
        unzip.push(ended ? new Uint8Array(0) : Uint8Array.prototype.slice.call(buffer, 0, read), ended);
      } catch {
        fail(new HttpInputError("Invalid export package"));
      }
    }
  } finally {
    closeSync(fd);
    if (databaseFd !== null) closeSync(databaseFd);
  }
  if (failure) throw failure;

  if (!seen.has(manifestEntry) || !seen.has(databaseEntry)) throw new HttpInputError("Export package has missing or unexpected files");
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(manifestText.toString("utf8")) as PackageManifest;
  } catch {
    throw new HttpInputError("Invalid export package");
  }
  if (
    !manifest || manifest.format !== exportFormat || manifest.version !== exportVersion || !manifest.files ||
    typeof manifest.files !== "object" || !Array.isArray(manifest.migrations)
  ) {
    throw new HttpInputError("Invalid export package");
  }
  const listed = Object.keys(manifest.files).sort();
  const present = [...seen.keys()].filter((name) => name !== manifestEntry).sort();
  if (listed.length !== present.length || listed.some((name, index) => name !== present[index])) {
    throw new HttpInputError("Export package has missing or unexpected files");
  }
  for (const name of listed) {
    const state = seen.get(name)!;
    const expected = manifest.files[name];
    if (!expected || state.hash.digest("hex") !== expected.sha256 || state.bytes !== expected.bytes) {
      throw new HttpInputError("Export package does not match its checksums");
    }
  }
  return manifest;
}
