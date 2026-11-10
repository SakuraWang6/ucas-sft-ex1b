import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

const MAGIC = Buffer.from('SFT1', 'ascii');
const PREFIX_BYTES = 12;
const MAX_HEADER = 4096;
export const MAX_PAYLOAD = 8 * 1024 * 1024;

type Header = Record<string, unknown>;
export type Frame = { header: Header; payload: Buffer };

export function digest(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function validName(name: unknown): name is string {
  return typeof name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.endsWith('.')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export class FrameReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(stream: Duplex) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  private async readBytes(size: number, allowEof: true): Promise<Buffer | null>;
  private async readBytes(size: number, allowEof?: false): Promise<Buffer>;
  private async readBytes(size: number, allowEof = false): Promise<Buffer | null> {
    const output = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.chunks.next();
        if (next.done) {
          if (allowEof && written === 0) return null;
          throw new Error('Truncated frame');
        }
        this.chunk = next.value;
        this.offset = 0;
      }
      const count = Math.min(size - written, this.chunk.length - this.offset);
      this.chunk.copy(output, written, this.offset, this.offset + count);
      this.offset += count;
      written += count;
    }
    return output;
  }

  async read(): Promise<Frame | null> {
    const prefix = await this.readBytes(PREFIX_BYTES, true);
    if (prefix === null) return null;
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid frame version');
    const headerBytes = prefix.readUInt32BE(4);
    const payloadBytes = prefix.readUInt32BE(8);
    if (headerBytes === 0 || headerBytes > MAX_HEADER || payloadBytes > MAX_PAYLOAD) {
      throw new Error('Frame length exceeds limit');
    }
    const header: unknown = JSON.parse(this.decoder.decode(await this.readBytes(headerBytes)));
    if (header === null || typeof header !== 'object' || Array.isArray(header)) {
      throw new Error('Frame header must be a JSON object');
    }
    return { header: header as Header, payload: await this.readBytes(payloadBytes) };
  }
}

function writeBytes(stream: Duplex, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

export async function writeFrame(stream: Duplex, header: Header, payload: Buffer = Buffer.alloc(0)): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(header), 'utf-8');
  if (encoded.length === 0 || encoded.length > MAX_HEADER || payload.length > MAX_PAYLOAD) {
    throw new Error('Frame length exceeds limit');
  }
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(encoded.length, 4);
  prefix.writeUInt32BE(payload.length, 8);
  await writeBytes(stream, Buffer.concat([prefix, encoded]));
  if (payload.length > 0) await writeBytes(stream, payload);
}
