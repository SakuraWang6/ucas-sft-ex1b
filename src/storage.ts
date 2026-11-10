import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MAX_PAYLOAD, validName } from './protocol.js';

const MAX_FILES = 16;

export class RequestError extends Error {}

export async function requirePrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Storage must be a private directory owned by the server account');
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('Storage owner must match the server account');
  }
}

export async function listFiles(directory: string): Promise<{ name: string; bytes: number }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !validName(entry.name)) continue;
    const stat = await lstat(join(directory, entry.name));
    if (stat.isFile() && stat.size <= MAX_PAYLOAD) files.push({ name: entry.name, bytes: stat.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_FILES);
}

export async function storeFile(directory: string, name: string, payload: Buffer): Promise<void> {
  // One authenticated session per user serializes updates to this private directory.
  if ((await readdir(directory)).length >= MAX_FILES) throw new RequestError('Storage is full');
  const temporary = join(directory, '.part-' + randomUUID());
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(payload);
    } finally {
      await file.close();
    }
    // Link commits a complete file and fails atomically if the name already exists.
    await link(temporary, join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RequestError('File already exists');
    throw error;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      console.error('Could not remove staging file:', error.code);
    });
  }
}

export async function loadFile(directory: string, name: string): Promise<Buffer> {
  const path = join(directory, name);
  try {
    if (!(await lstat(path)).isFile()) throw new RequestError('File is unavailable');
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const handle = await open(path, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PAYLOAD) {
        throw new RequestError('File is unavailable');
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) throw new RequestError('File changed during read');
        offset += bytesRead;
      }
      const latest = await handle.stat();
      if (latest.size !== stat.size || latest.mtimeMs !== stat.mtimeMs) {
        throw new RequestError('File changed during read');
      }
      return buffer;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') throw new RequestError('File is unavailable');
    throw error;
  }
}
