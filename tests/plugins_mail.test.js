'use strict';

// gc.mail and gc.http.fetchImage (docs/plugins.md "Mail", since 1.216.0):
// IMAP sessions the host holds for a plugin process, SMTP, MIME, the HTML
// sanitizer, autoconfig and the picture proxy — against the tests' own IMAP,
// SMTP and HTTP servers on loopback (tests/helpers/mailServers.js), which
// stand in for public hosts. No real provider is ever asked.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');
const { testCert, imapServer, smtpServer } = require('./helpers/mailServers');
const PUI = require('../public/js/plugins-ui.js');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

let agent, csrf, runtime, plugins, hostApi, netPolicy, mail, manifest, registry, fetchImage;
let cert, imapTls, imapStarttls, imapPlain, imapBig, smtpTls, smtpStarttls, smtpPlain, smtpSlow, web, webPort;
const API = '/api/v1/plugins';
const PID = 'mail-test';
const NONE = 'mail-none';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const HOST = 'mail.test.example';
const MAIL_PERM = { purpose: { de: 'Deine Postfächer lesen und Mails senden', en: 'Read your mailboxes and send mails' }, maxConnections: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOB = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(1024 * 1024 - 2)]); // 1 MB + 7: not a multiple of 3

const RAW = [
  'From: Ann Example <ann@example.com>',
  'To: bob@example.com',
  'Subject: Rechnung November',
  'Date: Fri, 02 Jan 2026 10:00:00 +0000',
  'Message-ID: <m1@example.com>',
  'List-Id: Newsletter <news.example.com>',
  'List-Unsubscribe: <https://example.com/unsub?u=1>, <mailto:unsub@example.com>',
  'Precedence: bulk',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hallo <b>Bob</b><script>alert(1)</script></p>',
  '--b1',
  'Content-Type: application/pdf; name="rechnung.pdf"',
  'Content-Disposition: attachment; filename="rechnung.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 test invoice').toString('base64'),
  '--b1',
  'Content-Type: text/calendar; name="termin.ics"',
  'Content-Disposition: attachment; filename="termin.ics"',
  '',
  'BEGIN:VCALENDAR',
  'END:VCALENDAR',
  '--b1--',
  '',
].join('\r\n');
const RAW2 = RAW.replace('Rechnung November', 'Zweite Mail').replace('<m1@example.com>', '<m2@example.com>');

/** POST /mail of the hello plugin `id` → body */
const mailOp = async (id, body) => (await agent.post(`${API}/${id}/api/mail`).set('X-CSRF-Token', csrf).send(body)).body;
const gcOf = async (id, fn, ...args) => (await agent.post(`${API}/${id}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const server = (port, security = port === 993 || port === 465 ? 'tls' : 'starttls') => ({ host: HOST, port, security });
const auth = { user: 'bob', pass: 's3cret-pass' };
const connect = (opts, id = PID) => mailOp(id, { op: 'connect', opts: { ...server(993), auth, ...opts } });
const call = (sid, method, ...args) => mailOp(PID, { op: 'call', id: sid, method, args });

async function install(id, permissions, extra = {}) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
    .send(helloPackage({ overrides: { id, name: { de: id, en: id }, permissions, ...extra } })).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning(id), true);
  return r.body;
}

let inspected;
before(async () => {
  cert = testCert([HOST]);
  const users = { bob: 's3cret-pass' };
  imapTls = imapServer({ secure: true, cert, users, messages: [{ uid: 1, flags: ['\\Seen'], raw: RAW }, { uid: 2, flags: [], raw: RAW2 }] });
  imapStarttls = imapServer({ starttls: true, cert, users, messages: [{ uid: 7, flags: [], raw: RAW }] });
  imapPlain = imapServer({ starttls: false, cert, users, messages: [] });
  imapBig = imapServer({ secure: true, cert, users, messages: Array.from({ length: 501 }, (_x, i) => ({ uid: i + 1, flags: [], raw: RAW })) });
  smtpTls = smtpServer({ secure: true, cert, users, rejectRcpt: /reject/ });
  smtpStarttls = smtpServer({ starttls: true, cert, users });
  smtpPlain = smtpServer({ starttls: false, cert, users });
  smtpSlow = smtpServer({ secure: true, cert, users, greetingDelayMs: 400 });
  for (const s of [imapTls, imapStarttls, imapPlain, imapBig, smtpTls, smtpStarttls, smtpPlain, smtpSlow]) s.port = await s.start();
  web = http.createServer((req, res) => {
    web.seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/up')) {
      // gc.http.fetch with bodyMedia: what arrived, byte for byte
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        web.uploads.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
        if (req.url === '/up-redirect') { res.writeHead(307, { location: '/up' }); res.end(); return; }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ got: Buffer.concat(chunks).length }));
      });
      return;
    }
    if (req.url === '/blob.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(BLOB); return; }
    if (req.url === '/big.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.alloc(4 * 1024 * 1024 + 1, 7)); return; }
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(40, 1)]);
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])); return; }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hi</html>'); return; }
    if (req.url === '/fake.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html><script>alert(1)</script></html>'); return; }
    if (req.url === '/x.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); return; }
    if (req.url === '/to-private') { res.writeHead(302, { location: `http://intranet.test.example:${webPort}/pic.png` }); res.end(); return; }
    if (req.url === '/to-loopback') { res.writeHead(302, { location: `http://127.0.0.2:${webPort}/pic.png` }); res.end(); return; }
    if (req.url === '/to-pic') { res.writeHead(301, { location: '/pic.png' }); res.end(); return; }
    const hop = /^\/loop\/(\d+)$/.exec(req.url);
    if (hop) { res.writeHead(302, { location: `/loop/${Number(hop[1]) + 1}` }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  web.seen = [];
  web.uploads = [];
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;

  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  hostApi = require('../src/services/plugins/hostApi');
  netPolicy = require('../src/services/plugins/netPolicy');
  mail = require('../src/services/plugins/mail');
  manifest = require('../src/services/plugins/manifest');
  registry = require('../src/services/plugins/registry');
  fetchImage = require('../src/services/plugins/fetchImage');
  netPolicy._setTestPrivateForTest({ '127.0.0.1': 'public' });
  netPolicy._setReservedForTest(['10.8.0.0/24']);
  hostApi._lookup = async (h) => {
    if (h === HOST || h === 'other.test.example' || h === 'img.test.example' || h === 'up.cloud.example') return [{ address: '127.0.0.1', family: 4 }];
    if (h === 'intranet.test.example' || h === 'lan.cloud.example') return [{ address: '192.168.1.10', family: 4 }];
    if (h === 'cgnat.test.example') return [{ address: '100.64.1.2', family: 4 }];
    if (h === 'mixed.test.example') return [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.3', family: 4 }];
    if (h === 'wg.test.example') return [{ address: '10.8.0.5', family: 4 }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  mail._setSeams({ net: { ports: { 993: imapTls.port, 143: imapStarttls.port, 465: smtpTls.port, 587: smtpStarttls.port }, ca: cert.cert } });
  fetchImage._setPortsForTest([webPort]);
  const perms = clone(helloManifest.permissions);
  inspected = await install(PID, { ...perms, network: { ...perms.network, images: true }, mail: MAIL_PERM },
    { media: { maxBytes: 26214400, types: ['application/pdf'], quotaDefault: '1GB' } });
  await install(NONE, clone(helloManifest.permissions));
});

after(async () => {
  hostApi._lookup = null;
  netPolicy._setTestPrivateForTest(null);
  netPolicy._setReservedForTest(null);
  mail._setSeams(null);
  fetchImage._setPortsForTest(null);
  await plugins.stop();
  teardown();
  for (const s of [imapTls, imapStarttls, imapPlain, imapBig, smtpTls, smtpStarttls, smtpPlain, smtpSlow]) await s.stop();
  await new Promise((r) => web.close(r));
});

beforeEach(() => {
  mail._setSeams({ net: { ports: { 993: imapTls.port, 143: imapStarttls.port, 465: smtpTls.port, 587: smtpStarttls.port }, ca: cert.cert } });
});

// ─── plugin.json ────────────────────────────────

describe('plugin.json: permissions.mail, network.images, consent', () => {
  const base = () => clone(helloManifest);
  const errs = (fn) => { const m = base(); fn(m); return manifest.validate(m).errors; };

  it('permissions.mail { purpose, maxConnections 1…200 (default 50) }', () => {
    const m = base();
    assert.equal(manifest.validate(m).manifest.permissions.mail, null);
    m.permissions.mail = { purpose: 'Postfächer lesen' };
    assert.deepEqual(manifest.validate(m).manifest.permissions.mail, { purpose: { de: 'Postfächer lesen', en: 'Postfächer lesen' }, maxConnections: 50 });
    m.permissions.mail = { purpose: { de: 'a', en: 'b' }, maxConnections: 200 };
    assert.equal(manifest.validate(m).manifest.permissions.mail.maxConnections, 200);
    assert.deepEqual(errs((x) => { x.permissions.mail = true; }), ['permissions.mail: invalid']);
    assert.deepEqual(errs((x) => { x.permissions.mail = { purpose: 'x', other: 1 }; }), ['permissions.mail: invalid']);
    assert.deepEqual(errs((x) => { x.permissions.mail = {}; }), ['permissions.mail: invalid (needs a purpose)']);
    for (const bad of [0, 201, 1.5, '10']) {
      assert.deepEqual(errs((x) => { x.permissions.mail = { purpose: 'x', maxConnections: bad }; }), ['permissions.mail.maxConnections: invalid'], String(bad));
    }
  });

  it('permissions.network.images: boolean', () => {
    const m = base();
    assert.equal(manifest.validate(m).manifest.permissions.network.images, false);
    m.permissions.network.images = true;
    assert.equal(manifest.validate(m).manifest.permissions.network.images, true);
    assert.deepEqual(errs((x) => { x.permissions.network.images = 'yes'; }), ['permissions.network.images: invalid']);
  });

  it('the install dialog and the plugin card name both, marked as sensitive (DE/EN)', () => {
    const perm = inspected.plugin.permissions;
    assert.equal(perm.mail.maxConnections, 2);
    assert.ok([MAIL_PERM.purpose.de, MAIL_PERM.purpose.en].includes(perm.mail.purpose), perm.mail.purpose);
    assert.equal(perm.network.images, true);
    for (const dict of [de, en]) {
      const t = (k, p) => { let s = dict[k] || k; for (const [a, b] of Object.entries(p || {})) s = s.split('{{' + a + '}}').join(String(b)); return s; };
      const rows = PUI.permRows(perm, t);
      const mailRow = rows.find((r) => r.label === dict['plugins.perm.mail']);
      const imgRow = rows.find((r) => r.label === dict['plugins.perm.images']);
      assert.ok(mailRow && imgRow, JSON.stringify(rows));
      assert.match(mailRow.value, dict === de ? /darf sich mit Mail-Servern im Internet verbinden \(IMAP und SMTP, nur verschlüsselt\) und in deinem Namen Mails senden/
        : /may connect to mail servers on the internet \(IMAP and SMTP, encrypted only\) and send mails on your behalf/);
      assert.ok(mailRow.value.endsWith(perm.mail.purpose), mailRow.value);
      assert.match(imgRow.value, dict === de ? /lädt Bilder aus Mails stellvertretend aus dem Internet/ : /loads pictures in mails from the internet on your behalf/);
    }
    const sens = PUI.sensitivePerms(perm);
    assert.ok(sens.includes('plugins.perm.mail') && sens.includes('plugins.perm.images'));
  });

  it('without the permissions there is no gc.mail and no gc.http.fetchImage in the plugin process', async () => {
    assert.deepEqual(await mailOp(NONE, { op: 'has' }), { ok: true, mail: 'undefined', connect: 'undefined', fetchImage: 'undefined', verify: 'undefined', mediaBase64: '{{gc:media:base64}}' });
    assert.deepEqual(await mailOp(PID, { op: 'has' }), { ok: true, mail: 'object', connect: 'function', fetchImage: 'function', verify: 'function', mediaBase64: '{{gc:media:base64}}' });
    // and the host refuses the calls themselves
    const none = registry.get(NONE);
    await assert.rejects(() => hostApi.handle(none, 'mail.imap.connect', { ...server(993), auth }, { emit() {} }), (e) => e.code === 'ERR_MAIL_DENIED');
    await assert.rejects(() => hostApi.handle(none, 'mail.sanitize', { html: '<p>x</p>' }), (e) => e.code === 'ERR_MAIL_DENIED');
    await assert.rejects(() => hostApi.handle(none, 'http.fetchImage', { url: `http://img.test.example:${webPort}/pic.png` }), (e) => e.code === 'ERR_NETWORK_DENIED');
  });
});

// ─── Network check ──────────────────────────────

describe('mail servers: public addresses only, the four ports, TLS always', () => {
  const net = () => require('../src/services/plugins/mail/net');
  const opts = () => ({ lookup: hostApi._lookup });
  const code = async (kind, o) => { try { await net().endpoint(kind, o, opts()); return 'ok'; } catch (e) { return e.code; } };

  it('IMAP 993/tls and 143/starttls, SMTP 465/tls and 587/starttls; other ports → ERR_NETWORK_DENIED', async () => {
    assert.equal(await code('imap', server(993)), 'ok');
    assert.equal(await code('imap', server(143)), 'ok');
    assert.equal(await code('smtp', server(465)), 'ok');
    assert.equal(await code('smtp', server(587)), 'ok');
    for (const port of [25, 110, 995, 80, 443, 2525, 465]) assert.equal(await code('imap', { host: HOST, port }), 'ERR_NETWORK_DENIED', `imap ${port}`);
    for (const port of [25, 2525, 993, 143]) assert.equal(await code('smtp', { host: HOST, port }), 'ERR_NETWORK_DENIED', `smtp ${port}`);
  });

  it('never in plain text: the security has to fit the port', async () => {
    assert.equal(await code('imap', { host: HOST, port: 993, security: 'starttls' }), 'ERR_INVALID');
    assert.equal(await code('imap', { host: HOST, port: 143, security: 'tls' }), 'ERR_INVALID');
    assert.equal(await code('imap', { host: HOST, port: 143, security: 'none' }), 'ERR_INVALID');
    assert.equal(await code('smtp', { host: HOST, port: 587, security: false }), 'ERR_INVALID');
    const ep = await net().endpoint('imap', { host: HOST, port: 143 }, opts());
    assert.equal(ep.security, 'starttls', 'without security the port decides');
  });

  it('private, loopback, link-local, CGNAT, ULA, multicast, WireGuard → ERR_NETWORK_DENIED; DNS pinned', async () => {
    for (const host of ['intranet.test.example', 'cgnat.test.example', 'mixed.test.example', 'wg.test.example', '10.0.0.1', '192.168.0.10',
      '127.0.0.2', '169.254.169.254', '100.64.0.1', 'fd00::1', 'fe80::1', '224.0.0.1', '0.0.0.0', '255.255.255.255', '::1']) {
      assert.equal(await code('imap', { host, port: 993 }), 'ERR_NETWORK_DENIED', host);
    }
    assert.equal(await code('imap', { host: 'nowhere.test.example', port: 993 }), 'ERR_MAIL_NET', 'a name that does not resolve');
    assert.equal(await code('imap', { host: 'bad host', port: 993 }), 'ERR_INVALID');
    const ep = await net().endpoint('imap', server(993), opts());
    assert.equal(ep.address, '127.0.0.1', 'the connection goes to the checked address');
    assert.equal(ep.host, HOST);
    const tlsOpts = net().tlsOptions(HOST);
    assert.equal(tlsOpts.rejectUnauthorized, true);
    assert.equal(tlsOpts.minVersion, 'TLSv1.2');
    assert.equal(tlsOpts.servername, HOST);
  });
});

// ─── IMAP ───────────────────────────────────────

describe('gc.mail.imap through the plugin process', () => {
  it('connects over TLS: capabilities, folders, status, open, fetch, search, flags, move, close', async () => {
    const c = await connect();
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(c.capabilities.includes('IDLE'));
    assert.equal(c.serverInfo, null);
    const list = (await call(c.id, 'list')).result;
    assert.deepEqual(list.map((x) => [x.path, x.specialUse]), [['INBOX', '\\Inbox'], ['Sent', '\\Sent']]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['delimiter', 'flags', 'name', 'parent', 'path', 'specialUse', 'subscribed']);
    const st = (await call(c.id, 'status', 'INBOX', { messages: true, unseen: true, uidNext: true, uidValidity: true })).result;
    assert.deepEqual(st, { path: 'INBOX', messages: 2, unseen: 1, uidNext: 3, uidValidity: 1700 });
    const open = (await call(c.id, 'open', 'INBOX')).result;
    assert.deepEqual(open, { path: 'INBOX', uidValidity: 1700, uidNext: 3, exists: 2, highestModseq: null });
    const f = (await call(c.id, 'fetch', '1:*', { envelope: true, flags: true, size: true, internalDate: true, headers: ['list-id', 'precedence'] })).result;
    assert.equal(f.length, 2);
    assert.deepEqual(f[0].flags, ['\\Seen']);
    assert.equal(f[0].envelope.subject, 'Rechnung November');
    assert.deepEqual(f[0].envelope.from, [{ name: 'Ann Example', address: 'ann@example.com' }]);
    assert.equal(f[0].envelope.messageId, '<m1@example.com>');
    assert.equal(typeof f[0].internalDate, 'number');
    assert.deepEqual(f[0].headers, { 'list-id': 'Newsletter <news.example.com>', precedence: 'bulk' });
    assert.deepEqual((await call(c.id, 'fetch', [2], { flags: true })).result, [{ uid: 2, flags: [] }]);
    assert.deepEqual((await call(c.id, 'search', { seen: false })).result, [2]);
    assert.equal((await call(c.id, 'flags', [2], { add: ['\\Seen', '\\Flagged'] })).result, true);
    assert.deepEqual((await call(c.id, 'search', { seen: false })).result, []);
    assert.deepEqual((await call(c.id, 'move', '2', 'Sent')).result, { uidMap: { 2: 1 } });
    assert.equal((await call(c.id, 'noop')).result, true);
    const before1 = imapTls.open();
    assert.equal((await call(c.id, 'close')).ok, true);
    await sleep(200);
    assert.equal(imapTls.open(), before1 - 1, 'the host ended the connection');
    const gone = await call(c.id, 'list');
    assert.equal(gone.ok, false);
    // the mailbox was changed: back to two messages for the other tests
    imapTls.state.mailboxes.INBOX.messages.push({ uid: 2, flags: [], raw: RAW2 });
  });

  it('message(): parsed with mailparser; attachments as metadata or unclaimed media files', async () => {
    const c = await connect();
    await call(c.id, 'open', 'INBOX', { readOnly: true });
    const meta = (await call(c.id, 'message', 1)).result;
    assert.equal(meta.subject, 'Rechnung November');
    assert.deepEqual(meta.from, { name: 'Ann Example', address: 'ann@example.com' });
    assert.equal(meta.messageId, '<m1@example.com>');
    assert.equal(meta.listId, 'news.example.com');
    assert.equal(meta.precedence, 'bulk');
    assert.deepEqual(meta.listUnsubscribe, { url: 'https://example.com/unsub?u=1', mail: 'unsub@example.com' });
    assert.ok(meta.html.includes('<script>alert(1)</script>'), 'html as the mail has it — gc.mail.sanitize cleans it');
    assert.equal(meta.attachments.length, 2);
    const pdf = meta.attachments[0];
    assert.equal(pdf.filename, 'rechnung.pdf');
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.size, '%PDF-1.4 test invoice'.length);
    assert.equal(pdf.checksum, crypto.createHash('sha256').update('%PDF-1.4 test invoice').digest('hex'));
    assert.equal(pdf.mediaId, null);
    assert.equal(pdf.partId, '2');
    const full = (await call(c.id, 'message', 1, { attachments: 'media' })).result;
    for (const a of full.attachments) {
      assert.match(a.mediaId, /^[0-9a-f]{32}$/);
      const info = (await gcOf(PID, 'media.info', a.mediaId)).result;
      assert.equal(info.claimed, false, 'unclaimed, removed after 24 h unless claimed');
      assert.equal(info.sha256, a.checksum);
      assert.equal(info.bytes, a.size);
    }
    // stored with the mail's own type, even one media.types does not list
    assert.equal((await gcOf(PID, 'media.info', full.attachments[1].mediaId)).result.mime, 'text/calendar');
    const big = await call(c.id, 'message', 1, { maxBytes: 100 });
    assert.equal(big.code, 'ERR_MAIL_LIMIT');
    assert.equal((await call(c.id, 'message', 99)).code, 'ERR_INVALID');
    await call(c.id, 'close');
  });

  it('IDLE: new mail reaches the plugin as an "exists" event; a command in between and IDLE goes on', async () => {
    const c = await connect();
    await call(c.id, 'open', 'INBOX');
    assert.equal((await call(c.id, 'idle')).result, true);
    await sleep(300);
    assert.equal(imapTls.state.idling.size >= 1, true, 'the host sent IDLE');
    imapTls.deliver(RAW.replace('<m1@', '<m3@'));
    await sleep(300);
    let ev = (await mailOp(PID, { op: 'events', id: c.id })).events;
    assert.deepEqual(ev.find((e) => e.ev === 'exists').data, { path: 'INBOX', count: 3, prevCount: 2 });
    // a command breaks IDLE, afterwards the host starts it again
    assert.equal((await call(c.id, 'search', { seen: false })).ok, true);
    await sleep(300);
    assert.equal(imapTls.state.idling.size >= 1, true, 'IDLE again after the command');
    imapTls.deliver(RAW.replace('<m1@', '<m4@'));
    await sleep(300);
    ev = (await mailOp(PID, { op: 'events', id: c.id })).events;
    assert.equal(ev.filter((e) => e.ev === 'exists').length, 2);
    await call(c.id, 'close');
    imapTls.state.mailboxes.INBOX.messages.splice(2);
  });

  it('append(): a composed message from the plugin\'s media goes into a folder', async () => {
    const comp = (await gcOf(PID, 'mail.compose', { from: { name: 'Bob', address: 'bob@example.com' }, to: ['ann@example.com'], subject: 'Entwurf', text: 'Hallo' })).result;
    assert.match(comp.mediaId, /^[0-9a-f]{32}$/);
    const c = await connect();
    const r = (await call(c.id, 'append', 'Sent', comp.mediaId, { flags: ['\\Seen'] })).result;
    assert.equal(typeof r.uid, 'number');
    const appended = imapTls.state.appended[imapTls.state.appended.length - 1];
    assert.equal(appended.mailbox, 'Sent');
    assert.match(appended.raw, /Subject: Entwurf/);
    assert.equal((await call(c.id, 'append', 'Sent', 'f'.repeat(32))).code, 'ERR_INVALID', 'only its own media');
    await call(c.id, 'close');
  });

  it('STARTTLS on 143: nothing but STARTTLS in plain text; a server without STARTTLS → ERR_MAIL_NET, no login sent', async () => {
    const c = await connect(server(143));
    assert.equal(c.ok, true, JSON.stringify(c));
    const cmds = imapStarttls.state.commands;
    assert.deepEqual(cmds.filter((x) => !x.secure).map((x) => x.cmd), ['STARTTLS']);
    assert.ok(cmds.some((x) => x.cmd === 'LOGIN' && x.secure));
    await call(c.id, 'close');
    mail._setSeams({ net: { ports: { 993: imapTls.port, 143: imapPlain.port }, ca: cert.cert } });
    const r = await connect(server(143));
    assert.equal(r.code, 'ERR_MAIL_NET');
    assert.equal(imapPlain.state.commands.some((x) => x.cmd === 'LOGIN'), false, 'the password never went out in plain text');
  });

  it('error codes: ERR_MAIL_AUTH (serverText without credentials), ERR_MAIL_NET (certificate), ERR_NETWORK_DENIED, ERR_INVALID', async () => {
    const a = await connect({ auth: { user: 'bob', pass: 'wrong-pass-123' } });
    assert.equal(a.code, 'ERR_MAIL_AUTH');
    assert.match(a.serverText, /invalid credentials/);
    assert.doesNotMatch(a.serverText, /wrong-pass-123|bob/);
    assert.ok(a.serverText.length <= 200);
    const t = await connect({ host: 'other.test.example' });
    assert.equal(t.code, 'ERR_MAIL_NET', 'the certificate does not name the host');
    assert.match(t.error, /TLS/);
    mail._setSeams({ net: { ports: { 993: imapTls.port }, ca: null } });
    assert.equal((await connect()).code, 'ERR_MAIL_NET', 'a certificate nobody trusts');
    assert.equal((await connect({ host: 'intranet.test.example' })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await connect({ port: 110 })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await connect({ auth: { user: 'bob' } })).code, 'ERR_INVALID');
    assert.equal((await connect({ auth: { user: 'bob', pass: 'x', accessToken: 'y' } })).code, 'ERR_INVALID');
  });

  it('maxConnections: at most permissions.mail.maxConnections sessions at a time (ERR_MAIL_LIMIT)', async () => {
    assert.equal(mail.stats(PID).sessions, 0, 'every earlier test closed its sessions');
    const a = await connect();
    const b = await connect();
    assert.equal(a.ok && b.ok, true);
    const c = await connect();
    assert.equal(c.code, 'ERR_MAIL_LIMIT');
    await call(a.id, 'close');
    const d = await connect();
    assert.equal(d.ok, true, 'room again after a close');
    await call(b.id, 'close');
    await call(d.id, 'close');
  });

  it('fetch(): more than 500 messages in a range → ERR_INVALID; bad ranges → ERR_INVALID', async () => {
    mail._setSeams({ net: { ports: { 993: imapBig.port }, ca: cert.cert } });
    const c = await connect();
    await call(c.id, 'open', 'INBOX');
    assert.equal((await call(c.id, 'fetch', '1:*', { flags: true })).code, 'ERR_INVALID');
    assert.equal((await call(c.id, 'fetch', '1:500', { flags: true })).result.length, 500);
    assert.equal((await call(c.id, 'fetch', '1;2', { flags: true })).code, 'ERR_INVALID');
    assert.equal((await call(c.id, 'search', { evil: 1 })).code, 'ERR_INVALID');
    await call(c.id, 'close');
  });

  it('the sessions end with the plugin process', async () => {
    const a = await connect();
    assert.equal(a.ok, true);
    await sleep(100);
    const openBefore = imapTls.open();
    assert.equal(mail.stats(PID).sessions, 1);
    await agent.post(`${API}/${PID}/api/crash`).set('X-CSRF-Token', csrf);
    await sleep(500);
    assert.equal(mail.stats(PID).sessions, 0);
    assert.equal(imapTls.open(), openBefore - 1, 'the host closed the orphaned connection');
    assert.equal(await runtime.waitRunning(PID, 20000), true);
    assert.equal((await call(a.id, 'list')).ok, false, 'the old session is gone in the new process');
  });
});

// ─── SMTP ───────────────────────────────────────

describe('gc.mail.smtp.send', () => {
  const message = {
    from: { name: 'Bob', address: 'bob@example.com' },
    to: [{ name: 'Ann', address: 'ann@example.com' }, 'x-reject@example.com'],
    bcc: ['hidden@example.com'],
    subject: 'Termin', text: 'Hallo', html: '<p>Hallo</p>',
    headers: { 'X-Mailer-Id': '42', 'List-Unsubscribe': '<mailto:u@example.com>' },
  };
  const send = (o) => gcOf(PID, 'mail.smtp.send', { ...server(465), auth, message, ...o });

  it('sends over TLS: accepted / rejected, Bcc not in the mail, a copy for "Gesendet" as unclaimed media', async () => {
    const r = await send({ appendCopy: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result.accepted, ['ann@example.com', 'hidden@example.com']);
    assert.deepEqual(r.result.rejected, ['x-reject@example.com']);
    assert.match(r.result.messageId, /^<.+@example\.com>$/);
    const got = smtpTls.state.mails[smtpTls.state.mails.length - 1];
    assert.equal(got.secure, true);
    assert.deepEqual(got.to, ['ann@example.com', 'hidden@example.com']);
    assert.doesNotMatch(got.raw, /^Bcc:/im);
    assert.match(got.raw, /^X-Mailer-Id: 42/im);
    const info = (await gcOf(PID, 'media.info', r.result.raw.mediaId)).result;
    assert.equal(info.claimed, false);
    assert.equal(info.mime, 'message/rfc822');
    assert.equal(info.bytes, r.result.raw.bytes);
    const plain = await send({});
    assert.equal(plain.result.raw, null, 'no copy without appendCopy');
  });

  it('STARTTLS on 587 before AUTH; without STARTTLS → ERR_MAIL_NET and no AUTH, no mail', async () => {
    const r = await send({ ...server(587) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const cmds = smtpStarttls.state.commands;
    assert.deepEqual(cmds.filter((x) => !x.secure).map((x) => x.cmd), ['EHLO', 'STARTTLS']);
    mail._setSeams({ net: { ports: { 587: smtpPlain.port }, ca: cert.cert } });
    const n = await send({ ...server(587) });
    assert.equal(n.code, 'ERR_MAIL_NET');
    assert.equal(smtpPlain.state.commands.some((x) => x.cmd === 'AUTH' || x.cmd === 'MAIL'), false);
  });

  it('error codes: ERR_MAIL_AUTH, ERR_MAIL_REJECTED (serverText), ERR_INVALID, ERR_NETWORK_DENIED', async () => {
    const a = await send({ auth: { user: 'bob', pass: 'nope-nope' } });
    assert.equal(a.code, 'ERR_MAIL_AUTH');
    assert.doesNotMatch(a.serverText, /nope-nope/);
    const rej = await send({ message: { ...message, to: ['reject@example.com'], bcc: [] } });
    assert.equal(rej.code, 'ERR_MAIL_REJECTED');
    assert.match(rej.serverText, /550/);
    assert.equal((await send({ message: { ...message, headers: { Received: 'x' } } })).code, 'ERR_INVALID', 'X-… and List-Unsubscribe only');
    assert.equal((await send({ message: { ...message, to: ['a@b.c\r\nBcc: evil@x.y'] } })).code, 'ERR_INVALID');
    assert.equal((await send({ message: { ...message, attachments: [{ mediaId: 'f'.repeat(32) }] } })).code, 'ERR_INVALID');
    assert.equal((await send({ port: 25 })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await send({ host: 'intranet.test.example' })).code, 'ERR_NETWORK_DENIED');
  });

  it('XOAUTH2 with an access token', async () => {
    const r = await send({ auth: { user: 'bob@example.com', accessToken: 'good-token' }, message: { ...message, to: ['ann@example.com'] } });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe('gc.mail.smtp.verify (since 1.217.0)', () => {
  const verify = (o) => gcOf(PID, 'mail.smtp.verify', { ...server(465), auth, ...o });

  it('logs in over TLS and STARTTLS and leaves without sending', async () => {
    const before = smtpTls.state.mails.length;
    const n = smtpTls.state.commands.length;
    const r = await verify({});
    assert.deepEqual(r, { ok: true, result: { ok: true } });
    const cmds = smtpTls.state.commands.slice(n).map((x) => x.cmd);
    assert.ok(cmds.includes('AUTH') && cmds.includes('QUIT'), cmds.join(' '));
    assert.equal(cmds.includes('MAIL'), false);
    assert.equal(smtpTls.state.mails.length, before, 'nothing sent');
    const m = smtpStarttls.state.commands.length;
    assert.equal((await verify({ ...server(587) })).ok, true);
    const tlsCmds = smtpStarttls.state.commands.slice(m);
    assert.deepEqual(tlsCmds.filter((x) => !x.secure).map((x) => x.cmd), ['EHLO', 'STARTTLS'], 'AUTH only after STARTTLS');
    assert.equal((await verify({ auth: { user: 'bob@example.com', accessToken: 'good-token' } })).ok, true, 'XOAUTH2');
  });

  it('the error codes of smtp.send: ERR_MAIL_AUTH (serverText without the password), ERR_MAIL_NET, ERR_NETWORK_DENIED, ERR_INVALID', async () => {
    const a = await verify({ auth: { user: 'bob', pass: 'nope-nope' } });
    assert.equal(a.code, 'ERR_MAIL_AUTH');
    assert.match(a.serverText, /535/);
    assert.doesNotMatch(a.serverText, /nope-nope/);
    assert.equal((await verify({ auth: { user: 'bob@example.com', accessToken: 'bad-token' } })).code, 'ERR_MAIL_AUTH');
    mail._setSeams({ net: { ports: { 587: smtpPlain.port }, ca: cert.cert } });
    const n = await verify({ ...server(587) });
    assert.equal(n.code, 'ERR_MAIL_NET', 'no STARTTLS → never in plain text');
    assert.equal(smtpPlain.state.commands.some((x) => x.cmd === 'AUTH'), false);
    mail._setSeams({ net: { ports: { 465: smtpTls.port }, ca: null } });
    assert.equal((await verify({})).code, 'ERR_MAIL_NET', 'an unknown certificate');
    assert.equal((await verify({ port: 25 })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await verify({ port: 993 })).code, 'ERR_NETWORK_DENIED', 'an IMAP port');
    assert.equal((await verify({ host: 'intranet.test.example' })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await verify({ host: 'cgnat.test.example' })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await verify({ port: 465, security: 'starttls' })).code, 'ERR_INVALID');
    assert.equal((await verify({ auth: { user: 'bob' } })).code, 'ERR_INVALID');
    const none = registry.get(NONE);
    await assert.rejects(() => hostApi.handle(none, 'mail.smtp.verify', { ...server(465), auth }), (e) => e.code === 'ERR_MAIL_DENIED');
  });

  it('counts towards the SMTP operations a plugin may run at the same time (4)', async () => {
    mail._setSeams({ net: { ports: { 465: smtpSlow.port }, ca: cert.cert } });
    smtpSlow.state.maxOpen = 0;
    const all = await Promise.all(Array.from({ length: 6 }, () => verify({})));
    assert.ok(all.every((r) => r.ok), JSON.stringify(all));
    assert.ok(smtpSlow.state.maxOpen <= 4 && smtpSlow.state.maxOpen >= 2, `at most 4 at a time, saw ${smtpSlow.state.maxOpen}`);
    assert.ok(mail.callTimeout('mail.smtp.verify', { timeoutMs: 30000 }) > 60000);
  });
});

describe('gc.http.fetch with bodyMedia (since 1.217.0)', () => {
  const URL_UP = () => `http://up.cloud.example:${webPort}/up`;
  const fetch = (url, opts) => gcOf(PID, 'http.fetch', url, opts);
  let blobId, bigId;

  before(async () => {
    const b = await gcOf(PID, 'media.fetch', `http://up.cloud.example:${webPort}/blob.pdf`, {});
    assert.equal(b.ok, true, JSON.stringify(b));
    blobId = b.result.mediaId;
    const g = await gcOf(PID, 'media.fetch', `http://up.cloud.example:${webPort}/big.pdf`, {});
    assert.equal(g.ok, true, JSON.stringify(g));
    bigId = g.result.mediaId;
  });

  const last = () => web.uploads[web.uploads.length - 1];

  it('raw: the whole file, streamed, Content-Length and the media type', async () => {
    const r = await fetch(URL_UP(), { method: 'PUT', headers: { 'X-Test': '1', 'Content-Length': '5' }, bodyMedia: { mediaId: blobId } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.status, 201);
    assert.deepEqual(JSON.parse(r.result.body), { got: BLOB.length });
    const u = last();
    assert.equal(u.method, 'PUT');
    assert.ok(u.body.equals(BLOB));
    assert.equal(u.headers['content-length'], String(BLOB.length));
    assert.equal(u.headers['content-type'], 'application/pdf');
    assert.equal(u.headers['x-test'], '1');
    assert.equal(u.headers['content-range'], undefined);
  });

  it('raw ranges: Content-Range by the host (the plugin\'s own is dropped), the pieces make the file', async () => {
    const size = BLOB.length;
    const step = 327680;
    const parts = [];
    for (let start = 0; start < size; start += step) {
      const end = Math.min(size, start + step) - 1;
      const r = await fetch(URL_UP(), { method: 'PUT', headers: { 'content-range': 'bytes 0-0/1', 'content-type': 'application/octet-stream' }, bodyMedia: { mediaId: blobId, start, end } });
      assert.equal(r.ok, true, JSON.stringify(r));
      const u = last();
      assert.equal(u.headers['content-range'], `bytes ${start}-${end}/${size}`);
      assert.equal(u.headers['content-length'], String(end - start + 1));
      assert.equal(u.headers['content-type'], 'application/octet-stream');
      parts.push(u.body);
    }
    assert.ok(Buffer.concat(parts).equals(BLOB));
    const tail = await fetch(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: blobId, start: size - 3 } });
    assert.equal(last().headers['content-range'], `bytes ${size - 3}-${size - 1}/${size}`, JSON.stringify(tail));
    assert.ok(last().body.equals(BLOB.subarray(size - 3)));
  });

  it('base64 into the one json value gc.http.MEDIA_BASE64 (Graph contentBytes), or alone as text/plain', async () => {
    const json = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'a "b" {{gc:media:base64}}.pdf', contentType: 'application/pdf', contentBytes: '{{gc:media:base64}}', list: [1, null, true] };
    const r = await fetch(URL_UP(), { method: 'POST', headers: { authorization: 'Bearer t' }, json, bodyMedia: { mediaId: blobId } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const u = last();
    assert.equal(u.headers['content-type'], 'application/json');
    assert.equal(u.headers['content-length'], String(u.body.length));
    const got = JSON.parse(u.body.toString('utf8'));
    assert.equal(got.name, json.name, 'a string merely containing the placeholder stays');
    assert.deepEqual(got.list, [1, null, true]);
    assert.ok(Buffer.from(got.contentBytes, 'base64').equals(BLOB));
    const plain = await fetch(URL_UP(), { method: 'POST', bodyMedia: { mediaId: blobId, encoding: 'base64' } });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.equal(last().headers['content-type'], 'text/plain');
    assert.equal(last().body.toString('latin1'), BLOB.toString('base64'));
  });

  it('checks: like http.fetch, own media only, the sizes, exactly one placeholder, no redirect', async () => {
    const code = async (url, opts) => (await fetch(url, opts)).code;
    const bm = { mediaId: blobId };
    assert.equal(await code(`http://lan.cloud.example:${webPort}/up`, { method: 'PUT', bodyMedia: bm }), 'ERR_NET_DENIED', 'a private address');
    assert.equal(await code(`http://up.elsewhere.example:${webPort}/up`, { method: 'PUT', bodyMedia: bm }), 'ERR_NET_DENIED', 'not in plugin.json');
    assert.equal(await code(URL_UP(), { method: 'GET', bodyMedia: bm }), 'ERR_INVALID');
    assert.equal(await code(URL_UP(), { method: 'PUT', body: 'x', bodyMedia: bm }), 'ERR_INVALID');
    assert.equal(await code(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: 'f'.repeat(32) } }), 'ERR_INVALID', 'unknown media');
    assert.equal(await code(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: blobId, start: 5, end: BLOB.length } }), 'ERR_INVALID', 'beyond the end');
    assert.equal(await code(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: blobId, start: 9, end: 3 } }), 'ERR_INVALID');
    assert.equal(await code(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: blobId, encoding: 'hex' } }), 'ERR_INVALID');
    assert.equal(await code(URL_UP(), { method: 'POST', json: { a: 1 }, bodyMedia: bm }), 'ERR_INVALID', 'no placeholder');
    assert.equal(await code(URL_UP(), { method: 'POST', json: { a: '{{gc:media:base64}}', b: ['{{gc:media:base64}}'] }, bodyMedia: bm }), 'ERR_INVALID', 'two placeholders');
    assert.equal(await code(URL_UP(), { method: 'POST', json: { a: '{{gc:media:base64}}' }, bodyMedia: { mediaId: blobId, start: 0, end: 9 } }), 'ERR_INVALID', 'ranges raw only');
    assert.equal(await code(URL_UP(), { method: 'POST', json: { a: '{{gc:media:base64}}' }, bodyMedia: { mediaId: bigId } }), 'ERR_MEDIA_TOO_LARGE', 'base64 ≤ 4 MB');
    const big = await fetch(URL_UP(), { method: 'PUT', bodyMedia: { mediaId: bigId } });
    assert.equal(big.ok, true, 'raw larger files are fine');
    const n = web.uploads.length;
    const red = await fetch(`http://up.cloud.example:${webPort}/up-redirect`, { method: 'PUT', redirect: 'follow', bodyMedia: bm });
    assert.equal(red.result.status, 307, 'a streamed body never follows a redirect');
    assert.equal(web.uploads.length, n + 1);
    await assert.rejects(() => hostApi.handle(registry.get(NONE), 'http.fetch', { url: URL_UP(), opts: { method: 'PUT', bodyMedia: bm } }), (e) => e.code === 'ERR_MEDIA_DENIED');
    assert.ok(hostApi.callTimeout('http.fetch', { opts: { bodyMedia: bm } }) >= 10 * 60 * 1000);
    assert.ok(hostApi.callTimeout('http.fetch', { opts: {} }) < 10 * 60 * 1000);
  });
});

// ─── MIME, sanitizer, autoconfig ────────────────

describe('gc.mail.compose / parse', () => {
  it('compose → RFC 822 media; parse → the message with attachments as media, checksums sha256', async () => {
    const att = (await gcOf(PID, 'mail.compose', { from: 'bob@example.com', to: 'ann@example.com', subject: 'x', text: 'y' })).result;
    const comp = (await gcOf(PID, 'mail.compose', {
      from: { name: 'Bob', address: 'bob@example.com' }, to: ['ann@example.com'], cc: ['carl@example.com'], subject: 'Mit Anlage',
      html: '<p>Hi <img src="cid:logo@x"></p>', text: 'Hi', inReplyTo: '<m1@example.com>', references: ['<m0@example.com>', '<m1@example.com>'],
      attachments: [{ mediaId: att.mediaId, filename: 'weiter.eml', contentType: 'message/rfc822' }, { mediaId: att.mediaId, filename: 'logo.png', contentType: 'image/png', cid: 'logo@x' }],
    })).result;
    assert.match(comp.messageId, /^<.+>$/);
    const parsed = await gcOf(PID, 'mail.parse', comp.mediaId, { attachments: 'media' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    const p = parsed.result;
    assert.equal(p.subject, 'Mit Anlage');
    assert.equal(p.messageId, comp.messageId);
    assert.equal(p.inReplyTo, '<m1@example.com>');
    assert.deepEqual(p.references, ['<m0@example.com>', '<m1@example.com>']);
    assert.deepEqual(p.cc, [{ name: '', address: 'carl@example.com' }]);
    const logo = p.attachments.find((a) => a.filename === 'logo.png');
    assert.equal(logo.contentId, 'logo@x');
    assert.equal(logo.inline, true);
    for (const a of p.attachments) assert.equal((await gcOf(PID, 'media.info', a.mediaId)).result.sha256, a.checksum);
    const meta = (await gcOf(PID, 'mail.parse', comp.mediaId)).result;
    assert.ok(meta.attachments.every((a) => a.mediaId === null));
    assert.equal((await gcOf(PID, 'mail.parse', 'f'.repeat(32))).code, 'ERR_INVALID');
  });
});

describe('gc.mail.sanitize: strict allowlist', () => {
  const S = () => require('../src/services/plugins/mail/sanitize').sanitize;
  const clean = (html) => S()(html).html;
  const noActive = (out) => {
    assert.doesNotMatch(out, /<script|<svg|<math|<iframe|<object|<embed|<form|<input|<meta|<base|<link|<frame|<style[^>]*>[^<]*(?:@import|url\(|expression)/i);
    assert.doesNotMatch(out, /\son[a-z]+\s*=/i, 'no event attributes');
    assert.doesNotMatch(out, /javascript:|vbscript:|data:text/i);
  };

  const XSS = [
    '<script>alert(1)</script><p>x</p>',
    '<SCRIPT SRC=//evil/x.js></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<img src="https://ok.example/a.png" onerror="alert(1)" onload=alert(2)>',
    '<body onload=alert(1)><p>x</p></body>',
    '<a href="javascript:alert(1)">a</a><a href="JaVaScRiPt:alert(1)">b</a><a href="jav&#x09;ascript:alert(1)">c</a><a href=" javascript:alert(1)">d</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a><a href="vbscript:msgbox(1)">y</a>',
    '<svg onload=alert(1)><circle/></svg><svg><script>alert(1)</script></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
    '<div style="width: expression(alert(1))">x</div>',
    '<div style="background:url(javascript:alert(1))">x</div><div style="background-image: url(https://t.example/p.gif)">y</div>',
    '<div style="behavior: url(x.htc); -moz-binding: url(x.xml#x)">x</div>',
    '<style>@import url(https://evil/x.css); body{background:url(https://t.example/p.gif)} p{color:red;width:expression(alert(1))} </style><p>x</p>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example/"><a href="x">rel</a>',
    '<form action="https://evil.example"><input name="pw" type="password"><button>Login</button></form>',
    '<iframe src="https://evil.example"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="x.swf"></object><embed src="x.swf"><applet code="x"></applet>',
    '<link rel="stylesheet" href="https://evil/x.css">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<p style="position:fixed;top:0;left:0;z-index:9999">overlay</p>',
    '<img srcset="https://t.example/a.png 1x" src="https://ok.example/b.png">',
  ];
  for (const [i, html] of XSS.entries()) {
    it(`XSS case ${i + 1}: ${html.slice(0, 60)}`, () => noActive(clean(html)));
  }

  it('links keep http(s)/mailto/tel/#, open in a new tab with noopener noreferrer', () => {
    const out = clean('<a href="https://ex.com/a?b=1">x</a><a href="mailto:a@b.c">m</a><a href="tel:+491234">t</a><a href="#top">top</a><a href="/api/v1/x">rel</a>');
    assert.match(out, /<a href="https:\/\/ex.com\/a\?b=1" target="_blank" rel="noopener noreferrer">x<\/a>/);
    assert.match(out, /<a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">m<\/a>/);
    assert.match(out, /<a href="tel:\+491234"/);
    assert.match(out, /<a href="#top">top<\/a>/);
    assert.match(out, /<a>rel<\/a>/, 'a relative link loses its address');
  });

  it('external pictures → gc-img:<n> (once per address); cid: stays; known tracking pixels go and are counted', () => {
    const r = S()([
      '<img src="https://cdn.example/a.png" width="600" alt="Logo">',
      '<img src="https://cdn.example/a.png">',
      '<img src="https://cdn.example/b.jpg">',
      '<img src="https://t.example/open.gif" width="1" height="1">',
      '<img src="https://x.list-manage.com/track/open.php?u=1">',
      '<img src="https://pixel.example/p.gif" style="width:1px;height:1px">',
      '<img src="https://ok.example/c.png" style="display:none">',
      '<img src="https://ex.sendgrid.net/wf/open?upn=x">',
      '<img src="cid:logo@x">',
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
      '<img src="gc-img:7">',
    ].join(''));
    assert.deepEqual(r.images, ['https://cdn.example/a.png', 'https://cdn.example/b.jpg']);
    assert.equal(r.trackers, 5);
    assert.match(r.html, /<img src="gc-img:0" width="600" alt="Logo" \/><img src="gc-img:0" \/><img src="gc-img:1" \/>/);
    assert.match(r.html, /<img src="cid:logo@x" \/>/);
    assert.match(r.html, /<img src="data:image\/png;base64,iVBORw0KGgo=" \/>/);
    assert.doesNotMatch(r.html, /gc-img:7|open\.gif|list-manage|sendgrid/, 'a mail cannot bring its own placeholder or a tracker');
  });

  it('<style> blocks keep the allowed rules only; formatting survives', () => {
    const r = clean('<style>.a{color:red;font-family:"Helvetica Neue",Arial;background:url(x)} @media (max-width:600px){.b{width:100%}} @font-face{src:url(x)}</style><p class="a">x</p><table><tr><td bgcolor="#fff" colspan="2" style="padding:4px">y</td></tr></table>');
    assert.match(r, /^<style>\.a\{color:red;font-family:"Helvetica Neue",Arial\} @media \(max-width:600px\)\{\.b\{width:100%\}\}<\/style>/);
    assert.match(r, /<td bgcolor="#fff" colspan="2" style="padding:4px">y<\/td>/);
    assert.doesNotMatch(r, /font-face|url\(/);
    assert.equal(S()('<style>p{color:red}</style></style><script>x</script>').html.toLowerCase().includes('<script'), false);
  });

  it('through the plugin process: gc.mail.sanitize(html, { images: "placeholder" })', async () => {
    const r = await gcOf(PID, 'mail.sanitize', '<p onclick="x()">Hi<img src="https://cdn.example/a.png"></p>', { images: 'placeholder' });
    assert.deepEqual(r.result, { html: '<p>Hi<img src="gc-img:0" /></p>', images: ['https://cdn.example/a.png'], trackers: 0 });
    assert.equal((await gcOf(PID, 'mail.sanitize', '<p>x</p>', { images: 'load' })).code, 'ERR_INVALID');
  });
});

describe('gc.mail.autoconfig', () => {
  const ac = () => require('../src/services/plugins/mail/autoconfig');
  const XML = (imap, smtp) => `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="x"><domain>gmx.de</domain>${imap}${smtp}</emailProvider></clientConfig>`;
  const IN = (h, p, s) => `<incomingServer type="imap"><hostname>${h}</hostname><port>${p}</port><socketType>${s}</socketType></incomingServer>`;
  const OUT = (h, p, s) => `<outgoingServer type="smtp"><hostname>${h}</hostname><port>${p}</port><socketType>${s}</socketType></outgoingServer>`;
  const noDns = { resolveSrv: async () => [], resolveMx: async () => [] };

  it('ISPDB first; only usable servers (TLS before STARTTLS, never plain or other ports)', async () => {
    const asked = [];
    const r = await ac().autoconfig('ada@gmx.de', { resolver: noDns, fetchXml: async (url) => {
      asked.push(url);
      return url.startsWith('https://autoconfig.thunderbird.net/v1.1/gmx.de')
        ? XML(IN('pop.gmx.net', 995, 'SSL') + IN('imap.gmx.net', 143, 'STARTTLS') + IN('imap.gmx.net', 993, 'SSL') + IN('plain.gmx.net', 143, 'plain'), OUT('mail.gmx.net', 25, 'plain') + OUT('mail.gmx.net', 587, 'STARTTLS'))
        : null;
    } });
    assert.deepEqual(r, { imap: { host: 'imap.gmx.net', port: 993, security: 'tls' }, smtp: { host: 'mail.gmx.net', port: 587, security: 'starttls' }, source: 'ispdb', caldav: null, carddav: null });
    assert.equal(asked.length, 1);
  });

  it('then autoconfig.<domain>, the well-known address, SRV, MX', async () => {
    const xml = XML(IN('imap.%EMAILDOMAIN%', 993, 'SSL'), OUT('smtp.%EMAILDOMAIN%', 465, 'SSL'));
    let r = await ac().autoconfig('a@firma.example', { resolver: noDns, fetchXml: async (u) => (u.startsWith('https://autoconfig.firma.example/') ? xml : null) });
    assert.deepEqual(r, { imap: { host: 'imap.firma.example', port: 993, security: 'tls' }, smtp: { host: 'smtp.firma.example', port: 465, security: 'tls' }, source: 'autoconfig', caldav: null, carddav: null });
    r = await ac().autoconfig('a@firma.example', { resolver: noDns, fetchXml: async (u) => (u.startsWith('https://firma.example/.well-known/') ? xml : null) });
    assert.equal(r.source, 'autoconfig');
    const srv = { resolveMx: async () => [], resolveSrv: async (n) => ({
      '_imaps._tcp.firma.example': [{ name: 'mx.firma.example', port: 993, priority: 0, weight: 0 }],
      '_submission._tcp.firma.example': [{ name: 'out.firma.example', port: 587, priority: 0, weight: 0 }],
    })[n] || [] };
    r = await ac().autoconfig('a@firma.example', { resolver: srv, fetchXml: async () => null });
    assert.deepEqual(r, { imap: { host: 'mx.firma.example', port: 993, security: 'tls' }, smtp: { host: 'out.firma.example', port: 587, security: 'starttls' }, source: 'srv', caldav: null, carddav: null });
    const mx = { resolveSrv: async () => [], resolveMx: async () => [{ exchange: 'mx01.mail.provider.example', priority: 10 }] };
    r = await ac().autoconfig('a@kunde.example', { resolver: mx, fetchXml: async (u) => (u === 'https://autoconfig.thunderbird.net/v1.1/provider.example' ? XML(IN('imap.provider.example', 993, 'SSL'), OUT('smtp.provider.example', 465, 'SSL')) : null) });
    assert.equal(r.source, 'mx');
    assert.equal(r.imap.host, 'imap.provider.example');
    r = await ac().autoconfig('a@nothing.example', { resolver: noDns, fetchXml: async () => null });
    assert.deepEqual(r, { imap: null, smtp: null, source: null, caldav: null, carddav: null });
  });

  it('the HTTP requests are checked like gc.http.fetch (a private address is never asked); bad addresses → ERR_INVALID', async () => {
    const r = await ac().autoconfig('a@intranet.test.example', { resolver: noDns, lookup: hostApi._lookup });
    assert.deepEqual(r, { imap: null, smtp: null, source: null, caldav: null, carddav: null });
    const p = registry.get(PID);
    await assert.rejects(() => hostApi.handle(p, 'mail.autoconfig', { email: 'not an address' }), (e) => e.code === 'ERR_INVALID');
  });
});

// ─── gc.http.fetchImage ─────────────────────────

describe('gc.http.fetchImage', () => {
  const img = (u, opts) => mailOp(PID, { op: 'fetchImage', url: `http://img.test.example:${webPort}${u}`, opts });

  it('a picture: { status, mime, bytes (Buffer) }; no cookie, no referer, a neutral user agent', async () => {
    const r = await img('/pic.png');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status, 200);
    assert.equal(r.mime, 'image/png');
    assert.equal(r.isBuffer, true);
    assert.equal(Buffer.from(r.head, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.equal(r.length, 48);
    const seen = web.seen[web.seen.length - 1];
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers.referer, undefined);
    assert.equal(seen.headers['user-agent'], fetchImage.USER_AGENT);
    assert.equal((await img('/to-pic')).mime, 'image/png', 'a redirect on the same public host is followed');
  });

  it('a redirect to a private or loopback address is refused (ERR_NETWORK_DENIED)', async () => {
    assert.equal((await img('/to-private')).code, 'ERR_NETWORK_DENIED');
    assert.equal((await img('/to-loopback')).code, 'ERR_NETWORK_DENIED');
    assert.equal((await mailOp(PID, { op: 'fetchImage', url: `http://intranet.test.example:${webPort}/pic.png` })).code, 'ERR_NETWORK_DENIED');
    assert.equal((await mailOp(PID, { op: 'fetchImage', url: 'http://img.test.example:22/pic.png' })).code, 'ERR_NETWORK_DENIED', 'other ports');
  });

  it('not a picture → ERR_INVALID (type, SVG, bytes); too large, too many redirects, HTTP errors', async () => {
    assert.equal((await img('/page')).code, 'ERR_INVALID');
    assert.equal((await img('/fake.png')).code, 'ERR_INVALID', 'image/png that is no picture');
    assert.equal((await img('/x.svg')).code, 'ERR_INVALID', 'never SVG');
    assert.equal((await img('/big.png')).code, 'ERR_MEDIA_TOO_LARGE', 'default 2 MB');
    assert.equal((await img('/big.png', { maxBytes: 5 * 1024 * 1024 })).mime, 'image/png');
    assert.equal((await img('/pic.png', { maxBytes: 6 * 1024 * 1024 })).code, 'ERR_INVALID', 'at most 5 MB');
    assert.equal((await img('/pic.png', { timeoutMs: 20000 })).code, 'ERR_INVALID', 'at most 15 s');
    assert.equal((await img('/loop/0')).code, 'ERR_NET', 'at most 5 redirects');
    const nf = await img('/missing.png');
    assert.equal(nf.code, 'ERR_HTTP');
    assert.equal(nf.status, 404);
    assert.equal((await mailOp(PID, { op: 'fetchImage', url: 'file:///etc/passwd' })).code, 'ERR_INVALID');
  });

  it('knows the picture formats by their bytes', () => {
    const s = fetchImage.sniff;
    assert.equal(s(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
    assert.equal(s(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(s(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(s(Buffer.from('\0\0\0\x1cftypavif\0\0', 'latin1')), 'image/avif');
    assert.equal(s(Buffer.from('<svg>')), null);
    assert.equal(s(Buffer.from('<html>')), null);
  });
});
