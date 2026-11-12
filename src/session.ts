import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { FrameReader, writeFrame } from './protocol.js';

const REQUEST_TIMEOUT_MS = 45_000;

export async function connectClient(configPath: string, signal?: AbortSignal): Promise<TLSSocket> {
  const config = JSON.parse(await readFile(configPath, { encoding: 'utf8', signal }));
  if (!config || typeof config !== 'object') {
    throw new Error('Client configuration must be a JSON object.');
  }

  const { host, port, servername, ca, cert, key } = config;
  if (
    typeof host !== 'string' || !host ||
    !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof servername !== 'string' || !servername ||
    typeof ca !== 'string' || !ca ||
    typeof cert !== 'string' || !cert ||
    typeof key !== 'string' || !key
  ) {
    throw new Error('Client configuration needs host, port, servername, ca, cert and key.');
  }

  // 证书路径相对于配置文件解析。客户端使用 CA 和 servername 验证服务端身份。
  const directory = dirname(resolve(configPath));
  const [caPem, certPem, keyPem] = await Promise.all([
    readFile(resolve(directory, ca), { signal }),
    readFile(resolve(directory, cert), { signal }),
    readFile(resolve(directory, key), { signal }),
  ]);
  signal?.throwIfAborted();
  const socket = connect({
    host, port, servername,
    ca: caPem, cert: certPem, key: keyPem,
    minVersion: 'TLSv1.3',
    rejectUnauthorized: true,
  });
  const deadline = setTimeout(() => socket.destroy(new Error('TLS handshake timed out.')), 5000);
  try {
    await once(socket, 'secureConnect', { signal });
    signal?.throwIfAborted();
    socket.setKeepAlive(true, 10_000);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export class Session {
  private readonly reader: FrameReader;
  private pending = Promise.resolve();

  constructor(private readonly socket: TLSSocket) {
    this.reader = new FrameReader(socket);
  }

  // 同一条连接依次处理请求，读取到的响应帧对应当前请求。
  exchange(op: string, header: Record<string, unknown> = {}, payload?: Buffer) {
    const request = this.pending.then(async () => {
      const deadline = setTimeout(() => {
        this.socket.destroy(new Error('Request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      try {
        if (this.socket.destroyed) {
          throw new Error('The connection is closed.');
        }
        const response = await this.roundTrip(op, header, payload);
        if (
          !response || response.header.op !== op ||
          (response.header.status !== 'ok' && response.header.status !== 'error') ||
          ((!['get', 'get-chunk'].includes(op) || response.header.status !== 'ok') && response.payload.length !== 0)
        ) {
          this.socket.destroy();
          throw new Error('Missing or invalid server response.');
        }
        if (response.header.status === 'error') {
          const message = response.header.message;
          throw new Error(typeof message === 'string' ? message : 'The server rejected the request.');
        }
        return response;
      } finally {
        clearTimeout(deadline);
      }
    });
    // 当前请求失败后仍释放队列，后续请求可在连接可用时继续执行。
    this.pending = request.then(() => undefined, () => undefined);
    return request;
  }

  private async roundTrip(op: string, header: Record<string, unknown>, payload?: Buffer) {
    try {
      await writeFrame(this.socket, { ...header, op }, payload);
      return await this.reader.read();
    } catch (error) {
      this.socket.destroy();
      throw error;
    }
  }
}

export async function closeSocket(socket: TLSSocket): Promise<void> {
  if (socket.destroyed) {
    return;
  }
  const deadline = setTimeout(() => socket.destroy(), 2000);
  try {
    const closed = once(socket, 'close');
    socket.end();
    await closed;
  } finally {
    clearTimeout(deadline);
  }
}
