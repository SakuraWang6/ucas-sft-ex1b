import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, MAX_PAYLOAD, validDigest, validName } from './protocol.js';

// 每个账号有独立的文件目录，已完成文件与续传暂存文件共用名额。
const MAX_FILES = 16;
const SAFE_OPEN = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type PartialFile = { path: string; name: string; bytes: number; sha256: string };
type FileInfo = Pick<PartialFile, 'name' | 'bytes' | 'sha256'>;
type UploadProgress = FileInfo & { offset: number; complete: boolean };

export class RequestError extends Error {}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export async function requirePrivateDirectory(path: string): Promise<void> {
  // 检查目录本身，以拒绝用符号链接替代存储路径。
  const stat = await lstat(path);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Storage must be a private directory owned by the server account');
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('Storage owner must match the server account');
  }
}

async function loadFile(path: string): Promise<Buffer> {
  try {
    if (!(await lstat(path)).isFile()) throw new RequestError('File is unavailable');
    const handle = await open(path, constants.O_RDONLY | SAFE_OPEN);
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
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ELOOP') throw new RequestError('File is unavailable');
    throw error;
  }
}

async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') console.error('Could not remove staging file:', errorCode(error));
  }
}

async function partialOffset(partial: PartialFile): Promise<number> {
  // 暂存文件实际长度就是下一次写入的偏移，进程重启后仍可从磁盘恢复。
  const stat = await lstat(partial.path);
  if (!stat.isFile() || stat.size > partial.bytes) throw new RequestError('Upload staging file is invalid');
  return stat.size;
}

async function append(partial: PartialFile, offset: number, payload: Buffer): Promise<number> {
  if (offset + payload.length > partial.bytes) throw new RequestError('Chunk exceeds declared file length');
  await partialOffset(partial);
  const handle = await open(partial.path, constants.O_WRONLY | SAFE_OPEN);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new RequestError('Upload staging file is invalid');
    // 只允许从当前末尾追加，防止重试或并行请求改写已收到的数据。
    if (stat.size !== offset) throw new RequestError('Upload offset does not match');
    let written = 0;
    while (written < payload.length) {
      const { bytesWritten } = await handle.write(payload, written, payload.length - written, offset + written);
      if (bytesWritten === 0) throw new Error('Could not write upload chunk');
      written += bytesWritten;
    }
    // 同步成功后才确认新偏移，客户端收到确认即可继续发送下一块。
    await handle.sync();
    return offset + written;
  } finally {
    await handle.close();
  }
}

export class AccountStorage {
  private readonly staging: string;
  private readonly activeFiles = new Set<string>();
  private metadata = Promise.resolve();

  constructor(private readonly directory: string) {
    this.staging = join(directory, '.sft-partial');
  }

  async initialize(): Promise<void> {
    await mkdir(this.staging, { mode: 0o700 }).catch(error => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    await requirePrivateDirectory(this.staging);
  }

  async list(): Promise<{ name: string; bytes: number }[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !validName(entry.name)) continue;
      const stat = await existing(join(this.directory, entry.name));
      if (stat?.isFile() && stat.size <= MAX_PAYLOAD) files.push({ name: entry.name, bytes: stat.size });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_FILES);
  }

  load(name: string): Promise<Buffer> {
    return loadFile(join(this.directory, name));
  }

  store(name: string, payload: Buffer, sha256: string): Promise<void> {
    return this.exclusive(name, async () => {
      const partial = await this.createPartial({ name, bytes: payload.length, sha256 });
      try {
        if (payload.length) await append(partial, 0, payload);
        await this.publish(partial);
      } finally {
        await discard(partial.path);
      }
    });
  }

  begin(info: FileInfo): Promise<UploadProgress> {
    return this.exclusive(info.name, async () => {
      const complete = await this.completed(info.name, info.sha256);
      if (complete) {
        if (complete.bytes !== info.bytes) throw new RequestError('File already exists');
        return { ...complete, offset: complete.bytes, complete: true };
      }
      const partial = await this.findPartial(info.name) ?? await this.createPartial(info);
      if (partial.sha256 !== info.sha256 || partial.bytes !== info.bytes) {
        throw new RequestError('Upload already in progress with different file metadata');
      }
      return { ...info, offset: await partialOffset(partial), complete: false };
    });
  }

  append(name: string, sha256: string, offset: number, payload: Buffer): Promise<number> {
    return this.exclusive(name, async () => {
      const partial = await this.requirePartial(name, sha256);
      return append(partial, offset, payload);
    });
  }

  finish(name: string, sha256: string): Promise<FileInfo> {
    return this.exclusive(name, async () => {
      const complete = await this.completed(name, sha256);
      if (complete) return complete;
      const partial = await this.requirePartial(name, sha256);
      if (await partialOffset(partial) !== partial.bytes) throw new RequestError('Upload is incomplete');
      const payload = await loadFile(partial.path);
      if (payload.length !== partial.bytes || digest(payload) !== sha256) {
        await discard(partial.path);
        throw new RequestError('File digest mismatch');
      }
      await this.publish(partial);
      return { name, bytes: partial.bytes, sha256 };
    });
  }

  private async exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
    // 同名操作跨会话互斥，大小写变体共用锁，以适配大小写不敏感的文件系统。
    const key = name.toLowerCase();
    if (this.activeFiles.has(key)) throw new RequestError('File is busy');
    this.activeFiles.add(key);
    try {
      return await work();
    } finally {
      this.activeFiles.delete(key);
    }
  }

  private updateMetadata<T>(work: () => Promise<T>): Promise<T> {
    // 将配额检查、名额预留和发布串行化，避免并行上传重复占用名额。
    const result = this.metadata.then(work);
    this.metadata = result.then(() => undefined, () => undefined);
    return result;
  }

  private async partials(): Promise<PartialFile[]> {
    const entries = await readdir(this.staging);
    const partials: PartialFile[] = [];
    for (const entry of entries) {
      const match = /^(.+)\.([0-9]{1,7})\.([a-f0-9]{64})$/.exec(entry);
      if (!match) continue;
      const [, name, length, sha256] = match;
      const bytes = Number(length);
      if (validName(name) && bytes <= MAX_PAYLOAD) {
        partials.push({ path: join(this.staging, entry), name, bytes, sha256 });
      }
    }
    return partials;
  }

  private async findPartial(name: string): Promise<PartialFile | undefined> {
    const matches = (await this.partials()).filter(file => file.name.toLowerCase() === name.toLowerCase());
    if (matches.length > 1 || (matches[0] && matches[0].name !== name)) {
      throw new RequestError('Upload already in progress for this name');
    }
    return matches[0];
  }

  private async requirePartial(name: string, sha256: string): Promise<PartialFile> {
    const partial = await this.findPartial(name);
    if (!partial || partial.sha256 !== sha256) throw new RequestError('Matching upload has not begun');
    return partial;
  }

  private createPartial(info: FileInfo): Promise<PartialFile> {
    return this.updateMetadata(async () => {
      const names = new Set((await readdir(this.directory)).filter(validName).map(name => name.toLowerCase()));
      const key = info.name.toLowerCase();
      if (names.has(key)) throw new RequestError('File already exists');
      for (const partial of await this.partials()) {
        if (partial.name.toLowerCase() === key) throw new RequestError('Upload already in progress for this name');
        names.add(partial.name.toLowerCase());
      }
      if (names.size >= MAX_FILES) throw new RequestError('Storage is full');
      // 文件名记录目标名称、总长度与摘要，独占创建即可原子登记一个续传任务。
      const path = join(this.staging, `${info.name}.${info.bytes}.${info.sha256}`);
      const file = await open(path, 'wx', 0o600);
      await file.close();
      return { ...info, path };
    });
  }

  private async completed(name: string, sha256: string): Promise<FileInfo | undefined> {
    const path = join(this.directory, name);
    const stat = await existing(path);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.size > MAX_PAYLOAD) throw new RequestError('File already exists');
    const payload = await loadFile(path);
    if (!validDigest(sha256) || digest(payload) !== sha256) throw new RequestError('File already exists');
    // 发布后若响应丢失，重试可返回相同文件的结果，并清理可能遗留的暂存链接。
    const partial = await this.findPartial(name);
    if (partial?.sha256 === sha256 && partial.bytes === payload.length) await discard(partial.path);
    return { name, bytes: payload.length, sha256 };
  }

  private publish(partial: PartialFile): Promise<void> {
    return this.updateMetadata(async () => {
      try {
        // 校验通过后用硬链接原子发布，目标名已存在时保留原文件。
        await link(partial.path, join(this.directory, partial.name));
      } catch (error) {
        if (errorCode(error) === 'EEXIST') throw new RequestError('File already exists');
        throw error;
      }
      await discard(partial.path);
    });
  }
}
