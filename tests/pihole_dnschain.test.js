'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeChain, buildDnsToken, isValidDnsTarget } = require('../src/services/dnsChainConf');

let tmpDir, confPath, reloads;
beforeEach(() => {
  // mkdtempSync creates a uniquely-named, owner-only temp dir (avoids the
  // predictable-temp-file class flagged by CodeQL js/insecure-temporary-file).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnsmasq-test-'));
  confPath = path.join(tmpDir, 'dnsmasq.conf');
  fs.writeFileSync(confPath, 'bind-dynamic\nserver=1.1.1.1\nserver=8.8.8.8\n');
  reloads = 0;
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

function chain() { return makeChain({ confPath, defaults: ['1.1.1.1','8.8.8.8'], reload: () => { reloads++; } }); }

test('apply writes managed block with pihole upstreams + add-subnet, reloads', () => {
  chain().apply(['10.8.0.5', '10.8.0.6']);
  const c = fs.readFileSync(confPath, 'utf8');
  assert.match(c, /# >>> gatecontrol-pihole >>>/);
  assert.match(c, /server=10\.8\.0\.5/);
  assert.match(c, /server=10\.8\.0\.6/);
  assert.match(c, /add-subnet=32,128/);
  assert.doesNotMatch(c.split('# >>> gatecontrol-pihole >>>')[1], /server=1\.1\.1\.1/);
  assert.equal(reloads, 1);
});

test('apply is idempotent (no second reload for identical state)', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.apply(['10.8.0.5']);
  assert.equal(reloads, 1, 'identical apply should not reload again');
});

test('apply on a fresh instance skips reload when conf already routes to the same upstreams (boot case)', () => {
  // Simulate entrypoint.sh having baked the chain into the conf before boot:
  // add-subnet + the exact pihole upstreams already present.
  fs.writeFileSync(confPath, 'bind-dynamic\nadd-subnet=32,128\nserver=10.8.0.5\n');
  // A fresh chain (lastApplied='default', as on every process start) must NOT
  // restart dnsmasq when the effective upstreams already match.
  chain().apply(['10.8.0.5']);
  assert.equal(reloads, 0, 'should not reload/restart when upstreams already applied');
});

test('apply still reloads when conf upstreams differ from desired', () => {
  // add-subnet present but wrong upstream → must apply + reload.
  fs.writeFileSync(confPath, 'bind-dynamic\nadd-subnet=32,128\nserver=10.8.0.9\n');
  chain().apply(['10.8.0.5']);
  assert.equal(reloads, 1);
});

test('revert restores default upstreams and removes managed block', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.revert();
  const c = fs.readFileSync(confPath, 'utf8');
  assert.doesNotMatch(c, /# >>> gatecontrol-pihole >>>/);
  assert.doesNotMatch(c, /add-subnet/);
});

// ─── dns_port token building ───────────────────────────────────────────────
test('buildDnsToken: non-standard port produces ip#port token', () => {
  assert.equal(buildDnsToken({ dns_ip: '10.8.0.2', dns_port: 5335 }), '10.8.0.2#5335');
});

test('buildDnsToken: port 53 omits the port annotation', () => {
  assert.equal(buildDnsToken({ dns_ip: '10.8.0.5', dns_port: 53 }), '10.8.0.5');
});

test('buildDnsToken: missing dns_port omits the port annotation', () => {
  assert.equal(buildDnsToken({ dns_ip: '10.8.0.5' }), '10.8.0.5');
});

test('buildDnsToken: missing dns_ip returns null', () => {
  assert.equal(buildDnsToken({ dns_port: 5335 }), null);
});

test('apply with port-annotated token produces server=ip#port line', () => {
  chain().apply(['10.8.0.2#5335']);
  const c = fs.readFileSync(confPath, 'utf8');
  assert.match(c, /server=10\.8\.0\.2#5335/);
});

test('apply with plain ip token produces server=ip without hash', () => {
  chain().apply(['10.8.0.5']);
  const c = fs.readFileSync(confPath, 'utf8');
  assert.match(c, /server=10\.8\.0\.5/);
  assert.doesNotMatch(c, /server=10\.8\.0\.5#/);
});

test('revert is a no-op (no reload, no rewrite) when the conf already routes to the defaults', () => {
  const before = fs.readFileSync(confPath, 'utf8');
  chain().revert();
  assert.equal(reloads, 0, 'revert must not restart dnsmasq when nothing is to revert');
  assert.equal(fs.readFileSync(confPath, 'utf8'), before);
});

test('revert undoes the chain entrypoint.sh baked in at boot (no managed block)', () => {
  // The cause of "no DNS while Pi-hole is off": after a container start the
  // conf holds the Pi-hole upstreams WITHOUT the managed block. revert() only
  // looked for the block and did nothing — the fallback never happened.
  fs.writeFileSync(confPath, 'bind-dynamic\nadd-subnet=32,128\nserver=10.8.0.2#5335\nhost-record=gc.example.com,10.8.0.1\n');
  const ch = chain();
  ch.apply(['10.8.0.2#5335']); // boot: already applied, no restart
  assert.equal(reloads, 0);
  ch.revert();
  const c = fs.readFileSync(confPath, 'utf8');
  assert.deepEqual(c.match(/^server=.*/gm), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.doesNotMatch(c, /add-subnet/, 'no client subnets to public resolvers');
  assert.match(c, /^bind-dynamic$/m);
  assert.match(c, /^host-record=gc\.example\.com,10\.8\.0\.1$/m, 'the rest of the conf is kept');
  assert.equal(reloads, 1);
});

test('revert works on a fresh chain too (process restarted while the chain was applied)', () => {
  chain().apply(['10.8.0.5']);
  reloads = 0;
  chain().revert(); // new instance: remembers nothing
  const c = fs.readFileSync(confPath, 'utf8');
  assert.deepEqual(c.match(/^server=.*/gm), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.doesNotMatch(c, /gatecontrol-pihole|add-subnet/);
  assert.equal(reloads, 1);
});

test('apply after a baked chain leaves exactly one add-subnet line', () => {
  fs.writeFileSync(confPath, 'bind-dynamic\nadd-subnet=32,128\nserver=10.8.0.9\n');
  chain().apply(['10.8.0.5']);
  const c = fs.readFileSync(confPath, 'utf8');
  assert.equal((c.match(/^add-subnet=/gm) || []).length, 1);
  assert.deepEqual(c.match(/^server=.*/gm), ['server=10.8.0.5']);
});

test('apply → revert → apply restarts dnsmasq each time', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.revert();
  ch.apply(['10.8.0.5']);
  assert.equal(reloads, 3);
  assert.deepEqual(fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm), ['server=10.8.0.5']);
});

test('apply without any upstream never leaves dnsmasq without a server', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.apply([]);
  assert.deepEqual(fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm), ['server=1.1.1.1', 'server=8.8.8.8']);
});

// ─── what may end up in a server= line ─────────────────────────────────────
test('buildDnsToken: only IP literals and ports 1–65535', () => {
  assert.equal(buildDnsToken({ dns_ip: 'fd00::2', dns_port: 5335 }), 'fd00::2#5335');
  for (const bad of [
    { dns_ip: 'pi.hole' },
    { dns_ip: '10.8.0.2\nconf-file=/etc/passwd' },
    { dns_ip: '10.8.0.2#53\nserver=6.6.6.6' },
    { dns_ip: '10.8.0.2 ' },
    { dns_ip: '10.8.0.2', dns_port: 0 },
    { dns_ip: '10.8.0.2', dns_port: 65536 },
    { dns_ip: '10.8.0.2', dns_port: '53\nserver=6.6.6.6' },
    { dns_ip: '10.8.0.2', dns_port: '5335x' },
    { dns_ip: 12345 },
  ]) {
    assert.equal(buildDnsToken(bad), null, JSON.stringify(bad));
    assert.equal(isValidDnsTarget(bad), false);
  }
});

test('apply never writes anything but valid upstreams, whatever it is handed', () => {
  chain().apply(['10.8.0.5', '10.8.0.6\nconf-file=/tmp/x', 'pi.hole', '10.8.0.7#99999', '10.8.0.8#5335']);
  const c = fs.readFileSync(confPath, 'utf8');
  assert.deepEqual(c.match(/^server=.*/gm), ['server=10.8.0.5', 'server=10.8.0.8#5335']);
  assert.doesNotMatch(c, /conf-file|pi\.hole/);
});

test('apply with only invalid upstreams falls back to the defaults', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.apply(['bad\nline']);
  assert.deepEqual(fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm), ['server=1.1.1.1', 'server=8.8.8.8']);
});

test('revert without a conf throws (nothing to manage here), like apply', () => {
  fs.rmSync(confPath);
  assert.throws(() => chain().revert(), /ENOENT/);
  assert.equal(reloads, 0);
});
