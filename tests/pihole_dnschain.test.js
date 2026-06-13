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
