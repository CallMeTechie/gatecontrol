'use strict';

// Der Test-Stub für @callmetechie/gatecontrol-config-hash (tests/stubs/) darf
// NUR auf einem Entwicklerrechner ohne Registry-Zugriff greifen. In der CI —
// und damit in allem, was ein Release freigibt — muss das echte Paket geladen
// sein, sonst prüft die Suite Hashes gegen sich selbst statt gegen die
// Bibliothek, die auch das Gateway benutzt.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('@callmetechie/gatecontrol-config-hash');
const ROOT = path.join(__dirname, '..');

test('CI runs against the real package, never the stub', () => {
  if (!process.env.CI) return; // lokal ist der Stub erlaubt
  assert.notEqual(lib.__isTestStub, true,
    'the config-hash TEST STUB is installed in CI — npm ci must install the real package (NODE_AUTH_TOKEN)');
});

test('the stub refuses to load outside NODE_ENV=test', () => {
  const { spawnSync } = require('node:child_process');
  const stub = path.join(ROOT, 'tests', 'stubs', 'config-hash', 'index.cjs');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(stub)})`], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  assert.notEqual(r.status, 0, 'the stub loaded outside NODE_ENV=test');
  assert.match(r.stderr, /TEST STUB/);
});

test('production code has no fallback for the private package', () => {
  // Die Produktion darf sich nicht ändern: src/ kennt genau ein require und
  // keinen try/catch darum.
  const gw = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gateways.js'), 'utf8');
  assert.match(gw, /require\('@callmetechie\/gatecontrol-config-hash'\)/);
  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) srcFiles.push(p);
    }
  })(path.join(ROOT, 'src'));
  const offenders = srcFiles.filter((f) => /stubs\/config-hash|gatecontrolTestStub|__isTestStub/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'src/ must not know about the test stub');
});

test('the stub and the real package agree on the public surface', () => {
  // Nur die Namen — die Werte prüfen config_hash_smoke / gateways_hash.
  // Läuft mit Stub wie mit echtem Paket: beide müssen dasselbe exportieren.
  const expected = ['CONFIG_HASH_VERSION', 'GatewayConfigSchema', 'canonicalize', 'canonicalizeValue', 'computeConfigHash', 'computeHash', 'validateWgConfig'];
  for (const name of expected) assert.ok(name in lib, `missing export: ${name}`);
});

test('the stub mirrors the package version pinned in package-lock.json', (t) => {
  // Nur relevant, wenn der Stub geladen ist (lokal ohne Registry-Zugriff).
  // Wird das echte Paket angehoben, ohne den Stub nachzuziehen, laufen
  // lokale Stub-Läufe auseinander (so geschehen mit 1.3.0 /
  // backend_tls_fingerprint) — das soll hier auffallen statt als
  // rätselhafter Fehler in einem Fachtest.
  if (lib.__isTestStub !== true) { t.skip('real package installed — nothing to compare'); return; }
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const pinned = lock.packages['node_modules/@callmetechie/gatecontrol-config-hash'].version;
  const stubPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'stubs', 'config-hash', 'package.json'), 'utf8'));
  assert.equal(stubPkg.gatecontrolTestStubMirrors, pinned,
    `tests/stubs/config-hash mirrors ${stubPkg.gatecontrolTestStubMirrors}, package-lock pins ${pinned} — update the stub (and its gatecontrolTestStubMirrors)`);
});
