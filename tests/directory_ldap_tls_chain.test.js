'use strict';

// LDAPS / StartTLS against a server that sends only its leaf without the
// intermediate CA (docs/groups.md "Setting up"): ldapConn.tlsOptionsFor's
// options in a real TLS handshake. Same procedure as the storage targets
// (storageTargets/net.js caOptions): the uploaded intermediate is an anchor
// of its own, the root is not needed; nothing is weakened — a foreign CA, the
// wrong name and an untrusted leaf are still refused. tlsFailure tells a
// missing intermediate and an unknown issuer from other certificate errors.

require('./helpers/test-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const tcp = require('node:net');
const { execFileSync } = require('node:child_process');

const conn = require('../src/services/directory/ldapConn');

let tmp, pki;
const servers = [];
const DEADLINE_MS = 10000;

/** Settle a handshake: the first outcome wins; a hard deadline, never a hang. */
function settle(executor) {
  return new Promise((resolve) => {
    let done = false;
    const cleanups = [];
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const c of cleanups) { try { c(); } catch { /* closed */ } }
      resolve(v);
    };
    const timer = setTimeout(() => finish(new Error('handshake timeout')), DEADLINE_MS);
    // the outermost socket only: destroying the plain socket under a TLS
    // socket that wraps it crashes Node
    let outer = null;
    cleanups.push(() => { if (outer) outer.destroy(); });
    executor(finish, (sock) => { outer = sock; });
  });
}

/** root → intermediate → leaf for "ldap.heim.example", and a foreign root. */
function makePki(dir) {
  const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const root = (name, cn) => run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.pem', '-days', '2', '-subj', '/CN=' + cn]);
  const csr = (name, cn) => run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn]);
  const sign = (name, ca, ext) => {
    fs.writeFileSync(path.join(dir, name + '.cnf'), ext);
    run(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.pem', '-CAkey', ca + '.key', '-CAcreateserial', '-out', name + '.pem', '-days', '2', '-extfile', name + '.cnf']);
  };
  root('root', 'Heim Root CA');
  csr('int', 'Heim Intermediate CA'); sign('int', 'root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  csr('leaf', 'ldap.heim.example'); sign('leaf', 'int', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:ldap.heim.example\n');
  root('foreign', 'Fremde CA');
  return { root: r('root.pem'), int: r('int.pem'), leaf: { key: r('leaf.key'), cert: r('leaf.pem') }, foreign: r('foreign.pem') };
}

/** A TLS server presenting the leaf (+ chain) → its port (LDAPS). */
async function ldapsServer(chain = '') {
  const srv = tls.createServer({ key: pki.leaf.key, cert: pki.leaf.cert + chain }, (s) => s.end());
  srv.on('tlsClientError', () => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return srv.address().port;
}

/** A plain TCP server: one byte in, one byte out, then TLS on the same socket (like StartTLS's extended operation). */
async function startTlsServer() {
  const srv = tcp.createServer((raw) => {
    raw.once('data', () => {
      raw.write('y'); // "go ahead" (the extended operation's answer)
      const s = new tls.TLSSocket(raw, { isServer: true, key: pki.leaf.key, cert: pki.leaf.cert });
      s.on('error', () => {});
      s.on('secure', () => s.end());
    });
    raw.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return srv.address().port;
}

/** Handshake with ldapConn's TLS options → null (trusted) or the error. */
function handshake(port, cfg) {
  const opts = conn.tlsOptionsFor({ host: '127.0.0.1', security: 'ldaps', ...cfg });
  return settle((finish, track) => {
    const s = tls.connect({ host: '127.0.0.1', port, ...opts });
    track(s);
    s.once('secureConnect', () => finish(null));
    s.once('error', finish);
  });
}

/** StartTLS: plain connection, one byte, then TLS on the same socket. */
function startTls(port, cfg) {
  const opts = conn.tlsOptionsFor({ host: '127.0.0.1', security: 'starttls', ...cfg });
  return settle((finish, track) => {
    const raw = tcp.connect(port, '127.0.0.1', () => raw.write('x'));
    track(raw);
    raw.once('error', finish);
    raw.once('data', () => {
      const s = tls.connect({ socket: raw, ...opts });
      track(s);
      s.once('secureConnect', () => finish(null));
      s.once('error', finish);
    });
  });
}

describe('LDAP: server without intermediate certificate', { timeout: 120000 }, () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ldap-chain-'));
    pki = makePki(tmp);
  });
  after(() => {
    for (const s of servers) s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('tlsOptionsFor keeps verification on; an uploaded CA is a partial-chain anchor', () => {
    const plain = conn.tlsOptionsFor({ host: 'ldap.heim.example' });
    assert.equal(plain.rejectUnauthorized, true);
    assert.equal(plain.allowPartialTrustChain, undefined);
    assert.equal(plain.ca, undefined);
    const withCa = conn.tlsOptionsFor({ host: 'ldap.heim.example', caCert: pki.int });
    assert.equal(withCa.rejectUnauthorized, true);
    assert.equal(withCa.allowPartialTrustChain, true);
    assert.deepEqual(withCa.ca, [pki.int]);
    assert.equal(withCa.checkServerIdentity, undefined, 'the name is checked by Node as always');
  });

  it('LDAPS: leaf only and no CA uploaded → refused as missing intermediate', async () => {
    const port = await ldapsServer();
    const err = await handshake(port, { tlsServerName: 'ldap.heim.example' });
    assert.ok(err);
    assert.equal(err.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    assert.equal(conn.tlsFailure(err), 'missing_intermediate');
  });

  it('LDAPS: leaf only and only the root uploaded → refused, issuer unknown (upload the intermediate)', async () => {
    const port = await ldapsServer();
    const err = await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.root });
    assert.ok(err);
    assert.equal(err.code, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    assert.equal(conn.tlsFailure(err), 'unknown_issuer');
  });

  it('LDAPS: leaf only and the intermediate uploaded → trusted', async () => {
    const port = await ldapsServer();
    assert.equal(await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.int }), null);
    // root and intermediate together, too
    assert.equal(await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.root + pki.int }), null);
  });

  it('LDAPS: server sends the chain, the root uploaded → trusted (as before)', async () => {
    const port = await ldapsServer(pki.int);
    assert.equal(await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.root }), null);
  });

  it('StartTLS: leaf only and the intermediate uploaded → trusted; nothing uploaded → missing intermediate', async () => {
    const port = await startTlsServer();
    assert.equal(await startTls(port, { tlsServerName: 'ldap.heim.example', caCert: pki.int }), null);
    const err = await startTls(port, { tlsServerName: 'ldap.heim.example' });
    assert.ok(err);
    assert.equal(conn.tlsFailure(err), 'missing_intermediate');
  });

  it('nothing weakened: wrong name, foreign CA and no CA are still refused', async () => {
    const port = await ldapsServer();
    const wrongName = await handshake(port, { tlsServerName: 'other.heim.example', caCert: pki.int });
    assert.ok(wrongName);
    assert.equal(wrongName.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(conn.tlsFailure(wrongName), 'tls');
    const foreign = await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.foreign });
    assert.ok(foreign);
    assert.notEqual(conn.tlsFailure(foreign), null);
    const none = await handshake(port, { tlsServerName: 'ldap.heim.example' });
    assert.ok(none, 'the system CAs do not know this chain');
    // the leaf itself uploaded: an anchor, but only with the right name
    assert.equal(await handshake(port, { tlsServerName: 'ldap.heim.example', caCert: pki.leaf.cert }), null);
    assert.ok(await handshake(port, { tlsServerName: 'other.heim.example', caCert: pki.leaf.cert }));
  });

  it('tlsFailure: other errors are not certificate errors', () => {
    assert.equal(conn.tlsFailure(null), null);
    assert.equal(conn.tlsFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), null);
    assert.equal(conn.tlsFailure(Object.assign(new Error('x'), { name: 'InvalidCredentialsError', code: 49 })), null);
    assert.equal(conn.tlsFailure(new Error('wrapped', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) })), 'missing_intermediate');
  });
});
