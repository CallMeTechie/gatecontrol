'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeChain } = require('../src/services/piholeDnsChain');

let confPath, reloads;
beforeEach(() => {
  confPath = path.join(os.tmpdir(), `dnsmasq-test-${process.pid}-${Math.random().toString(36).slice(2)}.conf`);
  fs.writeFileSync(confPath, 'bind-dynamic\nserver=1.1.1.1\nserver=8.8.8.8\n');
  reloads = 0;
});
afterEach(() => { try { fs.unlinkSync(confPath); } catch {} });

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

test('revert restores default upstreams and removes managed block', () => {
  const ch = chain();
  ch.apply(['10.8.0.5']);
  ch.revert();
  const c = fs.readFileSync(confPath, 'utf8');
  assert.doesNotMatch(c, /# >>> gatecontrol-pihole >>>/);
  assert.doesNotMatch(c, /add-subnet/);
});

test('revert is a no-op (no reload, no rewrite) when nothing is GC-managed', () => {
  const before = fs.readFileSync(confPath, 'utf8');
  let reloads2 = 0;
  const ch = makeChain({ confPath, defaults: ['1.1.1.1', '8.8.8.8'], reload: () => { reloads2++; } });
  // Simulate the disabled-on-boot scenario: lastApplied is not 'default' (force it)
  // We call apply first to set lastApplied, then manually restore the file to pre-apply state
  // so the managed block is absent — but instead, we use a fresh chain that directly
  // sets lastApplied by calling a dummy apply then restoring file, or we can trigger
  // via the internal state. The simplest approach: use a second chain that previously
  // applied but the file was externally reverted (managed block gone).
  // Easiest: just call revert() on a chain whose internal state was set by apply().
  const ch2 = makeChain({ confPath, defaults: ['1.1.1.1', '8.8.8.8'], reload: () => { reloads2++; } });
  ch2.apply(['10.8.0.5']); // sets lastApplied to managed, increments reloads2
  reloads2 = 0; // reset counter
  // Now restore the file externally to the no-managed-block state
  fs.writeFileSync(confPath, before);
  ch2.revert(); // managed block absent → should be a no-op
  assert.equal(reloads2, 0, 'revert must not reload when no managed block is present');
  assert.equal(fs.readFileSync(confPath, 'utf8'), before, 'revert must not rewrite file when no managed block is present');
});
