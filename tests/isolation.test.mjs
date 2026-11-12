import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isolatedNode } from '../scripts/start-isolated.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const node = process.execPath;

describe('macOS server isolation', { skip: process.platform !== 'darwin' && 'requires macOS sandbox-exec' }, () => {
  let root;
  let runtime;
  let configFile;

  before(async () => {
    // 每次生成独立证书和数据目录，监听端口由系统分配。
    root = await mkdtemp(join(tmpdir(), 'sft-isolation-'));
    runtime = join(root, 'runtime');
    await exec(node, ['scripts/setup.mjs', runtime], {
      cwd: project, env: { ...process.env, SFT_PORT: '0' }, timeout: 5000,
    });
    configFile = join(runtime, 'server.json');
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('same macOS identity can read and write storage but not unrelated files', async () => {
    const outside = join(root, 'outside.txt');
    const inside = join(runtime, 'storage', 'alice', 'probe.txt');
    const clientKey = join(runtime, 'alice', 'key.pem');
    const serverCert = join(runtime, 'server', 'cert.pem');
    const probeFile = join(runtime, 'storage', 'probe.mjs');
    await writeFile(outside, 'outside marker', { mode: 0o600 });

    // 探针与测试进程使用同一用户身份。用可写模式打开文件来检查权限，保留原内容。
    const probe = `
      import { open, readFile, unlink, writeFile } from 'node:fs/promises';
      const [inside, outside, config, clientKey, serverCert] = process.argv.slice(2);
      const access = async action => {
        try { await action(); return 'allowed'; }
        catch (error) { return error.code; }
      };
      const writable = async path => { await (await open(path, 'r+')).close(); };
      await writeFile(inside, 'inside marker', { flag: 'wx' });
      const content = await readFile(inside, 'utf8');
      await unlink(inside);
      console.log(JSON.stringify({
        uid: process.getuid(), content,
        readOutside: await access(() => readFile(outside)),
        writeOutside: await access(() => writable(outside)),
        readConfig: await access(() => readFile(config)),
        writeConfig: await access(() => writable(config)),
        readClientKey: await access(() => readFile(clientKey)),
        readServerCert: await access(() => readFile(serverCert)),
        writeServerCert: await access(() => writable(serverCert)),
      }));
    `;
    await writeFile(probeFile, probe, { mode: 0o600 });
    const { command, args, options } = await isolatedNode(configFile);
    const { stdout } = await exec(command, [
      ...args, probeFile, inside, outside, configFile, clientKey, serverCert,
    ], { ...options, timeout: 5000 });
    const outcome = JSON.parse(stdout);
    assert.equal(outcome.uid, process.getuid());
    assert.equal(outcome.content, 'inside marker');
    assert.equal(outcome.readConfig, 'allowed');
    assert.equal(outcome.readServerCert, 'allowed');
    for (const name of ['readOutside', 'writeOutside', 'writeConfig', 'readClientKey', 'writeServerCert']) {
      assert.match(outcome[name], /^(EPERM|EACCES)$/, name);
    }
    assert.equal(await readFile(outside, 'utf8'), 'outside marker');
    await assert.rejects(readFile(inside), { code: 'ENOENT' });
  });

  test('isolated service completes a normal TLS file round trip', async t => {
    const server = spawn(node, ['scripts/start-isolated.mjs', configFile], {
      cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    server.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    let closed = false;
    const exit = new Promise(resolve => server.once('close', () => { closed = true; resolve(); }));
    server.on('error', error => { output += error.message; });
    // 等服务退出再清理运行目录，避免残留进程继续访问测试文件。
    t.after(async () => {
      server.kill('SIGTERM');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 2000);
      try { await exit; } finally { clearTimeout(timeout); }
    });

    let port;
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) {
      const match = output.match(/^LISTEN 127\.0\.0\.1:(\d+)$/m);
      if (match) { port = Number(match[1]); break; }
      await delay(20);
    }
    assert.ok(port, `Isolated server did not listen: ${output}`);
    const clientFile = join(runtime, 'alice.json');
    const client = JSON.parse(await readFile(clientFile, 'utf8'));
    client.port = port;
    await writeFile(clientFile, JSON.stringify(client));
    const input = join(root, 'input.bin');
    const destination = join(root, 'output.bin');
    const payload = Buffer.from([0, 1, 2, 10, 127, 128, 254, 255]);
    await writeFile(input, payload);
    const transfer = new Promise((resolve, reject) => {
      const commands = execFile(node, ['dist/client.js', clientFile], {
        cwd: project, timeout: 5000,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`, { cause: error }));
        else resolve(stdout);
      });
      commands.stdin.end(`put "${input}" isolated.bin\nget isolated.bin "${destination}"\nquit\n`);
    });
    const stdout = await transfer;
    assert.match(stdout, /^CONNECTED TLSv1\.3$/m);
    assert.match(stdout, /^BYE$/m);
    assert.deepEqual(await readFile(destination), payload);
  });
});
