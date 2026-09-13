'use strict';

// Clearing the last route PEM must remove its file on the next config build;
// before, the sync only ran while some route still carried a PEM.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pem-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');

let buildCaddyConfig, pem;
before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  pem = require('../src/services/caddyPemFiles');
});

test('orphaned PEM files are removed when no route carries a PEM any more', () => {
  const dir = path.join(tmp, 'caddy', 'mtls');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '4711.pem'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
  assert.equal(pem.hasPemFiles(), true);
  buildCaddyConfig();
  assert.equal(fs.existsSync(path.join(dir, '4711.pem')), false);
  assert.equal(pem.hasPemFiles(), false);
});

test('no PEM directories → nothing is created by a build', () => {
  fs.rmSync(path.join(tmp, 'caddy'), { recursive: true, force: true });
  buildCaddyConfig();
  assert.equal(fs.existsSync(path.join(tmp, 'caddy', 'mtls')), false);
});
