'use strict';

// WebDAV storage targets through a GateControl route or a VPN peer (since
// 1.218.0, docs/storage-targets.md "Addresses"): the driver against a small
// WebDAV server of this test, reached through stand-in routes and peers on
// 127.0.0.1 — an L4 route (direct and through a gateway's listener), an HTTP
// route through a gateway's companion proxy, a peer. The URL names a host
// that does not resolve: every byte has to go the way `via` says. http and
// https with an own CA, a self-signed certificate for another name, Range,
// COPY, MOVE, quota, the check, validation, "in use", the address rules.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { setup, teardown } = require('./helpers/setup');

const NAS = 'nas.heim.example'; // never resolves: the connection has to go through the route / peer
let agent, csrf, tmp, db;
let plain, secure, pinned, dsm, dsmLeafOnly, caddy; // { port, seen, close }
let pki;

const api = (method, p) => agent[method](p).set('X-CSRF-Token', csrf);
const targets = () => require('../src/services/storageTargets');

function peer(name, ip, type = 'client') {
  return Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, ?)").run(name, 'pk-' + name, ip + '/32', type).lastInsertRowid);
}
function route(fields) {
  const f = { route_type: 'http', target_ip: '', target_port: 80, enabled: 1, external_enabled: 0, ...fields };
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO routes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}
function gatewayMeta(peerId, proxyPort) {
  db.prepare('INSERT INTO gateway_meta (peer_id, api_token_hash, push_token_encrypted, created_at, proxy_port) VALUES (?, ?, ?, ?, ?)')
    .run(peerId, 'x', 'x', Date.now(), proxyPort);
}

/** An own CA, a server certificate for NAS signed by it, a self-signed one for "synology". */
function makePki(dir) {
  const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Heim-CA']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'nas.key', '-out', 'nas.csr', '-subj', '/CN=' + NAS]);
  fs.writeFileSync(path.join(dir, 'ext.cnf'), `subjectAltName=DNS:${NAS}\n`);
  run(['x509', '-req', '-in', 'nas.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'nas.pem', '-days', '2', '-extfile', 'ext.cnf']);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'syn.key', '-out', 'syn.pem', '-days', '2', '-subj', '/CN=synology']);
  // DSM's default certificate: a leaf for "synology" issued by "Synology Inc. CA"; one of Caddy's internal CA
  const issued = (name, ca, caCn, cn) => {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca + '.key', '-out', ca + '.pem', '-days', '2', '-subj', '/CN=' + caCn]);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn]);
    fs.writeFileSync(path.join(dir, name + '.cnf'), `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${cn}\n`);
    run(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.pem', '-CAkey', ca + '.key', '-CAcreateserial', '-out', name + '.pem', '-days', '2', '-extfile', name + '.cnf']);
  };
  issued('dsm', 'dsm-ca', 'Synology Inc. CA', 'synology');
  issued('caddy', 'caddy-ca', 'Caddy Local Authority - ECC Intermediate', NAS);
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { ca: r('ca.pem'), nasKey: r('nas.key'), nasCert: r('nas.pem'), synKey: r('syn.key'), synCert: r('syn.pem'),
    dsmKey: r('dsm.key'), dsmCert: r('dsm.pem'), dsmCa: r('dsm-ca.pem'), caddyKey: r('caddy.key'), caddyCert: r('caddy.pem'), caddyCa: r('caddy-ca.pem') };
}

/**
 * A small RFC 4918 server in memory: Basic gc:pw, PROPFIND (Depth 0 with
 * RFC 4331 quota, Depth 1), MKCOL, PUT, GET with Range, HEAD, DELETE, COPY
 * and MOVE (Overwrite: F; like Apache, the Destination must name the host
 * of the request). `seen` keeps { method, host, gatewayDomain } of each request.
 */
async function davServer(tlsOpts) {
  const files = new Map();
  const dirs = new Set(['']);
  const seen = [];
  const norm = (p) => decodeURIComponent(p).replace(/\/+$/, '').replace(/^\/+/, '');
  const parent = (p) => p.split('/').slice(0, -1).join('/');
  const handler = (req, res) => {
    seen.push({ method: req.method, host: req.headers.host, gatewayDomain: req.headers['x-gateway-target-domain'] || null });
    if (req.headers.authorization !== 'Basic ' + Buffer.from('gc:pw').toString('base64')) { res.writeHead(401); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = norm(new URL(req.url, 'http://x').pathname);
      const body = Buffer.concat(chunks);
      const m = req.method;
      if (m === 'PROPFIND') {
        if (!dirs.has(p) && !files.has(p)) { res.writeHead(404); res.end(); return; }
        let xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">';
        xml += `<d:response><d:href>/${p.split('/').map(encodeURIComponent).join('/')}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>`
          + '<d:quota-available-bytes>1000000</d:quota-available-bytes><d:quota-used-bytes>234</d:quota-used-bytes></d:prop></d:propstat></d:response>';
        if (req.headers.depth === '1') {
          for (const [k, v] of files) {
            if (parent(k) === p) xml += `<d:response><d:href>/${k.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${v.length}</d:getcontentlength></d:prop></d:propstat></d:response>`;
          }
        }
        res.writeHead(207, { 'content-type': 'application/xml' });
        res.end(xml + '</d:multistatus>');
        return;
      }
      if (m === 'MKCOL') {
        if (dirs.has(p)) { res.writeHead(405); res.end(); return; }
        if (!dirs.has(parent(p))) { res.writeHead(409); res.end(); return; }
        dirs.add(p); res.writeHead(201); res.end(); return;
      }
      if (m === 'PUT') {
        if (!dirs.has(parent(p))) { res.writeHead(409); res.end(); return; }
        files.set(p, body); res.writeHead(201); res.end(); return;
      }
      if (m === 'GET' || m === 'HEAD') {
        const f = files.get(p);
        if (!f) { res.writeHead(404); res.end(); return; }
        const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        if (r && m === 'GET') {
          const part = f.subarray(Number(r[1]), Number(r[2]) + 1);
          res.writeHead(206, { 'content-length': part.length, 'content-range': `bytes ${r[1]}-${r[2]}/${f.length}` });
          res.end(part);
          return;
        }
        res.writeHead(200, { 'content-length': f.length, 'last-modified': new Date().toUTCString() });
        res.end(m === 'GET' ? f : undefined);
        return;
      }
      if (m === 'DELETE') { const had = files.delete(p); res.writeHead(had ? 204 : 404); res.end(); return; }
      if (m === 'COPY' || m === 'MOVE') {
        let dest;
        try { dest = new URL(req.headers.destination); } catch { res.writeHead(400); res.end(); return; }
        if (dest.host !== req.headers.host) { res.writeHead(502); res.end(); return; } // Apache mod_dav: "Destination URI refers to different scheme or port"
        const to = norm(dest.pathname);
        if (!files.has(p)) { res.writeHead(404); res.end(); return; }
        if (files.has(to) && req.headers.overwrite === 'F') { res.writeHead(412); res.end(); return; }
        if (!dirs.has(parent(to))) { res.writeHead(409); res.end(); return; }
        files.set(to, files.get(p));
        if (m === 'MOVE') files.delete(p);
        res.writeHead(201); res.end(); return;
      }
      res.writeHead(405); res.end();
    });
  };
  const srv = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, files, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) };
}

const source = (buf) => ({ length: buf.length, open: (s, e) => Readable.from([buf.subarray(s, e + 1)]) });
async function collect(stream) { const p = []; for await (const c of stream) p.push(c); return Buffer.concat(p); }

before(async () => {
  ({ agent, csrfToken: csrf } = await setup());
  db = require('../src/db/connection').getDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stg-via-'));
  pki = makePki(tmp);
  plain = await davServer(null);
  secure = await davServer({ key: pki.nasKey, cert: pki.nasCert });
  pinned = await davServer({ key: pki.synKey, cert: pki.synCert });
  dsm = await davServer({ key: pki.dsmKey, cert: pki.dsmCert + pki.dsmCa });
  dsmLeafOnly = await davServer({ key: pki.dsmKey, cert: pki.dsmCert });
  caddy = await davServer({ key: pki.caddyKey, cert: pki.caddyCert + pki.caddyCa });
});
after(async () => {
  for (const s of [plain, secure, pinned, dsm, dsmLeafOnly, caddy]) if (s) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  teardown();
});

describe('WebDAV through an L4 route', () => {
  it('http: the whole check, Range, COPY, MOVE, quota — all to the route\'s target, the URL\'s host in Host', async () => {
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'nas-l4.example.com', l4_listen_port: '15005', l4_tls_mode: 'none',
      target_ip: '127.0.0.1', target_port: plain.port });
    const config = { url: `http://${NAS}:5005/dav/gc`, via: { kind: 'route', routeId: rid }, username: 'gc' };
    plain.seen.length = 0;
    const r = await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', label: 'NAS', ...config, password: 'pw' }).expect(200);
    assert.equal(r.body.check.ok, true, JSON.stringify(r.body.check));
    assert.deepEqual(r.body.check.steps.map((s) => s.step), ['connect', 'folder', 'write', 'read', 'delete']);
    assert.equal(r.body.check.free, 1000000);
    assert.equal(r.body.check.total, 1000234);
    assert.ok(plain.seen.length > 5);
    assert.ok(plain.seen.every((s) => s.host === `${NAS}:5005`), 'Host is the URL\'s host');

    const d = await targets().driverOf({ kind: 'webdav', config, secret: { password: 'pw' } });
    await d.prepare();
    const data = crypto.randomBytes(200 * 1024 + 3);
    await d.put('a/b/datei.bin', source(data));
    assert.ok((await collect(await d.get('a/b/datei.bin', { start: 65530, end: 131080 }))).equals(data.subarray(65530, 131081)));
    assert.equal(plain.seen.at(-1).method, 'GET');
    await d.copy('a/b/datei.bin', 'c/kopie.bin');
    await assert.rejects(d.copy('a/b/datei.bin', 'c/kopie.bin'), (e) => e.code === 'exists');
    await d.move('c/kopie.bin', 'c/verschoben.bin');
    assert.equal((await d.head('c/verschoben.bin')).size, data.length);
    assert.equal(await d.head('c/kopie.bin'), null);
    assert.deepEqual((await d.list('c')).map((x) => x.key), ['c/verschoben.bin']);
    assert.deepEqual(await d.space(), { free: 1000000, total: 1000234 });
  });

  it('a gateway route: the gateway\'s listener (its VPN address, the listen port), never Caddy', async () => {
    const gw = peer('gw-l4', '127.0.0.1', 'gateway');
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'nas-gw.example.com', l4_listen_port: String(plain.port), l4_tls_mode: 'none',
      target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.178.20', target_lan_port: 5005, target_port: 5005 });
    plain.seen.length = 0;
    const c = await targets().checkInput('webdav', { label: 'NAS', url: `http://${NAS}:5005/dav/gw`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(plain.seen.length > 0);
  });

  it('https with an own CA: SNI and the certificate check use the URL\'s name; without the CA: tls', async () => {
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'nas-tls.example.com', l4_listen_port: '15006', l4_tls_mode: 'none',
      target_ip: '127.0.0.1', target_port: secure.port });
    const base = { label: 'NAS', url: `https://${NAS}:5006/dav/tls`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' };
    const ok = await targets().checkInput('webdav', { ...base, tlsCa: pki.ca });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const d = await targets().driverOf({ kind: 'webdav', config: targets().normalise('webdav', { ...base, tlsCa: pki.ca }).config, secret: { password: 'pw' } });
    const data = crypto.randomBytes(70000);
    await d.put('x/y.bin', source(data));
    assert.ok((await collect(await d.get('x/y.bin', { start: 100, end: 65600 }))).equals(data.subarray(100, 65601)));

    const untrusted = await targets().checkInput('webdav', base);
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.error, 'tls');
    // the certificate names NAS, not what the URL names
    const wrongName = await targets().checkInput('webdav', { ...base, url: 'https://other.heim.example:5006/dav/tls', tlsCa: pki.ca });
    assert.equal(wrongName.error, 'tls');
  });

  it('https: a self-signed NAS certificate for another name works with exactly that certificate stored', async () => {
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'nas-syn.example.com', l4_listen_port: '15007', l4_tls_mode: 'none',
      target_ip: '127.0.0.1', target_port: pinned.port });
    const base = { label: 'NAS', url: `https://${NAS}:5006/dav/syn`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' };
    assert.equal((await targets().checkInput('webdav', { ...base, tlsCa: pki.synCert })).ok, true);
    assert.equal((await targets().checkInput('webdav', { ...base, tlsCa: pki.ca })).error, 'tls');
  });

  it('https: DSM\'s default certificate (a leaf issued by "Synology Inc. CA") works with only its cert.pem stored', async () => {
    let n = 0;
    for (const srv of [dsm, dsmLeafOnly]) {
      const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: `nas-dsm${++n}.example.com`, l4_listen_port: String(15010 + n), l4_tls_mode: 'none',
        target_ip: '127.0.0.1', target_port: srv.port });
      const base = { label: 'NAS', url: `https://${NAS}:5006/dav/dsm`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' };
      const ok = await targets().checkInput('webdav', { ...base, tlsCa: pki.dsmCert });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(ok.tls, undefined);
      // the CA itself: then the name has to match, and the URL names NAS
      assert.equal((await targets().checkInput('webdav', { ...base, tlsCa: pki.dsmCa })).error, 'tls');
    }
  });

  it('a failed TLS check shows the certificate and why; storing the offered PEM makes it pass', async () => {
    const at = (srv, n, mode = 'none') => route({ route_type: 'l4', l4_protocol: 'tcp', domain: `nas-diag${n}.example.com`, l4_listen_port: String(15020 + n), l4_tls_mode: mode,
      target_ip: '127.0.0.1', target_port: srv.port });
    const base = (rid) => ({ label: 'NAS', url: `https://${NAS}:5006/dav/diag`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' });

    // DSM sends leaf + its own CA, no own certificate stored: a CA nobody trusts
    dsm.seen.length = 0;
    const r1 = await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', ...base(at(dsm, 1)) }).expect(200);
    const c1 = r1.body.check;
    assert.equal(c1.error, 'tls');
    assert.equal(c1.tls.reason, 'untrusted_ca');
    assert.equal(c1.tls.code, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(c1.tls.host, NAS);
    assert.deepEqual(c1.tls.cert.names, ['synology']);
    assert.match(c1.tls.cert.issuer, /Synology Inc\. CA/);
    assert.match(c1.tls.cert.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(c1.tls.cert.validFrom && c1.tls.cert.validTo);
    assert.equal(c1.tls.chain.length, 2);
    assert.equal(c1.tls.chain[1].ca, true);
    assert.deepEqual(c1.tls.trust, { leaf: true, chain: true });
    assert.deepEqual(c1.tls.hints, []);
    assert.equal(dsm.seen.length, 0, 'not one request reached the server (no credentials sent)');
    // "Diesem Zertifikat vertrauen": the leaf as the target's own certificate
    assert.equal((await targets().checkInput('webdav', { ...base(at(dsm, 2)), tlsCa: c1.tls.cert.pem })).ok, true);

    // DSM sends the leaf alone: the intermediate is missing
    const c2 = (await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', ...base(at(dsmLeafOnly, 3)) }).expect(200)).body.check;
    assert.equal(c2.tls.reason, 'missing_intermediate');
    assert.deepEqual(c2.tls.hints, ['intermediate']);
    assert.deepEqual(c2.tls.trust, { leaf: true, chain: false });
    assert.equal(c2.tls.chain.length, 1);

    // the wrong certificate stored: not the one the server presents
    const c3 = await targets().checkInput('webdav', { ...base(at(dsm, 4)), tlsCa: pki.synCert });
    assert.equal(c3.tls.reason, 'not_stored');
    assert.deepEqual(c3.tls.trust, { leaf: true, chain: true });

    // the CA stored, but the URL names another host than the certificate: the names it has
    const c4 = await targets().checkInput('webdav', { ...base(at(dsm, 5)), tlsCa: pki.dsmCa });
    assert.equal(c4.tls.reason, 'name');
    assert.deepEqual(c4.tls.cert.names, ['synology']);
    assert.deepEqual(c4.tls.trust, { leaf: true, chain: false });

    // a certificate of Caddy's internal CA: GateControl decrypts itself — no offer to trust it
    const c5 = await targets().checkInput('webdav', base(at(caddy, 6)));
    assert.equal(c5.error, 'tls');
    assert.deepEqual(c5.tls.hints, ['route_decrypts']);
    assert.deepEqual(c5.tls.trust, { leaf: false, chain: false });
    // the same for an L4 route that terminates TLS
    const c6 = await targets().checkInput('webdav', base(at(dsm, 7, 'terminate')));
    assert.ok(c6.tls.hints.includes('route_decrypts'));
    assert.equal(c6.tls.trust.leaf, false);

    // https to the NAS's http port (5005 behind the route): no TLS there — not a certificate problem
    const c8 = (await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', ...base(at(plain, 9)) }).expect(200)).body.check;
    assert.equal(c8.error, 'not_tls');
    assert.match(c8.sys, /^ERR_SSL_/);
    assert.equal(c8.tls.reason, 'not_tls');
    assert.equal(c8.tls.cert, null);
    assert.deepEqual(c8.tls.trust, { leaf: false, chain: false });

    // a stored target: the same diagnosis from its "Prüfen"
    const saved = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', ...base(at(dsmLeafOnly, 8)) }).expect(201);
    const c7 = await api('post', `/api/v1/storage-targets/${saved.body.target.id}/check`).send({}).expect(200);
    assert.equal(c7.body.check.tls.reason, 'missing_intermediate');
    await api('delete', `/api/v1/storage-targets/${saved.body.target.id}`).expect(200);
  });

  it('a route to GateControl\'s own app port or the Caddy admin port is refused at "connect"', async () => {
    const appPort = require('../config/default').app.port;
    for (const p of [appPort, 2019]) {
      const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: `own-${p}.example.com`, l4_listen_port: String(20000 + (p % 1000)), l4_tls_mode: 'none',
        target_ip: '127.0.0.1', target_port: p });
      const c = await targets().checkInput('webdav', { label: 'X', url: `http://${NAS}/dav`, via: { kind: 'route', routeId: rid }, password: 'pw' });
      assert.equal(c.ok, false);
      assert.equal(c.error, 'blocked_address');
      assert.deepEqual(c.steps, [{ step: 'connect', ok: false }]);
    }
  });

  it('a route switched off is unreachable', async () => {
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'off.example.com', l4_listen_port: '15008', target_ip: '127.0.0.1', target_port: plain.port, enabled: 0 });
    const c = await targets().checkInput('webdav', { label: 'X', url: `http://${NAS}/dav`, via: { kind: 'route', routeId: rid }, password: 'pw' });
    assert.equal(c.error, 'unreachable');
  });
});

describe('WebDAV through an HTTP route and a peer', () => {
  it('an HTTP route through a gateway: its companion proxy with X-Gateway-Target-Domain (http only)', async () => {
    const gw = peer('gw-http', '127.0.0.1', 'gateway');
    gatewayMeta(gw, plain.port);
    const rid = route({ route_type: 'http', domain: 'nas-web.example.com', target_kind: 'gateway', target_peer_id: gw,
      target_lan_host: '192.168.178.20', target_lan_port: 5005, backend_https: 0 });
    plain.seen.length = 0;
    const c = await targets().checkInput('webdav', { label: 'NAS', url: `http://${NAS}:5005/dav/web`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw' });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(plain.seen.every((s) => s.gatewayDomain === 'nas-web.example.com' && s.host === `${NAS}:5005`));
    // https would be the companion's TLS connection, not checked by GateControl
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'NAS', url: `https://${NAS}:5006/dav`, via: { kind: 'route', routeId: rid }, password: 'pw' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'routeId');
    const tlsRoute = route({ route_type: 'http', domain: 'nas-web2.example.com', target_kind: 'gateway', target_peer_id: gw,
      target_lan_host: '192.168.178.20', target_lan_port: 5006, backend_https: 1 });
    const r2 = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'NAS', url: `http://${NAS}:5005/dav`, via: { kind: 'route', routeId: tlsRoute }, password: 'pw' });
    assert.equal(r2.body.field, 'routeId');
  });

  it('an HTTP route to a backend: its backend, when it speaks the URL\'s scheme', async () => {
    const rid = route({ route_type: 'http', domain: 'nas-direct.example.com', target_ip: '127.0.0.1', target_port: secure.port, backend_https: 1 });
    const c = await targets().checkInput('webdav', { label: 'NAS', url: `https://${NAS}/dav/direct`, via: { kind: 'route', routeId: rid }, username: 'gc', password: 'pw', tlsCa: pki.ca });
    assert.equal(c.ok, true, JSON.stringify(c));
    const r = await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', label: 'NAS', url: `http://${NAS}/dav`, via: { kind: 'route', routeId: rid }, password: 'pw' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'routeId');
  });

  it('a peer: its VPN address and `port` (default: the URL\'s port)', async () => {
    const pid = peer('nas-peer', '127.0.0.1');
    const c = await targets().checkInput('webdav', { label: 'NAS', url: `https://${NAS}/dav/peer`, via: { kind: 'peer', peerId: pid }, port: secure.port, username: 'gc', password: 'pw', tlsCa: pki.ca });
    assert.equal(c.ok, true, JSON.stringify(c));
    const n = targets().normalise('webdav', { label: 'NAS', url: `https://${NAS}:5006/dav`, via: { kind: 'peer', peerId: pid } });
    assert.deepEqual(n.config.via, { kind: 'peer', peerId: pid, port: 5006 });
    assert.equal(targets().normalise('webdav', { label: 'NAS', url: `http://${NAS}/dav`, via: { kind: 'peer', peerId: pid, port: 8080 } }).config.via.port, 8080);
    db.prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(pid);
    const off = await targets().checkInput('webdav', { label: 'NAS', url: `https://${NAS}/dav/peer`, via: { kind: 'peer', peerId: pid }, port: secure.port, password: 'pw', tlsCa: pki.ca });
    assert.equal(off.error, 'unreachable');
  });
});

describe('validation, choices, in use, backup', () => {
  it('refuses a missing peer or route, a UDP route and a bad port', async () => {
    const udp = route({ route_type: 'l4', l4_protocol: 'udp', domain: 'udp.example.com', l4_listen_port: '15009', target_ip: '127.0.0.1', target_port: 5005 });
    const pid = peer('nas-p2', '127.0.0.2');
    const cases = [
      [{ via: { kind: 'route', routeId: 999999 } }, 'via'],
      [{ via: { kind: 'peer', peerId: 999999 } }, 'via'],
      [{ via: { kind: 'route', routeId: udp } }, 'routeId'],
      [{ via: { kind: 'peer', peerId: pid }, port: 70000 }, 'port'],
      [{ via: { kind: 'tunnel' } }, 'via'],
    ];
    for (const [extra, field] of cases) {
      const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'X', url: `http://${NAS}/dav`, password: 'pw', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.field, field, JSON.stringify(extra));
    }
    // without via: the URL's own host, as before
    const plainTarget = targets().normalise('webdav', { label: 'X', url: 'https://nas.example.com/dav' });
    assert.deepEqual(plainTarget.config.via, { kind: 'host' });
  });

  it('choices list L4 (TCP) and HTTP routes with their type', async () => {
    const r = await api('get', '/api/v1/storage-targets/choices').expect(200);
    const l4 = r.body.routes.find((x) => x.label === 'nas-l4.example.com:15005');
    assert.equal(l4.type, 'l4');
    assert.equal(l4.internal, true);
    const web = r.body.routes.find((x) => x.label === 'nas-web.example.com');
    assert.equal(web.type, 'http');
    assert.equal(web.gateway, true);
    assert.equal(r.body.routes.some((x) => x.label === 'udp.example.com:15009'), false);
  });

  it('changing `via` of a used target is refused (409 in_use); label and password may change; stored via kept without one', async () => {
    const r1 = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'use1.example.com', l4_listen_port: '15010', target_ip: '127.0.0.1', target_port: plain.port });
    const r2 = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'use2.example.com', l4_listen_port: '15011', target_ip: '127.0.0.1', target_port: plain.port });
    const t = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'Genutzt', url: `http://${NAS}/dav/use`, via: { kind: 'route', routeId: r1 }, username: 'gc', password: 'pw' }).expect(201);
    const id = t.body.target.id;
    assert.equal(t.body.target.display, `http://${NAS}/dav/use · use1.example.com:15010`);
    targets().registerUsage((tid) => (tid === id ? [{ kind: 'area', plugin: 'gatecontrol-drive', area: 'family', label: 'Familie' }] : []));
    const url = `http://${NAS}/dav/use`;
    assert.equal((await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'G', url, via: { kind: 'route', routeId: r2 } })).status, 409);
    assert.equal((await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'G', url, via: { kind: 'host' } })).status, 409);
    const pid = peer('nas-p3', '127.0.0.3');
    assert.equal((await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'G', url, via: { kind: 'peer', peerId: pid } })).status, 409);
    const same = await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'Neuer Name', url, via: { kind: 'route', routeId: r1 }, password: 'neu' }).expect(200);
    assert.equal(same.body.target.label, 'Neuer Name');
    const kept = await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'Ohne via', url }).expect(200);
    assert.deepEqual(kept.body.target.config.via, { kind: 'route', routeId: r1 });
  });

  it('a used target from before 1.218.0 (no `via` stored) stays editable', async () => {
    const id = Number(db.prepare("INSERT INTO storage_targets (kind, label, config_json) VALUES ('webdav', 'Alt', ?)")
      .run(JSON.stringify({ url: 'https://nas.example.com/dav/', username: 'gc', tlsCa: null })).lastInsertRowid);
    targets().registerUsage((tid) => (tid === id ? [{ kind: 'area', plugin: 'gatecontrol-drive', area: 'old', label: 'Alt' }] : []));
    const r = await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'Alt, umbenannt', url: 'https://nas.example.com/dav/', via: { kind: 'host' }, username: 'gc' }).expect(200);
    assert.equal(r.body.target.display, 'https://nas.example.com/dav/');
  });

  it('a backup names the route by its domain and the peer by its name', async () => {
    const backup = require('../src/services/backup');
    const rid = route({ route_type: 'l4', l4_protocol: 'tcp', domain: 'bk.example.com', l4_listen_port: '15012', target_ip: '127.0.0.1', target_port: plain.port });
    const pid = peer('nas-bk', '127.0.0.4');
    const a = targets().create('webdav', { label: 'BK Route', url: `https://${NAS}/dav`, via: { kind: 'route', routeId: rid }, password: 'pw' });
    const b = targets().create('webdav', { label: 'BK Peer', url: `https://${NAS}/dav`, via: { kind: 'peer', peerId: pid }, port: 5006, password: 'pw' });
    const dump = JSON.parse(JSON.stringify(backup.createBackup()));
    const ea = dump.data.storage_targets.find((x) => x.target_ref === a.id);
    const eb = dump.data.storage_targets.find((x) => x.target_ref === b.id);
    assert.deepEqual(ea.config.via, { kind: 'route', route_domain: 'bk.example.com' });
    assert.deepEqual(eb.config.via, { kind: 'peer', peer_name: 'nas-bk', port: 5006 });
  });
});
