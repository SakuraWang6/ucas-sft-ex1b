import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { digest, MAX_PAYLOAD, validName } from './protocol.js';

import { connectClient, Session, closeSocket } from './session.js';
const PING_INTERVAL_MS = 15_000;

function parseCommand(line: string): string[] {
  const text = line.trim();
  if (!text) {
    return [];
  }
  if (!/^(?:"[^"]*"|[^\s"]+)(?:\s+(?:"[^"]*"|[^\s"]+))*$/.test(text)) {
    throw new Error('Use double quotes around arguments that contain spaces.');
  }
  return (text.match(/"[^"]*"|[^\s"]+/g) ?? []).map(token => (
    token.startsWith('"') ? token.slice(1, -1) : token
  ));
}

async function readUpload(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size > MAX_PAYLOAD) {
      throw new Error('Choose a regular file of at most 8 MiB.');
    }
    const data = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error('The local file changed while it was being read.');
      }
      offset += bytesRead;
    }
    const latest = await file.stat();
    if (latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs) {
      throw new Error('The local file changed while it was being read.');
    }
    return data;
  } finally {
    await file.close();
  }
}

async function saveDownload(path: string, data: Buffer): Promise<void> {
  const target = resolve(path);
  const temporary = join(dirname(target), `.sft-${randomUUID()}.part`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}

async function execute(session: Session, [op, first, second, ...extra]: string[]): Promise<boolean> {
  if (!op) {
    return false;
  }
  if (op === 'quit' && first === undefined) {
    return true;
  }
  if (op === 'list' && first === undefined) {
    const { header } = await session.exchange(op);
    if (!Array.isArray(header.files)) {
      throw new Error('Invalid file list.');
    }
    const rows = header.files.map((file: unknown) => {
      if (!file || typeof file !== 'object' || !('name' in file) || !('bytes' in file)) {
        throw new Error('Invalid file list entry.');
      }
      const { name, bytes } = file;
      if (!validName(name) || typeof bytes !== 'number' ||
          !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_PAYLOAD) {
        throw new Error('Invalid file list entry.');
      }
      return `${name}\t${bytes}`;
    });
    console.log([`LIST ${rows.length}`, ...rows].join('\n'));
    return false;
  }
  if (op === 'put' && first && extra.length === 0) {
    const name = second ?? basename(first);
    if (!validName(name)) {
      throw new Error('Choose a valid remote filename.');
    }
    const data = await readUpload(first);
    const sha256 = digest(data);
    const { header } = await session.exchange(op, { name, sha256 }, data);
    if (header.name !== name || header.bytes !== data.length || header.sha256 !== sha256) {
      throw new Error('The upload acknowledgement did not match the file.');
    }
    console.log(`PUT ${name} ${data.length} bytes SHA-256 ${sha256}`);
    return false;
  }
  if (op === 'get' && validName(first) && second !== '' && extra.length === 0) {
    const { header, payload } = await session.exchange(op, { name: first });
    const sha256 = digest(payload);
    if (header.name !== first || header.bytes !== payload.length || header.sha256 !== sha256) {
      throw new Error('Download metadata or SHA-256 did not match the file.');
    }
    await saveDownload(second ?? first, payload);
    console.log(`GET ${first} ${payload.length} bytes SHA-256 ${sha256}`);
    return false;
  }
  throw new Error('Commands: list | put <local-file> [name] | get <name> [local-file] | quit');
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR ${message.replace(/[\x00-\x1f\x7f]/g, ' ')}`);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node dist/client.js <client.json>');
  }

  const socket = await connectClient(process.argv[2]);
  socket.on('error', () => {
    // Pending requests and the close event report the failure.
  });
  const session = new Session(socket);
  // In TLS 1.3 the client handshake event can precede server-side identity acceptance.
  await session.exchange('ping');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    prompt: 'sft> ',
    crlfDelay: Infinity,
  });
  let closing = false;
  let busy = false;
  let pingPending = false;
  input.on('SIGINT', () => input.close());
  socket.once('close', () => {
    if (!closing) {
      process.exitCode = 1;
      reportError('The server connection closed.');
      input.close();
    }
  });

  const pings = setInterval(() => {
    if (!busy && !closing && !pingPending) {
      pingPending = true;
      session.exchange('ping').catch(error => {
        reportError(error);
        socket.destroy();
      }).finally(() => {
        pingPending = false;
      });
    }
  }, PING_INTERVAL_MS);
  console.log(`CONNECTED ${socket.getProtocol()}`);
  if (interactive) {
    console.log('Commands: list | put <local-file> [name] | get <name> [local-file] | quit');
    input.prompt();
  }

  try {
    for await (const line of input) {
      if (socket.destroyed) {
        break;
      }
      busy = true;
      try {
        if (await execute(session, parseCommand(line))) {
          break;
        }
      } catch (error) {
        reportError(error);
        if (!interactive) {
          process.exitCode = 1;
        }
      } finally {
        busy = false;
      }
      if (interactive) {
        input.prompt();
      }
    }
    closing = true;
    if (!socket.destroyed) {
      await session.exchange('quit');
      console.log('BYE');
      await closeSocket(socket);
    }
  } finally {
    closing = true;
    clearInterval(pings);
    input.close();
    socket.destroy();
  }
}

main().catch(error => {
  reportError(error);
  process.exitCode = 1;
});
