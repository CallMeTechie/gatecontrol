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
process.env.GC_WG_GATEWAY_IP = '10.8.0.1';

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
    db.prepare('DELETE FROM routes').run();
  });

  function insertPeer({ name, ip, hostname = null, hostname_source = null }) {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, `pk-${name}`, `${ip}/32`, hostname, hostname_source);
    return result.lastInsertRowid;
  }

  // Direct DB insert — deliberately bypasses the route API validator so we
  // can exercise the renderer's own FQDN-safety check (incl. malicious rows).
  function insertRoute({ domain, enabled = 1, route_type = 'http', target_ip = '10.0.0.1', target_port = 8080 }) {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO routes (domain, target_ip, target_port, enabled, route_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(domain, target_ip, target_port, enabled, route_type);
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
    // Parse the rendered hosts file into [ip, fqdn] pairs (exact-field
    // assertions avoid js/incomplete-url-substring-sanitization that a string
    // .includes() of a host literal would trip).
    function emittedHosts(content) {
      return content.split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => { const [ip, fqdn] = line.split('\t'); return { ip, fqdn }; });
    }

    it('renders empty on no hostnames', () => {
      insertPeer({ name: 'p1', ip: '10.8.0.5' });
      const content = dns.renderHostsContent();
      assert.match(content, /^# /);
      assert.ok(!emittedHosts(content).some((h) => h.ip === '10.8.0.5'), content);
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
      assert.ok(emittedHosts(content).some((h) => h.fqdn === 'ok1.gc.internal'), content);
      // The peer with a malformed allowed_ips ('not-an-ip', hostname 'ok2') is skipped.
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'ok2.gc.internal'), content);
    });

    it('silently skips peers whose hostname fails strict validation', () => {
      // Direct DB insert bypasses the API validator — the renderer must
      // refuse to emit a line for a poisoned value.
      const db = getDb();
      db.prepare('INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source) VALUES (?, ?, ?, ?, ?)')
        .run('poison', 'pk-poison', '10.8.0.9/32', 'foo\n10.8.0.1 evil', 'admin');
      const content = dns.renderHostsContent();
      // The poisoned peer (allowed_ips 10.8.0.9/32) must produce no emitted line.
      assert.ok(!emittedHosts(content).some((h) => h.ip === '10.8.0.9'), content);
    });

    // ─── route domains → VPN gateway (internal-always) ───

    const gwIp = process.env.GC_WG_GATEWAY_IP; // '10.8.0.1'

    it('emits an internal A-record (route domain → gateway IP) for an enabled route', () => {
      insertRoute({ domain: 'jellyfin.example.com' });
      const content = dns.renderHostsContent();
      assert.ok(emittedHosts(content).some((h) => h.ip === gwIp && h.fqdn === 'jellyfin.example.com'), content);
    });

    it('emits an internal A-record for an L4 route too', () => {
      insertRoute({ domain: 'rdp.example.com', route_type: 'l4' });
      const content = dns.renderHostsContent();
      assert.ok(emittedHosts(content).some((h) => h.ip === gwIp && h.fqdn === 'rdp.example.com'), content);
    });

    it('does not emit a disabled route', () => {
      insertRoute({ domain: 'disabled.example.com', enabled: 0 });
      const content = dns.renderHostsContent();
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'disabled.example.com'), content);
    });

    it('emits a route FQDN with a reserved label (peer reserved-name policy does NOT apply)', () => {
      insertRoute({ domain: 'admin.foo.example.com' });
      const content = dns.renderHostsContent();
      assert.ok(emittedHosts(content).some((h) => h.ip === gwIp && h.fqdn === 'admin.foo.example.com'), content);
    });

    it('skips a malicious route domain containing whitespace or #', () => {
      // Raw SQL bypasses the API validator — the renderer must refuse these.
      insertRoute({ domain: 'evilroute.example.com one.two 10.8.0.1 hijack' });
      insertRoute({ domain: 'sharp.example.com#injected' });
      const content = dns.renderHostsContent();
      // Neither malicious domain may surface as an emitted row.
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'evilroute.example.com one.two 10.8.0.1 hijack'), content);
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'sharp.example.com#injected'), content);
    });

    it('normalises a mixed-case route domain to lowercase', () => {
      insertRoute({ domain: 'RDP.Example.COM' });
      const content = dns.renderHostsContent();
      assert.ok(emittedHosts(content).some((h) => h.ip === gwIp && h.fqdn === 'rdp.example.com'), content);
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'RDP.Example.COM'), content);
    });

    it('skips a single-label route domain (no dot → labels.length < 2)', () => {
      insertRoute({ domain: 'intranet' });
      const content = dns.renderHostsContent();
      // The SQL filter only excludes domain=''; single-label still reaches the
      // renderer, which must refuse it via the assertSafeRouteDomain guard.
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'intranet'), content);
    });

    it('skips a route domain with a trailing dot (empty last label)', () => {
      insertRoute({ domain: 'foo.example.com.' });
      const content = dns.renderHostsContent();
      assert.ok(!emittedHosts(content).some((h) => h.fqdn === 'foo.example.com.' || h.fqdn === 'foo.example.com'), content);
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

  // ─── renderServersContent (innen immer intern: every record type) ───

  describe('renderServersContent', () => {
    const config = require('../config/default');
    let savedBase;
    let savedEnv;
    beforeEach(() => {
      savedBase = config.app.baseUrl;
      savedEnv = process.env.GC_BASE_URL;
      // the API host stays out of these tests unless one sets it
      config.app.baseUrl = 'http://localhost:3000';
      process.env.GC_BASE_URL = 'http://localhost:3000';
    });
    after(() => { config.app.baseUrl = savedBase; process.env.GC_BASE_URL = savedEnv; });

    // the lines that are not comments
    const directives = (content) => content.split('\n').filter((l) => l && !l.startsWith('#'));

    it('an enabled route: the exact name stays internal, the names below it go upstream as before', () => {
      insertRoute({ domain: 'App.Example.com' });
      insertRoute({ domain: 'off.example.com', enabled: 0 });
      assert.deepEqual(directives(dns.renderServersContent()), ['server=/app.example.com/', 'server=/*.app.example.com/#']);
    });

    it('a route below another route gets lines of its own (the longer match wins in dnsmasq)', () => {
      insertRoute({ domain: 'example.net' });
      insertRoute({ domain: 'x.example.net', route_type: 'l4' });
      assert.deepEqual(directives(dns.renderServersContent()), [
        'server=/example.net/', 'server=/*.example.net/#',
        'server=/x.example.net/', 'server=/*.x.example.net/#',
      ]);
    });

    it('never a name in a zone of the device names (local= there already; # would hand its subdomains out)', () => {
      insertRoute({ domain: 'nas.gc.internal' });
      // the portal is home.gc.internal by default: in the zone as well
      assert.deepEqual(directives(dns.renderServersContent()), []);
    });

    it('skips a malicious route domain (no extra dnsmasq directive)', () => {
      insertRoute({ domain: 'evil.example.com/\nserver=/x/' });
      insertRoute({ domain: 'a b.example.com' });
      assert.deepEqual(directives(dns.renderServersContent()), []);
    });

    it('the API host (GC_BASE_URL) is internal for every type and has its A record in the hosts file', () => {
      config.app.baseUrl = 'https://GC.Example.org:8443/path';
      process.env.GC_BASE_URL = config.app.baseUrl;
      assert.equal(dns.apiHost(), 'gc.example.org');
      assert.deepEqual(directives(dns.renderServersContent()), ['server=/gc.example.org/', 'server=/*.gc.example.org/#']);
      const hosts = dns.renderHostsContent().split('\n').filter((l) => l && !l.startsWith('#'));
      assert.ok(hosts.includes('10.8.0.1\tgc.example.org'), hosts.join('\n'));
      // once only, also when a route has the same name
      insertRoute({ domain: 'gc.example.org' });
      assert.equal(dns.renderHostsContent().split('\n').filter((l) => l === '10.8.0.1\tgc.example.org').length, 1);
      assert.deepEqual(directives(dns.renderServersContent()), ['server=/gc.example.org/', 'server=/*.gc.example.org/#']);
    });

    it('the API host: GC_WG_HOST without GC_BASE_URL; never an IP literal or a single label', () => {
      const savedHost = config.wireguard.host;
      try {
        delete process.env.GC_BASE_URL;
        config.wireguard.host = 'vpn.example.org';
        assert.equal(dns.apiHost(), 'vpn.example.org');
        config.wireguard.host = '203.0.113.7';
        assert.equal(dns.apiHost(), '');
        process.env.GC_BASE_URL = 'http://localhost:3000';
        assert.equal(dns.apiHost(), '');
        config.app.baseUrl = 'https://[2001:db8::1]/';
        process.env.GC_BASE_URL = config.app.baseUrl;
        assert.equal(dns.apiHost(), '');
      } finally {
        config.wireguard.host = savedHost;
      }
    });

    it('rebuildNow writes it next to the hosts file', () => {
      insertRoute({ domain: 'app.example.com' });
      dns.rebuildNow();
      const file = path.join(tmpDir, 'internal.servers');
      assert.equal(config.dns.serversFile, file);
      assert.deepEqual(directives(fs.readFileSync(file, 'utf8')), ['server=/app.example.com/', 'server=/*.app.example.com/#']);
      assert.equal(fs.readdirSync(tmpDir).filter((f) => f.startsWith('.internal.servers.')).length, 0);
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
