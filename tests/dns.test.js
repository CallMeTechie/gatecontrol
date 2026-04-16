'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dns-test-'));
const tmpDb = path.join(tmpDir, 'dns-test.db');
const hostsFile = path.join(tmpDir, 'peers.hosts');

process.env.GC_DB_PATH = tmpDb;
process.env.GC_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.GC_DNS_HOSTS_FILE = hostsFile;
process.env.GC_DNS_DOMAIN = 'gc.internal';
process.env.GC_DNS_REBUILD_DEBOUNCE_MS = '50';

describe('dns service', () => {
  let dns, getDb, closeDb;

  before(() => {
    const conn = require('../src/db/connection');
    getDb = conn.getDb;
    closeDb = conn.closeDb;
    const { runMigrations } = require('../src/db/migrations');
    runMigrations();
    dns = require('../src/services/dns');
  });

  after(() => {
    closeDb();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM peers').run();
  });

  function insertPeer({ name, ip, hostname = null, hostname_source = null }) {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, `pk-${name}`, `${ip}/32`, hostname, hostname_source);
    return result.lastInsertRowid;
  }

  // ─── normalizeHostname ─────────────────────────────

  describe('normalizeHostname', () => {
    it('lowercases and trims', () => {
      assert.equal(dns.normalizeHostname('  DESKTOP-ABC  '), 'desktop-abc');
    });
    it('throws on empty', () => {
      assert.throws(() => dns.normalizeHostname(''));
      assert.throws(() => dns.normalizeHostname('   '));
    });
    it('throws on non-string', () => {
      assert.throws(() => dns.normalizeHostname(null));
      assert.throws(() => dns.normalizeHostname(123));
    });
    it('throws on too long', () => {
      assert.throws(() => dns.normalizeHostname('a'.repeat(64)));
    });
  });

  // ─── strictHostnameAssert ──────────────────────────

  describe('strictHostnameAssert', () => {
    it('accepts valid DNS labels', () => {
      assert.doesNotThrow(() => dns.strictHostnameAssert('desktop-abc'));
      assert.doesNotThrow(() => dns.strictHostnameAssert('laptop42'));
      assert.doesNotThrow(() => dns.strictHostnameAssert('a'));
    });
    it('rejects uppercase (must be normalized first)', () => {
      assert.throws(() => dns.strictHostnameAssert('DESKTOP-ABC'));
    });
    it('rejects leading/trailing hyphen', () => {
      assert.throws(() => dns.strictHostnameAssert('-abc'));
      assert.throws(() => dns.strictHostnameAssert('abc-'));
    });
    it('rejects injection attempts', () => {
      assert.throws(() => dns.strictHostnameAssert('foo\n10.8.0.1 evil'));
      assert.throws(() => dns.strictHostnameAssert('foo bar'));
      assert.throws(() => dns.strictHostnameAssert('foo\tbar'));
      assert.throws(() => dns.strictHostnameAssert('foo#evil'));
      assert.throws(() => dns.strictHostnameAssert('foo\0bar'));
      assert.throws(() => dns.strictHostnameAssert('foo\r\nbar'));
    });
    it('rejects reserved names', () => {
      for (const name of ['localhost', 'gateway', 'server', 'admin', 'root', 'dns']) {
        assert.throws(() => dns.strictHostnameAssert(name), new RegExp(`reserved`));
      }
    });
    it('rejects non-ASCII', () => {
      assert.throws(() => dns.strictHostnameAssert('münchen'));
      assert.throws(() => dns.strictHostnameAssert('café'));
    });
  });

  // ─── reserveUniqueHostname ─────────────────────────

  describe('reserveUniqueHostname', () => {
    it('returns candidate when no conflict', () => {
      const peerId = insertPeer({ name: 'alice', ip: '10.8.0.5' });
      const assigned = dns.reserveUniqueHostname('alice', peerId, () => {});
      assert.equal(assigned, 'alice');
    });

    it('appends -2 on conflict', () => {
      const p1 = insertPeer({ name: 'alice', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      const p2 = insertPeer({ name: 'alice-laptop', ip: '10.8.0.6' });
      const assigned = dns.reserveUniqueHostname('alice', p2, (h) => {
        getDb().prepare('UPDATE peers SET hostname = ? WHERE id = ?').run(h, p2);
      });
      assert.equal(assigned, 'alice-2');
    });

    it('is case-insensitive (COLLATE NOCASE)', () => {
      const p1 = insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'Alice', hostname_source: 'admin' });
      const p2 = insertPeer({ name: 'p2', ip: '10.8.0.6' });
      const assigned = dns.reserveUniqueHostname('alice', p2, (h) => {
        getDb().prepare('UPDATE peers SET hostname = ? WHERE id = ?').run(h, p2);
      });
      assert.notEqual(assigned.toLowerCase(), 'alice');
      assert.ok(assigned.startsWith('alice-'));
    });

    it('keeps assignment for the same peer (idempotent)', () => {
      const p = insertPeer({ name: 'p', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      const assigned = dns.reserveUniqueHostname('alice', p, () => {});
      assert.equal(assigned, 'alice');
    });

    it('throws on invalid candidate', () => {
      const p = insertPeer({ name: 'p', ip: '10.8.0.5' });
      assert.throws(() => dns.reserveUniqueHostname('localhost', p, () => {}));
      assert.throws(() => dns.reserveUniqueHostname('foo\nbar', p, () => {}));
    });
  });

  // ─── renderHostsContent ────────────────────────────

  describe('renderHostsContent', () => {
    it('renders empty on no hostnames', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5' });
      const content = dns.renderHostsContent();
      assert.match(content, /^# /);
      assert.ok(!content.includes('10.8.0.5'));
    });

    it('renders FQDN and short name per peer', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      const content = dns.renderHostsContent();
      assert.match(content, /^10\.8\.0\.5\talice\.gc\.internal\talice$/m);
    });

    it('skips peers with malformed allowed_ips', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'ok1', hostname_source: 'admin' });
      const db = getDb();
      db.prepare('INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source) VALUES (?, ?, ?, ?, ?)')
        .run('bad', 'pk-bad', 'not-an-ip', 'ok2', 'admin');
      const content = dns.renderHostsContent();
      assert.match(content, /alice|ok1/);
      assert.ok(!content.includes('not-an-ip'));
    });

    it('silently skips peers whose hostname fails strict validation', () => {
      // Direct DB insert bypasses the API validator — the renderer must
      // refuse to emit a line for a poisoned value.
      const db = getDb();
      db.prepare('INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source) VALUES (?, ?, ?, ?, ?)')
        .run('poison', 'pk-poison', '10.8.0.9/32', 'foo\n10.8.0.1 evil', 'admin');
      const content = dns.renderHostsContent();
      assert.ok(!content.includes('evil'));
      assert.ok(!content.includes('foo\n10.8.0.1'));
    });
  });

  // ─── rebuildNow ────────────────────────────────────

  describe('rebuildNow', () => {
    it('writes the hosts file', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      dns.rebuildNow();
      const content = fs.readFileSync(hostsFile, 'utf8');
      assert.match(content, /10\.8\.0\.5\talice\.gc\.internal\talice/);
    });

    it('leaves no tmp files after rebuild', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      dns.rebuildNow();
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith('.peers.hosts.'));
      assert.equal(leftovers.length, 0);
    });
  });

  // ─── scheduleRebuild debouncing ────────────────────

  describe('scheduleRebuild', () => {
    it('coalesces rapid calls into a single rebuild', async () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });

      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(dns.scheduleRebuild());
      }
      const results = await Promise.all(promises);
      // All callers get the same eventual result object
      assert.ok(results.every((r) => r.ok === true));
      assert.equal(results[0].entries, results.at(-1).entries);
    });

    it('flushPendingRebuild triggers immediate write', async () => {
      insertPeer({ name: 'p2', ip: '10.8.0.6', hostname: 'bob', hostname_source: 'admin' });
      dns.scheduleRebuild();
      const flushed = await dns.flushPendingRebuild();
      assert.equal(flushed.ok, true);
      const content = fs.readFileSync(hostsFile, 'utf8');
      assert.match(content, /bob/);
    });
  });

  // ─── getStatus ─────────────────────────────────────

  describe('getStatus', () => {
    it('reports peer count per hostname source', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5', hostname: 'alice', hostname_source: 'admin' });
      insertPeer({ name: 'p2', ip: '10.8.0.6', hostname: 'bob', hostname_source: 'agent' });
      insertPeer({ name: 'p3', ip: '10.8.0.7' });
      const status = dns.getStatus();
      assert.equal(status.peers.total, 3);
      assert.equal(status.peers.with_hostname, 2);
      assert.equal(status.peers.admin_source, 1);
      assert.equal(status.peers.agent_source, 1);
      assert.equal(status.domain, 'gc.internal');
    });
  });
});
