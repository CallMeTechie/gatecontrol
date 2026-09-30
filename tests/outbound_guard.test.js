'use strict';

// Outbound-URL-Wächter (SSRF-Schutz für Webhooks): Adressklassen,
// Syntaxprüfung, DNS-Auflösung (gemockt), DNS-Pinning und Redirects.

require('./helpers/test-env');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  classifyIp,
  validateUrlSyntax,
  resolveAndValidate,
  safeRequest,
  OutboundUrlError,
} = require('../src/utils/outboundGuard');

describe('outboundGuard.classifyIp', () => {
  const cases = {
    public: [
      '8.8.8.8', '1.1.1.1', '203.0.113.50', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1',
      '2606:4700:4700::1111', '2a00:1450:4001::200e',
      '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
    ],
    private: [
      '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '100.64.0.1', '100.127.255.254', '198.18.0.1',
      'fc00::1', 'fd12:3456::1',
      '::ffff:10.0.0.1', '::ffff:192.168.0.1', '::ffff:c0a8:1',
      '10.8.0.5', // WireGuard-Subnetz (Default 10.8.0.0/24)
    ],
    forbidden: [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3', '169.254.169.254', '169.254.0.1',
      '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '192.0.0.192', '100.100.100.200',
      '::1', '::', '[::1]', 'fe80::1', 'fe80::1%eth0', 'ff02::1', 'fec0::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:0.0.0.0',
      '::127.0.0.1',            // IPv4-compatible (veraltet)
      '64:ff9b::7f00:1',        // NAT64 → 127.0.0.1
      '64:ff9b::a9fe:a9fe',     // NAT64 → 169.254.169.254
      '2002:7f00:1::1',         // 6to4 → 127.0.0.1
      '2001::1',                // Teredo
      '2001:db8::1',            // Dokumentation
      'fd00:ec2::254',          // AWS IMDS IPv6
      '10.8.0.1',               // eigene WireGuard-Adresse des Servers
      'not-an-ip', '', '999.1.1.1',
    ],
  };
  for (const [expected, ips] of Object.entries(cases)) {
    for (const ip of ips) {
      it(`${ip || '(empty)'} → ${expected}`, () => assert.equal(classifyIp(ip), expected));
    }
  }
});

describe('outboundGuard.validateUrlSyntax', () => {
  it('accepts public http(s) URLs', () => {
    assert.ok(validateUrlSyntax('https://hooks.slack.com/services/x'));
    assert.ok(validateUrlSyntax('http://8.8.8.8:8080/hook'));
    assert.ok(validateUrlSyntax('http://[2606:4700:4700::1111]/hook'));
  });

  it('rejects non-http protocols and garbage', () => {
    for (const u of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'data:,x']) {
      assert.throws(() => validateUrlSyntax(u), /http or https/, u);
    }
    assert.throws(() => validateUrlSyntax('not a url'), /Invalid webhook URL/);
  });

  it('rejects localhost names and loopback in every notation', () => {
    for (const u of [
      'http://localhost:2019/config/', 'http://LOCALHOST./', 'http://foo.localhost/',
      'http://127.0.0.1:2019/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
      'http://0177.0.0.1/', 'http://[::1]:2019/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    ]) {
      assert.throws(() => validateUrlSyntax(u), OutboundUrlError, u);
    }
  });

  it('rejects metadata, unspecified and link-local even with allowPrivate', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0:2019/', 'http://[::]/',
      'http://[fe80::1]/', 'http://[fd00:ec2::254]/', 'http://127.0.0.1/', 'http://10.8.0.1/',
      'http://[64:ff9b::a9fe:a9fe]/',
    ]) {
      assert.throws(() => validateUrlSyntax(u, { allowPrivate: true }), OutboundUrlError, u);
    }
  });

  it('private targets are blocked by default and allowed with the opt-in', () => {
    for (const u of ['http://192.168.1.10:8123/api/webhook/x', 'http://10.0.0.5/', 'http://[fd00::5]/', 'http://100.64.1.1/']) {
      assert.throws(() => validateUrlSyntax(u), /private or reserved/, u);
      assert.ok(validateUrlSyntax(u, { allowPrivate: true }), u);
    }
  });
});

function fakeLookup(table) {
  return async (host) => {
    if (!(host in table)) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

describe('outboundGuard.resolveAndValidate (mocked DNS)', () => {
  const lookup = fakeLookup({
    'public.example': ['93.184.216.34'],
    'lan.example': ['192.168.1.20'],
    'mixed.example': ['93.184.216.34', '10.0.0.1'],
    'loop.example': ['127.0.0.1'],
    'loop6.example': ['::1'],
    'mapped.example': ['::ffff:127.0.0.1'],
    'meta.example': ['169.254.169.254'],
  });

  it('accepts a hostname resolving to public addresses', async () => {
    const r = await resolveAndValidate('public.example', { lookup });
    assert.deepEqual(r, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a hostname resolving to a private address', async () => {
    await assert.rejects(resolveAndValidate('lan.example', { lookup }), /resolves to a private or reserved/);
  });

  it('rejects when ANY resolved address is private', async () => {
    await assert.rejects(resolveAndValidate('mixed.example', { lookup }), /resolves to a private or reserved/);
  });

  it('allowPrivate admits LAN but never loopback / metadata', async () => {
    assert.ok(await resolveAndValidate('lan.example', { lookup, allowPrivate: true }));
    for (const h of ['loop.example', 'loop6.example', 'mapped.example', 'meta.example']) {
      await assert.rejects(resolveAndValidate(h, { lookup, allowPrivate: true }), OutboundUrlError, h);
    }
  });

  it('fails closed on DNS errors', async () => {
    await assert.rejects(resolveAndValidate('nx.example', { lookup }), /could not be resolved/);
  });
});

describe('outboundGuard.safeRequest (pinning + redirects)', () => {
  let server;
  let port;
  const hits = [];
  let connects = [];
  const realRequest = http.request;
  const redirectTargets = new Map();
  /** Pfad, der mit `code` nach `location` weiterleitet. */
  const redirectPath = (location, code = 302) => {
    const id = String(redirectTargets.size + 1);
    redirectTargets.set(id, { location, code });
    return `/redirect?id=${id}`;
  };

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host });
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits[hits.length - 1].body = body;
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/redirect') {
          // Ziele kommen aus der Test-Tabelle, nicht aus der Anfrage (kein offener Redirect).
          const target = redirectTargets.get(u.searchParams.get('id'));
          if (!target) { res.writeHead(404); return res.end(); }
          res.writeHead(target.code, { Location: target.location });
          return res.end();
        }
        if (u.pathname === '/loop') {
          res.writeHead(302, { Location: '/loop' });
          return res.end();
        }
        if (u.pathname === '/big') {
          res.writeHead(200);
          return res.end(Buffer.alloc(1024 * 1024, 0x61));
        }
        if (u.pathname === '/hang') return; // nie antworten
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`ok ${req.method} ${body}`);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    // Die Wächter-Logik soll gegen "öffentliche" Adressen laufen, die TCP-
    // Verbindung landet aber beim lokalen Testserver: wir ersetzen den vom
    // Wächter gesetzten (gepinnten) lookup und merken uns, welche Adresse er
    // pinnen wollte.
    http.request = function patched(url, opts, cb) {
      const wanted = opts.lookup;
      wanted(url.hostname, {}, (err, address) => connects.push({ host: url.hostname, pinned: address }));
      assert.equal(opts.agent, false, 'guard must not reuse pooled sockets');
      const o = { ...opts, lookup: (h, lo, done) => (lo && lo.all
        ? done(null, [{ address: '127.0.0.1', family: 4 }])
        : done(null, '127.0.0.1', 4)) };
      return realRequest.call(http, url, o, cb);
    };
  });

  after(() => {
    http.request = realRequest;
    server.closeAllConnections();
    server.close();
  });

  afterEach(() => { hits.length = 0; connects = []; });

  const lookup = fakeLookup({
    'hook.example': ['93.184.216.34'],
    'other.example': ['93.184.216.35'],
    'internal.example': ['169.254.169.254'],
    'lan.example': ['192.168.1.20'],
  });

  it('connects to the validated address (DNS pinning) and sends Host of the URL', async () => {
    const res = await safeRequest(`http://hook.example:${port}/ok`, {
      method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' }, lookup,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'ok POST {"a":1}');
    assert.deepEqual(connects, [{ host: 'hook.example', pinned: '93.184.216.34' }]);
    assert.equal(hits[0].host, `hook.example:${port}`);
  });

  it('does not follow redirects by default (3xx is returned)', async () => {
    const res = await safeRequest(`http://hook.example:${port}${redirectPath(`http://other.example:${port}/ok`)}`, { lookup });
    assert.equal(res.status, 302);
    assert.equal(hits.length, 1);
  });

  it('blocks a redirect to 127.0.0.1 (Caddy admin API)', async () => {
    const target = `http://127.0.0.1:${port}/ok`;
    await assert.rejects(
      safeRequest(`http://hook.example:${port}${redirectPath(target)}`, { lookup, maxRedirects: 3 }),
      /localhost/,
    );
    await assert.rejects(
      safeRequest(`http://hook.example:${port}${redirectPath('http://localhost:2019/config/')}`, { lookup, maxRedirects: 3, allowPrivate: true }),
      /localhost/,
    );
    assert.equal(hits.length, 2, 'only the two redirecting hops were requested');
    assert.ok(hits.every((h) => h.url.startsWith('/redirect')));
  });

  it('blocks a redirect to a hostname resolving to the metadata address', async () => {
    await assert.rejects(
      safeRequest(`http://hook.example:${port}${redirectPath(`http://internal.example:${port}/ok`)}`, { lookup, maxRedirects: 3 }),
      /resolves to a private or reserved/,
    );
    assert.equal(hits.length, 1);
  });

  it('blocks a redirect to a private LAN host unless allowPrivate is set', async () => {
    const url = `http://hook.example:${port}${redirectPath(`http://lan.example:${port}/ok`)}`;
    await assert.rejects(safeRequest(url, { lookup, maxRedirects: 3 }), /private or reserved/);
    const res = await safeRequest(url, { lookup, maxRedirects: 3, allowPrivate: true });
    assert.equal(res.status, 200);
  });

  it('follows allowed redirects re-validating (and re-pinning) each hop', async () => {
    const res = await safeRequest(
      `http://hook.example:${port}${redirectPath(`http://other.example:${port}/ok`, 307)}`,
      { method: 'POST', body: 'x', lookup, maxRedirects: 3 },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'ok POST x');
    assert.deepEqual(connects.map((c) => c.pinned), ['93.184.216.34', '93.184.216.35']);
  });

  it('POST + 302 continues as GET without body', async () => {
    const res = await safeRequest(
      `http://hook.example:${port}${redirectPath('/ok')}`,
      { method: 'POST', body: 'secret', lookup, maxRedirects: 3 },
    );
    assert.equal(res.body.toString(), 'ok GET ');
  });

  it('enforces the redirect limit', async () => {
    await assert.rejects(safeRequest(`http://hook.example:${port}/loop`, { lookup, maxRedirects: 2 }), /redirect limit/);
    assert.equal(hits.length, 3);
  });

  it('caps the response size', async () => {
    const res = await safeRequest(`http://hook.example:${port}/big`, { lookup, maxBytes: 1000 });
    assert.equal(res.body.length, 1000);
    assert.equal(res.truncated, true);
  });

  it('times out', async () => {
    const t0 = Date.now();
    await assert.rejects(safeRequest(`http://hook.example:${port}/hang`, { lookup, timeoutMs: 200 }), /timed out/);
    assert.ok(Date.now() - t0 < 3000);
  });

  it('rejects a literal loopback URL without connecting', async () => {
    await assert.rejects(safeRequest(`http://127.0.0.1:${port}/ok`, { lookup }), /localhost/);
    assert.equal(hits.length, 0);
    assert.equal(connects.length, 0);
  });
});

describe('webhook service uses the guard', () => {
  const webhook = require('../src/services/webhook');

  it('deliver() refuses loopback / metadata targets', async () => {
    await assert.rejects(webhook.deliver('http://127.0.0.1:2019/load', '{}'), /localhost/);
    await assert.rejects(webhook.deliver('http://169.254.169.254/latest/meta-data/', '{}'), /private or reserved/);
    await assert.rejects(webhook.deliver('http://localhost:2019/config/', '{}'), /localhost/);
  });

  it('save-time validation blocks private targets by default', () => {
    assert.throws(() => webhook.validateWebhookUrl('http://192.168.1.10:8123/api/webhook/x'), /private or reserved/);
    assert.throws(() => webhook.validateWebhookUrl('http://[::ffff:127.0.0.1]/'), /localhost/);
  });
});
