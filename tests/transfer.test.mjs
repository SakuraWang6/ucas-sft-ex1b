import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHUNK_BYTES, digest } from '../dist/protocol.js';
import { downloadFile, uploadFile } from '../dist/transfer.js';

const name = 'checkpoint.bin';
const sample = Buffer.alloc(CHUNK_BYTES + 19, 42);
const sha256 = digest(sample);
const metadata = { name, bytes: sample.length, sha256 };

function downloadPeer(offsets, { interrupt, changed } = {}) {
  return {
    async exchange(op, header) {
      if (op === 'get-info') return { header: metadata };
      assert.equal(op, 'get-chunk');
      assert.equal(header.sha256, sha256);
      offsets.push(header.offset);
      if (interrupt && header.offset > 0) throw new Error('connection interrupted');
      const payload = Buffer.from(sample.subarray(header.offset, header.offset + header.bytes));
      if (changed) payload[0] ^= 1;
      return { header, payload };
    },
  };
}

async function checkpoint(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sft-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'checkpoint.part');
}

test('an interrupted download resumes from the last locally persisted chunk', async t => {
  const path = await checkpoint(t);
  const initial = [];
  await assert.rejects(downloadFile(downloadPeer(initial, { interrupt: true }), name, path), /interrupted/);
  assert.deepEqual(initial, [0, CHUNK_BYTES]);
  const resumed = [];
  const result = await downloadFile(downloadPeer(resumed), name, path);
  assert.deepEqual(resumed, [CHUNK_BYTES]);
  assert.equal(result.resumedAt, CHUNK_BYTES);
  assert.deepEqual(result.data, sample);
});

test('a changed version starts over, and a wrong final digest discards the checkpoint', async t => {
  const path = await checkpoint(t);
  await writeFile(path, Buffer.concat([Buffer.from('0'.repeat(64)), sample.subarray(0, 11)]), { mode: 0o600 });
  const offsets = [];
  await assert.rejects(downloadFile(downloadPeer(offsets, { changed: true }), name, path), /SHA-256/);
  assert.deepEqual(offsets, [0, CHUNK_BYTES]);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('upload sends only unacknowledged data and validates the next offset', async () => {
  const operations = [];
  const session = {
    async exchange(op, header, payload) {
      operations.push(op);
      if (op === 'put-begin') return { header: { ...metadata, offset: CHUNK_BYTES, complete: false } };
      if (op === 'put-finish') return { header: metadata };
      assert.equal(header.offset, CHUNK_BYTES);
      assert.deepEqual(payload, sample.subarray(CHUNK_BYTES));
      return { header: { name, sha256, offset: sample.length } };
    },
  };
  assert.deepEqual(await uploadFile(session, name, sample), { ...metadata, resumedAt: CHUNK_BYTES });
  assert.deepEqual(operations, ['put-begin', 'put-chunk', 'put-finish']);
  const invalid = {
    exchange: async (op) => op === 'put-begin'
      ? { header: { ...metadata, offset: CHUNK_BYTES, complete: false } }
      : { header: { name, sha256, offset: CHUNK_BYTES } },
  };
  await assert.rejects(uploadFile(invalid, name, sample), /chunk acknowledgement/);
});
