import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

// 客户端与服务端共用 SFT1 分帧格式，由 12 字节定长头、UTF-8 JSON 控制头和二进制载荷组成。
const MAGIC = Buffer.from('SFT1', 'ascii');
const PREFIX_BYTES = 12;
const MAX_HEADER = 4096;
const PACE_BLOCK_BYTES = 64 * 1024;
export const MAX_PAYLOAD = 8 * 1024 * 1024;
export const CHUNK_BYTES = 512 * 1024;
export const MAX_ACCOUNT_CONNECTIONS = 4;

type Header = Record<string, unknown>;
export type Frame = { header: Header; payload: Buffer };
export type PayloadPacer = (bytes: number) => Promise<void>;

export function digest(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function validName(name: unknown): name is string {
  // 远端名称只能表示单个文件，并遵循各平台通用的命名约束。
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export class FrameReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  // 一次流读取可能包含半帧或多帧，保留本段的未读字节供下次解析。
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(stream: Duplex) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  private async readInto(output: Buffer, start: number, end: number, allowEof = false): Promise<boolean> {
    let written = start;
    while (written < end) {
      if (this.offset === this.chunk.length) {
        const next = await this.chunks.next();
        if (next.done) {
          // 只有开始读取下一帧且尚未收到任何字节时，流结束才表示正常退出。
          if (allowEof && written === start) return false;
          throw new Error('Truncated frame');
        }
        this.chunk = next.value;
        this.offset = 0;
      }
      const count = Math.min(end - written, this.chunk.length - this.offset);
      this.chunk.copy(output, written, this.offset, this.offset + count);
      this.offset += count;
      written += count;
    }
    return true;
  }

  async read(pace?: PayloadPacer): Promise<Frame | null> {
    const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
    if (!(await this.readInto(prefix, 0, PREFIX_BYTES, true))) return null;
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid frame version');
    const headerBytes = prefix.readUInt32BE(4);
    const payloadBytes = prefix.readUInt32BE(8);
    // 先校验对端声明的长度，再分配变长字段的缓冲区。
    if (headerBytes === 0 || headerBytes > MAX_HEADER || payloadBytes > MAX_PAYLOAD) {
      throw new Error('Frame length exceeds limit');
    }
    const encoded = Buffer.allocUnsafe(headerBytes);
    await this.readInto(encoded, 0, headerBytes);
    const header: unknown = JSON.parse(this.decoder.decode(encoded));
    if (header === null || typeof header !== 'object' || Array.isArray(header)) {
      throw new Error('Frame header must be a JSON object');
    }
    const payload = Buffer.allocUnsafe(payloadBytes);
    if (pace) {
      for (let offset = 0; offset < payloadBytes; offset += PACE_BLOCK_BYTES) {
        const end = Math.min(payloadBytes, offset + PACE_BLOCK_BYTES);
        await pace(end - offset);
        await this.readInto(payload, offset, end);
      }
    } else {
      await this.readInto(payload, 0, payloadBytes);
    }
    return { header: header as Header, payload };
  }
}

function writeBytes(stream: Duplex, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

export async function writeFrame(
  stream: Duplex, header: Header, payload: Buffer = Buffer.alloc(0), pace?: PayloadPacer,
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(header), 'utf-8');
  if (encoded.length === 0 || encoded.length > MAX_HEADER || payload.length > MAX_PAYLOAD) {
    throw new Error('Frame length exceeds limit');
  }
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(encoded.length, 4);
  prefix.writeUInt32BE(payload.length, 8);
  await writeBytes(stream, Buffer.concat([prefix, encoded]));
  // 限速只计算载荷。应用层按块等待额度，块边界无需写入帧。
  if (pace) {
    for (let offset = 0; offset < payload.length; offset += PACE_BLOCK_BYTES) {
      const chunk = payload.subarray(offset, offset + PACE_BLOCK_BYTES);
      await pace(chunk.length);
      await writeBytes(stream, chunk);
    }
  } else if (payload.length > 0) {
    await writeBytes(stream, payload);
  }
}
