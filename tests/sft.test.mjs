import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CHUNK_BYTES, FrameReader, MAX_PAYLOAD, writeFrame } from '../dist/protocol.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const execNode = promisify(execFile);
let root;
let runtime;
let server;
let port;

function launch(args, timeout = 8000) {
  const child = spawn(process.execPath, args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.stdin.on('error', () => {
    // If a child closes stdin early, its exit status and diagnostics report why.
  });
  const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : undefined;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  void done.then(() => clearTimeout(timer), () => clearTimeout(timer));
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

async function waitForOutput(process, pattern, offset = 0, output = 'stdout') {
  const until = Date.now() + 4000;
  do {
    const match = process[output]().slice(offset).match(pattern);
    if (match) return match;
    if (process.child.exitCode !== null || process.child.signalCode !== null) break;
    await delay(20);
  } while (Date.now() < until);
  assert.fail(`Timed out waiting for ${pattern}.\nstdout: ${process.stdout()}\nstderr: ${process.stderr()}`);
}

function launchClient(name, timeout) {
  return launch(['dist/client.js', join(runtime, `${name}.json`)], timeout);
}

function batchClient(name, commands) {
  const client = launchClient(name);
  client.child.stdin.end(commands.join('\n') + '\n');
  return client.done;
}

function requireSuccess(result) {
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stderr, '');
}

function quoted(path) {
  assert(!path.includes('"'));
  return `"${path}"`;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sft-test-'));
  runtime = join(root, 'runtime');
  await execNode(process.execPath, ['scripts/setup.mjs', runtime], {
    cwd: project, env: { ...process.env, SFT_PORT: '0' }, timeout: 5000,
  });
  server = launch(['dist/server.js', join(runtime, 'server.json')], 0);
  server.child.stdin.end();
  const [, listeningPort] = await waitForOutput(server, /^LISTEN 127\.0\.0\.1:(\d+)$/m);
  port = Number(listeningPort);
  for (const name of ['alice', 'bob']) {
    const file = join(runtime, `${name}.json`);
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.port = port;
    await writeFile(file, JSON.stringify(config));
  }
});

after(async () => {
  try {
    if (server) {
      server.child.kill('SIGTERM');
      const deadline = setTimeout(() => server.child.kill('SIGKILL'), 2000);
      try {
        await server.done;
      } finally {
        clearTimeout(deadline);
      }
    }
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test('frame reader preserves split and coalesced messages', async () => {
  const bytes = [];
  const encoded = new PassThrough();
  encoded.on('data', chunk => bytes.push(chunk));
  const payload = Buffer.from([0, 1, 32, 128, 255]);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const put = { op: 'put', name: 'sample.bin', sha256 };
  const ping = { op: 'ping' };
  await writeFrame(encoded, put, payload);
  await writeFrame(encoded, ping);
  encoded.end();

  const wire = Buffer.concat(bytes);
  assert.equal(wire.toString('ascii', 0, 4), 'SFT1');
  assert.equal(wire.readUInt32BE(4), Buffer.byteLength(JSON.stringify(put)));
  assert.equal(wire.readUInt32BE(8), payload.length);
  const input = new PassThrough();
  const reader = new FrameReader(input);
  const first = reader.read();
  input.write(wire.subarray(0, 2));
  await setImmediate();
  input.write(wire.subarray(2, 16));
  await setImmediate();
  input.end(wire.subarray(16));
  assert.deepEqual(await first, { header: put, payload });
  assert.deepEqual(await reader.read(), { header: ping, payload: Buffer.alloc(0) });
  assert.equal(await reader.read(), null);
});

test('one Alice session lists, uploads and downloads a binary file and quits', async () => {
  const start = server.stdout().length;
  const source = join(root, 'sample input.bin');
  const destination = join(root, 'sample output.bin');
  const payload = Buffer.alloc(70_063);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + 17) & 0xff;
  const sha256 = createHash('sha256').update(payload).digest('hex');
  await writeFile(source, payload);
  const result = await batchClient('alice', [
    'list', `put ${quoted(source)} session.bin`, 'list',
    `get session.bin ${quoted(destination)}`, 'list', 'quit',
  ]);
  requireSuccess(result);
  assert.match(result.stdout, /^CONNECTED TLSv1\.3$/m);
  assert.match(result.stdout, /^LIST 0$/m);
  assert.match(result.stdout, /^session\.bin\t70063$/m);
  assert.match(result.stdout, new RegExp(`^PUT session\\.bin 70063 bytes SHA-256 ${sha256}$`, 'm'));
  assert.match(result.stdout, new RegExp(`^GET session\\.bin 70063 bytes SHA-256 ${sha256}$`, 'm'));
  assert.match(result.stdout, /^BYE$/m);
  assert.deepEqual(await readFile(destination), payload);
  await waitForOutput(server, /^SESSION \d+ END alice$/m, start);
  const logs = server.stdout().slice(start);
  const opened = [...logs.matchAll(/^SESSION (\d+) OPEN alice TLSv1\.3$/gm)];
  assert.equal(opened.length, 1, logs);
  const [, id] = opened[0];
  const actions = [...logs.matchAll(new RegExp(`^SESSION ${id} alice (list|put|get)$`, 'gm'))];
  assert.deepEqual(actions.map(match => match[1]), ['list', 'put', 'list', 'get', 'list']);
});

test('two simultaneous accounts get separate files with the same name', async t => {
  const start = server.stdout().length;
  const aliceFile = join(root, 'alice-input.bin');
  const bobFile = join(root, 'bob-input.bin');
  const aliceOut = join(root, 'alice-output.bin');
  const bobOut = join(root, 'bob-output.bin');
  const aliceBytes = Buffer.from('alice-only');
  const bobBytes = Buffer.from('bob-only');
  await Promise.all([writeFile(aliceFile, aliceBytes), writeFile(bobFile, bobBytes)]);

  const alice = launchClient('alice');
  const bob = launchClient('bob');
  t.after(async () => {
    alice.child.kill('SIGTERM');
    bob.child.kill('SIGTERM');
    await Promise.allSettled([alice.done, bob.done]);
  });
  await Promise.all([
    waitForOutput(alice, /^CONNECTED TLSv1\.3$/m),
    waitForOutput(bob, /^CONNECTED TLSv1\.3$/m),
  ]);
  alice.child.stdin.write(`put ${quoted(aliceFile)} shared.bin\n`);
  await waitForOutput(alice, /^PUT shared\.bin /m);
  bob.child.stdin.write('list\n');
  await waitForOutput(bob, /^LIST 0$/m);
  bob.child.stdin.write(`put ${quoted(bobFile)} shared.bin\n`);
  await waitForOutput(bob, /^PUT shared\.bin /m);
  alice.child.stdin.end(`get shared.bin ${quoted(aliceOut)}\nquit\n`);
  bob.child.stdin.end(`get shared.bin ${quoted(bobOut)}\nquit\n`);
  const results = await Promise.all([alice.done, bob.done]);
  results.forEach(requireSuccess);
  assert.deepEqual(await readFile(aliceOut), aliceBytes);
  assert.deepEqual(await readFile(bobOut), bobBytes);

  await Promise.all([
    waitForOutput(server, /^SESSION \d+ END alice$/m, start),
    waitForOutput(server, /^SESSION \d+ END bob$/m, start),
  ]);
  const events = [...server.stdout().slice(start).matchAll(/^SESSION \d+ (OPEN|END) (alice|bob)/gm)];
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(match => match[1]), ['OPEN', 'OPEN', 'END', 'END']);
  assert.deepEqual(events.slice(0, 2).map(match => match[2]).sort(), ['alice', 'bob']);
});

test('wrong server hostname and missing client certificate cannot use the service', async () => {
  const start = server.stdout().length;
  const config = JSON.parse(await readFile(join(runtime, 'alice.json'), 'utf8'));
  await writeFile(join(runtime, 'wrong-host.json'), JSON.stringify({
    ...config, servername: 'not-localhost.invalid',
  }));
  const wrongHost = await batchClient('wrong-host', ['list', 'quit']);
  assert.equal(wrongHost.code, 1, JSON.stringify(wrongHost));
  assert.match(wrongHost.stderr, /hostname|altnames|certificate/i);
  assert.doesNotMatch(wrongHost.stdout, /^LIST /m);

  const ca = await readFile(join(runtime, config.ca));
  const missingCert = connect({
    host: '127.0.0.1', port, servername: 'localhost', ca, minVersion: 'TLSv1.3', rejectUnauthorized: true,
  });
  let error;
  let received = 0;
  missingCert.on('error', failure => { error = failure; });
  missingCert.on('data', data => { received += data.length; });
  missingCert.once('secureConnect', () => {
    void writeFrame(missingCert, { op: 'list' }).catch(() => {});
  });
  const closed = new Promise(resolve => missingCert.once('close', resolve));
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    missingCert.destroy();
  }, 3000);
  try {
    await closed;
  } finally {
    clearTimeout(deadline);
    missingCert.destroy();
  }
  assert.equal(timedOut, false);
  assert.equal(received, 0);
  if (error) assert.match(error.message, /certificate|handshake|socket|reset/i);
  assert.doesNotMatch(server.stdout().slice(start), /^SESSION \d+ OPEN /m);
});

test('server and client refuse overwrites and preserve both original files', async () => {
  const original = join(root, 'first.bin');
  const replacement = join(root, 'replacement.bin');
  const occupied = join(root, 'occupied.bin');
  const downloaded = join(root, 'downloaded.bin');
  const first = Buffer.from('first upload');
  const local = Buffer.from('existing local data');
  await Promise.all([
    writeFile(original, first),
    writeFile(replacement, 'replacement'),
    writeFile(occupied, local),
  ]);
  const result = await batchClient('bob', [
    `put ${quoted(original)} fixed.bin`,
    `put ${quoted(replacement)} fixed.bin`,
    `get fixed.bin ${quoted(occupied)}`,
    `get fixed.bin ${quoted(downloaded)}`, 'quit',
  ]);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stderr, /^ERROR File already exists$/m);
  assert.match(result.stderr, /^ERROR .*EEXIST/m);
  assert.match(result.stdout, /^BYE$/m);
  assert.deepEqual(await readFile(occupied), local);
  assert.deepEqual(await readFile(downloaded), first);
  assert.deepEqual(await readFile(join(runtime, 'storage', 'bob', 'fixed.bin')), first);
  assert((await readdir(root)).every(name => !name.endsWith('.part')));
});

async function peerOptions(name, certificateDir = runtime) {
  const config = JSON.parse(await readFile(join(certificateDir, `${name}.json`), 'utf8'));
  const [ca, cert, key] = await Promise.all([
    readFile(join(runtime, config.ca)),
    readFile(join(certificateDir, config.cert)),
    readFile(join(certificateDir, config.key)),
  ]);
  return {
    host: '127.0.0.1', port, servername: 'localhost', ca, cert, key,
    minVersion: 'TLSv1.3', rejectUnauthorized: true,
  };
}

function waitForClose(socket, timeout = 3000) {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Socket did not close within ${timeout} ms`));
    }, timeout);
    socket.once('close', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

async function openPeer(t, name, options = {}) {
  const socket = connect({ ...await peerOptions(name), ...options });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect', { signal: AbortSignal.timeout(3000) });
  return { socket, reader: new FrameReader(socket) };
}

async function exchange(peer, header, payload) {
  await writeFrame(peer.socket, header, payload);
  const frame = await peer.reader.read();
  assert(frame, `No response to ${header.op}`);
  assert.equal(frame.header.op, header.op);
  return frame;
}

async function quitPeer(peer) {
  assert.equal((await exchange(peer, { op: 'quit' })).header.status, 'ok');
  const closed = waitForClose(peer.socket);
  peer.socket.end();
  await closed;
}

async function requireRejectedPeer(options) {
  const socket = connect(options);
  let received = 0;
  socket.on('error', () => {});
  socket.on('data', data => { received += data.length; });
  socket.once('secureConnect', () => {
    void writeFrame(socket, { op: 'list' }).catch(() => {});
  });
  try {
    await waitForClose(socket);
    assert.equal(received, 0);
  } finally {
    socket.destroy();
  }
}

test('resumable upload survives server restart and a ranged download survives reconnection', {
  timeout: 10000,
}, async t => {
  const config = JSON.parse(await readFile(join(runtime, 'server.json'), 'utf8'));
  config.dataDir = 'restart-storage';
  config.users = { alice: config.users.alice };
  const directory = join(runtime, config.dataDir);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'alice'), { mode: 0o700 });
  const configPath = join(runtime, 'restart-server.json');
  await writeFile(configPath, JSON.stringify(config));
  const startServer = async () => {
    const child = launch(['dist/server.js', configPath], 0);
    child.child.stdin.end();
    t.after(async () => { child.child.kill('SIGTERM'); await child.done; });
    const [, listen] = await waitForOutput(child, /^LISTEN 127\.0\.0\.1:(\d+)$/m);
    return { child, port: Number(listen) };
  };

  const payload = Buffer.alloc(CHUNK_BYTES + 91).fill(Buffer.from([0, 128, 255, 31]));
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const file = { name: 'resume.bin', sha256 };
  const begin = { op: 'put-begin', ...file, bytes: payload.length };
  const chunk = { op: 'put-chunk', ...file };
  const finish = { op: 'put-finish', ...file };
  const first = await startServer();
  const interrupted = await openPeer(t, 'alice', { port: first.port });
  assert.deepEqual((await exchange(interrupted, begin)).header, { ...begin, status: 'ok', offset: 0, complete: false });
  assert.equal((await exchange(interrupted, { ...chunk, offset: 0 }, payload.subarray(0, CHUNK_BYTES))).header.offset, CHUNK_BYTES);
  assert.deepEqual((await exchange(interrupted, { op: 'list' })).header.files, []);
  const overlapping = await exchange(interrupted, { ...chunk, offset: 0 }, Buffer.from([1]));
  assert.equal(overlapping.header.message, 'Upload offset does not match');
  assert.equal((await exchange(interrupted, finish)).header.message, 'Upload is incomplete');
  first.child.child.kill('SIGTERM');
  await first.child.done;
  interrupted.socket.destroy();

  const restarted = await startServer();
  const resumed = await openPeer(t, 'alice', { port: restarted.port });
  const checkpoint = await exchange(resumed, begin);
  assert.equal(checkpoint.header.offset, CHUNK_BYTES);
  assert.equal(checkpoint.header.complete, false);
  assert.equal((await exchange(resumed, { ...chunk, offset: CHUNK_BYTES }, payload.subarray(CHUNK_BYTES))).header.offset, payload.length);
  assert.deepEqual((await exchange(resumed, finish)).header, { ...finish, status: 'ok', bytes: payload.length });
  assert.deepEqual((await exchange(resumed, begin)).header, { ...begin, status: 'ok', offset: payload.length, complete: true });
  assert.equal((await exchange(resumed, { ...begin, sha256: '0'.repeat(64) })).header.message, 'File already exists');
  const info = await exchange(resumed, { op: 'get-info', name: file.name });
  assert.deepEqual(info.header, { op: 'get-info', ...file, status: 'ok', bytes: payload.length });
  const part1 = await exchange(resumed, { op: 'get-chunk', ...file, offset: 0, bytes: CHUNK_BYTES });
  await quitPeer(resumed);

  const download = await openPeer(t, 'alice', { port: restarted.port });
  const changed = await exchange(download, { op: 'get-chunk', ...file, sha256: '0'.repeat(64), offset: CHUNK_BYTES, bytes: 91 });
  assert.equal(changed.header.message, 'File changed since download began');
  const part2 = await exchange(download, { op: 'get-chunk', ...file, offset: CHUNK_BYTES, bytes: 91 });
  assert.equal(part2.header.offset, CHUNK_BYTES);
  assert.deepEqual(Buffer.concat([part1.payload, part2.payload]), payload);
  assert.deepEqual(await readFile(join(directory, 'alice', file.name)), payload);
  await quitPeer(download);
});

test('resumable upload discards incorrect content and accepts a zero-byte file', {
  timeout: 8000,
}, async t => {
  const peer = await openPeer(t, 'alice');
  const name = 'failed-checkpoint.bin';
  const payload = Buffer.from([1, 2, 3]);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const file = { name, sha256 };
  assert.equal((await exchange(peer, { op: 'put-begin', ...file, bytes: payload.length })).header.offset, 0);
  assert.equal((await exchange(peer, { op: 'put-chunk', ...file, offset: 0 }, Buffer.from([4, 5, 6]))).header.status, 'ok');
  assert.equal((await exchange(peer, { op: 'put-finish', ...file })).header.message, 'File digest mismatch');
  assert.equal((await exchange(peer, { op: 'get-info', name })).header.message, 'File is unavailable');
  const empty = { name, sha256: createHash('sha256').digest('hex') };
  assert.equal((await exchange(peer, { op: 'put-begin', ...empty, bytes: 0 })).header.offset, 0);
  assert.equal((await exchange(peer, { op: 'put-finish', ...empty })).header.bytes, 0);
  assert.equal((await exchange(peer, { op: 'get-info', name })).header.sha256, empty.sha256);
  await quitPeer(peer);
});

test('CLI round trips zero bytes and exactly 8 MiB, rejecting a local file one byte larger', async () => {
  const empty = join(root, 'empty.input');
  const maximum = join(root, 'maximum.input');
  const oversized = join(root, 'oversized.input');
  const emptyOutput = join(root, 'empty.output');
  const maximumOutput = join(root, 'maximum.output');
  const data = Buffer.alloc(MAX_PAYLOAD).fill(Buffer.from([0, 129, 255, 4]));
  await Promise.all([
    writeFile(empty, Buffer.alloc(0)), writeFile(maximum, data),
    writeFile(oversized, Buffer.alloc(MAX_PAYLOAD + 1)),
  ]);
  const result = await batchClient('alice', [
    `put ${quoted(empty)} empty.bin`, `get empty.bin ${quoted(emptyOutput)}`,
    `put ${quoted(maximum)} maximum.bin`, `get maximum.bin ${quoted(maximumOutput)}`,
    `put ${quoted(oversized)} oversized.bin`, 'list', 'quit',
  ]);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stdout, /^PUT empty\.bin 0 bytes SHA-256 [a-f0-9]{64}$/m);
  assert.match(result.stdout, /^GET maximum\.bin 8388608 bytes SHA-256 [a-f0-9]{64}$/m);
  assert.doesNotMatch(result.stdout, /oversized\.bin/);
  assert.match(result.stdout, /^BYE$/m);
  assert.match(result.stderr, /at most 8 MiB/);
  assert.deepEqual(await readFile(emptyOutput), Buffer.alloc(0));
  assert.deepEqual(await readFile(maximumOutput), data);
});

test('digest mismatch and illegal names produce errors without writing files', { timeout: 6000 }, async t => {
  const directory = join(runtime, 'storage', 'alice');
  const previous = (await readdir(directory)).sort();
  const peer = await openPeer(t, 'alice');
  const payload = Buffer.from('contents');
  const bad = await exchange(peer, { op: 'put', name: 'mismatch.bin', sha256: '0'.repeat(64) }, payload);
  assert.deepEqual(bad.header, { op: 'put', status: 'error', message: 'File digest mismatch' });
  const illegal = await exchange(peer, { op: 'put', name: '../outside.bin' }, payload);
  assert.deepEqual(illegal.header, { op: 'put', status: 'error', message: 'Invalid file name' });
  assert.deepEqual((await readdir(directory)).sort(), previous);
  await quitPeer(peer);
});

test('missing file, unknown operation and inappropriate payload recover on the same session', {
  timeout: 6000,
}, async t => {
  const peer = await openPeer(t, 'alice');
  const cases = [
    [{ op: 'get', name: 'absent.bin' }, undefined, 'File is unavailable'],
    [{ op: 'unexpected' }, undefined, 'Unknown operation'],
    [{ op: 'list' }, Buffer.from('ordinary data'), 'Unexpected file payload'],
  ];
  for (const [header, payload, message] of cases) {
    const response = await exchange(peer, header, payload);
    assert.deepEqual(response.header, { op: header.op, status: 'error', message });
    assert.equal(response.payload.length, 0);
  }
  assert.equal((await exchange(peer, { op: 'ping' })).header.status, 'ok');
  assert.equal((await exchange(peer, { op: 'list' })).header.status, 'ok');
  await quitPeer(peer);
});

test('directory entries that are symbolic links cannot be listed, read or overwritten', {
  timeout: 6000,
}, async t => {
  const outside = join(root, 'outside-data.txt');
  const alias = join(runtime, 'storage', 'alice', 'alias.txt');
  const contents = Buffer.from('outside the managed directory');
  await writeFile(outside, contents);
  try {
    await symlink(outside, alias);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Creating test symlinks requires local Windows privileges');
      return;
    }
    throw error;
  }
  t.after(() => rm(alias, { force: true }));

  const peer = await openPeer(t, 'alice');
  const listed = await exchange(peer, { op: 'list' });
  assert(!listed.header.files.some(file => file.name === 'alias.txt'));
  const downloaded = await exchange(peer, { op: 'get', name: 'alias.txt' });
  assert.deepEqual(downloaded.header, { op: 'get', status: 'error', message: 'File is unavailable' });
  assert.equal(downloaded.payload.length, 0);
  const replacement = Buffer.from('replacement');
  const sha256 = createHash('sha256').update(replacement).digest('hex');
  const uploaded = await exchange(peer, { op: 'put', name: 'alias.txt', sha256 }, replacement);
  assert.deepEqual(uploaded.header, { op: 'put', status: 'error', message: 'File already exists' });
  assert.deepEqual(await readFile(outside), contents);
  await quitPeer(peer);
});

test('a second session with the same client certificate is rejected without disrupting the first', {
  timeout: 6000,
}, async t => {
  const start = server.stdout().length;
  const peer = await openPeer(t, 'alice');
  assert.equal((await exchange(peer, { op: 'ping' })).header.status, 'ok');
  await requireRejectedPeer(await peerOptions('alice'));
  assert.equal((await exchange(peer, { op: 'ping' })).header.status, 'ok');
  await quitPeer(peer);
  await waitForOutput(server, /^SESSION \d+ END alice$/m, start);
  assert.equal([...server.stdout().slice(start).matchAll(/^SESSION \d+ OPEN alice /gm)].length, 1);
});

test('a certificate issued by another local CA grants no application access', { timeout: 6000 }, async () => {
  const alternate = join(root, 'other-ca');
  await execNode(process.execPath, ['scripts/setup.mjs', alternate], {
    cwd: project, env: { ...process.env, SFT_PORT: '0' }, timeout: 5000,
  });
  const start = server.stdout().length;
  await requireRejectedPeer(await peerOptions('alice', alternate));
  assert.doesNotMatch(server.stdout().slice(start), /^SESSION \d+ OPEN /m);
});

test('a valid TLS client certificate outside the server account map is refused', { timeout: 8000 }, async t => {
  const config = JSON.parse(await readFile(join(runtime, 'server.json'), 'utf8'));
  delete config.users.bob;
  const file = join(runtime, 'single-account.json');
  await writeFile(file, JSON.stringify(config));
  const filtered = launch(['dist/server.js', file]);
  filtered.child.stdin.end();
  t.after(async () => {
    filtered.child.kill('SIGTERM');
    await filtered.done;
  });
  const [, listeningPort] = await waitForOutput(filtered, /^LISTEN 127\.0\.0\.1:(\d+)$/m);
  await requireRejectedPeer({ ...await peerOptions('bob'), port: Number(listeningPort) });
  assert.doesNotMatch(filtered.stdout(), /^SESSION \d+ OPEN /m);
});

test('server startup validates account name, fingerprint uniqueness and private storage', async () => {
  const config = JSON.parse(await readFile(join(runtime, 'server.json'), 'utf8'));
  const { alice } = config.users;
  const publicDirectory = join(runtime, 'storage', 'public');
  await mkdir(publicDirectory, { mode: 0o755 });
  const cases = [
    ['empty', {}, /Configure at least one client certificate/],
    ['invalid-name', { Alice: alice }, /Invalid account configuration/],
    ['invalid-fingerprint', { alice: 'invalid' }, /Invalid account configuration/],
    ['duplicate', { alice, bob: alice }, /Invalid account configuration/],
  ];
  if (process.platform !== 'win32') {
    await chmod(publicDirectory, 0o755);
    cases.push(['public-directory', { public: alice }, /Storage must be a private directory/]);
  }
  for (const [name, users, expected] of cases) {
    const file = join(runtime, `invalid-${name}.json`);
    await writeFile(file, JSON.stringify({ ...config, users }));
    const invalid = launch(['dist/server.js', file], 2000);
    invalid.child.stdin.end();
    const result = await invalid.done;
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /^LISTEN /m);
  }
});

test('seventeenth stored file is refused and account quota remains sixteen', { timeout: 6000 }, async t => {
  const peer = await openPeer(t, 'bob');
  const payload = Buffer.alloc(0);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const initial = (await exchange(peer, { op: 'list' })).header.files;
  for (let index = initial.length; index < 16; index++) {
    const name = `quota-${index}.bin`;
    const stored = await exchange(peer, { op: 'put', name, sha256 }, payload);
    assert.equal(stored.header.status, 'ok', JSON.stringify(stored.header));
    t.after(() => rm(join(runtime, 'storage', 'bob', name), { force: true }));
  }
  const excess = await exchange(peer, { op: 'put', name: 'quota-excess.bin', sha256 }, payload);
  assert.deepEqual(excess.header, { op: 'put', status: 'error', message: 'Storage is full' });
  assert.equal((await exchange(peer, { op: 'list' })).header.files.length, 16);
  await quitPeer(peer);
});

test('disconnect during a valid upload leaves no partial file and releases the session', {
  timeout: 8000,
}, async t => {
  const start = server.stdout().length;
  const directory = join(runtime, 'storage', 'alice');
  const previous = (await readdir(directory)).sort();
  const peer = await openPeer(t, 'alice');
  const payload = Buffer.from('partial upload fixture');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const recorded = [];
  const stream = new PassThrough();
  stream.on('data', chunk => recorded.push(chunk));
  await writeFrame(stream, { op: 'put', name: 'interrupted.bin', sha256 }, payload);
  stream.end();
  const wire = Buffer.concat(recorded);
  const closed = waitForClose(peer.socket);
  peer.socket.end(wire.subarray(0, wire.length - 5));
  await closed;
  await waitForOutput(server, /^SESSION \d+ END alice$/m, start);
  assert.deepEqual((await readdir(directory)).sort(), previous);
  requireSuccess(await batchClient('alice', ['list', 'quit']));
});

test('120 ordinary operations are allowed in a session and the next reaches the budget', {
  timeout: 8000,
}, async t => {
  const start = server.stdout().length;
  const peer = await openPeer(t, 'alice');
  for (let request = 0; request < 120; request++) {
    assert.equal((await exchange(peer, { op: 'ping' })).header.status, 'ok');
  }
  const closed = waitForClose(peer.socket);
  await writeFrame(peer.socket, { op: 'ping' });
  await closed;
  await waitForOutput(server, /^SESSION \d+ END alice$/m, start);
  await waitForOutput(server, /Session request limit exceeded/, 0, 'stderr');
  requireSuccess(await batchClient('alice', ['list', 'quit']));
});

test('connection cap refuses the thirteenth socket and releases capacity after close', {
  timeout: 6000,
}, async t => {
  const quiet = [];
  try {
    for (let index = 0; index < 12; index++) {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.on('error', () => {});
      quiet.push(socket);
      await once(socket, 'connect', { signal: AbortSignal.timeout(2000) });
    }
    const excess = createConnection({ host: '127.0.0.1', port });
    excess.on('error', () => {});
    try {
      await waitForClose(excess, 2000);
      assert(quiet.every(socket => !socket.closed));
    } finally {
      excess.destroy();
    }
  } finally {
    const closed = quiet.map(socket => waitForClose(socket));
    quiet.forEach(socket => socket.end());
    await Promise.all(closed);
  }
  const restored = await openPeer(t, 'alice');
  assert.equal((await exchange(restored, { op: 'ping' })).header.status, 'ok');
  await quitPeer(restored);
});

test('real-time deadlines expire incomplete peers while heartbeat preserves a healthy session', {
  timeout: 54000,
}, async t => {
  const bob = launchClient('bob', 52000);
  t.after(async () => {
    bob.child.kill('SIGTERM');
    await bob.done;
  });
  await waitForOutput(bob, /^CONNECTED TLSv1\.3$/m);
  const bobIdleStarted = performance.now();
  const errorsBefore = server.stderr().length;

  const handshakeStarted = performance.now();
  const noHandshake = createConnection({ host: '127.0.0.1', port });
  noHandshake.on('error', () => {});
  t.after(() => noHandshake.destroy());
  const handshakeClosed = waitForClose(noHandshake, 8000).then(() => performance.now() - handshakeStarted);

  const alice = await openPeer(t, 'alice');
  assert.equal((await exchange(alice, { op: 'ping' })).header.status, 'ok');
  const frameStarted = performance.now();
  const requestClosed = waitForClose(alice.socket, 49000).then(() => performance.now() - frameStarted);
  alice.socket.write(Buffer.from('SFT'));
  const [handshakeMs, requestMs] = await Promise.all([handshakeClosed, requestClosed]);
  assert(handshakeMs >= 4600, `Handshake closed after ${handshakeMs} ms`);
  assert(requestMs >= 44800, `Incomplete frame closed after ${requestMs} ms`);
  await waitForOutput(server, /Request deadline exceeded/, errorsBefore, 'stderr');
  await delay(Math.max(0, 45100 - (performance.now() - bobIdleStarted)));

  bob.child.stdin.end('list\nquit\n');
  const result = await bob.done;
  requireSuccess(result);
  assert.match(result.stdout, /^LIST \d+$/m);
  assert.match(result.stdout, /^BYE$/m);
  t.diagnostic(`TLS handshake expired in ${Math.round(handshakeMs)} ms, incomplete frame expired in ${Math.round(requestMs)} ms.`);
});
