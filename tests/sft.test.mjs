import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FrameReader, writeFrame } from '../dist/protocol.js';

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

async function waitForOutput(process, pattern, offset = 0) {
  const until = Date.now() + 4000;
  do {
    const match = process.stdout().slice(offset).match(pattern);
    if (match) return match;
    if (process.child.exitCode !== null || process.child.signalCode !== null) break;
    await delay(20);
  } while (Date.now() < until);
  assert.fail(`Timed out waiting for ${pattern}.\nstdout: ${process.stdout()}\nstderr: ${process.stderr()}`);
}

function launchClient(name) {
  return launch(['dist/client.js', join(runtime, `${name}.json`)]);
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
