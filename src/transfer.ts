import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { CHUNK_BYTES, digest, MAX_PAYLOAD } from './protocol.js';
import type { Session } from './session.js';

const HASH_BYTES = 64;
const SHA256 = /^[0-9a-f]{64}$/;

function validSize(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

async function loadCheckpoint(path: string, hash: string, bytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (!file) return Buffer.alloc(0);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Download checkpoint must be a private file.');
    if (stat.size < HASH_BYTES || stat.size > HASH_BYTES + bytes) return Buffer.alloc(0);
    const data = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== data.length || data.toString('ascii', 0, HASH_BYTES) !== hash) return Buffer.alloc(0);
    return data.subarray(HASH_BYTES);
  } finally {
    await file.close();
  }
}

async function saveCheckpoint(path: string, hash: string, data: Buffer): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(Buffer.concat([Buffer.from(hash, 'ascii'), data]));
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function clearCheckpoint(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function uploadFile(session: Session, name: string, data: Buffer, signal?: AbortSignal) {
  const sha256 = digest(data);
  const bytes = data.length;
  const match = (header: Record<string, unknown>) =>
    header.name === name && header.bytes === bytes && header.sha256 === sha256;
  signal?.throwIfAborted();
  const { header } = await session.exchange('put-begin', { name, bytes, sha256 });
  if (!match(header) || !validSize(header.offset, bytes) || typeof header.complete !== 'boolean'
    || (header.complete && header.offset !== bytes)) {
    throw new Error('Invalid upload checkpoint.');
  }
  const resumedAt = header.offset;
  if (!header.complete) {
    for (let offset = resumedAt; offset < bytes;) {
      signal?.throwIfAborted();
      const end = Math.min(offset + CHUNK_BYTES, bytes);
      const chunk = await session.exchange('put-chunk', { name, sha256, offset }, data.subarray(offset, end));
      if (chunk.header.name !== name || chunk.header.sha256 !== sha256 || chunk.header.offset !== end) {
        throw new Error('Invalid upload chunk acknowledgement.');
      }
      offset = end;
    }
    signal?.throwIfAborted();
    const result = await session.exchange('put-finish', { name, sha256 });
    if (!match(result.header)) throw new Error('The upload acknowledgement did not match the file.');
  }
  return { name, bytes, sha256, resumedAt };
}

export async function downloadFile(session: Session, name: string, checkpoint: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { header } = await session.exchange('get-info', { name });
  const { bytes, sha256 } = header;
  if (header.name !== name || !validSize(bytes, MAX_PAYLOAD) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new Error('Invalid download metadata.');
  }
  const prefix = await loadCheckpoint(checkpoint, sha256, bytes);
  const data = Buffer.alloc(bytes);
  prefix.copy(data);
  for (let offset = prefix.length; offset < bytes;) {
    signal?.throwIfAborted();
    const length = Math.min(CHUNK_BYTES, bytes - offset);
    const { header: chunk, payload } = await session.exchange('get-chunk', { name, offset, bytes: length, sha256 });
    if (chunk.name !== name || chunk.offset !== offset || chunk.bytes !== length
      || chunk.sha256 !== sha256 || payload.length !== length) {
      throw new Error('Invalid download chunk metadata.');
    }
    payload.copy(data, offset);
    offset += length;
    await saveCheckpoint(checkpoint, sha256, data.subarray(0, offset));
  }
  if (digest(data) !== sha256) {
    await clearCheckpoint(checkpoint);
    throw new Error('Download SHA-256 did not match the file. Retry to download from the start.');
  }
  signal?.throwIfAborted();
  return { data, sha256, resumedAt: prefix.length };
}
