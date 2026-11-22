#!/usr/bin/env node
// Offline integrity verification of a previously finished, private Airtable family backup.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ATT_ID = /^att[A-Za-z0-9]{14}$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function hashFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk); size += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes: size };
}

export async function verifyBackup(folder) {
  const dir = resolve(folder);
  const manifestPayload = await readFile(join(dir, 'manifest.json'), 'utf8');
  const marker = JSON.parse(await readFile(join(dir, 'COMPLETE'), 'utf8'));
  const manifest = JSON.parse(manifestPayload);

  const manifestSha256 = createHash('sha256').update(manifestPayload).digest('hex');
  if (marker.manifestSha256 !== manifestSha256) throw new Error('Manifest SHA-256 mismatch');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources) ||
      !Array.isArray(manifest.files) || !manifest.counts) throw new Error('Invalid manifest schema');

  const recordKeys = new Set();
  const expectedFiles = new Map();
  let recordCount = 0;
  for (const source of manifest.sources) {
    if (!Array.isArray(source.records) || source.recordCount !== source.records.length ||
        typeof source.name !== 'string') throw new Error('Invalid source record count');
    recordCount += source.recordCount;
    for (const record of source.records) {
      const key = source.name + ':' + record.id;
      if (recordKeys.has(key)) throw new Error('Duplicate source record');
      recordKeys.add(key);
      if (!record.fields || typeof record.fields !== 'object') throw new Error('Missing record fields');
      for (const [fieldName, value] of Object.entries(record.fields)) {
        if (!Array.isArray(value)) continue;
        for (const element of value) {
          if (element && ATT_ID.test(element.id ?? '')) {
            const fieldFiles = manifest.files.filter(f =>
              f.source === source.name && f.recordId === record.id &&
              f.fieldName === fieldName && f.id === element.id);
            if (fieldFiles.length !== 1) throw new Error('Missing or duplicated attachment manifest entry');
          }
        }
      }
    }
  }
  let bytes = 0;
  for (const file of manifest.files) {
    if (!ATT_ID.test(file.id) || file.relativePath !== 'attachments/' + file.id ||
        !SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !recordKeys.has(file.source + ':' + file.recordId) || 'url' in file) {
      throw new Error('Unsafe or invalid attachment manifest entry');
    }
    bytes += file.bytes;
    const previous = expectedFiles.get(file.id);
    if (previous && (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)) {
      throw new Error('Conflicting duplicate attachment metadata');
    }
    expectedFiles.set(file.id, file);
  }
  if (recordCount !== manifest.counts.records ||
      manifest.files.length !== manifest.counts.attachments ||
      bytes !== manifest.counts.bytes ||
      JSON.stringify(marker.count) !== JSON.stringify(manifest.counts)) {
    throw new Error('Backup count mismatch');
  }
  const actualFiles = await readdir(join(dir, 'attachments'));
  if (actualFiles.length !== expectedFiles.size ||
      actualFiles.some(id => !expectedFiles.has(id))) {
    throw new Error('Attachment file set differs from manifest');
  }
  for (const [id, expected] of expectedFiles) {
    const filePath = join(dir, 'attachments', id);
    const st = await lstat(filePath);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe attachment file type');
    const actual = await hashFile(filePath);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error('Attachment checksum/size mismatch');
    }
  }
  return { ...manifest.counts, uniqueFiles: expectedFiles.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input') {
    process.stderr.write('Usage: node scripts/airtable-family-verify-backup.mjs --input /private/backup-directory\n');
    process.exitCode = 2;
  } else {
    verifyBackup(args[1]).then(result => {
      process.stdout.write('Verified backup: ' + JSON.stringify(result) + '\n');
    }).catch(() => {
      process.stderr.write('Backup integrity verification FAILED. Do not migrate from it.\n');
      process.exitCode = 1;
    });
  }
}
