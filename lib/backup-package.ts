import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Inflate, Zip, ZipDeflate } from "fflate";
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
  maxManifestBytes: number;
  bombFloorBytes: number;
  maxRatio: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxDatabaseBytes: number;
}
// Absolute limits. The exporter refuses to build a package above them and the importer refuses one above them, so
// whatever the app exports it can import again. They are bomb protection, not a size policy: entries are counted while
// inflating (not only as declared), and a package that inflates far beyond what it read is refused by the ratio guard.
export const defaultPackageLimits: PackageLimits = {
  maxEntries: 65_000,
  // The manifest lists every file (about 120 bytes each), so it is bounded on its own, well below the generic entry limit.
  maxManifestBytes: 32 * 1024 ** 2,
  maxTotalBytes: 4 * 1024 ** 3,
  maxEntryBytes: 1024 ** 3,
  maxDatabaseBytes: 2 * 1024 ** 3,
  // Inflating more than `bombFloorBytes` needs at least 1 byte read per `maxRatio` inflated (text and database files
  // compress about 3 to 20 times; a bomb compresses a thousand times or more).
  bombFloorBytes: 64 * 1024 ** 2,
  maxRatio: 200,
};
// The largest upload the import accepts; the export refuses to produce a file above it.
export const maxImportUploadBytes = 200 * 1024 * 1024;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
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

const tooLarge = () => new HttpInputError("Export is too large to be imported again", 413);

// Rows as JSON text in pieces of about 256 KB: no whole table is ever held as one string.
function* jsonArrayChunks(rows: Iterable<unknown>): Generator<Uint8Array> {
  let batch = "[";
  let first = true;
  for (const row of rows) {
    batch += (first ? "\n" : ",\n") + JSON.stringify(row);
    first = false;
    if (batch.length >= 256 * 1024) { yield encoder.encode(batch); batch = ""; }
  }
  yield encoder.encode(batch + (first ? "]\n" : "\n]\n"));
}
function* jsonLinesChunks(rows: Iterable<unknown>): Generator<Uint8Array> {
  let batch = "";
  for (const row of rows) {
    batch += JSON.stringify(row) + "\n";
    if (batch.length >= 256 * 1024) { yield encoder.encode(batch); batch = ""; }
  }
  if (batch) yield encoder.encode(batch);
}
function* fileChunks(file: string): Generator<Uint8Array> {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) yield Uint8Array.prototype.slice.call(buffer, 0, read);
  } finally {
    closeSync(fd);
  }
}

export interface ExportOptions { limits?: PackageLimits; uploadLimit?: number }

/**
 * Writes the export ZIP for the cleaned database copy at `copyPath` into `zipPath`, entry by entry, with bounded memory:
 * rows are iterated and written in batches, notes one at a time, the database in 256 KB pieces, and every entry's
 * SHA-256 is computed while it is written. The manifest comes last (the importer accepts it at any position). The limits
 * of the importer (entries, sizes, manifest, inflate ratio, upload size) are checked as the file grows; a package the
 * importer would refuse aborts the export with the localized 413 before more is written.
 */
export function writeExportZip(copyPath: string, zipPath: string, info: { counts: Record<string, number>; migrations: string[]; createdAt?: Date }, options: ExportOptions = {}): PackageManifest {
  const fd = openSync(zipPath, "w", 0o600);
  try {
    return writeExportEntries(fd, copyPath, info, options);
  } finally {
    closeSync(fd);
  }
}

function writeExportEntries(fd: number, copyPath: string, info: { counts: Record<string, number>; migrations: string[]; createdAt?: Date }, options: ExportOptions): PackageManifest {
  const limits = options.limits ?? defaultPackageLimits;
  const uploadLimit = options.uploadLimit ?? maxImportUploadBytes;
  const files: PackageManifest["files"] = {};
  let written = 0;
  let inflated = 0;
  let entries = 0;
  let manifestEstimate = 0;
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (failure) return;
    if (error) { failure = error; return; }
    written += chunk.length;
    if (written > uploadLimit) { failure = tooLarge(); return; }
    writeSync(fd, chunk);
  });
  const check = () => { if (failure) throw failure; };
  const addEntry = (name: string, chunks: Iterable<Uint8Array>, entryLimit: number) => {
    entries += 1;
    manifestEstimate += name.length + 110;
    // The manifest is one more entry.
    if (entries + 1 > limits.maxEntries || manifestEstimate > limits.maxManifestBytes) throw tooLarge();
    const deflate = new ZipDeflate(name, { level: 6 });
    zip.add(deflate);
    const hash = createHash("sha256");
    let bytes = 0;
    for (const chunk of chunks) {
      hash.update(chunk);
      bytes += chunk.length;
      inflated += chunk.length;
      if (bytes > entryLimit || inflated > limits.maxTotalBytes) throw tooLarge();
      deflate.push(chunk, false);
      check();
      if (inflated > limits.bombFloorBytes && inflated > written * limits.maxRatio) throw tooLarge();
    }
    deflate.push(new Uint8Array(0), true);
    check();
    files[name] = { sha256: hash.digest("hex"), bytes };
  };
  const text = (name: string, content: string) => addEntry(name, [encoder.encode(content)], limits.maxEntryBytes);
  const database = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const taken = new Set<string>();
    const notes = database.prepare("SELECT payload FROM entities WHERE json_extract(payload, '$.type') = 'note' ORDER BY updated_at, id");
    for (const row of notes.iterate() as Iterable<{ payload: string }>) {
      const note = JSON.parse(String(row.payload)) as Entity;
      let base = safeFileName(note.id);
      for (let index = 2; taken.has(base); index += 1) base = `${safeFileName(note.id)}-${index}`;
      taken.add(base);
      text(`notes/${base}.md`, noteMarkdown(note));
    }
    for (const table of includedTables) {
      addEntry(`data/${table}.json`, jsonArrayChunks(database.prepare(`SELECT * FROM ${quote(table)}`).iterate()), limits.maxEntryBytes);
    }
    addEntry("history/context-changes.jsonl", jsonLinesChunks(database.prepare("SELECT * FROM context_change_events ORDER BY sequence, rowid").iterate()), limits.maxEntryBytes);
    addEntry("history/note-revisions.jsonl", jsonLinesChunks(database.prepare("SELECT * FROM note_revisions ORDER BY note_id, revision").iterate()), limits.maxEntryBytes);
  } finally {
    database.close();
  }
  addEntry(databaseEntry, fileChunks(copyPath), limits.maxDatabaseBytes);
  const manifest: PackageManifest = {
    format: exportFormat,
    version: exportVersion,
    createdAt: (info.createdAt ?? new Date()).toISOString(),
    migrations: info.migrations,
    counts: info.counts,
    files,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.length > limits.maxManifestBytes) throw tooLarge();
  const deflate = new ZipDeflate(manifestEntry, { level: 6 });
  zip.add(deflate);
  deflate.push(manifestBytes, true);
  zip.end();
  check();
  return manifest;
}

export const badNameChecks = (name: string) =>
  name.length === 0 || name.length > 200 || name.startsWith("/") || name.endsWith("/") || name.includes("\\") ||
  name.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(name) || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f]/.test(name);

/**
 * Reads the ZIP at `zipPath` in pieces and checks it: sane names, bounded counts and sizes (also while inflating, not only
 * as declared), a manifest, and every file present, listed and matching its sha256. The package's database is written to
 * `databasePath` (a temporary file the caller owns and deletes); nothing else is kept.
 */
interface CentralEntry { name: string; method: number; compressed: number; size: number; localOffset: number }

const invalidFile = () => new HttpInputError("Not a valid export file");
const tooBig = () => new HttpInputError("Export package is too large");

function readExactly(fd: number, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw invalidFile();
    done += read;
  }
  return buffer;
}

/**
 * The entries of the ZIP from its central directory (the file is read by position, never scanned). A streaming reader
 * that looks for the end of an entry in the byte stream can cut one short when compressed data happens to contain the
 * signature of a data descriptor, which makes valid archives fail at random; the central directory has exact sizes.
 * Sizes and counts are checked here, before anything is inflated. ZIP64 is not accepted: an export never needs it.
 */
function readCentralDirectory(fd: number, fileSize: number, limits: PackageLimits): CentralEntry[] {
  if (fileSize < 22) throw invalidFile();
  const tailSize = Math.min(fileSize, 22 + 65535);
  const tail = readExactly(fd, tailSize, fileSize - tailSize);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw invalidFile();
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw invalidFile();
  const endPosition = fileSize - tailSize + end;
  if (count === 0 || directoryOffset + directorySize > endPosition) throw invalidFile();
  if (count > limits.maxEntries || directorySize > 64 * 1024 ** 2) throw tooBig();
  const directory = readExactly(fd, directorySize, directoryOffset);
  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let position = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) throw invalidFile();
    const flags = directory.readUInt16LE(position + 8);
    const method = directory.readUInt16LE(position + 10);
    const compressed = directory.readUInt32LE(position + 20);
    const size = directory.readUInt32LE(position + 24);
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const localOffset = directory.readUInt32LE(position + 42);
    if (position + 46 + nameLength + extraLength + commentLength > directory.length) throw invalidFile();
    const name = directory.toString("utf8", position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff || localOffset >= directoryOffset) throw invalidFile();
    if (badNameChecks(name) || names.has(name)) throw new HttpInputError("Invalid export package");
    names.add(name);
    entries.push({ name, method, compressed, size, localOffset });
  }
  return entries;
}

/**
 * Reads the ZIP at `zipPath` and checks it: the central directory (sane names, bounded counts and sizes), then every entry
 * inflated in pieces, with sizes counted as they inflate (not only as declared), the inflate ratio guarded, a manifest, and
 * every file present, listed and matching its sha256. The package's database is written to `databasePath` (a temporary
 * file the caller owns and deletes); nothing else is kept.
 */
export function verifyPackage(zipPath: string, databasePath: string, limits: PackageLimits = defaultPackageLimits) {
  const seen = new Map<string, { hash: ReturnType<typeof createHash>; bytes: number }>();
  const manifestChunks: Buffer[] = [];
  let totalBytes = 0;
  let compressedBytes = 0;
  const fd = openSync(zipPath, "r");
  try {
    const fileSize = statSync(zipPath).size;
    const entries = readCentralDirectory(fd, fileSize, limits);
    const limitFor = (name: string) => name === databaseEntry ? limits.maxDatabaseBytes : name === manifestEntry ? limits.maxManifestBytes : limits.maxEntryBytes;
    for (const entry of entries) if (entry.size > limitFor(entry.name)) throw tooBig();
    for (const entry of entries) {
      const entryLimit = limitFor(entry.name);
      const header = readExactly(fd, 30, entry.localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50) throw invalidFile();
      const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (dataStart + entry.compressed > fileSize) throw invalidFile();
      const state = { hash: createHash("sha256"), bytes: 0 };
      seen.set(entry.name, state);
      const databaseFd = entry.name === databaseEntry ? openSync(databasePath, "w", 0o600) : null;
      let finished = false;
      const take = (data: Uint8Array) => {
        state.bytes += data.length;
        totalBytes += data.length;
        if (state.bytes > entryLimit || totalBytes > limits.maxTotalBytes) throw tooBig();
        if (totalBytes > limits.bombFloorBytes && totalBytes > Math.max(1, compressedBytes) * limits.maxRatio) throw tooBig();
        state.hash.update(data);
        if (entry.name === manifestEntry) manifestChunks.push(Buffer.from(data));
        if (databaseFd !== null) writeSync(databaseFd, data);
      };
      try {
        const inflater = new Inflate();
        let failed: Error | null = null;
        inflater.ondata = (data, final) => { if (failed) return; try { take(data); } catch (error) { failed = error as Error; } if (final) finished = true; };
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (let done = 0; done < entry.compressed;) {
          const length = Math.min(buffer.length, entry.compressed - done);
          const read = readSync(fd, buffer, 0, length, dataStart + done);
          if (read === 0) throw invalidFile();
          done += read;
          compressedBytes += read;
          const chunk = Uint8Array.prototype.slice.call(buffer, 0, read);
          if (entry.method === 0) { take(chunk); finished = done === entry.compressed; }
          else {
            try { inflater.push(chunk, done === entry.compressed); } catch { throw failed ?? invalidFile(); }
          }
          if (failed) throw failed;
        }
        if (entry.compressed === 0 && entry.method === 8) {
          try { inflater.push(new Uint8Array(0), true); } catch { throw failed ?? invalidFile(); }
          if (failed) throw failed;
        }
        if (entry.method === 0 && entry.compressed === 0) finished = true;
        if (!finished || state.bytes !== entry.size) throw invalidFile();
      } finally {
        if (databaseFd !== null) closeSync(databaseFd);
      }
    }
  } finally {
    closeSync(fd);
  }
  if (seen.size === 0) throw invalidFile();

  if (!seen.has(manifestEntry) || !seen.has(databaseEntry)) throw new HttpInputError("Export package has missing or unexpected files");
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(Buffer.concat(manifestChunks).toString("utf8")) as PackageManifest;
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

/**
 * The export builds its ZIP in a file and runs the importer's own checks on it (upload size, entry and size limits, the
 * ratio guard, checksums). A package the import would refuse is never offered; every refusal reads the same.
 */
export function verifyExportOutput(zipPath: string, scratchDatabasePath: string, uploadLimit = maxImportUploadBytes, limits: PackageLimits = defaultPackageLimits) {
  if (statSync(zipPath).size > uploadLimit) throw new HttpInputError("Export is too large to be imported again", 413);
  try {
    return verifyPackage(zipPath, scratchDatabasePath, limits);
  } catch (error) {
    if (error instanceof HttpInputError) throw new HttpInputError("Export is too large to be imported again", 413);
    throw error;
  }
}
