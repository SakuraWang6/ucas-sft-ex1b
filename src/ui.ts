import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { connectClient, Session, closeSocket } from './session.js';
import { digest, MAX_PAYLOAD, validName } from './protocol.js';
import { clearCheckpoint, downloadFile, uploadFile } from './transfer.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const length = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PAYLOAD) {
    throw new HttpError(413, '请选择不超过 8 MiB 的文件');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PAYLOAD) throw new HttpError(413, '文件超过 8 MiB');
    chunks.push(chunk);
  }
  if (size !== length) throw new HttpError(400, '文件长度不一致');
  return Buffer.concat(chunks, size);
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw new Error('Usage: node dist/ui.js <client.json>');
  const cacheDir = join(dirname(resolve(configPath)), '.sft-download-' + basename(configPath, '.json'));
  async function checkpointPath(name: string) {
    await mkdir(cacheDir, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(cacheDir);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('下载缓存必须是私有目录');
    return join(cacheDir, digest(Buffer.from(name)) + '.part');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const token = randomBytes(32).toString('hex');
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ].map(async ([path, file, type]) => {
    const content = await readFile(new URL('../ui/' + file, import.meta.url), 'utf8');
    return [path, { content, type }] as const;
  })));

  const shutdown = new AbortController();
  let socket: TLSSocket | undefined;
  let session: Session | undefined;
  let busy = false;
  const transferSockets = new Set<TLSSocket>();
  const activeTransfers = new Set<string>();
  const transferLimit = 3;
  let origin = '';
  const connected = () => Boolean(socket && !socket.destroyed && session);

  async function connect(): Promise<void> {
    if (connected()) return;
    const nextSocket = await connectClient(configPath, shutdown.signal);
    nextSocket.on('error', () => {});
    try {
      shutdown.signal.throwIfAborted();
      session = undefined;
      socket = nextSocket;
      const nextSession = new Session(nextSocket);
      await nextSession.exchange('ping');
      shutdown.signal.throwIfAborted();
      session = nextSession;
    } catch (error) {
      nextSocket.destroy();
      if (socket === nextSocket) socket = undefined;
      throw error;
    }
  }

  async function disconnect(): Promise<void> {
    const previous = socket;
    const previousSession = session;
    session = undefined;
    try {
      if (previous && !previous.destroyed) {
        await previousSession?.exchange('quit');
        await closeSocket(previous);
      }
    } finally {
      previous?.destroy();
      socket = undefined;
    }
  }

  async function withTransfer<T>(
    key: string,
    response: ServerResponse,
    run: (worker: Session, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!connected()) throw new HttpError(503, '连接已断开，请重新连接');
    if (activeTransfers.has(key) || activeTransfers.size >= transferLimit) {
      throw new HttpError(409, '传输任务已在运行或达到并行上限');
    }
    activeTransfers.add(key);
    const cancel = new AbortController();
    response.once('close', () => cancel.abort());
    const signal = AbortSignal.any([cancel.signal, shutdown.signal]);
    let workerSocket: TLSSocket | undefined;
    const stopWorker = () => workerSocket?.destroy();
    signal.addEventListener('abort', stopWorker, { once: true });
    try {
      workerSocket = await connectClient(configPath, signal);
      workerSocket.on('error', () => {});
      transferSockets.add(workerSocket);
      signal.throwIfAborted();
      const worker = new Session(workerSocket);
      await worker.exchange('ping');
      const result = await run(worker, signal);
      await worker.exchange('quit');
      await closeSocket(workerSocket);
      return result;
    } finally {
      signal.removeEventListener('abort', stopWorker);
      if (workerSocket) {
        workerSocket.destroy();
        transferSockets.delete(workerSocket);
      }
      activeTransfers.delete(key);
    }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) {
        throw new HttpError(403, '仅允许本机界面访问');
      }
      const url = new URL(request.url ?? '/', origin);
      const asset = assets.get(url.pathname);
      if (asset && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': asset.type });
        response.end(asset.content);
        return;
      }
      if ((request.headers.origin && request.headers.origin !== origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, '仅允许本机界面访问');
      }
      if (request.headers['x-sft-token'] !== token) {
        throw new HttpError(403, '界面会话无效，请打开终端显示的完整链接');
      }
      if (url.pathname === '/api/status' && request.method === 'GET') {
        json(response, 200, {
          connected: connected(), user: basename(configPath, '.json'),
          protocol: connected() ? socket?.getProtocol() : null,
          peer: config.host + ':' + config.port, filesLimit: 16, maxBytes: MAX_PAYLOAD, transferLimit,
        });
        return;
      }
      const uploadResume = url.pathname === '/api/upload-resume' && request.method === 'POST';
      const downloadResume = url.pathname === '/api/download-resume' && request.method === 'GET';
      if (uploadResume || downloadResume) {
        const name = url.searchParams.get('name');
        if (!validName(name)) throw new HttpError(400, '文件名格式无效');
        if (busy) throw new HttpError(409, '连接状态正在切换，请稍后重试');
        if (uploadResume) {
          const result = await withTransfer('upload:' + name, response, async (worker, signal) =>
            uploadFile(worker, name, await body(request), signal));
          json(response, 200, result);
        } else {
          const result = await withTransfer('download:' + name, response, async (worker, signal) => {
            const checkpoint = await checkpointPath(name);
            const result = await downloadFile(worker, name, checkpoint, signal);
            await clearCheckpoint(checkpoint);
            return result;
          });
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'Content-Length': result.data.length,
            'Content-Disposition': 'attachment; filename="' + name + '"',
            'X-SFT-SHA256': result.sha256, 'X-SFT-Resumed-Bytes': result.resumedAt,
          });
          response.end(result.data);
        }
        return;
      }
      if (busy) throw new HttpError(409, '当前操作进行中，请稍后重试');
      busy = true;
      try {
        if (url.pathname === '/api/connect' && request.method === 'POST') {
          await connect();
          json(response, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/disconnect' && request.method === 'POST') {
          if (activeTransfers.size) throw new HttpError(409, '请先暂停或完成正在传输的任务');
          await disconnect();
          json(response, 200, { ok: true });
          return;
        }
        if (!connected() || !session) throw new HttpError(503, '连接已断开，请重新连接');
        if (url.pathname === '/api/files' && request.method === 'GET') {
          const result = await session.exchange('list');
          json(response, 200, { files: result.header.files });
          return;
        }
        const name = url.searchParams.get('name');
        if (!validName(name)) throw new HttpError(400, '文件名请使用字母、数字、点、下划线或连字符，最长 64 字符');
        if (url.pathname === '/api/upload' && request.method === 'POST') {
          const payload = await body(request);
          const sha256 = digest(payload);
          const result = await session.exchange('put', { name, sha256 }, payload);
          if (result.header.name !== name || result.header.bytes !== payload.length || result.header.sha256 !== sha256) {
            throw new Error('上传确认与文件不一致');
          }
          json(response, 200, { name, bytes: payload.length, sha256 });
          return;
        }
        if (url.pathname === '/api/download' && request.method === 'GET') {
          const result = await session.exchange('get', { name });
          const sha256 = digest(result.payload);
          if (result.header.name !== name || result.header.bytes !== result.payload.length || result.header.sha256 !== sha256) {
            throw new Error('下载文件完整性校验失败');
          }
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'Content-Length': result.payload.length,
            'Content-Disposition': 'attachment; filename="' + name + '"',
            'X-SFT-SHA256': sha256,
          });
          response.end(result.payload);
          return;
        }
        throw new HttpError(404, '操作不存在');
      } finally {
        busy = false;
      }
    } catch (error) {
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 400;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  server.on('connection', connection => connection.setTimeout(30_000, () => connection.destroy()));
  const port = Number(process.env.SFT_UI_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SFT_UI_PORT');
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      origin = 'http://127.0.0.1:' + address.port;
      console.log('UI ' + origin + '/#token=' + token);
    }
  });
  let pingPending = false;
  const heartbeat = setInterval(() => {
    if (busy || pingPending || !connected() || !session) return;
    const current = socket;
    pingPending = true;
    session.exchange('ping').catch(() => current?.destroy()).finally(() => { pingPending = false; });
  }, 15_000);
  heartbeat.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (shutdown.signal.aborted) return;
      shutdown.abort();
      clearInterval(heartbeat);
      socket?.destroy();
      for (const worker of transferSockets) worker.destroy();
      server.close();
      server.closeAllConnections();
    });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
