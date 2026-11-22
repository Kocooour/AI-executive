import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyBackup } from '../scripts/airtable-family-verify-backup.mjs';
import { buildBackupManifest } from '../scripts/airtable-family-backup.mjs';

const sha = content => createHash('sha256').update(content).digest('hex');
const id = 'att12345678901234';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'lumi-airtable-test-'));
  await mkdir(join(dir, 'attachments'), { mode: 0o700 });
  const data = Buffer.from('synthetic confidential document');
  await writeFile(join(dir, 'attachments', id), data);
  const record = {
    id: 'rec12345678901234',
    fields: {
      Název: 'Synthetic fixture',
      Soubory: [{ id, filename: 'fixture.pdf', size: data.length, type: 'application/pdf' }],
    },
  };
  const manifest = buildBackupManifest([
    { name: 'Dokumenty', table: 'Dokumenty', baseId: 'app12345678901234', records: [record] },
  ], [{
    source: 'Dokumenty', recordId: record.id, fieldName: 'Soubory',
    id, filename: 'fixture.pdf', mimeType: 'application/pdf',
    expectedSize: data.length, relativePath: 'attachments/' + id,
    sha256: sha(data), bytes: data.length,
  }]);
  const payload = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(dir, 'manifest.json'), payload);
  await writeFile(join(dir, 'COMPLETE'), JSON.stringify({
    manifestSha256: sha(payload), apiCalls: 1, count: manifest.counts,
  }, null, 2) + '\n');
  return { dir, data };
}

test('offline verifier validates bytes, manifest, count and source field links', async () => {
  const { dir, data } = await fixture();
  try {
    assert.deepEqual(await verifyBackup(dir), {
      records: 1, attachments: 1, bytes: data.length, uniqueFiles: 1,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline verifier fails closed when an attachment is corrupted', async () => {
  const { dir } = await fixture();
  try {
    await writeFile(join(dir, 'attachments', id), Buffer.from('corrupt'));
    await assert.rejects(() => verifyBackup(dir), /checksum\/size mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline verifier rejects an incomplete export', async () => {
  const { dir } = await fixture();
  try {
    await rm(join(dir, 'COMPLETE'));
    await assert.rejects(() => verifyBackup(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline verifier rejects a tampered manifest', async () => {
  const { dir } = await fixture();
  try {
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    await writeFile(join(dir, 'manifest.json'), manifest.replace('Synthetic fixture', 'Tampered'));
    await assert.rejects(() => verifyBackup(dir), /Manifest SHA-256 mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
