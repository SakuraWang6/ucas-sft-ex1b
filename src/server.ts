import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import { FrameReader, digest, validName, writeFrame, type Frame } from './protocol.js';
import { listFiles, loadFile, requirePrivateDirectory, RequestError, storeFile } from './storage.js';

const MAX_CONNECTIONS = 12;
const HANDSHAKE_MS = 5_000;
const KEEPALIVE_MS = 10_000;
const REQUEST_MS = 45_000;
const REQUESTS_PER_MINUTE = 120;

type User = { name: string; directory: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleRequest(socket: TLSSocket, directory: string, frame: Frame): Promise<boolean> {
  const { op, name, sha256 } = frame.header;
  const ok = { op, status: 'ok' };
  try {
    if (op !== 'put' && frame.payload.length !== 0) throw new RequestError('Unexpected file payload');
    switch (op) {
      case 'list':
        await writeFrame(socket, { ...ok, files: await listFiles(directory) });
        break;
      case 'put':
        if (!validName(name)) throw new RequestError('Invalid file name');
        if (sha256 !== digest(frame.payload)) throw new RequestError('File digest mismatch');
        await storeFile(directory, name, frame.payload);
        await writeFrame(socket, { ...ok, name, bytes: frame.payload.length, sha256 });
        break;
      case 'get': {
        if (!validName(name)) throw new RequestError('Invalid file name');
        const payload = await loadFile(directory, name);
        await writeFrame(socket, { ...ok, name, bytes: payload.length, sha256: digest(payload) }, payload);
        break;
      }
      case 'ping':
      case 'quit':
        await writeFrame(socket, ok);
        break;
      default:
        throw new RequestError('Unknown operation');
    }
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    await writeFrame(socket, {
      op: typeof op === 'string' && op.length <= 16 ? op : 'unknown',
      status: 'error',
      message: error.message,
    });
    return true;
  }
  return op !== 'quit';
}

async function serveSession(socket: TLSSocket, user: User, id: number): Promise<void> {
  socket.setKeepAlive(true, KEEPALIVE_MS);
  const reader = new FrameReader(socket);
  console.log(`SESSION ${id} OPEN ${user.name} ${socket.getProtocol()}`);
  let windowStart = performance.now();
  let requestCount = 0;
  try {
    for (;;) {
      // The deadline covers the full frame and response, even if a peer trickles bytes.
      const deadline = setTimeout(() => socket.destroy(new Error('Request deadline exceeded')), REQUEST_MS);
      try {
        const frame = await reader.read();
        if (!frame) break;
        if (performance.now() - windowStart >= 60_000) {
          windowStart = performance.now();
          requestCount = 0;
        }
        if (++requestCount > REQUESTS_PER_MINUTE) throw new Error('Session request limit exceeded');
        if (!(await handleRequest(socket, user.directory, frame))) break;
        if (frame.header.op !== 'ping') console.log(`SESSION ${id} ${user.name} ${String(frame.header.op).slice(0, 16).replace(/[^a-z]/g, '')}`);
      } finally {
        clearTimeout(deadline);
      }
    }
    socket.end();
  } catch (error) {
    console.error(`SESSION ${id} CLOSED ${errorMessage(error)}`);
    socket.destroy();
  } finally {
    console.log(`SESSION ${id} END ${user.name}`);
  }
}

async function main(): Promise<void> {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('Usage: node dist/server.js <server.json>');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const base = dirname(resolve(configFile));
  const storage = resolve(base, config.dataDir);
  await requirePrivateDirectory(storage);
  const users = new Map<string, User>();
  for (const [name, fingerprint] of Object.entries(config.users)) {
    if (!validName(name) || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)
      || typeof fingerprint !== 'string' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)
      || users.has(fingerprint)) throw new Error('Invalid account configuration');
    const directory = join(storage, name);
    await requirePrivateDirectory(directory);
    users.set(fingerprint, { name, directory });
  }
  if (users.size === 0) throw new Error('Configure at least one client certificate');

  const [key, cert, ca] = await Promise.all(
    [config.key, config.cert, config.ca].map((file: string) => readFile(resolve(base, file))),
  );
  const active = new Set<string>();
  const server = createServer({
    key, cert, ca,
    minVersion: 'TLSv1.3',
    requestCert: true,
    rejectUnauthorized: true,
    handshakeTimeout: HANDSHAKE_MS,
  }, (socket) => {
    socket.on('error', () => {});
    const user = users.get(socket.getPeerCertificate().fingerprint256);
    if (!socket.authorized || !user || active.has(user.name)) {
      socket.destroy();
      return;
    }
    active.add(user.name);
    void serveSession(socket, user, ++lastSession).finally(() => active.delete(user.name));
  });
  let lastSession = 0;
  server.maxConnections = MAX_CONNECTIONS;
  server.on('tlsClientError', (_error, socket) => socket.destroy());
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen({ port: config.port, host: config.host, backlog: MAX_CONNECTIONS }, () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(`LISTEN ${address.address}:${address.port}`);
  });
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
