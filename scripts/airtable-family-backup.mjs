#!/usr/bin/env node
// Read-only, resumability-safe family Airtable exporter.
// No writes to Airtable. Output is sensitive: keep it outside the repository.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.airtable.com/v0';
const SOURCE_TABLES = [
  ['Auto', 'Události', 'AIRTABLE_FAMILY_AUTO_BASE'],
  ['Dokumenty', 'Dokumenty', 'AIRTABLE_FAMILY_DOCUMENTS_BASE'],
  ['Nákupy', 'Nákupy', 'AIRTABLE_FAMILY_PURCHASES_BASE'],
];
const MAX_RETRIES = 3;
const ATT_ID = /^att[A-Za-z0-9]{14}$/;
const BASE_ID = /^app[A-Za-z0-9]{14}$/;

export function safeAttachmentUrl(input) {
  if (typeof input !== 'string') throw new Error('Attachment URL is missing');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !/^(?:[a-z0-9-]+\.)*airtableusercontent\.com$/i.test(url.hostname) &&
      url.hostname !== 'dl.airtable.com') {
    throw new Error('Attachment URL must point to a trusted Airtable HTTPS host');
  }
  return url;
}

export function snapshotRecord(record, sourceName) {
  if (!record || typeof record.id !== 'string' || !record.id.startsWith('rec') ||
      !record.fields || typeof record.fields !== 'object') {
    throw new Error('Invalid Airtable record');
  }
  const fields = {};
  const files = [];
  for (const [fieldName, value] of Object.entries(record.fields)) {
    if (Array.isArray(value) && value.some(v => v && typeof v === 'object' &&
        ('url' in v || 'filename' in v || (typeof v.id === 'string' && v.id.startsWith('att'))))) {
      fields[fieldName] = value.map(attachment => {
        if (!attachment || !ATT_ID.test(attachment.id) ||
            !Number.isSafeInteger(attachment.size) || attachment.size < 0 ||
            typeof attachment.filename !== 'string') {
          throw new Error('Invalid attachment metadata');
        }
        const url = safeAttachmentUrl(attachment.url);
        files.push({
          source: sourceName, recordId: record.id, fieldName,
          id: attachment.id, filename: attachment.filename,
          mimeType: attachment.type || null, expectedSize: attachment.size,
          url: url.toString(),
        });
        // Keep provenance, but never persist temporary signed URLs.
        return {
          id: attachment.id, filename: attachment.filename,
          size: attachment.size, type: attachment.type || null,
        };
      });
    } else {
      fields[fieldName] = value;
    }
  }
  return {
    record: { id: record.id, createdTime: record.createdTime, fields },
    files,
  };
}

export function buildBackupManifest(sources, files) {
  const bySource = sources.map(source => ({
    name: source.name,
    table: source.table,
    baseId: source.baseId,
    recordCount: source.records.length,
    records: source.records,
  }));
  return {
    schemaVersion: 1, finishedAt: new Date().toISOString(),
    sources: bySource,
    files: files.map(({ url, ...safe }) => safe),
    counts: {
      records: bySource.reduce((sum, item) => sum + item.recordCount, 0),
      attachments: files.length,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    },
  };
}

export function validateSourceConfiguration(env) {
  const token = env.AIRTABLE_TOKEN;
  if (!token || !token.trim()) throw new Error('AIRTABLE_TOKEN is required');
  return SOURCE_TABLES.map(([name, table, key]) => {
    const baseId = env[key];
    if (!BASE_ID.test(baseId ?? '')) throw new Error(key + ' must be a valid base ID');
    return { name, table, baseId };
  });
}

function retryDelay(response, attempt) {
  const raw = Number(response.headers.get('retry-after'));
  return Math.min(30_000, Math.max(1000, Number.isFinite(raw) && raw > 0 ? raw * 1000 : 1000 * 2 ** attempt));
}

async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, token, meter) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    meter.calls++;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' });
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelay(res, attempt)); continue;
    }
    if (!res.ok) throw new Error('Airtable API returned HTTP ' + res.status);
    return res.json();
  }
  throw new Error('Unreachable retry state');
}

async function listAll(source, token, meter) {
  const records = [];
  let offset;
  do {
    const url = new URL(API_ROOT + '/' + source.baseId + '/' + encodeURIComponent(source.table));
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const page = await fetchJson(url, token, meter);
    if (!Array.isArray(page.records)) throw new Error('Airtable returned no records array');
    records.push(...page.records);
    offset = page.offset;
    if (records.length > 1000) throw new Error('Unexpected record count above Airtable Free quota');
  } while (offset);
  return records;
}

async function fetchSignedAttachment(originalUrl) {
  let url = safeAttachmentUrl(originalUrl);
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('Missing attachment redirect target');
      url = safeAttachmentUrl(new URL(next, url).toString());
      continue;
    }
    if (!res.ok || !res.body) throw new Error('Attachment download returned HTTP ' + res.status);
    return res;
  }
  throw new Error('Too many attachment redirects');
}

async function downloadFile(file, outputDir) {
  if (!ATT_ID.test(file.id)) throw new Error('Unsafe attachment identifier');
  const name = file.id; // filenames from user records are never filesystem paths.
  const target = join(outputDir, 'attachments', name);
  const hash = createHash('sha256');
  let bytes = 0;
  const response = await fetchSignedAttachment(file.url);
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if (bytes !== file.expectedSize) throw new Error('Downloaded attachment size mismatch');
    return { relativePath: 'attachments/' + name, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    await unlink(target).catch(() => {});
    throw error;
  }
}

async function execute({ output, env = process.env } = {}) {
  if (!output) throw new Error('Pass --output /absolute/path/outside/repository');
  const sources = validateSourceConfiguration(env);
  const outDir = resolve(output);
  if (outDir === resolve('.') || outDir === resolve('..')) throw new Error('Choose a new private output directory');
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  await mkdir(join(outDir, 'attachments'), { mode: 0o700 });
  const meter = { calls: 0 };
  const snapshots = [];
  const attachmentRefs = [];
  for (const source of sources) {
    const records = await listAll(source, env.AIRTABLE_TOKEN, meter);
    const cleanRecords = [];
    for (const record of records) {
      const item = snapshotRecord(record, source.name);
      cleanRecords.push(item.record);
      attachmentRefs.push(...item.files);
    }
    snapshots.push({ ...source, records: cleanRecords });
    process.stderr.write(source.name + ': ' + cleanRecords.length + ' records\n');
  }
  const downloaded = new Map();
  const completed = [];
  for (const file of attachmentRefs) {
    if (!downloaded.has(file.id)) {
      downloaded.set(file.id, {
        ...await downloadFile(file, outDir),
        expectedSize: file.expectedSize,
      });
    } else if (downloaded.get(file.id).expectedSize !== file.expectedSize) {
      throw new Error('Conflicting metadata for the same attachment ID');
    }
    const { url, ...publicFile } = file;
    completed.push({ ...publicFile, ...downloaded.get(file.id) });
  }
  const manifest = buildBackupManifest(snapshots, completed);
  const payload = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(outDir, 'manifest.json.tmp'), payload, { mode: 0o600, flag: 'wx' });
  await rename(join(outDir, 'manifest.json.tmp'), join(outDir, 'manifest.json'));
  await writeFile(join(outDir, 'COMPLETE'), JSON.stringify({
    manifestSha256: createHash('sha256').update(payload).digest('hex'),
    apiCalls: meter.calls, count: manifest.counts,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stderr.write('Read-only backup complete: ' +
    manifest.counts.records + ' records, ' + manifest.counts.attachments +
    ' attachment references, ' + meter.calls + ' Airtable API requests.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') {
    process.stderr.write('Usage: node scripts/airtable-family-backup.mjs --output /path/to/NEW-private-directory\n');
    process.exitCode = 2;
  } else {
    execute({ output: args[1] }).catch(err => {
      process.stderr.write('Backup incomplete; source Airtable data was not modified. ' +
        (err instanceof Error ? err.message : 'Unknown error') + '\n');
      process.exitCode = 1;
    });
  }
}
