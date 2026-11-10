import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const identities = ['alice', 'bob'];
const host = '127.0.0.1';
const servername = 'localhost';
const ca = 'ca.crt';

function openssl(...args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${result.stderr.trim() || result.signal || result.status}`);
  }
}

function serial() {
  return `0x01${randomBytes(15).toString('hex')}`;
}

function createKey(file) {
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file);
}

function writeConfig(directory, name, config) {
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function issueCertificate(directory, scratch, identity, role) {
  mkdirSync(join(directory, identity), { mode: 0o700 });
  const key = `${identity}/key.pem`;
  const cert = `${identity}/cert.pem`;
  const keyFile = join(directory, key);
  const certFile = join(directory, cert);
  const request = join(scratch, `${identity}.csr`);
  const config = join(scratch, `${identity}.cnf`);
  const subject = role === 'serverAuth' ? servername : identity;
  const alternateNames = role === 'serverAuth' ? `subjectAltName = DNS:${servername},IP:${host}\n` : '';

  writeFileSync(config, `[req]
prompt = no
distinguished_name = dn
[dn]
CN = ${subject}
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = ${role}
${alternateNames}`);
  createKey(keyFile);
  openssl('req', '-new', '-sha256', '-key', keyFile, '-config', config, '-out', request);
  openssl(
    'x509', '-req', '-in', request, '-CA', join(directory, ca),
    '-CAkey', join(scratch, 'ca.key'), '-set_serial', serial(), '-sha256',
    '-days', '30', '-extfile', config, '-extensions', 'leaf', '-out', certFile,
  );
  const fingerprint = new X509Certificate(readFileSync(certFile)).fingerprint256;
  return { key, cert, fingerprint };
}

function initialize(directory, port) {
  mkdirSync(directory, { mode: 0o700 });
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'sft-ca-'));
    try {
      const config = join(scratch, 'ca.cnf');
      const key = join(scratch, 'ca.key');
      writeFileSync(config, `[req]
prompt = no
distinguished_name = dn
[dn]
CN = SFT Lab Local CA
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`);
      createKey(key);
      openssl(
        'req', '-new', '-x509', '-sha256', '-key', key, '-set_serial', serial(),
        '-days', '31', '-config', config, '-extensions', 'ca', '-out', join(directory, ca),
      );

      const dataDir = 'storage';
      mkdirSync(join(directory, dataDir), { mode: 0o700 });
      const server = issueCertificate(directory, scratch, 'server', 'serverAuth');
      const users = {};
      for (const user of identities) {
        const client = issueCertificate(directory, scratch, user, 'clientAuth');
        mkdirSync(join(directory, dataDir, user), { mode: 0o700 });
        users[user] = client.fingerprint;
        writeConfig(directory, user, { host, port, servername, ca, key: client.key, cert: client.cert });
      }
      const bandwidthBytesPerSecond = { alice: 8 * 1024 * 1024, bob: 2 * 1024 * 1024 };
      writeConfig(directory, 'server', {
        host, port, ca, key: server.key, cert: server.cert, dataDir, users, bandwidthBytesPerSecond,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('Usage: node scripts/setup.mjs [runtimeDir]');
  const port = process.env.SFT_PORT ?? '9443';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    throw new Error('SFT_PORT must be an integer between 0 and 65535');
  }
  process.umask(0o077);
  initialize(resolve(args[0] ?? 'runtime'), Number(port));
  console.log('Initialized local TLS certificates, server.json, alice.json, bob.json, and private storage.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Setup path already exists. Choose a new runtime directory.' : error.message);
  process.exitCode = 1;
}
