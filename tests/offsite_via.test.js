'use strict';

// Off-site backup targets through a VPN peer or a GateControl route
// ("Verbindung", storageTargets/via.js — the same as the storage targets'):
// the WebDAV transport against a small https WebDAV server of this test,
// reached through a stand-in gateway peer and routes on 127.0.0.1. The URL
// names a host that does not resolve: every byte has to go the way `via`
// says, while Host, SNI and the certificate check stay the URL's. Also: the
// own trust anchor (tls_ca), the backup round trip over the API, validation,
// the "points at this server" hint, "Speicherziel übernehmen" and the
// restore of a JSON backup (peer / route ids change), SMB and SFTP via
// shim binaries (-I / -p, the dialled address).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-via-bk-'));
process.env.GC_BACKUP_DIR = backupDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// smbclient / sftp shims: record argv, answer like the tools (or refuse, see `fail`)
const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-via-shim-'));
const bin = path.join(shimRoot, 'bin');
const rec = path.join(shimRoot, 'rec');
fs.mkdirSync(bin);
fs.mkdirSync(rec);
process.env.PATH = `${bin}:${process.env.PATH}`;
const SHIM = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const rec = ${JSON.stringify(rec)};
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(path.join(rec, String(fs.readdirSync(rec).length).padStart(3, '0') + '.json'), JSON.stringify({ tool, args, stdin }));
const fail = fs.existsSync(path.join(rec, '..', 'fail'));
if (tool === 'smbclient') {
  if (fail) { process.stdout.write('do_connect: Connection to nas failed (Error NT_STATUS_CONNECTION_REFUSED)\\n'); process.exit(1); }
  process.exit(0);
}
if (fail) { process.stderr.write('ssh: connect to host 127.0.0.1 port 22: Connection refused\\r\\nConnection closed\\n'); process.exit(255); }
process.stdout.write('sftp> ls -ln\\n');
process.exit(0);
`;
for (const t of ['sftp', 'smbclient']) fs.writeFileSync(path.join(bin, t), SHIM, { mode: 0o755 });

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const NAS = 'nas.domaincaster.example'; // never resolves: the connection has to go through the peer / route
const API = '/api/v1/settings/backup';
const PASS = 'offsite passphrase 42';
let db, pki, tmp;
let secure, plain; // { port, seen, files, close }

const req = (method, url, body) => {
  const r = getAgent()[method](url).set('X-CSRF-Token', getCsrf());
  return body === undefined ? r : r.send(body);
};
const webdav = () => require('../src/services/offsite/webdav');
const offsite = () => require('../src/services/offsite');

function peer(name, ip, type = 'client') {
  return Number(db.prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, ?)').run(name, 'pk-' + name, ip + '/32', type).lastInsertRowid);
}
function route(fields) {
  const f = { route_type: 'http', target_ip: '', target_port: 80, enabled: 1, external_enabled: 0, ...fields };
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO routes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}

/** A private CA (like the user's DSM certificate) and a leaf for NAS signed by it. */
function makePki(dir) {
  const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Heim-CA']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'nas.key', '-out', 'nas.csr', '-subj', '/CN=' + NAS]);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${NAS}\n`);
  run(['x509', '-req', '-in', 'nas.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'nas.pem', '-days', '2', '-extfile', 'ext.cnf']);
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { ca: r('ca.pem'), key: r('nas.key'), cert: r('nas.pem') };
}

/**
 * A small WebDAV server (Basic gc:pw): PROPFIND depth 0/1, MKCOL, PUT, GET,
 * DELETE. `seen`: { method, host, sni, gatewayDomain, chunked } of each request.
 */
async function davServer(tlsOpts) {
  const files = new Map();
  const cols = new Set(['/', '/GateControl/']);
  const seen = [];
  const handler = (rq, res) => {
    seen.push({ method: rq.method, host: rq.headers.host, sni: rq.socket.servername || null,
      gatewayDomain: rq.headers['x-gateway-target-domain'] || null, chunked: rq.headers['transfer-encoding'] === 'chunked' });
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      if (rq.headers.authorization !== 'Basic ' + Buffer.from('gc:pw').toString('base64')) { res.writeHead(401); res.end(); return; }
      const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
      if (rq.method === 'PROPFIND') {
        if (!cols.has(p)) { res.writeHead(404); res.end(); return; }
        const items = [`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        if (rq.headers.depth === '1') {
          for (const [fp, b] of files) if (fp.startsWith(p) && !fp.slice(p.length).includes('/')) items.push(`<d:response><d:href>${encodeURI(fp)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${b.length}</d:getcontentlength></d:prop></d:propstat></d:response>`);
        }
        res.writeHead(207); res.end(`<d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`); return;
      }
      if (rq.method === 'MKCOL') {
        if (!cols.has(p.replace(/[^/]+\/$/, ''))) { res.writeHead(409); res.end(); return; }
        cols.add(p); res.writeHead(201); res.end(); return;
      }
      if (rq.method === 'PUT') { files.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); return; }
      if (rq.method === 'GET') {
        const f = files.get(p);
        if (!f) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-length': f.length }); res.end(f); return;
      }
      if (rq.method === 'DELETE') { const had = files.delete(p); res.writeHead(had ? 204 : 404); res.end(); return; }
      res.writeHead(405); res.end();
    });
  };
  const srv = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, files, cols, close: () => new Promise((r) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(r); }) };
}

async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

function records() { return fs.readdirSync(rec).sort().map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), 'utf8'))); }
function resetShim(fail = false) {
  for (const f of fs.readdirSync(rec)) fs.unlinkSync(path.join(rec, f));
  const ff = path.join(shimRoot, 'fail');
  if (fail) fs.writeFileSync(ff, '1'); else fs.rmSync(ff, { force: true });
}

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-via-pki-'));
  pki = makePki(tmp);
  secure = await davServer({ key: pki.key, cert: pki.cert });
  plain = await davServer(null);
  require('../src/services/license')._overrideForTest({ scheduled_backups: true });
});
after(async () => {
  for (const s of [secure, plain]) if (s) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(shimRoot, { recursive: true, force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
  teardown();
});

describe('WebDAV through a VPN peer with an own certificate (the DS218+ of the report)', () => {
  // Drive's storage target: Verbindung "Über ein VPN-Gerät" → the gateway peer, port 5006,
  // https://nas.domaincaster.com:5006/GateControl/, a user, "Eigenes Zertifikat" filled
  let gw;
  const cfgOf = (extra = {}) => ({ url: `https://${NAS}:5006/GateControl/Backups/`, username: 'gc', password: 'pw',
    via: { kind: 'peer', peerId: gw, port: secure.port }, tls_ca: pki.ca, ...extra });

  before(() => { gw = peer('Home Gateway', '127.0.0.1', 'gateway'); });

  it('test, upload, list, download, remove: to the peer\'s address and port; Host and SNI are the URL\'s', async () => {
    secure.seen.length = 0;
    const cfg = offsite().normalizeConfig('webdav', cfgOf());
    assert.deepEqual(cfg.via, { kind: 'peer', peerId: gw, port: secure.port });
    assert.match(await webdav().test(cfg), /folder created, write \+ delete ok/);
    const data = require('node:crypto').randomBytes(300 * 1024 + 7);
    await webdav().upload(cfg, 'gatecontrol-20261109-030000.gcbk', data);
    assert.deepEqual((await webdav().list(cfg)).map((f) => [f.name, f.size]), [['gatecontrol-20261109-030000.gcbk', data.length]]);
    assert.ok((await webdav().download(cfg, 'gatecontrol-20261109-030000.gcbk')).equals(data));
    await webdav().remove(cfg, 'gatecontrol-20261109-030000.gcbk');
    assert.equal(secure.files.size, 0);
    assert.ok(secure.seen.length >= 8);
    assert.ok(secure.seen.every((s) => s.host === `${NAS}:5006`), 'Host: the URL\'s host and port');
    assert.ok(secure.seen.every((s) => s.sni === NAS), 'SNI: the URL\'s name');
    assert.ok(secure.seen.every((s) => !s.chunked), 'bodies with Content-Length');
  });

  it('the certificate is checked against the URL\'s name: without the own CA or for another name it fails', async () => {
    const noCa = offsite().normalizeConfig('webdav', cfgOf({ tls_ca: '' }));
    await assert.rejects(webdav().list(noCa), (e) => e.code === 'TRANSPORT' && /WebDAV PROPFIND failed/.test(e.message));
    const other = offsite().normalizeConfig('webdav', cfgOf({ url: 'https://other.domaincaster.example:5006/GateControl/' }));
    await assert.rejects(webdav().list(other), (e) => e.code === 'TRANSPORT' && /altnames|Hostname/i.test(e.message));
  });

  it('a switched-off peer is a transport error, not a crash', async () => {
    const off = peer('Aus', '127.0.0.1', 'gateway');
    db.prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(off);
    const cfg = offsite().normalizeConfig('webdav', cfgOf({ via: { kind: 'peer', peerId: off, port: secure.port } }));
    await assert.rejects(webdav().list(cfg), (e) => e.code === 'TRANSPORT' && /peer is missing or switched off/.test(e.message));
  });

  it('over the API: create, test, run (a decryptable archive), files, restore test', async () => {
    await req('put', `${API}/offsite`, { passphrase: PASS }).expect(200);
    const c = await req('post', `${API}/targets`, { name: 'DS218+', type: 'webdav', keep: 3, config: cfgOf() });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const t = c.body.target;
    assert.deepEqual(t.config.via, { kind: 'peer', peerId: gw, port: secure.port });
    assert.equal(t.config.has_password, true);
    assert.equal(t.config.tls_ca_info[0].subject, 'CN=Heim-CA');
    assert.ok(!JSON.stringify(c.body).includes('"pw"'));
    const test = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(test.status, 200, JSON.stringify(test.body));
    const run = await req('post', `${API}/targets/${t.id}/run`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const up = secure.files.get(`/GateControl/Backups/${run.body.file}`);
    assert.ok(up && up.subarray(0, 5).toString() === 'GCBK1');
    const files = await req('get', `${API}/targets/${t.id}/files`);
    assert.deepEqual(files.body.files.map((f) => f.name), [run.body.file]);
    const v = await req('post', `${API}/targets/${t.id}/verify`, {});
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.file, run.body.file);
    // PUT without via / tls_ca keeps them
    const u = await req('put', `${API}/targets/${t.id}`, { name: 'DS218+ Backups' });
    assert.deepEqual(u.body.target.config.via, t.config.via);
    assert.equal(u.body.target.config.tls_ca, pki.ca.trim());
    const u2 = await req('put', `${API}/targets/${t.id}`, { config: { keep: 3 } });
    assert.deepEqual(u2.body.target.config.via, t.config.via);
  });
});

describe('WebDAV through a route', () => {
  it('an L4 route through a gateway: the gateway\'s listener; https stays end to end', async () => {
    const gw = peer('gw-l4', '127.0.0.1', 'gateway');
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'nas-l4.example.com', l4_listen_port: String(secure.port), l4_tls_mode: 'none',
      target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.178.20', target_lan_port: 5006, target_port: 5006 });
    secure.seen.length = 0;
    const cfg = offsite().normalizeConfig('webdav', { url: `https://${NAS}:5006/GateControl/L4/`, username: 'gc', password: 'pw', via: { kind: 'route', routeId: rid }, tls_ca: pki.ca });
    assert.match(await webdav().test(cfg), /write \+ delete ok/);
    assert.ok(secure.seen.length > 0 && secure.seen.every((s) => s.host === `${NAS}:5006` && s.sni === NAS));
  });

  it('an HTTP route through a gateway: its companion proxy with X-Gateway-Target-Domain (http only)', async () => {
    const gw = peer('gw-http', '127.0.0.1', 'gateway');
    db.prepare('INSERT INTO gateway_meta (peer_id, api_token_hash, push_token_encrypted, created_at, proxy_port) VALUES (?, ?, ?, ?, ?)').run(gw, 'x', 'x', Date.now(), plain.port);
    const rid = route({ route_type: 'http', domain: 'nas-web.example.com', target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.178.20', target_lan_port: 5005, backend_https: 0 });
    plain.seen.length = 0;
    const cfg = offsite().normalizeConfig('webdav', { url: `http://${NAS}:5005/GateControl/`, username: 'gc', password: 'pw', via: { kind: 'route', routeId: rid } });
    await webdav().upload(cfg, 'gatecontrol-20261109-040000.gcbk', Buffer.from('archive'));
    assert.ok(plain.seen.length > 0 && plain.seen.every((s) => s.gatewayDomain === 'nas-web.example.com' && s.host === `${NAS}:5005`));
    // https through the companion would be its TLS connection, unchecked by GateControl
    const r = await req('post', `${API}/targets`, { name: 'x', type: 'webdav', config: { url: `https://${NAS}:5006/x/`, via: { kind: 'route', routeId: rid } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_CONFIG');
    assert.equal(r.body.field, 'routeId');
  });
});

describe('validation', () => {
  it('a missing peer / route, a UDP route, a bad port, a bad certificate → INVALID_CONFIG with the field', async () => {
    const udp = route({ route_type: 'l4', l4_protocol: 'udp', domain: 'udp.example.com', l4_listen_port: '15009', target_ip: '127.0.0.1', target_port: 445 });
    const http1 = route({ route_type: 'http', domain: 'web.example.com', target_ip: '127.0.0.1', target_port: 80 });
    const pid = peer('nas-p', '127.0.0.2');
    const cases = [
      ['webdav', { url: 'https://nas.example.com/dav/', via: { kind: 'peer', peerId: 999999 } }, 'via'],
      ['webdav', { url: 'https://nas.example.com/dav/', via: { kind: 'route', routeId: 999999 } }, 'via'],
      ['webdav', { url: 'https://nas.example.com/dav/', via: { kind: 'route', routeId: udp } }, 'routeId'],
      ['webdav', { url: 'https://nas.example.com/dav/', via: { kind: 'peer', peerId: pid, port: 70000 } }, 'port'],
      ['webdav', { url: 'https://nas.example.com/dav/', via: { kind: 'tunnel' } }, 'via'],
      ['webdav', { url: 'https://nas.example.com/dav/', tls_ca: 'not a certificate' }, 'tls_ca'],
      ['smb', { host: 'nas', share: 'backup', via: { kind: 'route', routeId: udp } }, 'via'],
      ['smb', { host: 'nas', share: 'backup', via: { kind: 'route', routeId: http1 } }, 'via'],
      ['sftp', { username: 'u', via: { kind: 'peer', peerId: 999999 } }, 'via'],
      ['sftp', { username: 'u' }, 'host'],
      ['webdav', { url: 'https://nas.example.com/dav/', password_from_storage_target: 999999 }, 'password_from_storage_target'],
    ];
    for (const [type, config, field] of cases) {
      const r = await req('post', `${API}/targets`, { name: 'x', type, config });
      assert.equal(r.status, 400, JSON.stringify(config));
      assert.equal(r.body.code, 'INVALID_CONFIG', JSON.stringify(config));
      assert.equal(r.body.field, field, JSON.stringify(config));
    }
    // without via: the address itself, as before; through a peer the host is optional
    assert.deepEqual(offsite().normalizeConfig('webdav', { url: 'https://nas.example.com/dav/' }).via, { kind: 'host' });
    assert.deepEqual(offsite().normalizeConfig('smb', { share: 'backup', via: { kind: 'peer', peerId: pid } }).via, { kind: 'peer', peerId: pid, port: 445 });
    assert.deepEqual(offsite().normalizeConfig('sftp', { username: 'u', port: 2222, via: { kind: 'peer', peerId: pid } }).via, { kind: 'peer', peerId: pid, port: 2222 });
    assert.deepEqual(offsite().normalizeConfig('webdav', { url: 'https://nas.example.com:5006/dav/', via: { kind: 'peer', peerId: pid } }).via, { kind: 'peer', peerId: pid, port: 5006 });
  });
});

describe('"the address points to this server" hint', () => {
  const net = () => require('../src/services/storageTargets/net');
  const via = () => require('../src/services/storageTargets/via');
  const domains = () => require('../src/services/domains');
  let port;
  before(async () => {
    port = await closedPort();
    // the NAS name resolves to this server's own public address (a GateControl route), nothing listens on the port
    const lookup = async (h) => (h === NAS ? [{ address: '127.0.0.1', family: 4 }] : []);
    net()._setLookupForTest(lookup);
    via()._setLookupForTest(lookup);
    domains()._setServerIpsForTest({ v4: '127.0.0.1' });
  });
  after(() => { net()._setLookupForTest(null); via()._setLookupForTest(null); domains()._setServerIpsForTest(null); });

  it('WebDAV: refused at this server\'s own address → hint self_address (API, last_error_hint)', async () => {
    const cfg = { url: `https://${NAS}:${port}/GateControl/`, username: 'gc', password: 'pw' };
    await assert.rejects(webdav().list(offsite().normalizeConfig('webdav', cfg)), (e) => e.hint === 'self_address' && /ECONNREFUSED/.test(e.message) && e.message.includes(via().SELF_HINT_TEXT));
    const t = (await req('post', `${API}/targets`, { name: 'Selbst', type: 'webdav', config: cfg }).expect(201)).body.target;
    const test = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(test.status, 502);
    assert.equal(test.body.code, 'TRANSPORT_FAILED');
    assert.equal(test.body.hint, 'self_address');
    const run = await req('post', `${API}/targets/${t.id}/run`, {});
    assert.equal(run.status, 502);
    assert.equal(run.body.hint, 'self_address');
    const row = (await req('get', `${API}/targets`)).body.targets.find((x) => x.id === t.id);
    assert.equal(row.last_error_hint, 'self_address');
    await req('put', `${API}/targets/${t.id}`, { enabled: false }).expect(200);
  });

  it('no hint when the address is not this server, or when a peer is chosen', async () => {
    domains()._setServerIpsForTest({ v4: '203.0.113.9' });
    try {
      await assert.rejects(webdav().list({ url: `https://${NAS}:${port}/x/`, username: 'gc', password: 'pw' }), (e) => e.code === 'TRANSPORT' && !e.hint);
    } finally { domains()._setServerIpsForTest({ v4: '127.0.0.1' }); }
    const pid = peer('nas-refused', '127.0.0.1');
    const cfg = offsite().normalizeConfig('webdav', { url: `https://${NAS}:5006/x/`, via: { kind: 'peer', peerId: pid, port } });
    await assert.rejects(webdav().list(cfg), (e) => e.code === 'TRANSPORT' && !e.hint);
  });

  it('SMB and SFTP: the same hint from "connection refused"', async () => {
    resetShim(true);
    await assert.rejects(require('../src/services/offsite/smb').list({ host: NAS, port: 445, share: 'backup', path: '', username: 'u', password: 'p' }),
      (e) => e.code === 'TRANSPORT' && e.hint === 'self_address');
    await assert.rejects(require('../src/services/offsite/sftp').list({ host: NAS, port: 22, username: 'u', path: '' }, { privateKey: require('../src/services/offsite/sshKey').generate().privateKey }),
      (e) => e.code === 'TRANSPORT' && e.hint === 'self_address');
    resetShim(false);
  });

  it('a storage target check gets the hint too', async () => {
    const c = await require('../src/services/storageTargets').checkInput('webdav', { label: 'NAS', url: `https://${NAS}:${port}/GateControl`, password: 'pw' });
    assert.equal(c.ok, false);
    assert.equal(c.error, 'unreachable');
    assert.equal(c.hint, 'self_address');
  });
});

describe('SMB and SFTP through a peer or an L4 route', () => {
  it('smbclient connects to the peer (-I, -p), the share keeps the NAS name', async () => {
    const pid = peer('nas-smb', '127.0.0.5');
    resetShim();
    await require('../src/services/offsite/smb').list(offsite().normalizeConfig('smb', { host: 'ds218', port: 1445, share: 'backup', path: 'gc', username: 'u', password: 'p', via: { kind: 'peer', peerId: pid } }));
    const [r] = records();
    assert.equal(r.args[0], '//ds218/backup');
    assert.equal(r.args[r.args.indexOf('-I') + 1], '127.0.0.5');
    assert.equal(r.args[r.args.indexOf('-p') + 1], '1445');
  });

  it('an L4 gateway route: its listener; without a host the share is named after the address', async () => {
    const gw = peer('gw-smb', '127.0.0.6', 'gateway');
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'smb.example.com', l4_listen_port: '14450', l4_tls_mode: 'none',
      target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.178.20', target_lan_port: 445, target_port: 445 });
    resetShim();
    await require('../src/services/offsite/smb').list(offsite().normalizeConfig('smb', { share: 'backup', via: { kind: 'route', routeId: rid } }));
    const [r] = records();
    assert.equal(r.args[0], '//127.0.0.6/backup');
    assert.equal(r.args[r.args.indexOf('-I') + 1], '127.0.0.6');
    assert.equal(r.args[r.args.indexOf('-p') + 1], '14450');
  });

  it('sftp connects to the peer\'s address and port', async () => {
    const pid = peer('nas-ssh', '127.0.0.7');
    resetShim();
    await require('../src/services/offsite/sftp').list(offsite().normalizeConfig('sftp', { host: 'ds218', port: 2222, username: 'backup', path: 'gc', via: { kind: 'peer', peerId: pid } }),
      { privateKey: require('../src/services/offsite/sshKey').generate().privateKey });
    const [r] = records();
    assert.equal(r.tool, 'sftp');
    assert.equal(r.args[r.args.indexOf('-P') + 1], '2222');
    assert.deepEqual(r.args.slice(-2), ['--', '127.0.0.7']);
  });
});

describe('"Speicherziel von Drive/Plugins übernehmen"', () => {
  it('lists WebDAV / SMB storage targets without secrets; the password is copied once on save', async () => {
    const gw = peer('Home Gateway 2', '127.0.0.1', 'gateway');
    const st = await req('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'DS218+', url: `https://${NAS}:5006/GateControl/`,
      via: { kind: 'peer', peerId: gw }, port: secure.port, username: 'gc', password: 'pw', tlsCa: pki.ca });
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const r = await req('get', `${API}/targets/storage-sources`).expect(200);
    assert.ok(!JSON.stringify(r.body).includes('"pw"'), 'no password in the answer');
    const src = r.body.sources.find((x) => x.id === st.body.target.id);
    assert.equal(src.kind, 'webdav');
    assert.equal(src.has_password, true);
    assert.deepEqual(src.config.via, { kind: 'peer', peerId: gw, port: secure.port });
    assert.equal(src.config.username, 'gc');
    assert.equal(src.config.tls_ca, pki.ca.trim());

    // the form: everything taken over, another sub-folder, the password from the storage target
    const body = { name: 'DS218+ Backups', type: 'webdav', config: { ...src.config, url: `https://${NAS}:5006/GateControl/Offsite/`, password_from_storage_target: src.id } };
    const c = await req('post', `${API}/targets`, body);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.target.config.has_password, true);
    const test = await req('post', `${API}/targets/${c.body.target.id}/test`, {});
    assert.equal(test.status, 200, JSON.stringify(test.body));
    assert.ok(secure.cols.has('/GateControl/Offsite/'));
    // a copy, not a link: changing the storage target's password leaves this one
    await req('patch', `/api/v1/storage-targets/${src.id}`).send({ label: 'DS218+', url: `https://${NAS}:5006/GateControl/`, via: { kind: 'peer', peerId: gw }, port: secure.port, username: 'gc', password: 'other', tlsCa: pki.ca }).expect(200);
    assert.equal((await req('post', `${API}/targets/${c.body.target.id}/test`, {})).status, 200);
    // the wrong kind is refused
    const wrong = await req('post', `${API}/targets`, { name: 'x', type: 'smb', config: { host: 'nas', share: 'b', password_from_storage_target: src.id } });
    assert.equal(wrong.body.field, 'password_from_storage_target');
    const log = db.prepare("SELECT message FROM activity_log WHERE event_type = 'offsite_target_created' ORDER BY id DESC LIMIT 1").get();
    assert.match(log.message, /password taken from storage target "DS218\+"/);
  });
});

describe('restore of a JSON backup', () => {
  it('the peer and route of a "Verbindung" are found again by name / domain (their ids change)', async () => {
    const backup = require('../src/services/backup');
    const pid = peer('Restore Gateway', '127.0.0.1', 'gateway');
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'restore-l4.example.com', l4_listen_port: String(secure.port), l4_tls_mode: 'none', target_ip: '127.0.0.1', target_port: secure.port });
    const a = offsite().createTarget({ name: 'R Peer', type: 'webdav', enabled: false, config: { url: `https://${NAS}:5006/GateControl/R1/`, username: 'gc', password: 'pw', via: { kind: 'peer', peerId: pid, port: secure.port }, tls_ca: pki.ca } });
    const b = offsite().createTarget({ name: 'R Route', type: 'webdav', enabled: false, config: { url: `https://${NAS}:5006/GateControl/R2/`, username: 'gc', password: 'pw', via: { kind: 'route', routeId: rid }, tls_ca: pki.ca } });
    const dump = JSON.parse(JSON.stringify(await backup.createBackup()));
    await backup.restoreBackup(dump);
    const newPeer = db.prepare("SELECT id FROM peers WHERE name = 'Restore Gateway'").get().id;
    const newRoute = db.prepare("SELECT id FROM routes WHERE domain = 'restore-l4.example.com'").get().id;
    assert.notEqual(newPeer, pid, 'the restore numbered the peers anew');
    const ta = offsite().getTarget(a.id);
    const tb = offsite().getTarget(b.id);
    assert.deepEqual(ta.config.via, { kind: 'peer', peerId: newPeer, port: secure.port });
    assert.deepEqual(tb.config.via, { kind: 'route', routeId: newRoute });
    assert.equal(ta.config.has_password, true);
    // and they still reach the NAS
    const cfg = JSON.parse(require('../src/utils/crypto').decrypt(db.prepare('SELECT config_enc FROM backup_targets WHERE id = ?').get(a.id).config_enc));
    assert.match(await webdav().test(cfg), /write \+ delete ok/);
  });
});
