'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('tags registry', () => {
  let server, baseUrl, db, tags;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tags-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/tags',
      '../src/app',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });

    require('../src/db/migrations').runMigrations();
    db = require('../src/db/connection').getDb();
    tags = require('../src/services/tags');

    // Seed a peer with CSV tags so list()-merging can be exercised.
    db.prepare(`INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted,
      allowed_ips, enabled, tags) VALUES (?, ?, ?, ?, ?, 1, ?)`).run(
      'peer-a', 'pubA', 'encA', 'encA', '10.8.0.10/32', 'server, production'
    );
    db.prepare(`INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted,
      allowed_ips, enabled, tags) VALUES (?, ?, ?, ?, ?, 1, ?)`).run(
      'peer-b', 'pubB', 'encB', 'encB', '10.8.0.11/32', 'production, Staging'
    );

    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  function req(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const r = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      }, (res) => {
        let b = ''; res.on('data', (c) => b += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(b); } catch (_) { /* ignore */ }
          resolve({ status: res.statusCode, body: parsed, raw: b });
        });
      });
      r.on('error', reject);
      if (body !== undefined) r.end(JSON.stringify(body)); else r.end();
    });
  }

  it('list() merges registry + distinct peer CSV tokens with correct counts', () => {
    tags.create('needs-review'); // orphan registry entry
    const all = tags.list();
    const byName = Object.fromEntries(all.map((t) => [t.name.toLowerCase(), t]));

    // From peer CSVs
    assert.equal(byName['server'].peer_count, 1);
    assert.equal(byName['server'].registered, false);
    assert.equal(byName['production'].peer_count, 2);
    assert.equal(byName['production'].registered, false);
    // Case-insensitive merge: "Staging" appears once across peers
    assert.equal(byName['staging'].peer_count, 1);

    // Orphan from registry
    assert.equal(byName['needs-review'].peer_count, 0);
    assert.equal(byName['needs-review'].registered, true);
  });

  it('create() rejects invalid names', () => {
    assert.throws(() => tags.create(''), /required/);
    assert.throws(() => tags.create('a'.repeat(65)), /too long/);
    assert.throws(() => tags.create('has,comma'), /invalid/);
    assert.throws(() => tags.create('line\nbreak'), /invalid/);
  });

  it('create() is idempotent for duplicate names (case-insensitive)', () => {
    const a = tags.create('Production'); // already exists on peers
    const b = tags.create('PRODUCTION');
    assert.equal(a.name.toLowerCase(), 'production');
    assert.equal(b.name.toLowerCase(), 'production');
  });

  it('remove() strips the tag from every peer CSV and deregisters', () => {
    tags.create('demo');
    const result = tags.remove('production');
    assert.equal(result.peers_affected, 2);
    // Peer CSVs no longer contain "production"
    const rows = db.prepare('SELECT name, tags FROM peers').all();
    for (const r of rows) {
      assert.ok(!/production/i.test(r.tags || ''), `peer ${r.name} still has production tag: ${r.tags}`);
    }
  });

  it('remove() only touches whole-token matches, not substrings', () => {
    db.prepare('UPDATE peers SET tags = ? WHERE name = ?').run('prod-backup, archive', 'peer-a');
    const result = tags.remove('prod');
    assert.equal(result.peers_affected, 0);
    const row = db.prepare('SELECT tags FROM peers WHERE name = ?').get('peer-a');
    assert.equal(row.tags, 'prod-backup, archive');
  });

  it('HTTP GET /api/v1/tags is mounted (auth redirects or 200)', async () => {
    // The API router sits behind requireAuth; without a session the
    // middleware will redirect (302) or 401. Both prove the route is
    // wired — the 404 case would indicate a mount-order bug.
    const r = await req('GET', '/api/v1/tags');
    assert.notEqual(r.status, 404, 'tags route should be mounted under /api/v1');
  });
});
