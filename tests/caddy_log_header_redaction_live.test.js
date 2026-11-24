'use strict';

// The header redaction of the generated logging block against a real Caddy:
// one request into the access log, one reverse_proxy "aborting with
// incomplete response" warning into the default log (the container log in
// the image). Needs a Caddy binary (GC_CADDY_BIN, /usr/local/bin/caddy,
// /usr/bin/caddy); skipped when there is none (plain CI runner) — the unit
// test tests/caddy_log_header_redaction.test.js covers the config itself.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.GC_LOG_LEVEL = process.env.GC_LOG_LEVEL || 'silent';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-caddy-logredact-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');
fs.mkdirSync(process.env.GC_CADDY_DATA_DIR, { recursive: true });

function findCaddy() {
  for (const bin of [process.env.GC_CADDY_BIN, '/usr/local/bin/caddy', '/usr/bin/caddy'].filter(Boolean)) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

const CADDY = findCaddy();
const SECRET = 'gc_' + crypto.randomBytes(16).toString('hex');
const FINGERPRINT = crypto.randomBytes(16).toString('hex');
const CSRF = crypto.randomBytes(12).toString('hex');
let caddy;
let upstream;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: p,
      headers: { 'User-Agent': 'gc-test', 'X-Api-Token': SECRET, 'x-machine-fingerprint': FINGERPRINT, CSRFPreventionToken: CSRF, 'Proxy-Authorization': `Basic ${SECRET}` },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); res.on('error', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(null));
  });
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

before(async () => {
  if (!CADDY) return;
  require('../src/db/migrations').runMigrations();
  const { buildCaddyConfig } = require('../src/services/caddyConfig');
  // Upstream that sends half a body and drops the connection.
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 50);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const port = await freePort();

  const { logging } = buildCaddyConfig();
  logging.logs.access.writer.filename = path.join(tmp, 'access.log');
  logging.logs.tls.writer.filename = path.join(tmp, 'tls.log');
  // stderr in the image; a file here so the test can read it
  logging.logs.default.writer = { output: 'file', filename: path.join(tmp, 'default.log') };
  const cfg = {
    admin: { disabled: true },
    logging,
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [`127.0.0.1:${port}`],
            automatic_https: { disable: true },
            logs: { default_logger_name: 'access' },
            routes: [
              { match: [{ path: ['/abort'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${upPort}` }] }] },
              { handle: [{ handler: 'static_response', status_code: 200, body: 'ok' }] },
            ],
          },
        },
      },
    },
  };
  const file = path.join(tmp, 'caddy.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  caddy = spawn(CADDY, ['run', '--config', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_DATA_HOME: path.join(tmp, 'caddy'), XDG_CONFIG_HOME: path.join(tmp, 'caddy') },
  });
  caddy.stderr.on('data', () => {});
  const up = await waitFor(() => get(port, '/ok').then((s) => s === 200));
  assert.ok(up, 'caddy did not come up');
  await get(port, '/abort');
  await waitFor(() => /aborting with incomplete response/.test(read(path.join(tmp, 'default.log'))));
});

after(async () => {
  if (caddy) { caddy.kill('SIGKILL'); await new Promise((r) => caddy.once('exit', r)); }
  if (upstream) await new Promise((r) => upstream.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

const skip = CADDY ? false : 'no Caddy binary (build the image or set GC_CADDY_BIN)';

function assertClean(text, where) {
  assert.ok(!text.includes(SECRET), `${where}: app token in clear`);
  assert.ok(!text.includes(FINGERPRINT), `${where}: fingerprint in clear`);
  assert.ok(!text.includes(CSRF), `${where}: CSRF token in clear`);
}

test('access log: token headers replaced, the request itself logged', { skip }, () => {
  const text = read(path.join(tmp, 'access.log'));
  assert.match(text, /"uri":"\/ok"/);
  assertClean(text, 'access');
  const line = JSON.parse(text.split('\n').find((l) => l.includes('"/ok"')));
  assert.equal(line.request.headers['X-Api-Token'], 'REDACTED');
  assert.equal(line.request.headers['X-Machine-Fingerprint'], 'REDACTED');
  assert.equal(line.request.headers.Csrfpreventiontoken, 'REDACTED');
  assert.ok(line.request.headers['User-Agent'], 'other headers stay');
});

test('default log: reverse_proxy warning without the token headers, no access lines', { skip }, () => {
  const text = read(path.join(tmp, 'default.log'));
  assert.match(text, /aborting with incomplete response/);
  assertClean(text, 'default');
  assert.match(text, /"X-Api-Token":"REDACTED"/);
  assert.doesNotMatch(text, /"logger":"http\.log\.access/, 'access lines only in their own file');
});
