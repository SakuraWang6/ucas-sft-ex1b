import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sandbox = '/usr/bin/sandbox-exec';
const profile = `
(version 1)
(deny default)
(allow process-exec (literal (param "NODE")))
(allow file-map-executable
  (literal (param "NODE"))
  (subpath "/System/Library")
  (subpath "/usr/lib"))
(allow sysctl-read)
(allow signal (target self))
; Path metadata is separate from opening a file or listing its contents.
(allow file-read-metadata)
(allow file-read*
  (literal (param "NODE"))
  (literal (param "PACKAGE"))
  (literal (param "CONFIG"))
  (literal (param "SERVER_KEY"))
  (literal (param "SERVER_CERT"))
  (literal (param "CA_CERT"))
  (subpath (param "DIST"))
  (subpath "/System/Library")
  (subpath "/usr/lib")
  (literal "/")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom"))
(allow file-read* file-write* (subpath (param "STORAGE")))
(allow network-bind network-inbound (local ip "localhost:*"))
`;

function inside(root, path) {
  const child = relative(root, path);
  return child !== '' && !isAbsolute(child) && child.split(sep)[0] !== '..';
}

async function runtimePath(root, name, field, isDirectory = false) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) {
    throw new Error(`${field} must be a relative path inside the runtime directory`);
  }
  const path = resolve(root, name);
  if (!inside(root, path) || await realpath(path) !== path) {
    throw new Error(`${field} must stay inside the runtime directory without symbolic links`);
  }
  const stat = await lstat(path);
  if (isDirectory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${field} must be a ${isDirectory ? 'directory' : 'regular file'}`);
  }
  return path;
}

export async function isolatedNode(configPath) {
  if (process.platform !== 'darwin') throw new Error('File isolation requires macOS sandbox-exec');
  const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const configFile = await realpath(configPath);
  if (!(await lstat(configFile)).isFile()) throw new Error('Server config must be a regular file');
  const runtime = dirname(configFile);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (config.host !== '127.0.0.1') throw new Error('Isolated mode requires host 127.0.0.1');
  const storage = await runtimePath(runtime, config.dataDir, 'dataDir', true);
  const [key, cert, ca] = await Promise.all([
    runtimePath(runtime, config.key, 'key'),
    runtimePath(runtime, config.cert, 'cert'),
    runtimePath(runtime, config.ca, 'ca'),
  ]);
  if ([key, cert, ca].some(path => inside(storage, path))) {
    throw new Error('Server credentials must be outside the writable storage directory');
  }
  const dist = await runtimePath(project, 'dist', 'Build output', true);
  if (storage === project || storage === dist || inside(storage, project) ||
      inside(storage, dist) || inside(dist, storage)) {
    throw new Error('The writable storage directory must be separate from server code');
  }
  const node = await realpath(process.execPath);
  const parameters = {
    NODE: node,
    DIST: dist,
    PACKAGE: join(project, 'package.json'),
    CONFIG: configFile,
    STORAGE: storage,
    SERVER_KEY: key,
    SERVER_CERT: cert,
    CA_CERT: ca,
  };
  return {
    command: sandbox,
    args: [...Object.entries(parameters).flatMap(([name, value]) => ['-D', `${name}=${value}`]), '-p', profile, node],
    options: { cwd: project, env: {} },
    serverArgs: [join(dist, 'server.js'), configFile],
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/start-isolated.mjs <server.json>');
  const { command, args, options, serverArgs } = await isolatedNode(process.argv[2]);
  const child = spawn(command, [...args, ...serverArgs], { ...options, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
      console.error(`Isolated server stopped by ${signal}`);
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => undefined)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
