'use strict';

// The encode handler's encodings are Caddy module names under http.encoders.*.
// The bundled Caddy (ueffel/caddy-brotli) registers `br`, not `brotli`; an
// unknown key makes Caddy reject the WHOLE config, so enabling compression on
// any route failed and was rolled back.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-encode-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

const KNOWN = new Set(['gzip', 'zstd', 'br']); // `caddy list-modules | grep http.encoders`

function encodeHandlers(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => encodeHandlers(n, out));
  else if (node && typeof node === 'object') {
    if (node.handler === 'encode') out.push(node);
    Object.values(node).forEach((v) => encodeHandlers(v, out));
  }
  return out;
}

let buildCaddyConfig;
before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

describe('encode handler uses registered encoder modules', () => {
  for (const auth of [false, true]) {
    it(`compress route ${auth ? 'with' : 'without'} route-auth`, () => {
      const route = {
        id: 1, domain: 'zip.example.com', route_type: 'http', target_kind: 'peer',
        target_ip: '10.8.0.7', target_port: 80, enabled: 1, https_enabled: 1, compress_enabled: 1,
      };
      if (auth) { route.route_auth_enabled = 1; route.route_auth_type = 'email_password'; }
      const encoders = encodeHandlers(buildCaddyConfig([route]));
      assert.ok(encoders.length >= 1, 'encode handler present');
      for (const h of encoders) {
        for (const name of Object.keys(h.encodings || {})) assert.ok(KNOWN.has(name), `unknown encoder module "${name}"`);
      }
    });
  }
});
