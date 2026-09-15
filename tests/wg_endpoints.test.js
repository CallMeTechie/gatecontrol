'use strict';

// WireGuard endpoint memory (src/services/wgEndpoints.js) and its restore at
// container start (scripts/wg-restore-endpoints.sh, run here with fake `wg`
// and `ping` binaries on PATH).

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { setup, teardown } = require('./helpers/setup');

let svc;
before(async () => { await setup(); svc = require('../src/services/wgEndpoints'); });
after(() => teardown());

const K1 = 'A'.repeat(43) + '=';
const K2 = 'B'.repeat(43) + '=';
const K3 = 'C'.repeat(43) + '=';
const NOW = 1_800_000_000;

const peer = (over) => ({ publicKey: K1, endpoint: '203.0.113.7:51820', allowedIps: '10.8.0.8/32', latestHandshake: NOW - 20, ...over });

describe('formatLines', () => {
  it('recent peers with endpoint → "<key> <endpoint> <tunnel ip>", sorted', () => {
    const out = svc.formatLines([
      peer({ publicKey: K2, endpoint: '[2001:db8::5]:40000', allowedIps: '10.8.0.9/32, 192.168.2.0/24' }),
      peer(),
    ], NOW);
    assert.equal(out, `${K1} 203.0.113.7:51820 10.8.0.8\n${K2} [2001:db8::5]:40000 10.8.0.9\n`);
  });

  it('skips stale handshakes, missing endpoints, malformed keys/endpoints and peers without a /32 tunnel IP', () => {
    const out = svc.formatLines([
      peer({ latestHandshake: NOW - svc.RECENT_S - 1 }),
      peer({ latestHandshake: 0 }),
      peer({ endpoint: null }),
      peer({ publicKey: 'short=' }),
      peer({ endpoint: '203.0.113.7:51820;touch' }),
      peer({ endpoint: 'host.example:51820' }),
      peer({ allowedIps: '192.168.2.0/24' }),
    ], NOW);
    assert.equal(out, '');
  });

  it('tunnelIp picks the first IPv4 /32', () => {
    assert.equal(svc.tunnelIp('fd00::2/128, 10.8.0.3/32'), '10.8.0.3');
    assert.equal(svc.tunnelIp('10.8.0.4'), '10.8.0.4');
    assert.equal(svc.tunnelIp('10.0.0.0/8'), null);
  });
});

describe('record', () => {
  let dir; let file; let status;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wgep-'));
    file = path.join(dir, 'wireguard', 'last-endpoints');
    svc._resetForTest({ file });
    const wg = require('../src/services/wireguard');
    status = { running: true, peers: [] };
    wg._origGetStatus = wg._origGetStatus || wg.getStatus;
    wg.getStatus = async () => status;
  });
  afterEach(() => {
    const wg = require('../src/services/wireguard');
    wg.getStatus = wg._origGetStatus;
    fs.rmSync(dir, { recursive: true, force: true });
    svc._resetForTest();
  });

  it('writes the file 0600, skips an unchanged rewrite, keeps the file when nothing is recent', async () => {
    const now = Date.now();
    status.peers = [peer({ latestHandshake: Math.floor(now / 1000) - 5 })];
    assert.equal(await svc.record({ now }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), `${K1} 203.0.113.7:51820 10.8.0.8\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(await svc.record({ now: now + 30_000 }), false, 'unchanged → no write');
    status.peers = [peer({ latestHandshake: Math.floor(now / 1000) + 6 * 60 - 5 })]; // still active 6 min later
    assert.equal(await svc.record({ now: now + 6 * 60_000 }), true, 'refreshed after 5 min');
    status.peers = [];
    assert.equal(await svc.record({ now: now + 7 * 60_000 }), false);
    assert.ok(fs.existsSync(file), 'previous endpoints kept for the next start');
  });

  it('interface down → nothing written', async () => {
    status = { running: false, peers: [] };
    assert.equal(await svc.record(), false);
    assert.equal(fs.existsSync(file), false);
  });
});

describe('scripts/wg-restore-endpoints.sh', () => {
  const script = path.join(__dirname, '..', 'scripts', 'wg-restore-endpoints.sh');
  let dir; let bin; let log; let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wgrs-'));
    bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    log = path.join(dir, 'calls.log');
    file = path.join(dir, 'last-endpoints');
    // fake wg: `wg show <if> peers` lists K1 and K2; `wg set …` is logged
    fs.writeFileSync(path.join(bin, 'wg'), `#!/bin/sh
if [ "$1" = show ]; then printf '%s\\n' '${K1}' '${K2}'; exit 0; fi
echo "wg $*" >> '${log}'
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'ping'), `#!/bin/sh\necho "ping $*" >> '${log}'\n`, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (env = {}) => spawnSync('sh', [script, file], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GC_WG_INTERFACE: 'wg0', ...env }, encoding: 'utf8',
  });
  const calls = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
  const waitCalls = (n) => { for (let i = 0; i < 50 && calls().split('\n').filter(Boolean).length < n; i++) spawnSync('sleep', ['0.1']); return calls(); };

  it('sets endpoints of peers still on the interface and pokes their tunnel IP', () => {
    fs.writeFileSync(file, `${K1} 203.0.113.7:51820 10.8.0.8\n${K2} [2001:db8::5]:40000 10.8.0.9\n${K3} 198.51.100.1:51820 10.8.0.10\n`);
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restored 2 peer endpoint/);
    const c = waitCalls(4);
    assert.match(c, new RegExp(`wg set wg0 peer ${K1.replace(/[+/=]/g, '\\$&')} endpoint 203\\.0\\.113\\.7:51820`));
    assert.match(c, /endpoint \[2001:db8::5\]:40000/);
    assert.match(c, /ping -c 1 -W 1 10\.8\.0\.8/);
    assert.match(c, /ping -c 1 -W 1 10\.8\.0\.9/);
    assert.doesNotMatch(c, /198\.51\.100\.1/, 'peer no longer on the interface is skipped');
  });

  it('ignores malformed and hostile lines', () => {
    const pwned = path.join(dir, 'pwned');
    fs.writeFileSync(file, [
      `${K1} $(touch ${pwned}):1 10.8.0.8`,
      `${K1} 203.0.113.7:51820;touch${pwned} 10.8.0.8`,
      `${K1} 203.0.113.7:51820 10.8.0.8 extra`,
      `short= 203.0.113.7:51820 10.8.0.8`,
      `${K2} [2001:db8::5;x]:40000 10.8.0.9`,
      `${K2} 203.0.113.7:51820 10.8.0.x`,
      '',
    ].join('\n'));
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restored 0 peer endpoint/);
    assert.equal(calls(), '');
    assert.equal(fs.existsSync(pwned), false);
  });

  it('stale file → nothing restored; missing file → silent exit 0', () => {
    fs.writeFileSync(file, `${K1} 203.0.113.7:51820 10.8.0.8\n`);
    const old = (Date.now() / 1000) - 3600;
    fs.utimesSync(file, old, old);
    const r = run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not restoring/);
    assert.equal(calls(), '');
    fs.rmSync(file);
    const r2 = run();
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '');
  });

  it('wg-wrapper.sh calls the restore right after wg-quick up, never fatally', () => {
    const w = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wg-wrapper.sh'), 'utf8');
    const up = w.indexOf('WG_UP=1');
    const call = w.indexOf('sh /app/scripts/wg-restore-endpoints.sh || true');
    assert.ok(up > 0 && call > up && call < w.indexOf('start_dnsmasq\n', up), 'after wg-quick up, before dnsmasq');
  });
});
