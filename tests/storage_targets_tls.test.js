'use strict';

// The own trust anchor of a storage target (`tlsCa`, docs/storage-targets.md
// "Certificates"): net.request against small https servers of this test.
// Every stored certificate is an anchor, also one that is not a self-signed
// root — the leaf of a Synology's default certificate is issued by "Synology
// Inc. CA", and storing only that leaf (cert.pem) has to work, with or
// without the CA in the server's chain, by IP or by any name. A leaf signed
// by a stored CA still has to match the URL's name; an expired certificate,
// pinned or not, and anything not stored are refused.

require('./helpers/test-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const http = require('node:http');
const tcp = require('node:net');
const { execFileSync } = require('node:child_process');

const net = require('../src/services/storageTargets/net');
const { StorageError } = require('../src/services/storageTargets/errors');

let tmp, pki;
const servers = [];

/**
 * A "Synology Inc. CA" with the NAS's leaf (name "synology", like DSM's
 * default certificate), a second leaf of the same CA (another NAS), an
 * expired leaf, a root → intermediate → leaf for "nas.heim.example" and a
 * foreign self-signed certificate. All made with openssl.
 */
function makePki(dir) {
  const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const root = (name, cn) => run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.pem', '-days', '2', '-subj', '/CN=' + cn]);
  const csr = (name, cn) => run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn]);
  const sign = (name, ca, ext) => {
    fs.writeFileSync(path.join(dir, name + '.cnf'), ext);
    run(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.pem', '-CAkey', ca + '.key', '-CAcreateserial', '-out', name + '.pem', '-days', '2', '-extfile', name + '.cnf']);
  };
  const leafExt = (dns) => `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${dns}\n`;

  root('syn-ca', 'Synology Inc. CA');
  csr('syn', 'synology'); sign('syn', 'syn-ca', leafExt('synology'));
  csr('syn2', 'synology'); sign('syn2', 'syn-ca', leafExt('synology'));
  // expired: openssl ca, the only way to set past dates with OpenSSL 3.0
  fs.writeFileSync(path.join(dir, 'index.txt'), '');
  fs.writeFileSync(path.join(dir, 'serial'), '1000\n');
  fs.writeFileSync(path.join(dir, 'ca.cnf'), '[ca]\ndefault_ca = d\n[d]\ndatabase = index.txt\nnew_certs_dir = .\nserial = serial\n'
    + 'default_md = sha256\npolicy = p\nunique_subject = no\n[p]\ncommonName = supplied\n');
  fs.writeFileSync(path.join(dir, 'old.cnf'), leafExt('synology'));
  csr('old', 'synology');
  run(['ca', '-batch', '-notext', '-config', 'ca.cnf', '-cert', 'syn-ca.pem', '-keyfile', 'syn-ca.key', '-in', 'old.csr', '-out', 'old.pem',
    '-startdate', '20200101000000Z', '-enddate', '20200102000000Z', '-extfile', 'old.cnf']);
  csr('new', 'synology');
  run(['ca', '-batch', '-notext', '-config', 'ca.cnf', '-cert', 'syn-ca.pem', '-keyfile', 'syn-ca.key', '-in', 'new.csr', '-out', 'new.pem',
    '-startdate', '20990101000000Z', '-enddate', '20990102000000Z', '-extfile', 'old.cnf']);

  root('root', 'Heim Root CA');
  csr('int', 'Heim Intermediate CA'); sign('int', 'root', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  csr('nas', 'nas.heim.example'); sign('nas', 'int', leafExt('nas.heim.example'));
  root('foreign', 'synology');

  const pair = (n) => ({ key: r(n + '.key'), cert: r(n + '.pem') });
  return {
    synCa: r('syn-ca.pem'), syn: pair('syn'), syn2: pair('syn2'), old: pair('old'), future: pair('new'),
    root: r('root.pem'), int: r('int.pem'), nas: pair('nas'), foreign: pair('foreign'),
  };
}

/** An https server presenting `cert` (+ `chain`) → its port. */
async function server(pair, chain = '') {
  const srv = https.createServer({ key: pair.key, cert: pair.cert + chain }, (q, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return srv.address().port;
}

/**
 * GET through net.request: `name` is the URL's host (never resolved: the
 * connection is dialled to 127.0.0.1, like a target behind a route), or
 * the IP itself → 'ok' or the StorageError code, plus the system's code.
 */
async function get(port, name, tlsCa) {
  const url = `https://${name}:${port}/`;
  const dial = name === '127.0.0.1' ? null : { host: '127.0.0.1', port };
  try {
    const res = await net.request({ url, dial, tlsCa });
    const body = (await net.readBody(res.stream)).toString();
    return { result: res.status === 200 && body === 'ok' ? 'ok' : 'bad answer' };
  } catch (e) {
    return { result: StorageError.from(e).code, sys: e.code };
  }
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stg-tls-'));
  pki = makePki(tmp);
});
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('storage targets: own trust anchor (tlsCa)', () => {
  it('a pinned leaf issued by a CA (Synology cert.pem) works by IP and by any name, with and without the CA in the chain', async () => {
    for (const chain of ['', pki.synCa]) {
      const port = await server(pki.syn, chain);
      for (const name of ['127.0.0.1', 'synology', 'nas.heim.example']) {
        assert.deepEqual(await get(port, name, pki.syn.cert), { result: 'ok' }, `${name}, CA in chain: ${!!chain}`);
      }
      // without any stored certificate: the system CAs do not know it
      assert.equal((await get(port, 'synology')).result, 'tls');
    }
  });

  it('the CA is trusted, too, but then the leaf has to match the URL\'s name', async () => {
    const port = await server(pki.syn, pki.synCa);
    assert.deepEqual(await get(port, 'synology', pki.synCa), { result: 'ok' });
    assert.equal((await get(port, 'nas.heim.example', pki.synCa)).sys, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal((await get(port, '127.0.0.1', pki.synCa)).result, 'tls');
  });

  it('an intermediate CA as the only anchor: its leaf with the right name works, another name not', async () => {
    const port = await server(pki.nas, pki.int);
    assert.deepEqual(await get(port, 'nas.heim.example', pki.int), { result: 'ok' });
    assert.equal((await get(port, 'synology', pki.int)).sys, 'ERR_TLS_CERT_ALTNAME_INVALID');
    // the root alone, too (the server sends the intermediate)
    assert.deepEqual(await get(port, 'nas.heim.example', pki.root), { result: 'ok' });
  });

  it('a certificate that is not stored is refused: another leaf of the same CA, a foreign self-signed one', async () => {
    const other = await server(pki.syn2, pki.synCa);
    const r1 = await get(other, 'synology', pki.syn.cert);
    assert.equal(r1.result, 'tls');
    assert.equal(r1.sys, 'SELF_SIGNED_CERT_IN_CHAIN');
    const r2 = await get(await server(pki.syn2), '127.0.0.1', pki.syn.cert);
    assert.equal(r2.result, 'tls');
    assert.match(r2.sys, /^UNABLE_TO_(?:GET_ISSUER_CERT_LOCALLY|VERIFY_LEAF_SIGNATURE)$/);
    const foreign = await server(pki.foreign);
    for (const tlsCa of [pki.syn.cert, pki.synCa]) assert.equal((await get(foreign, 'synology', tlsCa)).result, 'tls');
    // the pinned leaf does not make its CA trusted the other way round either
    assert.equal((await get(await server(pki.nas, pki.int), 'nas.heim.example', pki.syn.cert)).result, 'tls');
  });

  it('a certificate not valid yet is refused, pinned or not', async () => {
    const port = await server(pki.future, pki.synCa);
    for (const tlsCa of [pki.future.cert, pki.synCa]) assert.equal((await get(port, 'synology', tlsCa)).sys, 'CERT_NOT_YET_VALID');
  });

  it('an expired certificate is refused even when exactly that one is pinned', async () => {
    const port = await server(pki.old, pki.synCa);
    for (const tlsCa of [pki.old.cert, pki.synCa, pki.old.cert + pki.synCa]) {
      const r = await get(port, 'synology', tlsCa);
      assert.equal(r.result, 'tls');
      assert.equal(r.sys, 'CERT_HAS_EXPIRED');
    }
  });
});

describe('storage targets: reading the presented certificate (inspectTls)', () => {
  const inspect = (port, name, tlsCa) => net.inspectTls({ url: `https://${name}:${port}/dav/`, dial: { host: '127.0.0.1', port }, tlsCa });

  it('names why a certificate is not trusted, with the certificate and the chain the server sent', async () => {
    const cases = [
      [await server(pki.syn), 'synology', null, 'missing_intermediate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 1],
      [await server(pki.syn, pki.synCa), 'synology', null, 'untrusted_ca', 'SELF_SIGNED_CERT_IN_CHAIN', 2],
      [await server(pki.nas, pki.int), 'nas.heim.example', null, 'untrusted_ca', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 2],
      [await server(pki.foreign), 'synology', null, 'self_signed', 'DEPTH_ZERO_SELF_SIGNED_CERT', 1],
      [await server(pki.old, pki.synCa), 'synology', pki.synCa, 'expired', 'CERT_HAS_EXPIRED', 2],
      [await server(pki.old, pki.synCa), 'synology', pki.old.cert, 'expired', 'CERT_HAS_EXPIRED', 2],
      [await server(pki.future, pki.synCa), 'synology', pki.synCa, 'not_yet_valid', 'CERT_NOT_YET_VALID', 2],
      [await server(pki.syn2, pki.synCa), 'synology', pki.syn.cert, 'not_stored', null, 2],
      [await server(pki.syn, pki.synCa), 'nas.heim.example', pki.synCa, 'name', null, 2],
      [await server(pki.syn, pki.synCa), 'nas.heim.example', pki.syn.cert, null, null, 2],
      [await server(pki.nas, pki.int), 'nas.heim.example', pki.root, null, null, 3],
    ];
    for (const [port, name, tlsCa, reason, code, len] of cases) {
      const r = await inspect(port, name, tlsCa);
      const what = `${name} ${reason}`;
      assert.equal(r.reason, reason, what);
      if (code) assert.equal(r.code, code, what);
      assert.equal(r.host, name);
      assert.equal(r.chain.length, len, what);
      assert.equal(r.cert, r.chain[0]);
      assert.match(r.cert.fingerprint, /^[0-9a-f]{64}$/);
      assert.match(r.cert.pem, /^-----BEGIN CERTIFICATE-----/);
      if (reason !== 'self_signed') assert.equal(r.cert.ca, false);
    }
    const r = await inspect(await server(pki.syn, pki.synCa), 'synology');
    assert.deepEqual(r.cert.names, ['synology']);
    assert.match(r.cert.subject, /CN=synology/);
    assert.match(r.cert.issuer, /CN=Synology Inc\. CA/);
    assert.equal(r.chain[1].ca, true);
    assert.equal(r.chain[1].selfSigned, true);
    assert.equal(r.chain[1].pem.trim(), pki.synCa.trim());
    // what it shows is what a pinned certificate is compared with
    assert.equal(r.cert.fingerprint, net.parseCa(pki.syn.cert)[0].fingerprint);
  });

  it('only a handshake: not one application byte reaches the server, the socket is closed right away', async () => {
    const got = [];
    let closed = false;
    const srv = tls.createServer({ key: pki.syn.key, cert: pki.syn.cert + pki.synCa }, (s) => {
      s.on('data', (c) => got.push(c));
      s.on('error', () => {});
    });
    srv.on('tlsClientError', () => {}); // the client may hang up before the server has read its Finished
    srv.on('connection', (sock) => sock.on('close', () => { closed = true; }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const r = await inspect(srv.address().port, 'synology');
    assert.equal(r.reason, 'untrusted_ca');
    for (let i = 0; i < 50 && !closed; i++) await new Promise((x) => setTimeout(x, 10));
    assert.equal(closed, true);
    assert.equal(Buffer.concat(got).length, 0);
  });

  it('keeps the address rules of the real connection', async () => {
    await assert.rejects(net.inspectTls({ url: 'https://nas.heim.example/', dial: { host: '169.254.169.254', port: 443 } }), (e) => e.code === 'blocked_address');
    await assert.rejects(net.inspectTls({ url: 'http://nas.heim.example/' }), (e) => e.code === 'invalid_url');
  });
});

describe('storage targets: no TLS at all, a handshake aborted', () => {
  const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); servers.push(srv); return srv.address().port; };
  // a plain http server (Synology's http port 5000/5005 behind a route); one that answers the ClientHello with a fatal alert
  const httpPort = () => listen(http.createServer((q, res) => res.end('ok')));
  const alertPort = () => listen(tcp.createServer((c) => c.once('data', () => c.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])))));
  const reqErr = async (port, tlsCa) => {
    try { await net.request({ url: `https://synology:${port}/`, dial: { host: '127.0.0.1', port }, tlsCa }); } catch (e) { return StorageError.from(e); }
    return null;
  };

  it('an https request to a port without TLS is not_tls, not a certificate error', async () => {
    const port = await httpPort();
    for (const tlsCa of [null, pki.syn.cert]) {
      const e = await reqErr(port, tlsCa);
      assert.equal(e.code, 'not_tls');
      assert.match(e.sys, /^ERR_SSL_(?:PACKET_LENGTH_TOO_LONG|WRONG_VERSION_NUMBER|RECORD_LAYER_FAILURE|HTTP_REQUEST)$/);
      assert.ok(e.message.startsWith(e.sys));
    }
    const d = await net.inspectTls({ url: `https://synology:${port}/`, dial: { host: '127.0.0.1', port } });
    assert.deepEqual({ reason: d.reason, cert: d.cert, chain: d.chain }, { reason: 'not_tls', cert: null, chain: [] });
    assert.match(d.code, /^ERR_SSL_/);
  });

  it('a handshake aborted with an alert is tls_handshake with the code, no certificate', async () => {
    const port = await alertPort();
    const e = await reqErr(port);
    assert.equal(e.code, 'tls_handshake');
    assert.equal(e.sys, 'ERR_SSL_SSL_TLS_ALERT_HANDSHAKE_FAILURE');
    const d = await net.inspectTls({ url: `https://synology:${port}/`, dial: { host: '127.0.0.1', port } });
    assert.equal(d.reason, 'handshake');
    assert.equal(d.code, 'ERR_SSL_SSL_TLS_ALERT_HANDSHAKE_FAILURE');
    assert.equal(d.cert, null);
  });

  it('the mapping: certificate codes are tls, OpenSSL record and alert errors are not', () => {
    const from = (code, message = 'x') => { const e = new Error(message); e.code = code; return StorageError.from(e); };
    for (const c of ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      assert.equal(from(c).code, 'tls', c);
    }
    assert.equal(from('ERR_SSL_WRONG_VERSION_NUMBER').code, 'not_tls');
    assert.equal(from('ERR_SSL_PACKET_LENGTH_TOO_LONG').code, 'not_tls');
    const w = from('EPROTO', 'write EPROTO C0DC:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:../ssl/x.c:84:');
    assert.deepEqual([w.code, w.sys], ['not_tls', 'ERR_SSL_WRONG_VERSION_NUMBER']);
    const a = from('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
    assert.deepEqual([a.code, a.sys], ['tls_handshake', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION']);
    assert.equal(from('ERR_SSL_NO_PROTOCOLS_AVAILABLE').code, 'tls_handshake');
    assert.equal(from('EPROTO', 'read EPROTO').code, 'unreachable');
    assert.equal(from('ECONNRESET').code, 'unreachable');
  });
});
