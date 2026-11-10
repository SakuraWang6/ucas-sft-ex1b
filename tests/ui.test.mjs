import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CHUNK_BYTES, FrameReader, MAX_PAYLOAD } from '../dist/protocol.js';

import { connectClient, Session, closeSocket } from '../dist/session.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const execNode = promisify(execFile);
const children = [];
const bootstrapLine = /^UI (http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]{64})$/m;
let root;
let runtime;
let origin;
let token;
let server;

function launch(script, config, env = {}) {
  const child = spawn(process.execPath, [script, config], {
    cwd: project,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = { child, stdout: '', stderr: '', closed: false };
  child.stdout.setEncoding('utf8').on('data', data => { result.stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { result.stderr += data; });
  child.once('error', error => { result.stderr += error.message; });
  result.done = new Promise(resolve => child.once('close', (code, signal) => {
    result.closed = true;
    resolve({ code, signal });
  }));
  children.push(result);
  return result;
}

async function waitForOutput(program, pattern, offset = 0) {
  const deadline = Date.now() + 5000;
  do {
    const match = program.stdout.slice(offset).match(pattern);
    if (match) return match;
    if (program.closed) break;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Expected ${pattern} in process output.\n${program.stdout}\n${program.stderr}`);
}

function request(path, options = {}) {
  return fetch(origin + path, { signal: AbortSignal.timeout(5000), ...options });
}

function api(path, { headers = {}, ...options } = {}) {
  return request('/api/' + path, { ...options, headers: { 'x-sft-token': token, ...headers } });
}

async function apiJson(path, options, status = 200) {
  const response = await api(path, options);
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

function put(name, body, status) {
  return apiJson(`upload?name=${encodeURIComponent(name)}`, { method: 'POST', body }, status);
}

function session(action) {
  return apiJson(action, { method: 'POST' });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sft-ui-test-'));
  runtime = join(root, 'runtime');
  await execNode(process.execPath, ['scripts/setup.mjs', runtime], {
    cwd: project, env: { ...process.env, SFT_PORT: '0' }, timeout: 5000,
  });
  server = launch('dist/server.js', join(runtime, 'server.json'));
  const [, port] = await waitForOutput(server, /^LISTEN 127\.0\.0\.1:(\d+)$/m);
  const configFile = join(runtime, 'alice.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.port = Number(port);
  await writeFile(configFile, JSON.stringify(config));

  const ui = launch('dist/ui.js', configFile, { SFT_UI_PORT: '0' });
  [, origin, token] = await waitForOutput(ui, bootstrapLine);
});

after(async () => {
  try {
    await Promise.all(children.map(async ({ child, done }) => {
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await done;
      } finally {
        clearTimeout(deadline);
      }
    }));
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test('local UI serves its page and assets with restrictive response headers', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const contents = await response.text();
    assert.ok(contents.length > 0);
    assert.ok(!contents.includes(token), `Unexpected bootstrap token in ${path}`);
    assert.ok(![...response.headers.values()].some(value => value.includes(token)));
  }
});

test('local API requires the terminal bootstrap token and rejects unrelated browser origins and hosts', async () => {
  for (const [label, headers] of [
    ['missing token', {}],
    ['invalid token', { 'x-sft-token': 'invalid-token' }],
    ['unrelated origin', { 'x-sft-token': token, origin: 'http://example.invalid' }],
    ['cross-site browser request', { 'x-sft-token': token, 'sec-fetch-site': 'cross-site' }],
  ]) {
    const response = await request('/api/status', { headers });
    assert.equal(response.status, 403, label);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const queryToken = await request('/api/status?token=' + token);
  assert.equal(queryToken.status, 403);
  assert.ok(!(await queryToken.text()).includes(token));
  // Node's Fetch normalizes Host. Use the HTTP client to preserve the supplied value.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = get(origin + '/api/status', {
      headers: { host: 'localhost', 'x-sft-token': token },
      signal: AbortSignal.timeout(5000),
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.once('error', reject);
  });
  assert.equal(hostStatus, 403, 'unrelated host');
  const status = await apiJson('status', { headers: { origin } });
  assert.equal(status.user, 'alice');
});

test('browser API can connect, disconnect and reconnect as the configured account', async () => {
  const start = server.stdout.length;
  assert.equal((await apiJson('status')).connected, false);
  await apiJson('files', {}, 503);
  for (let index = 0; index < 2; index++) {
    const sessionStart = server.stdout.length;
    assert.deepEqual(await session('connect'), { ok: true });
    try {
      const status = await apiJson('status');
      assert.equal(status.connected, true);
      assert.equal(status.user, 'alice');
      assert.equal(status.protocol, 'TLSv1.3');
      assert.equal(status.maxBytes, MAX_PAYLOAD);
    } finally {
      assert.deepEqual(await session('disconnect'), { ok: true });
    }
    assert.equal((await apiJson('status')).connected, false);
    await waitForOutput(server, /^SESSION \d+ END alice$/m, sessionStart);
  }
  const opened = [...server.stdout.slice(start).matchAll(/^SESSION (\d+) OPEN alice TLSv1\.3$/gm)];
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0][1], opened[1][1]);
});

test('browser API lists, uploads and downloads verified bytes on a single TLS session', async () => {
  const start = server.stdout.length;
  const name = 'ui-roundtrip.bin';
  const bytes = Buffer.from([0, 1, 2, 10, 127, 128, 254, 255]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await session('connect');
  try {
    const initial = (await apiJson('files')).files;
    assert.ok(!initial.some(file => file.name === name));
    assert.deepEqual(await put(name, bytes), { name, bytes: bytes.length, sha256 });
    const updated = (await apiJson('files')).files;
    assert.deepEqual(updated.find(file => file.name === name), { name, bytes: bytes.length });
    const download = await api(`download?name=${name}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-length'), String(bytes.length));
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${name}"`);
    assert.equal(download.headers.get('x-sft-sha256'), sha256);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  } finally {
    await session('disconnect');
  }
  const [, id] = await waitForOutput(server, /^SESSION (\d+) END alice$/m, start);
  const logs = server.stdout.slice(start);
  assert.deepEqual([...logs.matchAll(/^SESSION (\d+) OPEN alice TLSv1\.3$/gm)].map(match => match[1]), [id]);
  const actions = [...logs.matchAll(new RegExp(`^SESSION ${id} alice (list|put|get)$`, 'gm'))];
  assert.deepEqual(actions.map(match => match[1]), ['list', 'put', 'list', 'get']);
});

test('browser API rejects duplicate, missing, invalid-name and oversized file operations', async () => {
  const original = Buffer.from('original UI file');
  const name = 'ui-existing.bin';
  await session('connect');
  try {
    await put(name, original);
    assert.match((await put(name, Buffer.from('replacement'), 400)).error, /already exists/i);
    assert.equal(typeof (await apiJson('download?name=unavailable.bin', {}, 400)).error, 'string');
    assert.equal(typeof (await put('invalid name.bin', original, 400)).error, 'string');
    assert.equal(typeof (await put('too-large.bin', Buffer.alloc(MAX_PAYLOAD + 1), 413)).error, 'string');
    const download = await api(`download?name=${name}`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    const { files } = await apiJson('files');
    assert.ok(!files.some(file => file.name === 'too-large.bin' || file.name === 'invalid name.bin'));
  } finally {
    await session('disconnect');
  }
});

test('browser adapter resumes a staged upload and verifies the downloaded file', async () => {
  const name = 'ui-resume.bin';
  const data = Buffer.alloc(CHUNK_BYTES + 9, 127);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const socket = await connectClient(join(runtime, 'alice.json'));
  try {
    const direct = new Session(socket);
    await direct.exchange('put-begin', { name, bytes: data.length, sha256 });
    await direct.exchange('put-chunk', { name, offset: 0, sha256 }, data.subarray(0, CHUNK_BYTES));
    await direct.exchange('quit');
    await closeSocket(socket);
  } finally {
    socket.destroy();
  }
  await session('connect');
  try {
    const reply = await apiJson(`upload-resume?name=${name}`, { method: 'POST', body: data });
    assert.deepEqual(reply, { name, bytes: data.length, sha256, resumedAt: CHUNK_BYTES });
    const received = await api(`download-resume?name=${name}`);
    assert.equal(received.status, 200);
    assert.equal(received.headers.get('x-sft-sha256'), sha256);
    assert.deepEqual(Buffer.from(await received.arrayBuffer()), data);
  } finally {
    await session('disconnect');
  }
});

for (const stage of ['TLS handshake', 'application authorization ping']) {
  test(`bridge shutdown closes an in-flight ${stage}`, {
    timeout: 7000,
    skip: process.platform === 'win32' && 'Windows does not deliver catchable SIGTERM to this subprocess',
  }, async t => {
    const remoteConfig = JSON.parse(await readFile(join(runtime, 'server.json'), 'utf8'));
    const clientConfig = JSON.parse(await readFile(join(runtime, 'alice.json'), 'utf8'));
    const reached = Promise.withResolvers();
    let peer;
    const stalledHandshake = stage === 'TLS handshake';
    const handlePeer = socket => {
      peer = socket;
      peer.on('error', () => {});
      if (stalledHandshake) {
        peer.once('data', () => reached.resolve());
      } else {
        new FrameReader(peer).read().then(frame => reached.resolve(frame), reached.reject);
      }
    };
    const remote = stalledHandshake ? createTcpServer(handlePeer) : createTlsServer({
      key: await readFile(join(runtime, remoteConfig.key)),
      cert: await readFile(join(runtime, remoteConfig.cert)),
      ca: await readFile(join(runtime, remoteConfig.ca)),
      minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true,
    }, handlePeer);
    t.after(() => {
      peer?.destroy();
      remote.close();
    });
    remote.listen(0, '127.0.0.1');
    await once(remote, 'listening', { signal: AbortSignal.timeout(2000) });
    const configPath = join(runtime, stalledHandshake ? 'stalled-handshake.json' : 'stalled-ping.json');
    await writeFile(configPath, JSON.stringify({ ...clientConfig, port: remote.address().port }));
    const bridge = launch('dist/ui.js', configPath, { SFT_UI_PORT: '0' });
    t.after(() => {
      if (!bridge.closed) bridge.child.kill('SIGKILL');
    });
    const [, bridgeOrigin, bridgeToken] = await waitForOutput(bridge, bootstrapLine);
    const pending = fetch(bridgeOrigin + '/api/connect', {
      method: 'POST',
      headers: { 'x-sft-token': bridgeToken },
      signal: AbortSignal.timeout(5000),
    }).catch(error => error);

    const timedOut = Symbol('timeout');
    const frame = await Promise.race([reached.promise, delay(2500, timedOut, { ref: false })]);
    assert.notEqual(frame, timedOut, `Bridge did not reach ${stage}`);
    if (!stalledHandshake) assert.equal(frame?.header.op, 'ping');
    const closed = new Promise(resolve => peer.once('close', resolve));
    bridge.child.kill('SIGTERM');
    const result = await Promise.race([
      Promise.all([bridge.done, closed]).then(([exit]) => exit),
      delay(1800, timedOut, { ref: false }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null }, `Bridge did not shut down during ${stage}`);
    assert((await pending) instanceof Error, 'Pending browser request unexpectedly completed');
  });
}
