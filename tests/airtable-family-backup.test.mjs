import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeAttachmentUrl,
  snapshotRecord,
  buildBackupManifest,
  validateSourceConfiguration,
  validateOutputDirectory,
} from '../scripts/airtable-family-backup.mjs';

const id = 'att12345678901234';
const sourceRecord = {
  id: 'rec12345678901234',
  createdTime: '2026-11-22T09:00:00.000Z',
  fields: {
    'Předmět': 'Fixture – test',
    'Záruka': 24,
    'Fotka': [{
      id,
      filename: '../test-image.png',
      size: 15,
      type: 'image/png',
      url: 'https://v5.airtableusercontent.com/v5/example-token',
    }],
    'Manuály': [],
    'Kategorie': ['Kategorie A', 'Kategorie B'],
  },
};

test('signed Airtable attachment URLs reject unsafe endpoints', () => {
  assert.equal(safeAttachmentUrl('https://v5.airtableusercontent.com/signed').hostname, 'v5.airtableusercontent.com');
  assert.equal(safeAttachmentUrl('https://dl.airtable.com/temporary').hostname, 'dl.airtable.com');
  for (const value of [
    'http://v5.airtableusercontent.com/file',
    'https://v5.airtableusercontent.com.evil.test/file',
    'https://example.com/file',
    'https://user:password@v5.airtableusercontent.com/file',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => safeAttachmentUrl(value), /trusted Airtable HTTPS host/);
  }
});

test('snapshot preserves source content without signed URLs or untrusted path usage', () => {
  const result = snapshotRecord(sourceRecord, 'Nákupy');
  assert.equal(result.record.fields['Předmět'], 'Fixture – test');
  assert.equal(result.record.fields['Záruka'], 24);
  assert.deepEqual(result.record.fields.Kategorie, ['Kategorie A', 'Kategorie B']);
  assert.equal(result.record.fields.Fotka[0].filename, '../test-image.png');
  assert.equal('url' in result.record.fields.Fotka[0], false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].recordId, sourceRecord.id);
  assert.equal(result.files[0].fieldName, 'Fotka');
  assert.equal(result.files[0].expectedSize, 15);
  assert.equal(result.files[0].url.startsWith('https://v5.airtableusercontent.com/'), true);
  assert.equal(JSON.stringify(result.record).includes('example-token'), false);
});

test('invalid attachment size and identifiers fail closed', () => {
  for (const patch of [{ size: -1 }, { size: null }, { id: '../../escape' }, { url: 'https://evil.test' }]) {
    const copy = structuredClone(sourceRecord);
    Object.assign(copy.fields.Fotka[0], patch);
    assert.throws(() => snapshotRecord(copy, 'Nákupy'));
  }
});

test('backup manifest is complete and never serializes signed URLs', () => {
  const { record, files } = snapshotRecord(sourceRecord, 'Nákupy');
  const [file] = files;
  const manifest = buildBackupManifest([
    { name: 'Nákupy', table: 'Nákupy', baseId: 'app12345678901234', records: [record] },
  ], [{
    ...file, relativePath: 'attachments/' + id,
    sha256: 'a'.repeat(64), bytes: 15,
  }]);
  assert.equal(manifest.counts.records, 1);
  assert.equal(manifest.counts.attachments, 1);
  assert.equal(manifest.counts.bytes, 15);
  assert.equal(manifest.files[0].relativePath, 'attachments/' + id);
  assert.equal(JSON.stringify(manifest).includes('example-token'), false);
  assert.equal(manifest.sources[0].records[0].fields.Fotka.length, 1);
});

test('source settings are explicit and do not include credentials in output', () => {
  const env = {
    AIRTABLE_TOKEN: 'private-token-fixture',
    AIRTABLE_FAMILY_AUTO_BASE: 'app12345678901234',
    AIRTABLE_FAMILY_DOCUMENTS_BASE: 'app23456789012345',
    AIRTABLE_FAMILY_PURCHASES_BASE: 'app34567890123456',
  };
  const sources = validateSourceConfiguration(env);
  assert.deepEqual(sources.map(s => s.name), ['Auto', 'Dokumenty', 'Nákupy']);
  assert.equal(JSON.stringify(sources).includes(env.AIRTABLE_TOKEN), false);
  assert.throws(() => validateSourceConfiguration({ ...env, AIRTABLE_TOKEN: '' }), /AIRTABLE_TOKEN/);
  assert.throws(() => validateSourceConfiguration({ ...env, AIRTABLE_FAMILY_AUTO_BASE: 'wrong' }), /AIRTABLE_FAMILY_AUTO_BASE/);
});

test('private backup output cannot be inside the public Git repository', () => {
  const root = '/home/operator/lumi-repo';
  assert.throws(() => validateOutputDirectory(root, root), /Refusing to store private/);
  assert.throws(() => validateOutputDirectory(root + '/backups/secrets', root), /Refusing to store private/);
  assert.equal(validateOutputDirectory('/home/operator/private-backups/family', root), '/home/operator/private-backups/family');
});
