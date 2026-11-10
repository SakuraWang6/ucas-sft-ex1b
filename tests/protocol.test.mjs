import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { digest, FrameReader, MAX_PAYLOAD, validName, writeFrame } from '../dist/protocol.js';

function readBytes(bytes) {
  const stream = new PassThrough();
  const reader = new FrameReader(stream);
  stream.end(bytes);
  return reader.read();
}

function wire(header, payload = Buffer.alloc(0), {
  magic = 'SFT1', headerBytes = header.length, payloadBytes = payload.length,
} = {}) {
  const prefix = Buffer.alloc(12);
  prefix.write(magic, 0, 4, 'ascii');
  prefix.writeUInt32BE(headerBytes, 4);
  prefix.writeUInt32BE(payloadBytes, 8);
  return Buffer.concat([prefix, header, payload]);
}

test('empty and exactly 8 MiB frames preserve binary payload and SHA-256', async () => {
  assert.equal(MAX_PAYLOAD, 8 * 1024 * 1024);
  const stream = new PassThrough();
  const reader = new FrameReader(stream);
  const source = Buffer.alloc(MAX_PAYLOAD).fill(Buffer.from([0, 255, 21, 128]));
  for (const payload of [Buffer.alloc(0), source]) {
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const header = { op: 'put', name: 'boundary.bin', sha256 };
    const [frame] = await Promise.all([reader.read(), writeFrame(stream, header, payload)]);
    assert.deepEqual(frame.header, header);
    assert.deepEqual(frame.payload, payload);
    assert.equal(digest(frame.payload), sha256);
  }
  stream.end();
  assert.equal(await reader.read(), null);
});

test('exactly 4096 UTF-8 header bytes are accepted', async () => {
  const header = { op: 'ping', pad: '中'.repeat(1000) };
  header.pad += 'x'.repeat(4096 - Buffer.byteLength(JSON.stringify(header)));
  const encoded = Buffer.from(JSON.stringify(header));
  assert.equal(encoded.length, 4096);
  const stream = new PassThrough();
  const reader = new FrameReader(stream);
  const [frame] = await Promise.all([reader.read(), writeFrame(stream, header)]);
  assert.deepEqual(frame, { header, payload: Buffer.alloc(0) });
  stream.end();
});

test('writer rejects out-of-bounds header and payload before writing', async () => {
  const stream = new PassThrough();
  const received = [];
  stream.on('data', chunk => received.push(chunk));
  const header = { pad: 'x'.repeat(4096) };
  await assert.rejects(writeFrame(stream, header), /length exceeds limit/);
  await assert.rejects(writeFrame(stream, {}, Buffer.alloc(MAX_PAYLOAD + 1)), /length exceeds limit/);
  assert.equal(received.length, 0);
  stream.end();
});

test('reader rejects invalid magic or declared lengths before reading bodies', async () => {
  for (const [options, message] of [
    [{ magic: 'SFT2' }, /Invalid frame version/],
    [{ headerBytes: 0 }, /length exceeds limit/],
    [{ headerBytes: 4097 }, /length exceeds limit/],
    [{ payloadBytes: MAX_PAYLOAD + 1 }, /length exceeds limit/],
    [{ payloadBytes: 0xffffffff }, /length exceeds limit/],
  ]) {
    await assert.rejects(readBytes(wire(Buffer.alloc(0), Buffer.alloc(0), options)), message);
  }
});

test('reader rejects invalid UTF-8, invalid JSON and non-object metadata', async () => {
  await assert.rejects(readBytes(wire(Buffer.from([0xc3, 0x28]))), /UTF-8/i);
  await assert.rejects(readBytes(wire(Buffer.from('{"op":'))), SyntaxError);
  for (const value of ['null', '[]', '"ping"', '1']) {
    await assert.rejects(readBytes(wire(Buffer.from(value))), /header must be a JSON object/);
  }
});

test('reader distinguishes normal EOF from truncated prefix, JSON or payload', async () => {
  const header = Buffer.from('{"op":"put"}');
  const complete = wire(header, Buffer.from([0, 255]));
  assert.equal(await readBytes(Buffer.alloc(0)), null);
  for (const bytes of [
    complete.subarray(0, 11),
    complete.subarray(0, 12 + header.length - 1),
    complete.subarray(0, complete.length - 1),
  ]) {
    await assert.rejects(readBytes(bytes), /Truncated frame/);
  }
});

test('remote names accept safe bounds and reject nonportable or nested paths', () => {
  for (const name of ['x', 'X-_.dat', 'a'.repeat(64), 'com10.txt']) {
    assert.equal(validName(name), true, name);
  }
  for (const name of [
    '', 'a'.repeat(65), '.', '..', '.hidden', 'sample.', 'a b', 'a\n', 'a\0',
    'résumé.pdf', 'dir/file', 'dir\\file', '../outside', '/absolute', 'C:drive',
    'NUL', 'con.txt', 'PRN', 'aux.bin', 'COM1.log', 'lPt9', null, 1, {},
  ]) {
    assert.equal(validName(name), false, String(name));
  }
});
